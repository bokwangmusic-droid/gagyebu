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
  makePendingTransactionCreate,
  makePendingTransactionDelete,
  makePendingTransactionUpdate,
  opsForScope,
  serverRowConfirmsUpdate,
  type PendingWrite,
} from '@/lib/offlineQueue';
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
import type { Transaction } from '@/store/types';

export type Hydration = 'idle' | 'loading' | 'ready' | 'failed';

export interface CoordinatorScope {
  userId: string;
  householdId: string;
}

export type PendingOpKind = 'create' | 'update' | 'delete';

export interface CoordinatorState {
  hydration: Hydration;
  /** Current-scope transaction ops (FIFO). Includes terminal-failed. */
  scopeOps: PendingWrite[];
  /** `scopeOps` entity ids that are still waiting to send (not failed). */
  pendingIds: ReadonlySet<string>;
  /** `scopeOps` entity ids that hit a terminal failure and are held. */
  failedIds: ReadonlySet<string>;
  /** entity id -> the op kind of its current-scope pending/failed op. */
  opByEntity: ReadonlyMap<string, PendingOpKind>;
  /** entity id -> the ORIGINAL service reason for a terminal failure. */
  failedReasons: ReadonlyMap<string, WriteConflictReason | undefined>;
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
  /** Trigger one authoritative refresh (B1). Resolves when it has committed. */
  requestRefresh: () => Promise<void>;
  /** Ask the React shell to re-read `getState()`. */
  onChange: () => void;
  /** Test injections — forwarded to `runPendingWrite`. */
  createTransaction?: RunOpDeps['createTransaction'];
  updateTransaction?: RunOpDeps['updateTransaction'];
  softDeleteTransaction?: RunOpDeps['softDeleteTransaction'];
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
  /** Ask for a flush. `includeFailed` first clears the terminal-failed set so
   *  those ops get one more attempt (manual "다시 시도"). */
  requestFlush(opts?: { includeFailed?: boolean }): void;
  dispose(): void;
  getState(): CoordinatorState;
}

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

  /** queueId -> { entityId, op }: server accepted it, awaiting refresh confirmation. */
  const awaitingAck = new Map<string, { entityId: string; op: PendingOpKind }>();
  /** entityId set: terminal failure, retained + excluded from auto-retry. */
  const failedIds = new Set<string>();
  /** entityId -> original service reason for the terminal failure. */
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
      // Transaction CREATE / UPDATE / DELETE (H2-B1 widened the union — B2
      // adds the user-facing enqueue APIs; the flusher is already generic).
      return opsForScope(controller.read(), fs.userId, fs.householdId).filter(
        (o) =>
          o.entity === 'transaction' &&
          !failedIds.has(o.entityId) &&
          !awaitingAck.has(o.queueId),
      );
    },
    runOp: (op) =>
      runPendingWrite(op, {
        knownCardIds: deps.getKnownCardIds(),
        ...(deps.createTransaction ? { createTransaction: deps.createTransaction } : {}),
        ...(deps.updateTransaction ? { updateTransaction: deps.updateTransaction } : {}),
        ...(deps.softDeleteTransaction ? { softDeleteTransaction: deps.softDeleteTransaction } : {}),
      }),
    onPass: async (result) => {
      if (disposed) return;
      let changed = false;

      for (const s of result.settled) {
        const rec = controller.read().find((r) => r.queueId === s.queueId);
        awaitingAck.set(s.queueId, { entityId: s.entityId, op: rec?.op ?? 'create' });
        changed = true;
      }
      for (const t of result.terminal) {
        if (!failedIds.has(t.entityId)) {
          failedIds.add(t.entityId);
          changed = true;
        }
        failedReasons.set(t.entityId, t.reason);
        lastError = t.message ?? '전송하지 못한 거래가 있어요';
        // Persist the terminal marker (message + reason) so a restart shows
        // the right "전송 실패" copy and never silently auto-retries.
        const msg = lastError;
        void controller.mutate((cur) => ({
          next: cur.map((r) =>
            r.entityId === t.entityId
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
        (o) => o.entity === 'transaction' && !failedIds.has(o.entityId),
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
        const knownCards = deps.getKnownCardIds();
        const confirmed: string[] = []; // queueIds the server has actually applied
        let unconfirmed = 0;
        for (const [queueId, { entityId, op }] of awaitingAck) {
          let ok: boolean;
          if (op === 'create') {
            ok = serverRows.has(entityId);
          } else if (op === 'delete') {
            // §17: the snapshot's `transactions` already excludes deleted_at;
            // so "not present" == deleted/gone, both the desired outcome.
            ok = !serverRows.has(entityId);
          } else {
            // §16: id present is NOT enough — the row's fields must reflect
            // the queued desired draft (guards against a still-stale snapshot).
            const row = serverRows.get(entityId);
            const rec = controller.read().find((r) => r.queueId === queueId);
            ok =
              !!row &&
              rec?.op === 'update' &&
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
              if (rec) awaitingAck.set(q, { entityId: rec.entityId, op: rec.op });
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
        failedIds.add(r.entityId);
        failedReasons.set(r.entityId, r.lastErrorReason);
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

  function getState(): CoordinatorState {
    const scopeOps =
      hydration === 'ready' && scope
        ? opsForScope(controller.read(), scope.userId, scope.householdId).filter(
            (o) => o.entity === 'transaction',
          )
        : [];
    const opIds = new Set(scopeOps.map((o) => o.entityId));
    const scopedFailed = new Set([...failedIds].filter((id) => opIds.has(id)));
    const pendingIds = new Set([...opIds].filter((id) => !scopedFailed.has(id)));
    const opByEntity = new Map<string, PendingOpKind>(
      scopeOps.map((o) => [o.entityId, o.op]),
    );
    const failedReasonsScoped = new Map<string, WriteConflictReason | undefined>(
      [...scopedFailed].map((id) => [id, failedReasons.get(id)]),
    );
    return {
      hydration,
      scopeOps,
      pendingIds,
      failedIds: scopedFailed,
      opByEntity,
      failedReasons: failedReasonsScoped,
      pendingCount: scopeOps.length,
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
    requestFlush,
    dispose,
    getState,
  };
}

export { MAX_PENDING_WRITES };
