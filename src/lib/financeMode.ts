/**
 * STEP 16-G1B / STEP 16-G2-A — household finance write gating.
 *
 * `REMOTE_FINANCE_READ_ONLY` stays `true` and keeps its exact original
 * meaning: every mutation screen EXCEPT new-transaction-create still renders
 * <ReadOnlyRouteNotice/> instead of its real form — card-add, budget-add,
 * recurring-add, planned-add, goal-add, loan-add, categories, and
 * transaction EDIT/DELETE. See src/components/ReadOnlyRouteNotice.tsx and
 * the guard at the top of each of those files.
 *
 * `REMOTE_FINANCE_WRITE` is the STEP 16-G2-A addition: the one, greppable
 * place that says which financial writes are actually open. For this STEP
 * that is exactly `transactionCreate` — a single new `public.transactions`
 * row via src/services/remoteFinanceWrite.ts. Editing and deleting a
 * transaction remain closed (`false`), as does everything still governed by
 * `REMOTE_FINANCE_READ_ONLY`.
 */
export const REMOTE_FINANCE_READ_ONLY = true as const;

export const REMOTE_FINANCE_WRITE = {
  transactionCreate: true,
  transactionEdit: false,
  transactionDelete: false,
} as const;
