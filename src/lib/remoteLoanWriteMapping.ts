/**
 * Local input draft -> `public.loans` INSERT / UPDATE row and
 * `public.loan_payments` INSERT row — STEP 16-G2-D4.
 *
 * The loan counterpart of src/lib/remoteGoalWriteMapping.ts. Pure
 * transform: no Supabase, no AsyncStorage, no React state. The one thing
 * that is NOT self-contained is the interest/principal split, which reuses
 * the existing src/lib/loan.ts `splitPayment()` — its semantics are
 * unchanged here.
 *
 * `public.loans` has a client-generated TEXT primary key `id` plus
 * `unique(household_id, id)`, so a 23505 on INSERT can ONLY be that exact
 * `(household_id, id)` already existing — a lost-response retry.
 *
 * ---- `loans` payloads deliberately NEVER carry (STEP 16-G2-D4 §2) ----
 *   - paid : a server-maintained cache. The `authenticated` UPDATE grant on
 *            `public.loans` does not even include `paid`; only
 *            `trg_apply_loan_payment()` (SECURITY DEFINER) can change it,
 *            fed by a `loan_payments` INSERT / soft-delete. A client that
 *            puts `paid` in a SET list is rejected at the column-privilege
 *            level.
 *   - created_by : server-forced by the INSERT trigger to auth.uid(), and
 *            frozen on UPDATE.
 *   - created_at / updated_at : server-managed.
 *   - deleted_at : soft-delete is its own service call.
 *   - id / household_id : on UPDATE they are `.eq(...)` filters and are
 *            trigger-locked.
 *
 * ---- `loan_payments` INSERT (STEP 16-G2-D4 §3/§8) ----
 * The user types ONLY a total `amount` and a `date`. `principal_part` /
 * `interest_part` are NOT user input — `buildLoanPaymentInsert` computes
 * them with `splitPayment(remaining, annualRate, amount)`, and the caller
 * MUST pass a `remaining` / `annualRate` taken from an AUTHORITATIVE
 * re-SELECT of the loan done immediately before the INSERT, never a
 * possibly-stale UI/domain value. `memo` is omitted this STEP.
 * `created_by` is trigger-forced. The payment `id` is client-generated
 * (`lp-...`) and MUST be stable across save retries — a fresh id would let
 * `trg_apply_loan_payment` move `loans.paid` twice.
 */
import { splitPayment } from '@/lib/loan';
import { isValidDateKey } from '@/lib/remotePlannedWriteMapping';
import type { LoanRepayType } from '@/store/types';

/* ================================================================== *
 * loans — CREATE / UPDATE
 * ================================================================== */

/**
 * What the loan form produces. Purely the user-editable shape — carries no
 * id, no household id, no `paid`, no ownership/identity/timestamp field.
 */
export interface NewLoanDraft {
  name: string;
  /** Lender name; empty string allowed. */
  lender: string;
  /** Won, positive integer. */
  principal: number;
  /** Annual interest rate in percent; >= 0, DECIMAL allowed (e.g. 4.25). */
  annualRate: number;
  termMonths: number;
  /** Local YYYY-MM-DD (첫 상환일). */
  startDate: string;
  /** 매월 상환일, integer 1..31. */
  paymentDay: number;
  repayType: LoanRepayType;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * Client-side guard — never lean on the DB CHECK / NOT-NULL for UX
 * (STEP 16-G2-D4 §2). Shared by CREATE and UPDATE. NOTE: this does NOT
 * check `principal >= paid` — that needs the authoritative loan and lives
 * in the service (§6).
 */
export function isValidLoanDraft(draft: NewLoanDraft): boolean {
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) return false;
  if (typeof draft.lender !== 'string') return false;
  if (!isInt(draft.principal) || draft.principal <= 0) return false;
  if (typeof draft.annualRate !== 'number' || !Number.isFinite(draft.annualRate) || draft.annualRate < 0) {
    return false;
  }
  if (!isInt(draft.termMonths) || draft.termMonths <= 0) return false;
  if (typeof draft.startDate !== 'string' || !isValidDateKey(draft.startDate)) return false;
  if (!isInt(draft.paymentDay) || draft.paymentDay < 1 || draft.paymentDay > 31) return false;
  if (
    draft.repayType !== 'amortizing' &&
    draft.repayType !== 'equal_principal' &&
    draft.repayType !== 'bullet'
  ) {
    return false;
  }
  return true;
}

export interface BuildLoanInsertContext {
  /** Client-generated `loan-...` id (src/lib/id.ts), fixed for one form mount. */
  id: string;
  /** The CURRENT trusted active household id. */
  householdId: string;
}

/** The exact column set sent to `public.loans` on INSERT. `paid` is NOT
 *  here — the DB default (0) applies. */
export interface LoanInsertRow {
  id: string;
  household_id: string;
  name: string;
  lender: string;
  principal: number;
  annual_rate: number;
  term_months: number;
  start_date: string;
  payment_day: number;
  repay_type: LoanRepayType;
}

export function buildLoanInsert(draft: NewLoanDraft, ctx: BuildLoanInsertContext): LoanInsertRow {
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    name: draft.name.trim(),
    lender: draft.lender.trim(),
    principal: draft.principal,
    annual_rate: draft.annualRate,
    term_months: draft.termMonths,
    start_date: draft.startDate,
    payment_day: draft.paymentDay,
    repay_type: draft.repayType,
  };
}

/**
 * The PATCH body for an existing loan. ONLY the user-editable fields —
 * NEVER `paid`, `id`, `household_id`, or any server/identity column.
 */
export interface LoanUpdateRow {
  name: string;
  lender: string;
  principal: number;
  annual_rate: number;
  term_months: number;
  start_date: string;
  payment_day: number;
  repay_type: LoanRepayType;
}

export function buildLoanUpdate(draft: NewLoanDraft): LoanUpdateRow {
  return {
    name: draft.name.trim(),
    lender: draft.lender.trim(),
    principal: draft.principal,
    annual_rate: draft.annualRate,
    term_months: draft.termMonths,
    start_date: draft.startDate,
    payment_day: draft.paymentDay,
    repay_type: draft.repayType,
  };
}

/* ================================================================== *
 * loan_payments — repayment INSERT
 * ================================================================== */

/**
 * What the repayment sheet produces. The user types ONLY these two — the
 * principal/interest split is derived, never entered.
 */
export interface NewLoanPaymentDraft {
  /** Local YYYY-MM-DD (상환일). */
  date: string;
  /** Won, positive integer — the TOTAL paid this time. */
  amount: number;
}

/** Client-side guard — 0 / non-integer / negative amounts and bad dates are
 *  blocked here so the DB CHECKs are never the first line of UX. */
export function isValidLoanPaymentDraft(draft: NewLoanPaymentDraft): boolean {
  if (typeof draft.date !== 'string' || !isValidDateKey(draft.date)) return false;
  if (!isInt(draft.amount) || draft.amount <= 0) return false;
  return true;
}

export interface BuildLoanPaymentInsertContext {
  /** Client-generated `lp-...` id, STABLE across every save retry of one sheet. */
  id: string;
  householdId: string;
  loanId: string;
  /**
   * `principal - paid` taken from an AUTHORITATIVE re-SELECT of the loan
   * done immediately before this INSERT (STEP 16-G2-D4 §3/§8-2). NEVER a
   * UI/domain value.
   */
  remaining: number;
  /** `annual_rate` from the SAME authoritative re-SELECT — never the UI value. */
  annualRate: number;
}

/** The exact column set sent to `public.loan_payments` on INSERT.
 *  `memo` is omitted this STEP; `created_by` is trigger-forced. */
export interface LoanPaymentInsertRow {
  id: string;
  household_id: string;
  loan_id: string;
  date: string;
  amount: number;
  principal_part: number;
  interest_part: number;
}

export function buildLoanPaymentInsert(
  draft: NewLoanPaymentDraft,
  ctx: BuildLoanPaymentInsertContext,
): LoanPaymentInsertRow {
  // splitPayment() is used verbatim — its semantics are NOT changed here.
  // It already guarantees: interestPart >= 0, principalPart >= 0,
  // principalPart <= remaining, principalPart + interestPart <= amount.
  const { interestPart, principalPart } = splitPayment(ctx.remaining, ctx.annualRate, draft.amount);
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    loan_id: ctx.loanId,
    date: draft.date,
    amount: draft.amount,
    principal_part: principalPart,
    interest_part: interestPart,
  };
}
