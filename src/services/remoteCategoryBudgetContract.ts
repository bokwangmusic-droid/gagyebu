/**
 * Pure TypeScript model of `delete_custom_category_with_budget`'s
 * validation-before-mutation decision tree — STEP 16-H2 "CATEGORY DELETE
 * WITH BUDGET A1.1" (response-loss idempotency fix).
 *
 * This is NOT called by any runtime code (`remoteCategoryBudgetWrite.ts`
 * calls the real SQL RPC — the actual authority). It exists purely so the
 * RPC's row-state-machine contract can be locked down by ordinary
 * TypeScript tests (`remoteCategoryBudgetContract.cases.ts`), the way this
 * repo already tests every other pure decision function, since there is no
 * SQL test harness here (see the migration file's and
 * remoteCategoryBudgetWrite.cases.ts's own notes on that). Any future
 * change to the SQL's branches MUST update this file's mirror in the same
 * change, or the tests stop meaning anything.
 *
 * THE A1.1 BUG this exists to pin down: a soft delete always changes
 * `updated_at` (trg_*_touch fires on every UPDATE, deletes included), so a
 * frozen "the row was ACTIVE with token T" expectation can never equal a
 * tombstone's `updated_at` — not even for the tombstone OUR OWN successful
 * delete created. Comparing tokens against an already-deleted row makes a
 * plain lost-response retry of a SUCCESSFUL delete fail as a false
 * conflict, every single time. The fix: once a row is confirmed a
 * tombstone (`deletedAt !== null`), it is ALWAYS accepted as the delete
 * intent's already-satisfied end state — no token comparison, ever. A
 * token is only ever compared against an ACTIVE row, which is exactly the
 * state that can still legitimately diverge from what the client last saw
 * (edited, or revived after an earlier delete).
 */

export interface RowSnapshot {
  /** Does a row exist at all for this natural key? */
  exists: boolean;
  /** The row's own `deleted_at`, or `null` if it's currently active (or
   *  doesn't exist — `deletedAt` is meaningless when `exists` is false). */
  deletedAt: string | null;
  /** The row's own `updated_at`, or `null` when it doesn't exist. */
  updatedAt: string | null;
}

export type DeleteValidationOutcome =
  | { ok: true; willMutate: boolean }
  | { ok: false; reason: string };

/**
 * The CATEGORY half. `expectedUpdatedAt` is always required (no "no
 * category expected" case — the client only ever offers delete on a
 * category it just displayed as live). Already-deleted is unconditionally
 * accepted with NO token check (same one-way-soft-delete reasoning as the
 * budget side below) — this branch was already correct in A1, unchanged
 * here; included for a complete, symmetric model.
 */
export function evaluateCategoryDeleteContract(
  row: RowSnapshot,
  expectedUpdatedAt: string,
): DeleteValidationOutcome {
  if (!row.exists) return { ok: false, reason: 'CATEGORY_NOT_FOUND' };
  if (row.deletedAt !== null) return { ok: true, willMutate: false };
  if (row.updatedAt !== expectedUpdatedAt) return { ok: false, reason: 'CATEGORY_CONFLICT' };
  return { ok: true, willMutate: true };
}

/**
 * The BUDGET half — THE fixed branch. `expectedUpdatedAt === null` means
 * "no ACTIVE budget existed at delete-intent time," which is itself an
 * optimistic-concurrency claim (STEP 16-H2 audit §3): a newly-appeared
 * ACTIVE row is a conflict exactly like a changed token would be.
 * `expectedUpdatedAt` non-null: no row at all -> BUDGET_NOT_FOUND
 * (defensive; budgets are never hard-deleted so this is near-unreachable);
 * an existing TOMBSTONE is accepted unconditionally regardless of its
 * token (the A1.1 fix); an ACTIVE row must match the token exactly, or a
 * concurrent edit/revive is protected via BUDGET_CONFLICT.
 */
export function evaluateBudgetDeleteContract(
  row: RowSnapshot,
  expectedUpdatedAt: string | null,
): DeleteValidationOutcome {
  if (expectedUpdatedAt === null) {
    if (row.exists && row.deletedAt === null) {
      return { ok: false, reason: 'BUDGET_CONFLICT' };
    }
    return { ok: true, willMutate: false };
  }

  if (!row.exists) return { ok: false, reason: 'BUDGET_NOT_FOUND' };
  if (row.deletedAt !== null) return { ok: true, willMutate: false }; // <- the A1.1 fix
  if (row.updatedAt !== expectedUpdatedAt) return { ok: false, reason: 'BUDGET_CONFLICT' };
  return { ok: true, willMutate: true };
}

export interface CombinedOutcome {
  ok: boolean;
  reason?: string;
  categoryWillMutate: boolean;
  budgetWillMutate: boolean;
}

/**
 * The WHOLE RPC's atomicity, modelled: category is validated first: any
 * failure stops there and the budget is never even evaluated, matching the
 * real function's row-lock order (category first). Only when category
 * passes is the budget evaluated; a budget failure means NEITHER table
 * mutates, even though the category validation already passed on its own
 * (this is what "atomic" means here — validation passing for one half
 * never lets that half mutate alone).
 */
export function evaluateDeleteCustomCategoryWithBudgetContract(
  category: RowSnapshot,
  expectedCategoryUpdatedAt: string,
  budget: RowSnapshot,
  expectedBudgetUpdatedAt: string | null,
): CombinedOutcome {
  const catResult = evaluateCategoryDeleteContract(category, expectedCategoryUpdatedAt);
  if (!catResult.ok) {
    return { ok: false, reason: catResult.reason, categoryWillMutate: false, budgetWillMutate: false };
  }
  const budResult = evaluateBudgetDeleteContract(budget, expectedBudgetUpdatedAt);
  if (!budResult.ok) {
    // Category validation passed, but the whole call still mutates
    // NOTHING — this is the atomicity guarantee.
    return { ok: false, reason: budResult.reason, categoryWillMutate: false, budgetWillMutate: false };
  }
  return {
    ok: true,
    categoryWillMutate: catResult.willMutate,
    budgetWillMutate: budResult.willMutate,
  };
}
