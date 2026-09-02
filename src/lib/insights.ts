/**
 * Rule-based spending insights — pure, no store/UI imports. No AI.
 *
 * Everything here is derived from stored numbers (transactions, budgets,
 * dates) via explicit calculation / comparison / thresholds, so every result
 * is explainable and reproducible.
 *
 * Design rules:
 *  - "이번 달" window = [month start, end of today], future days excluded.
 *  - "지난달 이맘때" window = previous month day 1 .. the same day-of-month
 *    (clamped to that month's last day, e.g. 3/31 -> 2/28).
 *  - Purchase-amount basis, identical to `totals` / `expenseByCategory`. A
 *    120,000원 3-month instalment counts as 120,000원 of spending in its
 *    purchase month. `cardBillingForMonth` (STEP 6 cash-flow view) is NOT
 *    used here.
 *  - Split transactions are handled entirely by `expenseByCategory` — this
 *    module never re-sums `splits`.
 */

import { getCat, type CustomCatMap } from '@/data/categories';
import { expenseByCategory, inRange, totals } from '@/lib/aggregate';
import { fmt } from '@/lib/format';
import { monthRange, prevPeriodRange } from '@/lib/period';
import type { BudgetMap, Transaction } from '@/store/types';

export type InsightKind =
  | 'budget-over'
  | 'budget-danger'
  | 'budget-watch'
  | 'pace-fast'
  | 'pace-easy'
  | 'category-up'
  | 'category-down'
  | 'total-up'
  | 'total-down'
  | 'top-category';

export type InsightTone = 'alert' | 'warn' | 'info' | 'positive';

/** Routes an insight row can deep-link to (kept to existing tab routes). */
export type InsightRoute = '/(tabs)/budget' | '/(tabs)/stats';

export interface Insight {
  kind: InsightKind;
  tone: InsightTone;
  /** Lower = more important. Used for sorting and same-category de-dup. */
  priority: number;
  /** AppIcon semantic name. */
  icon: string;
  title: string;
  body: string;
  route: InsightRoute;
  /** Category id this insight is about, for de-dup. */
  category?: string;
  /** Raw numbers for tests / debugging. */
  data?: Record<string, number>;
}

export interface InsightInput {
  transactions: Transaction[];
  budgets: BudgetMap;
  customCats: CustomCatMap;
  /** Injectable for deterministic tests. Defaults to now. */
  now?: Date;
}

/** Tunables — all thresholds in one place. */
export const INSIGHT_THRESHOLDS = {
  /** min last-month-same-window expense to trust an overall % comparison */
  totalPrevMin: 50_000,
  /** min |%| to surface an overall change */
  totalPctMin: 8,
  /** hide overall comparison before this day-of-month */
  minDayForCompare: 3,
  /** category must have at least this much on one side */
  catSideMin: 40_000,
  /** category change must move at least this many won */
  catDeltaMin: 20_000,
  /** category must be at least this share of this month's expense */
  catShareMin: 0.05,
  /** min |%| for a category change */
  catPctMin: 20,
  /** hide pace insight before this day-of-month */
  minDayForPace: 4,
  /** budgetUsed − monthProgress beyond this = fast / easy */
  paceGap: 0.15,
  /** budget ratios */
  budgetWatch: 0.8,
  budgetDanger: 0.9,
  budgetOver: 1.0,
} as const;

/** % change of `cur` vs `prev`, rounded. `null` when `prev <= 0`. */
export function pctChange(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** Days in the calendar month containing `d`. */
export function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** 0–1 fraction of the current month elapsed (whole days). */
export function monthProgress(now: Date): number {
  return now.getDate() / daysInMonth(now);
}

/**
 * This month so far: `[month start, start of tomorrow]`, clamped to the
 * month end. Half-open, so `inRange` includes every transaction dated today
 * and earlier this month, and excludes future days / next month entirely.
 */
export function monthToDateRange(now: Date): { start: Date; end: Date } {
  const { start, end: monthEnd } = monthRange(now);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start, end: endOfToday < monthEnd ? endOfToday : monthEnd };
}

/**
 * Previous month, same window: `[prev month day 1, prev month day N+1)` where
 * `N = min(today's day-of-month, prev month's last day)`. So on 3/31 the
 * window is all of February, on 1/10 it is Dec 1–10 of the previous year.
 */
export function prevSameWindowRange(now: Date): { start: Date; end: Date } {
  const { start: prevStart } = prevPeriodRange('month', now);
  const prevLastDay = daysInMonth(prevStart);
  const day = Math.min(now.getDate(), prevLastDay);
  const end = new Date(prevStart.getFullYear(), prevStart.getMonth(), day + 1);
  return { start: prevStart, end };
}

function catName(id: string, custom: CustomCatMap): string {
  return getCat(id, 'expense', custom).name;
}

const T = INSIGHT_THRESHOLDS;

/**
 * Build up to 3 insights for the home screen. Returns `[]` when there is
 * nothing meaningful to say (no expense this month, missing comparison data,
 * etc.). Results are de-duplicated per category and sorted by priority.
 */
export function buildInsights(input: InsightInput): Insight[] {
  const now = input.now ?? new Date();
  const { transactions, budgets, customCats } = input;

  const mtd = monthToDateRange(now);
  const prevWin = prevSameWindowRange(now);
  const curTxns = inRange(transactions, mtd.start, mtd.end);
  const prevTxns = inRange(transactions, prevWin.start, prevWin.end);

  const curExpense = totals(curTxns).expense;
  // Nothing spent this month (incl. no transactions at all) → no insights.
  if (curExpense <= 0) return [];

  const prevExpense = totals(prevTxns).expense;
  const curByCat = expenseByCategory(curTxns);
  const prevByCat = expenseByCategory(prevTxns);

  const day = now.getDate();
  const hasPrev = prevTxns.length > 0;
  const totalBudget = Object.values(budgets).reduce((s, v) => s + (v || 0), 0);
  const hasBudget = Object.keys(budgets).length > 0 && totalBudget > 0;

  const out: Insight[] = [];

  /* ---- 4. budget status (per category) ---- */
  if (hasBudget) {
    const rows = Object.entries(budgets)
      .filter(([, b]) => b > 0)
      .map(([catId, b]) => {
        const spent = curByCat[catId] ?? 0;
        return { catId, budget: b, spent, ratio: spent / b };
      })
      .filter((r) => r.ratio >= T.budgetWatch)
      .sort((a, b) => b.ratio - a.ratio);

    if (rows.length > 0) {
      const worst = rows[0];
      const more = rows.length - 1;
      const name = catName(worst.catId, customCats);
      const moreTxt = more > 0 ? ` 외 ${more}개` : '';
      const ratioPct = Math.round(worst.ratio * 100);
      if (worst.ratio >= T.budgetOver) {
        out.push({
          kind: 'budget-over',
          tone: 'alert',
          priority: 10,
          icon: 'warn',
          title: '예산 초과',
          body: `${name} 예산을 ${fmt(worst.spent - worst.budget)}원 초과했어요${moreTxt}`,
          route: '/(tabs)/budget',
          category: worst.catId,
          data: { spent: worst.spent, budget: worst.budget, over: worst.spent - worst.budget },
        });
      } else if (worst.ratio >= T.budgetDanger) {
        out.push({
          kind: 'budget-danger',
          tone: 'warn',
          priority: 20,
          icon: 'warn',
          title: '예산 위험',
          body: `${name} 예산의 ${ratioPct}%를 사용했어요${moreTxt}`,
          route: '/(tabs)/budget',
          category: worst.catId,
          data: { spent: worst.spent, budget: worst.budget, ratioPct },
        });
      } else {
        out.push({
          kind: 'budget-watch',
          tone: 'warn',
          priority: 40,
          icon: 'warn',
          title: '예산 주의',
          body: `${name} 예산의 ${ratioPct}%를 사용했어요${moreTxt}`,
          route: '/(tabs)/budget',
          category: worst.catId,
          data: { spent: worst.spent, budget: worst.budget, ratioPct },
        });
      }
    }
  }

  /* ---- 5. spending pace (budget users only) ---- */
  if (hasBudget && day >= T.minDayForPace && curExpense > 0) {
    const prog = monthProgress(now);
    const used = curExpense / totalBudget;
    const gap = used - prog;
    const progPct = Math.round(prog * 100);
    const usedPct = Math.round(used * 100);
    if (gap > T.paceGap) {
      out.push({
        kind: 'pace-fast',
        tone: 'warn',
        priority: 30,
        icon: 'up',
        title: '이번 달 소비 속도가 빨라요',
        body: `월은 ${progPct}% 지났는데 예산은 ${usedPct}% 사용했어요`,
        route: '/(tabs)/budget',
        data: { progressPct: progPct, usedPct },
      });
    } else if (gap < -T.paceGap) {
      out.push({
        kind: 'pace-easy',
        tone: 'positive',
        priority: 80,
        icon: 'down',
        title: '이번 달 소비 속도가 여유로워요',
        body: `월은 ${progPct}% 지났는데 예산은 ${usedPct}% 사용했어요`,
        route: '/(tabs)/budget',
        data: { progressPct: progPct, usedPct },
      });
    }
  }

  /* ---- 3. biggest category change (ranked by |delta| won) ---- */
  // Also a "지난달 이맘때" comparison, so hide it in the first days of the month.
  if (hasPrev && day >= T.minDayForCompare) {
    const catIds = new Set([...Object.keys(curByCat), ...Object.keys(prevByCat)]);
    const candidates = [...catIds]
      .map((catId) => {
        const cur = curByCat[catId] ?? 0;
        const prev = prevByCat[catId] ?? 0;
        return {
          catId,
          cur,
          prev,
          delta: cur - prev,
          pct: pctChange(cur, prev),
          share: cur / curExpense,
        };
      })
      .filter(
        (c) =>
          Math.max(c.cur, c.prev) >= T.catSideMin &&
          Math.abs(c.delta) >= T.catDeltaMin &&
          c.share >= T.catShareMin &&
          c.pct !== null &&
          Math.abs(c.pct) >= T.catPctMin,
      )
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    if (candidates.length > 0) {
      const c = candidates[0];
      const name = catName(c.catId, customCats);
      const up = c.delta > 0;
      const pctAbs = Math.abs(c.pct as number);
      out.push({
        kind: up ? 'category-up' : 'category-down',
        tone: up ? 'info' : 'positive',
        priority: up ? 50 : 80,
        icon: up ? 'up' : 'down',
        title: up
          ? `${name} 지출이 지난달보다 ${pctAbs}% 늘었어요`
          : `${name} 지출이 지난달보다 ${pctAbs}% 줄었어요`,
        body: `${up ? '+' : '−'}${fmt(Math.abs(c.delta))}원 · 지난달 이맘때 ${fmt(c.prev)}원`,
        route: '/(tabs)/stats',
        category: c.catId,
        data: { cur: c.cur, prev: c.prev, delta: c.delta, pct: c.pct as number },
      });
    }
  }

  /* ---- 1. overall spend vs last month, same window ---- */
  if (hasPrev && day >= T.minDayForCompare && prevExpense >= T.totalPrevMin) {
    const pct = pctChange(curExpense, prevExpense);
    if (pct !== null && Math.abs(pct) >= T.totalPctMin) {
      const up = pct > 0;
      const pctAbs = Math.abs(pct);
      out.push({
        kind: up ? 'total-up' : 'total-down',
        tone: up ? 'info' : 'positive',
        priority: up ? 60 : 80,
        icon: up ? 'up' : 'down',
        title: '지난달 이맘때보다',
        body: `지출이 ${pctAbs}% ${up ? '많아요' : '적어요'} · ${fmt(prevExpense)}원 → ${fmt(curExpense)}원`,
        route: '/(tabs)/stats',
        data: { cur: curExpense, prev: prevExpense, pct },
      });
    }
  }

  /* ---- 2. top category (baseline — shown when a slot is free) ---- */
  {
    const top = Object.entries(curByCat).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] > 0) {
      const [catId, amt] = top;
      const sharePct = Math.round((amt / curExpense) * 100);
      out.push({
        kind: 'top-category',
        tone: 'info',
        priority: 70,
        icon: 'sparkle',
        title: '이번 달 가장 많이 쓴 곳',
        body: `${catName(catId, customCats)} ${fmt(amt)}원 · 전체의 ${sharePct}%`,
        route: '/(tabs)/stats',
        category: catId,
        data: { amount: amt, sharePct },
      });
    }
  }

  /*
   * Assemble: `top-category` is only a baseline — it fills a slot when no
   * other insight already speaks about that category. Everything else is
   * de-duplicated per category (keep the most important) and sorted.
   */
  const perCat = new Map<string, Insight>();
  const noCat: Insight[] = [];
  for (const ins of out) {
    if (ins.kind === 'top-category') continue;
    if (ins.category) {
      const prev = perCat.get(ins.category);
      if (!prev || ins.priority < prev.priority) perCat.set(ins.category, ins);
    } else {
      noCat.push(ins);
    }
  }
  const result = [...perCat.values(), ...noCat].sort((a, b) => a.priority - b.priority);

  const top = out.find((i) => i.kind === 'top-category');
  if (top && !result.some((i) => i.category === top.category)) {
    result.push(top);
    result.sort((a, b) => a.priority - b.priority);
  }

  return result.slice(0, 3);
}
