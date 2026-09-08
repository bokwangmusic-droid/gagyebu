/**
 * STEP 16-G1B / 16-G2-A / 16-G2-B / 16-G2-C2 / 16-G2-C3-B / 16-G2-C4-B /
 * 16-G2-D1 / 16-G2-D2 / 16-G2-D3 / 16-G2-D4 — household finance write gating.
 *
 * `REMOTE_FINANCE_READ_ONLY` stays `true` and keeps its exact declaration
 * for now. As of STEP 16-G2-D4 NO screen checks it any more (`loan-add` is
 * the last one to switch to `REMOTE_FINANCE_WRITE.*`); tidying the constant
 * away is left as its own follow-up so this STEP has no unrelated cleanup.
 *
 * `REMOTE_FINANCE_WRITE` is the one greppable place that says which
 * financial writes are open:
 *   - transaction CREATE / EDIT / (soft) DELETE — STEP 16-G2-A / 16-G2-B,
 *     via src/services/remoteFinanceWrite.ts.
 *   - card CREATE / EDIT / (soft) DELETE — STEP 16-G2-C2, via
 *     src/services/remoteCardWrite.ts (direct `public.cards` INSERT /
 *     UPDATE / UPDATE deleted_at; no RPC, no hard DELETE).
 *   - budget CREATE / EDIT / (soft) DELETE — STEP 16-G2-C3-B, via
 *     src/services/remoteBudgetWrite.ts (direct `public.budgets` INSERT /
 *     conditional UPDATE / UPDATE deleted_at, keyed on the natural PK
 *     `(household_id, category_id)` — no surrogate id, no `month`, no
 *     `.upsert()`, no RPC, no hard DELETE).
 *   - custom category CREATE / EDIT / (soft) DELETE + shared REORDER —
 *     STEP 16-G2-C4-B, via src/services/remoteCategoryWrite.ts (direct
 *     `public.custom_categories` INSERT / UPDATE name·bg·color·icon /
 *     UPDATE deleted_at, and `public.household_settings` UPDATE
 *     cat_order_expense|cat_order_income for reorder; `type` is immutable
 *     after create; a category soft-delete also soft-deletes its live
 *     budget via the existing softDeleteBudget(); no RPC, no hard DELETE).
 *   - planned-expense CREATE / EDIT / (soft) DELETE — STEP 16-G2-D1, via
 *     src/services/remotePlannedWrite.ts (direct `public.planned_expenses`
 *     INSERT / conditional UPDATE of name·amount·category·date·memo /
 *     UPDATE deleted_at, keyed on `(household_id, id)` with a client
 *     `p-...` id; `type` is immutable after create; NO "complete to a real
 *     transaction" step, NO `transactions` write, no RPC, no hard DELETE).
 *   - recurring-rule CREATE / EDIT / ACTIVE-TOGGLE / (soft) DELETE —
 *     STEP 16-G2-D2, via src/services/remoteRecurringWrite.ts (direct
 *     `public.recurring_rules` INSERT / conditional UPDATE of
 *     name·amount·category·frequency·day_of_month·day_of_week / conditional
 *     UPDATE of `active` alone / UPDATE deleted_at, keyed on
 *     `(household_id, id)` with a client `rec-...` id; `type` is immutable
 *     after create; `active` is NEVER in the edit payload — it has its own
 *     `setRecurringActive`; `last_run` is NEVER written; NO transaction
 *     auto-generation, NO `transactions` write, no RPC, no hard DELETE).
 *   - savings-goal CREATE / EDIT / (soft) DELETE / ADD-MOVEMENT —
 *     STEP 16-G2-D3, via src/services/remoteGoalWrite.ts (direct
 *     `public.goals` INSERT / conditional UPDATE of name·target·deadline·
 *     icon / UPDATE deleted_at, keyed on `(household_id, id)` with a client
 *     `goal-...` id; `saved` is NEVER written directly — deposits and
 *     withdrawals are a `public.goal_movements` INSERT of a signed
 *     `amount_delta`, and the DB `trg_apply_goal_movement` trigger updates
 *     `goals.saved` atomically; the movement `gm-...` id is stable across
 *     retries; NO `transactions` write, no RPC, no hard DELETE).
 *   - loan CREATE / EDIT / (soft) DELETE + loan-payment ADD / (soft) DELETE
 *     — STEP 16-G2-D4, via src/services/remoteLoanWrite.ts (direct
 *     `public.loans` INSERT / conditional UPDATE of name·lender·principal·
 *     annual_rate·term_months·start_date·payment_day·repay_type / UPDATE
 *     deleted_at, keyed on `(household_id, id)` with a client `loan-...`
 *     id; `paid` is NEVER written directly — a repayment is a
 *     `public.loan_payments` INSERT of a client-`splitPayment`-ed
 *     principal_part / interest_part computed from an AUTHORITATIVE
 *     re-SELECT of the loan, and the DB `trg_apply_loan_payment` trigger
 *     moves `loans.paid`; a payment soft-delete reverses it the same way;
 *     the payment `lp-...` id is stable across retries; `principal` cannot
 *     be edited below the current `paid`; NO `transactions` write, no RPC,
 *     no hard DELETE).
 * `card-add`, `budget-add`, `categories`, `planned-add`, `recurring-add`,
 * `goal-add` and `loan-add` are the former `REMOTE_FINANCE_READ_ONLY`
 * routes that now check `REMOTE_FINANCE_WRITE.*` instead. Nothing else is
 * gated.
 */
export const REMOTE_FINANCE_READ_ONLY = true as const;

export const REMOTE_FINANCE_WRITE = {
  transactionCreate: true,
  transactionEdit: true,
  transactionDelete: true,
  cardCreate: true,
  cardEdit: true,
  cardDelete: true,
  budgetCreate: true,
  budgetEdit: true,
  budgetDelete: true,
  categoryCreate: true,
  categoryEdit: true,
  categoryDelete: true,
  categoryReorder: true,
  plannedCreate: true,
  plannedEdit: true,
  plannedDelete: true,
  recurringCreate: true,
  recurringEdit: true,
  recurringToggle: true,
  recurringDelete: true,
  goalCreate: true,
  goalEdit: true,
  goalDelete: true,
  goalAddMovement: true,
  loanCreate: true,
  loanEdit: true,
  loanDelete: true,
  loanAddPayment: true,
  loanDeletePayment: true,
} as const;
