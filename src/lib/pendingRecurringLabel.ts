/**
 * Row subtitle for a recurring rule that carries an offline-queue overlay on
 * the Recurring screen — STEP 16-H2-F2 §18. PURE, no React. Mirrors
 * src/lib/pendingPlannedLabel.ts / pendingBudgetLabel.ts, extended with an
 * `updateKind` discriminant (`'full'` schedule edit vs the `'active'`
 * 정지/재개 toggle) since both share `op: 'update'`.
 *
 * The finance read model (`useFinanceRead().pendingRecurringOps`) maps a
 * visible recurring id to `{ op, updateKind?, failed, reason?, synthetic,
 * queueId?, attemptedDraft?, attemptedActive? }`. This turns the
 * `{ op, updateKind, failed, reason }` part into the short Korean status
 * line(s) shown under the row's name — this function is ALSO reused,
 * row-less, for the standalone orphan-ACTIVE failure notice (§13): it only
 * needs the op-state, never a `RecurringRule`.
 *
 * Two-line `{ primary, detail }` — the Budget/Planned conflict-label lesson:
 * a single combined string truncates in a narrow row. `detail` is `null`
 * only for a not-failed pending op.
 *
 * `reason` is the ORIGINAL write-service verdict, already normalized by
 * `runOp.ts` down to the shared `WriteConflictReason` (`invalid` arrives as
 * `undefined`). Raw server / Postgres text is never shown.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingRecurringRowState {
  op: 'create' | 'update' | 'delete';
  /** Required when `op === 'update'` — which action produced/marks the row. */
  updateKind?: 'full' | 'active';
  failed: boolean;
  reason?: WriteConflictReason;
}

/** Two short lines, never a single long truncation-prone string. */
export interface PendingRecurringRowLabel {
  /** Always fits one line on its own: "전송 대기" / "수정 전송 실패" / … */
  primary: string;
  /** `null` only for a not-failed pending op; always present when `failed`. */
  detail: string | null;
}

/** True when a retry cannot fix it and the user must check another device. */
export function isRecurringCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * A pending or failed recurring row (CREATE, FULL UPDATE, ACTIVE toggle, or
 * DELETE) is ALWAYS read-only on the Recurring screen (STEP 16-H2-F2 §17):
 * no tap-to-edit, no toggle, no delete, no second queued write, until a
 * terminal failure is resolved by a successful retry or dropped via
 * "변경 버리기".
 */
export function isPendingRecurringRowReadOnly(_state: PendingRecurringRowState): boolean {
  return true;
}

/** "시도한 상태: 활성" / "시도한 상태: 일시정지" — the ONLY attempted-active
 *  copy this module produces; never a raw boolean, never JSON. */
export function attemptedActiveLabel(active: boolean): string {
  return `시도한 상태: ${active ? '활성' : '일시정지'}`;
}

export function pendingRecurringRowLabel(state: PendingRecurringRowState): PendingRecurringRowLabel {
  if (!state.failed) {
    if (state.op === 'create') return { primary: '전송 대기', detail: null };
    if (state.op === 'delete') return { primary: '삭제 전송 대기', detail: null };
    // update
    return state.updateKind === 'active'
      ? { primary: '상태 변경 전송 대기', detail: null }
      : { primary: '수정 전송 대기', detail: null };
  }

  if (state.op === 'create') {
    // recurring_rules has a client-generated id + unique(household_id, id),
    // so a failed CREATE is a lost-response race: same id, different server
    // payload -> `conflict`.
    if (state.reason === 'conflict') return { primary: '전송 실패', detail: '다른 기기에서 변경됐어요' };
    if (state.reason === 'gone' || state.reason === 'deleted') {
      return { primary: '전송 실패', detail: '다른 기기에서 삭제됐어요' };
    }
    return { primary: '전송 실패', detail: '아래로 당겨 다시 시도' };
  }

  if (state.op === 'delete') {
    return {
      primary: '삭제 전송 실패',
      detail: isRecurringCrossDeviceConflict(state.reason) ? '다른 기기에서 변경됐어요' : '아래로 당겨 다시 시도',
    };
  }

  // update — FULL vs ACTIVE get their own primary word, same reason table.
  const primary = state.updateKind === 'active' ? '상태 변경 실패' : '수정 전송 실패';
  if (state.reason === 'deleted' || state.reason === 'gone') {
    return { primary, detail: '다른 기기에서 삭제됐어요' };
  }
  if (state.reason === 'conflict') return { primary, detail: '다른 기기에서 변경됐어요' };
  return { primary, detail: '아래로 당겨 다시 시도' };
}
