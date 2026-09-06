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
  type NewTransactionDraft,
  type TransactionInsertRow,
} from '@/lib/remoteFinanceWriteMapping';
import type { TransactionSplit } from '@/store/types';

export type CreateTransactionResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

const GENERIC_ERROR = '거래를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors src/services/remoteFinance.ts). */
function describeWriteError(error: PostgrestError): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return GENERIC_ERROR;
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

    // Can't read it back (RLS says it isn't ours, or a transient read error)
    // -> do NOT treat as success.
    if (readErr || !existing) {
      return { ok: false, message: GENERIC_ERROR };
    }

    if (isSameRequest(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, message: GENERIC_ERROR };
  }

  if (error) return { ok: false, message: describeWriteError(error) };
  return { ok: false, message: GENERIC_ERROR };
}
