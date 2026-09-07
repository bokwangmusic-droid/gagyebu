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
import type { RemoteBudgetMeta, RemoteCardMeta, RemoteTransactionMeta } from '@/lib/remoteFinanceMapping';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
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
  recurring: RecurringRule[];
  planned: PlannedExpense[];
  goals: Goal[];
  loans: Loan[];
  customCats: CustomCatMap;
  notes: string;
  catOrder: CatOrderMap;

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
  recurring: [] as RecurringRule[],
  planned: [] as PlannedExpense[],
  goals: [] as Goal[],
  loans: [] as Loan[],
  customCats: DEFAULT_CUSTOM_CATS,
  notes: '',
  catOrder: DEFAULT_CAT_ORDER,
};

export function useFinanceRead(): FinanceReadResult {
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { data, error, loadedForUserId, loadedForHouseholdId, refreshRemoteFinance } = useRemoteFinance();

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
      return {
        status: 'ready',
        ready: true,
        loading: false,
        error: null,
        readOnly: true,
        source: 'remote',
        transactions: data.transactions,
        transactionMeta: data.transactionMeta,
        cards: data.cards,
        cardMeta: data.cardMeta,
        budgets: data.budgets,
        budgetMeta: data.budgetMeta,
        recurring: data.recurring,
        planned: data.planned,
        goals: data.goals,
        loans: data.loans,
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
  }, [trusted, data, error, refreshRemoteFinance]);
}
