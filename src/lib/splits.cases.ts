/**
 * Dev verification for split-expense validation.
 *
 * Same rationale as `naturalInput.cases.ts`: no test framework is set up in
 * this project, so these are plain data + a runner. Nothing imports this file
 * in the app, so it is not bundled; `npx tsc --noEmit` still type-checks it,
 * so it catches signature drift. Run ad-hoc:
 *
 *   (transpile src/lib/{splits,format,aggregate}.ts + src/store/types.ts,
 *    then `node` a script that calls runSplitCases())
 */

import { expenseByCategory } from '@/lib/aggregate';
import {
  checkSplits,
  normalizeSplits,
  type SplitDraft,
  type SplitError,
} from '@/lib/splits';
import type { Transaction } from '@/store/types';

const d = (category: string, amount: string): SplitDraft => ({ category, amount });

export interface SplitCase {
  name: string;
  total: number;
  rows: SplitDraft[];
  expectOk: boolean;
  expectError?: SplitError;
}

export const SPLIT_CASES: SplitCase[] = [
  {
    name: '2개 · 합계 일치 (50000 = 30000 + 20000)',
    total: 50000,
    rows: [d('food', '30000'), d('shopping', '20000')],
    expectOk: true,
  },
  {
    name: '3개 · 합계 일치 (60000 = 20000 + 20000 + 20000)',
    total: 60000,
    rows: [d('food', '20000'), d('shopping', '20000'), d('transit', '20000')],
    expectOk: true,
  },
  {
    name: '합계 불일치 (50000 ≠ 30000 + 10000)',
    total: 50000,
    rows: [d('food', '30000'), d('shopping', '10000')],
    expectOk: false,
    expectError: 'sum-mismatch',
  },
  {
    name: '분할 1개뿐',
    total: 30000,
    rows: [d('food', '30000')],
    expectOk: false,
    expectError: 'too-few',
  },
  {
    name: '0원 분할 포함',
    total: 30000,
    rows: [d('food', '30000'), d('shopping', '0')],
    expectOk: false,
    expectError: 'nonpositive',
  },
  {
    name: '카테고리 미선택',
    total: 50000,
    rows: [d('food', '30000'), d('', '20000')],
    expectOk: false,
    expectError: 'missing-category',
  },
];

export interface SplitCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function runSplitCases(cases: SplitCase[] = SPLIT_CASES): {
  results: SplitCaseResult[];
  passed: number;
  failed: number;
} {
  const results = cases.map((c) => {
    const got = checkSplits(c.total, normalizeSplits(c.rows));
    const okMatch = got.ok === c.expectOk;
    const errMatch = c.expectOk ? true : got.error === c.expectError;
    const pass = okMatch && errMatch;
    return {
      name: c.name,
      pass,
      detail: pass
        ? `ok=${got.ok}${got.error ? ` error=${got.error}` : ''} sum=${got.sum}`
        : `got ok=${got.ok} error=${got.error ?? '-'}, want ok=${c.expectOk} error=${c.expectError ?? '-'}`,
    };
  });
  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}

/**
 * A split transaction must aggregate per-split but count its total only once.
 * 50,000 = 식비 30,000 + 쇼핑 20,000  ->  byCategory food=30k shopping=20k,
 * and no double counting of the 50,000.
 */
export function runSplitAggregationCheck(): {
  pass: boolean;
  detail: string;
} {
  const txns: Transaction[] = [
    {
      id: 't1',
      type: 'expense',
      category: 'food',
      amount: 50000,
      memo: '마트',
      date: new Date().toISOString(),
      splits: [
        { category: 'food', amount: 30000 },
        { category: 'shopping', amount: 20000 },
      ],
    },
    {
      id: 't2',
      type: 'expense',
      category: 'transit',
      amount: 8000,
      memo: '버스',
      date: new Date().toISOString(),
    },
  ];
  const by = expenseByCategory(txns);
  const pass =
    by.food === 30000 && by.shopping === 20000 && by.transit === 8000;
  return {
    pass,
    detail: `food=${by.food} shopping=${by.shopping} transit=${by.transit} (sum=${
      (by.food ?? 0) + (by.shopping ?? 0) + (by.transit ?? 0)
    }, expected 58000)`,
  };
}
