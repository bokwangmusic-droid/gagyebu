/**
 * Row subtitle for a loan that carries an offline-queue overlay on the
 * loan-management screen — STEP 16-H2-L2. PURE, no React.
 *
 * The finance read model (`useFinanceRead().pendingLoanOps`) maps a visible
 * loan id to `{ op, failed, reason?, payment? }`. This turns that into the
 * one short Korean line shown under the loan's name. Mirrors
 * src/lib/pendingGoalLabel.ts so every management-screen row label stays
 * structurally identical — `payment` plays the SAME role here as
 * `PendingGoalRowState.movement` does for a deposit/withdraw: a loan's
 * marker can be backed by EITHER a plain loan create/update/delete OR a
 * repayment create/delete, and both share the generic `op:'update'` bucket
 * when it's a payment (see `composeLoanManagement`).
 *
 * A TERMINAL reason's ORIGINAL `reason` is rendered through
 * `terminalReasonClause` — a retry can NEVER fix `conflict` / `gone` /
 * `deleted` / `principal_low` / `paid_off` / `stale`, so none of them may
 * say anything that reads as "다시 시도해 보세요". `gone`/`deleted` are
 * DELIBERATELY unified, and their wording depends on WHICH entity actually
 * went missing: a plain loan op or a payment CREATE means the LOAN is gone
 * (`addLoanPayment`'s `!loan` / `deleted_at` check); a payment DELETE means
 * the PAYMENT ROW itself is gone (`softDeleteLoanPayment`'s reconcile) — see
 * `src/services/remoteLoanWrite.ts`. `principal_low` is loan-UPDATE-only;
 * `paid_off`/`stale` are payment-CREATE-only — reused generically here in
 * case they were ever reused elsewhere. The generic "아래로 당겨 다시 시도"
 * clause (the app's existing general-failure wording, same as
 * `pendingGoalLabel.ts`'s default) is reserved for `undefined` (a genuinely
 * unclassified/unknown terminal failure, or the structurally-unreachable-
 * once-queued `invalid`, which `runOp.ts` still flattens away) and for
 * `identity`/`error`.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingLoanRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
  /**
   * Present when this marker is backed by a repayment create/delete rather
   * than a full loan edit — DELIBERATELY read regardless of `failed` (a
   * still-pending payment needs its kind too, to say "상환 전송 대기" /
   * "상환 취소 전송 대기" instead of a generic "수정 전송 대기").
   */
  payment?: { kind: 'create' | 'delete' };
}

/** True when a retry cannot fix it and the user must check another device
 *  (or accept the loan/payment is simply gone). Kept for callers that only
 *  need the yes/no split; `terminalReasonClause` below is what actually
 *  renders text. */
export function isLoanCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * STEP 16-H2-L2 — the short Korean clause for a TERMINAL failure's ORIGINAL
 * `reason`, shared by every op (create/update/delete/payment) so the same
 * reason always reads the same way, with ONE exception: `gone`/`deleted` for
 * a payment DELETE names the PAYMENT (the row that turned out missing),
 * never the loan — see this module's own doc for why.
 */
function terminalReasonClause(
  reason: WriteConflictReason | undefined,
  paymentKind: 'create' | 'delete' | undefined,
): string {
  switch (reason) {
    case 'conflict':
      return '다른 기기에서 변경된 내용이 있어요';
    case 'gone':
    case 'deleted':
      return paymentKind === 'delete' ? '이미 삭제된 상환 내역이에요' : '이미 삭제된 대출이에요';
    case 'principal_low':
      return '현재 상환액보다 원금이 작을 수 없어요';
    case 'paid_off':
      return '이미 상환이 완료된 대출이에요';
    case 'stale':
      return '최신 대출 상태를 다시 확인해주세요';
    default:
      return '아래로 당겨 다시 시도';
  }
}

/**
 * A pending or failed loan row is ALWAYS read-only on the loan list (mirrors
 * the goal-management rule): no edit route, no payment/delete re-entry.
 * Trivial predicate — its presence documents the invariant and gives the
 * screen one named call site.
 */
export function isPendingLoanRowReadOnly(_state: PendingLoanRowState): boolean {
  return true;
}

export function pendingLoanRowLabel(state: PendingLoanRowState): string {
  const paymentKind = state.payment?.kind;

  if (!state.failed) {
    if (paymentKind === 'create') return '상환 전송 대기 · 인터넷 연결 후 자동 반영';
    if (paymentKind === 'delete') return '상환 취소 전송 대기 · 인터넷 연결 후 자동 반영';
    switch (state.op) {
      case 'create':
        return '생성 전송 대기 · 인터넷 연결 후 자동 반영';
      case 'update':
        return '수정 전송 대기 · 인터넷 연결 후 자동 반영';
      case 'delete':
        return '삭제 전송 대기 · 인터넷 연결 후 자동 반영';
    }
  }

  const clause = terminalReasonClause(state.reason, paymentKind);
  if (paymentKind === 'create') return `상환 전송 실패 · ${clause}`;
  if (paymentKind === 'delete') return `상환 취소 전송 실패 · ${clause}`;
  switch (state.op) {
    case 'create':
      return `전송 실패 · ${clause}`;
    case 'update':
      return `수정 전송 실패 · ${clause}`;
    case 'delete':
      return `삭제 전송 실패 · ${clause}`;
  }
}
