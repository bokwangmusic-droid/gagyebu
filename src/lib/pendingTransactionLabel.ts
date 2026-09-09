/**
 * Row subtitle for a transaction that carries an offline-queue overlay —
 * STEP 16-H2-B2 §6/§11/§12/§20/§21. PURE, no React.
 *
 * The finance read model (`useFinanceRead().pendingTransactionOps`) maps a
 * visible transaction id to `{ op, failed, reason? }`. This turns that into
 * the one short Korean line shown under the row. A not-failed pending DELETE
 * has no visible row at all (composeFinance hides it), so `op:'delete'` with
 * `failed:false` should not normally reach here — a sensible label is still
 * returned for completeness.
 *
 * `reason` is the ORIGINAL write-service verdict for a terminal failure.
 * A failed UPDATE is phrased per reason (STEP 16-H2-B2.1 §5):
 *   - `deleted` -> "다른 기기에서 삭제된 거래예요"
 *   - `gone`    -> "거래를 찾을 수 없어요"
 *   - `conflict`-> "다른 기기 변경 확인 필요"
 *   - anything else -> the plain "아래로 당겨 다시 시도" (pull-to-refresh
 *     retries the SAME frozen op, §11/§6).
 * A failed DELETE keeps the conflict-family "다른 기기 변경 확인 필요"
 * wording (`deleted` / `gone` are idempotent successes for a delete, so
 * they never reach here). Raw server / Postgres text is never shown.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingTransactionRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
}

/** True when a retry cannot fix it and the user must check another device. */
export function isCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

export function pendingTransactionRowLabel(state: PendingTransactionRowState): string {
  if (!state.failed) {
    switch (state.op) {
      case 'create':
        return '전송 대기';
      case 'update':
        return '수정 전송 대기';
      case 'delete':
        return '삭제 전송 대기';
    }
  }

  switch (state.op) {
    case 'create':
      return '전송 실패 · 아래로 당겨 다시 시도';
    case 'update':
      if (state.reason === 'deleted') return '수정 전송 실패 · 다른 기기에서 삭제된 거래예요';
      if (state.reason === 'gone') return '수정 전송 실패 · 거래를 찾을 수 없어요';
      if (state.reason === 'conflict') return '수정 전송 실패 · 다른 기기 변경 확인 필요';
      return '수정 전송 실패 · 아래로 당겨 다시 시도';
    case 'delete':
      return isCrossDeviceConflict(state.reason)
        ? '삭제 전송 실패 · 다른 기기 변경 확인 필요'
        : '삭제 전송 실패 · 아래로 당겨 다시 시도';
  }
}
