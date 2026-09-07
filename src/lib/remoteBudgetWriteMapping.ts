/**
 * Local input draft -> `public.budgets` INSERT / UPDATE row — STEP 16-G2-C3-B.
 *
 * The budget counterpart of src/lib/remoteCardWriteMapping.ts. Pure
 * transform: no Supabase, no AsyncStorage, no React state.
 *
 * `public.budgets` is unusual — it has NO surrogate `id` and NO `month`
 * column. Its natural PRIMARY KEY is `(household_id, category_id)`, and its
 * only user-editable column is `amount` (the RLS grant is
 * `update (amount, deleted_at)`). So a budget is identified by
 * `household_id + category_id`, "changing the category" is not an update
 * (it's soft-delete-old + insert-new), and there is exactly one budget row
 * per category per household — ever, tombstones included.
 *
 * ---- deliberately NOT in any payload (STEP 16-G2-C3-B §7) ----
 *   - created_by : server-forced by private.trg_lock_budget_identity() to
 *                  auth.uid() on INSERT, immutable on UPDATE.
 *   - created_at / updated_at : server-managed.
 *   - id / month  : these columns DO NOT EXIST — never invent them.
 *   - household_id / category_id : on UPDATE they are `.eq(...)` filters
 *                  and are trigger-locked; never in the PATCH body.
 * `deleted_at` appears ONLY in the soft-delete body and the tombstone
 * revive body — never in a plain create/edit.
 */

/**
 * What the budget form produces per category. Purely the user-editable
 * shape — no id, no household id, no month, no timestamps.
 */
export interface NewBudgetDraft {
  /** = category_id (a plain category key, same string space as transaction.category). */
  category: string;
  /** KRW, must be a finite number > 0. */
  amount: number;
}

/** Client-side guard — never lean on the DB `amount > 0` CHECK for UX (STEP 16-G2-C3-B §8). */
export function isValidBudgetDraft(draft: NewBudgetDraft): boolean {
  return (
    typeof draft.category === 'string' &&
    draft.category.trim().length > 0 &&
    Number.isFinite(draft.amount) &&
    draft.amount > 0
  );
}

export interface BuildBudgetInsertContext {
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
}

/** The exact column set sent to `public.budgets` on INSERT. */
export interface BudgetInsertRow {
  household_id: string;
  category_id: string;
  amount: number;
}

export function buildBudgetInsert(
  draft: NewBudgetDraft,
  ctx: BuildBudgetInsertContext,
): BudgetInsertRow {
  return {
    household_id: ctx.householdId,
    category_id: draft.category,
    amount: draft.amount,
  };
}

/* ================================================================== *
 * UPDATE bodies — `amount` is the only editable field.
 * ================================================================== */

export interface BudgetAmountUpdateRow {
  amount: number;
}

/** Plain edit of an existing live budget's amount. */
export function buildBudgetUpdate(draft: NewBudgetDraft): BudgetAmountUpdateRow {
  return { amount: draft.amount };
}

export interface BudgetReviveRow {
  amount: number;
  deleted_at: null;
}

/**
 * Re-adding a budget for a category whose row was soft-deleted: the row
 * still occupies the PK slot, so this is an UPDATE that sets the new amount
 * AND clears the tombstone — never a second INSERT (STEP 16-G2-C3-B §18).
 */
export function buildBudgetRevive(draft: NewBudgetDraft): BudgetReviveRow {
  return { amount: draft.amount, deleted_at: null };
}
