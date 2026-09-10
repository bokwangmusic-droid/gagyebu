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
  PendingWrite,
} from '@/lib/offlineQueue';
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
