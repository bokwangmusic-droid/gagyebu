/**
 * Savings-goal maths — STEP 9.
 *
 * Pure, UI-agnostic derivations from the existing `Goal` shape
 * (`target`, `saved`, `deadline`, `createdAt`). No new stored fields, no
 * schema change: everything here is computed on the fly.
 *
 * Month arithmetic is done with a `year * 12 + month` index only — never with
 * `Date.prototype.setMonth` increments — so a goal near a month boundary can't
 * drift a month, and there is no `NaN` / `Infinity` / negative-month path.
 */

import type { Goal } from '@/store/types';

export type GoalPace = 'ahead' | 'onTrack' | 'behind';

/** Time-vs-money gap (as a fraction of the goal) that flips the pace verdict. */
export const PACE_BAND = 0.1;

export interface GoalDeadlineStats {
  /** YYYY-MM-DD, echoed back for convenience. */
  date: string;
  /** The deadline is before today. */
  past: boolean;
  /** Whole months from today to the deadline, always >= 1. Absent when `past`. */
  remainingMonths?: number;
  /** `ceil(remainingAmount / remainingMonths)`. Absent when `past` or achieved. */
  requiredMonthlySaving?: number;
  /** Money progress vs time progress. Absent when `past`, achieved, or `createdAt` unusable. */
  pace?: GoalPace;
}

export interface GoalStats {
  /** `saved / target`, clamped to 0..1. */
  progress: number;
  /** `progress` as a 0..100 integer (never overflows past 100). */
  progressPct: number;
  /** `max(target - saved, 0)`. */
  remainingAmount: number;
  /** `saved >= target` (with `target > 0`). */
  achieved: boolean;
  /** Present only when the goal has a valid `deadline`. */
  deadline: GoalDeadlineStats | null;
}

const monthIndex = (d: Date): number => d.getFullYear() * 12 + d.getMonth();

/** Local midnight of `ref`. */
function startOfDayLocal(ref: Date): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
}

/** Parse a strict `YYYY-MM-DD` key to local midnight, or `null` if malformed. */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  // Reject calendar overflow like 2026-02-31.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Whole calendar months from `now` to `deadline`, floored at 1 (month-index
 * difference). The caller must have already established that `deadline` is not
 * in the past.
 */
export function monthsUntil(deadline: Date, now: Date): number {
  return Math.max(1, monthIndex(deadline) - monthIndex(now));
}

/** `saved / target`, guarded and clamped to 0..1. */
export function goalProgress(saved: number, target: number): number {
  if (!(target > 0)) return 0;
  const p = saved / target;
  if (!Number.isFinite(p) || p < 0) return 0;
  return Math.min(1, p);
}

/** `ceil(remaining / months)` — 0 when nothing is left or months is unusable. */
export function requiredMonthlySaving(remaining: number, months: number): number {
  if (remaining <= 0 || months <= 0 || !Number.isFinite(remaining) || !Number.isFinite(months)) {
    return 0;
  }
  return Math.ceil(remaining / months);
}

/**
 * Compare how far the *money* has come against how far the *time* has come.
 *
 *   amountProgress = saved / target        (NOT capped — a 130%-funded goal is clearly ahead)
 *   timeProgress   = elapsed / totalSpan   (clamped 0..1)
 *
 * `amountProgress - timeProgress`:
 *   >=  +PACE_BAND -> 'ahead'
 *   <=  -PACE_BAND -> 'behind'
 *   else            -> 'onTrack'
 *
 * Returns `undefined` when the span is unusable (start not before deadline, or
 * a non-positive target).
 */
export function goalPace(
  saved: number,
  target: number,
  start: Date,
  deadline: Date,
  now: Date,
): GoalPace | undefined {
  if (!(target > 0)) return undefined;
  const totalSpan = deadline.getTime() - start.getTime();
  if (!(totalSpan > 0)) return undefined;

  const elapsed = now.getTime() - start.getTime();
  const timeProgress = Math.min(1, Math.max(0, elapsed / totalSpan));
  const amountProgress = saved / target;
  const diff = amountProgress - timeProgress;

  if (diff >= PACE_BAND) return 'ahead';
  if (diff <= -PACE_BAND) return 'behind';
  return 'onTrack';
}

/** Everything the goal card needs, with every edge case already resolved. */
export function goalStats(goal: Goal, now: Date = new Date()): GoalStats {
  const target = Math.max(0, Number.isFinite(goal.target) ? goal.target : 0);
  const saved = Math.max(0, Number.isFinite(goal.saved) ? goal.saved : 0);

  const progress = goalProgress(saved, target);
  const remainingAmount = Math.max(target - saved, 0);
  const achieved = target > 0 && saved >= target;

  const base: GoalStats = {
    progress,
    progressPct: Math.round(progress * 100),
    remainingAmount,
    achieved,
    deadline: null,
  };

  if (!goal.deadline) return base;
  const dl = parseDateKey(goal.deadline);
  if (!dl) return base; // malformed deadline -> behave as if there is none

  const today = startOfDayLocal(now);
  if (dl.getTime() < today.getTime()) {
    return { ...base, deadline: { date: goal.deadline, past: true } };
  }

  const remainingMonths = monthsUntil(dl, today);
  const start = parseIso(goal.createdAt);
  const usableStart = start && start.getTime() < dl.getTime() ? start : null;

  return {
    ...base,
    deadline: {
      date: goal.deadline,
      past: false,
      remainingMonths,
      requiredMonthlySaving: achieved
        ? undefined
        : requiredMonthlySaving(remainingAmount, remainingMonths),
      pace:
        achieved || !usableStart
          ? undefined
          : goalPace(saved, target, usableStart, dl, now),
    },
  };
}
