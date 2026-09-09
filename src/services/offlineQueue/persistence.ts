/**
 * Offline Write Queue persistence — STEP 16-H2-A1 §4/§5.
 *
 * Owns the ONE AsyncStorage key `gagyebu.pendingWrites` and the single
 * serialization point every queue mutation must go through. Pure validation
 * lives in src/lib/offlineQueue.ts (`sanitizePendingWrites`); this module is
 * the storage side-effect.
 *
 * Contract:
 *  - `loadPendingWrites` NEVER throws (bad JSON / non-array / bad records ->
 *    `[]` or the good subset, plus a __DEV__ warning). It must never block
 *    app boot.
 *  - `persistPendingWrites` is NOT best-effort: it returns `{ ok:false }` on
 *    a storage failure so a caller can refuse to report "saved".
 *  - `createQueueController().mutate(...)` serializes reads+writes so two
 *    concurrent enqueues can't clobber each other's array.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { sanitizePendingWrites, type PendingWrite } from '@/lib/offlineQueue';
import { storageKey } from '@/lib/storage';

/** The storage surface this module needs. Injectable for tests. */
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const KEY = storageKey('pendingWrites');

const defaultStorage: QueueStorage = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
};

/**
 * STEP 16-H2-A1.1 FIX 1: a storage READ FAILURE (`getItem` rejected /
 * threw) is NOT the same as "no queue yet". Reporting `[]` for a transient
 * `getItem` failure would let a later enqueue persist `[D]` over a stored
 * `[A, B, C]` — silent data loss. So the result is now discriminated:
 *   - `{ ok: true,  records, dropped }` — read succeeded (key missing =>
 *     `records: []`; corrupt/invalid-root JSON is unrecoverable so it is
 *     also `records: []` with a __DEV__ warning — a corrupt blob holds
 *     nothing to preserve).
 *   - `{ ok: false, error }` — the read itself failed. The caller must NOT
 *     treat this as an empty queue; retry later.
 */
export type LoadPendingWritesResult =
  | { ok: true; records: PendingWrite[]; dropped: number }
  | { ok: false; error: unknown };

export async function loadPendingWrites(
  storage: QueueStorage = defaultStorage,
): Promise<LoadPendingWritesResult> {
  let raw: string | null;
  try {
    raw = await storage.getItem(KEY);
  } catch (error) {
    if (__DEV__) console.warn('[offline-queue] load: storage getItem failed', error);
    return { ok: false, error };
  }
  if (raw == null) return { ok: true, records: [], dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (__DEV__) console.warn('[offline-queue] load: corrupt JSON; treating as empty');
    return { ok: true, records: [], dropped: 0 };
  }

  const { records, dropped } = sanitizePendingWrites(parsed);
  if (__DEV__ && dropped > 0) {
    console.warn(`[offline-queue] load: dropped ${dropped} invalid record(s)`);
  }
  return { ok: true, records, dropped };
}

export type PersistResult = { ok: true } | { ok: false; error: string };

export async function persistPendingWrites(
  records: readonly PendingWrite[],
  storage: QueueStorage = defaultStorage,
): Promise<PersistResult> {
  let json: string;
  try {
    json = JSON.stringify(records);
  } catch (e) {
    return { ok: false, error: `serialize: ${String(e)}` };
  }
  try {
    await storage.setItem(KEY, json);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `setItem: ${String(e)}` };
  }
}

/* ------------------------------------------------------------------ *
 * Serialized mutation controller
 * ------------------------------------------------------------------ */

export interface MutateOutcome<T> {
  persist: PersistResult;
  /** Whatever the mutator chose to report (e.g. an EnqueueResult); `undefined`
   *  when the mutation was refused before `fn` ran. */
  result: T | undefined;
  /**
   * STEP 16-H2-A1.1 FIX 1: `true` when the mutation was REFUSED because the
   * controller has not completed a successful `hydrate()`. The stored queue
   * is still unconfirmed, so a durable write here could clobber it. `fn` is
   * NOT run. Retry after a successful `hydrate()`.
   */
  blockedNotHydrated?: boolean;
}

export interface QueueController {
  /** The in-memory array as of the last successful load/mutate. */
  read(): PendingWrite[];
  /** True only after a `hydrate()` that actually read storage. */
  isHydrated(): boolean;
  /**
   * Load from storage and seed memory. Returns the discriminated
   * `LoadPendingWritesResult`: on `{ ok: false }` the controller stays
   * NOT hydrated and `current` is left as-is (never forced to `[]`).
   * Safe to call again to retry.
   */
  hydrate(storage?: QueueStorage): Promise<LoadPendingWritesResult>;
  /**
   * Apply `fn` to the current array, persist the result, and only then
   * adopt it in memory.
   *  - Refused (no persist, no `fn`) with `blockedNotHydrated: true` until a
   *    successful `hydrate()` — never overwrite an unconfirmed stored queue.
   *  - `fn` returning `next: null` => NO write (a no-op such as a cap reject).
   *  - On a persist failure the in-memory array is left untouched and
   *    `persist.ok === false` is returned.
   *
   * Calls are serialized: each awaits the previous one, so a burst of
   * concurrent enqueues can never lose an update.
   */
  mutate<T>(
    fn: (current: readonly PendingWrite[]) => { next: PendingWrite[] | null; result: T },
    storage?: QueueStorage,
  ): Promise<MutateOutcome<T>>;
}

export function createQueueController(): QueueController {
  let current: PendingWrite[] = [];
  let hydrated = false;
  let tail: Promise<unknown> = Promise.resolve();

  const chain = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    // keep the chain alive even if a job rejects (it shouldn't — jobs catch)
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    read: () => current.slice(),
    isHydrated: () => hydrated,

    hydrate: (storage) =>
      chain(async () => {
        const res = await loadPendingWrites(storage);
        if (res.ok) {
          current = res.records;
          hydrated = true;
        }
        // res.ok === false: leave `current` and `hydrated` exactly as they were.
        return res;
      }),

    mutate: (fn, storage) =>
      chain(async () => {
        if (!hydrated) {
          return {
            persist: { ok: false, error: 'controller not hydrated' } as PersistResult,
            result: undefined,
            blockedNotHydrated: true,
          };
        }
        const { next, result } = fn(current);
        if (next == null) {
          return { persist: { ok: true } as PersistResult, result };
        }
        const persist = await persistPendingWrites(next, storage);
        if (persist.ok) current = next;
        return { persist, result };
      }),
  };
}
