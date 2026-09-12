/**
 * Row subtitle for a savings goal that carries an offline-queue overlay on
 * the goal-management screen — STEP 16-H2-G3. PURE, no React.
 *
 * The finance read model (`useFinanceRead().pendingGoalOps`) maps a visible
 * goal id to `{ op, failed, reason?, movement? }`. This turns that into the
 * one short Korean line shown under the goal's name. Mirrors
 * src/lib/pendingCardLabel.ts so every management-screen row label stays
 * structurally identical. `op:'create'` (goal creation) and `op:'update'`
 * backed by a deposit/withdraw `movement` are reachable in practice (delete
 * is not offline-connected from any screen yet); the function stays
 * complete over the whole `PendingWrite` op space so it never needs
 * revisiting when delete is wired later.
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

/** True when a retry cannot fix it and the user must check another device. */
export function isGoalCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
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

  if (movementKind) {
    if (state.reason === 'deleted') return `${movementKind} 전송 실패 · 다른 기기에서 삭제된 목표예요`;
    if (state.reason === 'gone') return `${movementKind} 전송 실패 · 목표를 찾을 수 없어요`;
    if (state.reason === 'conflict') return `${movementKind} 전송 실패 · 다른 기기 변경 확인 필요`;
    // Also covers a discovered-on-replay `insufficient` (over-withdraw) —
    // flattened to a reason-less terminal by runOp.ts, same as `invalid`.
    return `${movementKind} 전송 실패 · 아래로 당겨 다시 시도`;
  }

  switch (state.op) {
    case 'create':
      return '전송 실패 · 아래로 당겨 다시 시도';
    case 'update':
      if (state.reason === 'deleted') return '수정 전송 실패 · 다른 기기에서 삭제된 목표예요';
      if (state.reason === 'gone') return '수정 전송 실패 · 목표를 찾을 수 없어요';
      if (state.reason === 'conflict') return '수정 전송 실패 · 다른 기기 변경 확인 필요';
      return '수정 전송 실패 · 아래로 당겨 다시 시도';
    case 'delete':
      return isGoalCrossDeviceConflict(state.reason)
        ? '삭제 전송 실패 · 다른 기기 변경 확인 필요'
        : '삭제 전송 실패 · 아래로 당겨 다시 시도';
  }
}
