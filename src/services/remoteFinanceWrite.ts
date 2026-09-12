/**
 * Remote household finance WRITE layer — STEP 16-G2-A
 * (hardened in STEP 16-G2-A2-HARDEN: session-identity guard + created_by in
 * the 23505 idempotency check + structural splits comparison).
 *
 * The FIRST and (this STEP) ONLY financial write path in the app. It does
 * exactly one thing: create a single new `public.transactions` row via a
 * direct `.insert()` (STEP 16-G2-A1 decided against an RPC — the
 * transactions_insert RLS policy already checks household membership,
 * private.trg_lock_identity() already forces created_by = auth.uid(), and
 * the composite (household_id, card_id) FK already blocks a cross-household
 * card reference, so a SECURITY DEFINER function would add nothing).
 *
 * No UPDATE, no soft delete, no other table, no RPC, no realtime. Screens
 * never call `supabase` for a write directly — they call `createTransaction`
 * here.
 *
 * Session identity (STEP 16-G2-A2-HARDEN §1/§2): the caller passes the
 * `expectedUserId` it validated the trusted screen against. If the live
 * Supabase session's user id no longer matches (an account A -> B switch
 * raced the submit), the INSERT is NOT attempted — otherwise B's auth.uid()
 * would end up as created_by on a row A meant to write. This is a
 * client-side stale-identity guard layered on top of RLS, not a substitute
 * for it.
 *
 * Idempotency (STEP 16-G2-A2 §8, hardened §3/§4): the caller passes a
 * client-generated id that is stable across retries. If the INSERT comes
 * back as a unique violation (23505), this module re-reads that id within
 * the same household and only reports success when the stored row is
 * field-for-field the same request AND was created_by this same user. A
 * 23505 whose row differs, whose created_by differs, or one we can't read
 * back at all, is reported as a failure — never a blind success.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  buildTransactionInsert,
  buildTransactionUpdate,
  type NewTransactionDraft,
  type TransactionInsertRow,
  type TransactionUpdateRow,
} from '@/lib/remoteFinanceWriteMapping';
import { isTransportError } from '@/lib/transportError';
import type { TransactionSplit } from '@/store/types';

export type CreateTransactionResult =
  | { ok: true; id: string }
  /**
   * `transport: true` (STEP 16-H2-A1 §1) marks a NETWORK/TRANSPORT failure —
   * the INSERT never reached a server verdict — as opposed to an unexpected
   * server error, an identity guard, or a 23505 that failed to reconcile.
   * ONLY a `transport` failure is safe for the Offline Write Queue to
   * enqueue. The field is additive and optional; existing callers that only
   * branch on `res.ok` are unaffected.
   */
  | { ok: false; message: string; transport?: boolean };

/**
 * STEP 16-G2-B — every non-ok end state for an edit / soft delete.
 * `'insufficient'` (STEP 16-H2-G6) is additive and ONLY ever produced by a
 * goal-movement over-withdraw discovered on a replay (see
 * `AddGoalMovementResult` / runOp.ts's goalMovement dispatch) — every other
 * entity's write service never emits it, so widening this shared union is
 * behaviourally inert for them (their `reason` checks are plain `if`/`===`
 * comparisons, never an exhaustive switch that this would break).
 */
export type WriteConflictReason = 'identity' | 'conflict' | 'deleted' | 'gone' | 'error' | 'insufficient';

/**
 * STEP 16-H2-B1 §2/§3: `transport: true` marks a NETWORK/TRANSPORT failure
 * of the UPDATE / soft-delete request (it never reached a server verdict) —
 * ONLY set on the `reason: 'error'` primary path, never on a
 * conflict / deleted / gone / identity / reconcile-read failure. Additive;
 * existing callers that branch on `res.ok` / `res.reason` are unaffected.
 */
export type UpdateTransactionResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: WriteConflictReason; message: string; transport?: boolean };

export type SoftDeleteResult =
  | { ok: true }
  | { ok: false; reason: WriteConflictReason; message: string; transport?: boolean };

const GENERIC_ERROR = '거래를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 거래예요. 최신 내용을 다시 불러올게요.';
const DELETE_CONFLICT = '다른 곳에서 이미 변경됐거나 삭제된 거래예요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors src/services/remoteFinance.ts). */
function describeWriteError(error: PostgrestError): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return GENERIC_ERROR;
}

/**
 * Classify the RECONCILE-READ error — the SELECT the write path runs after a
 * 0-row UPDATE / soft-delete or a 23505 INSERT to work out what actually
 * happened. STEP 16-H2-B1.1: for the durable offline queue this read's
 * outcome must not be mistaken for a business verdict. A TRANSPORT failure
 * here (network dropped mid-reconcile) is NOT evidence the row is gone /
 * mismatched — it's retryable; anything else is a plain server error.
 * `undefined` when there was no read error.
 */
export function classifyReconcileReadError(
  readErr: PostgrestError | null,
): { reason: 'error'; message: string; transport: boolean } | undefined {
  if (!readErr) return undefined;
  return {
    reason: 'error',
    message: describeWriteError(readErr),
    transport: isTransportError(readErr),
  };
}

/**
 * Structural comparison of two split lists (STEP 16-G2-A2-HARDEN §4).
 *
 * `splits` is stored as jsonb, so a raw `JSON.stringify` compare would be at
 * the mercy of object key order and could turn an identical retry into a
 * false mismatch. This walks the actual `TransactionSplit` shape instead:
 * same length, and for each index the same `category`, the same numeric
 * `amount`, and the same `memo` (absent and empty both normalised to null).
 * Order IS significant — the split list is a user-ordered sequence, and
 * Postgres preserves jsonb array order — so entries are matched by index,
 * never sorted.
 */
function splitsEqual(a: unknown, b: unknown): boolean {
  const xa: TransactionSplit[] = Array.isArray(a) ? (a as TransactionSplit[]) : [];
  const xb: TransactionSplit[] = Array.isArray(b) ? (b as TransactionSplit[]) : [];
  if (xa.length !== xb.length) return false;
  return xa.every((s, i) => {
    const t = xb[i];
    return (
      s.category === t.category &&
      Number(s.amount) === Number(t.amount) &&
      (s.memo ?? null) === (t.memo ?? null)
    );
  });
}

/**
 * Every field that identifies "this exact create request". A stored row must
 * match ALL of them — and have been `created_by` the same user
 * (STEP 16-G2-A2-HARDEN §3) — for a 23505 to count as an already-succeeded
 * retry. `date` is compared as an instant and `amount` as a number so a
 * server-normalised representation doesn't cause a false mismatch;
 * everything else is an exact `===`.
 */
function isSameRequest(
  existing: Record<string, unknown>,
  row: TransactionInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.type === row.type &&
    existing.category === row.category &&
    Number(existing.amount) === Number(row.amount) &&
    ((existing.memo as string | null) ?? '') === row.memo &&
    new Date(existing.date as string).getTime() === new Date(row.date).getTime() &&
    ((existing.member_id as string | null) ?? null) === row.member_id &&
    ((existing.payment_method as string | null) ?? null) === row.payment_method &&
    ((existing.card_id as string | null) ?? null) === row.card_id &&
    ((existing.installment_months as number | null) ?? null) ===
      row.installment_months &&
    splitsEqual(existing.splits, row.splits)
  );
}

export async function createTransaction(args: {
  /** Client-generated `txn-...` id, fixed for the form's lifetime (src/lib/id.ts). */
  id: string;
  /** CURRENT trusted active household id. */
  householdId: string;
  /** The user id the calling screen validated its trusted state against. */
  expectedUserId: string;
  draft: NewTransactionDraft;
  /** Ids of the household's own live cards (for the dangling-cardId guard). */
  knownCardIds: ReadonlySet<string>;
}): Promise<CreateTransactionResult> {
  // Client-side stale-identity guard (RLS is still the real authority). The
  // live session must be the exact user the trusted screen was built for —
  // if an account switch raced the submit, do not write at all.
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) {
    return { ok: false, message: '다시 로그인해 주세요.' };
  }
  if (liveUserId !== args.expectedUserId) {
    return { ok: false, message: IDENTITY_CHANGED };
  }

  const row = buildTransactionInsert(args.draft, {
    id: args.id,
    householdId: args.householdId,
    knownCardIds: args.knownCardIds,
  });

  const { data, error } = await supabase
    .from('transactions')
    .insert(row)
    .select('id')
    .single();

  if (!error && data?.id) {
    return { ok: true, id: data.id as string };
  }

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('transactions')
      .select(
        'id,household_id,created_by,type,category,amount,memo,date,member_id,payment_method,card_id,installment_months,splits',
      )
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    // A TRANSPORT failure during the reconcile read is retryable — the row
    // may well be ours; the offline queue should re-attempt, not give up.
    const readClass = classifyReconcileReadError(readErr);
    if (readClass?.transport) {
      return { ok: false, message: readClass.message, transport: true };
    }
    // A non-transport read error, or a successful read that returned no row
    // (RLS says it isn't ours) -> do NOT treat as success. Terminal.
    if (readErr || !existing) {
      return { ok: false, message: GENERIC_ERROR };
    }

    if (isSameRequest(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, message: GENERIC_ERROR };
  }

  // A non-23505 error: could be transport (offline) or an unexpected server
  // error. `transport` lets the Offline Write Queue (STEP 16-H2) tell them
  // apart; the message/behaviour for every current caller is unchanged.
  if (error) {
    return { ok: false, message: describeWriteError(error), transport: isTransportError(error) };
  }
  return { ok: false, message: GENERIC_ERROR };
}

/* ================================================================== *
 * UPDATE + SOFT DELETE — STEP 16-G2-B
 *
 * Shared-ledger policy: any household member may edit or soft-delete any of
 * the household's transactions (the existing transactions_update RLS
 * already permits exactly this — no created_by restriction, no migration).
 * Both operations are optimistic-concurrency-guarded on `updated_at`: the
 * edit screen captures the token it first saw and passes it back verbatim;
 * a mismatch (someone else changed or deleted the row first) fails the
 * write instead of silently overwriting.
 *
 * Hard DELETE is never used — there is no client DELETE grant/policy, and
 * "delete" means `UPDATE ... SET deleted_at = <now>`.
 * ================================================================== */

/**
 * Does the stored row already hold exactly what this edit would write?
 * Used only on the 0-row path, to tell "my earlier UPDATE landed but its
 * response was lost" (idempotent success) from a genuine concurrent change.
 * `updated_at` is NOT part of this — it is the token, not desired content.
 */
function financialFieldsMatch(
  existing: Record<string, unknown>,
  row: TransactionUpdateRow,
): boolean {
  // STEP 16-G2-C2 §6: when `card_id` is absent from the PATCH body the
  // mapper deliberately preserved a dangling deleted-card link — the stored
  // value is whatever it already was, so it can never make this a mismatch.
  const cardIdMatches =
    !('card_id' in row) ||
    ((existing.card_id as string | null) ?? null) === row.card_id;

  return (
    existing.type === row.type &&
    existing.category === row.category &&
    Number(existing.amount) === Number(row.amount) &&
    ((existing.memo as string | null) ?? '') === row.memo &&
    new Date(existing.date as string).getTime() === new Date(row.date).getTime() &&
    ((existing.payment_method as string | null) ?? null) === row.payment_method &&
    cardIdMatches &&
    ((existing.installment_months as number | null) ?? null) === row.installment_months &&
    splitsEqual(existing.splits, row.splits)
  );
}

export async function updateTransaction(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string the edit screen first saw — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewTransactionDraft;
  knownCardIds: ReadonlySet<string>;
  /**
   * transactionMeta.rawCardId — the transaction's ORIGINAL DB card_id.
   * STEP 16-G2-C2 §5: lets buildTransactionUpdate preserve (omit) a
   * card_id that points at a now-soft-deleted card instead of null-ing it.
   */
  originalRawCardId?: string | null;
}): Promise<UpdateTransactionResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, reason: 'identity', message: '다시 로그인해 주세요.' };
  if (liveUserId !== args.expectedUserId) {
    return { ok: false, reason: 'identity', message: IDENTITY_CHANGED };
  }

  const row = buildTransactionUpdate(args.draft, {
    knownCardIds: args.knownCardIds,
    originalRawCardId: args.originalRawCardId ?? null,
  });

  const { data, error } = await supabase
    .from('transactions')
    .update(row)
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      transport: isTransportError(error),
    };
  }
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — reconcile against the current row (no updated_at / deleted_at filter).
  const { data: existing, error: readErr } = await supabase
    .from('transactions')
    .select(
      'id,type,category,amount,memo,date,payment_method,card_id,installment_months,splits,deleted_at,updated_at',
    )
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-B1.1: a TRANSPORT failure during the reconcile read is NOT
  // proof the row is gone — it's retryable. A non-transport read error is a
  // plain server error (also more accurate than 'gone'). Only a SUCCESSFUL
  // read that returned no row is genuinely 'gone'.
  const readClass = classifyReconcileReadError(readErr);
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (financialFieldsMatch(existingRow, row)) {
    // Our earlier UPDATE already succeeded; only the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeleteTransaction(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string the edit screen first saw — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, reason: 'identity', message: '다시 로그인해 주세요.' };
  if (liveUserId !== args.expectedUserId) {
    return { ok: false, reason: 'identity', message: IDENTITY_CHANGED };
  }

  // Soft delete = UPDATE deleted_at. `deleted_at` here is a client marker;
  // the server's trg_touch_updated_at still stamps updated_at = now() on
  // this same UPDATE. No hard DELETE, no migration.
  const { data, error } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, deleted_at, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      transport: isTransportError(error),
    };
  }
  if (data?.id) return { ok: true };

  // 0 rows — reconcile (no updated_at / deleted_at filter).
  const { data: existing, error: readErr } = await supabase
    .from('transactions')
    .select('id, deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-B1.1: transport read failure -> retryable error; non-transport
  // read error -> plain server error; only a successful empty read is 'gone'.
  const readClass = classifyReconcileReadError(readErr);
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: DELETE_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  // Row is still active but our updated_at no longer matches: someone edited it first.
  return { ok: false, reason: 'conflict', message: DELETE_CONFLICT };
}
