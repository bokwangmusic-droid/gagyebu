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

import {
  mapRemoteFinanceToReadModel,
  type RemoteFinanceData,
} from '@/lib/remoteFinanceMapping';
import { fetchHouseholdFinanceSnapshot } from '@/services/remoteFinance';
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
  // Imperative-only bookkeeping (STEP 16-E's `latestUserIdRef` pattern):
  // identifies which (user, household) pair the in-flight fetch was
  // issued for. A response is applied ONLY if this still matches when it
  // resolves — if the user switches household (or account) while a fetch
  // for the PREVIOUS one is still in flight, that late response is simply
  // dropped instead of being shown under the new household (STEP 16-G1A
  // §4's "A household fetch 도중 B household로 바뀌면 A 응답을 무시").
  const requestKeyRef = useRef<string | null>(null);

  const runFetch = useCallback(async (forHouseholdId: string, forUserId: string) => {
    const key = `${forUserId}:${forHouseholdId}`;
    requestKeyRef.current = key;
    setLoading(true);
    setError(null);

    const result = await fetchHouseholdFinanceSnapshot(forHouseholdId);

    if (!mountedRef.current) return;
    if (requestKeyRef.current !== key) return; // stale — household/user moved on

    if (!result.ok) {
      setError(result.message);
      setData(null);
      setLoading(false);
      // loadedForHouseholdId/loadedForUserId intentionally left untouched:
      // this fetch did not produce confirmed data for this (user,
      // household) pair (STEP 16-G1A §8 — partial/failed fetches are
      // never presented as ready).
      return;
    }

    setData(mapRemoteFinanceToReadModel(result.raw));
    // Always set together, in the same update — STEP 16-G1A-HARDEN §1.
    setLoadedForHouseholdId(forHouseholdId);
    setLoadedForUserId(forUserId);
    setLoading(false);
  }, []);

  // Household/account switch: invalidate immediately, then fetch fresh.
  // Runs on sign-out too (userId becomes null), clearing everything.
  useEffect(() => {
    mountedRef.current = true;
    // Step 1 (STEP 16-G1A §4): stop trusting whatever the previous
    // household's data was, synchronously, before any new fetch starts.
    requestKeyRef.current = null;
    setData(null);
    setLoadedForHouseholdId(null);
    setLoadedForUserId(null);
    setError(null);

    if (!householdId || !userId) {
      setLoading(false);
      return;
    }

    void runFetch(householdId, userId);
    return () => {
      mountedRef.current = false;
    };
  }, [householdId, userId, runFetch]);

  const refreshRemoteFinance = useCallback(async () => {
    if (!householdId || !userId) return;
    await runFetch(householdId, userId);
  }, [householdId, userId, runFetch]);

  const clearRemoteFinance = useCallback(() => {
    requestKeyRef.current = null;
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
