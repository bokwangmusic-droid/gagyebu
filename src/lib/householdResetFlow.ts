/**
 * "우리집 가계부 데이터 전체 초기화" — the client-side sequence around the
 * RPC, as pure logic with every side effect injected (app/household-reset.tsx
 * supplies the real ones). No React, no Supabase, no AsyncStorage.
 *
 * Order, and why:
 *   1. read the server marker   — doubles as the online check, and is the
 *                                 "before" value step 4b compares against.
 *   1b. arm                     — this scope's remembered marker AND this
 *                                 attempt (its request id) must be on disk
 *                                 BEFORE anything is deleted. It is what
 *                                 makes every later failure safe: if the
 *                                 purge in step 5 fails, or the app dies
 *                                 mid-call, the scope's queue is not sent
 *                                 until the server has said what became of
 *                                 the attempt. Cannot be written ->
 *                                 `storage`, nothing is started.
 *   2. freeze the offline queue — nothing queued may be sent while the
 *                                 household is being emptied.
 *   3. call the RPC.
 *   4a. server said no          — the transaction was rolled back; unfreeze,
 *                                 report failure. Never a success message.
 *   4b. no verdict (transport)  — the reset may have committed, or may still
 *                                 be RUNNING on the server. Ask the server's
 *                                 serialized check once, queue still frozen:
 *                                 it waits for a running reset to end and
 *                                 closes the request if it has not run, so
 *                                 its answer is final. Committed -> step 5.
 *                                 Not committed -> `failed`. No answer ->
 *                                 `unconfirmed` — never "data is intact" —
 *                                 and the attempt stays armed (see 6).
 *   5. it committed             — purge this scope's pending queue (one
 *                                 retry), and only once that purge is
 *                                 durable remember the new marker (a failed
 *                                 purge leaves the old marker, so the
 *                                 ordinary reset detection purges it later
 *                                 instead).
 *   5b. settle the attempt      — only when its outcome is certain AND dealt
 *                                 with (did not happen, or happened and the
 *                                 purge is durable).
 *   6. unfreeze, on every path that froze. An attempt that was not settled
 *      keeps THIS scope's queue from being sent (the coordinator asks the
 *      same serialized check before every flush pass, also after a restart)
 *      — everything else works again.
 *   7. refresh the snapshot and wait until it reflects the reset, so the
 *      caller never navigates back to a stale, still-populated screen.
 */
import { resetMarkerReached, type ResetVerdictRead } from '@/lib/householdResetMarker';

/** What the user must type to arm the final button. */
export const RESET_CONFIRM_PHRASE = '초기화';

/** Exact phrase; surrounding whitespace (an IME's trailing space) is forgiven, nothing else is. */
export function isResetPhraseConfirmed(input: string): boolean {
  return input.trim() === RESET_CONFIRM_PHRASE;
}

/** The final button's enabled state — owner + exact phrase + nothing in flight. */
export function canSubmitHouseholdReset(args: {
  role: 'owner' | 'member' | null | undefined;
  confirmText: string;
  running: boolean;
}): boolean {
  return args.role === 'owner' && !args.running && isResetPhraseConfirmed(args.confirmText);
}

export type ResetMarkerRead = { ok: true; value: string | null } | { ok: false };

export type ResetCallResult =
  | { ok: true; resetAt: string }
  | { ok: false; code: string; definitive: boolean };

export interface HouseholdResetDeps {
  /** Server `data_reset_at` right now. `ok: false` = offline / unreadable. */
  readMarker: () => Promise<ResetMarkerRead>;
  /** Durably remember this scope's marker (`current` if it has none yet) and this attempt. `false` = not written. */
  armMarker: (current: string | null) => Promise<boolean>;
  /** The server's serialized, final answer about THIS attempt. `ok: false` = no answer. */
  verifyReset: () => Promise<ResetVerdictRead>;
  /** The attempt's outcome is certain and dealt with — stop gating the scope on it. */
  settle: () => Promise<unknown>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => void;
  callReset: () => Promise<ResetCallResult>;
  /** Durably drop this scope's pending queue. */
  clearPending: () => Promise<{ ok: boolean }>;
  /** Remember `resetAt` as this device's marker for the scope. */
  syncMarker: (resetAt: string) => Promise<unknown>;
  /** Refresh the snapshot; resolves true once it reflects `resetAt`. */
  refresh: (resetAt: string) => Promise<boolean>;
}

export type HouseholdResetOutcome =
  /** Server data deleted, local queue handled, screens show the empty household. */
  | { kind: 'done'; resetAt: string }
  /** Server data deleted, but the snapshot on screen could not be refreshed. */
  | { kind: 'done-refresh-failed'; resetAt: string }
  | { kind: 'offline' }
  /** This device could not durably arm its reset marker — nothing was started. */
  | { kind: 'storage' }
  | { kind: 'not-owner' }
  /** The server refused or aborted: nothing was deleted. `code` is the service's error code. */
  | { kind: 'failed'; code: string }
  /**
   * No verdict and the serialized check gave no answer either: the data may
   * or may not have been deleted. The attempt is still armed.
   */
  | { kind: 'unconfirmed' }
  /** A run is already in flight (duplicate tap) — nothing was started. */
  | { kind: 'busy' };

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

/**
 * Returns a runner that executes at most ONE reset at a time: a second call
 * while the first is still in flight resolves `{ kind: 'busy' }` without
 * touching any dependency.
 */
export function createHouseholdResetRunner(): (deps: HouseholdResetDeps) => Promise<HouseholdResetOutcome> {
  let running = false;

  return async (deps) => {
    if (running) return { kind: 'busy' };
    running = true;
    try {
      const before = await safe(deps.readMarker, { ok: false } as ResetMarkerRead);
      if (!before.ok) return { kind: 'offline' };
      if (!(await safe(() => deps.armMarker(before.value), false))) return { kind: 'storage' };

      let resetAt: string | null = null;
      let failure: HouseholdResetOutcome | null = null;

      await deps.pauseQueue();
      try {
        const res = await safe<ResetCallResult>(deps.callReset, {
          ok: false,
          code: 'UNKNOWN',
          definitive: false,
        });

        if (res.ok) {
          resetAt = res.resetAt;
        } else if (res.definitive) {
          failure = res.code === 'NOT_OWNER' ? { kind: 'not-owner' } : { kind: 'failed', code: res.code };
        } else {
          // No verdict. Did it commit anyway — or is it still about to?
          const verdict = await safe(deps.verifyReset, { ok: false } as ResetVerdictRead);
          if (!verdict.ok) {
            failure = { kind: 'unconfirmed' };
          } else if (verdict.committed && verdict.resetAt != null) {
            resetAt = verdict.resetAt;
          } else if (verdict.marker != null && !resetMarkerReached(before.value, verdict.marker)) {
            // Not this attempt, but the household WAS reset since step 1
            // (another device): the queue is just as stale.
            resetAt = verdict.marker;
          } else {
            failure = { kind: 'failed', code: res.code }; // closed without running -> nothing was deleted
          }
        }

        let settled = failure != null && failure.kind !== 'unconfirmed';
        if (resetAt != null) {
          let cleared = await safe(deps.clearPending, { ok: false });
          if (!cleared.ok) cleared = await safe(deps.clearPending, { ok: false });
          const committedAt = resetAt;
          if (cleared.ok) await safe(() => deps.syncMarker(committedAt), undefined);
          settled = cleared.ok;
        }
        if (settled) await safe(deps.settle, undefined);
      } finally {
        deps.resumeQueue();
      }

      if (failure) return failure;
      if (resetAt == null) return { kind: 'unconfirmed' };

      const committedAt = resetAt;
      const refreshed = await safe(() => deps.refresh(committedAt), false);
      return refreshed
        ? { kind: 'done', resetAt: committedAt }
        : { kind: 'done-refresh-failed', resetAt: committedAt };
    } finally {
      running = false;
    }
  };
}
