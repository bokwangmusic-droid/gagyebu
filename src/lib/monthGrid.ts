/**
 * Shared month-grid builder for every calendar in the app (the date-picker
 * `CalendarSheet` and the transaction `calendar` tab).
 *
 * Korean convention: the week starts on SUNDAY. `Date.getDay()` is used
 * directly as the column index (0 = 일 … 6 = 토) — no Monday-first shift.
 *
 * The result is a list of WEEKS, each guaranteed to hold exactly 7 days
 * (leading/trailing days come from the neighbouring months). Consumers
 * render one `<View flexDirection:"row">` per week with 7 `flex: 1` cells,
 * so a row can never wrap to 6 columns from percentage/pixel rounding.
 *
 * Pure: no timezone change (local `new Date(y, m, d)`, same as `toDateKey`),
 * no store/UI imports.
 */
import { toDateKey } from '@/lib/format';

export interface MonthDay {
  date: Date;
  /** YYYY-MM-DD (local). */
  key: string;
  /** false for the leading/trailing days that belong to another month. */
  inMonth: boolean;
  /** `Date.getDay()` — 0 = Sunday … 6 = Saturday. */
  dow: number;
}

/**
 * `year` full year, `month` 0-based (0 = January). Returns full weeks
 * (Sun→Sat), 4–6 of them.
 */
export function buildMonthWeeks(year: number, month: number): MonthDay[][] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadPad = new Date(year, month, 1).getDay(); // 0 when the 1st is a Sunday

  const flat: MonthDay[] = [];
  const push = (d: Date, inMonth: boolean) =>
    flat.push({ date: d, key: toDateKey(d), inMonth, dow: d.getDay() });

  // Leading days from the previous month. `new Date(y, m, 0 / -1 / …)`
  // rolls back into the previous month correctly.
  for (let i = leadPad; i > 0; i--) push(new Date(year, month, 1 - i), false);
  // This month.
  for (let i = 1; i <= daysInMonth; i++) push(new Date(year, month, i), true);
  // Trailing days to complete the last week.
  while (flat.length % 7 !== 0) {
    const prev = flat[flat.length - 1].date;
    push(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1), false);
  }

  const weeks: MonthDay[][] = [];
  for (let i = 0; i < flat.length; i += 7) weeks.push(flat.slice(i, i + 7));
  return weeks;
}
