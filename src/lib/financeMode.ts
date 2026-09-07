/**
 * STEP 16-G1B / 16-G2-A / 16-G2-B / 16-G2-C2 / 16-G2-C3-B / 16-G2-C4-B /
 * 16-G2-D1 — household finance write gating.
 *
 * `REMOTE_FINANCE_READ_ONLY` stays `true` and keeps its exact original
 * meaning: every OTHER mutation screen still renders <ReadOnlyRouteNotice/>
 * instead of its real form — recurring-add, goal-add, loan-add. Those
 * files check this constant directly (not `REMOTE_FINANCE_WRITE`), so they
 * stay closed. (`planned-add` no longer checks it — see below.)
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
 * `card-add`, `budget-add`, `categories` and `planned-add` are the former
 * `REMOTE_FINANCE_READ_ONLY` routes that now check `REMOTE_FINANCE_WRITE.*`
 * instead. Everything else — recurring, goals, loans — remains closed.
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
} as const;
