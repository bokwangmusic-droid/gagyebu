/**
 * Dev verification for recurring-rule schedule maths.
 *
 * Same convention as the other `src/lib/*.cases.ts` (plain data + a runner, no
 * test framework). Not bundled; `npx tsc --noEmit` type-checks it.
 *
 * Focus: STEP 11 regression — a "매월 29/30/31일" monthly rule must clamp to the
 * target month's last day instead of spilling into the next month (2월,
 * 30-day months), and year boundaries stay exact.
 */

import { computeMissedOccurrences, nextOccurrenceAfter } from '@/lib/recurring';
import { toDateKey } from '@/lib/format';
import type { RecurringRule } from '@/store/types';

const rule = (o: Partial<RecurringRule>): RecurringRule => ({
  id: 'r',
  type: 'expense',
  name: 'test',
  amount: 1000,
  category: 'subscribe',
  frequency: 'monthly',
  dayOfMonth: 1,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...o,
});

export interface RecurringCase {
  name: string;
  rule: RecurringRule;
  from: Date;
  expectKey: string; // toDateKey of the next occurrence
}

export const RECURRING_CASES: RecurringCase[] = [
  {
    name: '매월 31일 · 1월 초 → 1/31',
    rule: rule({ dayOfMonth: 31 }),
    from: new Date(2026, 0, 2),
    expectKey: '2026-01-31',
  },
  {
    name: '매월 31일 · 2월 → 2/28 (다음 달로 안 넘어감)',
    rule: rule({ dayOfMonth: 31 }),
    from: new Date(2026, 1, 1),
    expectKey: '2026-02-28',
  },
  {
    name: '매월 31일 · 4월 → 4/30',
    rule: rule({ dayOfMonth: 31 }),
    from: new Date(2026, 3, 1),
    expectKey: '2026-04-30',
  },
  {
    name: '매월 30일 · 2월 → 2/28',
    rule: rule({ dayOfMonth: 30 }),
    from: new Date(2026, 1, 1),
    expectKey: '2026-02-28',
  },
  {
    name: '매월 29일 · 윤년 2월(2028) → 2/29',
    rule: rule({ dayOfMonth: 29 }),
    from: new Date(2028, 1, 1),
    expectKey: '2028-02-29',
  },
  {
    name: '매월 31일 · 12월 말 → 다음 해 1/31 (연도 경계)',
    rule: rule({ dayOfMonth: 31 }),
    from: new Date(2026, 11, 31, 12), // Dec 31 midday, target this month already passed
    expectKey: '2027-01-31',
  },
  {
    name: '매월 15일 · 평범한 케이스는 그대로 (회귀 없음)',
    rule: rule({ dayOfMonth: 15 }),
    from: new Date(2026, 4, 20),
    expectKey: '2026-06-15',
  },
];

export interface RecurringCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function runRecurringCases(cases: RecurringCase[] = RECURRING_CASES): {
  results: RecurringCaseResult[];
  passed: number;
  failed: number;
} {
  const results = cases.map((c) => {
    const d = nextOccurrenceAfter(c.rule, c.from);
    const got = d ? toDateKey(d) : '(null)';
    const pass = got === c.expectKey;
    return { name: c.name, pass, detail: `got ${got}, want ${c.expectKey}` };
  });

  // Missed-occurrence sweep must not misplace or duplicate a day-31 rule.
  {
    const r = rule({ dayOfMonth: 31, createdAt: '2026-01-01T00:00:00.000Z', lastRun: '2026-01-31T00:00:00.000Z' });
    const occs = computeMissedOccurrences(r, new Date(2026, 3, 15)); // through Apr 15
    const keys = occs.map(toDateKey);
    const ok = JSON.stringify(keys) === JSON.stringify(['2026-02-28', '2026-03-31']);
    results.push({
      name: 'computeMissedOccurrences(매월 31일, Jan31→Apr15) = [2/28, 3/31]',
      pass: ok,
      detail: `got ${JSON.stringify(keys)}`,
    });
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
