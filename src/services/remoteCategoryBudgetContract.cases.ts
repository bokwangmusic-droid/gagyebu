/**
 * Static verification for the `delete_custom_category_with_budget` RPC's
 * validation contract — STEP 16-H2 "CATEGORY DELETE WITH BUDGET A1.1"
 * (response-loss idempotency fix). Pins down the exact 8-scenario matrix
 * from the A1.1 review, plus the atomicity guarantee and the (unchanged,
 * already-correct) category-side rule, against the pure TS mirror in
 * `remoteCategoryBudgetContract.ts`.
 */
import {
  evaluateBudgetDeleteContract,
  evaluateCategoryDeleteContract,
  evaluateDeleteCustomCategoryWithBudgetContract,
  type RowSnapshot,
} from '@/services/remoteCategoryBudgetContract';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NO_ROW: RowSnapshot = { exists: false, deletedAt: null, updatedAt: null };
const active = (updatedAt: string): RowSnapshot => ({ exists: true, deletedAt: null, updatedAt });
const tombstone = (deletedAt: string, updatedAt = deletedAt): RowSnapshot => ({
  exists: true,
  deletedAt,
  updatedAt,
});

export async function runCategoryBudgetContractCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============== the 8-scenario matrix from the A1.1 review ============== */

  // 1 — active T1 -> successful delete -> tombstone T2 -> retry expected T1 -> SUCCESS
  {
    // T2 (the tombstone's own updated_at, stamped by trg_budgets_touch at
    // delete time) is DELIBERATELY different from T1 (the frozen token) —
    // this is exactly the bug scenario: a real soft-delete always changes
    // updated_at, so T2 !== T1 by construction, every time.
    const r = evaluateBudgetDeleteContract(tombstone('T2'), 'T1');
    check(
      '1 active T1 -> deleted (tombstone T2) -> retry with frozen T1 -> SUCCESS (the exact A1.1 bug)',
      r.ok === true && r.willMutate === false,
      JSON.stringify(r),
    );
  }

  // 2 — active T1 -> other device update -> active T2 -> delete expected T1 -> CONFLICT
  {
    const r = evaluateBudgetDeleteContract(active('T2'), 'T1');
    check(
      '2 active row edited elsewhere (T1 -> T2) -> delete expecting stale T1 -> CONFLICT',
      r.ok === false && r.reason === 'BUDGET_CONFLICT',
      JSON.stringify(r),
    );
  }

  // 3 — active T1 -> delete -> tombstone T2 -> revive -> active T3 -> retry expected T1 -> CONFLICT
  {
    // The tombstone T2 itself is never even reached by a stale retry once
    // revived — the row is ACTIVE again, so it's the active-branch (case 2
    // shape) that must reject it. This is what proves tombstone-mismatch
    // success (case 1) can NEVER be exploited to delete a revived row.
    const r = evaluateBudgetDeleteContract(active('T3'), 'T1');
    check(
      '3 delete(T1->tombstone T2) -> revive -> active T3 -> stale retry(T1) -> CONFLICT, revived row protected',
      r.ok === false && r.reason === 'BUDGET_CONFLICT',
      JSON.stringify(r),
    );
  }

  // 4 — category already deleted + budget tombstoned -> SUCCESS
  {
    const r = evaluateDeleteCustomCategoryWithBudgetContract(
      tombstone('CAT_T2'), 'CAT_T1', tombstone('BUD_T2'), 'BUD_T1',
    );
    check(
      '4 category already deleted + budget already tombstoned -> SUCCESS, nothing re-mutated',
      r.ok === true && r.categoryWillMutate === false && r.budgetWillMutate === false,
      JSON.stringify(r),
    );
  }

  // 5 — category already deleted + budget active matching frozen token -> cleanup SUCCESS
  {
    const r = evaluateDeleteCustomCategoryWithBudgetContract(
      tombstone('CAT_T2'), 'CAT_T1', active('BUD_T1'), 'BUD_T1',
    );
    check(
      '5 category already deleted + budget still ACTIVE with matching token -> cleanup completes now',
      r.ok === true && r.categoryWillMutate === false && r.budgetWillMutate === true,
      JSON.stringify(r),
    );
  }

  // 6 — category already deleted + budget active mismatching token -> CONFLICT, budget preserved
  {
    const r = evaluateDeleteCustomCategoryWithBudgetContract(
      tombstone('CAT_T2'), 'CAT_T1', active('BUD_T2'), 'BUD_T1',
    );
    check(
      '6 category already deleted + budget ACTIVE with a DIFFERENT token -> CONFLICT, budget untouched',
      r.ok === false && r.reason === 'BUDGET_CONFLICT' && r.budgetWillMutate === false,
      JSON.stringify(r),
    );
  }

  // 7 — expectedBudgetUpdatedAt null + active budget created since snapshot -> CONFLICT
  {
    const r = evaluateBudgetDeleteContract(active('NEW_T1'), null);
    check(
      '7 expected NO active budget, but one now exists -> CONFLICT',
      r.ok === false && r.reason === 'BUDGET_CONFLICT',
      JSON.stringify(r),
    );
  }

  // 8 — expectedBudgetUpdatedAt null + tombstone exists -> SUCCESS
  {
    const r = evaluateBudgetDeleteContract(tombstone('T1'), null);
    check(
      '8 expected NO active budget, and a tombstone exists (or no row) -> SUCCESS, no-op',
      r.ok === true && r.willMutate === false,
      JSON.stringify(r),
    );
  }
  {
    const r = evaluateBudgetDeleteContract(NO_ROW, null);
    check('8b expected NO active budget, no row at all -> SUCCESS, no-op', r.ok === true && r.willMutate === false, JSON.stringify(r));
  }

  /* ============== additional coverage: BUDGET_NOT_FOUND, active-match ============== */

  // 9 — expectedBudgetUpdatedAt non-null but no row exists at all -> BUDGET_NOT_FOUND
  {
    const r = evaluateBudgetDeleteContract(NO_ROW, 'T1');
    check('9 expected a budget (token given) but no row exists -> BUDGET_NOT_FOUND', r.ok === false && r.reason === 'BUDGET_NOT_FOUND', JSON.stringify(r));
  }

  // 10 — plain active-with-matching-token delete (no prior history) -> proceeds to mutate
  {
    const r = evaluateBudgetDeleteContract(active('T1'), 'T1');
    check('10 plain active budget, matching token -> proceeds to delete', r.ok === true && r.willMutate === true, JSON.stringify(r));
  }

  /* ============== category side (unchanged, re-confirmed here) ============== */

  // 11 — category already deleted -> SUCCESS regardless of token (no comparison at all)
  {
    const r = evaluateCategoryDeleteContract(tombstone('CAT_T2'), 'CAT_T1_STALE_OR_ANYTHING');
    check('11 category already deleted -> success no-op, no token check', r.ok === true && r.willMutate === false, JSON.stringify(r));
  }
  // 12 — category active, matching token -> proceeds
  {
    const r = evaluateCategoryDeleteContract(active('CAT_T1'), 'CAT_T1');
    check('12 category active + matching token -> proceeds to delete', r.ok === true && r.willMutate === true, JSON.stringify(r));
  }
  // 13 — category active, mismatching token -> CONFLICT
  {
    const r = evaluateCategoryDeleteContract(active('CAT_T2'), 'CAT_T1');
    check('13 category active + mismatching token -> CONFLICT', r.ok === false && r.reason === 'CATEGORY_CONFLICT', JSON.stringify(r));
  }
  // 14 — category row doesn't exist -> CATEGORY_NOT_FOUND
  {
    const r = evaluateCategoryDeleteContract(NO_ROW, 'CAT_T1');
    check('14 category row missing -> CATEGORY_NOT_FOUND', r.ok === false && r.reason === 'CATEGORY_NOT_FOUND', JSON.stringify(r));
  }

  /* ============== atomicity: category conflict -> budget never even evaluated ============== */

  // 15 — category conflict stops the whole call; budget half is never touched/evaluated
  {
    const r = evaluateDeleteCustomCategoryWithBudgetContract(
      active('CAT_T2'), 'CAT_T1', // category conflict
      active('BUD_T1'), 'BUD_T1', // budget WOULD pass on its own
    );
    check(
      '15 category conflict aborts the whole call even though the budget half would have passed alone',
      r.ok === false && r.reason === 'CATEGORY_CONFLICT' && r.categoryWillMutate === false && r.budgetWillMutate === false,
      JSON.stringify(r),
    );
  }

  // 16 — the plain happy path: both active + matching -> both mutate
  {
    const r = evaluateDeleteCustomCategoryWithBudgetContract(
      active('CAT_T1'), 'CAT_T1',
      active('BUD_T1'), 'BUD_T1',
    );
    check('16 both active + matching tokens -> both mutate, ok:true', r.ok === true && r.categoryWillMutate === true && r.budgetWillMutate === true, JSON.stringify(r));
  }

  // 17 — no budget expected at all, category active + matching -> category mutates, budget no-op
  {
    const r = evaluateDeleteCustomCategoryWithBudgetContract(
      active('CAT_T1'), 'CAT_T1',
      NO_ROW, null,
    );
    check('17 no budget ever involved -> category deletes, budget stays a no-op', r.ok === true && r.categoryWillMutate === true && r.budgetWillMutate === false, JSON.stringify(r));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
