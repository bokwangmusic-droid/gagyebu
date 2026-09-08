/**
 * Authoritative-refresh scheduler for household finance — STEP 16-G3-B1.
 *
 * Pure state machine — NO React, NO Supabase, NO realtime. It only hardens
 * the sequencing of the EXISTING authoritative-snapshot refresh path.
 *
 * Fixes the STEP 16-G3-A AUDIT's top finding: two overlapping `refresh()`es
 * for the SAME `${userId}:${householdId}` both passed the old string-key
 * guard, so the LAST-COMPLETED fetch (not the last-STARTED) won — a stale
 * snapshot could overwrite a newer one.
 *
 * Guarantees
 * ----------
 *  1. Single-flight per scope. At most ONE `fetchSnapshot` is in flight for
 *     the current scope at a time. A refresh requested while one is running
 *     is coalesced into a SINGLE trailing fetch — a burst of N `request()`s
 *     produces at most 1 in-flight + 1 trailing, never N parallel snapshots.
 *  2. Monotonic generation. Every fetch dispatch gets an ever-increasing
 *     `generation`; a response commits only if it is still the newest
 *     generation AND still the current scope AND still from the active drain
 *     loop. An OLD same-scope response can therefore never commit.
 *  3. Scope transitions start a fresh pipeline IMMEDIATELY — a new scope's
 *     initial fetch is never blocked waiting for the previous scope's
 *     in-flight fetch. The previous scope's late response is discarded,
 *     never committed (belt-and-braces on top of the consumer's own
 *     loadedForUserId / loadedForHouseholdId trust check).
 *  4. `request()` resolves only after a fetch that STARTED at/after the call
 *     has committed (or the scope went away) — so `await refresh()` callers
 *     (e.g. `write -> await refresh() -> router.back()`) still observe the
 *     authoritative latest snapshot before continuing.
 *  5. A thrown `fetchSnapshot` becomes an `{ ok: false }` outcome — never an
 *     unhandled rejection — and a thrown fetch for a STALE scope never
 *     reaches `commit` (so it can't turn a healthy screen into an error).
 */

export interface RefreshScope {
  userId: string;
  householdId: string;
}

export type SnapshotOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

export interface RefreshSchedulerOptions<T> {
  /**
   * Fetch one authoritative snapshot for `scope`. A thrown error is caught
   * by the scheduler and turned into an `{ ok: false }` outcome.
   */
  fetchSnapshot: (scope: RefreshScope) => Promise<SnapshotOutcome<T>>;
  /**
   * Apply a fetch outcome the scheduler has confirmed is the NEWEST valid
   * result for the CURRENT scope. Never called for a superseded / stale /
   * wrong-scope response.
   */
  commit: (scope: RefreshScope, outcome: SnapshotOutcome<T>) => void;
}

export interface RefreshScheduler {
  /** Point the scheduler at a new account/household (or `null` when signed out). Starts its own initial fetch. */
  setScope: (scope: RefreshScope | null) => void;
  /** Request an authoritative refresh of the current scope. Coalesces; see guarantee 4 for the Promise semantics. */
  request: () => Promise<void>;
  /** Provider unmount — no further fetch commits. */
  dispose: () => void;
  /** Inspection only (tests / debugging). */
  _debug: () => {
    scopeKey: string | null;
    generation: number;
    running: boolean;
    dirty: boolean;
    disposed: boolean;
  };
}

const scopeKeyOf = (s: RefreshScope | null): string | null =>
  s ? `${s.userId}:${s.householdId}` : null;

export function createRefreshScheduler<T>(
  opts: RefreshSchedulerOptions<T>,
): RefreshScheduler {
  let scope: RefreshScope | null = null;
  let scopeKey: string | null = null;
  let generation = 0; // monotonic across the scheduler's whole life; never resets
  let loopSeq = 0; // monotonic; identifies a drain-loop invocation
  let activeLoop = 0; // the loop id currently permitted to run/commit (0 = idle)
  let dirty = false;
  let drainPromise: Promise<void> = Promise.resolve();
  let disposed = false;

  function setScope(next: RefreshScope | null): void {
    if (disposed) return;
    const nextKey = scopeKeyOf(next);
    if (nextKey === scopeKey) return;
    // New pipeline. Any running loop is orphaned: after its current await it
    // will see `activeLoop` / `scopeKey` changed and bail without committing.
    scope = next;
    scopeKey = nextKey;
    dirty = false;
    activeLoop = 0;
    if (nextKey) startLoop(true);
  }

  function request(): Promise<void> {
    if (disposed || !scopeKey) return Promise.resolve();
    dirty = true;
    if (activeLoop === 0) startLoop(false);
    // A loop is (or was just) running: it re-checks `dirty` after its only
    // await point, so this request is guaranteed to be drained by the
    // promise below (guarantee 4). `request()` cannot interleave into the
    // synchronous while-exit -> finally sequence, so it is never lost.
    return drainPromise;
  }

  function startLoop(initial: boolean): void {
    if (disposed || activeLoop !== 0 || !scope || !scopeKey) return;
    const myLoop = ++loopSeq;
    activeLoop = myLoop;
    if (initial) dirty = true;
    const loopScope = scope;
    const loopScopeKey = scopeKey;
    let resolve!: () => void;
    drainPromise = new Promise<void>((r) => {
      resolve = r;
    });
    void drain(loopScope, loopScopeKey, myLoop, resolve).catch(() => undefined);
  }

  async function drain(
    loopScope: RefreshScope,
    loopScopeKey: string,
    myLoop: number,
    resolve: () => void,
  ): Promise<void> {
    try {
      while (
        !disposed &&
        activeLoop === myLoop &&
        scopeKey === loopScopeKey &&
        dirty
      ) {
        dirty = false;
        const gen = ++generation;

        let outcome: SnapshotOutcome<T>;
        try {
          outcome = await opts.fetchSnapshot(loopScope);
        } catch {
          outcome = { ok: false, message: 'FETCH_THREW' };
        }

        // Superseded while awaiting? Discard — never commit a stale result.
        if (
          disposed ||
          activeLoop !== myLoop ||
          scopeKey !== loopScopeKey ||
          gen !== generation
        ) {
          return;
        }

        opts.commit(loopScope, outcome);
      }
    } finally {
      if (activeLoop === myLoop) activeLoop = 0;
      resolve();
    }
  }

  function dispose(): void {
    disposed = true;
    activeLoop = 0;
    dirty = false;
  }

  return {
    setScope,
    request,
    dispose,
    _debug: () => ({
      scopeKey,
      generation,
      running: activeLoop !== 0,
      dirty,
      disposed,
    }),
  };
}
