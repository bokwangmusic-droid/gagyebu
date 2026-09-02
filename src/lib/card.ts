/**
 * Credit-card & instalment maths — pure, no store/UI imports.
 *
 * Design (STEP 6 MVP):
 *  - A card purchase is ONE `Transaction`. Its `amount` is the full price and
 *    stays the basis for every existing total (`totals`, `expenseByCategory`,
 *    stats, budget). Nothing here changes those.
 *  - 할부 is expressed only as `installment.months`. The per-month charge is
 *    derived here, never stored, never materialised as extra rows.
 *  - Billing is bucketed by the PURCHASE month (거래 발생 월 = 1회차 월). No
 *    carrier-specific 마감일/이용기간 windows. `closingDay`/`paymentDay` are
 *    display-only elsewhere.
 *
 * All month arithmetic uses an integer month index `year * 12 + month` so
 * year boundaries (12월 → 다음 해 1월) are exact without `Date.setMonth` loops.
 */

import type { CreditCard, Transaction } from '@/store/types';

/** Sentinel key for card charges whose `cardId` is missing or unknown. */
export const UNASSIGNED_CARD_ID = '__unassigned__';

/** `year * 12 + month` (month 0-based). Accepts a Date or an ISO string. */
export function monthIndex(d: Date | string): number {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.getFullYear() * 12 + dt.getMonth();
}

export interface InstallmentSchedule {
  months: number;
  /** Charge for every month except the last. */
  perMonth: number;
  /** Last month absorbs the rounding remainder so the schedule sums exactly. */
  lastMonth: number;
}

/**
 * Split `amount` into `months` monthly charges. Every month is `perMonth`
 * except the final one, which is `amount - perMonth * (months - 1)`, so
 * `perMonth * (months - 1) + lastMonth === amount` always holds.
 *
 * 120,000 / 3 -> 40,000 · 40,000 · 40,000
 * 100,000 / 3 -> 33,333 · 33,333 · 33,334
 */
export function installmentPerMonth(
  amount: number,
  months: number,
): InstallmentSchedule {
  const n = Number.isFinite(months) ? Math.max(1, Math.floor(months)) : 1;
  const amt = Number.isFinite(amount) ? amount : 0;
  const perMonth = Math.floor(amt / n);
  const lastMonth = amt - perMonth * (n - 1);
  return { months: n, perMonth, lastMonth };
}

/**
 * Number of instalment months for a transaction (1 = 일시불).
 *
 * Defensive: the input UI only ever stores an integer `months >= 2`, but a
 * corrupted / hand-edited / future-version backup could carry a string,
 * `NaN`, `Infinity`, 0 or a negative. Any non-finite / sub-1 value falls back
 * to `1` (일시불) so downstream maths stays a finite number and never NaN.
 */
function monthsOf(txn: Pick<Transaction, 'installment'>): number {
  const n = Math.floor(Number(txn.installment?.months));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * How much of `txn` lands on the card bill for the calendar month `m`
 * (an integer month index from `monthIndex`). Ignores `paymentMethod` and
 * `splits` entirely — callers decide which transactions are card charges.
 *
 * 일시불: the whole amount in its own month, 0 elsewhere.
 * 할부:   `perMonth` for months `start … start+months-2`, `lastMonth` for the
 *         final month, 0 outside the window.
 */
export function chargeForMonth(
  txn: Pick<Transaction, 'amount' | 'date' | 'installment'>,
  m: number,
): number {
  const start = monthIndex(txn.date);
  const months = monthsOf(txn);
  const k = m - start;
  if (k < 0 || k >= months) return 0;
  if (months <= 1) return txn.amount;
  const { perMonth, lastMonth } = installmentPerMonth(txn.amount, months);
  return k === months - 1 ? lastMonth : perMonth;
}

export interface InstallmentPlan {
  months: number;
  perMonth: number;
  lastMonth: number;
  /** Month index of the first (=purchase) instalment. */
  startIndex: number;
  /** Instalments already billed as of `ref` (start month counts as #1). */
  billedCount: number;
  /** Instalments not yet billed. Never negative. */
  remainingCount: number;
  billedAmount: number;
  /** `amount - billedAmount`. Never negative. */
  remainingAmount: number;
}

/**
 * Progress of one instalment purchase as of `ref` (default: now). All fields
 * are derived; nothing is persisted. Works for 일시불 too (months = 1).
 */
export function installmentPlan(
  txn: Pick<Transaction, 'amount' | 'date' | 'installment'>,
  ref: Date = new Date(),
): InstallmentPlan {
  const months = monthsOf(txn);
  const startIndex = monthIndex(txn.date);
  const curIndex = monthIndex(ref);
  const { perMonth, lastMonth } = installmentPerMonth(txn.amount, months);

  const billedCount = Math.min(months, Math.max(0, curIndex - startIndex + 1));
  const remainingCount = months - billedCount;

  let billedAmount = 0;
  for (let k = 0; k < billedCount; k++) {
    billedAmount += k === months - 1 ? lastMonth : perMonth;
  }
  const remainingAmount = Math.max(0, txn.amount - billedAmount);

  return {
    months,
    perMonth,
    lastMonth,
    startIndex,
    billedCount,
    remainingCount,
    billedAmount,
    remainingAmount,
  };
}

export interface CardBilling {
  /** cardId -> charge for the target month. Unknown/missing cardId is excluded here. */
  byCard: Record<string, number>;
  /** Charges for credit transactions whose card can't be resolved. */
  unassigned: number;
  /** `sum(byCard) + unassigned`. */
  total: number;
  /** The month index this was computed for. */
  month: number;
}

/**
 * "사용월 기준 예상 카드값" for the month containing `ref` (default: now).
 * Only `type === 'expense'` && `paymentMethod === 'credit'` transactions
 * count. A `cardId` that no longer matches any registered card falls into
 * `unassigned` — the source transaction is never dropped.
 */
export function cardBillingForMonth(
  txns: Transaction[],
  cards: CreditCard[],
  ref: Date = new Date(),
): CardBilling {
  const m = monthIndex(ref);
  const known = new Set(cards.map((c) => c.id));
  const byCard: Record<string, number> = {};
  let unassigned = 0;

  for (const t of txns) {
    if (t.type !== 'expense' || t.paymentMethod !== 'credit') continue;
    const charge = chargeForMonth(t, m);
    if (charge === 0) continue;
    if (t.cardId && known.has(t.cardId)) {
      byCard[t.cardId] = (byCard[t.cardId] ?? 0) + charge;
    } else {
      unassigned += charge;
    }
  }

  const total =
    Object.values(byCard).reduce((s, v) => s + v, 0) + unassigned;
  return { byCard, unassigned, total, month: m };
}

/** Resolve a transaction's card key for grouping (unknown -> sentinel). */
export function resolveCardKey(
  txn: Pick<Transaction, 'cardId'>,
  cards: CreditCard[],
): string {
  if (txn.cardId && cards.some((c) => c.id === txn.cardId)) return txn.cardId;
  return UNASSIGNED_CARD_ID;
}
