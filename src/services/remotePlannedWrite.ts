/**
 * Remote household planned-expense WRITE layer — STEP 16-G2-D1.
 *
 * Three direct writes, no RPC:
 *   - createPlanned     : `.insert()` one `public.planned_expenses` row
 *   - updatePlanned     : conditional `.update()` of
 *                         name/amount/category/date/memo (NEVER type)
 *   - softDeletePlanned : `.update({ deleted_at })` — never a hard DELETE
 *
 * This module writes ONLY `public.planned_expenses`. It NEVER writes
 * `transactions` (no "complete this planned item into a real transaction"
 * step in this STEP), and never touches `from_planned`, recurring rules,
 * goals or loans.
 *
 * `public.planned_expenses` has a client-generated TEXT PK `id` plus
 * `unique(household_id, id)`, so a 23505 on INSERT can ONLY be that exact
 * `(household_id, id)` already existing — a lost-response retry, never a
 * "duplicate name" (name/date/category are free text with no uniqueness).
 * A 23505 is reconciled by re-reading the row and confirming it is the
 * SAME create by the SAME user before reporting idempotent success — never
 * a blind success. `type` is product-immutable after create and is never
 * in an UPDATE payload.
 *
 * RLS / triggers (from the audit): planned_expenses_* policies permit any
 * household member (owner OR member) to SELECT / INSERT / UPDATE; the
 * INSERT trigger forces `created_by = auth.uid()`; the UPDATE trigger
 * freezes id/household_id/created_by/created_at and auto-touches
 * updated_at; `authenticated` has NO DELETE grant / NO DELETE policy, so a
 * hard delete is impossible — every "delete" here is an UPDATE of
 * deleted_at.
 *
 * Session identity: every write re-checks the live session and refuses if
 * it no longer matches `expectedUserId` (same HARDEN as card/budget/
 * category).
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  buildPlannedInsert,
  buildPlannedUpdate,
  isValidPlannedDraft,
  type NewPlannedExpenseDraft,
  type PlannedInsertRow,
} from '@/lib/remotePlannedWriteMapping';

export type PlannedWriteReason =
  | 'identity'
  | 'invalid'
  | 'conflict'
  | 'deleted'
  | 'gone'
  | 'error';

export type CreatePlannedResult =
  | { ok: true; id: string }
  | { ok: false; reason: PlannedWriteReason; message: string };

export type UpdatePlannedResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: PlannedWriteReason; message: string };

export type SoftDeletePlannedResult =
  | { ok: true }
  | { ok: false; reason: Exclude<PlannedWriteReason, 'invalid' | 'deleted'>; message: string };

const GENERIC_ERROR = '예정 지출을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const INVALID = '예정 지출 정보를 확인해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 예정 지출이에요. 최신 내용을 불러올게요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors remoteCardWrite.ts). */
function describeWriteError(error: PostgrestError): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return GENERIC_ERROR;
}

async function assertLiveUser(
  expectedUserId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, message: RELOGIN };
  if (liveUserId !== expectedUserId) return { ok: false, message: IDENTITY_CHANGED };
  return { ok: true };
}

/** Does a row read back after a 23505 represent the SAME create, by the SAME user? */
function isSameCreateRow(
  existing: Record<string, unknown>,
  row: PlannedInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.name === row.name &&
    existing.amount === row.amount &&
    existing.category === row.category &&
    existing.date === row.date &&
    existing.memo === row.memo &&
    existing.type === row.type
  );
}

/** Does the stored row already hold exactly what this edit would write? */
function plannedFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildPlannedUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    existing.amount === row.amount &&
    existing.category === row.category &&
    existing.date === row.date &&
    existing.memo === row.memo
  );
}

export async function createPlanned(args: {
  /** Client-generated `p-...` id, stable across retries of ONE form mount. */
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewPlannedExpenseDraft;
}): Promise<CreatePlannedResult> {
  if (!isValidPlannedDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildPlannedInsert(args.draft, {
    id: args.id,
    householdId: args.householdId,
  });

  const { data, error } = await supabase
    .from('planned_expenses')
    .insert(row)
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true, id: data.id as string };

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('planned_expenses')
      .select('id,household_id,created_by,name,amount,category,date,memo,type')
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
    if (!existing) return { ok: false, reason: 'error', message: GENERIC_ERROR };
    if (isSameCreateRow(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, reason: 'conflict', message: GENERIC_ERROR };
  }

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  return { ok: false, reason: 'error', message: GENERIC_ERROR };
}

export async function updatePlanned(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured at form MOUNT — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewPlannedExpenseDraft;
}): Promise<UpdatePlannedResult> {
  if (!isValidPlannedDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildPlannedUpdate(args.draft); // { name, amount, category, date, memo } — no type

  const { data, error } = await supabase
    .from('planned_expenses')
    .update(row)
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, updated_at')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — reconcile against the authoritative row.
  const { data: existing, error: readErr } = await supabase
    .from('planned_expenses')
    .select('name,amount,category,date,memo,deleted_at,updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (plannedFieldsMatch(existingRow, row)) {
    // Our earlier edit already landed; the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeletePlanned(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured BEFORE the confirm Alert — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeletePlannedResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('planned_expenses')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, deleted_at, updated_at')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (data?.id) return { ok: true };

  // 0 rows — reconcile.
  const { data: existing, error: readErr } = await supabase
    .from('planned_expenses')
    .select('deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  // Still active but our updated_at no longer matches — someone edited it first.
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}
