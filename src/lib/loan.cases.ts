/**
 * Dev verification for the loan maths (STEP 16-G2-D4.1 — 원금균등상환 added).
 *
 * Same convention as goal.cases.ts / recurring.cases.ts: no test framework
 * is set up, so these are plain data + a runner. Nothing imports this file
 * in the app, so it is not bundled; `npx tsc --noEmit` still type-checks
 * it.
 *
 * Covers `scheduledPayment` / `equalPrincipalSlice` / `splitPayment` for
 * all three repay styles, with an emphasis on the new `equal_principal`
 * schedule and the repayType-agnostic split invariants.
 */
import {
  equalPrincipalSlice,
  scheduledPayment,
  splitPayment,
} from '@/lib/loan';

export interface LoanCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export function runLoanCases(): { results: LoanCaseResult[]; passed: number; failed: number } {
  const results: LoanCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const eq = (name: string, got: number, want: number) =>
    check(name, got === want, `got ${got}, want ${want}`);

  /* ---- amortizing / bullet unchanged ---- */
  // 원리금균등: 1,200,000 @ 12%/yr, 12mo -> classic annuity ~106,619/mo.
  // (tolerant: the annuity formula is unchanged; guard against float drift.)
  {
    const got = scheduledPayment(1_200_000, 12, 12, 'amortizing');
    check('amortizing · 1.2M @12% 12mo ~= 106,619 fixed monthly', Math.abs(got - 106_619) <= 2, `got ${got}`);
  }
  // 원리금균등, r = 0 -> principal / term.
  eq('amortizing · r=0 -> principal/term', scheduledPayment(1_200_000, 0, 12, 'amortizing'), 100_000);
  // 만기일시: interest only.
  eq('bullet · monthly = interest only', scheduledPayment(1_200_000, 12, 12, 'bullet'), 12_000);

  /* ---- equal_principal · scheduledPayment (STEP 16-G2-D4.1 §9.1/§9.4/§9.5) ---- */
  // §9.1: 1,200,000 / 12 = 100,000 principal + first-month interest 12,000 = 112,000.
  eq('equal_principal · 1.2M @12% 12mo -> first-month total', scheduledPayment(1_200_000, 12, 12, 'equal_principal'), 112_000);
  eq('equal_principal · fixed principal slice = principal/term', equalPrincipalSlice(1_200_000, 12, 'equal_principal'), 100_000);
  // §9.4: annualRate 0 -> only the principal slice.
  eq('equal_principal · r=0 -> first-month total = principal slice', scheduledPayment(1_200_000, 0, 12, 'equal_principal'), 100_000);
  // §9.5: termMonths 1 -> whole principal + first-month interest.
  eq('equal_principal · term=1 -> principal + first interest', scheduledPayment(1_200_000, 12, 1, 'equal_principal'), 1_212_000);
  eq('equalPrincipalSlice · non-equal_principal type -> 0', equalPrincipalSlice(1_200_000, 12, 'amortizing'), 0);
  eq('equalPrincipalSlice · term 0 -> 0', equalPrincipalSlice(1_200_000, 0, 'equal_principal'), 0);

  /* ---- equal_principal · splitPayment on the running balance ---- */
  // The user enters the schedule total; split = interest on balance, rest to principal.
  {
    // §9.1 month 1: remaining 1,200,000, pay 112,000 -> interest 12,000 / principal 100,000.
    const s = splitPayment(1_200_000, 12, 112_000);
    check('equal_principal · month 1 split 12,000 / 100,000', s.interestPart === 12_000 && s.principalPart === 100_000, `${s.interestPart}/${s.principalPart}`);
  }
  {
    // §9.2 month 2: remaining 1,100,000, pay 111,000 -> interest 11,000 / principal 100,000.
    const s = splitPayment(1_100_000, 12, 111_000);
    check('equal_principal · month 2 split 11,000 / 100,000', s.interestPart === 11_000 && s.principalPart === 100_000, `${s.interestPart}/${s.principalPart}`);
  }
  {
    // §9.3 last month: remaining 50,000 < the regular 100,000 slice. Pay the
    // "regular" total 100,000 + interest 500 -> principal clamps to 50,000.
    const s = splitPayment(50_000, 12, 100_500);
    check('equal_principal · last month principal clamped to remaining', s.principalPart === 50_000 && s.principalPart <= 50_000 && s.interestPart === 500, `${s.interestPart}/${s.principalPart}`);
  }
  {
    // §9.6 no over-repayment: even a huge amount can't push principal past remaining.
    const s = splitPayment(30_000, 12, 10_000_000);
    check('equal_principal · over-payment: principal never exceeds remaining', s.principalPart === 30_000 && s.principalPart + s.interestPart <= 10_000_000, `${s.interestPart}/${s.principalPart}`);
  }
  {
    // §9.4 r=0: no interest, all principal (clamped).
    const s = splitPayment(1_200_000, 0, 100_000);
    check('equal_principal · r=0 split -> 0 interest / 100,000 principal', s.interestPart === 0 && s.principalPart === 100_000, `${s.interestPart}/${s.principalPart}`);
  }

  /* ---- split invariants across a spread (repayType-agnostic) ---- */
  {
    let ok = true;
    for (const [rem, rate, amt] of [
      [1_200_000, 12, 112_000],
      [1_100_000, 12, 111_000],
      [50_000, 12, 100_500],
      [1, 12, 1],
      [123_456, 4.25, 9_999],
      [30_000, 0, 5_000],
    ] as [number, number, number][]) {
      const s = splitPayment(rem, rate, amt);
      if (
        s.principalPart < 0 ||
        s.interestPart < 0 ||
        s.principalPart > rem ||
        s.principalPart + s.interestPart > amt
      ) {
        ok = false;
      }
    }
    check('split invariants: parts >= 0, principal <= remaining, sum <= amount', ok);
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
