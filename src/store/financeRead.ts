/**
 * Read-only finance adapter for existing UI screens — STEP 16-G1B.
 *
 * The ONE hook every finance-viewing screen should call instead of
 * `useStore()`. Wraps `useRemoteFinance()` (src/store/remoteFinance.tsx)
 * and re-derives the STEP 16-G1A-HARDEN trust condition itself (never
 * assumes the provider's `data` is safe just because it's non-null) —
 * same two-field check `app/remote-data-preview.tsx` uses.
 *
 * Contract (STEP 16-G1B §2):
 *   - No mutation function is returned. There isn't one to return — this
 *     module doesn't import any store mutation, RPC, or AsyncStorage write.
 *   - Never falls back to `useStore()`'s local data for any reason,
 *     trusted or not. `loading`/`error` are real states a screen must
 *     render; they are never silently papered over with local data.
 *   - `status`/`ready` tell a screen whether `transactions`/`cards`/etc.
 *     are trustworthy. While not `ready`, those fields are present (empty
 *     defaults) purely so a screen that forgets to check `status` doesn't
 *     crash on `undefined` — it must still branch on `status` to avoid
 *     showing a false "0건" as if it were confirmed.
 */
import { useMemo } from 'react';

import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS, type CatOrderMap, type CustomCatMap } from '@/data/categories';
import type {
  RemoteBudgetMeta,
  RemoteCardMeta,
  RemoteCategoryMeta,
  RemoteGoalMeta,
  RemoteLoanMeta,
  RemoteLoanPaymentMeta,
  RemotePlannedMeta,
  RemoteRecurringMeta,
  RemoteTransactionMeta,
} from '@/lib/remoteFinanceMapping';
import { composeFinance } from '@/lib/offlineQueue';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import { useRemoteFinance } from '@/store/remoteFinance';
import type { BudgetMap, CreditCard, Goal, Loan, PlannedExpense, RecurringRule, Transaction } from '@/store/types';

export type FinanceReadStatus = 'loading' | 'error' | 'ready';

export interface FinanceReadResult {
  status: FinanceReadStatus;
  /** true only when status === 'ready' — shorthand for the common check. */
  ready: boolean;
  loading: boolean;
  error: string | null;
  readOnly: true;
  source: 'remote';

  transactions: Transaction[];
  /**
   * id -> remote-only metadata (updatedAt concurrency token + createdBy).
   * STEP 16-G2-B. `{}` while not ready. Kept separate from `transactions`
   * so the Transaction domain type stays free of sync metadata.
   */
  transactionMeta: Record<string, RemoteTransactionMeta>;
  cards: CreditCard[];
  /**
   * card id -> remote-only metadata (updatedAt concurrency token + createdBy).
   * STEP 16-G2-C2. `{}` while not ready. Kept separate from `cards` so the
   * CreditCard domain type stays free of sync metadata.
   */
  cardMeta: Record<string, RemoteCardMeta>;
  budgets: BudgetMap;
  /**
   * category_id -> remote-only metadata (updatedAt concurrency token + createdBy).
   * STEP 16-G2-C3-B. `{}` while not ready. Kept separate from `budgets` so the
   * BudgetMap domain type stays a plain category->amount record.
   */
  budgetMeta: Record<string, RemoteBudgetMeta>;
  /**
   * custom category id -> remote-only metadata (updatedAt concurrency token
   * + createdBy). STEP 16-G2-C4-B. `{}` while not ready. Built-in category
   * ids never appear here. Kept separate so the Category domain type stays
   * free of sync metadata.
   */
  categoryMeta: Record<string, RemoteCategoryMeta>;
  recurring: RecurringRule[];
  /**
   * recurring-rule id -> remote-only metadata (updatedAt concurrency token
   * + createdBy). STEP 16-G2-D2. `{}` while not ready. Kept separate from
   * `recurring` so the RecurringRule domain type stays free of sync
   * metadata. Only non-soft-deleted rules appear (unrelated to the rule's
   * own `active` flag).
   */
  recurringMeta: Record<string, RemoteRecurringMeta>;
  planned: PlannedExpense[];
  /**
   * planned-expense id -> remote-only metadata (updatedAt concurrency token
   * + createdBy). STEP 16-G2-D1. `{}` while not ready. Kept separate from
   * `planned` so the PlannedExpense domain type stays free of sync metadata.
   */
  plannedMeta: Record<string, RemotePlannedMeta>;
  goals: Goal[];
  /**
   * goal id -> remote-only metadata (updatedAt concurrency token +
   * createdBy). STEP 16-G2-D3. `{}` while not ready. Kept separate from
   * `goals` so the Goal domain type stays free of sync metadata.
   */
  goalMeta: Record<string, RemoteGoalMeta>;
  loans: Loan[];
  /**
   * loan id -> remote-only metadata (updatedAt concurrency token +
   * createdBy). STEP 16-G2-D4. `{}` while not ready. Kept separate from
   * `loans` so the Loan domain type stays free of sync metadata.
   */
  loanMeta: Record<string, RemoteLoanMeta>;
  /**
   * loan-payment id -> remote-only metadata (updatedAt concurrency token +
   * createdBy). STEP 16-G2-D4. `{}` while not ready. Used to guard a
   * payment soft-delete.
   */
  loanPaymentMeta: Record<string, RemoteLoanPaymentMeta>;
  customCats: CustomCatMap;
  notes: string;
  catOrder: CatOrderMap;

  /**
   * STEP 16-H2-A2: transaction ids that are on screen ONLY because of a
   * durable offline CREATE that hasn't sent yet ("전송 대기"). A superset
   * `transactions`/`transactionMeta` already include the synthetic rows.
   * Empty unless the offline queue is hydrated and has current-scope pending
   * creates the server snapshot doesn't have.
   */
  pendingTransactionIds: ReadonlySet<string>;
  /**
   * STEP 16-H2-A2: pending-create transaction ids whose send hit a TERMINAL
   * failure and are being held for a manual retry ("전송 실패"). Also present
   * in `transactions` — a terminal failure never removes the user's row.
   */
  failedTransactionIds: ReadonlySet<string>;

  /** Manual reload only — no polling, no realtime (STEP 16-G1B §16/§23). */
  refresh: () => Promise<void>;
}

const EMPTY_SLICES = {
  transactions: [] as Transaction[],
  transactionMeta: {} as Record<string, RemoteTransactionMeta>,
  cards: [] as CreditCard[],
  cardMeta: {} as Record<string, RemoteCardMeta>,
  budgets: {} as BudgetMap,
  budgetMeta: {} as Record<string, RemoteBudgetMeta>,
  categoryMeta: {} as Record<string, RemoteCategoryMeta>,
  recurring: [] as RecurringRule[],
  recurringMeta: {} as Record<string, RemoteRecurringMeta>,
  planned: [] as PlannedExpense[],
  plannedMeta: {} as Record<string, RemotePlannedMeta>,
  goals: [] as Goal[],
  goalMeta: {} as Record<string, RemoteGoalMeta>,
  loans: [] as Loan[],
  loanMeta: {} as Record<string, RemoteLoanMeta>,
  loanPaymentMeta: {} as Record<string, RemoteLoanPaymentMeta>,
  customCats: DEFAULT_CUSTOM_CATS,
  notes: '',
  catOrder: DEFAULT_CAT_ORDER,
  pendingTransactionIds: new Set<string>() as ReadonlySet<string>,
  failedTransactionIds: new Set<string>() as ReadonlySet<string>,
};

export function useFinanceRead(): FinanceReadResult {
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { data, error, loadedForUserId, loadedForHouseholdId, refreshRemoteFinance } = useRemoteFinance();
  const {
    pendingTransactionCreateOps,
    failedTransactionIds: providerFailedIds,
    hydrationReady,
  } = usePendingWrites();

  // Same minimum trust condition as app/remote-data-preview.tsx — checked
  // again here rather than trusting any single upstream flag, so a bug in
  // one consumer can't silently make every other screen unsafe too.
  const trusted =
    !!session?.user?.id &&
    !!activeHousehold &&
    !!data &&
    loadedForUserId === session.user.id &&
    loadedForHouseholdId === activeHousehold.id;

  return useMemo<FinanceReadResult>(() => {
    if (trusted && data) {
      // STEP 16-H2-A2: overlay durable offline transaction CREATEs onto the
      // authoritative snapshot. `composeFinance` never mutates `data`; it
      // returns the same reference when nothing applies.
      const { data: composed, pendingIds } =
        hydrationReady && pendingTransactionCreateOps.length > 0
          ? composeFinance(data, pendingTransactionCreateOps)
          : { data, pendingIds: [] as string[] };
      const overlaid = new Set(pendingIds);
      const failed = new Set<string>();
      const pending = new Set<string>();
      for (const id of overlaid) {
        (providerFailedIds.has(id) ? failed : pending).add(id);
      }
      return {
        status: 'ready',
        ready: true,
        loading: false,
        error: null,
        readOnly: true,
        source: 'remote',
        transactions: composed.transactions,
        transactionMeta: composed.transactionMeta,
        pendingTransactionIds: pending,
        failedTransactionIds: failed,
        cards: data.cards,
        cardMeta: data.cardMeta,
        budgets: data.budgets,
        budgetMeta: data.budgetMeta,
        categoryMeta: data.categoryMeta,
        recurring: data.recurring,
        recurringMeta: data.recurringMeta,
        planned: data.planned,
        plannedMeta: data.plannedMeta,
        goals: data.goals,
        goalMeta: data.goalMeta,
        loans: data.loans,
        loanMeta: data.loanMeta,
        loanPaymentMeta: data.loanPaymentMeta,
        customCats: data.customCats,
        notes: data.notes,
        catOrder: data.catOrder,
        refresh: refreshRemoteFinance,
      };
    }
    if (error) {
      return {
        status: 'error',
        ready: false,
        loading: false,
        error,
        readOnly: true,
        source: 'remote',
        ...EMPTY_SLICES,
        refresh: refreshRemoteFinance,
      };
    }
    // Covers the ordinary "still loading" case AND any not-yet-trusted
    // state with no error (e.g. right after a household switch) — never
    // treated as "confirmed empty", only as "not ready yet".
    return {
      status: 'loading',
      ready: false,
      loading: true,
      error: null,
      readOnly: true,
      source: 'remote',
      ...EMPTY_SLICES,
      refresh: refreshRemoteFinance,
    };
  }, [
    trusted,
    data,
    error,
    refreshRemoteFinance,
    hydrationReady,
    pendingTransactionCreateOps,
    providerFailedIds,
  ]);
}
