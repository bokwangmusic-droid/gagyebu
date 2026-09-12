/**
 * Per-row offline-op state for the CATEGORY-management and BUDGET-management
 * screens — the glue between `composeFinance`'s pure `*Management` views
 * (src/lib/offlineQueue.ts) and the screen-facing maps `useFinanceRead`
 * returns. PURE: no Supabase, no React, no persistence.
 *
 * STEP 16-H2 A4.3 — a marker in a management view's `opById` is backed by
 * EITHER a single-table op (`entity:'category'` / `entity:'budget'`) OR a
 * composite delete (`entity:'categoryBudget'`). The A4.2 collision guard
 * means never BOTH for one id, so the resolution is unambiguous: a
 * single-table op wins the `queueId` / failure-`reason` lookup; otherwise
 * they come from the composite queue. NEITHER record is ever converted into
 * the other's type, and no `queueId` / `expectedUpdatedAt` is fabricated —
 * the composite record keeps its own `entity:'categoryBudget'` identity and
 * its real durable `queueId`.
 */
import type {
  BudgetManagementView,
  CategoryManagementView,
  GoalManagementView,
  PendingWrite,
  PlannedManagementView,
  RecurringManagementView,
} from '@/lib/offlineQueue';
import type { GoalMovementMode, NewGoalDraft } from '@/lib/remoteGoalWriteMapping';
import type { NewPlannedExpenseDraft } from '@/lib/remotePlannedWriteMapping';
import type { NewRecurringDraft } from '@/lib/remoteRecurringWriteMapping';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export type ManagementOpKind = 'create' | 'update' | 'delete';

export interface CategoryRowOpState {
  op: ManagementOpKind;
  failed: boolean;
  reason?: WriteConflictReason;
  queueId?: string;
  synthetic: boolean;
  attemptedName?: string;
}

export interface BudgetRowOpState {
  op: ManagementOpKind;
  failed: boolean;
  reason?: WriteConflictReason;
  queueId?: string;
  synthetic: boolean;
  attemptedAmount?: number;
}

export interface PlannedRowOpState {
  op: ManagementOpKind;
  failed: boolean;
  reason?: WriteConflictReason;
  queueId?: string;
  synthetic: boolean;
  /** For a TERMINAL-failed UPDATE, the FULL draft the user tried; conflict
   *  metadata ONLY (the displayed row is the authoritative server row when it
   *  still exists — STEP 16-H2-E1 §14). */
  attemptedDraft?: NewPlannedExpenseDraft;
}

/** The durable `queueId` for `id` in a de-duped `PendingWrite[]` (≤1 op per
 *  `(entity, id)`), or `undefined` when this queue has no op for it. */
function queueIdOf(ops: readonly PendingWrite[], id: string): string | undefined {
  return ops.find((o) => o.entityId === id)?.queueId;
}

export function buildPendingCategoryOps(
  view: CategoryManagementView,
  /** current-scope `entity:'category'` ops (create/update/delete, incl. failed). */
  singleTableOps: readonly PendingWrite[],
  /** current-scope `entity:'categoryBudget'` ops (delete only, incl. failed). */
  compositeOps: readonly PendingWrite[],
  /** category-id -> reason, for a terminal-failed single-table category op. */
  singleTableFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
  /** category-id -> reason, for a terminal-failed composite delete. */
  compositeFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
): Map<string, CategoryRowOpState> {
  const out = new Map<string, CategoryRowOpState>();
  for (const [id, op] of view.opById) {
    const failed = view.failedIds.has(id);
    const stQueueId = queueIdOf(singleTableOps, id);
    const fromSingleTable = stQueueId !== undefined;
    const queueId = fromSingleTable ? stQueueId : queueIdOf(compositeOps, id);
    const reason = fromSingleTable
      ? singleTableFailedReasons.get(id)
      : compositeFailedReasons.get(id);
    out.set(id, {
      op,
      failed,
      synthetic: view.syntheticIds.has(id),
      ...(queueId !== undefined ? { queueId } : {}),
      ...(failed ? { reason } : {}),
      ...(failed && view.attemptedNameById.has(id)
        ? { attemptedName: view.attemptedNameById.get(id) }
        : {}),
    });
  }
  return out;
}

/**
 * STEP 16-H2-E1 — the screen-facing per-row op-state map for a
 * planned-management surface. Planned has NO composite-delete counterpart
 * (unlike category/budget), so this is the single-queue shape: `queueId` and
 * failure `reason` come straight from the one `entity:'planned'` op for the
 * id.
 */
export function buildPendingPlannedOps(
  view: PlannedManagementView,
  /** current-scope `entity:'planned'` ops (create/update/delete, incl. failed). */
  ops: readonly PendingWrite[],
  /** planned-id -> reason, for a terminal-failed planned op. */
  failedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
): Map<string, PlannedRowOpState> {
  const out = new Map<string, PlannedRowOpState>();
  for (const [id, op] of view.opById) {
    const failed = view.failedIds.has(id);
    const queueId = queueIdOf(ops, id);
    out.set(id, {
      op,
      failed,
      synthetic: view.syntheticIds.has(id),
      ...(queueId !== undefined ? { queueId } : {}),
      ...(failed ? { reason: failedReasons.get(id) } : {}),
      ...(failed && view.attemptedDraftById.has(id)
        ? { attemptedDraft: view.attemptedDraftById.get(id) }
        : {}),
    });
  }
  return out;
}

export interface GoalRowOpState {
  op: ManagementOpKind;
  failed: boolean;
  reason?: WriteConflictReason;
  queueId?: string;
  synthetic: boolean;
  /** For a TERMINAL-failed UPDATE, the FULL draft the user tried; conflict
   *  metadata ONLY (the displayed row is the authoritative server row when it
   *  still exists — STEP 16-H2-G1). */
  attemptedDraft?: NewGoalDraft;
  /**
   * STEP 16-H2-G3 — present whenever this marker is backed by a pending or
   * failed deposit/withdraw movement (`{op:'update', ...}` at the generic
   * level — a movement reuses that bucket, same as a full goal edit).
   * DELIBERATELY populated for BOTH the still-pending AND the failed case
   * (unlike `attemptedDraft`, which is failed-only) — the row label needs
   * the mode even while merely pending, to say "저축 전송 대기" / "인출 전송
   * 대기" instead of a generic "수정 전송 대기".
   */
  movement?: { mode: GoalMovementMode; amount: number };
}

/**
 * STEP 16-H2-G1/G3 — the screen-facing per-row op-state map for a
 * goal-management surface. A marker is backed by EITHER a single-table
 * `entity:'goal'` op (create/update/delete) OR a `entity:'goalMovement'` op
 * (deposit/withdraw, keyed by the TARGET `goalId` — its own `entityId` is
 * the movement ledger row's unrelated identity). The coordinator's
 * `enqueueGoalMovementCreate` lock guard means never both for one id, so the
 * resolution is unambiguous: a single-table op wins the `queueId` /
 * failure-`reason` lookup; otherwise they come from the movement queue.
 * Mirrors `buildPendingCategoryOps`'s dual-source shape.
 */
export function buildPendingGoalOps(
  view: GoalManagementView,
  /** current-scope `entity:'goal'` ops (create/update/delete, incl. failed). */
  goalOps: readonly PendingWrite[],
  /** current-scope `entity:'goalMovement'` ops (deposit/withdraw, incl. failed). */
  movementOps: readonly PendingWrite[],
  /** goal-id -> reason, for a terminal-failed single-table goal op. */
  goalFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
  /** MOVEMENT-id (not goal id) -> reason, for a terminal-failed movement. */
  movementFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
): Map<string, GoalRowOpState> {
  const out = new Map<string, GoalRowOpState>();
  for (const [id, op] of view.opById) {
    const failed = view.failedIds.has(id);
    const stQueueId = queueIdOf(goalOps, id);
    const fromSingleTable = stQueueId !== undefined;
    // A movement's OWN `entityId` is its ledger row's id, not the goal id —
    // it is found by `goalId`, unlike `queueIdOf`'s generic `entityId` match.
    const movementOp = fromSingleTable
      ? undefined
      : movementOps.find(
          (o): o is Extract<PendingWrite, { entity: 'goalMovement' }> =>
            o.entity === 'goalMovement' && o.goalId === id,
        );
    const queueId = fromSingleTable ? stQueueId : movementOp?.queueId;
    const reason = fromSingleTable
      ? goalFailedReasons.get(id)
      : movementOp
        ? movementFailedReasons.get(movementOp.entityId)
        : undefined;
    out.set(id, {
      op,
      failed,
      synthetic: view.syntheticIds.has(id),
      ...(queueId !== undefined ? { queueId } : {}),
      ...(failed ? { reason } : {}),
      ...(failed && view.attemptedDraftById.has(id)
        ? { attemptedDraft: view.attemptedDraftById.get(id) }
        : {}),
      ...(view.movementById.has(id) ? { movement: view.movementById.get(id) } : {}),
    });
  }
  return out;
}

export interface RecurringRowOpState {
  op: ManagementOpKind;
  /** Present only when `op === 'update'` — which of the two update actions
   *  produced/marks this row (a full schedule edit vs the 정지/재개 toggle). */
  updateKind?: 'full' | 'active';
  failed: boolean;
  reason?: WriteConflictReason;
  queueId?: string;
  synthetic: boolean;
  /** For a TERMINAL-failed FULL UPDATE, the full draft the user tried;
   *  conflict metadata ONLY (STEP 16-H2-F1 §21). */
  attemptedDraft?: NewRecurringDraft;
  /** For a TERMINAL-failed ACTIVE toggle (row-present conflict OR the
   *  row-absent orphan case — see `RecurringManagementView.attemptedActiveById`),
   *  the desired `active` value the user tried; conflict metadata ONLY
   *  (STEP 16-H2-F1 §22/§24) — the row (when it exists) always shows the
   *  authoritative `active`, never this. */
  attemptedActive?: boolean;
}

/**
 * STEP 16-H2-F1 — the screen-facing per-row op-state map for a
 * recurring-management surface. Recurring has NO composite-delete
 * counterpart, so this is a single-queue shape like
 * `buildPendingPlannedOps`, plus `updateKind` / `attemptedActive` to
 * distinguish a full edit from an active toggle. An ORPHAN failed ACTIVE
 * toggle (server row gone) has NO entry in `view.opById` (see
 * `composeRecurringManagement` — nothing can be honestly rendered from an
 * `{ active }`-only payload with no row behind it), so it has no entry here
 * either; it stays traceable via the raw `PendingWrite` queue and
 * `discardPending`.
 */
export function buildPendingRecurringOps(
  view: RecurringManagementView,
  /** current-scope `entity:'recurring'` ops (create/update/delete, incl. failed). */
  ops: readonly PendingWrite[],
  /** recurring-id -> reason, for a terminal-failed recurring op. */
  failedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
): Map<string, RecurringRowOpState> {
  const out = new Map<string, RecurringRowOpState>();
  for (const [id, op] of view.opById) {
    const failed = view.failedIds.has(id);
    const queueId = queueIdOf(ops, id);
    const rec = ops.find((o) => o.entity === 'recurring' && o.entityId === id);
    const updateKind = op === 'update' && rec?.entity === 'recurring' && rec.op === 'update' ? rec.updateKind : undefined;
    out.set(id, {
      op,
      ...(updateKind ? { updateKind } : {}),
      failed,
      synthetic: view.syntheticIds.has(id),
      ...(queueId !== undefined ? { queueId } : {}),
      ...(failed ? { reason: failedReasons.get(id) } : {}),
      ...(failed && view.attemptedDraftById.has(id)
        ? { attemptedDraft: view.attemptedDraftById.get(id) }
        : {}),
      ...(failed && view.attemptedActiveById.has(id)
        ? { attemptedActive: view.attemptedActiveById.get(id) }
        : {}),
    });
  }
  return out;
}

export function buildPendingBudgetOps(
  view: BudgetManagementView,
  /** current-scope `entity:'budget'` ops (create/update/delete, incl. failed). */
  singleTableOps: readonly PendingWrite[],
  /** current-scope `entity:'categoryBudget'` ops (delete only, incl. failed). */
  compositeOps: readonly PendingWrite[],
  singleTableFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
  compositeFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>,
): Map<string, BudgetRowOpState> {
  const out = new Map<string, BudgetRowOpState>();
  for (const [id, op] of view.opById) {
    const failed = view.failedIds.has(id);
    const stQueueId = queueIdOf(singleTableOps, id);
    const fromSingleTable = stQueueId !== undefined;
    const queueId = fromSingleTable ? stQueueId : queueIdOf(compositeOps, id);
    const reason = fromSingleTable
      ? singleTableFailedReasons.get(id)
      : compositeFailedReasons.get(id);
    out.set(id, {
      op,
      failed,
      synthetic: view.syntheticIds.has(id),
      ...(queueId !== undefined ? { queueId } : {}),
      ...(failed ? { reason } : {}),
      ...(failed && view.attemptedAmountById.has(id)
        ? { attemptedAmount: view.attemptedAmountById.get(id) }
        : {}),
    });
  }
  return out;
}
