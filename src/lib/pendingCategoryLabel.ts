/**
 * Row subtitle for a custom category that carries an offline-queue overlay on
 * the CATEGORY-management screen — STEP 16-H2-C2-B2 §11. PURE, no React.
 *
 * The finance read model (`useFinanceRead().pendingCategoryOps`) maps a
 * visible category id to `{ op, failed, reason? }`. This turns that into the
 * one short Korean line shown under the category's "사용자 추가" line. A
 * not-failed pending DELETE has no visible row (`composeCategoryManagement`
 * hides it) and this STEP wires no offline category DELETE at all, so
 * `op:'delete'` is here only for helper completeness.
 *
 * `reason` is the ORIGINAL write-service verdict for a terminal failure
 * (src/services/remoteCategoryWrite.ts). A failed UPDATE is phrased per
 * reason:
 *   - `deleted` -> "다른 기기에서 삭제된 카테고리예요"
 *   - `gone`    -> "카테고리를 찾을 수 없어요"
 *   - `conflict`-> "다른 기기 변경 확인 필요"
 *   - anything else -> the plain "아래로 당겨 다시 시도" (pull-to-refresh
 *     retries the SAME frozen op — §22/§25).
 * Raw server / Postgres text is never shown (§11). Mirrors
 * src/lib/pendingCardLabel.ts / pendingTransactionLabel.ts.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingCategoryRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
}

/** True when a retry cannot fix it and the user must check another device. */
export function isCategoryCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * A pending or failed category row is ALWAYS read-only on the management
 * screen (STEP 16-H2-C2-B2 §12): no edit sheet, no delete, and excluded from
 * drag-reorder so a pending id can never reach `saveCategoryOrder`.
 */
export function isPendingCategoryRowReadOnly(_state: PendingCategoryRowState): boolean {
  return true;
}

export function pendingCategoryRowLabel(state: PendingCategoryRowState): string {
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
      if (state.reason === 'deleted') return '수정 전송 실패 · 다른 기기에서 삭제된 카테고리예요';
      if (state.reason === 'gone') return '수정 전송 실패 · 카테고리를 찾을 수 없어요';
      if (state.reason === 'conflict') return '수정 전송 실패 · 다른 기기 변경 확인 필요';
      return '수정 전송 실패 · 아래로 당겨 다시 시도';
    case 'delete':
      return isCategoryCrossDeviceConflict(state.reason)
        ? '삭제 전송 실패 · 다른 기기 변경 확인 필요'
        : '삭제 전송 실패 · 아래로 당겨 다시 시도';
  }
}
