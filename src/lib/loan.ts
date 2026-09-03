/**
 * Loan maths — pure, no store/UI imports.
 *
 * Supports two Korean repayment styles:
 *  - 'amortizing' (원리금균등상환): equal total payment every month
 *  - 'bullet'     (만기일시상환): interest only each month, principal at maturity
 */

import type { Loan, LoanRepayType } from '@/store/types';

export const monthlyRateOf = (annualRatePct: number) => annualRatePct / 100 / 12;

/** Scheduled monthly payment for the whole loan. */
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
  if (r === 0) return Math.round(principal / termMonths);
  const f = Math.pow(1 + r, termMonths);
  return Math.round((principal * r * f) / (f - 1));
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
  return t === 'bullet' ? '만기일시상환' : '원리금균등상환';
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
