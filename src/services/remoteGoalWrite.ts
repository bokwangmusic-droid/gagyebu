/**
 * Remote household savings-goal WRITE layer — STEP 16-G2-D3.
 *
 * Four direct writes, no RPC:
 *   - createGoal      : `.insert()` one `public.goals` row (NEVER `saved`)
 *   - updateGoal      : conditional `.update()` of name/target/deadline/icon
 *   - softDeleteGoal  : `.update({ deleted_at })` — never a hard DELETE
 *   - addGoalMovement : `.insert()` one `public.goal_movements` row with a
 *                       SIGNED `amount_delta`; the DB trigger
 *                       `trg_apply_goal_movement()` then updates
 *                       `goals.saved` atomically. The client NEVER reads
 *                       `saved`, computes a new total and writes it back —
 *                       the `authenticated` UPDATE grant on `public.goals`
 *                       does not even include `saved`.
 *
 * This module writes ONLY `public.goals` and `public.goal_movements`. It
 * NEVER writes `transactions`, never adds/removes a provenance column,
 * never touches an existing goal_movements row on a goal soft-delete.
 *
 * `public.goals` has a client-generated TEXT PK `id` plus
 * `unique(household_id, id)`; `public.goal_movements` has only a TEXT PK
 * `id`. A 23505 on either INSERT can ONLY be that exact id already
 * existing — a lost-response retry. A movement retry MUST reuse the same
 * `gm-...` id: a fresh id would make the trigger apply the delta twice.
 *
 * RLS / triggers (STEP 16-G2-D3 audit): goals_* / goal_movements_* policies
 * permit any household member (owner OR member); the INSERT triggers force
 * `created_by = auth.uid()`; the UPDATE triggers freeze
 * id/household_id/created_by/created_at (+ goal_id for movements) and
 * auto-touch updated_at; there is NO DELETE grant / policy, so hard delete
 * is impossible. `trg_apply_goal_movement()` is SECURITY DEFINER and
 * row-locks the target goal, so concurrent deposits/withdrawals serialise;
 * a would-be-negative `saved` trips `goals_saved_non_negative` and aborts
 * the whole movement INSERT statement (SQLSTATE 23514).
 *
 * Session identity: every write re-checks the live session and refuses if
 * it no longer matches `expectedUserId`.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  buildGoalInsert,
  buildGoalMovementInsert,
  buildGoalUpdate,
  isValidGoalDraft,
  isValidGoalMovementDraft,
  type GoalInsertRow,
  type NewGoalDraft,
  type NewGoalMovementDraft,
} from '@/lib/remoteGoalWriteMapping';

export type GoalWriteReason =
  | 'identity'
  | 'invalid'
  | 'conflict'
  | 'deleted'
  | 'gone'
  | 'error';

/** addGoalMovement can additionally fail with `insufficient` (23514). */
export type GoalMovementReason = GoalWriteReason | 'insufficient';

export type CreateGoalResult =
  | { ok: true; id: string }
  | { ok: false; reason: GoalWriteReason; message: string };

export type UpdateGoalResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: GoalWriteReason; message: string };

export type SoftDeleteGoalResult =
  | { ok: true }
  | { ok: false; reason: Exclude<GoalWriteReason, 'invalid' | 'deleted'>; message: string };

export type AddGoalMovementResult =
  | { ok: true }
  | { ok: false; reason: Exclude<GoalMovementReason, never>; message: string };

const GENERIC_ERROR = '저축 목표를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const MOVEMENT_ERROR = '저축 금액을 반영하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const INVALID = '저축 목표 정보를 확인해 주세요.';
const INVALID_AMOUNT = '금액을 확인해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 저축 목표예요. 최신 내용을 불러올게요.';
const GOAL_GONE = '삭제됐거나 찾을 수 없는 저축 목표예요. 최신 내용을 불러올게요.';
const INSUFFICIENT = '현재 모은 금액보다 많이 인출할 수 없어요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors remoteCardWrite.ts). */
function describeWriteError(error: PostgrestError, fallback = GENERIC_ERROR): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return fallback;
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

/** Does a goal row read back after a 23505 represent the SAME create, by the
 *  SAME user, still active? A soft-deleted row is an id collision, not an
 *  idempotent success — never revived (STEP 16-G2-D3 §6). */
function isSameGoalCreate(
  existing: Record<string, unknown>,
  row: GoalInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.deleted_at == null &&
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.name === row.name &&
    existing.target === row.target &&
    existing.deadline === row.deadline &&
    existing.icon === row.icon
  );
}

/** Does the stored goal already hold exactly what this edit would write? */
function goalFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildGoalUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    existing.target === row.target &&
    existing.deadline === row.deadline &&
    existing.icon === row.icon
  );
}

/* ================================================================== *
 * CREATE
 * ================================================================== */

export async function createGoal(args: {
  /** Client-generated `goal-...` id, stable across retries of ONE form mount. */
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewGoalDraft;
}): Promise<CreateGoalResult> {
  if (!isValidGoalDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildGoalInsert(args.draft, { id: args.id, householdId: args.householdId });

  const { data, error } = await supabase
    .from('goals')
    .insert(row) // `saved` omitted -> DB default 0; `created_by` set by trigger
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true, id: data.id as string };

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('goals')
      .select('id,household_id,created_by,name,target,deadline,icon,deleted_at')
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
    if (!existing) return { ok: false, reason: 'error', message: GENERIC_ERROR };
    if (isSameGoalCreate(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, reason: 'conflict', message: GENERIC_ERROR };
  }

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  return { ok: false, reason: 'error', message: GENERIC_ERROR };
}

/* ================================================================== *
 * UPDATE (name / target / deadline / icon — NEVER saved)
 * ================================================================== */

export async function updateGoal(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured at form MOUNT — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewGoalDraft;
}): Promise<UpdateGoalResult> {
  if (!isValidGoalDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildGoalUpdate(args.draft); // { name, target, deadline, icon } — no saved, no identity

  const { data, error } = await supabase
    .from('goals')
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
    .from('goals')
    .select('name,target,deadline,icon,deleted_at,updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (goalFieldsMatch(existingRow, row)) {
    // Our earlier edit already landed; the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

/* ================================================================== *
 * SOFT DELETE (goal_movements + transactions untouched)
 * ================================================================== */

export async function softDeleteGoal(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured BEFORE the confirm Alert — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteGoalResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('goals')
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
    .from('goals')
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

/* ================================================================== *
 * ADD MOVEMENT (deposit / withdrawal) — goal_movements INSERT only
 * ================================================================== */

export async function addGoalMovement(args: {
  /** Client-generated `gm-...` id, STABLE across every save retry of one sheet. */
  movementId: string;
  householdId: string;
  goalId: string;
  expectedUserId: string;
  draft: NewGoalMovementDraft;
}): Promise<AddGoalMovementResult> {
  if (!isValidGoalMovementDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID_AMOUNT };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  // Best-effort parent-active precheck (STEP 16-G2-D3 §9). There is no DB
  // atomic "parent still active" guard between this SELECT and the INSERT,
  // so this is the freshest check available without a migration/RPC.
  const { data: goal, error: goalErr } = await supabase
    .from('goals')
    .select('id, deleted_at')
    .eq('household_id', args.householdId)
    .eq('id', args.goalId)
    .maybeSingle();

  if (goalErr) return { ok: false, reason: 'error', message: describeWriteError(goalErr, MOVEMENT_ERROR) };
  if (!goal) return { ok: false, reason: 'gone', message: GOAL_GONE };
  if ((goal as Record<string, unknown>).deleted_at != null) {
    return { ok: false, reason: 'deleted', message: GOAL_GONE };
  }

  const row = buildGoalMovementInsert(args.draft, {
    id: args.movementId,
    householdId: args.householdId,
    goalId: args.goalId,
  });

  const { data, error } = await supabase
    .from('goal_movements')
    .insert(row) // `created_by` set by trigger; `trg_apply_goal_movement` updates goals.saved
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true };

  // Withdrawal would take goals.saved below 0 -> goals_saved_non_negative
  // CHECK aborts the whole statement (SQLSTATE 23514). Never applied.
  if (error?.code === '23514') {
    return { ok: false, reason: 'insufficient', message: INSUFFICIENT };
  }

  // Parent goal vanished in the precheck->insert window (should be
  // impossible — no hard delete — but the composite FK would raise 23503).
  if (error?.code === '23503') {
    return { ok: false, reason: 'gone', message: GOAL_GONE };
  }

  // Same movement id already exists — a lost-response retry. NEVER retry
  // with a fresh id (the trigger would double-apply). Verify it is OUR
  // movement before reporting idempotent success.
  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('goal_movements')
      .select('id,household_id,goal_id,created_by,amount_delta,deleted_at')
      .eq('id', args.movementId)
      .maybeSingle();

    if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr, MOVEMENT_ERROR) };
    if (!existing) return { ok: false, reason: 'error', message: MOVEMENT_ERROR };
    const ex = existing as Record<string, unknown>;
    if (
      ex.deleted_at == null &&
      ex.household_id === args.householdId &&
      ex.goal_id === args.goalId &&
      ex.created_by === args.expectedUserId &&
      ex.amount_delta === row.amount_delta
    ) {
      // Our earlier movement already landed and was already applied.
      return { ok: true };
    }
    return { ok: false, reason: 'conflict', message: MOVEMENT_ERROR };
  }

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error, MOVEMENT_ERROR) };
  return { ok: false, reason: 'error', message: MOVEMENT_ERROR };
}
