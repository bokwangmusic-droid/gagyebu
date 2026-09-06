/**
 * Transaction aggregation helpers — pure, no store/UI imports.
 *
 * Consolidates the income / expense / per-category sums that were repeated
 * inline in the store (`useMonthlyTotals`) and in the stats, home and
 * all-transactions screens. Behaviour is identical to the previous inline
 * code for existing data.
 *
 * Split-aware: a transaction carrying a non-empty `splits` array contributes
 * each split to its own category in `expenseByCategory`; the transaction's
 * own `amount` still stands as its total for `sumByType` / `totals`. Today no
 * data has `splits`, so every result matches the pre-refactor numbers.
 */

import type { TxnType } from '@/data/categories';
import { monthRange } from '@/lib/period';
import type { BudgetMap, Transaction } from '@/store/types';

/** Half-open `[start, end)` date-range filter. Null bounds are skipped. */
export function inRange(
  txns: Transaction[],
  start: Date | null,
  end: Date | null,
): Transaction[] {
  if (!start && !end) return txns.slice();
  return txns.filter((t) => {
    const d = new Date(t.date);
    if (start && d < start) return false;
    if (end && d >= end) return false;
    return true;
  });
}

/** Sum of `amount` over transactions of the given type. */
export function sumByType(txns: Transaction[], type: TxnType): number {
  let sum = 0;
  for (const t of txns) if (t.type === type) sum += t.amount;
  return sum;
}

/** `{ income, expense, net }` in a single pass. */
export function totals(txns: Transaction[]): {
  income: number;
  expense: number;
  net: number;
} {
  let income = 0;
  let expense = 0;
  for (const t of txns) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  }
  return { income, expense, net: income - expense };
}

/** Expense amount per category id (income ignored). Split-aware. */
export function expenseByCategory(txns: Transaction[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const t of txns) {
    if (t.type !== 'expense') continue;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) m[s.category] = (m[s.category] ?? 0) + s.amount;
    } else {
      m[t.category] = (m[t.category] ?? 0) + t.amount;
    }
  }
  return m;
}

/** `expenseByCategory` as `[id, amount]` pairs, largest first. */
export function sortedExpenseCategories(txns: Transaction[]): [string, number][] {
  return Object.entries(expenseByCategory(txns)).sort((a, b) => b[1] - a[1]);
}

/**
 * Current-calendar-month figures — the same computation `useMonthlyTotals`
 * (src/store/store.tsx) does, extracted as a plain function so a screen
 * reading from a data source OTHER than `useStore()` (STEP 16-G1B's
 * `useFinanceRead()`) can get the identical numbers without depending on
 * StoreProvider. `useMonthlyTotals` itself is untouched — this is a new,
 * parallel export, not a replacement.
 */
export function monthlyTotals(
  transactions: Transaction[],
  budgets: BudgetMap,
): {
  thisMonth: Transaction[];
  income: number;
  expense: number;
  byCategory: Record<string, number>;
  totalBudget: number;
  remaining: number;
} {
  const { start, end } = monthRange();
  const thisMonth = inRange(transactions, start, end);
  const { income, expense } = totals(thisMonth);
  const byCategory = expenseByCategory(thisMonth);
  const totalBudget = Object.values(budgets).reduce((s, v) => s + (v || 0), 0);
  return { thisMonth, income, expense, byCategory, totalBudget, remaining: totalBudget - expense };
}
