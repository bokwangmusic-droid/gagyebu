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
 * Millisecond value of a `Transaction.date`. Invalid / missing dates sort as
 * the epoch so the comparator in `recentTransactions` stays total.
 */
function dateMs(date: string): number {
  const t = Date.parse(date);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Creation time recovered from a client-minted id: `<prefix>-<ms>-<rand>`
 * (src/lib/id.ts and src/store/store.tsx's private `uid`). An id that doesn't
 * carry a numeric middle segment yields 0 — the `id` string comparison in
 * `recentTransactions` is still there as the final, always-deterministic
 * tie-break.
 */
function createdMsFromId(id: string): number {
  const seg = id.split('-')[1];
  const n = seg ? Number(seg) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * The `limit` most-recently-entered transactions, for the home "최근 내역"
 * list — a DETERMINISTIC selection, not "the first N of whatever order the
 * array happens to be in".
 *
 * Why this exists: the remote snapshot SELECT (src/services/remoteFinance.ts)
 * carries no `ORDER BY`, and src/lib/remoteFinanceMapping.ts preserves that
 * order, so a freshly-inserted transaction can land anywhere in the array —
 * which is why a just-created row could be missing from the home list while
 * still showing on 전체 내역 (that screen re-sorts by `date`). The local
 * store happens to prepend new rows, so a bare `.slice(0, N)` looked correct
 * there; this helper makes both paths agree on the same Transaction model.
 *
 * Order:
 *   1. `date` descending — the same key app/all-transactions.tsx sorts by.
 *   2. tie-break: creation time descending, from the id's `<ms>` segment.
 *   3. final tie-break: `id` descending — fully deterministic even for two
 *      rows created in the same millisecond.
 *
 * Pure; sorts a COPY, never mutates the input. `updated_at` / an edit is
 * deliberately NOT a key: editing an old transaction (without changing its
 * `date`) does not move it up the list.
 */
export function recentTransactions(
  txns: readonly Transaction[],
  limit = 5,
): Transaction[] {
  return [...txns]
    .sort((a, b) => {
      const byDate = dateMs(b.date) - dateMs(a.date);
      if (byDate !== 0) return byDate;
      const byCreated = createdMsFromId(b.id) - createdMsFromId(a.id);
      if (byCreated !== 0) return byCreated;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .slice(0, Math.max(0, limit));
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
