/**
 * "우리집 가계부 데이터 전체 초기화" — the client-side sequence around the
 * RPC, as pure logic with every side effect injected (app/household-reset.tsx
 * supplies the real ones). No React, no Supabase, no AsyncStorage.
 *
 * Order, and why:
 *   1. read the server marker   — doubles as the online check, and is the
 *                                 "before" value step 4b compares against.
 *   2. freeze the offline queue — nothing queued may be sent while the
 *                                 household is being emptied.
 *   3. call the RPC.
 *   4a. server said no          — the transaction was rolled back; unfreeze,
 *                                 report failure. Never a success message.
 *   4b. no verdict (transport)  — the reset may have committed. Read the
 *                                 marker again: a NEWER one means it did.
 *                                 If that read fails too, the outcome is
 *                                 `unconfirmed` — never "data is intact".
 *   5. it committed             — purge this scope's pending queue, and only
 *                                 once that purge is durable remember the
 *                                 new marker (a failed purge leaves the old
 *                                 marker, so the ordinary reset detection
 *                                 purges it later instead).
 *   6. unfreeze, on every path that froze.
 *   7. refresh the snapshot and wait until it reflects the reset, so the
 *      caller never navigates back to a stale, still-populated screen.
 */
import { resetMarkerReached } from '@/lib/householdResetMarker';

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
  | { kind: 'not-owner' }
  /** The server refused or aborted: nothing was deleted. `code` is the service's error code. */
  | { kind: 'failed'; code: string }
  /** No verdict and no way to check: the data may or may not have been deleted. */
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
          // No verdict. Did it commit anyway?
          const after = await safe(deps.readMarker, { ok: false } as ResetMarkerRead);
          if (!after.ok) {
            failure = { kind: 'unconfirmed' };
          } else if (after.value != null && !resetMarkerReached(before.value, after.value)) {
            resetAt = after.value; // marker moved forward -> the reset did commit
          } else {
            failure = { kind: 'failed', code: res.code }; // marker unchanged -> nothing was deleted
          }
        }

        if (resetAt != null) {
          const cleared = await safe(deps.clearPending, { ok: false });
          const committedAt = resetAt;
          if (cleared.ok) await safe(() => deps.syncMarker(committedAt), undefined);
        }
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
