/**
 * Dev verification for the natural-language parser.
 *
 * No test framework is set up in this project, so these are plain data +
 * a runner. Nothing imports this file in the app, so it is not bundled; it
 * exists to document expected behaviour and to be run ad-hoc:
 *
 *   (transpile src/lib/{naturalInput,format}.ts + src/data/categories.ts,
 *    then `node` a script that calls runNaturalInputCases())
 *
 * `npx tsc --noEmit` still type-checks it, so it catches signature drift.
 */

import { parseNaturalInput, type NaturalParseResult } from '@/lib/naturalInput';

/** Fixed reference date so relative words resolve deterministically. */
export const REFERENCE_DATE = new Date(2026, 8, 15); // 2026-09-15

export interface NaturalInputCase {
  input: string;
  /** Subset of NaturalParseResult fields that must match exactly. */
  expect: Partial<Pick<NaturalParseResult, 'type' | 'amount' | 'category' | 'memo' | 'dateKey'>>;
}

/** The spec's 10 cases, plus a few Korean-amount / category checks. */
export const NATURAL_INPUT_CASES: NaturalInputCase[] = [
  { input: '점심 김치찌개 9000', expect: { type: 'expense', amount: 9000, memo: '김치찌개' } },
  { input: '스타벅스 5500원', expect: { type: 'expense', amount: 5500, memo: '스타벅스' } },
  { input: '오늘 편의점 7800', expect: { type: 'expense', amount: 7800, memo: '편의점', dateKey: '2026-09-15' } },
  { input: '택시 12500', expect: { type: 'expense', amount: 12500, memo: '택시' } },
  { input: '마트 32000', expect: { type: 'expense', amount: 32000, memo: '마트' } },
  { input: '월급 320만원', expect: { type: 'income', amount: 3200000, memo: '월급' } },
  { input: '어제 저녁 치킨 24000', expect: { type: 'expense', amount: 24000, memo: '치킨', dateKey: '2026-09-14' } },
  { input: '9월 1일 점심 9000', expect: { type: 'expense', amount: 9000, dateKey: '2026-09-01' } },
  { input: '보너스 100만원', expect: { type: 'income', amount: 1000000 } },
  { input: '9000', expect: { amount: 9000 } },
  { input: '9천원 커피', expect: { amount: 9000, category: 'cafe' } },
  { input: '1만5천원 점심', expect: { amount: 15000 } },
  { input: '1.5만원 택시', expect: { amount: 15000, category: 'transit' } },
  { input: '3,200,000원 월세', expect: { amount: 3200000, category: 'housing' } },
  { input: '넷플릭스 13500', expect: { amount: 13500, category: 'subscribe' } },
  { input: '약국 4800', expect: { amount: 4800, category: 'health' } },
];

export interface CaseResult {
  input: string;
  pass: boolean;
  got: NaturalParseResult;
  failures: string[];
}

export function runNaturalInputCases(
  cases: NaturalInputCase[] = NATURAL_INPUT_CASES,
  ref: Date = REFERENCE_DATE,
): { results: CaseResult[]; passed: number; failed: number } {
  const results = cases.map((c) => {
    const got = parseNaturalInput(c.input, ref);
    const failures: string[] = [];
    for (const [k, want] of Object.entries(c.expect)) {
      const actual = (got as unknown as Record<string, unknown>)[k];
      if (actual !== want) failures.push(`${k}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
    }
    return { input: c.input, pass: failures.length === 0, got, failures };
  });
  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
