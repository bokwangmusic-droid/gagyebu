/**
 * Recurring-rule schedule maths. Ported verbatim from the web version.
 */

import type { RecurringRule } from '@/store/types';

/** Next occurrence strictly at/after `from` for the given rule. */
export function nextOccurrenceAfter(rule: RecurringRule, from: Date): Date | null {
  const f = new Date(from);
  if (rule.frequency === 'monthly') {
    const target = new Date(f.getFullYear(), f.getMonth(), rule.dayOfMonth ?? 1);
    if (target < f) target.setMonth(target.getMonth() + 1);
    return target;
  }
  if (rule.frequency === 'weekly') {
    const target = new Date(f);
    const diff = ((rule.dayOfWeek ?? 0) + 7 - target.getDay()) % 7;
    if (diff === 0 && target <= f) target.setDate(target.getDate() + 7);
    else target.setDate(target.getDate() + diff);
    return target;
  }
  return null;
}

/** All missed fire dates since `lastRun` (or `createdAt`) up to `now`. */
export function computeMissedOccurrences(rule: RecurringRule, now: Date): Date[] {
  const results: Date[] = [];
  const start = new Date(rule.lastRun || rule.createdAt || now);
  let d = nextOccurrenceAfter(rule, start);
  let guard = 0;
  while (d && d <= now && guard < 100) {
    results.push(new Date(d));
    d = nextOccurrenceAfter(rule, new Date(d.getTime() + 86_400_000));
    guard++;
  }
  return results;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function describeSchedule(rule: RecurringRule): string {
  if (rule.frequency === 'monthly') return `매월 ${rule.dayOfMonth}일`;
  if (rule.frequency === 'weekly') return `매주 ${WEEKDAYS[rule.dayOfWeek ?? 0]}요일`;
  return '';
}
