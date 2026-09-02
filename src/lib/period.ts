/**
 * Period & date-range helpers.
 *
 * Consolidates the week / month / year boundary maths that several screens
 * (stats, all-transactions, home, calendar) were each computing inline.
 * All ranges are half-open: an item belongs to a range when
 * `start <= date < end`.
 */

import { startOfMonth } from '@/lib/format';

export type PeriodKind = 'week' | 'month' | 'year';

export interface DateRange {
  start: Date;
  end: Date;
}

/** Local midnight of the given day. */
export function startOfDay(ref: Date = new Date()): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
}

/** Monday-based start of the week containing `ref`. */
export function startOfWeek(ref: Date = new Date()): Date {
  const d = startOfDay(ref);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d;
}

export function weekRange(ref: Date = new Date()): DateRange {
  const start = startOfWeek(ref);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

export function monthRange(ref: Date = new Date()): DateRange {
  const start = startOfMonth(ref);
  return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
}

export function yearRange(ref: Date = new Date()): DateRange {
  const y = ref.getFullYear();
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
}

export function periodRange(kind: PeriodKind, ref: Date = new Date()): DateRange {
  if (kind === 'week') return weekRange(ref);
  if (kind === 'year') return yearRange(ref);
  return monthRange(ref);
}

/** The period of the same kind immediately before the one containing `ref`. */
export function prevPeriodRange(kind: PeriodKind, ref: Date = new Date()): DateRange {
  const cur = periodRange(kind, ref);
  if (kind === 'week') {
    const start = new Date(cur.start);
    start.setDate(start.getDate() - 7);
    return { start, end: new Date(cur.start) };
  }
  if (kind === 'year') {
    return { start: new Date(cur.start.getFullYear() - 1, 0, 1), end: new Date(cur.start) };
  }
  return {
    start: new Date(cur.start.getFullYear(), cur.start.getMonth() - 1, 1),
    end: new Date(cur.start),
  };
}
