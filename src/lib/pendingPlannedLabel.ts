/**
 * Row subtitle for a planned expense that carries an offline-queue overlay on
 * the Planned tab — STEP 16-H2-E2 §16. PURE, no React. Mirrors
 * src/lib/pendingBudgetLabel.ts / pendingCategoryLabel.ts.
 *
 * The finance read model (`useFinanceRead().pendingPlannedOps`) maps a
 * visible planned id to `{ op, failed, reason?, synthetic, queueId?,
 * attemptedDraft? }`. This turns the `{ op, failed, reason? }` part into the
 * short Korean status line(s) shown under the planned row's name.
 *
 * Two-line `{ primary, detail }` — the same lesson as the Budget conflict
 * label: the row's text column is narrow (icon on the left, amount / discard
 * controls on the right), so a single combined string truncates to an
 * unreadable fragment. The caller renders `primary` and `detail` as separate
 * `<Text>` lines with no `numberOfLines`, so the full meaning always reads.
 *   - `primary` — the short status word, always fits one line on its own.
 *   - `detail`  — `null` for a not-failed pending op; for ANY failed op a
 *     short reason line (or "아래로 당겨 다시 시도" when there is no specific
 *     server verdict).
 *
 * `reason` is the ORIGINAL write-service verdict, already normalized by
 * `runOp.ts` down to the shared `WriteConflictReason` (`invalid` arrives as
 * `undefined`). Raw server / Postgres text is never shown.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingPlannedRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
}

/** Two short lines, never a single long truncation-prone string. */
export interface PendingPlannedRowLabel {
  /** Always fits one line on its own: "전송 대기" / "수정 전송 실패" / … */
  primary: string;
  /** `null` only for a not-failed pending op; always present when `failed`. */
  detail: string | null;
}

/** True when a retry cannot fix it and the user must check another device. */
export function isPlannedCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * A pending or failed planned row is ALWAYS read-only on the Planned tab
 * (STEP 16-H2-E2 §13): no tap-to-edit, no delete, no second queued write on
 * the same row, until a terminal failure is resolved by a successful retry
 * or dropped via "변경 버리기".
 */
export function isPendingPlannedRowReadOnly(_state: PendingPlannedRowState): boolean {
  return true;
}

export function pendingPlannedRowLabel(state: PendingPlannedRowState): PendingPlannedRowLabel {
  if (!state.failed) {
    switch (state.op) {
      case 'create':
        return { primary: '전송 대기', detail: null };
      case 'update':
        return { primary: '수정 전송 대기', detail: null };
      case 'delete':
        return { primary: '삭제 전송 대기', detail: null };
    }
  }

  switch (state.op) {
    case 'create':
      // planned_expenses has a client-generated id + unique(household_id, id),
      // so a failed CREATE is a lost-response race: same id, different server
      // payload -> `conflict`.
      if (state.reason === 'conflict') return { primary: '전송 실패', detail: '다른 기기에서 변경됐어요' };
      if (state.reason === 'gone' || state.reason === 'deleted') {
        return { primary: '전송 실패', detail: '다른 기기에서 삭제됐어요' };
      }
      return { primary: '전송 실패', detail: '아래로 당겨 다시 시도' };
    case 'update':
      if (state.reason === 'deleted' || state.reason === 'gone') {
        return { primary: '수정 전송 실패', detail: '다른 기기에서 삭제됐어요' };
      }
      if (state.reason === 'conflict') return { primary: '수정 전송 실패', detail: '다른 기기에서 변경됐어요' };
      return { primary: '수정 전송 실패', detail: '아래로 당겨 다시 시도' };
    case 'delete':
      return {
        primary: '삭제 전송 실패',
        detail: isPlannedCrossDeviceConflict(state.reason)
          ? '다른 기기에서 변경됐어요'
          : '아래로 당겨 다시 시도',
      };
  }
}
