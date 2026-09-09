/**
 * Pending (offline) finance writes — STEP 16-H2-A2.
 *
 * A thin React shell over `createPendingWriteCoordinator`
 * (src/services/offlineQueue/coordinator.ts). It:
 *   - owns ONE coordinator (which owns ONE durable queue controller),
 *   - feeds it live scope / remote-readiness / server-snapshot values via
 *     refs (never captured stale),
 *   - re-renders when the coordinator's state changes,
 *   - wires the minimal flush triggers: hydrate, remote-ready, AppState
 *     foreground. Backoff + enqueue-triggered flush live in the coordinator.
 *
 * It NEVER owns or copies the authoritative snapshot — that stays in
 * `RemoteFinanceProvider`. This provider only holds durable UNSENT
 * operations. Transaction CREATE only in this step.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { PendingWrite } from '@/lib/offlineQueue';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
  type EnqueueOutcome,
  type Hydration,
} from '@/services/offlineQueue/coordinator';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { useRemoteFinance } from '@/store/remoteFinance';

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_OPS: PendingWrite[] = [];

interface PendingFinanceValue {
  hydration: Hydration;
  hydrationReady: boolean;
  /** Current-scope transaction-create ops (incl. terminal-failed) for the overlay. */
  pendingTransactionCreateOps: PendingWrite[];
  /** entity ids of not-yet-sent pending creates for the current scope. */
  pendingTransactionIds: ReadonlySet<string>;
  /** entity ids of terminal-failed, held creates for the current scope. */
  failedTransactionIds: ReadonlySet<string>;
  pendingCount: number;
  lastError: string | null;
  /** Try a direct write's transport failure as a durable offline enqueue. */
  enqueueTransactionCreate: (args: {
    scope: CoordinatorScope;
    entityId: string;
    payload: NewTransactionDraft;
  }) => Promise<EnqueueOutcome>;
  /** Ask for a flush now (e.g. pull-to-refresh). `includeFailed` retries held ops. */
  requestFlush: (opts?: { includeFailed?: boolean }) => void;
}

const PendingFinanceContext = createContext<PendingFinanceValue | null>(null);

export function PendingWritesProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const rf = useRemoteFinance();

  const userId = session?.user?.id ?? null;
  const householdId = activeHousehold?.id ?? null;
  const scope: CoordinatorScope | null =
    userId && householdId ? { userId, householdId } : null;
  const scopeKey = scope ? `${scope.userId}:${scope.householdId}` : null;

  const remoteReady =
    !!rf.data &&
    !!userId &&
    !!householdId &&
    rf.loadedForUserId === userId &&
    rf.loadedForHouseholdId === householdId;

  // ---- live refs (read at use-time by the coordinator, never captured) ----
  const scopeRef = useRef<CoordinatorScope | null>(scope);
  scopeRef.current = scope;
  const remoteReadyRef = useRef(remoteReady);
  remoteReadyRef.current = remoteReady;
  const refreshRef = useRef(rf.refreshRemoteFinance);
  refreshRef.current = rf.refreshRemoteFinance;

  const knownCardIds = useMemo<ReadonlySet<string>>(
    () => new Set((rf.data?.cards ?? []).map((c) => c.id)),
    [rf.data?.cards],
  );
  const knownCardIdsRef = useRef<ReadonlySet<string>>(knownCardIds);
  knownCardIdsRef.current = knownCardIds;

  const serverTxnIds = useMemo<ReadonlySet<string>>(
    () => new Set((rf.data?.transactions ?? []).map((t) => t.id)),
    [rf.data?.transactions],
  );
  const serverTxnIdsRef = useRef<ReadonlySet<string>>(serverTxnIds);
  serverTxnIdsRef.current = serverTxnIds;

  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const coordRef = useRef<ReturnType<typeof createPendingWriteCoordinator> | null>(null);
  if (coordRef.current == null) {
    coordRef.current = createPendingWriteCoordinator({
      getScope: () => scopeRef.current,
      getRemoteReady: () => remoteReadyRef.current,
      getKnownCardIds: () => knownCardIdsRef.current,
      getServerTransactionIds: () => serverTxnIdsRef.current,
      requestRefresh: () => refreshRef.current(),
      onChange: () => forceRender(),
    });
  }
  const coord = coordRef.current;

  // ---- hydrate once; dispose on unmount ----
  useEffect(() => {
    void coord.hydrate();
    return () => coord.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- scope wiring ----
  useEffect(() => {
    coord.setScope(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // ---- Trigger A/B: hydrated + valid scope + remote snapshot trusted ----
  const hydration = coord.getState().hydration;
  useEffect(() => {
    if (scopeKey && remoteReady && hydration === 'ready') {
      coord.requestFlush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, remoteReady, hydration]);

  // ---- AppState foreground: retry hydrate if failed, then flush ----
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && (prev === 'background' || prev === 'inactive')) {
        if (coord.getState().hydration === 'failed') void coord.hydrate();
        coord.requestFlush();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = coord.getState();
  const value = useMemo<PendingFinanceValue>(
    () => ({
      hydration: state.hydration,
      hydrationReady: state.hydration === 'ready',
      pendingTransactionCreateOps: state.scopeOps.length > 0 ? state.scopeOps : EMPTY_OPS,
      pendingTransactionIds: state.pendingIds.size > 0 ? state.pendingIds : EMPTY_SET,
      failedTransactionIds: state.failedIds.size > 0 ? state.failedIds : EMPTY_SET,
      pendingCount: state.pendingCount,
      lastError: state.lastError,
      enqueueTransactionCreate: coord.enqueueTransactionCreate,
      requestFlush: coord.requestFlush,
    }),
    // state is a fresh object each render; that's exactly when something changed
    [state, coord],
  );

  return (
    <PendingFinanceContext.Provider value={value}>{children}</PendingFinanceContext.Provider>
  );
}

export function usePendingWrites(): PendingFinanceValue {
  const ctx = useContext(PendingFinanceContext);
  if (!ctx) throw new Error('usePendingWrites must be used within <PendingWritesProvider>');
  return ctx;
}
