// ============================================================
// supabase/functions/delete-account/index.ts
// STEP AUTH-F2-A (post-audit) — server-side account deletion (privileged
// path only)
//
// This is the ONLY place in the entire project that ever holds the
// service_role key. It lives exclusively in this Edge Function's
// server-side runtime, read from the environment
// (`SUPABASE_SERVICE_ROLE_KEY`, injected automatically by the Supabase
// platform for every Edge Function) — it is never sent to, embedded in,
// committed to, or reachable from the mobile app. The client
// (src/store/auth.tsx, a later STEP) calls this function over HTTPS with
// nothing but its OWN current session's access token in the
// `Authorization` header; it never sees this key, and nothing in this
// file ever writes it anywhere the client could read it back.
//
// ---- identity: never trust a client-supplied user id ----
// The request body is intentionally never parsed for a user/account
// identifier at all — there is no field anywhere in this function's logic
// that would let a caller name a DIFFERENT account to delete. The only
// user this function ever acts on is whichever account the caller's own
// `Authorization: Bearer <jwt>` verifies to, via `callerClient.auth.
// getUser()` — a real call to GoTrue that verifies the token's signature
// server-side (not a local JWT decode, which would trust an unverified
// payload). A missing/invalid/expired token fails this call and the
// function returns 401 before touching the database at all.
//
// ---- authoritative classification + deletion now lives in the DB ----
// (post-audit revision) Every household-membership classification
// decision and the sole-member `households` hard-delete now happen
// INSIDE ONE Postgres transaction, via
// `public.delete_sole_member_households_for_current_user()`
// (supabase/migrations/20260914001200_delete_sole_member_households_rpc.
// sql — see that file for the full policy/lock-ordering/concurrency
// analysis). This function used to run a classification SELECT and a
// separate `households` DELETE as two independent PostgREST calls, which
// left a real TOCTOU window (another user could redeem a household invite
// in between, and the DELETE would still destroy their brand-new
// membership along with it). Moving both steps into one SECURITY DEFINER
// RPC closes that window at the database level — this file no longer
// contains ANY classification or deletion logic of its own, only the
// glue to call that RPC and interpret its result.
//
// CRITICAL: the RPC is called through `callerClient` — a client carrying
// the CALLER's own verified JWT, never the admin/service_role client.
// `auth.uid()` inside a SECURITY DEFINER function resolves from the
// REQUEST's own JWT claims (the same mechanism every other RPC in this
// project already relies on — create_household_invite,
// redeem_household_invite, transfer_household_ownership); calling it
// through the service_role client instead would make `auth.uid()` return
// null (service_role requests carry no end-user `sub` claim) and there is
// deliberately no argument on the RPC a caller (or this function) could
// pass a different user id through even if it wanted to — the database,
// not this function, decides whose households get inspected.
//
// ---- partial-failure / idempotency (the one gap that remains) ----
// Once the RPC succeeds (no blocking household found; zero or more
// sole-member households already hard-deleted, atomically, inside that
// one transaction), exactly one step remains:
//   adminClient.auth.admin.deleteUser(callerId) — a separate system
//   (GoTrue), NOT part of the same Postgres transaction as the RPC.
// This is a genuine, irreducible gap given a Postgres RPC + the GoTrue
// Admin API are two different systems — nothing short of GoTrue itself
// participating in a Postgres transaction could close it, which is not
// something this project controls. The ordering (destroy the caller's own
// sole-owned data FIRST, delete the auth user SECOND) is unchanged from
// the original design and still deliberate:
//   - If the RPC itself fails: nothing has changed (it is one all-or-
//     nothing transaction), the caller can retry immediately.
//   - If the RPC succeeds but deleteUser fails (e.g. a transient GoTrue
//     error): the caller's sole-owned households/data are already gone
//     permanently, but their auth.users/profiles row still exists — they
//     are still a valid, signed-in account. This remains safe to retry:
//     a retry's call to the RPC finds those households already gone (no
//     longer in household_members at all, so nothing to classify or
//     delete there) and returns success immediately with an empty
//     `deletedHouseholdIds`, so the retry proceeds straight to
//     deleteUser again. The client MUST surface a clear "다시
//     시도해주세요" error here rather than silently giving up.
//   - The reverse order (delete the auth user first) remains rejected for
//     the same reason as before: its failure mode is unrecoverable (no
//     session left to retry with) and leaves the sole-owned
//     households/data as permanent, unreachable orphans — exactly the
//     problem this whole feature exists to close.
//
// ---- what this function deliberately does NOT do (out of scope here) ----
// No re-authentication/password check happens in this function — STEP
// AUTH-F2-B wires the client-side "reenter your password" gate (via the
// existing `useAuth().signIn`) BEFORE this function is ever called. This
// function only guarantees the JWT it receives is valid and identifies a
// real account; whether the app decided to demand a fresh password first
// is a client-side UX concern layered in front of this call, not something
// this server endpoint can distinguish from any other authenticated
// request (a session is a session). No UI, no offline-queue integration —
// this endpoint is a plain online-only request/response call, never
// queued.
// ============================================================

// @ts-ignore: Deno remote-import specifier, not resolvable by the app's own tsc project.
import { createClient } from 'npm:@supabase/supabase-js@2';

interface DeleteSoleMemberHouseholdsResult {
  ok: boolean;
  error?: string;
  householdIds?: string[];
  deletedHouseholdIds?: string[];
}

// Harmless boilerplate for any future non-native (web) caller — React
// Native fetch is not subject to CORS at all, so none of this changes
// anything for the mobile app itself. `Allow-Methods` lists exactly the
// two methods this function ever handles (POST for the real call, OPTIONS
// for the preflight itself) — a browser's preflight check needs this
// header present to permit the actual POST that follows.
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// @ts-ignore: Deno global, not part of the app's own TS project types.
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    // A 204 response must never carry a body — the Fetch/Deno runtime
    // enforces this at Response-construction time and throws otherwise.
    // The previous `jsonResponse({}, 204)` built a Response with a
    // `"{}"` body attached to a 204 status, which threw here on every
    // single preflight request and surfaced as an uncaught 500
    // (EDGE_FUNCTION_ERROR) — confirmed on the deployed function. `null`
    // has no body at all, so this constructs cleanly.
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return jsonResponse({ error: 'AUTH_REQUIRED' }, 401);
  }

  // @ts-ignore: Deno global.
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  // @ts-ignore: Deno global.
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  // @ts-ignore: Deno global.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    // Misconfigured environment — fail loudly rather than silently running
    // with a missing key. Never logs the key values themselves.
    return jsonResponse({ error: 'SERVER_MISCONFIGURED' }, 500);
  }

  // Caller-scoped client: verifies the JWT against GoTrue itself (a real
  // network round trip, not a local decode of an unverified payload) and
  // resolves the AUTHORITATIVE current user. Nothing in the request body
  // is ever read for identity — see file header. This SAME client is also
  // what calls the classification/deletion RPC below, so that RPC's own
  // `auth.uid()` resolves to this exact user.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ error: 'AUTH_REQUIRED' }, 401);
  }
  const callerId: string = userData.user.id;

  // ---- 1. authoritative classification + sole-member household deletion,
  // entirely inside the DB (one transaction) — see file header. Called via
  // callerClient, NEVER the admin client: auth.uid() inside the RPC must
  // resolve to THIS caller, and the RPC takes no user-id argument at all,
  // so there is no parameter here that could even be pointed at a
  // different account. ----
  const { data: rpcData, error: rpcError } = await callerClient.rpc(
    'delete_sole_member_households_for_current_user',
  );

  if (rpcError) {
    return jsonResponse({ error: 'CLASSIFICATION_FAILED' }, 500);
  }

  const result = rpcData as DeleteSoleMemberHouseholdsResult;
  if (!result?.ok) {
    if (result?.error === 'OWNERSHIP_TRANSFER_REQUIRED') {
      return jsonResponse(
        { error: 'OWNERSHIP_TRANSFER_REQUIRED', householdIds: result.householdIds ?? [] },
        409,
      );
    }
    return jsonResponse({ error: 'CLASSIFICATION_FAILED' }, 500);
  }

  // ---- 2. delete the auth account itself. This is the one step that
  // genuinely requires service_role — GoTrue's admin user-deletion has no
  // SQL-callable equivalent. See file header for the ordering/partial-
  // failure analysis. ----
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: deleteUserErr } = await adminClient.auth.admin.deleteUser(callerId);
  if (deleteUserErr) {
    // The caller's sole-owned households (if any) are already gone at
    // this point — see the file header's partial-failure analysis. The
    // account itself still exists and is still a valid session, so the
    // client should present a "다시 시도해주세요" error and allow
    // retrying this same call, which is safe/idempotent (see header).
    return jsonResponse({ error: 'ACCOUNT_DELETE_FAILED' }, 500);
  }

  return jsonResponse({ ok: true }, 200);
});
