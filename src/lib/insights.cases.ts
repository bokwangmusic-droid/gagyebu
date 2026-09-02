/**
 * Dev verification for the rule-based insight engine.
 *
 * Same convention as `naturalInput.cases.ts` / `splits.cases.ts` /
 * `card.cases.ts`: no test framework, so plain data + a runner. Not bundled;
 * `npx tsc --noEmit` still type-checks it. Run ad-hoc: transpile
 * src/lib/{insights,aggregate,period,format}.ts + src/data/categories.ts +
 * src/store/types.ts, then `node` a script that calls runInsightCases().
 */

import { DEFAULT_CUSTOM_CATS } from '@/data/categories';
import { inRange } from '@/lib/aggregate';
import { monthRange } from '@/lib/period';
import {
  buildInsights,
  daysInMonth,
  monthProgress,
  monthToDateRange,
  pctChange,
  prevSameWindowRange,
  type Insight,
  type InsightKind,
} from '@/lib/insights';
import type { BudgetMap, Transaction } from '@/store/types';

const CATS = DEFAULT_CUSTOM_CATS;

/** Local reference "now": 2026-09-10 15:00 (September has 30 days). */
const NOW = new Date(2026, 8, 10, 15, 0, 0);

function txn(p: Partial<Transaction> & { amount: number; date: string }): Transaction {
  return {
    id: p.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    type: p.type ?? 'expense',
    category: p.category ?? 'food',
    amount: p.amount,
    memo: p.memo ?? '',
    date: p.date,
    splits: p.splits,
    paymentMethod: p.paymentMethod,
    cardId: p.cardId,
    installment: p.installment,
  };
}

/** expense txn on a given local day of a month (YYYY, M 1-based, D). */
function ex(y: number, m: number, d: number, amount: number, category = 'food'): Transaction {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return txn({ amount, category, date: `${y}-${mm}-${dd}T12:00:00` });
}

const has = (r: Insight[], k: InsightKind) => r.some((i) => i.kind === k);
const pick = (r: Insight[], k: InsightKind) => r.find((i) => i.kind === k);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

interface Case {
  name: string;
  run: () => { pass: boolean; detail: string };
}

export const INSIGHT_CASES: Case[] = [
  {
    name: '1. pctChange 증가/감소',
    run: () => {
      const a = pctChange(112, 100);
      const b = pctChange(90, 100);
      return { pass: a === 12 && b === -10, detail: `+12→${a}, -10→${b}` };
    },
  },
  {
    name: '2. pctChange prev=0 / 0,0 → null',
    run: () => {
      const a = pctChange(50, 0);
      const b = pctChange(0, 0);
      return { pass: a === null && b === null, detail: `(50,0)→${a}, (0,0)→${b}` };
    },
  },
  {
    name: '3. 지난달 같은 기간 범위 (9/10 → 8/1~8/11)',
    run: () => {
      const w = prevSameWindowRange(NOW);
      const ok = iso(w.start) === '2026-08-01' && iso(w.end) === '2026-08-11';
      return { pass: ok, detail: `${iso(w.start)} ~ ${iso(w.end)}` };
    },
  },
  {
    name: '4. 3/31 → 지난달 마지막날 clamp ([2/1, 3/1))',
    run: () => {
      const w = prevSameWindowRange(new Date(2026, 2, 31, 12));
      const ok = iso(w.start) === '2026-02-01' && iso(w.end) === '2026-03-01';
      return { pass: ok, detail: `${iso(w.start)} ~ ${iso(w.end)}` };
    },
  },
  {
    name: '5. 연말 경계 (1/10 → 전년 12/1~12/11)',
    run: () => {
      const w = prevSameWindowRange(new Date(2026, 0, 10, 12));
      const ok = iso(w.start) === '2025-12-01' && iso(w.end) === '2025-12-11';
      return { pass: ok, detail: `${iso(w.start)} ~ ${iso(w.end)}` };
    },
  },
  {
    name: '6. 미래 거래 제외 (이번달 창이 오늘까지)',
    run: () => {
      const w = monthToDateRange(NOW);
      const txns = [ex(2026, 9, 3, 10000), ex(2026, 9, 20, 999999), ex(2026, 10, 5, 888888)];
      const kept = inRange(txns, w.start, w.end);
      const ok =
        iso(w.start) === '2026-09-01' &&
        iso(w.end) === '2026-09-11' &&
        kept.length === 1 &&
        kept[0].amount === 10000;
      return { pass: ok, detail: `창 ${iso(w.start)}~${iso(w.end)}, 포함 ${kept.length}건` };
    },
  },
  {
    name: '7. top-category',
    run: () => {
      const r = buildInsights({
        transactions: [ex(2026, 9, 2, 200000, 'food'), ex(2026, 9, 3, 50000, 'transit')],
        budgets: {},
        customCats: CATS,
        now: NOW,
      });
      const tc = pick(r, 'top-category');
      const ok = !!tc && tc.category === 'food' && tc.body.includes('식비') && tc.body.includes('200,000') && tc.body.includes('80%');
      return { pass: ok, detail: tc ? tc.body : 'top-category 없음' };
    },
  },
  {
    name: '8. split-aware top-category (120,000 = 식비 70,000 + 쇼핑 50,000)',
    run: () => {
      const t = txn({
        amount: 120000,
        date: '2026-09-03T12:00:00',
        category: 'food',
        splits: [
          { category: 'food', amount: 70000 },
          { category: 'shopping', amount: 50000 },
        ],
      });
      const r = buildInsights({ transactions: [t], budgets: {}, customCats: CATS, now: NOW });
      const tc = pick(r, 'top-category');
      const ok = !!tc && tc.category === 'food' && tc.data?.amount === 70000 && tc.body.includes('58%');
      return { pass: ok, detail: tc ? `${tc.body} (amount=${tc.data?.amount})` : 'top-category 없음' };
    },
  },
  {
    name: '9. 전체 지출 증가 (Sep 112,000 vs Aug 100,000 → +12%)',
    run: () => {
      const txns = [
        ex(2026, 8, 4, 60000), ex(2026, 8, 8, 40000), // Aug 1-10 = 100,000
        ex(2026, 9, 3, 70000), ex(2026, 9, 7, 42000), // Sep 1-10 = 112,000
      ];
      const r = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const t = pick(r, 'total-up');
      const ok = !!t && t.data?.pct === 12 && t.body.includes('12%') && t.body.includes('많아요');
      return { pass: ok, detail: t ? t.body : 'total-up 없음' };
    },
  },
  {
    name: '10. 지난달 표본 < 50,000 → 전체 비교 숨김',
    run: () => {
      const txns = [ex(2026, 8, 4, 30000), ex(2026, 9, 3, 300000)];
      const r = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const ok = !has(r, 'total-up') && !has(r, 'total-down');
      return { pass: ok, detail: `kinds: ${r.map((i) => i.kind).join(',') || '(none)'}` };
    },
  },
  {
    name: '11. 카테고리 증가 (식비 100,000 → 128,000, +28%)',
    run: () => {
      const txns = [
        ex(2026, 8, 4, 100000, 'food'),
        ex(2026, 9, 3, 128000, 'food'),
      ];
      const r = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const c = pick(r, 'category-up');
      const ok = !!c && c.category === 'food' && c.data?.pct === 28 && c.data?.delta === 28000 && c.body.includes('+28,000원');
      return { pass: ok, detail: c ? c.title + ' / ' + c.body : 'category-up 없음' };
    },
  },
  {
    name: '12. 소액 카테고리 고배율 제외 (카페 1,000 → 3,000 = +200%)',
    run: () => {
      const txns = [
        ex(2026, 8, 4, 1000, 'cafe'),
        ex(2026, 9, 3, 3000, 'cafe'),
        ex(2026, 9, 5, 90000, 'food'), // keeps curExpense meaningful
      ];
      const r = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const c = pick(r, 'category-up');
      // no category-up at all (cafe filtered by 금액 하한; food has no prev)
      return { pass: !c, detail: c ? `잘못 노출: ${c.title}` : '카페 정상 제외' };
    },
  },
  {
    name: '13. 카테고리 감소 (쇼핑 200,000 → 120,000, −40%)',
    run: () => {
      const txns = [
        ex(2026, 8, 4, 200000, 'shopping'),
        ex(2026, 9, 3, 120000, 'shopping'),
      ];
      const r = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const c = pick(r, 'category-down');
      const ok = !!c && c.category === 'shopping' && c.data?.pct === -40 && c.body.includes('−80,000원');
      return { pass: ok, detail: c ? c.title + ' / ' + c.body : 'category-down 없음' };
    },
  },
  {
    name: '14. 예산 83% → budget-watch',
    run: () => {
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 83000, 'food')], budgets, customCats: CATS, now: NOW });
      const b = pick(r, 'budget-watch');
      const ok = !!b && b.data?.ratioPct === 83 && b.body.includes('83%');
      return { pass: ok, detail: b ? b.body : `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '15. 예산 92% → budget-danger',
    run: () => {
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 92000, 'food')], budgets, customCats: CATS, now: NOW });
      const b = pick(r, 'budget-danger');
      const ok = !!b && b.data?.ratioPct === 92 && b.body.includes('92%');
      return { pass: ok, detail: b ? b.body : `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '16. 예산 110% → budget-over (초과 10,000원)',
    run: () => {
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 110000, 'food')], budgets, customCats: CATS, now: NOW });
      const b = pick(r, 'budget-over');
      const ok = !!b && b.data?.over === 10000 && b.body.includes('10,000원 초과');
      return { pass: ok, detail: b ? b.body : `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '17. 소비 속도 fast (9/10, 예산 100,000, 지출 60,000)',
    run: () => {
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 60000, 'food')], budgets, customCats: CATS, now: NOW });
      const p = pick(r, 'pace-fast');
      const ok = !!p && p.data?.progressPct === 33 && p.data?.usedPct === 60;
      return { pass: ok, detail: p ? p.body : `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '18. 소비 속도 normal → 인사이트 없음',
    run: () => {
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 35000, 'food')], budgets, customCats: CATS, now: NOW });
      const ok = !has(r, 'pace-fast') && !has(r, 'pace-easy');
      return { pass: ok, detail: `kinds: ${r.map((i) => i.kind).join(',') || '(none)'}` };
    },
  },
  {
    name: '19. 소비 속도 easy (9/25, 예산 100,000, 지출 40,000)',
    run: () => {
      const now = new Date(2026, 8, 25, 12);
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 40000, 'food')], budgets, customCats: CATS, now });
      const p = pick(r, 'pace-easy');
      const ok = !!p && p.data?.progressPct === 83 && p.data?.usedPct === 40;
      return { pass: ok, detail: p ? p.body : `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '20. 월초(9/3) → 소비 속도 숨김',
    run: () => {
      const now = new Date(2026, 8, 3, 12);
      const budgets: BudgetMap = { food: 100000 };
      const r = buildInsights({ transactions: [ex(2026, 9, 1, 60000, 'food')], budgets, customCats: CATS, now });
      const ok = !has(r, 'pace-fast') && !has(r, 'pace-easy');
      return { pass: ok, detail: `kinds: ${r.map((i) => i.kind).join(',') || '(none)'}` };
    },
  },
  {
    name: '21. 거래 0건 → []',
    run: () => {
      const r = buildInsights({ transactions: [], budgets: {}, customCats: CATS, now: NOW });
      return { pass: r.length === 0, detail: `length=${r.length}` };
    },
  },
  {
    name: '22. 지난달 데이터 없음 → 비교 인사이트 없음, top-category는 있음',
    run: () => {
      const r = buildInsights({ transactions: [ex(2026, 9, 3, 90000, 'food')], budgets: {}, customCats: CATS, now: NOW });
      const ok =
        !has(r, 'total-up') && !has(r, 'total-down') &&
        !has(r, 'category-up') && !has(r, 'category-down') &&
        has(r, 'top-category');
      return { pass: ok, detail: `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '23. 예산 없음 → budget-* / pace-* 없음',
    run: () => {
      const txns = [ex(2026, 8, 4, 100000, 'food'), ex(2026, 9, 3, 150000, 'food')];
      const r = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const ok = !r.some((i) => i.kind.startsWith('budget-') || i.kind.startsWith('pace-'));
      return { pass: ok, detail: `kinds: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '24. 최대 3개 반환 + priority 오름차순',
    run: () => {
      const budgets: BudgetMap = { food: 100000, shopping: 100000 };
      const txns = [
        // last month
        ex(2026, 8, 4, 100000, 'shopping'),
        ex(2026, 8, 6, 60000, 'transit'),
        // this month — food over budget, shopping big drop, transit big rise, total up
        ex(2026, 9, 2, 130000, 'food'),
        ex(2026, 9, 3, 20000, 'shopping'),
        ex(2026, 9, 5, 120000, 'transit'),
      ];
      const r = buildInsights({ transactions: txns, budgets, customCats: CATS, now: NOW });
      const sorted = r.every((i, idx) => idx === 0 || r[idx - 1].priority <= i.priority);
      return { pass: r.length <= 3 && r.length > 0 && sorted, detail: `len=${r.length} [${r.map((i) => `${i.kind}#${i.priority}`).join(', ')}]` };
    },
  },
  {
    name: '25. 같은 카테고리 중복 제거 (식비 over + up + top → 1개)',
    run: () => {
      const budgets: BudgetMap = { food: 100000 };
      const txns = [ex(2026, 8, 4, 90000, 'food'), ex(2026, 9, 3, 130000, 'food')];
      const r = buildInsights({ transactions: txns, budgets, customCats: CATS, now: NOW });
      const foodRows = r.filter((i) => i.category === 'food');
      const ok = foodRows.length === 1 && foodRows[0].kind === 'budget-over';
      return { pass: ok, detail: `food rows: ${foodRows.map((i) => i.kind).join(',')} | all: ${r.map((i) => i.kind).join(',')}` };
    },
  },
  {
    name: '26. 카드 3개월 할부 거래 → 소비 인사이트는 구매액 전액 (120,000)',
    run: () => {
      const t = txn({
        amount: 120000,
        date: '2026-09-02T12:00:00',
        category: 'food',
        paymentMethod: 'credit',
        cardId: 'hyundai',
        installment: { months: 3 },
      });
      const r = buildInsights({ transactions: [t], budgets: {}, customCats: CATS, now: NOW });
      const tc = pick(r, 'top-category');
      const ok = !!tc && tc.data?.amount === 120000; // NOT 40,000
      return { pass: ok, detail: tc ? `식비 ${tc.data?.amount}원` : 'top-category 없음' };
    },
  },
  {
    name: '27. 다음달 거래는 이번 달 창(useMonthlyTotals와 동일 필터)에서 제외',
    run: () => {
      const r = monthRange(NOW);
      const txns = [ex(2026, 9, 5, 50000), ex(2026, 10, 5, 999999)];
      const thisMonth = inRange(txns, r.start, r.end);
      const bi = buildInsights({ transactions: txns, budgets: {}, customCats: CATS, now: NOW });
      const tc = pick(bi, 'top-category');
      const ok =
        thisMonth.length === 1 &&
        thisMonth[0].amount === 50000 &&
        iso(r.end) === '2026-10-01' &&
        !!tc && tc.data?.amount === 50000;
      return { pass: ok, detail: `monthRange end=${iso(r.end)}, 포함 ${thisMonth.length}건, top=${tc?.data?.amount}` };
    },
  },
  {
    name: '보조. daysInMonth / monthProgress',
    run: () => {
      const dim = daysInMonth(NOW); // Sep = 30
      const prog = Math.round(monthProgress(NOW) * 100); // 10/30 = 33
      const feb = daysInMonth(new Date(2026, 1, 15));
      return { pass: dim === 30 && prog === 33 && feb === 28, detail: `Sep일수=${dim}, 9/10 진행=${prog}%, Feb일수=${feb}` };
    },
  },
];

export interface InsightCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function runInsightCases(cases: Case[] = INSIGHT_CASES): {
  results: InsightCaseResult[];
  passed: number;
  failed: number;
} {
  const results = cases.map((c) => {
    try {
      const { pass, detail } = c.run();
      return { name: c.name, pass, detail };
    } catch (err) {
      return { name: c.name, pass: false, detail: `threw: ${String(err)}` };
    }
  });
  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
