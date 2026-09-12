/**
 * Pending (offline) finance writes — STEP 16-H2-A2.
 *
 * A thin React shell over `createPendingWriteCoordinator`
 * (src/services/offlineQueue/coordinator.ts). It:
 *   - owns ONE coordinator (which owns ONE durable queue controller),
 *   - feeds it live scope / remote-readiness / server-snapshot values via
 *     refs (never captured stale),
 *   - re-renders when the coordinator's state changes,
 *   - wires the minimal flush triggers: hydrate, remote-ready, AppState
 *     foreground. Backoff + enqueue-triggered flush live in the coordinator.
 *
 * It NEVER owns or copies the authoritative snapshot — that stays in
 * `RemoteFinanceProvider`. This provider only holds durable UNSENT
 * operations. Transaction CREATE (H2-A2) + UPDATE + soft DELETE (H2-B2).
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { Category } from '@/data/categories';
import type { PendingWrite } from '@/lib/offlineQueue';
import type { NewBudgetDraft } from '@/lib/remoteBudgetWriteMapping';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewCustomCategoryDraft } from '@/lib/remoteCategoryWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { NewGoalDraft, NewGoalMovementDraft } from '@/lib/remoteGoalWriteMapping';
import type { NewPlannedExpenseDraft } from '@/lib/remotePlannedWriteMapping';
import type { NewRecurringDraft } from '@/lib/remoteRecurringWriteMapping';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
  type DiscardOutcome,
  type EnqueueOutcome,
  type Hydration,
  type PendingOpKind,
} from '@/services/offlineQueue/coordinator';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { useRemoteFinance } from '@/store/remoteFinance';
import type { CreditCard, Goal, PlannedExpense, RecurringRule, Transaction } from '@/store/types';

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_OPS: PendingWrite[] = [];
const EMPTY_KIND_MAP: ReadonlyMap<string, PendingOpKind> = new Map();
const EMPTY_REASON_MAP: ReadonlyMap<string, WriteConflictReason | undefined> = new Map();

interface PendingFinanceValue {
  hydration: Hydration;
  hydrationReady: boolean;
  /** Current-scope transaction ops (create/update/delete, incl. terminal-failed) for the overlay. */
  pendingTransactionOps: PendingWrite[];
  /** entity id -> op kind of its current-scope pending/failed op. */
  opByEntity: ReadonlyMap<string, PendingOpKind>;
  /** entity id -> original service reason for a terminal failure. */
  failedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  /** entity ids of not-yet-sent pending ops (not failed). */
  pendingTransactionIds: ReadonlySet<string>;
  /** entity ids of terminal-failed, held ops. */
  failedTransactionIds: ReadonlySet<string>;
  pendingCount: number;
  lastError: string | null;
  /** Try a direct write's transport failure as a durable offline enqueue. */
  enqueueTransactionCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
  }) => Promise<EnqueueOutcome>;
  enqueueTransactionUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
    expectedUpdatedAt: string;
    originalRawCardId: string | null;
  }) => Promise<EnqueueOutcome>;
  enqueueTransactionDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-A1 — current-scope CARD ops (create/update/delete, incl.
   *  terminal-failed) for the card-management overlay. Bare card-id keys. */
  pendingCardOps: PendingWrite[];
  cardOpByEntity: ReadonlyMap<string, PendingOpKind>;
  cardFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingCardIds: ReadonlySet<string>;
  failedCardIds: ReadonlySet<string>;
  enqueueCardCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCardDraft;
  }) => Promise<EnqueueOutcome>;
  enqueueCardUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCardDraft;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueueCardDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-B1 — current-scope CUSTOM-CATEGORY ops (create/update/delete,
   *  incl. terminal-failed) for the category-management overlay. Bare
   *  category-id keys. `enqueueCategoryDelete` has an engine path but NO UI
   *  wiring yet (blocked on the Budget queue, §30). */
  pendingCategoryOps: PendingWrite[];
  categoryOpByEntity: ReadonlyMap<string, PendingOpKind>;
  categoryFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingCategoryIds: ReadonlySet<string>;
  failedCategoryIds: ReadonlySet<string>;
  enqueueCategoryCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCustomCategoryDraft;
  }) => Promise<EnqueueOutcome>;
  enqueueCategoryUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCustomCategoryDraft;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueueCategoryDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-BUDGET A1 — current-scope BUDGET ops (create/update/delete,
   *  incl. terminal-failed), bare category-id keys. ENGINE ONLY — no UI call
   *  site enqueues these yet. */
  pendingBudgetOps: PendingWrite[];
  budgetOpByEntity: ReadonlyMap<string, PendingOpKind>;
  budgetFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingBudgetIds: ReadonlySet<string>;
  failedBudgetIds: ReadonlySet<string>;
  enqueueBudgetCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewBudgetDraft;
  }) => Promise<EnqueueOutcome>;
  enqueueBudgetUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewBudgetDraft;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueueBudgetDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2 A4.2 — current-scope COMPOSITE category+budget delete ops
   *  (only `op: 'delete'`, incl. terminal-failed), bare category-id keys,
   *  `categoryBudget:` failed-state namespace. Not wired to `financeRead` /
   *  any screen yet (projection is A4.3). */
  pendingCategoryBudgetOps: PendingWrite[];
  categoryBudgetOpByEntity: ReadonlyMap<string, PendingOpKind>;
  categoryBudgetFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingCategoryBudgetIds: ReadonlySet<string>;
  failedCategoryBudgetIds: ReadonlySet<string>;
  enqueueCategoryBudgetDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedCategoryUpdatedAt: string;
    expectedBudgetUpdatedAt: string | null;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-E1 — current-scope PLANNED-EXPENSE ops (create/update/delete,
   *  incl. terminal-failed), bare planned-id keys. ENGINE ONLY — no UI call
   *  site enqueues these yet (E2). */
  pendingPlannedOps: PendingWrite[];
  plannedOpByEntity: ReadonlyMap<string, PendingOpKind>;
  plannedFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingPlannedIds: ReadonlySet<string>;
  failedPlannedIds: ReadonlySet<string>;
  enqueuePlannedCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewPlannedExpenseDraft;
  }) => Promise<EnqueueOutcome>;
  enqueuePlannedUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewPlannedExpenseDraft;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueuePlannedDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-F1 — current-scope RECURRING-RULE ops (create/update/delete,
   *  incl. terminal-failed), bare recurring-id keys. A FULL update and an
   *  ACTIVE toggle for the same id share one `op:'update'` entry here — the
   *  discriminating `updateKind` lives on the raw `PendingWrite`. ENGINE
   *  ONLY — no UI call site enqueues these yet (F2). */
  pendingRecurringOps: PendingWrite[];
  recurringOpByEntity: ReadonlyMap<string, PendingOpKind>;
  recurringFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingRecurringIds: ReadonlySet<string>;
  failedRecurringIds: ReadonlySet<string>;
  enqueueRecurringCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewRecurringDraft;
  }) => Promise<EnqueueOutcome>;
  enqueueRecurringUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewRecurringDraft;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueueRecurringActiveUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    active: boolean;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueueRecurringDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-G1 — current-scope SAVINGS-GOAL ops (create/update/delete,
   *  incl. terminal-failed), bare goal-id keys. `saved` / deposit-withdraw
   *  movements are OUT OF SCOPE — no enqueue method exists for them. ENGINE
   *  ONLY — no UI call site enqueues these yet. */
  pendingGoalOps: PendingWrite[];
  goalOpByEntity: ReadonlyMap<string, PendingOpKind>;
  goalFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingGoalIds: ReadonlySet<string>;
  failedGoalIds: ReadonlySet<string>;
  enqueueGoalCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewGoalDraft;
  }) => Promise<EnqueueOutcome>;
  enqueueGoalUpdate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewGoalDraft;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  enqueueGoalDelete: (args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-G3 — current-scope GOAL-MOVEMENT ops (deposit/withdraw,
   *  incl. terminal-failed), bare MOVEMENT-id keys (the ledger row's OWN
   *  id — NOT the goal id; that lives on the raw `PendingWrite.goalId`). */
  pendingGoalMovementOps: PendingWrite[];
  goalMovementOpByEntity: ReadonlyMap<string, PendingOpKind>;
  goalMovementFailedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  pendingGoalMovementIds: ReadonlySet<string>;
  failedGoalMovementIds: ReadonlySet<string>;
  enqueueGoalMovementCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    goalId: string;
    payload: NewGoalMovementDraft;
    expectedBaselineSaved: number;
  }) => Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-B2 conflict-UX — drop ONE queued record by `queueId`
   *  ("변경 버리기"). NOT a server delete; scope-guarded; awaits persistence. */
  discardPending: (queueId: string) => Promise<DiscardOutcome>;
  /** Ask for a flush now (e.g. pull-to-refresh). `includeFailed` retries held ops. */
  requestFlush: (opts?: { includeFailed?: boolean }) => void;
}

const PendingFinanceContext = createContext<PendingFinanceValue | null>(null);

export function PendingWritesProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const rf = useRemoteFinance();

  const userId = session?.user?.id ?? null;
  const householdId = activeHousehold?.id ?? null;
  const scope: CoordinatorScope | null =
    userId && householdId ? { userId, householdId } : null;
  const scopeKey = scope ? `${scope.userId}:${scope.householdId}` : null;

  const remoteReady =
    !!rf.data &&
    !!userId &&
    !!householdId &&
    rf.loadedForUserId === userId &&
    rf.loadedForHouseholdId === householdId;

  // ---- live refs (read at use-time by the coordinator, never captured) ----
  const scopeRef = useRef<CoordinatorScope | null>(scope);
  scopeRef.current = scope;
  const remoteReadyRef = useRef(remoteReady);
  remoteReadyRef.current = remoteReady;
  const refreshRef = useRef(rf.refreshRemoteFinance);
  refreshRef.current = rf.refreshRemoteFinance;

  const knownCardIds = useMemo<ReadonlySet<string>>(
    () => new Set((rf.data?.cards ?? []).map((c) => c.id)),
    [rf.data?.cards],
  );
  const knownCardIdsRef = useRef<ReadonlySet<string>>(knownCardIds);
  knownCardIdsRef.current = knownCardIds;

  const serverTxns = useMemo<ReadonlyMap<string, Transaction>>(
    () => new Map((rf.data?.transactions ?? []).map((t) => [t.id, t])),
    [rf.data?.transactions],
  );
  const serverTxnsRef = useRef<ReadonlyMap<string, Transaction>>(serverTxns);
  serverTxnsRef.current = serverTxns;

  const serverCards = useMemo<ReadonlyMap<string, CreditCard>>(
    () => new Map((rf.data?.cards ?? []).map((c) => [c.id, c])),
    [rf.data?.cards],
  );
  const serverCardsRef = useRef<ReadonlyMap<string, CreditCard>>(serverCards);
  serverCardsRef.current = serverCards;

  const serverCategories = useMemo<ReadonlyMap<string, Category>>(
    () =>
      new Map(
        [
          ...(rf.data?.customCats.expense ?? []),
          ...(rf.data?.customCats.income ?? []),
        ].map((c) => [c.id, c]),
      ),
    [rf.data?.customCats],
  );
  const serverCategoriesRef = useRef<ReadonlyMap<string, Category>>(serverCategories);
  serverCategoriesRef.current = serverCategories;

  const serverBudgets = useMemo<ReadonlyMap<string, number>>(
    () => new Map(Object.entries(rf.data?.budgets ?? {})),
    [rf.data?.budgets],
  );
  const serverBudgetsRef = useRef<ReadonlyMap<string, number>>(serverBudgets);
  serverBudgetsRef.current = serverBudgets;

  const serverPlanned = useMemo<ReadonlyMap<string, PlannedExpense>>(
    () => new Map((rf.data?.planned ?? []).map((p) => [p.id, p])),
    [rf.data?.planned],
  );
  const serverPlannedRef = useRef<ReadonlyMap<string, PlannedExpense>>(serverPlanned);
  serverPlannedRef.current = serverPlanned;

  const serverRecurring = useMemo<ReadonlyMap<string, RecurringRule>>(
    () => new Map((rf.data?.recurring ?? []).map((r) => [r.id, r])),
    [rf.data?.recurring],
  );
  const serverRecurringRef = useRef<ReadonlyMap<string, RecurringRule>>(serverRecurring);
  serverRecurringRef.current = serverRecurring;

  const serverGoals = useMemo<ReadonlyMap<string, Goal>>(
    () => new Map((rf.data?.goals ?? []).map((g) => [g.id, g])),
    [rf.data?.goals],
  );
  const serverGoalsRef = useRef<ReadonlyMap<string, Goal>>(serverGoals);
  serverGoalsRef.current = serverGoals;

  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const coordRef = useRef<ReturnType<typeof createPendingWriteCoordinator> | null>(null);
  if (coordRef.current == null) {
    coordRef.current = createPendingWriteCoordinator({
      getScope: () => scopeRef.current,
      getRemoteReady: () => remoteReadyRef.current,
      getKnownCardIds: () => knownCardIdsRef.current,
      getServerTransactions: () => serverTxnsRef.current,
      getServerCards: () => serverCardsRef.current,
      getServerCategories: () => serverCategoriesRef.current,
      getServerBudgets: () => serverBudgetsRef.current,
      getServerPlanned: () => serverPlannedRef.current,
      getServerRecurring: () => serverRecurringRef.current,
      getServerGoals: () => serverGoalsRef.current,
      requestRefresh: () => refreshRef.current(),
      onChange: () => forceRender(),
    });
  }
  const coord = coordRef.current;

  // ---- hydrate once; dispose on unmount ----
  useEffect(() => {
    void coord.hydrate();
    return () => coord.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- scope wiring ----
  useEffect(() => {
    coord.setScope(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // ---- Trigger A/B: hydrated + valid scope + remote snapshot trusted ----
  const hydration = coord.getState().hydration;
  useEffect(() => {
    if (scopeKey && remoteReady && hydration === 'ready') {
      coord.requestFlush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, remoteReady, hydration]);

  // ---- AppState foreground: retry hydrate if failed, then flush ----
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && (prev === 'background' || prev === 'inactive')) {
        if (coord.getState().hydration === 'failed') void coord.hydrate();
        coord.requestFlush();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = coord.getState();
  const value = useMemo<PendingFinanceValue>(
    () => ({
      hydration: state.hydration,
      hydrationReady: state.hydration === 'ready',
      pendingTransactionOps: state.scopeOps.length > 0 ? state.scopeOps : EMPTY_OPS,
      opByEntity: state.opByEntity.size > 0 ? state.opByEntity : EMPTY_KIND_MAP,
      failedReasons: state.failedReasons.size > 0 ? state.failedReasons : EMPTY_REASON_MAP,
      pendingTransactionIds: state.pendingIds.size > 0 ? state.pendingIds : EMPTY_SET,
      failedTransactionIds: state.failedIds.size > 0 ? state.failedIds : EMPTY_SET,
      pendingCardOps: state.card.scopeOps.length > 0 ? state.card.scopeOps : EMPTY_OPS,
      cardOpByEntity: state.card.opByEntity.size > 0 ? state.card.opByEntity : EMPTY_KIND_MAP,
      cardFailedReasons: state.card.failedReasons.size > 0 ? state.card.failedReasons : EMPTY_REASON_MAP,
      pendingCardIds: state.card.pendingIds.size > 0 ? state.card.pendingIds : EMPTY_SET,
      failedCardIds: state.card.failedIds.size > 0 ? state.card.failedIds : EMPTY_SET,
      pendingCategoryOps: state.category.scopeOps.length > 0 ? state.category.scopeOps : EMPTY_OPS,
      categoryOpByEntity: state.category.opByEntity.size > 0 ? state.category.opByEntity : EMPTY_KIND_MAP,
      categoryFailedReasons:
        state.category.failedReasons.size > 0 ? state.category.failedReasons : EMPTY_REASON_MAP,
      pendingCategoryIds: state.category.pendingIds.size > 0 ? state.category.pendingIds : EMPTY_SET,
      failedCategoryIds: state.category.failedIds.size > 0 ? state.category.failedIds : EMPTY_SET,
      pendingBudgetOps: state.budget.scopeOps.length > 0 ? state.budget.scopeOps : EMPTY_OPS,
      budgetOpByEntity: state.budget.opByEntity.size > 0 ? state.budget.opByEntity : EMPTY_KIND_MAP,
      budgetFailedReasons:
        state.budget.failedReasons.size > 0 ? state.budget.failedReasons : EMPTY_REASON_MAP,
      pendingBudgetIds: state.budget.pendingIds.size > 0 ? state.budget.pendingIds : EMPTY_SET,
      failedBudgetIds: state.budget.failedIds.size > 0 ? state.budget.failedIds : EMPTY_SET,
      pendingCategoryBudgetOps:
        state.categoryBudget.scopeOps.length > 0 ? state.categoryBudget.scopeOps : EMPTY_OPS,
      categoryBudgetOpByEntity:
        state.categoryBudget.opByEntity.size > 0 ? state.categoryBudget.opByEntity : EMPTY_KIND_MAP,
      categoryBudgetFailedReasons:
        state.categoryBudget.failedReasons.size > 0
          ? state.categoryBudget.failedReasons
          : EMPTY_REASON_MAP,
      pendingCategoryBudgetIds:
        state.categoryBudget.pendingIds.size > 0 ? state.categoryBudget.pendingIds : EMPTY_SET,
      failedCategoryBudgetIds:
        state.categoryBudget.failedIds.size > 0 ? state.categoryBudget.failedIds : EMPTY_SET,
      pendingPlannedOps: state.planned.scopeOps.length > 0 ? state.planned.scopeOps : EMPTY_OPS,
      plannedOpByEntity:
        state.planned.opByEntity.size > 0 ? state.planned.opByEntity : EMPTY_KIND_MAP,
      plannedFailedReasons:
        state.planned.failedReasons.size > 0 ? state.planned.failedReasons : EMPTY_REASON_MAP,
      pendingPlannedIds: state.planned.pendingIds.size > 0 ? state.planned.pendingIds : EMPTY_SET,
      failedPlannedIds: state.planned.failedIds.size > 0 ? state.planned.failedIds : EMPTY_SET,
      pendingRecurringOps: state.recurring.scopeOps.length > 0 ? state.recurring.scopeOps : EMPTY_OPS,
      recurringOpByEntity:
        state.recurring.opByEntity.size > 0 ? state.recurring.opByEntity : EMPTY_KIND_MAP,
      recurringFailedReasons:
        state.recurring.failedReasons.size > 0 ? state.recurring.failedReasons : EMPTY_REASON_MAP,
      pendingRecurringIds:
        state.recurring.pendingIds.size > 0 ? state.recurring.pendingIds : EMPTY_SET,
      failedRecurringIds: state.recurring.failedIds.size > 0 ? state.recurring.failedIds : EMPTY_SET,
      pendingGoalOps: state.goal.scopeOps.length > 0 ? state.goal.scopeOps : EMPTY_OPS,
      goalOpByEntity: state.goal.opByEntity.size > 0 ? state.goal.opByEntity : EMPTY_KIND_MAP,
      goalFailedReasons:
        state.goal.failedReasons.size > 0 ? state.goal.failedReasons : EMPTY_REASON_MAP,
      pendingGoalIds: state.goal.pendingIds.size > 0 ? state.goal.pendingIds : EMPTY_SET,
      failedGoalIds: state.goal.failedIds.size > 0 ? state.goal.failedIds : EMPTY_SET,
      pendingGoalMovementOps:
        state.goalMovement.scopeOps.length > 0 ? state.goalMovement.scopeOps : EMPTY_OPS,
      goalMovementOpByEntity:
        state.goalMovement.opByEntity.size > 0 ? state.goalMovement.opByEntity : EMPTY_KIND_MAP,
      goalMovementFailedReasons:
        state.goalMovement.failedReasons.size > 0 ? state.goalMovement.failedReasons : EMPTY_REASON_MAP,
      pendingGoalMovementIds:
        state.goalMovement.pendingIds.size > 0 ? state.goalMovement.pendingIds : EMPTY_SET,
      failedGoalMovementIds:
        state.goalMovement.failedIds.size > 0 ? state.goalMovement.failedIds : EMPTY_SET,
      pendingCount: state.pendingCount,
      lastError: state.lastError,
      enqueueTransactionCreate: coord.enqueueTransactionCreate,
      enqueueTransactionUpdate: coord.enqueueTransactionUpdate,
      enqueueTransactionDelete: coord.enqueueTransactionDelete,
      enqueueCardCreate: coord.enqueueCardCreate,
      enqueueCardUpdate: coord.enqueueCardUpdate,
      enqueueCardDelete: coord.enqueueCardDelete,
      enqueueCategoryCreate: coord.enqueueCategoryCreate,
      enqueueCategoryUpdate: coord.enqueueCategoryUpdate,
      enqueueCategoryDelete: coord.enqueueCategoryDelete,
      enqueueBudgetCreate: coord.enqueueBudgetCreate,
      enqueueBudgetUpdate: coord.enqueueBudgetUpdate,
      enqueueBudgetDelete: coord.enqueueBudgetDelete,
      enqueueCategoryBudgetDelete: coord.enqueueCategoryBudgetDelete,
      enqueuePlannedCreate: coord.enqueuePlannedCreate,
      enqueuePlannedUpdate: coord.enqueuePlannedUpdate,
      enqueuePlannedDelete: coord.enqueuePlannedDelete,
      enqueueRecurringCreate: coord.enqueueRecurringCreate,
      enqueueRecurringUpdate: coord.enqueueRecurringUpdate,
      enqueueRecurringActiveUpdate: coord.enqueueRecurringActiveUpdate,
      enqueueRecurringDelete: coord.enqueueRecurringDelete,
      enqueueGoalCreate: coord.enqueueGoalCreate,
      enqueueGoalUpdate: coord.enqueueGoalUpdate,
      enqueueGoalDelete: coord.enqueueGoalDelete,
      enqueueGoalMovementCreate: coord.enqueueGoalMovementCreate,
      discardPending: coord.discardPending,
      requestFlush: coord.requestFlush,
    }),
    // state is a fresh object each render; that's exactly when something changed
    [state, coord],
  );

  return (
    <PendingFinanceContext.Provider value={value}>{children}</PendingFinanceContext.Provider>
  );
}

export function usePendingWrites(): PendingFinanceValue {
  const ctx = useContext(PendingFinanceContext);
  if (!ctx) throw new Error('usePendingWrites must be used within <PendingWritesProvider>');
  return ctx;
}
