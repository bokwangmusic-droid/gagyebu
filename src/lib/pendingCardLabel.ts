/**
 * Row subtitle for a card that carries an offline-queue overlay on the
 * CARD-MANAGEMENT screen — STEP 16-H2-C2-A2 §10/§19/§20. PURE, no React.
 *
 * The finance read model (`useFinanceRead().pendingCardOps`) maps a visible
 * card id to `{ op, failed, reason? }`. This turns that into the one short
 * Korean line shown under the card's 결제일 line. A not-failed pending DELETE
 * has no visible row at all (`composeCardManagement` hides it), so
 * `op:'delete'` with `failed:false` should not normally reach here — a
 * sensible label is still returned for completeness.
 *
 * `reason` is the ORIGINAL write-service verdict for a terminal failure
 * (src/services/remoteCardWrite.ts). A failed UPDATE is phrased per reason:
 *   - `deleted` -> "다른 기기에서 삭제된 카드예요"
 *   - `gone`    -> "카드를 찾을 수 없어요"
 *   - `conflict`-> "다른 기기 변경 확인 필요"
 *   - anything else -> the plain "아래로 당겨 다시 시도" (pull-to-refresh
 *     retries the SAME frozen op — STEP 16-H2-C2-A2 §15/§18).
 * A failed DELETE keeps the conflict-family "다른 기기 변경 확인 필요"
 * wording for `conflict` (a `deleted` / `gone` verdict is an idempotent
 * success for a delete, so it never reaches here). Raw server / Postgres
 * text is never shown (§10).
 *
 * Mirrors src/lib/pendingTransactionLabel.ts so the two row labels stay
 * structurally identical and equally easy to verify.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingCardRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
}

/** True when a retry cannot fix it and the user must check another device. */
export function isCardCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * A pending or failed card row is ALWAYS read-only on the management screen
 * (STEP 16-H2-C2-A2 §11): no edit route, no delete re-entry. Cross-op
 * compaction (CREATE→UPDATE, UPDATE→DELETE, …) is not supported yet, so the
 * row must not be re-opened while an op is in flight or held failed. This is
 * a trivial predicate today — its presence documents the invariant and gives
 * the screen one named call site.
 */
export function isPendingCardRowReadOnly(_state: PendingCardRowState): boolean {
  return true;
}

export function pendingCardRowLabel(state: PendingCardRowState): string {
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
      if (state.reason === 'deleted') return '수정 전송 실패 · 다른 기기에서 삭제된 카드예요';
      if (state.reason === 'gone') return '수정 전송 실패 · 카드를 찾을 수 없어요';
      if (state.reason === 'conflict') return '수정 전송 실패 · 다른 기기 변경 확인 필요';
      return '수정 전송 실패 · 아래로 당겨 다시 시도';
    case 'delete':
      return isCardCrossDeviceConflict(state.reason)
        ? '삭제 전송 실패 · 다른 기기 변경 확인 필요'
        : '삭제 전송 실패 · 아래로 당겨 다시 시도';
  }
}
