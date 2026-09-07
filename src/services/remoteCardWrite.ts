/**
 * Remote household card WRITE layer — STEP 16-G2-C2.
 *
 * The card counterpart of src/services/remoteFinanceWrite.ts (which stays
 * transaction-only). Three direct writes against `public.cards`:
 *   - createCard      : `.insert()` one new row
 *   - updateCard      : `.update()` the user-editable fields
 *   - softDeleteCard  : `.update({ deleted_at })` — never a hard DELETE
 *
 * No RPC. STEP 16-G2-C1 established this is safe as a direct write: the
 * cards_insert / cards_update RLS policies already permit any household
 * member (owner OR member) to touch any of the household's cards,
 * private.trg_lock_identity() already forces created_by = auth.uid() on
 * INSERT and freezes id/household_id/created_by/created_at on UPDATE, and
 * private.trg_touch_updated_at() already stamps updated_at = now() on every
 * UPDATE. `authenticated` has no DELETE grant and there is no cards DELETE
 * policy, so a hard delete is impossible from here even if attempted.
 *
 * softDeleteCard writes ONLY `public.cards`. It never touches
 * `public.transactions` — a card being removed must not modify, null, or
 * bulk-update any transaction row (STEP 16-G2-C2 §18). Past transactions
 * keep their real DB `card_id`; the read model shows them as "카드 미지정".
 *
 * Session identity (mirrors remoteFinanceWrite.ts): the caller passes the
 * `expectedUserId` its trusted screen was validated against; if the live
 * Supabase session's user id no longer matches, the write is NOT attempted.
 *
 * Idempotency: createCard takes a client-generated id stable across
 * retries; a 23505 is re-read and only reported as success when the stored
 * row is field-for-field the same request AND created_by this same user —
 * never a blind success. updateCard / softDeleteCard are optimistic-
 * concurrency-guarded on `updated_at` and reconcile a 0-row result the
 * same way updateTransaction / softDeleteTransaction do.
 *
 * Small, deliberate duplication with remoteFinanceWrite.ts (error
 * describer, conflict-reason union, the 0-row reconcile shape) is accepted
 * per STEP 16-G2-C2 §10 — safety over a premature shared-helper refactor.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  buildCardInsert,
  buildCardUpdate,
  type CardInsertRow,
  type NewCardDraft,
} from '@/lib/remoteCardWriteMapping';

export type CreateCardResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

/** Every non-ok end state for a card edit / soft delete. */
export type CardWriteConflictReason = 'identity' | 'conflict' | 'deleted' | 'gone' | 'error';

export type UpdateCardResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: CardWriteConflictReason; message: string };

export type SoftDeleteCardResult =
  | { ok: true }
  | { ok: false; reason: CardWriteConflictReason; message: string };

const GENERIC_ERROR = '카드를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 카드예요. 최신 내용을 다시 불러올게요.';
const DELETE_CONFLICT = '다른 곳에서 이미 변경됐거나 삭제된 카드예요.';
const RELOGIN = '다시 로그인해 주세요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors src/services/remoteFinanceWrite.ts). */
function describeWriteError(error: PostgrestError): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return GENERIC_ERROR;
}

/** The live session must be exactly the user the trusted screen was built for. */
async function assertLiveUser(
  expectedUserId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, message: RELOGIN };
  if (liveUserId !== expectedUserId) return { ok: false, message: IDENTITY_CHANGED };
  return { ok: true };
}

/**
 * Does a stored row (read back after a 23505) represent the SAME create
 * request, made by the SAME user? Every field the app is allowed to send
 * for a new card, plus created_by. Days compared as nullable numbers,
 * colours as nullable strings; everything exact.
 */
function isSameCardRequest(
  existing: Record<string, unknown>,
  row: CardInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.name === row.name &&
    ((existing.color_bg as string | null) ?? null) === row.color_bg &&
    ((existing.color_fg as string | null) ?? null) === row.color_fg &&
    ((existing.payment_day as number | null) ?? null) === row.payment_day &&
    ((existing.closing_day as number | null) ?? null) === row.closing_day
  );
}

/** Does the stored row already hold exactly what this edit would write? */
function cardFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildCardUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    ((existing.color_bg as string | null) ?? null) === row.color_bg &&
    ((existing.color_fg as string | null) ?? null) === row.color_fg &&
    ((existing.payment_day as number | null) ?? null) === row.payment_day &&
    ((existing.closing_day as number | null) ?? null) === row.closing_day
  );
}

export async function createCard(args: {
  /** Client-generated `card-...` id, fixed for the form's lifetime (src/lib/id.ts). */
  id: string;
  /** CURRENT trusted active household id. */
  householdId: string;
  /** The user id the calling screen validated its trusted state against. */
  expectedUserId: string;
  draft: NewCardDraft;
}): Promise<CreateCardResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, message: live.message };

  const row = buildCardInsert(args.draft, {
    id: args.id,
    householdId: args.householdId,
  });

  const { data, error } = await supabase
    .from('cards')
    .insert(row)
    .select('id')
    .single();

  if (!error && data?.id) {
    return { ok: true, id: data.id as string };
  }

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('cards')
      .select('id,household_id,created_by,name,color_bg,color_fg,payment_day,closing_day')
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    // Can't read it back (RLS says it isn't ours, or a transient read error)
    // -> do NOT treat as success.
    if (readErr || !existing) {
      return { ok: false, message: GENERIC_ERROR };
    }

    if (isSameCardRequest(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, message: GENERIC_ERROR };
  }

  if (error) return { ok: false, message: describeWriteError(error) };
  return { ok: false, message: GENERIC_ERROR };
}

export async function updateCard(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string the edit screen first saw — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewCardDraft;
}): Promise<UpdateCardResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildCardUpdate(args.draft);

  const { data, error } = await supabase
    .from('cards')
    .update(row)
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, updated_at')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — reconcile against the current row (no updated_at / deleted_at filter).
  const { data: existing, error: readErr } = await supabase
    .from('cards')
    .select('id,name,color_bg,color_fg,payment_day,closing_day,deleted_at,updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // A failed reselect (network / RLS / transient) is NOT "the row is gone" —
  // classify it as 'error' so the caller retries instead of treating a
  // still-existing card as deleted. Only a successful reselect that returns
  // no row is 'gone'.
  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (cardFieldsMatch(existingRow, row)) {
    // Our earlier UPDATE already succeeded; only the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeleteCard(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string the edit screen first saw — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteCardResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  // Soft delete = UPDATE deleted_at, ONLY on public.cards. The server's
  // trg_touch_updated_at still stamps updated_at = now() on this same
  // UPDATE. No hard DELETE, no transactions write, no migration.
  const { data, error } = await supabase
    .from('cards')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, deleted_at, updated_at')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (data?.id) return { ok: true };

  // 0 rows — reconcile (no updated_at / deleted_at filter).
  const { data: existing, error: readErr } = await supabase
    .from('cards')
    .select('id, deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // A failed reselect (network / RLS / transient) is NOT "the row is gone" —
  // classify it as 'error'. Only a successful reselect returning no row is
  // 'gone'.
  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: DELETE_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  // Row is still active but our updated_at no longer matches: someone edited it first.
  return { ok: false, reason: 'conflict', message: DELETE_CONFLICT };
}
