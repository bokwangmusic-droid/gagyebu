/**
 * Loan maths — pure, no store/UI imports.
 *
 * Supports three Korean repayment styles:
 *  - 'amortizing'      (원리금균등상환): equal TOTAL payment every month
 *  - 'equal_principal' (원금균등상환): equal PRINCIPAL slice every month
 *                       (principal / termMonths) + interest on the current
 *                       balance, so the total payment DECREASES each month
 *  - 'bullet'          (만기일시상환): interest only each month, principal at maturity
 *
 * `splitPayment` is deliberately repayType-agnostic: the product lets the
 * user enter whatever TOTAL they actually paid, and every style splits it
 * "interest on the balance first, the rest to principal (clamped to the
 * remaining balance)". `repayType` only shapes the PROJECTED / displayed
 * monthly payment via `scheduledPayment`.
 */

import type { Loan, LoanRepayType } from '@/store/types';

export const monthlyRateOf = (annualRatePct: number) => annualRatePct / 100 / 12;

/**
 * Projected monthly payment.
 *  - amortizing      -> the fixed monthly total for the whole term
 *  - equal_principal -> the FIRST month's total (fixed principal slice +
 *                       first-month interest); later months are smaller
 *  - bullet          -> the monthly interest (principal repaid at maturity)
 */
export function scheduledPayment(
  principal: number,
  annualRatePct: number,
  termMonths: number,
  repayType: LoanRepayType,
): number {
  const r = monthlyRateOf(annualRatePct);
  if (principal <= 0) return 0;
  if (repayType === 'bullet') return Math.round(principal * r);
  if (termMonths <= 0) return 0;
  if (repayType === 'equal_principal') {
    // Fixed principal slice + interest on the full balance (first month).
    return Math.round(principal / termMonths) + Math.round(principal * r);
  }
  if (r === 0) return Math.round(principal / termMonths);
  const f = Math.pow(1 + r, termMonths);
  return Math.round((principal * r * f) / (f - 1));
}

/** Fixed monthly PRINCIPAL slice for an 원금균등 loan (0 for other styles). */
export function equalPrincipalSlice(
  principal: number,
  termMonths: number,
  repayType: LoanRepayType,
): number {
  if (repayType !== 'equal_principal' || principal <= 0 || termMonths <= 0) return 0;
  return Math.round(principal / termMonths);
}

/** Split one payment into interest (on the current balance) + principal. */
export function splitPayment(
  remaining: number,
  annualRatePct: number,
  amount: number,
): { interestPart: number; principalPart: number } {
  const r = monthlyRateOf(annualRatePct);
  const interestPart = Math.max(0, Math.min(amount, Math.round(remaining * r)));
  const principalPart = Math.max(0, Math.min(remaining, amount - interestPart));
  return { interestPart, principalPart };
}

/**
 * Scheduled payoff date = startDate + termMonths. Uses the `Date(year, month,
 * day)` constructor (which normalises month overflow) plus a last-day clamp,
 * so a loan that starts on the 31st doesn't roll its estimated payoff into the
 * wrong month via `setMonth`.
 */
export function payoffDate(startDate: string, termMonths: number): Date {
  const d = new Date(`${startDate}T00:00:00`);
  const year = d.getFullYear();
  const month = d.getMonth() + termMonths;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(d.getDate(), lastDay));
}

/** "2029.03" */
export function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function describeRepayType(t: LoanRepayType): string {
  if (t === 'bullet') return '만기일시상환';
  if (t === 'equal_principal') return '원금균등상환';
  return '원리금균등상환';
}

export interface LoanView {
  remaining: number; // 남은 원금
  progress: number; // 0–1, 상환한 원금 비율
  scheduled: number; // 예정 월 상환액
  interestPaid: number; // 누적 이자
  principalPaid: number; // 누적 상환 원금
  paidCount: number;
  payoff: Date; // 예정 만기일
  done: boolean;
}

export function viewLoan(loan: Loan): LoanView {
  const remaining = Math.max(0, loan.principal - loan.paid);
  const interestPaid = loan.payments.reduce((s, p) => s + p.interestPart, 0);
  return {
    remaining,
    progress: loan.principal > 0 ? Math.min(1, loan.paid / loan.principal) : 0,
    scheduled: scheduledPayment(
      loan.principal,
      loan.annualRate,
      loan.termMonths,
      loan.repayType,
    ),
    interestPaid,
    principalPaid: loan.paid,
    paidCount: loan.payments.length,
    payoff: payoffDate(loan.startDate, loan.termMonths),
    done: remaining <= 0,
  };
}
