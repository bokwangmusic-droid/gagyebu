/**
 * Household finance reset marker — pure decision logic.
 *
 * `household_settings.data_reset_at` changes every time an owner wipes the
 * household's finance data (`reset_household_finance_data()`,
 * supabase/migrations/20261008002000). Offline writes still queued on ANY
 * member's device were made against the pre-reset data, so they must be
 * discarded instead of replayed onto the emptied household.
 *
 * Each device remembers, per `${userId}:${householdId}` (the same scope the
 * offline queue uses), the NEWEST marker value it has seen. The marker is a
 * generation that only moves forward: a server value NEWER than the
 * remembered one means "a reset happened since this device last looked"; an
 * OLDER one (or `null` after a timestamp) is just a stale read — a snapshot
 * that was already in flight when a newer marker was learned — and must
 * neither purge nor move the remembered marker back. Only two SERVER
 * timestamps are ever compared with each other; the device clock is never
 * involved, so clock skew is irrelevant.
 *
 * Two states that must never be confused:
 *   - NOT INITIALIZED — the scope has no entry at all. The device has never
 *     looked, so whatever the server says now is only a baseline.
 *   - INITIALIZED with `value: null` — the device HAS looked and the
 *     household had never been reset. The first real reset (null -> a
 *     timestamp) is then a change like any other and purges.
 * An entry therefore exists from the very first trusted snapshot on, even
 * when the server value is `null`.
 *
 * No React, no AsyncStorage here. `createResetMarkerStore` takes its storage
 * as injected IO (src/store/pendingFinance.tsx supplies AsyncStorage); the
 * queue purge itself lives in the offline-queue coordinator, which consults
 * this from BOTH places a reset can be noticed — a freshly loaded snapshot,
 * and the server check right before a flush pass sends anything.
 */

export interface ResetMarkerEntry {
  /** Always `true` — an entry's existence IS "this device has looked". Spelled out so the stored JSON is self-describing. */
  initialized: true;
  /** Last seen `data_reset_at`; `null` = seen, and the household had never been reset. */
  value: string | null;
}

/** `${userId}:${householdId}` -> what this device last saw. A missing key = not initialized. */
export type ResetMarkerMap = Record<string, ResetMarkerEntry>;

/** AsyncStorage key (under the `gagyebu.` prefix) holding the `ResetMarkerMap`. */
export const RESET_MARKERS_STORAGE_KEY = 'householdResetMarkers';

export const resetMarkerKey = (userId: string, householdId: string): string =>
  `${userId}:${householdId}`;

/**
 * - `bootstrap` — not initialized: record the incoming value (null or not)
 *                 as the baseline, NO purge. A reset that predates this
 *                 device's first look is not a new reset.
 * - `unchanged` — initialized, the same instant; nothing to do or store.
 * - `purge`     — initialized, and the server marker is NEWER than the
 *                 remembered one (null -> T, or T1 -> a later T2): discard
 *                 the scope's pending queue, THEN record it.
 * - `stale`     — initialized, and the server marker is OLDER than the
 *                 remembered one (T2 -> an earlier T1, or T -> null). No
 *                 purge, and the remembered marker is kept as it is.
 */
export type ResetMarkerDecision = 'bootstrap' | 'unchanged' | 'purge' | 'stale';

const TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)?$/i;

/**
 * A `timestamptz` rendering (PostgREST: `2026-10-08T03:21:45.123456+00:00`)
 * as whole MICROSECONDS since the epoch, or `null` if it is not one.
 *
 * Parsed by hand rather than with `Date.parse`: a JS `Date` holds
 * milliseconds, so two resets inside the same millisecond would collapse
 * into "the same instant" and the second one would be missed. Postgres
 * stores `timestamptz` at microsecond resolution, so this keeps every
 * distinct server value distinct and orderable. The result (~1.8e15 in
 * 2026) is well inside `Number.MAX_SAFE_INTEGER` (~9.0e15), so plain
 * numbers are exact — no BigInt. Fraction digits beyond the 6th are
 * dropped; an absent offset is read as UTC.
 */
export function parseResetMarkerMicros(raw: string): number | null {
  const m = TIMESTAMPTZ.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(wallMs)) return null;
  let offsetSec = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(/:/g, '');
    const hh = +digits.slice(0, 2);
    const mm = +(digits.slice(2, 4) || '0');
    const ss = +(digits.slice(4, 6) || '0');
    offsetSec = (zone[0] === '-' ? -1 : 1) * (hh * 3600 + mm * 60 + ss);
  }
  const micros = +(frac ?? '').padEnd(6, '0').slice(0, 6);
  return (wallMs / 1000 - offsetSec) * 1_000_000 + micros;
}

type MarkerOrder = 'same' | 'newer' | 'older';

/**
 * How `incoming` relates to the remembered `seen` marker — the ONE ordering
 * rule, used by the snapshot path and the pre-flush server check alike.
 *
 * `null` is the oldest possible state ("never reset"): anything after it is
 * newer, and `null` after a timestamp is older (the RPC never sets the
 * column back to null).
 *
 * Two timestamps are ordered by their actual instants at microsecond
 * resolution, never as strings, so the same instant written with another
 * UTC offset is `same`.
 *
 * Values that cannot be parsed (never produced by PostgREST; a corrupt
 * store at worst):
 *   - byte-identical strings are `same` regardless;
 *   - an unparseable INCOMING value against a parseable remembered one is
 *     `older` — garbage never purges and never replaces a good marker;
 *   - an unparseable REMEMBERED value against anything else is `newer` —
 *     it cannot be ordered, and missing a real reset is worse than one
 *     purge; this self-heals, because the purge records the incoming value.
 */
function orderOf(seen: string | null, incoming: string | null): MarkerOrder {
  if (seen === incoming) return 'same';
  if (seen == null) return 'newer';
  if (incoming == null) return 'older';
  const a = parseResetMarkerMicros(seen);
  const b = parseResetMarkerMicros(incoming);
  if (a == null) return 'newer';
  if (b == null) return 'older';
  return b === a ? 'same' : b > a ? 'newer' : 'older';
}

/**
 * Has `current` caught up with `target`? True when `current` is the same
 * instant as `target` or a newer one — same ordering rule as everything
 * else here. Used to tell "the snapshot on screen already reflects this
 * reset" from "it is still the pre-reset one".
 */
export function resetMarkerReached(current: string | null, target: string | null): boolean {
  return orderOf(current, target) !== 'newer';
}

const entryOf = (markers: ResetMarkerMap, key: string): ResetMarkerEntry | undefined =>
  Object.prototype.hasOwnProperty.call(markers, key) ? markers[key] : undefined;

export function decideResetMarker(
  markers: ResetMarkerMap,
  key: string,
  incoming: string | null,
): ResetMarkerDecision {
  const entry = entryOf(markers, key);
  if (!entry) return 'bootstrap';
  const order = orderOf(entry.value, incoming);
  return order === 'same' ? 'unchanged' : order === 'newer' ? 'purge' : 'stale';
}

/**
 * The decision plus the map to persist for it. `next` is the SAME reference
 * as `markers` for `unchanged` and for `stale` (a stale value never moves
 * the marker back); for `bootstrap` / `purge` it is a copy with the scope's
 * entry set to the incoming value. For `purge`, persist `next` only AFTER
 * the queue purge succeeded — remembering the marker first would lose the
 * purge if it then failed.
 */
export function applyResetMarker(
  markers: ResetMarkerMap,
  key: string,
  incoming: string | null,
): { decision: ResetMarkerDecision; next: ResetMarkerMap } {
  const decision = decideResetMarker(markers, key, incoming);
  if (decision === 'unchanged' || decision === 'stale') return { decision, next: markers };
  return { decision, next: { ...markers, [key]: { initialized: true, value: incoming } } };
}

/**
 * Defensive parse of the stored map — never throws. Anything malformed is
 * dropped, which leaves that scope NOT INITIALIZED: its next snapshot is a
 * `bootstrap` (no purge), i.e. a corrupt store can cost one missed reset
 * detection but can never destroy a user's legitimate pending writes.
 *
 * Also accepts the earlier bare `string | null` entry shape as an
 * initialized entry, so a device that stored it keeps its baseline.
 */
export function parseResetMarkers(raw: unknown): ResetMarkerMap {
  const out: ResetMarkerMap = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value === 'string') {
      out[key] = { initialized: true, value };
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as { initialized?: unknown; value?: unknown };
    if (entry.initialized !== true) continue;
    if (entry.value === null || typeof entry.value === 'string') {
      out[key] = { initialized: true, value: entry.value };
    }
  }
  return out;
}

/** Injected persistence for `createResetMarkerStore`. `load` returns the raw stored value (or null). */
export interface ResetMarkerIO {
  load: () => Promise<unknown>;
  save: (markers: ResetMarkerMap) => Promise<void>;
}

export interface ResetMarkerStore {
  /** What `incoming` means for this scope right now. Never persists. */
  decide: (key: string, incoming: string | null) => Promise<ResetMarkerDecision>;
  /** Remember `incoming` as the scope's marker (memory first, then storage). */
  record: (key: string, incoming: string | null) => Promise<void>;
  /**
   * Make sure the scope HAS an entry (bootstrapping it with `incoming` when
   * it has none; an existing entry is never changed) and that the map is on
   * disk right now. Resolves `false` when that write failed. Unlike
   * `record`, this is what a caller about to reset the household waits on:
   * with a durable entry, a restart after the reset sees a NEWER server
   * marker and purges, instead of bootstrapping past it.
   */
  ensureDurable: (key: string, incoming: string | null) => Promise<boolean>;
}

/**
 * One in-memory copy of the marker map over injected storage, loaded lazily
 * and exactly once. A failed load or save never throws: load falls back to
 * an empty map (every scope bootstraps), save is best-effort — the
 * in-memory map stays authoritative for the rest of the session. Only
 * `ensureDurable` reports whether its save reached storage, so `io.save`
 * must reject on failure rather than swallow it.
 */
export function createResetMarkerStore(io: ResetMarkerIO): ResetMarkerStore {
  let markers: ResetMarkerMap | null = null;
  let loading: Promise<ResetMarkerMap> | null = null;

  const ensure = (): Promise<ResetMarkerMap> => {
    if (markers) return Promise.resolve(markers);
    loading ??= io
      .load()
      .then(parseResetMarkers, () => ({}) as ResetMarkerMap)
      .then((loaded) => {
        markers = loaded;
        return loaded;
      });
    return loading;
  };

  return {
    decide: async (key, incoming) => decideResetMarker(await ensure(), key, incoming),
    record: async (key, incoming) => {
      await ensure();
      const { decision, next } = applyResetMarker(markers ?? {}, key, incoming);
      // `stale` included: recording never moves a marker back.
      if (decision === 'unchanged' || decision === 'stale') return;
      markers = next;
      try {
        await io.save(next);
      } catch {
        // best-effort; see above
      }
    },
    ensureDurable: async (key, incoming) => {
      const current = await ensure();
      const next = entryOf(current, key)
        ? current
        : { ...current, [key]: { initialized: true as const, value: incoming } };
      markers = next;
      try {
        await io.save(next);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reset attempts THIS device started and has no verdict for yet
 * ------------------------------------------------------------------ */

/**
 * A reset this device sent whose outcome is not known yet. Written to disk
 * BEFORE the RPC is called and removed only once the outcome is certain, so
 * a lost reply — or the app dying mid-call — leaves a durable "do not send
 * this scope's queue until the server has said what happened".
 */
export interface ResetPendingEntry {
  /** The id the reset RPC was called with; what the server is asked about. */
  requestId: string;
}

/** `${userId}:${householdId}` -> the unresolved attempt. */
export type ResetPendingMap = Record<string, ResetPendingEntry>;

/** AsyncStorage key (under the `gagyebu.` prefix) holding the `ResetPendingMap`. */
export const RESET_PENDING_STORAGE_KEY = 'householdResetPending';

/** Defensive parse — never throws; malformed entries are dropped. */
export function parseResetPending(raw: unknown): ResetPendingMap {
  const out: ResetPendingMap = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) continue;
    const requestId = (value as { requestId?: unknown }).requestId;
    if (typeof requestId === 'string' && requestId !== '') out[key] = { requestId };
  }
  return out;
}

export interface ResetPendingIO {
  load: () => Promise<unknown>;
  /** Must reject on failure — `set` reports it. */
  save: (pending: ResetPendingMap) => Promise<void>;
}

export interface ResetPendingStore {
  get: (key: string) => Promise<ResetPendingEntry | undefined>;
  /** Remember the attempt. Resolves `false` (and remembers nothing) when it could not be written. */
  set: (key: string, entry: ResetPendingEntry) => Promise<boolean>;
  /**
   * Forget the attempt, but only if it is still `requestId`'s (a newer
   * attempt for the same scope is left alone). Memory first, then storage,
   * best-effort: an entry that survives on disk is asked about again after a
   * restart, and the server gives the same answer.
   */
  clear: (key: string, requestId: string) => Promise<void>;
}

/** Same shape as `createResetMarkerStore`: one in-memory copy, loaded lazily and once. */
export function createResetPendingStore(io: ResetPendingIO): ResetPendingStore {
  let pending: ResetPendingMap | null = null;
  let loading: Promise<ResetPendingMap> | null = null;

  const ensure = (): Promise<ResetPendingMap> => {
    if (pending) return Promise.resolve(pending);
    loading ??= io
      .load()
      .then(parseResetPending, () => ({}) as ResetPendingMap)
      .then((loaded) => {
        pending = loaded;
        return loaded;
      });
    return loading;
  };

  return {
    get: async (key) => {
      const map = await ensure();
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    },
    set: async (key, entry) => {
      const next = { ...(await ensure()), [key]: entry };
      try {
        await io.save(next);
      } catch {
        return false;
      }
      pending = next;
      return true;
    },
    clear: async (key, requestId) => {
      const map = await ensure();
      if (!Object.prototype.hasOwnProperty.call(map, key) || map[key].requestId !== requestId) return;
      const next = { ...map };
      delete next[key];
      pending = next;
      try {
        await io.save(next);
      } catch {
        // best-effort; see above
      }
    },
  };
}

/**
 * The server's serialized answer about one reset attempt
 * (`get_household_reset_marker_serialized`, migration 20261008002100). It is
 * only produced once every reset holding the household lock has finished,
 * and a `committed: false` answer has closed the request for good — so an
 * `ok: true` value is final. `ok: false` = no answer (transport, timeout).
 */
export type ResetVerdictRead =
  | {
      ok: true;
      /** Did the reset carrying this request id commit? */
      committed: boolean;
      /** That reset's `data_reset_at`, when it committed. */
      resetAt: string | null;
      /** The household's `data_reset_at` right now. */
      marker: string | null;
    }
  | { ok: false };
