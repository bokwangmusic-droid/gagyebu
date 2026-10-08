/**
 * Static verification for the household finance reset guard in the Offline
 * Write Queue coordinator (src/services/offlineQueue/coordinator.ts):
 * `preflightResetMarker` (one server `data_reset_at` read before a flush
 * pass sends anything) and `syncResetMarker` (the same reconciliation driven
 * by a freshly loaded snapshot).
 *
 * Fully faked, like coordinator.cases.ts: in-memory queue storage, an
 * in-memory marker store, a scriptable "server marker" and a scriptable
 * `createTransaction` whose call log is the "did a network mutation go
 * out?" assertion. No React, no Supabase.
 */
import {
  createResetMarkerStore,
  resetMarkerKey,
  type ResetMarkerMap,
} from '@/lib/householdResetMarker';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { CreateTransactionResult } from '@/services/remoteFinanceWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { Transaction } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A: CoordinatorScope = { userId: 'u-A', householdId: 'h-A' };
const A2: CoordinatorScope = { userId: 'u-A', householdId: 'h-A2' };
const KEY_A = resetMarkerKey(A.userId, A.householdId);
const KEY_A2 = resetMarkerKey(A2.userId, A2.householdId);
const T1 = '2026-10-08T03:21:45.123456+00:00';
const T2 = '2026-10-09T10:00:00.000001+00:00';

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const draft = (): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: '2026-09-10T09:00:00.000Z',
});

type MarkerAnswer = { ok: true; value: string | null } | { ok: false };

function makeHarness(opts: {
  /** what this device already remembers (undefined entry = not initialized) */
  markers?: ResetMarkerMap;
  /** server `data_reset_at` per household id */
  server?: Record<string, string | null>;
  scope?: CoordinatorScope;
}) {
  let queueValue: string | null = null;
  let failQueueSet = 0;
  /** while set, every durable queue write waits on it (a purge "in flight") */
  let queueSetGate: Promise<void> | null = null;
  /**
   * Every durable queue write attempt. `clearPendingForHousehold` always
   * performs exactly one (its filter builds a new array), so across a window
   * with no enqueue and no send, the delta IS the number of purge runs.
   */
  let queueWrites = 0;
  const storage = {
    getItem: () => Promise.resolve(queueValue),
    setItem: async (_k: string, v: string) => {
      queueWrites += 1;
      if (queueSetGate) await queueSetGate;
      if (failQueueSet > 0) {
        failQueueSet -= 1;
        throw new Error('disk full');
      }
      queueValue = v;
    },
  };

  let markerStored: unknown = opts.markers ?? null;
  let failMarkerSave = false;
  let markerSaves = 0;
  const resetMarkers = createResetMarkerStore({
    load: () => Promise.resolve(markerStored),
    save: (m) => {
      markerSaves += 1;
      if (failMarkerSave) return Promise.reject(new Error('disk full'));
      markerStored = JSON.parse(JSON.stringify(m)) as unknown;
      return Promise.resolve();
    },
  });

  const serverMarker: Record<string, string | null> = { ...(opts.server ?? {}) };
  let markerFetch = (householdId: string): Promise<MarkerAnswer> =>
    Promise.resolve({ ok: true, value: serverMarker[householdId] ?? null });
  const fetchLog: string[] = [];

  let scope: CoordinatorScope | null = opts.scope ?? A;
  let online = false;
  let refreshes = 0;
  const createLog: { id: string; householdId: string }[] = [];
  const serverTxns = new Map<string, Transaction>();
  const timers: { fn: () => void; cancelled: boolean }[] = [];

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => true,
    getKnownCardIds: () => new Set<string>(),
    getServerTransactions: () => serverTxns,
    getServerCards: () => new Map(),
    getServerCategories: () => new Map(),
    getServerBudgets: () => new Map(),
    getServerPlanned: () => new Map(),
    getServerRecurring: () => new Map(),
    getServerGoals: () => new Map(),
    getServerLoans: () => new Map(),
    requestRefresh: () => {
      refreshes += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    fetchResetMarker: (householdId) => {
      fetchLog.push(householdId);
      return markerFetch(householdId);
    },
    resetMarkers,
    createTransaction: (args): Promise<CreateTransactionResult> => {
      const a = args as { id: string; householdId: string; draft: NewTransactionDraft };
      if (!online) return Promise.resolve({ ok: false, message: 'net', transport: true });
      createLog.push({ id: a.id, householdId: a.householdId });
      serverTxns.set(a.id, {
        id: a.id,
        type: a.draft.type,
        category: a.draft.category,
        amount: a.draft.amount,
        memo: a.draft.memo,
        date: a.draft.date,
      });
      return Promise.resolve({ ok: true, id: a.id });
    },
    schedule: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (t) => {
      (t as unknown as { cancelled: boolean }).cancelled = true;
    },
  });

  return {
    coord,
    createLog,
    fetchLog,
    serverMarker,
    setOnline: (b: boolean) => {
      online = b;
    },
    setScope: (s: CoordinatorScope | null) => {
      scope = s;
      coord.setScope(s);
    },
    setMarkerFetch: (f: (householdId: string) => Promise<MarkerAnswer>) => {
      markerFetch = f;
    },
    failQueueSet: (n: number) => {
      failQueueSet = n;
    },
    /** hold every durable queue write until the returned function is called */
    gateQueueSet: () => {
      let open!: () => void;
      queueSetGate = new Promise<void>((r) => {
        open = r;
      });
      return () => {
        queueSetGate = null;
        open();
      };
    },
    failMarkerSave: (b: boolean) => {
      failMarkerSave = b;
    },
    markerSaves: () => markerSaves,
    queueDump: () => queueValue ?? '',
    markerOf: (key: string) =>
      (markerStored as ResetMarkerMap | null)?.[key] as ResetMarkerMap[string] | undefined,
    refreshes: () => refreshes,
    queueWrites: () => queueWrites,
    liveTimers: () => timers.filter((t) => !t.cancelled).length,
    runTimers: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
    /** enqueue while "offline" so the record is durable but unsent, then come back online */
    async seedOffline(s: CoordinatorScope, ids: string[]) {
      online = false;
      // marker reads fail while offline too, like the real network
      const prev = markerFetch;
      markerFetch = () => Promise.resolve({ ok: false });
      for (const id of ids) await coord.enqueueTransactionCreate({ scope: s, entityId: id, payload: draft() });
      await settle();
      markerFetch = prev;
      fetchLog.length = 0;
      online = true;
    },
  };
}

export async function runCoordinatorResetMarkerCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const seen = (value: string | null, key = KEY_A): ResetMarkerMap => ({
    [key]: { initialized: true, value },
  });

  /* ============================ pre-flush server check ============================ */

  // RM1 — marker unchanged -> batch sent normally, ONE marker read for the whole batch
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T1 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm1-a', 'txn-rm1-b', 'txn-rm1-c']);
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM1 same marker -> all 3 queued writes sent, marker read once (per batch, not per write)',
      h.createLog.length === 3 && h.fetchLog.length === 1 && h.fetchLog[0] === 'h-A',
      `sent=${h.createLog.map((c) => c.id)} fetches=${h.fetchLog.length}`,
    );
  }

  // RM2 — null baseline, server now T1 -> purge BEFORE the first mutation goes out
  {
    const h = makeHarness({ markers: seen(null), server: { 'h-A': T1 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm2-a', 'txn-rm2-b']);
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM2 initialized null -> T1: no mutation called, queue purged, marker recorded, refresh requested',
      h.createLog.length === 0 &&
        !h.queueDump().includes('txn-rm2') &&
        h.coord.getState().pendingCount === 0 &&
        h.markerOf(KEY_A)?.value === T1 &&
        h.refreshes() >= 1,
      `sent=${h.createLog.length} pending=${h.coord.getState().pendingCount} marker=${JSON.stringify(h.markerOf(KEY_A))} refreshes=${h.refreshes()}`,
    );
  }

  // RM3 — T1 -> T2 -> purge, nothing sent
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm3']);
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM3 T1 -> T2: no mutation called, queue purged, marker = T2',
      h.createLog.length === 0 && !h.queueDump().includes('txn-rm3') && h.markerOf(KEY_A)?.value === T2,
      `sent=${h.createLog.length} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM4 — the pre-flush read answers null / an OLDER marker than remembered: stale, never a purge
  {
    const h = makeHarness({ markers: seen(T2), server: { 'h-A': null } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm4-a']);
    h.coord.requestFlush();
    await settle(12);
    h.serverMarker['h-A'] = T1;
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-rm4-b', payload: draft() });
    await settle(12);
    check(
      'RM4 pre-flush read of null, then of older T1, while remembering T2 -> both batches sent (nothing purged), marker stays T2',
      enq.ok === true &&
        h.createLog.map((c) => c.id).join() === 'txn-rm4-a,txn-rm4-b' &&
        h.markerOf(KEY_A)?.value === T2,
      `sent=${h.createLog.map((c) => c.id)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM5 — not initialized + server T1 -> baseline stored, NO purge, batch sent
  {
    const h = makeHarness({ server: { 'h-A': T1 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm5']);
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM5 not initialized + T1 -> bootstrap: baseline T1 stored, write sent, nothing purged',
      h.createLog.length === 1 && h.createLog[0].id === 'txn-rm5' && h.markerOf(KEY_A)?.value === T1,
      `sent=${h.createLog.map((c) => c.id)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM6 — not initialized + server null -> null baseline stored, batch sent
  {
    const h = makeHarness({ server: { 'h-A': null } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm6']);
    h.coord.requestFlush();
    await settle(12);
    const m = h.markerOf(KEY_A);
    check(
      'RM6 not initialized + null -> { initialized: true, value: null } stored, write sent',
      h.createLog.length === 1 && m?.initialized === true && m.value === null,
      `sent=${h.createLog.length} marker=${JSON.stringify(m)}`,
    );
  }

  // RM7 — marker read fails -> nothing sent, queue kept, retry scheduled; succeeds on retry
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T1 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm7']);
    h.setMarkerFetch(() => Promise.resolve({ ok: false }));
    h.coord.requestFlush();
    await settle(12);
    const sentWhileFailing = h.createLog.length;
    const keptWhileFailing = h.queueDump().includes('txn-rm7') && h.coord.getState().pendingIds.has('txn-rm7');
    const retryArmed = h.liveTimers() > 0;
    h.setMarkerFetch((id) => Promise.resolve({ ok: true, value: h.serverMarker[id] ?? null }));
    h.runTimers();
    await settle(12);
    check(
      'RM7 marker read failed -> no mutation, record kept, backoff retry armed; retry then sends',
      sentWhileFailing === 0 && keptWhileFailing && retryArmed && h.createLog.some((c) => c.id === 'txn-rm7'),
      `sentWhileFailing=${sentWhileFailing} kept=${keptWhileFailing} retryArmed=${retryArmed} sentAfter=${h.createLog.map((c) => c.id)}`,
    );
  }

  // RM8 — a THROWING marker read is the same as a failed one
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm8']);
    h.setMarkerFetch(() => Promise.reject(new Error('boom')));
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM8 marker read throws -> no mutation, no purge, marker untouched',
      h.createLog.length === 0 && h.queueDump().includes('txn-rm8') && h.markerOf(KEY_A)?.value === T1,
      `sent=${h.createLog.length} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM9 — another household's queue is untouched by a purge, and is checked against ITS OWN marker
  {
    const h = makeHarness({
      markers: { ...seen(T1), ...seen(T1, KEY_A2) },
      server: { 'h-A': T2, 'h-A2': T1 },
    });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm9-a']);
    await h.seedOffline(A2, ['txn-rm9-a2']);
    h.coord.requestFlush(); // live scope A: reset -> purge
    await settle(12);
    const a2KeptAfterPurge = h.queueDump().includes('txn-rm9-a2');
    h.fetchLog.length = 0;
    h.setScope(A2); // switch household: its marker is unchanged -> its write is sent
    await settle(12);
    check(
      'RM9 purge of h-A leaves h-A2 queued; h-A2 is then checked on its own marker and sent',
      h.createLog.length === 1 &&
        h.createLog[0].id === 'txn-rm9-a2' &&
        a2KeptAfterPurge &&
        !h.queueDump().includes('txn-rm9-a"') &&
        h.fetchLog.every((id) => id === 'h-A2') &&
        h.markerOf(KEY_A)?.value === T2 &&
        h.markerOf(KEY_A2)?.value === T1,
      `sent=${h.createLog.map((c) => c.id)} a2Kept=${a2KeptAfterPurge} fetches=${h.fetchLog}`,
    );
  }

  // RM10 — after a purge the queue works again: a NEW write is checked (now unchanged) and sent
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm10-old']);
    h.coord.requestFlush();
    await settle(12);
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-rm10-new', payload: draft() });
    await settle(12);
    check(
      'RM10 post-purge write enqueues and is sent; the purged one never is',
      enq.ok === true &&
        h.createLog.length === 1 &&
        h.createLog[0].id === 'txn-rm10-new',
      `enq=${JSON.stringify(enq)} sent=${h.createLog.map((c) => c.id)}`,
    );
  }

  // RM11 — purge cannot be persisted -> marker NOT recorded, records kept, nothing sent
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm11']);
    h.failQueueSet(1);
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM11 purge persist failure -> marker stays T1 (re-detected later), record kept, no mutation',
      h.createLog.length === 0 && h.queueDump().includes('txn-rm11') && h.markerOf(KEY_A)?.value === T1,
      `sent=${h.createLog.length} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
    // ...and the retry completes it
    h.runTimers();
    await settle(12);
    check(
      'RM11b the retry re-detects the reset and completes the purge',
      h.createLog.length === 0 && !h.queueDump().includes('txn-rm11') && h.markerOf(KEY_A)?.value === T2,
      `sent=${h.createLog.length} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM12 — an empty queue costs no marker read at all
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T1 } });
    await h.coord.hydrate();
    h.setOnline(true);
    h.coord.requestFlush();
    await settle(8);
    check('RM12 nothing to send -> no marker read', h.fetchLog.length === 0, `fetches=${h.fetchLog.length}`);
  }

  /* ============================== snapshot-driven sync ============================== */

  // RM13 — syncResetMarker: bootstrap stores the baseline, keeps the queue
  {
    const h = makeHarness({ server: { 'h-A': null } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm13']);
    h.setOnline(false);
    const out = await h.coord.syncResetMarker(A.userId, A.householdId, null);
    check(
      'RM13 syncResetMarker first sight (null) -> bootstrap, baseline stored, queue kept',
      out.ok && out.decision === 'bootstrap' && h.markerOf(KEY_A)?.value === null && h.queueDump().includes('txn-rm13'),
      `${JSON.stringify(out)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
    // ...then the household's FIRST reset arrives in a snapshot
    const out2 = await h.coord.syncResetMarker(A.userId, A.householdId, T1);
    check(
      'RM13b then null -> T1 from a snapshot -> purge, marker T1, queue empty',
      out2.ok && out2.decision === 'purge' && h.markerOf(KEY_A)?.value === T1 && !h.queueDump().includes('txn-rm13'),
      `${JSON.stringify(out2)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM14 — snapshot path + flush preflight detecting the SAME reset run ONE purge
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm14']);
    const before = h.refreshes();
    h.coord.requestFlush();
    const out = await h.coord.syncResetMarker(A.userId, A.householdId, T2);
    await settle(12);
    check(
      'RM14 concurrent detections share one purge (one refresh request), nothing sent',
      out.ok && h.refreshes() - before === 1 && h.createLog.length === 0 && h.markerOf(KEY_A)?.value === T2,
      `out=${JSON.stringify(out)} refreshes=${h.refreshes() - before} sent=${h.createLog.length}`,
    );
  }

  // RM15 — account-deletion freeze is respected: a reset purge under it does not unfreeze the queue
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.coord.pauseForAccountDeletion();
    await h.coord.syncResetMarker(A.userId, A.householdId, T2);
    const frozen = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-rm15', payload: draft() });
    h.coord.resumeAfterAccountDeletionFailure();
    check(
      'RM15 reset purge during an account-deletion freeze leaves the freeze in place',
      frozen.ok === false,
      JSON.stringify(frozen),
    );
  }

  /* ===================== stale snapshots never purge / never move back ===================== */

  // RM16 — the reported data-loss path: pre-flush check learns T2 and purges ONCE; the user then
  // adds a new write; a snapshot that was already in flight arrives late, still carrying T1.
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm16-old']);
    const writesBeforePurge = h.queueWrites();
    const refreshesBeforePurge = h.refreshes();
    h.coord.requestFlush();
    await settle(12);
    const purgeRuns = h.queueWrites() - writesBeforePurge; // nothing enqueued/sent in this window
    const purgeRefreshes = h.refreshes() - refreshesBeforePurge;
    const markerAfterPurge = h.markerOf(KEY_A)?.value;

    // user is offline again and saves a NEW transaction -> durable, unsent
    h.setOnline(false);
    h.setMarkerFetch(() => Promise.resolve({ ok: false }));
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-rm16-new', payload: draft() });
    await settle();

    const writesBeforeStale = h.queueWrites();
    const refreshesBeforeStale = h.refreshes();
    const late = await h.coord.syncResetMarker(A.userId, A.householdId, T1); // the late, older snapshot
    await settle(12);
    check(
      'RM16 T1 -> T2 purges exactly once; the purged write is gone, nothing was sent',
      purgeRuns === 1 && purgeRefreshes === 1 && markerAfterPurge === T2 && h.createLog.length === 0,
      `purgeRuns=${purgeRuns} refreshes=${purgeRefreshes} marker=${markerAfterPurge} sent=${h.createLog.length}`,
    );
    check(
      'RM16b late T1 snapshot after T2 -> stale: clearPendingForHousehold NOT run again (0 queue writes, 0 refreshes)',
      late.ok === true &&
        late.decision === 'stale' &&
        h.queueWrites() - writesBeforeStale === 0 &&
        h.refreshes() - refreshesBeforeStale === 0,
      `${JSON.stringify(late)} queueWrites=+${h.queueWrites() - writesBeforeStale} refreshes=+${h.refreshes() - refreshesBeforeStale}`,
    );
    check(
      'RM16c the NEW pending write made just before the stale snapshot is preserved; marker still T2',
      enq.ok === true &&
        h.queueDump().includes('txn-rm16-new') &&
        h.coord.getState().pendingIds.has('txn-rm16-new') &&
        h.markerOf(KEY_A)?.value === T2,
      `enq=${JSON.stringify(enq)} kept=${h.queueDump().includes('txn-rm16-new')} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
    // ...and it is delivered normally once the network is back
    h.setOnline(true);
    h.setMarkerFetch((id) => Promise.resolve({ ok: true, value: h.serverMarker[id] ?? null }));
    h.runTimers();
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM16d that preserved write is then sent; the purged old one never is',
      h.createLog.map((c) => c.id).join() === 'txn-rm16-new',
      `sent=${h.createLog.map((c) => c.id)}`,
    );
  }

  // RM17 — a null snapshot after T2 is stale too
  {
    const h = makeHarness({ markers: seen(T2), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm17']);
    h.setOnline(false);
    h.setMarkerFetch(() => Promise.resolve({ ok: false }));
    const writesBefore = h.queueWrites();
    const out = await h.coord.syncResetMarker(A.userId, A.householdId, null);
    await settle(12);
    check(
      'RM17 remembered T2, null snapshot arrives -> stale: 0 purges, write kept, marker stays T2',
      out.ok === true &&
        out.decision === 'stale' &&
        h.queueWrites() - writesBefore === 0 &&
        h.queueDump().includes('txn-rm17') &&
        h.markerOf(KEY_A)?.value === T2,
      `${JSON.stringify(out)} queueWrites=+${h.queueWrites() - writesBefore} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM18 — null -> T1 from a snapshot purges exactly once
  {
    const h = makeHarness({ markers: seen(null), server: { 'h-A': T1 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm18']);
    h.setOnline(false);
    h.setMarkerFetch(() => Promise.resolve({ ok: false }));
    const writesBefore = h.queueWrites();
    const out = await h.coord.syncResetMarker(A.userId, A.householdId, T1);
    const again = await h.coord.syncResetMarker(A.userId, A.householdId, T1);
    await settle(12);
    check(
      'RM18 null -> T1 purges once; the same T1 again is unchanged (1 queue write total)',
      out.decision === 'purge' &&
        again.decision === 'unchanged' &&
        h.queueWrites() - writesBefore === 1 &&
        !h.queueDump().includes('txn-rm18'),
      `${out.decision}/${again.decision} queueWrites=+${h.queueWrites() - writesBefore}`,
    );
  }

  // RM19 — the same instant written with another UTC offset is not a reset, on either path
  {
    const utc = '2026-10-08T03:21:45.123456+00:00';
    const kst = '2026-10-08T12:21:45.123456+09:00';
    const h = makeHarness({ markers: seen(utc), server: { 'h-A': kst } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm19']);
    const out = await h.coord.syncResetMarker(A.userId, A.householdId, kst); // snapshot path
    h.coord.requestFlush(); // pre-flush path reads `kst` from the server
    await settle(12);
    check(
      'RM19 same instant in another timezone rendering -> unchanged on both paths, write sent, marker text untouched',
      out.decision === 'unchanged' &&
        h.createLog.map((c) => c.id).join() === 'txn-rm19' &&
        h.markerOf(KEY_A)?.value === utc,
      `${out.decision} sent=${h.createLog.map((c) => c.id)} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  // RM20 — same millisecond, one microsecond later: still detected as a new reset
  {
    const early = '2026-10-08T03:21:45.123456+00:00';
    const late = '2026-10-08T03:21:45.123457+00:00';
    const h = makeHarness({ markers: seen(early), server: { 'h-A': late } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm20']);
    h.coord.requestFlush();
    await settle(12);
    check(
      'RM20 a reset 1 microsecond after the remembered one -> purge before any mutation',
      h.createLog.length === 0 && !h.queueDump().includes('txn-rm20') && h.markerOf(KEY_A)?.value === late,
      `sent=${h.createLog.length} marker=${JSON.stringify(h.markerOf(KEY_A))}`,
    );
  }

  /* ============================ freeze ownership ============================ */

  const tryEnqueue = (h: ReturnType<typeof makeHarness>, id: string) =>
    h.coord.enqueueTransactionCreate({ scope: A, entityId: id, payload: draft() });

  // RM21 — an account deletion pauses WHILE a reset purge is mid-write: the purge ending must not thaw it
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    await h.seedOffline(A, ['txn-rm21']);
    const open = h.gateQueueSet();
    const purge = h.coord.syncResetMarker(A.userId, A.householdId, T2);
    await settle();
    await h.coord.pauseForAccountDeletion(); // arrives during the purge
    open();
    const out = await purge;
    await settle();
    const frozen = await tryEnqueue(h, 'txn-rm21-a');
    h.coord.resumeAfterAccountDeletionFailure();
    const resumed = await tryEnqueue(h, 'txn-rm21-b');
    check(
      'RM21 account-delete pause taken during a purge survives that purge finishing; its own resume lifts it',
      out.ok && !h.queueDump().includes('"txn-rm21"') && frozen.ok === false && resumed.ok === true,
      `out=${JSON.stringify(out)} frozen=${JSON.stringify(frozen)} resumed=${JSON.stringify(resumed)}`,
    );
  }

  // RM22 — two caller-owned freezes + the account one: each release drops only its own
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T1 } });
    await h.coord.hydrate();
    const releaseA = await h.coord.freezeQueue();
    const releaseB = await h.coord.freezeQueue();
    await h.coord.pauseForAccountDeletion();
    releaseA();
    releaseA(); // a double release must not eat someone else's hold
    const afterA = await tryEnqueue(h, 'txn-rm22-a');
    h.coord.resumeAfterAccountDeletionFailure();
    h.coord.resumeAfterAccountDeletionFailure();
    const afterAccount = await tryEnqueue(h, 'txn-rm22-b');
    releaseB();
    const afterB = await tryEnqueue(h, 'txn-rm22-c');
    check(
      'RM22 freeze holds are per owner: frozen until the LAST one is released, double release is harmless',
      afterA.ok === false && afterAccount.ok === false && afterB.ok === true,
      `${JSON.stringify(afterA)} ${JSON.stringify(afterAccount)} ${JSON.stringify(afterB)}`,
    );
  }

  // RM23 — a scope change still lifts the ACCOUNT freeze (sign-in after a deletion), but not a caller-owned one
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T1, 'h-A2': null } });
    await h.coord.hydrate();
    await h.seedOffline(A2, ['txn-rm23-a2']);
    await h.coord.pauseForAccountDeletion();
    h.setScope(A2);
    const accountLifted = await h.coord.enqueueTransactionCreate({ scope: A2, entityId: 'txn-rm23-x', payload: draft() });
    await settle(12);
    const sentBefore = h.createLog.length;

    const release = await h.coord.freezeQueue();
    h.setScope(A);
    const held = await tryEnqueue(h, 'txn-rm23-y');
    release();
    const thawed = await tryEnqueue(h, 'txn-rm23-z');
    await settle(12);
    check(
      'RM23 scope change lifts the account freeze as before; under a caller-owned freeze it waits, then the live scope resumes',
      accountLifted.ok === true &&
        sentBefore === 2 &&
        held.ok === false &&
        thawed.ok === true &&
        h.createLog[h.createLog.length - 1]?.householdId === 'h-A',
      `lifted=${JSON.stringify(accountLifted)} sentBefore=${sentBefore} held=${JSON.stringify(held)} thawed=${JSON.stringify(thawed)} sent=${h.createLog.map((c) => c.id)}`,
    );
  }

  /* ============================ arming the marker before a reset ============================ */

  // RM24 — not initialized: the baseline is written, so a restart after the reset purges instead of bootstrapping
  {
    const h = makeHarness({ server: { 'h-A': null } });
    await h.coord.hydrate();
    const armed = await h.coord.ensureResetMarkerBaseline(A.userId, A.householdId, null);
    const stored = h.markerOf(KEY_A);
    const decision = (await h.coord.syncResetMarker(A.userId, A.householdId, T1)).decision;
    check(
      'RM24 arm on an un-remembered scope -> durable null baseline; the reset that follows is a purge, not a bootstrap',
      armed === true && stored?.initialized === true && stored.value === null && decision === 'purge',
      `armed=${armed} stored=${JSON.stringify(stored)} decision=${decision}`,
    );
  }

  // RM25 — already remembered: the entry is not changed, but it IS written again (an earlier save may have failed)
  {
    const h = makeHarness({ markers: seen(T1), server: { 'h-A': T2 } });
    await h.coord.hydrate();
    const before = h.markerSaves();
    const armed = await h.coord.ensureResetMarkerBaseline(A.userId, A.householdId, T2);
    check(
      'RM25 arm on a remembered scope -> value untouched (never moved to the server value), one durable write',
      armed === true && h.markerOf(KEY_A)?.value === T1 && h.markerSaves() - before === 1,
      `armed=${armed} marker=${JSON.stringify(h.markerOf(KEY_A))} saves=${h.markerSaves() - before}`,
    );
  }

  // RM26 — the write fails: reported, so the caller does not start the reset
  {
    const h = makeHarness({ server: { 'h-A': null } });
    await h.coord.hydrate();
    h.failMarkerSave(true);
    const armed = await h.coord.ensureResetMarkerBaseline(A.userId, A.householdId, null);
    check('RM26 arm with failing storage -> false', armed === false, `armed=${armed}`);
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
