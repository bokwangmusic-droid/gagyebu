/**
 * Dev verification for net-worth maths (전체자산/순자산 STEP 2).
 *
 * Same convention as loan.cases.ts / goal.cases.ts: no test framework is
 * set up, so these are plain data + a runner. Nothing imports this file in
 * the app, so it is not bundled; `npx tsc --noEmit` still type-checks it.
 *
 * Note on soft-delete (see netWorth.ts's header): `Asset`/`Loan` have no
 * `deletedAt` field at all, so there is no way to construct a "soft-deleted"
 * fixture here in the first place — that filtering already happened one
 * layer up (remoteFinanceMapping), by construction of the type. Every
 * fixture below is therefore implicitly "active"; there is no separate
 * case for it.
 */
import { calculateNetWorth, calculateTotalAssets, calculateTotalDebt, summarizeNetWorth } from '@/lib/netWorth';
import type { Asset, Loan } from '@/store/types';

export interface NetWorthCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function makeAsset(id: string, balance: number, type: Asset['type'] = 'cash'): Asset {
  return { id, name: id, type, balance, createdAt: '2026-01-01T00:00:00.000Z' };
}

function makeLoan(id: string, principal: number, paid: number): Loan {
  return {
    id,
    name: id,
    lender: '',
    principal,
    annualRate: 5,
    termMonths: 12,
    startDate: '2026-01-01',
    paymentDay: 1,
    repayType: 'amortizing',
    paid,
    payments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export function runNetWorthCases(): { results: NetWorthCaseResult[]; passed: number; failed: number } {
  const results: NetWorthCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const eq = (name: string, got: number, want: number) =>
    check(name, got === want, `got ${got}, want ${want}`);

  // 1. assets 없음 / loans 없음 -> 전부 0
  {
    const s = summarizeNetWorth([], []);
    check(
      '빈 배열 -> totalAssets/totalDebt/netWorth 전부 0',
      s.totalAssets === 0 && s.totalDebt === 0 && s.netWorth === 0,
      JSON.stringify(s),
    );
  }

  // 2. 자산 2개 합산
  eq(
    '자산 2개 합산',
    calculateTotalAssets([makeAsset('a1', 1_000_000, 'cash'), makeAsset('a2', 2_500_000, 'bank')]),
    3_500_000,
  );

  // 3. 대출 2개 remaining 합산 (완납 없음)
  eq(
    '대출 2개 remaining 합산',
    calculateTotalDebt([makeLoan('l1', 1_000_000, 200_000), makeLoan('l2', 500_000, 0)]),
    1_300_000, // (1,000,000-200,000) + (500,000-0)
  );

  // 4. 일부 완납 대출 포함 -> 완납분은 0으로 반영, 재구현 없이 viewLoan 재사용 확인
  eq(
    '완납 대출(paid===principal) -> remaining 0, 나머지만 집계',
    calculateTotalDebt([makeLoan('paid-off', 800_000, 800_000), makeLoan('active', 1_000_000, 400_000)]),
    600_000,
  );

  // 5. 순자산 양수
  {
    const net = calculateNetWorth(
      [makeAsset('a1', 5_000_000), makeAsset('a2', 3_000_000, 'investment')],
      [makeLoan('l1', 2_000_000, 1_000_000)],
    );
    eq('자산 8,000,000 - 부채 1,000,000 -> 순자산 7,000,000 (양수)', net, 7_000_000);
  }

  // 6. 순자산 음수
  {
    const net = calculateNetWorth(
      [makeAsset('a1', 500_000)],
      [makeLoan('l1', 3_000_000, 0)],
    );
    eq('자산 500,000 - 부채 3,000,000 -> 순자산 -2,500,000 (음수)', net, -2_500_000);
  }

  // 7. soft-delete: Asset/Loan 도메인 타입에 deletedAt이 없으므로, 이 레이어에
  //    들어오는 배열은 이미 "활성" 행만 담고 있다는 것이 타입으로 보장된다.
  //    별도 필터링 로직이 없어도 되는지 확인 — summarizeNetWorth가 입력을
  //    그대로 신뢰해 계산하는지만 재확인.
  {
    const s = summarizeNetWorth([makeAsset('a1', 100)], [makeLoan('l1', 100, 100)]);
    check(
      'deletedAt 없는 도메인 타입 -> 입력을 그대로 신뢰 (완납 대출도 remaining 0으로 정상 반영)',
      s.totalAssets === 100 && s.totalDebt === 0 && s.netWorth === 100,
      JSON.stringify(s),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
