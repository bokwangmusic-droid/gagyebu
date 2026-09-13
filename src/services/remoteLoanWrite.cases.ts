/**
 * Static verification for STEP 16-H2-L1.1 (`addLoanPayment` idempotency) AND
 * STEP 16-H2-L2.3 (`updateLoan` idempotency) — the pure, extractable
 * decision points each write's own "did our earlier attempt already land?"
 * reconcile relies on:
 *   - `isSamePaymentRequest` — shared by `addLoanPayment`'s pre-check and its
 *     23505 race-fallback.
 *   - `loanFieldsMatch` — `updateLoan`'s own "0 rows on the primary UPDATE ->
 *     did WE already write this?" reconcile.
 *
 * The full `addLoanPayment`/`updateLoan` flows call `supabase` directly and
 * can't run here (same limitation as remoteCategoryBudgetWrite.cases.ts's
 * own header note — every other Supabase-calling write service in this repo
 * hits the same wall; there is no Supabase-mocking harness in this
 * environment). This file covers both pure decision functions exhaustively,
 * plus a direct, concrete reproduction of each REPORTED bug:
 *   - `isSamePaymentRequest`: re-derives what the OLD (removed) comparison —
 *     matching on the freshly-recomputed `principal_part`/`interest_part` —
 *     would have done for the EXACT scenario from the H2-L1 report (a
 *     lost-response replay after `paid` has already moved), side-by-side
 *     with the NEW function, using the REAL `splitPayment()` so the numbers
 *     are not hand-picked.
 *   - `loanFieldsMatch`: reproduces the H2-L2.3 real-device bug — Postgres
 *     `numeric` columns (`principal`, `annual_rate`) come back from
 *     PostgREST as STRINGS, so the OLD raw `===` compare NEVER matched even
 *     when the value was semantically identical, misreporting a
 *     genuinely-landed lost-response retry as `conflict`.
 *
 * The INSERT-time split computation itself (`splitPayment`, `remaining`,
 * `annual_rate` re-SELECT) is UNCHANGED — see splits.cases.ts /
 * remoteLoanWriteMapping.cases.ts for its own coverage. This file is about
 * idempotency / duplicate-recognition ONLY.
 */
import { splitPayment } from '@/lib/loan';
import { isSamePaymentRequest, loanFieldsMatch } from '@/services/remoteLoanWrite';
import { buildLoanUpdate } from '@/lib/remoteLoanWriteMapping';
import type { NewLoanDraft, NewLoanPaymentDraft } from '@/lib/remoteLoanWriteMapping';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { householdId: 'h-A', loanId: 'loan-1', expectedUserId: 'u-A' };

const pd = (over: Partial<NewLoanPaymentDraft> = {}): NewLoanPaymentDraft => ({
  date: '2026-09-15',
  amount: 1000000,
  ...over,
});

/** A `loan_payments` row shaped exactly like the columns `isSamePaymentRequest`
 *  reads — mirrors what a real `.select('household_id,loan_id,created_by,date,amount,deleted_at')` returns. */
const row = (over: Record<string, unknown> = {}) => ({
  household_id: 'h-A',
  loan_id: 'loan-1',
  created_by: 'u-A',
  date: '2026-09-15',
  amount: 1000000,
  deleted_at: null,
  ...over,
});

/**
 * The OLD (removed) comparison `addLoanPayment` used to make on both the
 * pre-existing-row and 23505-reconcile paths: stable fields PLUS the
 * freshly-recomputed `principal_part`/`interest_part` for THIS call. This is
 * reconstructed here (NOT imported — it no longer exists in the source)
 * purely to demonstrate, side-by-side, that it used to false-negative the
 * exact scenario the fix addresses.
 */
function oldBuggyIsSameRequest(
  existing: { principal_part: number; interest_part: number } & ReturnType<typeof row>,
  freshlyComputed: { principal_part: number; interest_part: number },
): boolean {
  return (
    existing.deleted_at == null &&
    existing.household_id === A.householdId &&
    existing.loan_id === A.loanId &&
    existing.created_by === A.expectedUserId &&
    existing.date === '2026-09-15' &&
    existing.amount === 1000000 &&
    existing.principal_part === freshlyComputed.principal_part &&
    existing.interest_part === freshlyComputed.interest_part
  );
}

export async function runRemoteLoanWriteCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ================== THE CORE REGRESSION (reported bug) ================== */

  // 1 — THE REPORTED SCENARIO: an INSERT actually succeeded, the response
  // was lost, and by the time of the replay `paid` has already moved (by
  // THIS SAME payment's own principalPart) — so a freshly-recomputed split
  // at replay time is DIFFERENT from what was actually stored. The OLD
  // comparison (reconstructed above) sees this as a mismatch -> `conflict`
  // (the bug). The NEW `isSamePaymentRequest` never looks at the split at
  // all -> recognizes it as the same request -> idempotent success.
  {
    const principal = 100000000;
    const annualRate = 4.5;
    const amount = 1000000;

    // Attempt 1 (the one that actually landed): remaining is the FULL balance.
    const remainingAtFirstAttempt = principal - 0;
    const firstSplit = splitPayment(remainingAtFirstAttempt, annualRate, amount);
    // The row as actually stored by that successful INSERT:
    const storedRow = row({ amount, principal_part: firstSplit.principalPart, interest_part: firstSplit.interestPart });

    // Attempt 2 (the lost-response REPLAY): `paid` has already moved by
    // `firstSplit.principalPart` (the trigger's effect of attempt 1), so
    // `remaining` is now smaller -> a DIFFERENT split.
    const remainingAtReplay = principal - firstSplit.principalPart;
    const secondSplit = splitPayment(remainingAtReplay, annualRate, amount);

    // Sanity: the whole scenario is only meaningful if the two splits
    // actually differ (a zero-rate loan would make interestPart 0 always
    // and this test vacuous) — assert that up front.
    const splitsGenuinelyDiffer =
      firstSplit.principalPart !== secondSplit.principalPart || firstSplit.interestPart !== secondSplit.interestPart;

    const oldVerdict = oldBuggyIsSameRequest(
      storedRow as never,
      secondSplit as unknown as { principal_part: number; interest_part: number },
    );
    const newVerdict = isSamePaymentRequest(storedRow, { ...A, draft: pd({ amount }) });

    check(
      '1 CORE REGRESSION: reported lost-response-after-paid-moved scenario — OLD comparison false-negatives (conflict), NEW recognizes idempotent success',
      splitsGenuinelyDiffer && oldVerdict === false && newVerdict === true,
      JSON.stringify({ firstSplit, secondSplit, splitsGenuinelyDiffer, oldVerdict, newVerdict }),
    );
  }

  // 2 — same scenario but with a THIRD replay (paid has moved twice as far
  // in a hypothetical world where the fix did NOT prevent re-application —
  // i.e. this documents that `isSamePaymentRequest` is oblivious to `paid`
  // entirely, at any distance from the original attempt).
  {
    const principal = 50000000;
    const annualRate = 12; // higher rate -> larger interest swing between remainings
    const amount = 2000000;
    const storedRow = row({
      household_id: 'h-A',
      loan_id: 'loan-1',
      created_by: 'u-A',
      date: '2026-01-01',
      amount,
    });
    // Even a wildly different current-state split (simulated by NOT even
    // computing one — the function signature has no parameter for it) still
    // matches, because the comparison structurally cannot see it.
    const verdict = isSamePaymentRequest(storedRow, {
      householdId: 'h-A',
      loanId: 'loan-1',
      expectedUserId: 'u-A',
      draft: pd({ date: '2026-01-01', amount }),
    });
    check(
      '2 isSamePaymentRequest has no parameter for principal_part/interest_part at all — structurally split-independent',
      verdict === true,
      JSON.stringify({ storedRow, verdict }),
    );
  }

  /* ================== SAME-ID, DIFFERENT REQUEST -> NEVER SUCCESS ================== */

  // 3 — different amount -> NOT the same request
  {
    const verdict = isSamePaymentRequest(row({ amount: 1000000 }), { ...A, draft: pd({ amount: 2000000 }) });
    check('3 different amount -> isSamePaymentRequest false (never a silent success)', verdict === false, '');
  }

  // 4 — different loanId -> NOT the same request
  {
    const verdict = isSamePaymentRequest(row({ loan_id: 'loan-1' }), {
      ...A,
      loanId: 'loan-2',
      draft: pd(),
    });
    check('4 different loanId -> isSamePaymentRequest false', verdict === false, '');
  }

  // 5 — different householdId -> NOT the same request
  {
    const verdict = isSamePaymentRequest(row({ household_id: 'h-A' }), {
      ...A,
      householdId: 'h-B',
      draft: pd(),
    });
    check('5 different householdId -> isSamePaymentRequest false', verdict === false, '');
  }

  // 6 — different created_by (requesting user) -> NOT the same request
  {
    const verdict = isSamePaymentRequest(row({ created_by: 'u-A' }), {
      ...A,
      expectedUserId: 'u-B',
      draft: pd(),
    });
    check('6 different created_by -> isSamePaymentRequest false', verdict === false, '');
  }

  // 7 — different date -> NOT the same request
  {
    const verdict = isSamePaymentRequest(row({ date: '2026-09-15' }), {
      ...A,
      draft: pd({ date: '2026-09-16' }),
    });
    check('7 different date -> isSamePaymentRequest false', verdict === false, '');
  }

  // 8 — a soft-deleted existing row is a genuine id COLLISION, never revived
  // as an idempotent success, even if every other field matches exactly.
  {
    const verdict = isSamePaymentRequest(row({ deleted_at: '2026-09-16T00:00:00.000Z' }), { ...A, draft: pd() });
    check('8 soft-deleted existing row (same-else fields) -> isSamePaymentRequest false, never revived', verdict === false, '');
  }

  /* ================== EXACT MATCH -> IDEMPOTENT SUCCESS ================== */

  // 9 — every stable-intent field identical, not deleted -> true
  {
    const verdict = isSamePaymentRequest(row(), { ...A, draft: pd() });
    check('9 identical stable-intent fields, not deleted -> isSamePaymentRequest true', verdict === true, '');
  }

  // 10 — used by BOTH call sites in addLoanPayment (pre-check AND the 23505
  // race-fallback) — this file cannot execute the real Supabase-backed
  // function, but the source is read to confirm they call the SAME
  // exported helper, not two diverging copies (documented, not re-asserted
  // as a runtime check — see the completion report).
  check(
    '10 (documented, not runtime-checked) pre-check and 23505 fallback both call the ONE exported isSamePaymentRequest — verified by reading src/services/remoteLoanWrite.ts',
    true,
    'see report: both call sites reuse this exact function',
  );

  /* ================================================================== *
   * loanFieldsMatch — STEP 16-H2-L2.3 real-device bug
   * ================================================================== */

  const ld = (over: Partial<NewLoanDraft> = {}): NewLoanDraft => ({
    name: '전세자금대출',
    lender: '국민은행',
    principal: 100000000,
    annualRate: 4.5,
    termMonths: 24,
    startDate: '2026-01-15',
    paymentDay: 15,
    repayType: 'amortizing',
    ...over,
  });

  /**
   * A `loans` row shaped exactly like a REAL PostgREST response for the
   * reconcile's own select
   * (`'name,lender,principal,annual_rate,term_months,start_date,payment_day,repay_type,deleted_at,updated_at'`):
   * `principal`/`annual_rate` (Postgres `numeric`) come back as STRINGS;
   * `term_months`/`payment_day` (Postgres `int`) come back as genuine
   * numbers — this asymmetry is exactly what the old bug missed.
   */
  const existingRow = (over: Record<string, unknown> = {}) => ({
    name: '전세자금대출',
    lender: '국민은행',
    principal: '100000000', // numeric -> STRING over the wire
    annual_rate: '4.5', // numeric -> STRING over the wire
    term_months: 24, // int -> genuine number
    start_date: '2026-01-15',
    payment_day: 15, // int -> genuine number
    repay_type: 'amortizing',
    deleted_at: null,
    updated_at: '2026-09-13T00:00:00.000+00:00',
    ...over,
  });

  /** The OLD (removed) raw `===` comparison, reconstructed here (not
   *  imported — no longer in the source) to demonstrate side-by-side that it
   *  used to false-negative a semantically-identical PostgREST numeric
   *  string against a JS number. */
  function oldBuggyLoanFieldsMatch(
    existing: Record<string, unknown>,
    row: ReturnType<typeof buildLoanUpdate>,
  ): boolean {
    return (
      existing.name === row.name &&
      existing.lender === row.lender &&
      existing.principal === row.principal &&
      existing.annual_rate === row.annual_rate &&
      existing.term_months === row.term_months &&
      existing.start_date === row.start_date &&
      existing.payment_day === row.payment_day &&
      existing.repay_type === row.repay_type
    );
  }

  // 11 — CORE REGRESSION (the real-device bug): a lost-response replay whose
  // write ACTUALLY landed, reconciled against the PostgREST numeric-as-
  // string representation — OLD comparison false-negatives (misreports
  // `conflict`), NEW comparison correctly recognizes the idempotent match.
  {
    const draft = ld();
    const row = buildLoanUpdate(draft);
    const existing = existingRow(); // same values, numeric-as-string shape
    const oldVerdict = oldBuggyLoanFieldsMatch(existing, row);
    const newVerdict = loanFieldsMatch(existing, row);
    check(
      '11 CORE REGRESSION: PostgREST numeric-as-string vs JS number — OLD false-negatives (conflict), NEW recognizes idempotent match',
      oldVerdict === false && newVerdict === true,
      JSON.stringify({ existing, row, oldVerdict, newVerdict }),
    );
  }

  // 12 — a GENUINE conflict (principal really differs) must still be
  // detected — the fix widens type tolerance, it does NOT widen value
  // tolerance.
  {
    const draft = ld({ principal: 100000000 });
    const row = buildLoanUpdate(draft);
    const existing = existingRow({ principal: '90000000' }); // someone else's edit
    check(
      '12 genuine principal mismatch (as PostgREST numeric string) -> loanFieldsMatch still false',
      loanFieldsMatch(existing, row) === false,
      '',
    );
  }

  // 13 — a GENUINE annual_rate conflict is still detected.
  {
    const draft = ld({ annualRate: 4.5 });
    const row = buildLoanUpdate(draft);
    const existing = existingRow({ annual_rate: '5.0' });
    check('13 genuine annual_rate mismatch -> loanFieldsMatch still false', loanFieldsMatch(existing, row) === false, '');
  }

  // 14 — term_months / payment_day (genuine numbers, not numeric strings)
  // still compare correctly in both directions (match + genuine mismatch).
  {
    const draft = ld({ termMonths: 24, paymentDay: 15 });
    const row = buildLoanUpdate(draft);
    const match = loanFieldsMatch(existingRow({ term_months: 24, payment_day: 15 }), row);
    const mismatch = loanFieldsMatch(existingRow({ term_months: 36 }), row);
    check(
      '14 term_months/payment_day (plain int columns) -> match true, genuine mismatch false',
      match === true && mismatch === false,
      JSON.stringify({ match, mismatch }),
    );
  }

  // 15 — name / lender / start_date / repay_type (plain text/date columns,
  // never numeric-string affected) still compare correctly — unaffected by
  // the fix, regression check that the untouched fields still work.
  {
    const draft = ld();
    const row = buildLoanUpdate(draft);
    const sameText = loanFieldsMatch(existingRow(), row);
    const diffName = loanFieldsMatch(existingRow({ name: '다른 이름' }), row);
    const diffLender = loanFieldsMatch(existingRow({ lender: '다른 은행' }), row);
    const diffDate = loanFieldsMatch(existingRow({ start_date: '2026-02-01' }), row);
    const diffType = loanFieldsMatch(existingRow({ repay_type: 'bullet' }), row);
    check(
      '15 text/date/enum fields (name/lender/start_date/repay_type) still match/mismatch correctly',
      sameText === true && diffName === false && diffLender === false && diffDate === false && diffType === false,
      JSON.stringify({ sameText, diffName, diffLender, diffDate, diffType }),
    );
  }

  // 16 — a deleted_at difference is NOT part of loanFieldsMatch's own
  // comparison set (updateLoan checks deleted_at separately, BEFORE calling
  // this) — documents that boundary rather than asserting new behavior.
  {
    const draft = ld();
    const row = buildLoanUpdate(draft);
    const verdict = loanFieldsMatch(existingRow({ deleted_at: '2026-09-13T00:00:00.000Z' }), row);
    check(
      '16 (documented boundary) loanFieldsMatch does not itself look at deleted_at — updateLoan checks that separately first',
      verdict === true,
      'see updateLoan(): existingRow.deleted_at != null is checked BEFORE loanFieldsMatch is ever called',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
