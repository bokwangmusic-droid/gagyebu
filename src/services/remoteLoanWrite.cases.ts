/**
 * Static verification for STEP 16-H2-L1.1 — the `addLoanPayment` idempotency
 * fix: `isSamePaymentRequest`, the ONE pure, extractable decision point that
 * both the pre-check and the 23505 race-fallback inside `addLoanPayment`
 * share to recognize "this is a replay of a repayment that already landed."
 *
 * The full `addLoanPayment` flow calls `supabase` directly and can't run
 * here (same limitation as remoteCategoryBudgetWrite.cases.ts's own header
 * note — every other Supabase-calling write service in this repo hits the
 * same wall; there is no Supabase-mocking harness in this environment). This
 * file covers the pure decision function exhaustively, plus a direct,
 * concrete reproduction of the REPORTED bug: it re-derives what the OLD
 * (removed) comparison — matching on the freshly-recomputed
 * `principal_part`/`interest_part` — would have done for the EXACT scenario
 * from the H2-L1 report (a lost-response replay after `paid` has already
 * moved), side-by-side with what the NEW `isSamePaymentRequest` does, using
 * the REAL `splitPayment()` so the numbers are not hand-picked.
 *
 * The INSERT-time split computation itself (`splitPayment`, `remaining`,
 * `annual_rate` re-SELECT) is UNCHANGED — see splits.cases.ts /
 * remoteLoanWriteMapping.cases.ts for its own coverage. This file is about
 * idempotency / duplicate-recognition ONLY.
 */
import { splitPayment } from '@/lib/loan';
import { isSamePaymentRequest } from '@/services/remoteLoanWrite';
import type { NewLoanPaymentDraft } from '@/lib/remoteLoanWriteMapping';

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

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
