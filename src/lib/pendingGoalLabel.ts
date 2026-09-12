/**
 * Row subtitle for a savings goal that carries an offline-queue overlay on
 * the goal-management screen — STEP 16-H2-G3, reason wording refined in
 * STEP 16-H2-G6. PURE, no React.
 *
 * The finance read model (`useFinanceRead().pendingGoalOps`) maps a visible
 * goal id to `{ op, failed, reason?, movement? }`. This turns that into the
 * one short Korean line shown under the goal's name. Mirrors
 * src/lib/pendingCardLabel.ts so every management-screen row label stays
 * structurally identical.
 *
 * STEP 16-H2-G6: a TERMINAL failure's ORIGINAL `reason` is rendered through
 * `terminalReasonClause` — a retry can NEVER fix `conflict` / `gone` /
 * `deleted` / `insufficient`, so none of them may say anything that reads as
 * "다시 시도해 보세요". The generic "아래로 당겨 다시 시도" clause is reserved
 * for `undefined` (a genuinely unclassified/unknown terminal failure, or the
 * structurally-unreachable-once-queued `invalid`, which `runOp.ts` still
 * flattens away — see its own comment) and for `identity`/`error`, neither
 * of which this STEP was asked to give a dedicated phrase.
 */
import type { GoalMovementMode } from '@/lib/remoteGoalWriteMapping';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingGoalRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
  /**
   * Present when this marker is backed by a deposit/withdraw movement
   * rather than a full goal edit — DELIBERATELY read regardless of
   * `failed` (a still-pending movement needs its mode too, to say "저축
   * 전송 대기" / "인출 전송 대기" instead of a generic "수정 전송 대기").
   * Only `.mode` is used here; the caller's richer `{mode, amount}` shape is
   * structurally compatible and passed through as-is.
   */
  movement?: { mode: GoalMovementMode };
}

/** True when a retry cannot fix it and the user must check another device
 *  (or accept the goal is simply gone). Kept for callers that only need the
 *  yes/no split; `terminalReasonClause` below is what actually renders text. */
export function isGoalCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * STEP 16-H2-G6 — the short Korean clause for a TERMINAL failure's ORIGINAL
 * `reason`, shared by every op (create/update/delete/movement) so the same
 * reason always reads the same way regardless of which action produced it.
 * `gone` and `deleted` are DELIBERATELY unified (a goal offline-queue write
 * can encounter either depending on which service call raced it — the user
 * never needs to tell them apart). `insufficient` is goal-MOVEMENT-only
 * (an over-withdraw discovered on replay) but is handled generically here in
 * case it were ever reused. Anything else — `identity` / `error` /
 * `undefined` (incl. the structurally-unreachable-once-queued `invalid`,
 * flattened away in runOp.ts) — keeps the existing retry-suggesting clause;
 * retry policy itself is UNCHANGED (STEP 16-H2-G6 §3), this only decides
 * what TEXT is shown for a reason that already will not auto-retry into
 * success.
 */
function terminalReasonClause(reason: WriteConflictReason | undefined): string {
  switch (reason) {
    case 'conflict':
      return '다른 기기에서 변경된 내용이 있어요';
    case 'gone':
    case 'deleted':
      return '이미 삭제된 목표예요';
    case 'insufficient':
      return '인출 가능한 금액이 부족해요';
    default:
      return '아래로 당겨 다시 시도';
  }
}

/**
 * A pending or failed goal row is ALWAYS read-only on the goal list (mirrors
 * the card-management rule): no edit route, no delete/movement re-entry.
 * Trivial predicate — its presence documents the invariant and gives the
 * screen one named call site.
 */
export function isPendingGoalRowReadOnly(_state: PendingGoalRowState): boolean {
  return true;
}

export function pendingGoalRowLabel(state: PendingGoalRowState): string {
  const movementKind = state.movement ? (state.movement.mode === 'deposit' ? '저축' : '인출') : null;

  if (!state.failed) {
    if (movementKind) return `${movementKind} 전송 대기 · 인터넷 연결 후 자동 반영`;
    switch (state.op) {
      case 'create':
        return '전송 대기 · 인터넷에 연결되면 자동으로 반영할게요';
      case 'update':
        return '수정 전송 대기';
      case 'delete':
        return '삭제 전송 대기';
    }
  }

  const clause = terminalReasonClause(state.reason);
  if (movementKind) return `${movementKind} 전송 실패 · ${clause}`;
  switch (state.op) {
    case 'create':
      return `전송 실패 · ${clause}`;
    case 'update':
      return `수정 전송 실패 · ${clause}`;
    case 'delete':
      return `삭제 전송 실패 · ${clause}`;
  }
}
