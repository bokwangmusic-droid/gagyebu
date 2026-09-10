/**
 * STEP 16-H2 A3 / A4.4 — pure decision helpers for the /categories ATOMIC
 * category + budget delete: the pre-Alert gate, the failure-reason -> toast
 * map, and (A4.4) the "does this failure get a durable offline fallback?"
 * predicate.
 *
 * app/categories.tsx stays a thin caller: it owns the refs, the confirm
 * Alert, `refresh()`, the haptic, the toast side effects, and the actual
 * `pendingWrites.enqueueCategoryBudgetDelete(...)` call. This module owns the
 * branching so every gate / message / enqueue-decision can be exhaustively
 * cased without a React renderer (see categoryDeleteFlow.cases.ts).
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
  /** success (both category and, if present, budget tombstoned on the server). */
  success: '카테고리를 삭제했어요',
  /** A4.4 — a transport failure that WAS durably enqueued. Distinct from
   *  `success`: the server delete has NOT happened yet, only the intent is
   *  saved. The A4.3 read-model projection hides the row meanwhile. */
  offlineQueued: '카테고리를 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요',
  /** Defensive fallback only — A4.4 intercepts a transport failure BEFORE
   *  this map via `shouldEnqueueCompositeDelete` and routes it to the durable
   *  queue. Shown only if an enqueue is somehow not attempted. */
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
 * STEP 16-H2 A4.4 — the ONE failure that earns a durable offline fallback: a
 * TRANSPORT failure (the request never reached a server verdict). Everything
 * else — `conflict` / `gone` / `identity` / a generic non-transport `error` —
 * is terminal in the UI: no enqueue, no auto-retry, no token re-fetch. The
 * caller enqueues the composite delete with the SAME two frozen tokens only
 * when this returns true.
 */
export function shouldEnqueueCompositeDelete(f: CategoryDeleteFailure): boolean {
  return f.transport === true;
}

/**
 * Failure result -> the single toast to show, for a failure the caller did
 * NOT enqueue (i.e. `shouldEnqueueCompositeDelete` was false). §5/§6: the
 * atomic RPC mutated NEITHER table on failure, so there is no partial-success
 * line to render; one message per reason. `identity` and a generic `error`
 * fall through to the service's own copy verbatim. The `transport` branch is
 * a defensive fallback — A4.4 routes a transport failure to the durable
 * queue before this is reached.
 */
export function categoryDeleteFailureToast(f: CategoryDeleteFailure): string {
  if (f.transport === true) return CATEGORY_DELETE_MSG.transport;
  if (f.reason === 'conflict') return CATEGORY_DELETE_MSG.conflict;
  if (f.reason === 'gone') return CATEGORY_DELETE_MSG.gone;
  return f.message;
}
