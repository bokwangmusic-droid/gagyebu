/**
 * STEP 16-G1B / 16-G2-A / 16-G2-B / 16-G2-C2 — household finance write gating.
 *
 * `REMOTE_FINANCE_READ_ONLY` stays `true` and keeps its exact original
 * meaning: every OTHER mutation screen still renders <ReadOnlyRouteNotice/>
 * instead of its real form — budget-add, recurring-add, planned-add,
 * goal-add, loan-add, categories. Those files check this constant directly
 * (not `REMOTE_FINANCE_WRITE`), so they stay closed.
 *
 * `REMOTE_FINANCE_WRITE` is the one greppable place that says which
 * financial writes are open:
 *   - transaction CREATE / EDIT / (soft) DELETE — STEP 16-G2-A / 16-G2-B,
 *     via src/services/remoteFinanceWrite.ts.
 *   - card CREATE / EDIT / (soft) DELETE — STEP 16-G2-C2, via
 *     src/services/remoteCardWrite.ts (direct `public.cards` INSERT /
 *     UPDATE / UPDATE deleted_at; no RPC, no hard DELETE).
 * `card-add` is the only former `REMOTE_FINANCE_READ_ONLY` route that now
 * checks `REMOTE_FINANCE_WRITE.cardCreate` / `.cardEdit` instead.
 * Everything else — budgets, recurring, planned, goals, loans, custom
 * categories — remains closed.
 */
export const REMOTE_FINANCE_READ_ONLY = true as const;

export const REMOTE_FINANCE_WRITE = {
  transactionCreate: true,
  transactionEdit: true,
  transactionDelete: true,
  cardCreate: true,
  cardEdit: true,
  cardDelete: true,
} as const;
