/**
 * STEP 16-G1B / 16-G2-A / 16-G2-B — household finance write gating.
 *
 * `REMOTE_FINANCE_READ_ONLY` stays `true` and keeps its exact original
 * meaning: every OTHER mutation screen still renders <ReadOnlyRouteNotice/>
 * instead of its real form — card-add, budget-add, recurring-add,
 * planned-add, goal-add, loan-add, categories. Those files check this
 * constant directly (not `REMOTE_FINANCE_WRITE`), so they stay closed.
 *
 * `REMOTE_FINANCE_WRITE` is the one greppable place that says which
 * financial writes are open. STEP 16-G2-B opens transaction EDIT and
 * (soft) DELETE alongside CREATE — all three go through
 * src/services/remoteFinanceWrite.ts (direct `public.transactions`
 * INSERT / UPDATE / UPDATE deleted_at; no RPC, no hard DELETE). Everything
 * else — cards, budgets, recurring, planned, goals, loans, custom
 * categories — remains closed.
 */
export const REMOTE_FINANCE_READ_ONLY = true as const;

export const REMOTE_FINANCE_WRITE = {
  transactionCreate: true,
  transactionEdit: true,
  transactionDelete: true,
} as const;
