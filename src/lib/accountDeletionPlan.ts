/**
 * NON-AUTHORITATIVE account-deletion policy reference — STEP AUTH-F2-A,
 * re-scoped after a pre-deploy security audit moved the REAL classify-
 * and-delete logic into the database.
 *
 * The actual, authoritative decision now lives entirely inside
 * `public.delete_sole_member_households_for_current_user()`
 * (supabase/migrations/20260914001200_delete_sole_member_households_rpc.
 * sql) — a single Postgres transaction that locks every relevant
 * household row before re-counting membership, closing a real TOCTOU race
 * a plain classify-then-delete split (which is what this module and the
 * Edge Function's PREVIOUS design both did) could not close. Neither
 * `supabase/functions/delete-account/index.ts` NOR any client code calls
 * this module for a real decision anymore — it is not imported by either.
 *
 * What this module IS: a plain-TypeScript mirror of the POLICY RULES ONLY
 * (sole-member vs. safe-member vs. blocking, from the AUTH-F2 investigation
 * report) — no locking, no transactions, no I/O — kept purely so those
 * rules have fast, dependency-free regression coverage (via
 * accountDeletionPlan.cases.ts, the existing sucrase harness) without
 * standing up a live Postgres instance to test against, which this
 * project's test tooling deliberately does not do. It is NOT literally
 * shared code with the SQL RPC (impossible — one is PL/pgSQL, one is
 * TypeScript) and nothing enforces that the two stay in sync: if the SQL
 * policy in 20260914001200 ever changes, this file and its cases must be
 * updated BY HAND to match, or this module's tests will quietly assert
 * outdated rules while the real (SQL) behavior has already moved on.
 *
 * If a future STEP (e.g. F2-B's client UI) ever wants to preview this
 * classification before calling the server, its output here must be
 * treated as advisory/UI-hint ONLY — the actual delete-account call's own
 * response (success, or 409 OWNERSHIP_TRANSFER_REQUIRED from the RPC) is
 * the only ground truth a destructive action may ever act on.
 */

export type HouseholdRole = 'owner' | 'member';

export interface HouseholdMembershipForDeletion {
  householdId: string;
  /** The CALLER's own role in this household. */
  role: HouseholdRole;
  /** Total member count of this household, including the caller. */
  memberCount: number;
}

export interface AccountDeletionPlan {
  /** Caller is the household's only member — safe to hard-delete (DELETE
   *  FROM households cascades to every table that references it). */
  soleMemberHouseholdIds: string[];
  /** Caller is a plain member with co-members present — nothing to do;
   *  the caller's own membership cascades away with auth.users, the
   *  household and its data are entirely untouched. */
  safeMemberHouseholdIds: string[];
  /** Caller is owner with co-members present — blocks the ENTIRE account
   *  deletion (see canProceedWithAccountDeletion) until ownership is
   *  transferred away from the caller for every household listed here. */
  blockingHouseholdIds: string[];
}

export function planAccountDeletion(
  memberships: readonly HouseholdMembershipForDeletion[],
): AccountDeletionPlan {
  const soleMemberHouseholdIds: string[] = [];
  const safeMemberHouseholdIds: string[] = [];
  const blockingHouseholdIds: string[] = [];

  for (const m of memberships) {
    if (m.memberCount <= 1) {
      soleMemberHouseholdIds.push(m.householdId);
    } else if (m.role === 'owner') {
      blockingHouseholdIds.push(m.householdId);
    } else {
      safeMemberHouseholdIds.push(m.householdId);
    }
  }

  return { soleMemberHouseholdIds, safeMemberHouseholdIds, blockingHouseholdIds };
}

/**
 * A single unresolved owner+co-member household blocks the WHOLE account
 * deletion (STEP AUTH-F2 policy §4) — deletion never proceeds partially
 * (e.g. hard-deleting the caller's safe sole-member households while
 * leaving the blocking one unresolved). The Edge Function checks this
 * BEFORE any destructive step runs at all (see its own header).
 */
export function canProceedWithAccountDeletion(plan: AccountDeletionPlan): boolean {
  return plan.blockingHouseholdIds.length === 0;
}
