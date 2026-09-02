/**
 * Split-expense helpers — pure, no store/UI imports.
 *
 * A split transaction keeps its own `amount` as the real total and carries a
 * `splits: TransactionSplit[]` breakdown that must sum to it. Validation for
 * the input layer lives here; aggregation (`expenseByCategory`) already reads
 * `splits` when present, so nothing downstream needs to change.
 */

import { parseNum } from '@/lib/format';
import type { Transaction, TransactionSplit } from '@/store/types';

/** A split row while it is being edited (amount still a raw string). */
export interface SplitDraft {
  category: string;
  amount: string;
}

/** Fewer than this and there is no reason to use `splits` at all. */
export const MIN_SPLITS = 2;

export function makeSplitDraft(category: string): SplitDraft {
  return { category, amount: '' };
}

/** Draft rows -> clean splits (`amount` as an integer number of won). */
export function normalizeSplits(drafts: SplitDraft[]): TransactionSplit[] {
  return drafts.map((d) => ({ category: d.category, amount: parseNum(d.amount) }));
}

export function splitsTotal(splits: { amount: number }[]): number {
  return splits.reduce((sum, s) => sum + (s.amount || 0), 0);
}

/** True when this transaction stores a per-category breakdown. */
export function hasSplits(t: Pick<Transaction, 'splits'>): boolean {
  return Array.isArray(t.splits) && t.splits.length > 0;
}

export type SplitError =
  | 'too-few'
  | 'missing-category'
  | 'nonpositive'
  | 'sum-mismatch';

export interface SplitCheck {
  ok: boolean;
  /** First failing rule, in priority order. */
  error?: SplitError;
  /** Sum of the split amounts (for display regardless of ok). */
  sum: number;
}

/**
 * Validate split rows against the transaction total. Rules, in order:
 *   1. at least MIN_SPLITS rows
 *   2. every row has a category
 *   3. every row amount is > 0
 *   4. the rows sum exactly to `total`
 */
export function checkSplits(
  total: number,
  splits: TransactionSplit[],
): SplitCheck {
  const sum = splitsTotal(splits);
  if (splits.length < MIN_SPLITS) return { ok: false, error: 'too-few', sum };
  if (splits.some((s) => !s.category))
    return { ok: false, error: 'missing-category', sum };
  if (splits.some((s) => !(s.amount > 0)))
    return { ok: false, error: 'nonpositive', sum };
  if (sum !== total) return { ok: false, error: 'sum-mismatch', sum };
  return { ok: true, sum };
}

export const SPLIT_ERROR_TEXT: Record<SplitError, string> = {
  'too-few': '분할은 2개 이상이어야 해요.',
  'missing-category': '모든 분할에 카테고리를 선택해 주세요.',
  nonpositive: '분할 금액은 0보다 커야 해요.',
  'sum-mismatch': '분할 금액이 총 금액과 일치하지 않습니다.',
};
