/**
 * Remote household asset WRITE layer — 전체자산/순자산 STEP 4.
 *
 * The asset counterpart of src/services/remoteCardWrite.ts. Three direct
 * writes against `public.assets`:
 *   - createAsset      : `.insert()` one new row
 *   - updateAsset      : `.update()` the user-editable fields
 *   - softDeleteAsset  : `.update({ deleted_at })` — never a hard DELETE
 *
 * No RPC. Same reasoning as cards: the assets_insert / assets_update RLS
 * policies already permit any household member (owner OR member) to touch
 * any of the household's assets, private.trg_lock_identity() already
 * forces created_by = auth.uid() on INSERT and freezes
 * id/household_id/created_by/created_at on UPDATE, and
 * private.trg_touch_updated_at() already stamps updated_at = now() on
 * every UPDATE. `authenticated` has no DELETE grant and there is no assets
 * DELETE policy, so a hard delete is impossible from here even if
 * attempted.
 *
 * ONLINE-ONLY (deliberate, this STEP): unlike cards/loans/etc., these
 * functions are NOT wired to the offline write queue
 * (src/services/offlineQueue/coordinator.*.ts) or to `usePendingWrites()`.
 * When the device is offline, the `.insert()`/`.update()` calls below
 * simply fail with a transport error (`isTransportError` -> `true`,
 * exactly as every other entity's write behaved BEFORE its own offline
 * queue was added) and the caller sees an ordinary failed-write result —
 * no silent queueing, no optimistic local row. That is the correct
 * "existing online-only entity" behaviour to fall back to; a future STEP
 * may add `enqueueAssetCreate`/`enqueueAssetUpdate`/`enqueueAssetDelete`
 * the same way cards/loans got theirs, but this STEP does not.
 *
 * Session identity (mirrors remoteCardWrite.ts): the caller passes the
 * `expectedUserId` its trusted screen was validated against; if the live
 * Supabase session's user id no longer matches, the write is NOT attempted.
 *
 * Idempotency: createAsset takes a client-generated id stable across
 * retries; a 23505 is re-read and only reported as success when the stored
 * row is field-for-field the same request AND created_by this same user —
 * never a blind success. updateAsset / softDeleteAsset are optimistic-
 * concurrency-guarded on `updated_at` and reconcile a 0-row result the same
 * way updateCard / softDeleteCard do.
 *
 * Every result carries an additive optional `transport?: boolean` — `true`
 * only for a NETWORK/TRANSPORT failure (primary write OR reconcile-read),
 * never for a 23505, an RLS/PGRST verdict, or a successful-but-empty
 * reselect (same taxonomy as every other write service, src/lib/
 * transportError.ts). It has no consumer in THIS STEP (no offline queue
 * reads it yet) — kept only so a future queue wiring is additive, not a
 * reshape of this module's result types.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  buildAssetInsert,
  buildAssetUpdate,
  isValidAssetDraft,
  type AssetInsertRow,
  type NewAssetDraft,
} from '@/lib/remoteAssetWriteMapping';
import { classifyWriteReadError, isTransportError } from '@/lib/transportError';

export type CreateAssetResult =
  | { ok: true; id: string }
  | { ok: false; message: string; transport?: boolean };

/** Every non-ok end state for an asset edit / soft delete. */
export type AssetWriteConflictReason = 'identity' | 'invalid' | 'conflict' | 'deleted' | 'gone' | 'error';

export type UpdateAssetResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: AssetWriteConflictReason; message: string; transport?: boolean };

export type SoftDeleteAssetResult =
  | { ok: true }
  | { ok: false; reason: Exclude<AssetWriteConflictReason, 'invalid'>; message: string; transport?: boolean };

const GENERIC_ERROR = '자산을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const INVALID = '자산 정보를 확인해 주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 자산이에요. 최신 내용을 다시 불러올게요.';
const DELETE_CONFLICT = '다른 곳에서 이미 변경됐거나 삭제된 자산이에요.';
const RELOGIN = '다시 로그인해 주세요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors remoteCardWrite.ts). */
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
 * request, made by the SAME user, still active? A soft-deleted row is an
 * id collision, never an idempotent success — never revived (mirrors
 * `isSameLoanCreate`).
 */
function isSameAssetRequest(
  existing: Record<string, unknown>,
  row: AssetInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.deleted_at == null &&
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.name === row.name &&
    existing.type === row.type &&
    Number(existing.balance) === row.balance
  );
}

/** Does the stored row already hold exactly what this edit would write? */
function assetFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildAssetUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    existing.type === row.type &&
    Number(existing.balance) === row.balance
  );
}

export async function createAsset(args: {
  /** Client-generated `asset-...` id, fixed for the form's lifetime (src/lib/id.ts). */
  id: string;
  /** CURRENT trusted active household id. */
  householdId: string;
  /** The user id the calling screen validated its trusted state against. */
  expectedUserId: string;
  draft: NewAssetDraft;
}): Promise<CreateAssetResult> {
  if (!isValidAssetDraft(args.draft)) {
    return { ok: false, message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, message: live.message };

  const row = buildAssetInsert(args.draft, {
    id: args.id,
    householdId: args.householdId,
  });

  const { data, error } = await supabase
    .from('assets')
    .insert(row)
    .select('id')
    .single();

  if (!error && data?.id) {
    return { ok: true, id: data.id as string };
  }

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('assets')
      .select('id,household_id,created_by,name,type,balance,deleted_at')
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    const readClass = classifyWriteReadError(readErr, describeWriteError);
    if (readClass?.transport) {
      return { ok: false, message: readClass.message, transport: true };
    }
    if (readErr || !existing) {
      return { ok: false, message: GENERIC_ERROR };
    }

    if (isSameAssetRequest(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, message: GENERIC_ERROR };
  }

  // A non-23505 error: transport (offline) or an unexpected server error.
  if (error) {
    return { ok: false, message: describeWriteError(error), transport: isTransportError(error) };
  }
  return { ok: false, message: GENERIC_ERROR };
}

export async function updateAsset(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string the edit screen first saw — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewAssetDraft;
}): Promise<UpdateAssetResult> {
  if (!isValidAssetDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildAssetUpdate(args.draft);

  const { data, error } = await supabase
    .from('assets')
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
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — reconcile against the current row (no updated_at / deleted_at filter).
  const { data: existing, error: readErr } = await supabase
    .from('assets')
    .select('id,name,type,balance,deleted_at,updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  const readClass = classifyWriteReadError(readErr, describeWriteError);
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
  if (assetFieldsMatch(existingRow, row)) {
    // Our earlier UPDATE already succeeded; only the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeleteAsset(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string the edit screen first saw — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteAssetResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  // Soft delete = UPDATE deleted_at, ONLY on public.assets. The server's
  // trg_touch_updated_at still stamps updated_at = now() on this same
  // UPDATE. No hard DELETE, no migration.
  const { data, error } = await supabase
    .from('assets')
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
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.id) return { ok: true };

  // 0 rows — reconcile (no updated_at / deleted_at filter).
  const { data: existing, error: readErr } = await supabase
    .from('assets')
    .select('id, deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  const readClass = classifyWriteReadError(readErr, describeWriteError);
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
