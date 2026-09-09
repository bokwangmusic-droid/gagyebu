/**
 * Offline Write Queue flusher — STEP 16-H2-A1 §9/§10.
 *
 * A DEDICATED single-flight state machine for WRITE-queue draining. It
 * borrows the *shape* of src/lib/remoteFinanceRefreshScheduler.ts
 * (scopeKey + single-flight + dirty-coalesce + stale-abort) but is its own
 * module — READ snapshot concurrency (B1) and WRITE flush concurrency are
 * different problems and must not share a controller.
 *
 * NO React, NO Supabase, NO persistence writes. It calls `runOp` per item
 * and hands the caller a `FlushPassResult`; the caller owns:
 *   1. triggering the authoritative refresh, and
 *   2. AFTER the refresh confirms, durably removing the `settled` queueIds
 *      (and removing + surfacing the `terminal` ones).
 * The flusher never removes anything itself — that "ack after refresh"
 * ordering (STEP 16-H2-A1 §10) is what makes a crash between "server OK" and
 * "queue cleaned" recover safely: the item is replayed and the existing
 * 23505 / updated_at idempotency in the write service absorbs it.
 */
import type { PendingWrite } from '@/lib/offlineQueue';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
import type { RunOpOutcome } from '@/services/offlineQueue/runOp';

export interface FlushScope {
  userId: string;
  householdId: string;
}

export interface FlushItemResult {
  queueId: string;
  entityId: string;
  outcome: 'success' | 'terminal';
  message?: string;
  /** STEP 16-H2-B1 §17: the original service reason for a terminal
   *  UPDATE/DELETE (`conflict` / `deleted` / `gone` / `identity` / `error`),
   *  passed through un-collapsed. `undefined` for CREATE. */
  reason?: WriteConflictReason;
}

export interface FlushPassResult {
  ran: boolean;
  /** queueIds the server accepted this pass — NOT yet durably removed. */
  settled: FlushItemResult[];
  /** queueIds that failed with a server verdict — caller drops + surfaces. */
  terminal: FlushItemResult[];
  /** true => stopped early on a transport failure; remaining items retained. */
  haltedByTransport: boolean;
  /** true => scope changed / disposed mid-pass; the pass is partial. */
  aborted: boolean;
}

export interface FlusherConfig {
  /** Current pending ops for `scope`, in FIFO order. Re-read every pass. */
  getOps: (scope: FlushScope) => PendingWrite[];
  /** Replay one op against the server. */
  runOp: (op: PendingWrite) => Promise<RunOpOutcome>;
  /** Called once per drained pass with the results (may be async). */
  onPass: (result: FlushPassResult) => void | Promise<void>;
  /** Optional bookkeeping before each attempt (persistence owned by caller). */
  onAttempt?: (op: PendingWrite) => void | Promise<void>;
}

export interface WriteQueueFlusher {
  /** Point at an account/household, or `null` when signed out / no household. */
  setScope: (scope: FlushScope | null) => void;
  /** Ask for a flush. Coalesces; resolves when the drain settles. */
  request: () => Promise<void>;
  /** No further passes / callbacks. */
  dispose: () => void;
  _debug: () => { scopeKey: string | null; flushing: boolean; dirty: boolean; disposed: boolean };
}

const keyOf = (s: FlushScope | null): string | null =>
  s ? `${s.userId}:${s.householdId}` : null;

export function createWriteQueueFlusher(cfg: FlusherConfig): WriteQueueFlusher {
  let scope: FlushScope | null = null;
  let scopeKey: string | null = null;
  let flushing = false;
  let dirty = false;
  let disposed = false;
  let drainPromise: Promise<void> = Promise.resolve();

  function setScope(next: FlushScope | null): void {
    if (disposed) return;
    const nextKey = keyOf(next);
    if (nextKey === scopeKey) return;
    scope = next;
    scopeKey = nextKey;
    dirty = false; // a running drain sees the key change and bails
  }

  function request(): Promise<void> {
    if (disposed || !scopeKey) return Promise.resolve();
    dirty = true;
    if (!flushing) startDrain();
    return drainPromise;
  }

  function startDrain(): void {
    if (disposed || flushing || !scope || !scopeKey) return;
    flushing = true;
    const myScope = scope;
    const myKey = scopeKey;
    let resolve!: () => void;
    drainPromise = new Promise<void>((r) => {
      resolve = r;
    });
    void drain(myScope, myKey, resolve).catch(() => undefined);
  }

  async function drain(
    myScope: FlushScope,
    myKey: string,
    resolve: () => void,
  ): Promise<void> {
    try {
      while (!disposed && scopeKey === myKey && dirty) {
        dirty = false;

        const ops = cfg.getOps(myScope);
        const settled: FlushItemResult[] = [];
        const terminal: FlushItemResult[] = [];
        let halted = false;
        let aborted = false;

        for (const op of ops) {
          if (disposed || scopeKey !== myKey) {
            aborted = true;
            break;
          }
          try {
            await cfg.onAttempt?.(op);
          } catch {
            // bookkeeping failure must not crash the pass
          }

          let outcome: RunOpOutcome;
          try {
            outcome = await cfg.runOp(op);
          } catch (e) {
            outcome = { kind: 'transport', message: `runOp threw: ${String(e)}` };
          }

          if (disposed || scopeKey !== myKey) {
            aborted = true;
            break;
          }

          if (outcome.kind === 'success') {
            settled.push({ queueId: op.queueId, entityId: op.entityId, outcome: 'success' });
            continue;
          }
          if (outcome.kind === 'terminal') {
            terminal.push({
              queueId: op.queueId,
              entityId: op.entityId,
              outcome: 'terminal',
              message: outcome.message,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            });
            // H2-A1: transaction creates are independent — a terminal on one
            // does not block the rest of the pass. (Dependency-aware halting
            // arrives with multi-entity rollout.)
            continue;
          }
          // transport
          halted = true;
          break;
        }

        try {
          await cfg.onPass({
            ran: true,
            settled,
            terminal,
            haltedByTransport: halted,
            aborted,
          });
        } catch {
          // a callback failure must not spin the loop
        }

        if (halted || aborted) break; // caller schedules the next attempt
      }
    } finally {
      flushing = false;
      resolve();
    }
  }

  function dispose(): void {
    disposed = true;
    dirty = false;
  }

  return {
    setScope,
    request,
    dispose,
    _debug: () => ({ scopeKey, flushing, dirty, disposed }),
  };
}
