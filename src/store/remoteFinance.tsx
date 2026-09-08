/**
 * Remote household finance state — STEP 16-G1A, hardened in
 * STEP 16-G1A-HARDEN (loadedForUserId added alongside
 * loadedForHouseholdId — see below).
 *
 * READ-ONLY, in-memory only. Mirrors src/store/household.tsx's own shape
 * (a small Context provider, no external state library, a `latestKeyRef`-
 * style stale-response guard) but for financial DATA rather than
 * membership. Deliberately separate from `StoreProvider` (src/store/
 * store.tsx) — see the completion report §1/§2 for why: StoreProvider's
 * `mutate()` always persists to AsyncStorage's global `gagyebu.*`
 * namespace on every state change, and that namespace is not split per
 * user/household. Putting remote household data into that store even
 * once would risk it landing in `gagyebu.*` on the next unrelated local
 * mutation — this provider never touches AsyncStorage at all, so that
 * risk doesn't exist here by construction.
 *
 * Never call any mutation through this provider — there isn't one. This
 * is intentionally read-only; see src/services/remoteFinance.ts for the
 * SELECT-only fetch layer and src/lib/remoteFinanceMapping.ts for the
 * remote -> local-domain-type transform this wraps in React state.
 *
 * STEP 16-G3-B1: refresh sequencing (single-flight per scope, monotonic
 * generation so an old same-scope response can't overwrite a newer one,
 * dirty-trailing coalescing, stale-scope discard) is delegated to the pure
 * `createRefreshScheduler` state machine (src/lib/remoteFinanceRefreshScheduler.ts).
 * This provider only supplies its `fetchSnapshot` (the existing SELECT
 * layer) and `commit` (the existing setState), plus one AppState
 * background->foreground authoritative refresh through the SAME scheduler.
 *
 * STEP 16-G3-B2: household finance Realtime is wired here too. A
 * `postgres_changes` event on any finance table is a debounced invalidation
 * SIGNAL only — it calls `scheduler.request()` (never patches state from a
 * payload). Channel transport/lifecycle lives in
 * src/services/remoteFinanceRealtime.ts; this provider just binds it to the
 * `${userId}:${householdId}` scope and guards against a torn-down channel's
 * late callback. Realtime payloads are NEVER the source of truth — the next
 * authoritative snapshot always is.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  mapRemoteFinanceToReadModel,
  type RemoteFinanceData,
} from '@/lib/remoteFinanceMapping';
import {
  createRefreshScheduler,
  type RefreshScheduler,
} from '@/lib/remoteFinanceRefreshScheduler';
import { fetchHouseholdFinanceSnapshot } from '@/services/remoteFinance';
import { subscribeHouseholdFinance } from '@/services/remoteFinanceRealtime';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';

interface RemoteFinanceContextValue {
  loading: boolean;
  error: string | null;
  data: RemoteFinanceData | null;
  /**
   * The household id `data` is a CONFIRMED, completed fetch result for —
   * `null` until a fetch for the CURRENT `activeHousehold`/user pair has
   * actually finished.
   */
  loadedForHouseholdId: string | null;
  /**
   * STEP 16-G1A-HARDEN: the user id `data` is a CONFIRMED, completed fetch
   * result for — always set/cleared IN THE SAME STATE UPDATE as
   * `loadedForHouseholdId` (never independently), so the two can never
   * disagree. Exists specifically so a consumer can require BOTH the
   * current session's user id AND the current household id to match
   * before trusting `data` — closing the one-frame window where an
   * account switch (A -> B) could otherwise leave a still-matching
   * `loadedForHouseholdId` from A briefly readable before this provider's
   * own effect has a chance to clear it. See app/remote-data-preview.tsx's
   * `isTrusted` for the actual two-field check.
   */
  loadedForUserId: string | null;
  refreshRemoteFinance: () => Promise<void>;
  clearRemoteFinance: () => void;
}

const RemoteFinanceContext = createContext<RemoteFinanceContextValue | null>(null);

export function RemoteFinanceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { activeHousehold } = useHousehold();
  const householdId = activeHousehold?.id ?? null;
  const userId = user?.id ?? null;

  const [data, setData] = useState<RemoteFinanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedForHouseholdId, setLoadedForHouseholdId] = useState<string | null>(null);
  const [loadedForUserId, setLoadedForUserId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  // The `${userId}:${householdId}` a successful commit was last applied for.
  // Distinguishes an INITIAL load (no snapshot on screen yet -> a failure
  // must surface as an error state) from a BACKGROUND refresh (a snapshot is
  // already on screen -> a failure keeps it, silently; the next write /
  // foreground retries). Reset synchronously whenever the scope changes.
  const lastGoodScopeKeyRef = useRef<string | null>(null);

  // STEP 16-G3-B1: the refresh state machine. Created once per provider
  // instance in an effect (so a dev/StrictMode remount gets a fresh, not a
  // permanently-disposed, one) and disposed on real unmount.
  const schedulerRef = useRef<RefreshScheduler | null>(null);
  useEffect(() => {
    const scheduler = createRefreshScheduler<RemoteFinanceData>({
      fetchSnapshot: async (scope) => {
        const res = await fetchHouseholdFinanceSnapshot(scope.householdId);
        return res.ok
          ? { ok: true, data: mapRemoteFinanceToReadModel(res.raw) }
          : { ok: false, message: res.message };
      },
      commit: (scope, outcome) => {
        if (!mountedRef.current) return;
        const scopeKey = `${scope.userId}:${scope.householdId}`;
        setLoading(false);
        if (outcome.ok) {
          // Atomic swap — never a `setData(null)` blink for a same-scope
          // background refresh (STEP 16-G3-B1 §8). Always set together
          // (STEP 16-G1A-HARDEN §1).
          setData(outcome.data);
          setLoadedForHouseholdId(scope.householdId);
          setLoadedForUserId(scope.userId);
          setError(null);
          lastGoodScopeKeyRef.current = scopeKey;
          return;
        }
        // A background refresh of a scope whose snapshot is already on
        // screen must NOT blank it to an error state — keep the last good
        // snapshot; the next write / foreground refresh retries (§9).
        if (lastGoodScopeKeyRef.current === scopeKey) return;
        // Initial load failed: surface it (STEP 16-G1A §8).
        setError(outcome.message);
        setData(null);
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, []);

  // Household/account switch: reset the visible state to "initial load",
  // then point the scheduler at the new scope (it starts the initial fetch
  // itself). A late response for the OLD scope is discarded inside the
  // scheduler and never reaches `commit`. Runs on sign-out too (userId ->
  // null), clearing everything.
  useEffect(() => {
    mountedRef.current = true;
    lastGoodScopeKeyRef.current = null;
    setData(null);
    setLoadedForHouseholdId(null);
    setLoadedForUserId(null);
    setError(null);

    if (!householdId || !userId) {
      setLoading(false);
      schedulerRef.current?.setScope(null);
      return () => {
        mountedRef.current = false;
      };
    }

    setLoading(true);
    schedulerRef.current?.setScope({ userId, householdId });
    return () => {
      mountedRef.current = false;
    };
  }, [householdId, userId]);

  // STEP 16-G3-B1 §10: background/inactive -> active. One authoritative
  // refresh of the current scope, through the SAME scheduler (no separate
  // fetch path). A cold start is already 'active', and the initial mount
  // fires no 'change' event, so only a genuine return-from-background
  // transition triggers this.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (
        next === 'active' &&
        (prev === 'background' || prev === 'inactive') &&
        userId &&
        householdId
      ) {
        void schedulerRef.current?.request();
      }
    });
    return () => sub.remove();
  }, [userId, householdId]);

  // STEP 16-G3-B2: household finance Realtime. One channel per
  // `${userId}:${householdId}`; every finance-table INSERT/UPDATE is a
  // debounced invalidation that goes through the SAME B1 scheduler. Torn
  // down (removeChannel + debounce cancel) on account/household switch,
  // sign-out and unmount — deps are exactly `[userId, householdId]`.
  const realtimeScopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !householdId) {
      realtimeScopeKeyRef.current = null;
      return;
    }
    const scopeKey = `${userId}:${householdId}`;
    realtimeScopeKeyRef.current = scopeKey;
    const sub = subscribeHouseholdFinance({
      userId,
      householdId,
      onInvalidate: () => {
        // Stale-channel guard (STEP 16-G3-B2 §13): a late flush from a
        // channel that has since been torn down must not refresh the new
        // scope. (The B1 scheduler's own scope/generation guard is a third
        // layer on top of this and `subscribeHouseholdFinance`'s own
        // `disposed` flag.)
        if (realtimeScopeKeyRef.current !== scopeKey) return;
        void schedulerRef.current?.request();
      },
    });
    return () => {
      realtimeScopeKeyRef.current = null;
      sub.unsubscribe();
    };
  }, [userId, householdId]);

  const refreshRemoteFinance = useCallback(async () => {
    await schedulerRef.current?.request();
  }, []);

  const clearRemoteFinance = useCallback(() => {
    lastGoodScopeKeyRef.current = null;
    schedulerRef.current?.setScope(null);
    setData(null);
    setLoadedForHouseholdId(null);
    setLoadedForUserId(null);
    setError(null);
    setLoading(false);
  }, []);

  const value = useMemo<RemoteFinanceContextValue>(
    () => ({
      data,
      loading,
      error,
      loadedForHouseholdId,
      loadedForUserId,
      refreshRemoteFinance,
      clearRemoteFinance,
    }),
    [
      data,
      loading,
      error,
      loadedForHouseholdId,
      loadedForUserId,
      refreshRemoteFinance,
      clearRemoteFinance,
    ],
  );

  return <RemoteFinanceContext.Provider value={value}>{children}</RemoteFinanceContext.Provider>;
}

export function useRemoteFinance(): RemoteFinanceContextValue {
  const ctx = useContext(RemoteFinanceContext);
  if (!ctx) throw new Error('useRemoteFinance must be used within <RemoteFinanceProvider>');
  return ctx;
}
