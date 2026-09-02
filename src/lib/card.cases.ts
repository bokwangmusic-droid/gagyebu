/**
 * Dev verification for credit-card & instalment maths.
 *
 * Same rationale as `naturalInput.cases.ts` / `splits.cases.ts`: no test
 * framework is set up, so this is plain data + a runner. Nothing imports it
 * in the app, so it is not bundled; `npx tsc --noEmit` still type-checks it.
 * Run ad-hoc: transpile src/lib/{card,aggregate}.ts + src/store/types.ts,
 * then `node` a script that calls runCardCases().
 */

import { expenseByCategory } from '@/lib/aggregate';
import {
  cardBillingForMonth,
  chargeForMonth,
  installmentPerMonth,
  installmentPlan,
  monthIndex,
  UNASSIGNED_CARD_ID,
} from '@/lib/card';
import type { CreditCard, Transaction } from '@/store/types';

/* --- fixtures ---------------------------------------------------------- */

const CARDS: CreditCard[] = [
  { id: 'hyundai', name: '현대카드', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'samsung', name: '삼성카드', createdAt: '2026-01-01T00:00:00.000Z' },
];

function txn(p: Partial<Transaction> & { amount: number; date: string }): Transaction {
  return {
    id: p.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
    type: p.type ?? 'expense',
    category: p.category ?? 'food',
    amount: p.amount,
    memo: p.memo ?? '',
    date: p.date,
    paymentMethod: p.paymentMethod,
    cardId: p.cardId,
    installment: p.installment,
    splits: p.splits,
  };
}

const mi = (isoMonth: string) => monthIndex(`${isoMonth}-01T00:00:00`);

/* --- cases ----------------------------------------------------------- */

export interface CardCase {
  name: string;
  run: () => { pass: boolean; detail: string };
}

export const CARD_CASES: CardCase[] = [
  {
    name: '1. 일시불 — 구매 당월 전액 청구',
    run: () => {
      const t = txn({ amount: 50000, date: '2026-03-10T09:00:00', paymentMethod: 'credit', cardId: 'hyundai' });
      const got = chargeForMonth(t, mi('2026-03'));
      return { pass: got === 50000, detail: `당월 청구=${got} (기대 50000)` };
    },
  },
  {
    name: '2. 일시불 — 다음 달 0원',
    run: () => {
      const t = txn({ amount: 50000, date: '2026-03-10T09:00:00', paymentMethod: 'credit', cardId: 'hyundai' });
      const got = chargeForMonth(t, mi('2026-04'));
      return { pass: got === 0, detail: `익월 청구=${got} (기대 0)` };
    },
  },
  {
    name: '3. 120,000 / 3개월 = 40,000 × 3',
    run: () => {
      const { perMonth, lastMonth } = installmentPerMonth(120000, 3);
      const ok = perMonth === 40000 && lastMonth === 40000;
      return { pass: ok, detail: `perMonth=${perMonth} last=${lastMonth}` };
    },
  },
  {
    name: '4. 100,000 / 3개월 = 33,333 + 33,333 + 33,334',
    run: () => {
      const { perMonth, lastMonth } = installmentPerMonth(100000, 3);
      const ok = perMonth === 33333 && lastMonth === 33334;
      return { pass: ok, detail: `${perMonth} + ${perMonth} + ${lastMonth}` };
    },
  },
  {
    name: '5. 모든 회차 합계 === 원 거래 금액',
    run: () => {
      const trials: [number, number][] = [
        [120000, 3], [100000, 3], [100001, 7], [999999, 12], [55555, 6], [10, 4],
      ];
      const bad = trials.filter(([amt, n]) => {
        const { perMonth, lastMonth } = installmentPerMonth(amt, n);
        return perMonth * (n - 1) + lastMonth !== amt;
      });
      return { pass: bad.length === 0, detail: bad.length ? `불일치: ${JSON.stringify(bad)}` : `${trials.length}종 모두 합계 일치` };
    },
  },
  {
    name: '6. 300,000 / 3개월, 1회차 경과 → 남은 회차 2',
    run: () => {
      const t = txn({ amount: 300000, date: '2026-01-15T09:00:00', paymentMethod: 'credit', cardId: 'hyundai', installment: { months: 3 } });
      const plan = installmentPlan(t, new Date('2026-01-20T00:00:00'));
      const ok = plan.billedCount === 1 && plan.remainingCount === 2;
      return { pass: ok, detail: `billed=${plan.billedCount} remaining=${plan.remainingCount}` };
    },
  },
  {
    name: '7. 300,000 / 3개월, 1회차 경과 → 남은 금액 200,000',
    run: () => {
      const t = txn({ amount: 300000, date: '2026-01-15T09:00:00', paymentMethod: 'credit', cardId: 'hyundai', installment: { months: 3 } });
      const plan = installmentPlan(t, new Date('2026-01-20T00:00:00'));
      const ok = plan.billedAmount === 100000 && plan.remainingAmount === 200000;
      return { pass: ok, detail: `billed=${plan.billedAmount} remaining=${plan.remainingAmount}` };
    },
  },
  {
    name: '8. 12월 구매 3개월 → 12월 / 1월 / 2월, 3월 0원 (연말 경계)',
    run: () => {
      const t = txn({ amount: 300000, date: '2026-12-20T09:00:00', paymentMethod: 'credit', cardId: 'hyundai', installment: { months: 3 } });
      const dec = chargeForMonth(t, mi('2026-12'));
      const jan = chargeForMonth(t, mi('2027-01'));
      const feb = chargeForMonth(t, mi('2027-02'));
      const mar = chargeForMonth(t, mi('2027-03'));
      const ok = dec === 100000 && jan === 100000 && feb === 100000 && mar === 0;
      return { pass: ok, detail: `12월=${dec} 1월=${jan} 2월=${feb} 3월=${mar}` };
    },
  },
  {
    name: '9. 카드별 청구 합계 (현대 일시불 + 삼성 할부)',
    run: () => {
      const txns = [
        txn({ amount: 50000, date: '2026-05-03T09:00:00', paymentMethod: 'credit', cardId: 'hyundai' }),
        txn({ amount: 30000, date: '2026-05-09T09:00:00', paymentMethod: 'credit', cardId: 'hyundai' }),
        txn({ amount: 120000, date: '2026-05-01T09:00:00', paymentMethod: 'credit', cardId: 'samsung', installment: { months: 3 } }),
        txn({ amount: 9000, date: '2026-05-02T09:00:00', paymentMethod: 'cash' }), // ignored
      ];
      const b = cardBillingForMonth(txns, CARDS, new Date('2026-05-15T00:00:00'));
      const ok = b.byCard.hyundai === 80000 && b.byCard.samsung === 40000 && b.unassigned === 0 && b.total === 120000;
      return { pass: ok, detail: `현대=${b.byCard.hyundai} 삼성=${b.byCard.samsung} 미지정=${b.unassigned} 합계=${b.total}` };
    },
  },
  {
    name: '10. 카드 미지정 신용거래 → unassigned 버킷',
    run: () => {
      const txns = [txn({ amount: 25000, date: '2026-05-04T09:00:00', paymentMethod: 'credit' })];
      const b = cardBillingForMonth(txns, CARDS, new Date('2026-05-15T00:00:00'));
      const ok = b.unassigned === 25000 && b.total === 25000 && Object.keys(b.byCard).length === 0;
      return { pass: ok, detail: `unassigned=${b.unassigned} total=${b.total} byCardKeys=${Object.keys(b.byCard).length}` };
    },
  },
  {
    name: '11. 분할 지출 + 할부 — 총액 중복 없음, 서로 간섭 없음',
    run: () => {
      const t = txn({
        amount: 120000,
        date: '2026-06-01T09:00:00',
        category: 'food',
        paymentMethod: 'credit',
        cardId: 'hyundai',
        installment: { months: 3 },
        splits: [
          { category: 'food', amount: 70000 },
          { category: 'household', amount: 50000 },
        ],
      });
      const by = expenseByCategory([t]);
      const catSum = (by.food ?? 0) + (by.household ?? 0);
      const monthly = [0, 1, 2].map((k) => chargeForMonth(t, mi('2026-06') + k));
      const monthlySum = monthly.reduce((s, v) => s + v, 0);
      const ok =
        by.food === 70000 &&
        by.household === 50000 &&
        catSum === 120000 &&
        monthlySum === 120000 &&
        monthly.every((v) => v === 40000);
      return {
        pass: ok,
        detail: `카테고리합=${catSum} (식비 ${by.food}/생활 ${by.household}), 월청구=${monthly.join('+')}=${monthlySum}`,
      };
    },
  },
  {
    name: '12. 삭제된 cardId 거래 — 사라지지 않고 미지정 처리',
    run: () => {
      const txns = [
        txn({ amount: 40000, date: '2026-07-05T09:00:00', paymentMethod: 'credit', cardId: 'ghost-card' }),
        txn({ amount: 10000, date: '2026-07-06T09:00:00', paymentMethod: 'credit', cardId: 'hyundai' }),
      ];
      const b = cardBillingForMonth(txns, CARDS, new Date('2026-07-20T00:00:00'));
      const ok =
        b.byCard['ghost-card'] === undefined &&
        b.unassigned === 40000 &&
        b.byCard.hyundai === 10000 &&
        b.total === 50000;
      return { pass: ok, detail: `ghost=${b.byCard['ghost-card']} unassigned=${b.unassigned} 현대=${b.byCard.hyundai} total=${b.total}` };
    },
  },
  {
    name: '13. 방어 — installment.months = NaN → 유한값 (일시불 취급)',
    run: () => {
      const t = txn({
        amount: 90000,
        date: '2026-04-10T09:00:00',
        paymentMethod: 'credit',
        cardId: 'hyundai',
        installment: { months: NaN },
      });
      const cur = chargeForMonth(t, mi('2026-04'));
      const next = chargeForMonth(t, mi('2026-05'));
      const sch = installmentPerMonth(t.amount, NaN);
      const plan = installmentPlan(t, new Date('2026-04-20T00:00:00'));
      const fin = (x: number) => Number.isFinite(x);
      const ok =
        cur === 90000 &&
        next === 0 &&
        fin(sch.perMonth) && fin(sch.lastMonth) &&
        fin(plan.remainingCount) && fin(plan.remainingAmount) && fin(plan.billedCount);
      return {
        pass: ok,
        detail: `당월=${cur} 익월=${next} sch=(${sch.perMonth},${sch.lastMonth}) plan.remain=(${plan.remainingCount}회, ${plan.remainingAmount}원)`,
      };
    },
  },
  {
    name: '14. 방어 — installment.months = Infinity → 유한값',
    run: () => {
      const t = txn({
        amount: 90000,
        date: '2026-04-10T09:00:00',
        paymentMethod: 'credit',
        cardId: 'hyundai',
        installment: { months: Infinity },
      });
      const cur = chargeForMonth(t, mi('2026-04'));
      const next = chargeForMonth(t, mi('2026-05'));
      const sch = installmentPerMonth(t.amount, Infinity);
      const plan = installmentPlan(t, new Date('2026-04-20T00:00:00'));
      const fin = (x: number) => Number.isFinite(x);
      const ok =
        cur === 90000 &&
        next === 0 &&
        fin(sch.perMonth) && fin(sch.lastMonth) &&
        fin(plan.remainingCount) && fin(plan.remainingAmount) && fin(plan.billedCount);
      return {
        pass: ok,
        detail: `당월=${cur} 익월=${next} sch=(${sch.perMonth},${sch.lastMonth}) plan.remain=(${plan.remainingCount}회, ${plan.remainingAmount}원)`,
      };
    },
  },
  {
    name: '15. 방어 — months = 0 / 음수 / 문자열 → 유한값 (일시불 취급)',
    run: () => {
      const fin = (x: number) => Number.isFinite(x);
      const bad: { months: number }[] = [
        { months: 0 },
        { months: -3 },
        { months: 'abc' as unknown as number },
        { months: 2.7 }, // 정수화 → 2, 유한
      ];
      const rows = bad.map((installment, idx) => {
        const t = txn({
          amount: 60000,
          date: '2026-08-01T09:00:00',
          paymentMethod: 'credit',
          cardId: 'hyundai',
          installment,
        });
        const cur = chargeForMonth(t, mi('2026-08'));
        const plan = installmentPlan(t, new Date('2026-08-10T00:00:00'));
        return { idx, cur, ok: fin(cur) && fin(plan.remainingCount) && fin(plan.remainingAmount) };
      });
      const ok = rows.every((r) => r.ok);
      return { pass: ok, detail: rows.map((r) => `#${r.idx}:cur=${r.cur}`).join(' ') };
    },
  },
];

export interface CardCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function runCardCases(cases: CardCase[] = CARD_CASES): {
  results: CardCaseResult[];
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

// Referenced so `UNASSIGNED_CARD_ID` import is not flagged unused by strict TS.
export const _sentinel = UNASSIGNED_CARD_ID;
