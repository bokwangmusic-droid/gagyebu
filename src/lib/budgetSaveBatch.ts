/**
 * Budget multi-category batch-save algorithm — STEP 16-H2-C2-BUDGET A2 §4.
 *
 * Pure orchestration extracted out of app/budget-add.tsx so the
 * direct-write-first / transport-only-queue / stop-on-first-non-transport-
 * failure policy can be unit-tested without React. NO Supabase, NO
 * AsyncStorage, NO React — `saveBudget` / `enqueueBudgetCreate` /
 * `enqueueBudgetUpdate` are injected by the caller (the real services in the
 * app, fakes in tests).
 *
 * The PLAN (`BudgetSavePlanItem[]`) itself is built by the caller from a
 * MOUNT-time-frozen snapshot (STEP 16-H2-C2-BUDGET A2 §5/§6) — this module
 * never reads live budget/meta state, so a background refresh firing mid-
 * batch can't reclassify an item or swap its `expectedUpdatedAt` token.
 *
 * Algorithm per item, in plan order (§4):
 *   A. a category that already has an unresolved offline op -> stop (never
 *      stack a second write on an in-flight one, §18).
 *   B. direct `saveBudget()` (CREATE: `expectedUpdatedAt:null`; UPDATE: the
 *      plan's frozen token) — DIRECT WRITE FIRST, always.
 *   C. success -> `done += 1`, continue.
 *   D. `transport === true` -> `enqueueBudgetCreate`/`enqueueBudgetUpdate`
 *      with the SAME frozen plan values. Enqueue success -> `queued += 1`,
 *      continue with the remaining items. Enqueue failure -> stop; NEVER
 *      claim success for this item.
 *   E. any other failure (conflict / exists / deleted / gone / invalid /
 *      identity) -> NEVER queued; stop immediately.
 *
 * A transport failure on ONE item does not automatically queue the rest —
 * every remaining item still gets its own direct-write-first attempt.
 */

export type BudgetSaveOp = 'create' | 'update';

export interface BudgetSavePlanItem {
  categoryId: string;
  amount: number;
  op: BudgetSaveOp;
  /** `null` for CREATE. FROZEN for UPDATE — never a value re-read mid-batch. */
  expectedUpdatedAt: string | null;
}

/** The minimal shape this module needs from `saveBudget`'s result. */
export type BudgetItemWriteResult =
  | { ok: true }
  | { ok: false; message: string; transport?: boolean; reason?: string };

/** The minimal shape this module needs from the coordinator's enqueue result. */
export type BudgetItemEnqueueResult =
  | { ok: true }
  | { ok: false; reason: 'not-hydrated' | 'persist' | 'cap' | 'existing-pending' };

export interface RunBudgetSaveBatchDeps {
  /** Category ids that already carry an unresolved offline op (§18) — a
   *  plan item targeting one of these is refused, never double-queued. */
  pendingBudgetIds: ReadonlySet<string>;
  saveBudget(item: BudgetSavePlanItem): Promise<BudgetItemWriteResult>;
  enqueueBudgetCreate(item: BudgetSavePlanItem): Promise<BudgetItemEnqueueResult>;
  enqueueBudgetUpdate(item: BudgetSavePlanItem): Promise<BudgetItemEnqueueResult>;
}

export interface RunBudgetSaveBatchCapabilities {
  budgetCreate: boolean;
  budgetEdit: boolean;
}

export interface BudgetSaveBatchFailure {
  message: string;
  /** True for a server verdict that means "someone else already changed or
   *  removed it" (conflict / exists / deleted / gone) — phrased differently
   *  from a plain error by the caller. */
  changedElsewhere: boolean;
}

export interface BudgetSaveBatchResult {
  /** Direct-write successes. */
  done: number;
  /** Durably enqueued transport fallbacks. */
  queued: number;
  /** Items an actual write (or enqueue) was attempted for — excludes items
   *  stopped before ever reaching `saveBudget` (capability off, pending-op
   *  guard, missing token). */
  attempted: number;
  /** Non-null iff the batch stopped before processing every plan item. */
  failure: BudgetSaveBatchFailure | null;
}

const NON_TRANSPORT_CHANGED_ELSEWHERE = new Set(['conflict', 'exists', 'deleted', 'gone']);

export async function runBudgetSaveBatch(
  plan: readonly BudgetSavePlanItem[],
  capabilities: RunBudgetSaveBatchCapabilities,
  deps: RunBudgetSaveBatchDeps,
): Promise<BudgetSaveBatchResult> {
  let done = 0;
  let queued = 0;
  let attempted = 0;
  let failure: BudgetSaveBatchFailure | null = null;

  for (const item of plan) {
    // §18 — never stack a second write on a category with an unresolved op.
    if (deps.pendingBudgetIds.has(item.categoryId)) {
      failure = {
        message: '이미 처리 중인 예산 변경이 있어요. 완료되거나 예산 탭에서 버린 뒤 다시 시도해주세요.',
        changedElsewhere: false,
      };
      break;
    }

    // Defensive: an UPDATE plan item must carry its frozen token. Should
    // never happen (the caller's plan-builder only emits `null` for CREATE).
    if (item.op === 'update' && item.expectedUpdatedAt == null) {
      failure = { message: '예산 정보를 다시 불러와 주세요.', changedElsewhere: false };
      break;
    }

    const needed = item.op === 'update' ? capabilities.budgetEdit : capabilities.budgetCreate;
    if (!needed) {
      failure = { message: '지금은 예산을 저장할 수 없어요.', changedElsewhere: false };
      break;
    }

    attempted += 1;
    const res = await deps.saveBudget(item);

    if (res.ok) {
      done += 1;
      continue;
    }

    if (res.transport === true) {
      const enq =
        item.op === 'update' ? await deps.enqueueBudgetUpdate(item) : await deps.enqueueBudgetCreate(item);
      if (enq.ok) {
        queued += 1;
        continue; // durable success — keep going with the remaining plan items
      }
      const enqMessage =
        enq.reason === 'not-hydrated'
          ? '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.'
          : enq.reason === 'cap'
            ? '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.'
            : enq.reason === 'existing-pending'
              ? '이미 전송 대기 중인 변경이 있어요.'
              : '예산을 기기에 저장하지 못했어요. 다시 시도해주세요.';
      failure = { message: enqMessage, changedElsewhere: false };
      break;
    }

    // Non-transport terminal failure — never queued; stop at the first one.
    failure = {
      message: res.message,
      changedElsewhere: !!res.reason && NON_TRANSPORT_CHANGED_ELSEWHERE.has(res.reason),
    };
    break;
  }

  return { done, queued, attempted, failure };
}
