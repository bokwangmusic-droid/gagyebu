/**
 * Static verification for `categorySpendingRows` (src/lib/categorySpending.ts)
 * — HOME CATEGORY SPENDING DETAIL. Plain data + runner, same convention as
 * the other *.cases.ts files.
 */
import { categorySpendingRows } from '@/lib/categorySpending';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runCategorySpendingCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  const M = { food: 350_000, shop: 220_000, cafe: 90_000 };
  const total = 660_000;

  check(
    'CASE 1 rows are sorted by amount descending',
    (() => {
      const r = categorySpendingRows(M, total);
      return r.map((x) => x.id).join(',') === 'food,shop,cafe';
    })(),
  );

  check(
    'CASE 2 per-category amounts pass through unchanged',
    (() => {
      const r = categorySpendingRows(M, total);
      return r[0].amount === 350_000 && r[1].amount === 220_000 && r[2].amount === 90_000;
    })(),
  );

  check(
    'CASE 3 sharePct = rounded share of total',
    (() => {
      const r = categorySpendingRows(M, total);
      // 350000/660000 = 53.03 -> 53 ; 220000/660000 = 33.33 -> 33 ; 90000/660000 = 13.6 -> 14
      return r[0].sharePct === 53 && r[1].sharePct === 33 && r[2].sharePct === 14;
    })(),
  );

  check(
    'CASE 4 a 0-spend category is dropped',
    categorySpendingRows({ food: 1000, empty: 0 }, 1000).every((r) => r.id !== 'empty'),
  );

  check(
    'CASE 5 a negative amount is dropped (defensive)',
    categorySpendingRows({ food: 1000, weird: -50 }, 1000).every((r) => r.id !== 'weird'),
  );

  check(
    'CASE 6 total = 0 -> sharePct is 0, never NaN',
    (() => {
      const r = categorySpendingRows({ food: 1000 }, 0);
      return r.length === 1 && r[0].sharePct === 0 && !Number.isNaN(r[0].sharePct);
    })(),
  );

  check('CASE 7 empty map -> []', categorySpendingRows({}, 0).length === 0);
  check('CASE 7b empty map + non-zero total -> []', categorySpendingRows({}, 500).length === 0);

  check(
    'CASE 8 rounding: exact thirds -> 33 / 33 / 33',
    (() => {
      const r = categorySpendingRows({ a: 100, b: 100, c: 100 }, 300);
      return r.every((x) => x.sharePct === 33);
    })(),
  );

  check(
    'CASE 9 single category = 100%',
    categorySpendingRows({ solo: 12_345 }, 12_345)[0].sharePct === 100,
  );

  check(
    'CASE 10 a stable tie keeps both rows (no row dropped on equal amounts)',
    categorySpendingRows({ a: 500, b: 500 }, 1000).length === 2,
  );

  check(
    'CASE 11 user-defined category ids flow through untouched',
    (() => {
      const r = categorySpendingRows({ 'c-1a2b3c': 5000, food: 1000 }, 6000);
      return r[0].id === 'c-1a2b3c' && r[0].amount === 5000;
    })(),
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
