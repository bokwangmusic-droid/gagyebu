/**
 * Local input draft -> `public.goals` INSERT / UPDATE row and
 * `public.goal_movements` INSERT row — STEP 16-G2-D3.
 *
 * The savings-goal counterpart of src/lib/remotePlannedWriteMapping.ts /
 * src/lib/remoteRecurringWriteMapping.ts. Pure transform: no Supabase, no
 * AsyncStorage, no React state.
 *
 * `public.goals` has a client-generated TEXT primary key `id` plus
 * `unique(household_id, id)`, so a 23505 on INSERT can ONLY be that exact
 * `(household_id, id)` already existing — a lost-response retry.
 *
 * ---- `goals` payloads deliberately NEVER carry (STEP 16-G2-D3 §3) ----
 *   - saved : a server-maintained cache. The `authenticated` UPDATE grant
 *             on `public.goals` does not even include `saved`; only the
 *             `trg_apply_goal_movement()` trigger (SECURITY DEFINER) can
 *             change it, fed by a `goal_movements` INSERT. A client that
 *             puts `saved` in a SET list is rejected at the column-privilege
 *             level.
 *   - created_by : server-forced by the INSERT trigger to auth.uid(), and
 *             frozen on UPDATE.
 *   - created_at / updated_at : server-managed.
 *   - deleted_at : soft-delete is its own service call.
 *   - id / household_id : on UPDATE they are `.eq(...)` filters and are
 *             trigger-locked.
 *
 * ---- `goal_movements` INSERT (STEP 16-G2-D3 §4/§9) ----
 * The user always types a POSITIVE amount; `mode` decides the sign. The
 * signed `amount_delta` is what the DB trigger applies to `goals.saved`
 * atomically. `memo` is omitted this STEP. `created_by` is trigger-forced.
 * The movement `id` is client-generated (`gm-...`) and MUST be stable
 * across save retries — a fresh id would let the trigger apply the delta
 * twice.
 */
import { isValidDateKey } from '@/lib/remotePlannedWriteMapping';

/* ================================================================== *
 * goals — CREATE / UPDATE
 * ================================================================== */

/**
 * What the goal form produces. Purely the user-editable shape — carries no
 * id, no household id, no `saved`, no ownership/identity/timestamp field.
 */
export interface NewGoalDraft {
  name: string;
  /** Won, positive integer (same unit policy as every other money field). */
  target: number;
  /** Local YYYY-MM-DD, or null when the goal has no deadline. */
  deadline: string | null;
  icon: string;
}

/**
 * Client-side guard — never lean on the DB CHECK / NOT-NULL for UX
 * (STEP 16-G2-D3 §3). Shared by CREATE and UPDATE.
 */
export function isValidGoalDraft(draft: NewGoalDraft): boolean {
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) return false;
  if (
    typeof draft.target !== 'number' ||
    !Number.isFinite(draft.target) ||
    !Number.isInteger(draft.target) ||
    draft.target <= 0
  ) {
    return false;
  }
  if (draft.deadline !== null) {
    if (typeof draft.deadline !== 'string' || !isValidDateKey(draft.deadline)) return false;
  }
  if (typeof draft.icon !== 'string' || draft.icon.trim().length === 0) return false;
  return true;
}

export interface BuildGoalInsertContext {
  /** Client-generated `goal-...` id (src/lib/id.ts), fixed for one form mount. */
  id: string;
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
}

/** The exact column set sent to `public.goals` on INSERT. `saved` is NOT
 *  here — the DB default (0) applies. */
export interface GoalInsertRow {
  id: string;
  household_id: string;
  name: string;
  target: number;
  deadline: string | null;
  icon: string;
}

export function buildGoalInsert(draft: NewGoalDraft, ctx: BuildGoalInsertContext): GoalInsertRow {
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    name: draft.name.trim(),
    target: draft.target,
    deadline: draft.deadline,
    icon: draft.icon,
  };
}

/**
 * The PATCH body for an existing goal. ONLY the user-editable fields —
 * NEVER `saved`, `id`, `household_id`, or any server/identity column.
 */
export interface GoalUpdateRow {
  name: string;
  target: number;
  deadline: string | null;
  icon: string;
}

export function buildGoalUpdate(draft: NewGoalDraft): GoalUpdateRow {
  return {
    name: draft.name.trim(),
    target: draft.target,
    deadline: draft.deadline,
    icon: draft.icon,
  };
}

/* ================================================================== *
 * goal_movements — deposit / withdrawal INSERT
 * ================================================================== */

export type GoalMovementMode = 'deposit' | 'withdraw';

/**
 * What the deposit/withdraw sheet produces. `amount` is ALWAYS the
 * positive integer the user typed; `mode` (never a typed minus sign)
 * decides the sign of the stored `amount_delta`.
 */
export interface NewGoalMovementDraft {
  mode: GoalMovementMode;
  amount: number;
}

/** Client-side guard — 0 / non-integer / negative amounts are blocked here
 *  so the DB CHECK (`amount_delta <> 0`) is never the first line of UX. */
export function isValidGoalMovementDraft(draft: NewGoalMovementDraft): boolean {
  if (draft.mode !== 'deposit' && draft.mode !== 'withdraw') return false;
  if (
    typeof draft.amount !== 'number' ||
    !Number.isFinite(draft.amount) ||
    !Number.isInteger(draft.amount) ||
    draft.amount <= 0
  ) {
    return false;
  }
  return true;
}

export interface BuildGoalMovementInsertContext {
  /** Client-generated `gm-...` id, STABLE across every save retry of one sheet. */
  id: string;
  householdId: string;
  goalId: string;
}

/** The exact column set sent to `public.goal_movements` on INSERT.
 *  `memo` is omitted this STEP; `created_by` is trigger-forced. */
export interface GoalMovementInsertRow {
  id: string;
  household_id: string;
  goal_id: string;
  amount_delta: number;
}

export function buildGoalMovementInsert(
  draft: NewGoalMovementDraft,
  ctx: BuildGoalMovementInsertContext,
): GoalMovementInsertRow {
  const magnitude = Math.abs(draft.amount);
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    goal_id: ctx.goalId,
    amount_delta: draft.mode === 'deposit' ? magnitude : -magnitude,
  };
}
