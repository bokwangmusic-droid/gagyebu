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
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
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
   * STEP 16-H2-A2: not-yet-sent pending ops that are visible on screen
   * (a CREATE's synthetic row, an UPDATE's overlaid row). Kept for backward
   * compatibility — prefer `pendingTransactionOps` for the row label.
   */
  pendingTransactionIds: ReadonlySet<string>;
  /**
   * STEP 16-H2-A2: visible transaction ids whose send hit a TERMINAL failure
   * and are being held for a manual retry. A terminal failure never removes
   * the user's row (a failed DELETE keeps its server row visible).
   */
  failedTransactionIds: ReadonlySet<string>;
  /**
   * STEP 16-H2-B2: per-visible-transaction offline-op state, for the row
   * label / read-only gate. A not-failed pending DELETE hides its row, so it
   * has NO entry here. `reason` is only set when `failed` is true.
   */
  pendingTransactionOps: ReadonlyMap<
    string,
    { op: 'create' | 'update' | 'delete'; failed: boolean; reason?: WriteConflictReason }
  >;
  /**
   * STEP 16-H2-B2.2: DISPLAY-ONLY rows for a TERMINAL-failed offline UPDATE
   * whose authoritative server row is GONE (deleted on another device). They
   * are NOT in `transactions` — no stats / budget / 합계 / recent calculation
   * ever sees them — but Home / 전체 거래내역 render them read-only so the
   * user's un-sent edit is not silently lost. `reason` drives the failure
   * label. `[]` unless the offline queue is hydrated and has such a record
   * for the current scope.
   */
  failedLocalTransactions: ReadonlyArray<{
    transaction: Transaction;
    op: 'update';
    reason?: WriteConflictReason;
  }>;

  /**
   * STEP 16-H2-C2-A1 — the card list for the CARD-MANAGEMENT screen ONLY:
   * authoritative server cards with a pending UPDATE overlaid, a synthetic row
   * for a pending/failed CREATE, a synthetic row for a failed UPDATE whose
   * server card is gone, minus a not-failed pending DELETE. This is
   * DELIBERATELY separate from `cards` (which stays authoritative-server-only
   * so the transaction card picker, backup and household-import never see an
   * un-sent card — §8/§9/§15). Equals `cards` when there are no card ops.
   */
  cardManagementRows: CreditCard[];
  /**
   * card id -> its pending offline-op state, for the row label / read-only
   * gate on the card-management screen. Mirrors `pendingTransactionOps`.
   * `reason` only set when `failed` is true.
   */
  pendingCardOps: ReadonlyMap<
    string,
    { op: 'create' | 'update' | 'delete'; failed: boolean; reason?: WriteConflictReason }
  >;

  /**
   * STEP 16-H2-C2-B1 — the custom-category list for the CATEGORY-MANAGEMENT
   * screen ONLY: authoritative server `customCats` with a pending UPDATE
   * overlaid, a synthetic entry for a pending/failed CREATE, a synthetic entry
   * for a failed UPDATE whose server row is gone, minus a not-failed pending
   * DELETE. DELIBERATELY separate from `customCats` (which stays
   * authoritative-server-only so every category picker, stats name
   * resolution, backup and household-import never see an un-sent category —
   * §12/§13). Same `{ expense, income }` shape; equals `customCats` when there
   * are no category ops.
   */
  categoryManagementRows: CustomCatMap;
  /**
   * custom category id -> its pending offline-op state, for the row label /
   * read-only gate on the category-management screen. Mirrors `pendingCardOps`,
   * plus (STEP 16-H2-C2-B2 conflict-UX):
   *   - `queueId`        — the durable record's id, so the row's "변경 버리기"
   *                        can call `discardPending(queueId)`.
   *   - `synthetic`      — the row has NO authoritative server category behind
   *                        it (pending/failed CREATE, or a failed UPDATE whose
   *                        server row is gone) -> exclude from the sortable
   *                        list / `saveCategoryOrder` payload.
   *   - `attemptedName`  — for a terminal-failed UPDATE, the name the user
   *                        tried; conflict metadata ONLY (the displayed row is
   *                        the authoritative server name when it still exists).
   * `reason` / `attemptedName` are only set when `failed` is true.
   */
  pendingCategoryOps: ReadonlyMap<
    string,
    {
      op: 'create' | 'update' | 'delete';
      failed: boolean;
      reason?: WriteConflictReason;
      queueId?: string;
      synthetic: boolean;
      attemptedName?: string;
    }
  >;

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
  pendingTransactionOps: new Map() as FinanceReadResult['pendingTransactionOps'],
  failedLocalTransactions: [] as FinanceReadResult['failedLocalTransactions'],
  cardManagementRows: [] as CreditCard[],
  pendingCardOps: new Map() as FinanceReadResult['pendingCardOps'],
  categoryManagementRows: DEFAULT_CUSTOM_CATS,
  pendingCategoryOps: new Map() as FinanceReadResult['pendingCategoryOps'],
};

export function useFinanceRead(): FinanceReadResult {
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { data, error, loadedForUserId, loadedForHouseholdId, refreshRemoteFinance } = useRemoteFinance();
  const {
    pendingTransactionOps: providerOps,
    opByEntity,
    failedReasons,
    failedTransactionIds: providerFailedIds,
    pendingCardOps: providerCardOps,
    cardFailedReasons,
    failedCardIds: providerFailedCardIds,
    pendingCategoryOps: providerCategoryOps,
    categoryFailedReasons,
    failedCategoryIds: providerFailedCategoryIds,
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
      // STEP 16-H2-A2/B1: overlay durable offline transaction CREATE/UPDATE/
      // DELETE ops onto the authoritative snapshot. `composeFinance` never
      // mutates `data`; it returns the same reference when nothing applies.
      // `providerFailedIds` (entity-id set) only changes DELETE behaviour —
      // a failed DELETE keeps its server row visible so it can be labelled.
      const anyOps =
        providerOps.length > 0 || providerCardOps.length > 0 || providerCategoryOps.length > 0;
      const composedResult =
        hydrationReady && anyOps
          ? composeFinance(
              data,
              [...providerOps, ...providerCardOps, ...providerCategoryOps],
              providerFailedIds,
              providerFailedCardIds,
              providerFailedCategoryIds,
            )
          : null;
      const { data: composed, pendingIds, orphanedFailedUpdates } = composedResult ?? {
        data,
        pendingIds: [] as string[],
        orphanedFailedUpdates: [] as Transaction[],
      };
      // STEP 16-H2-C2-A1: card display-only surface. `composeFinance` NEVER
      // put a card row into `composed.cards`; it feeds `cardManagement` only.
      const cardManagementRows = composedResult ? composedResult.cardManagement.rows : data.cards;
      const pendingCardOps = new Map<
        string,
        { op: 'create' | 'update' | 'delete'; failed: boolean; reason?: WriteConflictReason }
      >();
      if (composedResult) {
        for (const [id, op] of composedResult.cardManagement.opById) {
          const isFailed = composedResult.cardManagement.failedIds.has(id);
          pendingCardOps.set(id, {
            op,
            failed: isFailed,
            ...(isFailed ? { reason: cardFailedReasons.get(id) } : {}),
          });
        }
      }
      // STEP 16-H2-C2-B1: custom-category display-only surface. `composeFinance`
      // NEVER folded a category row into `composed.customCats`; it feeds
      // `categoryManagement` only.
      const categoryManagementRows = composedResult
        ? composedResult.categoryManagement.rows
        : data.customCats;
      const pendingCategoryOps = new Map<
        string,
        {
          op: 'create' | 'update' | 'delete';
          failed: boolean;
          reason?: WriteConflictReason;
          queueId?: string;
          synthetic: boolean;
          attemptedName?: string;
        }
      >();
      if (composedResult) {
        const cm = composedResult.categoryManagement;
        for (const [id, op] of cm.opById) {
          const isFailed = cm.failedIds.has(id);
          // `providerCategoryOps` is the durable `PendingWrite[]` — one op per
          // (entity,id) by the dedup rule, so `find` gives the queueId for
          // "변경 버리기".
          const rec = providerCategoryOps.find((o) => o.entityId === id);
          pendingCategoryOps.set(id, {
            op,
            failed: isFailed,
            synthetic: cm.syntheticIds.has(id),
            ...(rec ? { queueId: rec.queueId } : {}),
            ...(isFailed ? { reason: categoryFailedReasons.get(id) } : {}),
            ...(isFailed && cm.attemptedNameById.has(id)
              ? { attemptedName: cm.attemptedNameById.get(id) }
              : {}),
          });
        }
      }
      // Per-visible-transaction offline-op state (STEP 16-H2-B2 §6/§13).
      // `pendingIds` = rows composeFinance kept visible: a CREATE's synthetic
      // row, an UPDATE's overlaid row, and a *failed* DELETE's server row. A
      // not-failed DELETE is hidden, so it never lands here.
      const opStates = new Map<
        string,
        { op: 'create' | 'update' | 'delete'; failed: boolean; reason?: WriteConflictReason }
      >();
      const failed = new Set<string>();
      const pending = new Set<string>();
      for (const id of pendingIds) {
        const isFailed = providerFailedIds.has(id);
        (isFailed ? failed : pending).add(id);
        opStates.set(id, {
          op: opByEntity.get(id) ?? 'create',
          failed: isFailed,
          ...(isFailed ? { reason: failedReasons.get(id) } : {}),
        });
      }
      // STEP 16-H2-B2.2: display-only rows for failed UPDATEs whose server
      // row is gone. `composeFinance` deliberately kept these OUT of
      // `composed.transactions`, so nothing below (or any stats/budget
      // consumer) counts them; only Home / 전체 거래내역 render them.
      const failedLocalTransactions = orphanedFailedUpdates.map((t) => ({
        transaction: t,
        op: 'update' as const,
        reason: failedReasons.get(t.id),
      }));
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
        pendingTransactionOps: opStates,
        failedLocalTransactions,
        cardManagementRows,
        pendingCardOps,
        categoryManagementRows,
        pendingCategoryOps,
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
    providerOps,
    opByEntity,
    failedReasons,
    providerFailedIds,
    providerCardOps,
    cardFailedReasons,
    providerFailedCardIds,
    providerCategoryOps,
    categoryFailedReasons,
    providerFailedCategoryIds,
  ]);
}
