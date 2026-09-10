/**
 * Row subtitle for a budget that carries an offline-queue overlay on the
 * Budget tab — STEP 16-H2-C2-BUDGET A2. PURE, no React. Mirrors
 * src/lib/pendingCategoryLabel.ts / pendingCardLabel.ts.
 *
 * The finance read model (`useFinanceRead().pendingBudgetOps`) maps a
 * visible category id to `{ op, failed, reason?, attemptedAmount? }`. This
 * turns that into the short Korean status line(s) shown under the budget
 * row's category name.
 *
 * BUDGET CONFLICT LABEL UI FIX — the row's text column is narrow (it sits
 * next to a fixed-size icon and the delete/discard controls), so the old
 * single combined string ("수정 전송 실패 · 다른 기기 변경 확인 필요")
 * truncated to an unreadable "다른 기기 ..." under `numberOfLines={1}`.
 * `pendingBudgetRowLabel` now returns `{ primary, detail }` — TWO short
 * pieces the caller renders as separate `<Text>` lines with no
 * `numberOfLines`/ellipsis, so the full meaning is always readable:
 *   - `primary` — the short status word, always fits one line on its own
 *     ("전송 대기" / "수정 전송 실패" / …).
 *   - `detail`  — `null` for a not-failed pending op (the primary line
 *     already says everything); for ANY failed op, a short second line
 *     naming the reason (or "아래로 당겨 다시 시도" when there is no
 *     specific server verdict) — always present so the layout is
 *     consistent whether or not a reason is known.
 * A-vs-B copy: this is a text/layout change ONLY — the underlying
 * `PendingBudgetRowState` (op/failed/reason) and every other conflict/queue
 * behavior are unchanged.
 *
 * `reason` is the ORIGINAL write-service verdict, already normalized by
 * `runOp.ts` (STEP 16-H2-C2-BUDGET A1 §4) down to the shared
 * `WriteConflictReason` — `exists` arrives here as `conflict`, `invalid` as
 * `undefined`. Raw server / Postgres text is never shown.
 */
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';

export interface PendingBudgetRowState {
  op: 'create' | 'update' | 'delete';
  failed: boolean;
  reason?: WriteConflictReason;
}

/** Two short lines, never a single long truncation-prone string. */
export interface PendingBudgetRowLabel {
  /** Always fits one line on its own: "전송 대기" / "수정 전송 실패" / … */
  primary: string;
  /** `null` only for a not-failed pending op; always present when `failed`. */
  detail: string | null;
}

/** True when a retry cannot fix it and the user must check another device. */
export function isBudgetCrossDeviceConflict(reason: WriteConflictReason | undefined): boolean {
  return reason === 'conflict' || reason === 'deleted' || reason === 'gone';
}

/**
 * A pending or failed budget row is ALWAYS read-only on the Budget tab
 * (STEP 16-H2-C2-BUDGET A2 §18): no tap-to-edit, no delete, until a terminal
 * failure is either resolved by a successful retry or dropped via
 * "변경 버리기" — never a second write stacked on top of an in-flight one.
 */
export function isPendingBudgetRowReadOnly(_state: PendingBudgetRowState): boolean {
  return true;
}

export function pendingBudgetRowLabel(state: PendingBudgetRowState): PendingBudgetRowLabel {
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
      // §11/§6-item-C: budget's natural key (category_id) makes a genuine
      // "someone else already created this budget" race reachable (unlike
      // card/category's client-generated ids) — `exists` normalizes to
      // `conflict` in runOp.ts, so it gets the same cross-device phrasing.
      if (state.reason === 'conflict') return { primary: '전송 실패', detail: '다른 기기에서 변경됐어요' };
      if (state.reason === 'gone') return { primary: '전송 실패', detail: '카테고리를 찾을 수 없어요' };
      return { primary: '전송 실패', detail: '아래로 당겨 다시 시도' };
    case 'update':
      if (state.reason === 'deleted') return { primary: '수정 전송 실패', detail: '다른 기기에서 삭제됐어요' };
      if (state.reason === 'gone') return { primary: '수정 전송 실패', detail: '예산을 찾을 수 없어요' };
      if (state.reason === 'conflict') return { primary: '수정 전송 실패', detail: '다른 기기에서 변경됐어요' };
      return { primary: '수정 전송 실패', detail: '아래로 당겨 다시 시도' };
    case 'delete':
      return {
        primary: '삭제 전송 실패',
        detail: isBudgetCrossDeviceConflict(state.reason) ? '다른 기기에서 변경됐어요' : '아래로 당겨 다시 시도',
      };
  }
}
