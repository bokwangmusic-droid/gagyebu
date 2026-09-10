/**
 * STEP 16-H2 A3 — pure decision helpers for the /categories ATOMIC
 * category + budget delete (ONLINE direct-write flow).
 *
 * app/categories.tsx stays a thin caller: it owns the refs, the confirm
 * Alert, `refresh()`, the haptic and the toast side effects. This module
 * owns the branching so every gate / message can be exhaustively cased
 * without a React renderer (see categoryDeleteFlow.cases.ts).
 *
 * NOTHING here touches Supabase, the offline queue, CategoryOrder, or any
 * migration — it is a synchronous function of already-resolved primitives.
 */
import type { DeleteCategoryWithBudgetReason } from '@/services/remoteCategoryBudgetWrite';

/* toasts — exported so the case suite asserts against the same constants. */
export const CATEGORY_DELETE_MSG = {
  /** §9 — an un-sent offline BUDGET op for this category would race the RPC. */
  budgetOpInFlight: '먼저 처리 중인 예산 변경을 완료하거나 정리해주세요.',
  /** frozen category token missing -> no safe optimistic-concurrency guard. */
  needCategoryReload: '카테고리 정보를 다시 불러온 뒤 삭제해 주세요.',
  /** a live budget with no meta -> a guarded budget delete is impossible. */
  needBudgetReload: '예산 정보를 다시 불러온 뒤 삭제해 주세요.',
  /** success (both category and, if present, budget tombstoned). */
  success: '카테고리를 삭제했어요',
  /** §6 — transport failure. A3 does NOT enqueue DELETE: plain "try again". */
  transport: '인터넷 연결을 확인하고 다시 시도해주세요.',
  /** §6 — optimistic-concurrency conflict on the category OR the budget. */
  conflict: '다른 기기에서 카테고리 또는 예산이 변경됐어요. 새로고침 후 다시 시도해주세요.',
  /** §6 — the category row is already gone. */
  gone: '카테고리를 찾을 수 없어요. 새로고침 후 다시 확인해주세요.',
} as const;

export interface CategoryDeleteGateInput {
  /** REMOTE_FINANCE_WRITE.categoryDelete */
  canDelete: boolean;
  /** a composite delete is already running (deletingRef). */
  deleting: boolean;
  /** the CATEGORY row carries its own un-sent offline op (isPendingRow). */
  categoryRowPending: boolean;
  /** §9 — an un-sent offline BUDGET op exists for this same category id
   *  (pendingBudgetOps.has(id)); create / update / delete, pending OR failed. */
  budgetOpPending: boolean;
  /** categoryMeta[id]?.updatedAt ?? null — frozen BEFORE the confirm Alert. */
  categoryToken: string | null;
  /** the authoritative snapshot has a live budget row for this category. */
  hasLiveBudget: boolean;
  /** budgetMeta[id]?.updatedAt ?? null — frozen at the SAME moment as
   *  `categoryToken`. Ignored (forced to null) when `hasLiveBudget` is false,
   *  so a "no live budget" intent always goes to the RPC as `null` (§10). */
  budgetToken: string | null;
}

export type CategoryDeleteGate =
  | { proceed: true; categoryToken: string; budgetToken: string | null }
  | { proceed: false; toast: string | null };

/**
 * The pre-Alert gate. Order matters:
 *   1. silent no-ops (capability off / already deleting / read-only row) —
 *      `toast: null`, never a message.
 *   2. §9 budget-op-in-flight — the one guard A3 adds.
 *   3. §11 frozen-token completeness — a missing token means we cannot form a
 *      safe guard, so we do not start (and never re-read a fresher token).
 * Only when every gate passes do we return the frozen `(categoryToken,
 * budgetToken)` pair for the caller to hand verbatim to the Alert's onPress.
 */
export function gateCategoryDelete(i: CategoryDeleteGateInput): CategoryDeleteGate {
  if (!i.canDelete || i.deleting || i.categoryRowPending) return { proceed: false, toast: null };
  if (i.budgetOpPending) return { proceed: false, toast: CATEGORY_DELETE_MSG.budgetOpInFlight };
  if (!i.categoryToken) return { proceed: false, toast: CATEGORY_DELETE_MSG.needCategoryReload };
  if (i.hasLiveBudget && !i.budgetToken) {
    return { proceed: false, toast: CATEGORY_DELETE_MSG.needBudgetReload };
  }
  return {
    proceed: true,
    categoryToken: i.categoryToken,
    budgetToken: i.hasLiveBudget ? i.budgetToken : null,
  };
}

export interface CategoryDeleteFailure {
  reason: DeleteCategoryWithBudgetReason;
  message: string;
  transport?: boolean;
}

/**
 * Failure result -> the single toast to show. §5/§6: the atomic RPC mutated
 * NEITHER table on failure, so there is no partial-success line to render;
 * one message per reason. A transport failure is checked first and is never
 * an offline-success (A3 does not enqueue DELETE). `identity` and a generic
 * `error` fall through to the service's own copy verbatim.
 */
export function categoryDeleteFailureToast(f: CategoryDeleteFailure): string {
  if (f.transport === true) return CATEGORY_DELETE_MSG.transport;
  if (f.reason === 'conflict') return CATEGORY_DELETE_MSG.conflict;
  if (f.reason === 'gone') return CATEGORY_DELETE_MSG.gone;
  return f.message;
}
