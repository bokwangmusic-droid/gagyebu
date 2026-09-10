/**
 * Offline Write Queue coordinator — STEP 16-H2-A2.
 *
 * The NON-REACT brain that wires the H2-A1 pieces (`createQueueController` +
 * `createWriteQueueFlusher` + `runPendingWrite`) into the app lifecycle:
 * hydrate, enqueue, flush, ack-after-refresh, terminal retention, and
 * transport backoff. `src/store/pendingFinance.tsx` is a thin React shell
 * over this — everything decidable is here so it can be unit-tested with
 * fakes (fake timers, fake refresh, fake server snapshot).
 *
 * Scope of H2-A2: transaction CREATE only.
 *
 * Key invariants:
 *  - A `settled` op is NEVER durably removed until an authoritative refresh
 *    shows its `entityId` in the trusted server snapshot (§11). A refresh
 *    that does NOT show it puts the op back on the normal queue to replay
 *    (the write service's 23505 reconcile makes the replay idempotent).
 *  - A `terminal` op is RETAINED (kept in the queue, shown to the user as
 *    "전송 실패") and excluded from auto-retry — user must ask (§12).
 *  - A `transport` halt schedules a bounded backoff retry (§10).
 *  - A scope change / dispose cancels timers and drops in-memory scope
 *    state; the durable queue is never wiped (§16).
 */
import {
  MAX_PENDING_WRITES,
  computeBackoffDelay,
  enqueuePendingWrite,
  makePendingBudgetCreate,
  makePendingBudgetDelete,
  makePendingBudgetUpdate,
  makePendingCardCreate,
  makePendingCardDelete,
  makePendingCardUpdate,
  makePendingCategoryCreate,
  makePendingCategoryDelete,
  makePendingCategoryUpdate,
  makePendingTransactionCreate,
  makePendingTransactionDelete,
  makePendingTransactionUpdate,
  opsForScope,
  serverBudgetConfirmsUpdate,
  serverCardConfirmsUpdate,
  serverCategoryConfirmsUpdate,
  serverRowConfirmsUpdate,
  type PendingEntity,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { Category } from '@/data/categories';
import type { NewBudgetDraft } from '@/lib/remoteBudgetWriteMapping';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewCustomCategoryDraft } from '@/lib/remoteCategoryWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
import {
  createQueueController,
  type QueueStorage,
} from '@/services/offlineQueue/persistence';
import {
  createWriteQueueFlusher,
  type FlushScope,
} from '@/services/offlineQueue/flusher';
import { runPendingWrite, type RunOpDeps } from '@/services/offlineQueue/runOp';
import type { CreditCard, Transaction } from '@/store/types';

/** STEP 16-H2-C2-A1 §21 — internal state is keyed by `${entity}:${entityId}`,
 *  NOT bare `entityId`, so a card op and a transaction op that happen to
 *  share an id can never corrupt each other's failed / ack / reason state. */
const opKey = (entity: PendingEntity, entityId: string): string => `${entity}:${entityId}`;

export type Hydration = 'idle' | 'loading' | 'ready' | 'failed';

export interface CoordinatorScope {
  userId: string;
  householdId: string;
}

export type PendingOpKind = 'create' | 'update' | 'delete';

/** Per-entity view of the current scope's pending/failed ops. Keys are bare
 *  `entityId` (safe WITHIN one entity). */
export interface CoordinatorEntityState {
  /** Current-scope ops for this entity (FIFO). Includes terminal-failed. */
  scopeOps: PendingWrite[];
  /** entity ids still waiting to send (not failed). */
  pendingIds: ReadonlySet<string>;
  /** entity ids that hit a terminal failure and are held. */
  failedIds: ReadonlySet<string>;
  /** entity id -> op kind of its current-scope pending/failed op. */
  opByEntity: ReadonlyMap<string, PendingOpKind>;
  /** entity id -> ORIGINAL service reason for a terminal failure. */
  failedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
}

export interface CoordinatorState {
  hydration: Hydration;
  /** === TRANSACTION view (unchanged public contract) === */
  /** Current-scope TRANSACTION ops (FIFO). Includes terminal-failed. */
  scopeOps: PendingWrite[];
  pendingIds: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
  opByEntity: ReadonlyMap<string, PendingOpKind>;
  failedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
  /** STEP 16-H2-C2-A1 — the CARD view (bare card-id keys). */
  card: CoordinatorEntityState;
  /** STEP 16-H2-C2-B1 — the CUSTOM-CATEGORY view (bare category-id keys). */
  category: CoordinatorEntityState;
  /** STEP 16-H2-C2-BUDGET A1 — the BUDGET view (bare category-id keys — a
   *  budget's natural key IS the category_id, same key space as `category`
   *  but a structurally separate entity/map). */
  budget: CoordinatorEntityState;
  /** Total pending ops across ALL entities in the current scope (§28 — the
   *  future household-import guard must see cards + categories + budgets
   *  too). */
  pendingCount: number;
  lastError: string | null;
  flushing: boolean;
}

export type EnqueueOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-hydrated' | 'persist' | 'cap' | 'existing-pending' };

type Timer = ReturnType<typeof setTimeout>;

export interface CoordinatorDeps {
  storage?: QueueStorage;
  /** Live getter — the current `(userId, householdId)` or `null`. */
  getScope: () => CoordinatorScope | null;
  /** Live getter — is the remote snapshot trusted for the current scope? */
  getRemoteReady: () => boolean;
  /** Live getter — the household's current live card ids (for the dangling-card guard). */
  getKnownCardIds: () => ReadonlySet<string>;
  /**
   * Live getter — the current trusted server snapshot's ACTIVE transactions,
   * keyed by id. Used for the ack confirmation: CREATE needs "id present",
   * DELETE needs "id absent", UPDATE needs "row present AND its fields match
   * the queued draft" (STEP 16-H2-B2 §16/§17).
   */
  getServerTransactions: () => ReadonlyMap<string, Transaction>;
  /**
   * Live getter — the trusted server snapshot's ACTIVE cards, keyed by id.
   * STEP 16-H2-C2-A1 §22/§23/§24: card CREATE ack = id present AND fields
   * match; card UPDATE ack = row present AND fields match; card DELETE ack =
   * id absent (the read model already excludes soft-deleted cards).
   */
  getServerCards: () => ReadonlyMap<string, CreditCard>;
  /**
   * Live getter — the trusted server snapshot's ACTIVE custom categories,
   * keyed by id (both types flattened). STEP 16-H2-C2-B1 §24–§27: category
   * CREATE ack = id present AND fields match; UPDATE ack = row present AND
   * fields match; DELETE ack = id absent (the read model already excludes
   * soft-deleted categories).
   */
  getServerCategories: () => ReadonlyMap<string, Category>;
  /**
   * Live getter — the trusted server snapshot's ACTIVE budgets, keyed by
   * category_id (bare `RemoteFinanceData.budgets` values — a plain number,
   * no row object). STEP 16-H2-C2-BUDGET A1: CREATE/UPDATE ack = category
   * present AND amount matches the queued draft; DELETE ack = category
   * absent (the read model already excludes soft-deleted budgets).
   */
  getServerBudgets: () => ReadonlyMap<string, number>;
  /** Trigger one authoritative refresh (B1). Resolves when it has committed. */
  requestRefresh: () => Promise<void>;
  /** Ask the React shell to re-read `getState()`. */
  onChange: () => void;
  /** Test injections — forwarded to `runPendingWrite`. */
  createTransaction?: RunOpDeps['createTransaction'];
  updateTransaction?: RunOpDeps['updateTransaction'];
  softDeleteTransaction?: RunOpDeps['softDeleteTransaction'];
  createCard?: RunOpDeps['createCard'];
  updateCard?: RunOpDeps['updateCard'];
  softDeleteCard?: RunOpDeps['softDeleteCard'];
  createCategory?: RunOpDeps['createCategory'];
  updateCategory?: RunOpDeps['updateCategory'];
  softDeleteCategory?: RunOpDeps['softDeleteCategory'];
  saveBudget?: RunOpDeps['saveBudget'];
  softDeleteBudget?: RunOpDeps['softDeleteBudget'];
  /** Test injection — defaults to `setTimeout` / `clearTimeout`. */
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (t: Timer) => void;
  /** Test injection — a settle yield after `requestRefresh()` so the shell's
   *  server-id ref can update. Defaults to a `setTimeout(0)`. */
  yieldToShell?: () => Promise<void>;
}

export interface PendingWriteCoordinator {
  hydrate(): Promise<void>;
  setScope(scope: CoordinatorScope | null): void;
  enqueueTransactionCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
  }): Promise<EnqueueOutcome>;
  /**
   * STEP 16-H2-B2 — `expectedUpdatedAt` / `originalRawCardId` are FROZEN by
   * the caller from the snapshot the user opened the edit against. The
   * coordinator stores them verbatim; it NEVER re-reads a newer token.
   */
  enqueueTransactionUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
    expectedUpdatedAt: string;
    originalRawCardId: string | null;
  }): Promise<EnqueueOutcome>;
  enqueueTransactionDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-A1 — card ops. `expectedUpdatedAt` is FROZEN by the caller
   *  from the `cardMeta.updatedAt` the edit screen opened against; stored
   *  verbatim, NEVER re-read. */
  enqueueCardCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCardDraft;
  }): Promise<EnqueueOutcome>;
  enqueueCardUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCardDraft;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  enqueueCardDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-B1 — custom-category ops. `expectedUpdatedAt` is FROZEN by
   *  the caller from the `categoryMeta.updatedAt` the edit sheet opened
   *  against; stored verbatim, NEVER re-read. (DELETE has an engine path but
   *  no UI enqueue yet — blocked on the Budget queue, §30.) */
  enqueueCategoryCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCustomCategoryDraft;
  }): Promise<EnqueueOutcome>;
  enqueueCategoryUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCustomCategoryDraft;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  enqueueCategoryDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  /** STEP 16-H2-C2-BUDGET A1 — budget ops. ENGINE ONLY — no UI call site
   *  enqueues these yet. `entityId` is the category_id (budget's natural
   *  key — no separate client-generated budget id). `expectedUpdatedAt` is
   *  FROZEN by the caller from the `budgetMeta.updatedAt` the form snapshot
   *  opened against; stored verbatim, NEVER re-read. */
  enqueueBudgetCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewBudgetDraft;
  }): Promise<EnqueueOutcome>;
  enqueueBudgetUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewBudgetDraft;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  enqueueBudgetDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome>;
  /**
   * STEP 16-H2-C2-B2 conflict-UX — permanently DROP one queued record by its
   * `queueId` ("변경 버리기" for a terminal-failed UPDATE). This is NOT a
   * server delete: it only removes the local un-sent write + its
   * failed/ack/reason state; the authoritative server row is never touched.
   * Refuses a `queueId` that isn't in the CURRENT scope (never touches another
   * account/household's pending writes). Awaits durable persistence.
   */
  discardPending(queueId: string): Promise<DiscardOutcome>;
  /** Ask for a flush. `includeFailed` first clears the terminal-failed set so
   *  those ops get one more attempt (manual "다시 시도"). */
  requestFlush(opts?: { includeFailed?: boolean }): void;
  dispose(): void;
  getState(): CoordinatorState;
}

export type DiscardOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-hydrated' | 'not-found' | 'scope' | 'persist' };

const scopeKeyOf = (s: CoordinatorScope | null): string | null =>
  s ? `${s.userId}:${s.householdId}` : null;

export function createPendingWriteCoordinator(
  deps: CoordinatorDeps,
): PendingWriteCoordinator {
  const controller = createQueueController();
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((t) => clearTimeout(t));
  const yieldToShell =
    deps.yieldToShell ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

  let hydration: Hydration = 'idle';
  let disposed = false;
  let scope: CoordinatorScope | null = deps.getScope();
  let lastError: string | null = null;

  /** queueId -> op identity: server accepted it, awaiting refresh confirmation.
   *  Keyed by queueId (globally unique) — `entity`/`entityId`/`op` carried
   *  for the entity-aware reconcile. */
  const awaitingAck = new Map<
    string,
    { entity: PendingEntity; entityId: string; op: PendingOpKind }
  >();
  /** `${entity}:${entityId}` set: terminal failure, retained + excluded from auto-retry. */
  const failedIds = new Set<string>();
  /** `${entity}:${entityId}` -> original service reason for the terminal failure. */
  const failedReasons = new Map<string, WriteConflictReason | undefined>();

  let backoffTimer: Timer | null = null;
  let backoffAttempt = 0;
  let reconciling = false;
  let reconcileAgain = false;

  const emit = () => {
    if (!disposed) deps.onChange();
  };

  /* --------------------------- flusher --------------------------- */

  const flusher = createWriteQueueFlusher({
    getOps: (fs: FlushScope) => {
      if (hydration !== 'ready' || !deps.getRemoteReady()) return [];
      // Every supported entity (transaction + card + category). The flusher is
      // generic; `runPendingWrite` dispatches by `op.entity`.
      return opsForScope(controller.read(), fs.userId, fs.householdId).filter(
        (o) =>
          !failedIds.has(opKey(o.entity, o.entityId)) &&
          !awaitingAck.has(o.queueId),
      );
    },
    runOp: (op) =>
      runPendingWrite(op, {
        knownCardIds: deps.getKnownCardIds(),
        ...(deps.createTransaction ? { createTransaction: deps.createTransaction } : {}),
        ...(deps.updateTransaction ? { updateTransaction: deps.updateTransaction } : {}),
        ...(deps.softDeleteTransaction ? { softDeleteTransaction: deps.softDeleteTransaction } : {}),
        ...(deps.createCard ? { createCard: deps.createCard } : {}),
        ...(deps.updateCard ? { updateCard: deps.updateCard } : {}),
        ...(deps.softDeleteCard ? { softDeleteCard: deps.softDeleteCard } : {}),
        ...(deps.createCategory ? { createCategory: deps.createCategory } : {}),
        ...(deps.updateCategory ? { updateCategory: deps.updateCategory } : {}),
        ...(deps.softDeleteCategory ? { softDeleteCategory: deps.softDeleteCategory } : {}),
        ...(deps.saveBudget ? { saveBudget: deps.saveBudget } : {}),
        ...(deps.softDeleteBudget ? { softDeleteBudget: deps.softDeleteBudget } : {}),
      }),
    onPass: async (result) => {
      if (disposed) return;
      let changed = false;

      for (const s of result.settled) {
        const rec = controller.read().find((r) => r.queueId === s.queueId);
        awaitingAck.set(s.queueId, {
          entity: rec?.entity ?? 'transaction',
          entityId: s.entityId,
          op: rec?.op ?? 'create',
        });
        changed = true;
      }
      for (const t of result.terminal) {
        const rec = controller.read().find((r) => r.queueId === t.queueId);
        const key = opKey(rec?.entity ?? 'transaction', t.entityId);
        if (!failedIds.has(key)) {
          failedIds.add(key);
          changed = true;
        }
        failedReasons.set(key, t.reason);
        lastError = t.message ?? '전송하지 못한 변경이 있어요';
        // Persist the terminal marker (message + reason) on THIS record only
        // (by queueId — never `entityId`, which can collide across entities)
        // so a restart shows the right "전송 실패" copy and never auto-retries.
        const msg = lastError;
        void controller.mutate((cur) => ({
          next: cur.map((r) =>
            r.queueId === t.queueId
              ? {
                  ...r,
                  lastError: r.lastError ?? msg ?? 'terminal',
                  ...(t.reason ? { lastErrorReason: t.reason } : {}),
                }
              : r,
          ),
          result: 0,
        }), deps.storage);
      }

      if (result.haltedByTransport) {
        scheduleBackoff();
      } else if (!result.aborted) {
        // A clean pass — reset the backoff ramp.
        backoffAttempt = 0;
        clearBackoff();
      }

      if (changed) emit();
      if (result.settled.length > 0) void reconcile();
    },
  });

  // Point the flusher at the initial scope right away — its own `request()`
  // is a no-op until it has one, so `hydrate()`'s trigger-A flush would
  // otherwise never fire until the React shell's scope effect ran.
  flusher.setScope(scope);

  /* ------------------------- backoff timer ------------------------- */

  function clearBackoff() {
    if (backoffTimer != null) {
      cancel(backoffTimer);
      backoffTimer = null;
    }
  }

  function scheduleBackoff() {
    if (disposed || !scope) return;
    // Nothing to retry -> no timer (§10).
    const anyRetryable =
      awaitingAck.size > 0 ||
      opsForScope(controller.read(), scope.userId, scope.householdId).some(
        (o) => !failedIds.has(opKey(o.entity, o.entityId)),
      );
    if (!anyRetryable) {
      clearBackoff();
      backoffAttempt = 0;
      return;
    }
    clearBackoff();
    const delay = computeBackoffDelay(backoffAttempt);
    backoffAttempt += 1;
    backoffTimer = schedule(() => {
      backoffTimer = null;
      if (disposed) return;
      if (awaitingAck.size > 0) void reconcile();
      flusher.request();
    }, delay);
  }

  /* --------------------- ack after refresh ----------------------- */

  async function reconcile(): Promise<void> {
    if (disposed) return;
    if (reconciling) {
      reconcileAgain = true;
      return;
    }
    if (awaitingAck.size === 0) return;
    reconciling = true;
    try {
      do {
        reconcileAgain = false;

        try {
          await deps.requestRefresh();
        } catch {
          scheduleBackoff(); // refresh failed -> cannot confirm; keep, retry later
          return;
        }
        await yieldToShell();
        if (disposed) return;
        if (!deps.getRemoteReady()) {
          scheduleBackoff(); // snapshot not trusted -> cannot confirm; keep, retry later
          return;
        }

        const serverRows = deps.getServerTransactions();
        const serverCards = deps.getServerCards();
        const serverCategories = deps.getServerCategories();
        const serverBudgets = deps.getServerBudgets();
        const knownCards = deps.getKnownCardIds();
        const confirmed: string[] = []; // queueIds the server has actually applied
        let unconfirmed = 0;
        for (const [queueId, { entity, entityId, op }] of awaitingAck) {
          const rec = controller.read().find((r) => r.queueId === queueId);
          let ok: boolean;
          if (entity === 'budget') {
            // STEP 16-H2-C2-BUDGET A1 §7/§9
            if (op === 'delete') {
              ok = !serverBudgets.has(entityId);
            } else {
              // CREATE + UPDATE: category present AND amount matches the
              // queued draft. A present category with a DIFFERENT amount
              // (someone else's concurrent create/update) is NOT an ack —
              // it drops back to the normal queue and replays, whose
              // reconcile inside `saveBudget` classifies it as `exists`/
              // `conflict` (never a blind success).
              const amt = serverBudgets.get(entityId);
              ok =
                amt !== undefined &&
                (rec?.op === 'create' || rec?.op === 'update') &&
                rec.entity === 'budget' &&
                serverBudgetConfirmsUpdate(amt, rec.payload);
            }
          } else if (entity === 'category') {
            // STEP 16-H2-C2-B1 §25/§26/§27
            if (op === 'delete') {
              ok = !serverCategories.has(entityId);
            } else {
              // CREATE + UPDATE: row present AND editable fields match the draft.
              const cat = serverCategories.get(entityId);
              ok =
                !!cat &&
                (rec?.op === 'create' || rec?.op === 'update') &&
                rec.entity === 'category' &&
                serverCategoryConfirmsUpdate(cat, rec.payload);
            }
          } else if (entity === 'card') {
            // §22/§23/§24
            if (op === 'delete') {
              ok = !serverCards.has(entityId);
            } else {
              // CREATE + UPDATE: row present AND editable fields match the draft.
              const card = serverCards.get(entityId);
              ok =
                !!card &&
                (rec?.op === 'create' || rec?.op === 'update') &&
                rec.entity === 'card' &&
                serverCardConfirmsUpdate(card, rec.payload);
            }
          } else if (op === 'create') {
            ok = serverRows.has(entityId);
          } else if (op === 'delete') {
            // §17: the snapshot's `transactions` already excludes deleted_at;
            // so "not present" == deleted/gone, both the desired outcome.
            ok = !serverRows.has(entityId);
          } else {
            // §16: id present is NOT enough — the row's fields must reflect
            // the queued desired draft (guards against a still-stale snapshot).
            const row = serverRows.get(entityId);
            ok =
              !!row &&
              rec?.op === 'update' &&
              rec.entity === 'transaction' &&
              serverRowConfirmsUpdate(row, rec.payload, knownCards);
          }
          if (ok) confirmed.push(queueId);
          else unconfirmed += 1;
        }

        // Empty `awaitingAck` entirely: confirmed ones are about to be
        // removed from the durable queue; unconfirmed ones drop back onto
        // the normal queue so the flusher REPLAYS them (idempotent via the
        // write service's 23505 reconcile). Only a failed ack-persist below
        // re-adds the confirmed ids.
        awaitingAck.clear();
        if (unconfirmed > 0) flusher.request(); // replay the ones the server didn't get

        if (confirmed.length > 0) {
          const out = await controller.mutate(
            (cur) => ({ next: cur.filter((r) => !confirmed.includes(r.queueId)), result: 0 }),
            deps.storage,
          );
          if (!out.persist.ok) {
            // Ack persist failed: the on-disk queue still has the item
            // (mutate rolled back). Re-mark it awaiting-ack so a later
            // reconcile retries the REMOVAL — never re-runs the write.
            for (const q of confirmed) {
              const rec = controller.read().find((r) => r.queueId === q);
              if (rec) awaitingAck.set(q, { entity: rec.entity, entityId: rec.entityId, op: rec.op });
            }
            scheduleBackoff();
          }
          emit();
        }
      } while (reconcileAgain && !disposed && awaitingAck.size > 0);
    } finally {
      reconciling = false;
    }
  }

  /* ---------------------------- API ----------------------------- */

  function rebuildFailedFromRecords() {
    failedIds.clear();
    failedReasons.clear();
    for (const r of controller.read()) {
      if (r.lastError) {
        const key = opKey(r.entity, r.entityId);
        failedIds.add(key);
        failedReasons.set(key, r.lastErrorReason);
      }
    }
  }

  async function hydrate(): Promise<void> {
    if (disposed) return;
    hydration = 'loading';
    emit();
    const res = await controller.hydrate(deps.storage);
    if (disposed) return;
    if (res.ok) {
      hydration = 'ready';
      rebuildFailedFromRecords();
      emit();
      // Trigger A: hydrated + valid scope + remote ready -> one flush.
      requestFlush();
    } else {
      hydration = 'failed';
      if (__DEV__) console.warn('[pending-finance] hydrate failed', res.error);
      emit();
    }
  }

  function setScope(next: CoordinatorScope | null): void {
    if (disposed) return;
    if (scopeKeyOf(next) === scopeKeyOf(scope)) return;
    scope = next;
    flusher.setScope(next);
    clearBackoff();
    backoffAttempt = 0;
    awaitingAck.clear();
    failedIds.clear();
    failedReasons.clear();
    lastError = null;
    // Re-derive failed markers for the NEW scope from durable records.
    if (hydration === 'ready') rebuildFailedFromRecords();
    emit();
    requestFlush();
  }

  async function enqueue(record: PendingWrite): Promise<EnqueueOutcome> {
    if (disposed) return { ok: false, reason: 'not-hydrated' };
    if (hydration !== 'ready' || !controller.isHydrated()) {
      return { ok: false, reason: 'not-hydrated' };
    }
    const outcome = await controller.mutate((cur) => {
      const r = enqueuePendingWrite(cur, record);
      return { next: r.ok ? r.queue : null, result: r };
    }, deps.storage);

    if (outcome.blockedNotHydrated) return { ok: false, reason: 'not-hydrated' };
    if (outcome.result && outcome.result.ok === false) {
      // 'cap' (MAX_PENDING_WRITES) or 'existing-pending' (a differing op for
      // the same transaction is already queued — never silently overwritten).
      return { ok: false, reason: outcome.result.reason };
    }
    if (!outcome.persist.ok) return { ok: false, reason: 'persist' };

    emit();
    requestFlush(); // try immediately; onPass schedules backoff if offline
    return { ok: true };
  }

  function enqueueTransactionCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingTransactionCreate({
        scope: args.scope,
        entityId: args.entityId,
        payload: args.payload,
      }),
    );
  }

  function enqueueTransactionUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
    expectedUpdatedAt: string;
    originalRawCardId: string | null;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingTransactionUpdate({
        scope: args.scope,
        entityId: args.entityId,
        payload: args.payload,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
        originalRawCardId: args.originalRawCardId,
      }),
    );
  }

  function enqueueTransactionDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingTransactionDelete({
        scope: args.scope,
        entityId: args.entityId,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  function enqueueCardCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCardDraft;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingCardCreate({ scope: args.scope, entityId: args.entityId, payload: args.payload }),
    );
  }

  function enqueueCardUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCardDraft;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingCardUpdate({
        scope: args.scope,
        entityId: args.entityId,
        payload: args.payload,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  function enqueueCardDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingCardDelete({
        scope: args.scope,
        entityId: args.entityId,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  function enqueueCategoryCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCustomCategoryDraft;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingCategoryCreate({ scope: args.scope, entityId: args.entityId, payload: args.payload }),
    );
  }

  function enqueueCategoryUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewCustomCategoryDraft;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingCategoryUpdate({
        scope: args.scope,
        entityId: args.entityId,
        payload: args.payload,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  function enqueueCategoryDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingCategoryDelete({
        scope: args.scope,
        entityId: args.entityId,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  function enqueueBudgetCreate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewBudgetDraft;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingBudgetCreate({ scope: args.scope, entityId: args.entityId, payload: args.payload }),
    );
  }

  function enqueueBudgetUpdate(args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewBudgetDraft;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingBudgetUpdate({
        scope: args.scope,
        entityId: args.entityId,
        payload: args.payload,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  function enqueueBudgetDelete(args: {
    scope: CoordinatorScope;
    entityId: string;
    expectedUpdatedAt: string;
  }): Promise<EnqueueOutcome> {
    return enqueue(
      makePendingBudgetDelete({
        scope: args.scope,
        entityId: args.entityId,
        expectedUpdatedAt: args.expectedUpdatedAt, // FROZEN — never refreshed
      }),
    );
  }

  async function discardPending(queueId: string): Promise<DiscardOutcome> {
    if (disposed) return { ok: false, reason: 'not-hydrated' };
    if (hydration !== 'ready' || !controller.isHydrated()) {
      return { ok: false, reason: 'not-hydrated' };
    }
    const rec = controller.read().find((r) => r.queueId === queueId);
    if (!rec) return { ok: false, reason: 'not-found' };
    // Scope safety (§4): never remove a record that belongs to another
    // account / household. `queueId` is globally unique, but this is the
    // explicit guard.
    if (
      !scope ||
      rec.scope.userId !== scope.userId ||
      rec.scope.householdId !== scope.householdId
    ) {
      return { ok: false, reason: 'scope' };
    }
    const out = await controller.mutate(
      (cur) => ({ next: cur.filter((r) => r.queueId !== queueId), result: 0 }),
      deps.storage,
    );
    if (out.blockedNotHydrated) return { ok: false, reason: 'not-hydrated' };
    if (!out.persist.ok) return { ok: false, reason: 'persist' };
    // Drop the local failed / ack / reason state for this op's key ONLY when
    // no other record for the same `${entity}:${entityId}` remains.
    awaitingAck.delete(queueId);
    const key = opKey(rec.entity, rec.entityId);
    if (!controller.read().some((r) => opKey(r.entity, r.entityId) === key)) {
      failedIds.delete(key);
      failedReasons.delete(key);
    }
    emit();
    return { ok: true };
  }

  function requestFlush(opts?: { includeFailed?: boolean }): void {
    if (disposed) return;
    if (opts?.includeFailed) {
      failedIds.clear();
      failedReasons.clear();
      lastError = null;
      // Also drop the durable terminal markers so a restart doesn't re-fail.
      void controller.mutate((cur) => ({
        next: cur.map((r) =>
          r.lastError || r.lastErrorReason
            ? { ...r, lastError: undefined, lastErrorReason: undefined }
            : r,
        ),
        result: 0,
      }), deps.storage);
      emit();
    }
    if (awaitingAck.size > 0) void reconcile();
    flusher.request();
  }

  function dispose(): void {
    disposed = true;
    flusher.dispose();
    clearBackoff();
  }

  /** Build a per-entity view from the current-scope ops of ONE entity.
   *  Keys are bare `entityId`; `failedIds`/`failedReasons` are looked up by
   *  the `${entity}:${entityId}` opKey and re-exposed bare. */
  function entityStateOf(entity: PendingEntity, allScopeOps: PendingWrite[]): CoordinatorEntityState {
    const scopeOps = allScopeOps.filter((o) => o.entity === entity);
    const ids = new Set(scopeOps.map((o) => o.entityId));
    const scopedFailed = new Set([...ids].filter((id) => failedIds.has(opKey(entity, id))));
    const pendingIds = new Set([...ids].filter((id) => !scopedFailed.has(id)));
    const opByEntity = new Map<string, PendingOpKind>(scopeOps.map((o) => [o.entityId, o.op]));
    const failedReasonsScoped = new Map<string, WriteConflictReason | undefined>(
      [...scopedFailed].map((id) => [id, failedReasons.get(opKey(entity, id))]),
    );
    return { scopeOps, pendingIds, failedIds: scopedFailed, opByEntity, failedReasons: failedReasonsScoped };
  }

  function getState(): CoordinatorState {
    const allScopeOps =
      hydration === 'ready' && scope
        ? opsForScope(controller.read(), scope.userId, scope.householdId)
        : [];
    const txn = entityStateOf('transaction', allScopeOps);
    const card = entityStateOf('card', allScopeOps);
    const category = entityStateOf('category', allScopeOps);
    const budget = entityStateOf('budget', allScopeOps);
    return {
      hydration,
      scopeOps: txn.scopeOps,
      pendingIds: txn.pendingIds,
      failedIds: txn.failedIds,
      opByEntity: txn.opByEntity,
      failedReasons: txn.failedReasons,
      card,
      category,
      budget,
      pendingCount: allScopeOps.length,
      lastError,
      flushing: flusher._debug().flushing,
    };
  }

  return {
    hydrate,
    setScope,
    enqueueTransactionCreate,
    enqueueTransactionUpdate,
    enqueueTransactionDelete,
    enqueueCardCreate,
    enqueueCardUpdate,
    enqueueCardDelete,
    enqueueCategoryCreate,
    enqueueCategoryUpdate,
    enqueueCategoryDelete,
    enqueueBudgetCreate,
    enqueueBudgetUpdate,
    enqueueBudgetDelete,
    discardPending,
    requestFlush,
    dispose,
    getState,
  };
}

export { MAX_PENDING_WRITES };
