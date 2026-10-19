/**
 * 결제 알림 자동입력 — STEP 3. Optional starting values for a NEW
 * transaction on /input, passed as route params.
 *
 * A prefill only seeds the form's initial state. Nothing is saved until the
 * user presses the form's own 저장하기 button, through the unchanged
 * create path. Edit mode (/input?id=…) ignores a prefill entirely.
 *
 * Pure, no I/O. Params are untrusted (any screen / deep link can set them),
 * so every field is re-validated and anything malformed is dropped.
 *
 * STEP 4: `sourceCandidateId` names the 후보함 candidate the prefill came
 * from, so /input can mark it 처리 완료 once the save succeeds
 * (src/lib/paymentNotification/candidateAutoHandle.ts). Read only together
 * with a valid prefill, never in edit mode.
 */
import type { TxnType } from '@/data/categories';
import { isPaymentCandidateFingerprint } from '@/lib/paymentNotification/candidateAutoHandle';

export interface InputPrefill {
  type: TxnType;
  /** Whole won, > 0. */
  amount: number;
  /** '' = leave the memo empty. */
  memo: string;
  /** YYYY-MM-DD. `null` = keep the form's default (today). */
  dateKey: string | null;
}

export type InputPrefillParams = {
  prefillType: string;
  prefillAmount: string;
  prefillMemo?: string;
  prefillDate?: string;
  sourceCandidateId?: string;
};

export const INPUT_PREFILL_MAX_AMOUNT = 9_999_999_999; // the keypad's 10-digit cap
export const INPUT_PREFILL_MAX_MEMO_LENGTH = 100;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function inputPrefillToParams(prefill: InputPrefill, sourceCandidateId?: string): InputPrefillParams {
  return {
    prefillType: prefill.type,
    prefillAmount: String(prefill.amount),
    ...(prefill.memo ? { prefillMemo: prefill.memo } : {}),
    ...(prefill.dateKey ? { prefillDate: prefill.dateKey } : {}),
    ...(sourceCandidateId ? { sourceCandidateId } : {}),
  };
}

const first = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;

/**
 * `null` = no usable prefill (missing / invalid type or amount). A bad memo
 * or date alone only drops that field. A date after `todayKey` is dropped —
 * the form does not allow saving a future date.
 */
export function parseInputPrefillParams(params: Record<string, unknown>, todayKey: string): InputPrefill | null {
  const type = first(params.prefillType);
  if (type !== 'expense' && type !== 'income') return null;
  const amountRaw = first(params.prefillAmount) ?? '';
  if (!/^[1-9]\d*$/.test(amountRaw)) return null;
  const amount = Number(amountRaw);
  if (!Number.isSafeInteger(amount) || amount > INPUT_PREFILL_MAX_AMOUNT) return null;

  const memoRaw = (first(params.prefillMemo) ?? '').replace(/\s+/g, ' ').trim();
  const memo = memoRaw.length <= INPUT_PREFILL_MAX_MEMO_LENGTH ? memoRaw : '';

  const dateRaw = first(params.prefillDate);
  const dateKey = dateRaw && DATE_KEY_RE.test(dateRaw) && isRealDate(dateRaw) && dateRaw <= todayKey ? dateRaw : null;

  return { type, amount, memo, dateKey };
}

/** `null` = not started from a 후보함 candidate (or a malformed id). */
export function parseInputSourceCandidateParam(params: Record<string, unknown>): string | null {
  const id = first(params.sourceCandidateId);
  return isPaymentCandidateFingerprint(id) ? id : null;
}

/**
 * What /input takes from its params. Edit mode (`id` present) takes
 * nothing; the source candidate only comes with a usable prefill, so a plain
 * manual entry never carries one.
 */
export function parseInputRouteSeed(
  params: Record<string, unknown>,
  todayKey: string,
): { prefill: InputPrefill | null; sourceCandidateId: string | null } {
  if (first(params.id)) return { prefill: null, sourceCandidateId: null };
  const prefill = parseInputPrefillParams(params, todayKey);
  return { prefill, sourceCandidateId: prefill ? parseInputSourceCandidateParam(params) : null };
}

function isRealDate(key: string): boolean {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
