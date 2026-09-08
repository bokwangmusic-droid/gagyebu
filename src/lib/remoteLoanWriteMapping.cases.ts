/**
 * Dev verification for the loan INSERT/UPDATE-row mappers, the
 * loan_payments INSERT mapper (incl. the reused splitPayment split) and
 * both draft validators (STEP 16-G2-D4).
 *
 * Same convention as remoteGoalWriteMapping.cases.ts: no test framework in
 * this project, so these are plain data + a runner. Nothing imports this
 * file (not bundled); `tsc --noEmit` still type-checks it. No Supabase
 * call — only the pure transforms.
 */
import {
  buildLoanInsert,
  buildLoanPaymentInsert,
  buildLoanUpdate,
  isValidLoanDraft,
  isValidLoanPaymentDraft,
  type LoanInsertRow,
  type LoanPaymentInsertRow,
  type NewLoanDraft,
} from '@/lib/remoteLoanWriteMapping';

const HID = 'hh-1111';
const LID = 'loan-1700000000000-abc123';
const PID = 'lp-1700000000000-def456';

const LOAN_INSERT_ALLOWED_KEYS: (keyof LoanInsertRow)[] = [
  'id',
  'household_id',
  'name',
  'lender',
  'principal',
  'annual_rate',
  'term_months',
  'start_date',
  'payment_day',
  'repay_type',
];
const LOAN_INSERT_FORBIDDEN_KEYS = ['paid', 'created_by', 'created_at', 'updated_at', 'deleted_at'];
const LOAN_UPDATE_ALLOWED_KEYS = [
  'name',
  'lender',
  'principal',
  'annual_rate',
  'term_months',
  'start_date',
  'payment_day',
  'repay_type',
];
const LOAN_UPDATE_FORBIDDEN_KEYS = [
  'id',
  'household_id',
  'paid',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
];

const PAY_INSERT_ALLOWED_KEYS: (keyof LoanPaymentInsertRow)[] = [
  'id',
  'household_id',
  'loan_id',
  'date',
  'amount',
  'principal_part',
  'interest_part',
];
const PAY_INSERT_FORBIDDEN_KEYS = ['created_by', 'created_at', 'updated_at', 'deleted_at', 'memo'];

export interface LoanMapperCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function fieldMatch(got: Record<string, unknown>, want: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(want)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
      return `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`;
    }
  }
  return null;
}

const LOAN: NewLoanDraft = {
  name: '  전세자금대출  ',
  lender: '  국민은행  ',
  principal: 100_000_000,
  annualRate: 4.25,
  termMonths: 120,
  startDate: '2026-01-25',
  paymentDay: 25,
  repayType: 'amortizing',
};

export function runLoanMapperCases(): {
  results: LoanMapperCaseResult[];
  passed: number;
  failed: number;
} {
  const results: LoanMapperCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- loans CREATE ---- */
  {
    const row = buildLoanInsert(LOAN, { id: LID, householdId: HID });
    const keys = Object.keys(row);
    check(
      'INSERT · normal — allowed cols only, name/lender trimmed, NO paid',
      keys.filter((k) => LOAN_INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !LOAN_INSERT_ALLOWED_KEYS.includes(k as keyof LoanInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: LID,
          household_id: HID,
          name: '전세자금대출',
          lender: '국민은행',
          principal: 100_000_000,
          annual_rate: 4.25,
          term_months: 120,
          start_date: '2026-01-25',
          payment_day: 25,
          repay_type: 'amortizing',
        }) === null,
      keys.join(','),
    );
  }
  {
    const row = buildLoanInsert({ ...LOAN, lender: '' }, { id: LID, householdId: HID });
    check('INSERT · empty lender allowed, still no paid', row.lender === '' && !('paid' in row));
  }
  {
    const row = buildLoanInsert({ ...LOAN, repayType: 'equal_principal' }, { id: LID, householdId: HID });
    check('INSERT · repay_type equal_principal passes through', row.repay_type === 'equal_principal');
  }

  /* ---- loans validation ---- */
  check('validate · empty name rejected', isValidLoanDraft({ ...LOAN, name: '  ' }) === false);
  check('validate · empty lender accepted', isValidLoanDraft({ ...LOAN, lender: '' }) === true);
  check('validate · principal 0 rejected', isValidLoanDraft({ ...LOAN, principal: 0 }) === false);
  check('validate · negative principal rejected', isValidLoanDraft({ ...LOAN, principal: -1 }) === false);
  check('validate · non-integer principal rejected', isValidLoanDraft({ ...LOAN, principal: 1000.5 }) === false);
  check('validate · annualRate 0 accepted', isValidLoanDraft({ ...LOAN, annualRate: 0 }) === true);
  check('validate · decimal annualRate accepted', isValidLoanDraft({ ...LOAN, annualRate: 3.333 }) === true);
  check('validate · negative annualRate rejected', isValidLoanDraft({ ...LOAN, annualRate: -0.1 }) === false);
  check('validate · NaN annualRate rejected', isValidLoanDraft({ ...LOAN, annualRate: NaN }) === false);
  check('validate · termMonths 0 rejected', isValidLoanDraft({ ...LOAN, termMonths: 0 }) === false);
  check('validate · non-integer termMonths rejected', isValidLoanDraft({ ...LOAN, termMonths: 12.5 }) === false);
  check('validate · bad startDate rejected', isValidLoanDraft({ ...LOAN, startDate: '2026-02-30' }) === false);
  check('validate · paymentDay 0 rejected', isValidLoanDraft({ ...LOAN, paymentDay: 0 }) === false);
  check('validate · paymentDay 32 rejected', isValidLoanDraft({ ...LOAN, paymentDay: 32 }) === false);
  check('validate · paymentDay 1 / 31 accepted', isValidLoanDraft({ ...LOAN, paymentDay: 1 }) === true && isValidLoanDraft({ ...LOAN, paymentDay: 31 }) === true);
  check('validate · bad repayType rejected', isValidLoanDraft({ ...LOAN, repayType: 'balloon' as unknown as 'bullet' }) === false);
  check('validate · bullet accepted', isValidLoanDraft({ ...LOAN, repayType: 'bullet' }) === true);
  check('validate · equal_principal accepted', isValidLoanDraft({ ...LOAN, repayType: 'equal_principal' }) === true);
  check('validate · clean draft accepted', isValidLoanDraft(LOAN) === true);

  /* ---- loans UPDATE ---- */
  {
    const row = buildLoanUpdate(LOAN);
    const keys = Object.keys(row);
    check(
      'UPDATE · editable cols only — NO paid / id / identity / server fields',
      keys.filter((k) => LOAN_UPDATE_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !LOAN_UPDATE_ALLOWED_KEYS.includes(k)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          name: '전세자금대출',
          lender: '국민은행',
          principal: 100_000_000,
          annual_rate: 4.25,
          term_months: 120,
          start_date: '2026-01-25',
          payment_day: 25,
          repay_type: 'amortizing',
        }) === null,
      keys.join(','),
    );
    check('UPDATE · never carries paid', !('paid' in row));
  }

  /* ---- loan_payments INSERT + splitPayment behaviour (STEP 16-G2-D4 §8-3) ---- */
  const payCtx = (remaining: number, annualRate: number) => ({
    id: PID,
    householdId: HID,
    loanId: LID,
    remaining,
    annualRate,
  });
  {
    // 정상 일반 상환: remaining 1,000,000 @ 12%/yr (1%/mo), pay 100,000.
    const row = buildLoanPaymentInsert({ date: '2026-02-25', amount: 100_000 }, payCtx(1_000_000, 12));
    const keys = Object.keys(row);
    check(
      'PAYMENT · normal — allowed cols only, no created_by/memo, split = 10,000 interest / 90,000 principal',
      keys.filter((k) => PAY_INSERT_FORBIDDEN_KEYS.includes(k)).length === 0 &&
        keys.filter((k) => !PAY_INSERT_ALLOWED_KEYS.includes(k as keyof LoanPaymentInsertRow)).length === 0 &&
        fieldMatch(row as unknown as Record<string, unknown>, {
          id: PID,
          household_id: HID,
          loan_id: LID,
          date: '2026-02-25',
          amount: 100_000,
          interest_part: 10_000,
          principal_part: 90_000,
        }) === null,
      `${row.principal_part}/${row.interest_part}`,
    );
  }
  {
    // amount smaller than the month's interest -> all interest, 0 principal.
    const row = buildLoanPaymentInsert({ date: '2026-02-25', amount: 5_000 }, payCtx(1_000_000, 12));
    check(
      'PAYMENT · amount < monthly interest -> interest 5,000 / principal 0',
      row.interest_part === 5_000 &&
        row.principal_part === 0 &&
        row.principal_part >= 0 &&
        row.principal_part + row.interest_part <= row.amount,
    );
  }
  {
    // near payoff: remaining 50,000, pay 100,000 -> principal clamps to remaining.
    const row = buildLoanPaymentInsert({ date: '2026-11-25', amount: 100_000 }, payCtx(50_000, 12));
    check(
      'PAYMENT · near payoff -> principal clamped to remaining (50,000), never exceeds',
      row.principal_part === 50_000 &&
        row.principal_part <= 50_000 &&
        row.interest_part === 500 &&
        row.principal_part + row.interest_part <= row.amount,
    );
  }
  {
    // invariants on a spread of inputs.
    let ok = true;
    for (const [rem, rate, amt] of [
      [1_000_000, 12, 100_000],
      [1_000_000, 0, 100_000],
      [50_000, 12, 100_000],
      [123_456, 4.25, 7_777],
      [1, 12, 1],
    ] as [number, number, number][]) {
      const r = buildLoanPaymentInsert({ date: '2026-05-25', amount: amt }, payCtx(rem, rate));
      if (
        r.principal_part < 0 ||
        r.interest_part < 0 ||
        r.principal_part > rem ||
        r.principal_part + r.interest_part > r.amount
      ) {
        ok = false;
      }
    }
    check('PAYMENT · invariants hold: parts >= 0, principal <= remaining, parts sum <= amount', ok);
  }

  /* ---- payment validation ---- */
  check('pay-validate · amount 0 rejected', isValidLoanPaymentDraft({ date: '2026-02-25', amount: 0 }) === false);
  check('pay-validate · negative amount rejected', isValidLoanPaymentDraft({ date: '2026-02-25', amount: -1 }) === false);
  check('pay-validate · non-integer amount rejected', isValidLoanPaymentDraft({ date: '2026-02-25', amount: 100.5 }) === false);
  check('pay-validate · bad date rejected', isValidLoanPaymentDraft({ date: '2026-13-01', amount: 100 }) === false);
  check('pay-validate · clean draft accepted', isValidLoanPaymentDraft({ date: '2026-02-25', amount: 100_000 }) === true);

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
