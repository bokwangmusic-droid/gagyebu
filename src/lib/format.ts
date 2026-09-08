/**
 * Money + date formatting helpers. Ported from the web version so numbers
 * read identically across platforms.
 */

/** 12345 -> "12,345" (absolute value, rounded). */
export function fmt(n: number | null | undefined): string {
  return Math.abs(Math.round(n ?? 0)).toLocaleString('ko-KR');
}

/** Korean short form for tight spaces: 12,345 -> "1.2만", 3.4억 etc. */
export function fmtShort(n: number | null | undefined): string {
  const abs = Math.abs(Math.round(n ?? 0));
  if (abs < 10_000) return abs.toLocaleString('ko-KR');
  if (abs < 100_000) return `${(abs / 10_000).toFixed(1).replace(/\.0$/, '')}만`;
  if (abs < 100_000_000) return `${Math.round(abs / 10_000).toLocaleString('ko-KR')}만`;
  return `${(abs / 100_000_000).toFixed(1).replace(/\.0$/, '')}억`;
}

/** Strip every non-digit, return an int (empty -> 0). */
export function parseNum(s: string | number | null | undefined): number {
  const clean = String(s ?? '').replace(/[^0-9]/g, '');
  return clean === '' ? 0 : parseInt(clean, 10);
}

/** Signed money label: expense -> "−12,345", income -> "+12,345". */
export function signed(type: 'income' | 'expense', n: number): string {
  return `${type === 'income' ? '+' : '−'}${fmt(n)}`;
}

/** Korean weekday labels, Sunday-first — index by `Date.getDay()` (0 = 일). */
export const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

export function weekdayKo(d: Date): string {
  return WEEKDAYS_KO[d.getDay()];
}

export function startOfMonth(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function daysLeftInMonth(from: Date = new Date()): number {
  const end = endOfMonth(from);
  return Math.max(0, Math.ceil((end.getTime() - from.getTime()) / 86_400_000));
}

/** "오늘 14:30" / "어제 09:05" / "3/14 18:22" */
export function formatRelativeDateTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `오늘 ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `어제 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** "2026년 9월" */
export function formatMonthLabel(d: Date = new Date()): string {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

/** "9/1" */
export function formatShortDate(d: Date | string): string {
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

/** Local YYYY-MM-DD (no timezone shift, unlike toISOString). */
export function toDateKey(d: Date | string): string {
  const dt = new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}
