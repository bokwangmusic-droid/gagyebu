/**
 * Static verification for the Offline Write Queue coordinator's
 * SAVINGS-GOAL wiring — STEP 16-H2-G1. A small, self-contained harness
 * (separate from coordinator.cases.ts) exercising `createGoal`/`updateGoal`/
 * `softDeleteGoal` dispatch, FROZEN `expectedUpdatedAt` forwarding, the
 * CREATE/UPDATE/DELETE ack reconcile against `getServerGoals()`, the
 * "authoritative server row (incl. `saved`) is never overwritten by a stale
 * local draft" rule, transport-vs-terminal normalization, discard, and scope
 * safety. `addGoalMovement` (deposit/withdraw) is OUT OF SCOPE and is never
 * exercised here. No React, no Supabase. ENGINE ONLY — no UI call site is
 * exercised.
 */
import { QUEUE_SCHEMA_VERSION, type PendingGoalCreate } from '@/lib/offlineQueue';
import type { NewGoalDraft } from '@/lib/remoteGoalWriteMapping';
import type {
  CreateGoalResult,
  SoftDeleteGoalResult,
  UpdateGoalResult,
} from '@/services/remoteGoalWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { Goal } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A: CoordinatorScope = { userId: 'u-A', householdId: 'h-A' };
const B: CoordinatorScope = { userId: 'u-B', householdId: 'h-B' };

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const gd = (over: Partial<NewGoalDraft> = {}): NewGoalDraft => ({
  name: '내 집 마련',
  target: 5000000,
  deadline: '2027-01-01',
  icon: '🏠',
  ...over,
});

const srvRow = (id: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name: '내 집 마련',
  target: 5000000,
  saved: 0,
  deadline: '2027-01-01',
  icon: '🏠',
  createdAt: '2026-09-10T09:00:00.000Z',
  ...over,
});

function memStorage(seed?: string) {
  let value: string | null = seed ?? null;
  let failNextSet = 0;
  return {
    getItem: () => Promise.resolve(value),
    setItem: (_k: string, v: string) => {
      if (failNextSet > 0) {
        failNextSet -= 1;
        return Promise.reject(new Error('disk full'));
      }
      value = v;
      return Promise.resolve();
    },
    failSet: (n: number) => {
      failNextSet = n;
    },
    dump: () => value,
  };
}

type CreateArgs = { id: string; householdId: string; expectedUserId: string; draft: NewGoalDraft };
type UpdateArgs = CreateArgs & { expectedUpdatedAt: string };
type DeleteArgs = { id: string; householdId: string; expectedUserId: string; expectedUpdatedAt: string };

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  server: Map<string, Goal>;
  storage: ReturnType<typeof memStorage>;
  createLog: CreateArgs[];
  updateLog: UpdateArgs[];
  deleteLog: DeleteArgs[];
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setCreate: (f: (a: CreateArgs) => Promise<CreateGoalResult>) => void;
  setUpdate: (f: (a: UpdateArgs) => Promise<UpdateGoalResult>) => void;
  setDelete: (f: (a: DeleteArgs) => Promise<SoftDeleteGoalResult>) => void;
  serverPut: (row: Goal) => void;
  serverDelete: (id: string) => void;
  runTimers: () => void;
  refreshes: () => number;
}

function makeHarness(opts?: { seed?: string }): Harness {
  const server = new Map<string, Goal>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = A;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const createLog: CreateArgs[] = [];
  const updateLog: UpdateArgs[] = [];
  const deleteLog: DeleteArgs[] = [];

  // default create: server accepts + snapshot reflects it. `saved` is NEVER
  // set by a CREATE — the DB default (0) applies, mirroring the real
  // `createGoal()` (`saved` is never in the insert row).
  let createImpl = async (a: CreateArgs): Promise<CreateGoalResult> => {
    createLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.set(a.id, {
      id: a.id,
      name: a.draft.name.trim(),
      target: a.draft.target,
      saved: 0,
      deadline: a.draft.deadline,
      icon: a.draft.icon,
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    return { ok: true, id: a.id };
  };
  // default update: `saved` is NEVER touched — mirrors the real `updateGoal()`
  // (the UPDATE grant on `goals` doesn't even include `saved`).
  let updateImpl = async (a: UpdateArgs): Promise<UpdateGoalResult> => {
    updateLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    const prev = server.get(a.id);
    if (prev) {
      server.set(a.id, {
        ...prev,
        name: a.draft.name.trim(),
        target: a.draft.target,
        deadline: a.draft.deadline,
        icon: a.draft.icon,
      });
    }
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };
  let deleteImpl = async (a: DeleteArgs): Promise<SoftDeleteGoalResult> => {
    deleteLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.delete(a.id);
    return { ok: true };
  };

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => true,
    getKnownCardIds: () => new Set(),
    getServerTransactions: () => new Map(),
    getServerCards: () => new Map(),
    getServerCategories: () => new Map(),
    getServerBudgets: () => new Map(),
    getServerPlanned: () => new Map(),
    getServerRecurring: () => new Map(),
    getServerGoals: () => server,
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    createGoal: (a) => createImpl(a as CreateArgs),
    updateGoal: (a) => updateImpl(a as UpdateArgs),
    softDeleteGoal: (a) => deleteImpl(a as DeleteArgs),
    schedule: (fn, ms) => {
      const id = ++timerSeq;
      timers.push({ id, fn, ms, cancelled: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (t) => {
      const e = timers.find((x) => x.id === (t as unknown as number));
      if (e) e.cancelled = true;
    },
    yieldToShell: () => Promise.resolve(),
  });

  return {
    coord,
    server,
    storage,
    createLog,
    updateLog,
    deleteLog,
    timers,
    setScope: (s) => {
      scope = s;
      coord.setScope(s);
    },
    setCreate: (f) => {
      createImpl = f;
    },
    setUpdate: (f) => {
      updateImpl = f;
    },
    setDelete: (f) => {
      deleteImpl = f;
    },
    serverPut: (row) => {
      server.set(row.id, row);
    },
    serverDelete: (id) => {
      server.delete(id);
    },
    runTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    refreshes: () => refreshCount,
  };
}

const TRANSPORT_C: CreateGoalResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_U: UpdateGoalResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_D: SoftDeleteGoalResult = { ok: false, reason: 'error', message: 'net', transport: true };
const CONFLICT_C: CreateGoalResult = { ok: false, reason: 'conflict', message: '충돌' };
const INVALID_C: CreateGoalResult = { ok: false, reason: 'invalid', message: '확인해 주세요' };
const CONFLICT_U: UpdateGoalResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };
const GONE_U: UpdateGoalResult = { ok: false, reason: 'gone', message: '삭제된 항목' };
const CONFLICT_D: SoftDeleteGoalResult = { ok: false, reason: 'conflict', message: '이미 변경됨' };

const seedWith = (recs: PendingGoalCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingGoalCreate> = {}): PendingGoalCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'goal',
  op: 'create',
  entityId: 'goal-1',
  payload: gd(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorGoalCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ RUNOP ============================ */

  // 10 — CREATE dispatch: createGoal called with id === entityId, no token, `saved` defaults to 0
  {
    const h = makeHarness();
    await h.coord.hydrate();
    const enq = await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd({ target: 3000000 }) });
    await settle(8);
    check(
      '10 CREATE dispatch -> createGoal(id=entityId, draft), lands on server with saved=0, queue empties',
      enq.ok === true &&
        h.createLog.length === 1 &&
        h.createLog[0].id === 'goal-1' &&
        h.server.get('goal-1')?.target === 3000000 &&
        h.server.get('goal-1')?.saved === 0 &&
        h.coord.getState().goal.scopeOps.length === 0,
      JSON.stringify({ log: h.createLog, server: [...h.server] }),
    );
  }

  // 11 — UPDATE: frozen expectedUpdatedAt forwarded verbatim on EVERY replay
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1', { target: 999 }));
    h.setUpdate((a) => {
      h.updateLog.push(a);
      return Promise.resolve(TRANSPORT_U); // stay "offline" across retries
    });
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 1 }),
      expectedUpdatedAt: 'FROZEN-V1',
    });
    await settle();
    h.runTimers(); // backoff retry
    await settle(6);
    check(
      '11 UPDATE: every replay uses the SAME frozen expectedUpdatedAt (never refreshed)',
      h.updateLog.length >= 2 && h.updateLog.every((u) => u.expectedUpdatedAt === 'FROZEN-V1'),
      JSON.stringify(h.updateLog.map((u) => u.expectedUpdatedAt)),
    );
  }

  // 12 — DELETE: frozen expectedUpdatedAt forwarded verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1'));
    h.setDelete((a) => {
      h.deleteLog.push(a);
      return Promise.resolve(TRANSPORT_D);
    });
    await h.coord.enqueueGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'FROZEN-DEL' });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      '12 DELETE: every replay uses the SAME frozen expectedUpdatedAt',
      h.deleteLog.length >= 2 && h.deleteLog.every((d) => d.expectedUpdatedAt === 'FROZEN-DEL'),
      JSON.stringify(h.deleteLog.map((d) => d.expectedUpdatedAt)),
    );
  }

  // 13 — transport:true is normalized to a retryable transport halt (enqueued, not failed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    const enq = await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await settle();
    const st = h.coord.getState().goal;
    check(
      '13 transport:true -> retained pending (not failed), a backoff timer is scheduled',
      enq.ok === true &&
        st.pendingIds.has('goal-1') &&
        !st.failedIds.has('goal-1') &&
        h.timers.some((t) => !t.cancelled),
      JSON.stringify({ enq, pending: [...st.pendingIds], failed: [...st.failedIds] }),
    );
  }

  // 14 — a non-transport conflict is TERMINAL: retained failed, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_C);
    });
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await settle();
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    const st = h.coord.getState().goal;
    check(
      '14 CREATE conflict -> terminal-failed, reason retained, exactly one attempt',
      st.failedIds.has('goal-1') && st.failedReasons.get('goal-1') === 'conflict' && calls === 1,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('goal-1'), calls }),
    );
  }

  // 15 — gone UPDATE is TERMINAL (reason preserved, not collapsed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1'));
    h.setUpdate(() => Promise.resolve(GONE_U));
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 5 }),
      expectedUpdatedAt: 'V0',
    });
    await settle();
    const st = h.coord.getState().goal;
    check(
      '15 UPDATE gone -> terminal-failed with reason "gone"',
      st.failedIds.has('goal-1') && st.failedReasons.get('goal-1') === 'gone',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('goal-1') }),
    );
  }

  // 15b — CREATE `invalid` -> reason-less generic terminal (mirrors card/category/planned/recurring)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(INVALID_C));
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await settle();
    const st = h.coord.getState().goal;
    check(
      '15b CREATE invalid -> terminal-failed with NO stored reason',
      st.failedIds.has('goal-1') && st.failedReasons.get('goal-1') === undefined,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('goal-1') }),
    );
  }

  /* ========================= CREATE ACK ========================= */

  // 16 — server absent after replay -> NOT acked, op RETAINED (never durably removed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setCreate((a) => {
      calls += 1;
      h.createLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true, id: a.id } : TRANSPORT_C);
    });
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await settle(8);
    check(
      '16 CREATE: server row never appears in snapshot -> not acked, op still queued (not durably removed)',
      h.coord.getState().goal.scopeOps.length === 1 &&
        calls >= 1 &&
        !h.server.has('goal-1') &&
        !h.coord.getState().goal.failedIds.has('goal-1'),
      JSON.stringify({ ops: h.coord.getState().goal.scopeOps.length, calls }),
    );
  }

  // 17 — same id + same payload on server -> ack (idempotent lost-response)
  {
    const h = makeHarness({
      seed: seedWith([rec({ queueId: 'q-17', entityId: 'goal-1', payload: gd({ target: 7700000 }) })]),
    });
    // server already holds the exact same create (response was lost)
    h.serverPut(srvRow('goal-1', { target: 7700000 }));
    let calls = 0;
    h.setCreate((a) => {
      calls += 1;
      return Promise.resolve({ ok: true, id: a.id });
    });
    await h.coord.hydrate();
    await settle(8);
    check(
      '17 CREATE lost-response: server row matches draft -> ack removes it durably',
      h.coord.getState().goal.scopeOps.length === 0 && h.server.get('goal-1')?.target === 7700000,
      JSON.stringify({ ops: h.coord.getState().goal.scopeOps, calls }),
    );
  }

  // 18 — same id + DIFFERENT server payload -> NOT acked; a service conflict is retained terminal
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1', { target: 2000000 })); // someone else's row on the same id
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_C); // real service: 23505 reconcile says "different create"
    });
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd({ target: 1000000 }) });
    await settle();
    h.coord.requestFlush();
    await settle();
    const st = h.coord.getState().goal;
    check(
      '18 CREATE same id / different payload -> terminal conflict retained, server row untouched, no auto-retry',
      st.failedIds.has('goal-1') &&
        st.failedReasons.get('goal-1') === 'conflict' &&
        h.server.get('goal-1')?.target === 2000000 &&
        calls === 1,
      JSON.stringify({ failed: [...st.failedIds], server: h.server.get('goal-1')?.target, calls }),
    );
  }

  /* ========================= UPDATE ACK ========================= */

  // 19 — matching server draft after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1', { target: 1000000 }));
    const enq = await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 2500000 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '19 UPDATE online -> applied, content-matched, queue empty, refresh requested',
      enq.ok === true &&
        h.updateLog.length === 1 &&
        h.server.get('goal-1')?.target === 2500000 &&
        h.refreshes() >= 1 &&
        h.coord.getState().goal.scopeOps.length === 0,
      JSON.stringify({ server: h.server.get('goal-1')?.target, refreshes: h.refreshes() }),
    );
  }

  // 20 — server shows a DIFFERENT draft than attempted -> NOT acked (content mismatch)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1', { target: 1000000 }));
    let calls = 0;
    h.setUpdate((a) => {
      calls += 1;
      h.updateLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true, updatedAt: 'V2' } : TRANSPORT_U);
    });
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 2500000 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '20 UPDATE: snapshot content != attempted draft -> not acked, op still queued, server never overwritten to 2500000',
      h.coord.getState().goal.scopeOps.length === 1 &&
        calls >= 1 &&
        h.server.get('goal-1')?.target === 1000000,
      JSON.stringify({
        ops: h.coord.getState().goal.scopeOps.length,
        calls,
        server: h.server.get('goal-1')?.target,
      }),
    );
  }

  // 21 — stale concurrent server edit is NEVER overwritten (service conflict, one attempt)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1', { target: 1500000 })); // device B already won with 1.5M
    let calls = 0;
    h.setUpdate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_U); // frozen token no longer matches
    });
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 1200000 }), // A's stale draft
      expectedUpdatedAt: 'STALE-V0',
    });
    await settle(8);
    const st = h.coord.getState().goal;
    check(
      '21 UPDATE stale token -> server stays 1500000, one attempt, retained failed (no blind LWW)',
      h.server.get('goal-1')?.target === 1500000 &&
        calls === 1 &&
        st.failedIds.has('goal-1') &&
        st.failedReasons.get('goal-1') === 'conflict' &&
        (h.storage.dump() ?? '').includes('goal-1'),
      JSON.stringify({ server: h.server.get('goal-1')?.target, calls, failed: [...st.failedIds] }),
    );
  }

  /* ========================= DELETE ACK ========================= */

  // 22 — active server row still present after replay -> NOT acked; op retained
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1'));
    let calls = 0;
    h.setDelete((a) => {
      calls += 1;
      h.deleteLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true } : TRANSPORT_D);
    });
    await h.coord.enqueueGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      '22 DELETE: active server row still present -> not acked, op still queued',
      h.coord.getState().goal.scopeOps.length === 1 && calls >= 1 && h.server.has('goal-1'),
      JSON.stringify({ ops: h.coord.getState().goal.scopeOps.length, calls }),
    );
  }

  // 23 — server row absent after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1'));
    const enq = await h.coord.enqueueGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      '23 DELETE online -> server row gone, queue empty, refresh requested',
      enq.ok === true &&
        !h.server.has('goal-1') &&
        h.refreshes() >= 1 &&
        h.coord.getState().goal.scopeOps.length === 0,
      JSON.stringify({ hasRow: h.server.has('goal-1'), ops: h.coord.getState().goal.scopeOps.length }),
    );
  }

  // 30 — failed DELETE -> retained + failed; authoritative row NEVER removed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('goal-1', { target: 1000000 }));
    h.setDelete(() => Promise.resolve(CONFLICT_D));
    await h.coord.enqueueGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'V1' });
    await settle();
    const st = h.coord.getState().goal;
    check(
      '30 failed DELETE -> retained + failedIds, authoritative server row still present',
      st.failedIds.has('goal-1') && h.server.get('goal-1')?.target === 1000000 && st.scopeOps.length === 1,
      JSON.stringify({ failed: [...st.failedIds], server: h.server.get('goal-1')?.target }),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 36 — scope isolation: household B never sees household A's goal op
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState().goal;
    h.setScope(A);
    const underA = h.coord.getState().goal;
    check(
      '36 scope isolation: goal op hidden under B, visible again under A',
      underB.scopeOps.length === 0 && underA.pendingIds.has('goal-1'),
      `B=${underB.scopeOps.length} A=${[...underA.pendingIds]}`,
    );
  }

  // 37 — enqueue persist failure -> {ok:false, persist}, item NOT visible
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    h.storage.failSet(1);
    const enq = await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await settle();
    check(
      '37 enqueue persist failure -> {ok:false, persist}, not visible',
      enq.ok === false && enq.reason === 'persist' && h.coord.getState().goal.scopeOps.length === 0,
      JSON.stringify(enq),
    );
  }

  // 38 — restart/hydrate: a seeded goal CREATE is restored, no duplicate
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd({ target: 5555500 }) });
    await settle();
    h.coord.dispose();
    const stored = h.storage.dump();

    const h2 = makeHarness({ seed: stored ?? undefined });
    h2.setCreate(() => Promise.resolve(TRANSPORT_C)); // still offline
    await h2.coord.hydrate();
    await settle();
    check(
      '38 restart -> pending goal row restored from storage, exactly one',
      h2.coord.getState().goal.pendingIds.has('goal-1') && h2.coord.getState().goal.scopeOps.length === 1,
      JSON.stringify([...h2.coord.getState().goal.pendingIds]),
    );
  }

  // 39 — discardPending: exact queueId removal, scope isolation, other entity untouched
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() => Promise.resolve(CONFLICT_U));
    h.serverPut(srvRow('goal-1', { target: 9999999 }));
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 1 }),
      expectedUpdatedAt: 'V1',
    });
    await settle();
    const recQ = h.coord.getState().goal.scopeOps.find((o) => o.entityId === 'goal-1');
    // scope isolation: cannot discard A's record while B is active
    h.setScope(B);
    const outB = await h.coord.discardPending(recQ!.queueId);
    h.setScope(A);
    const outA = await h.coord.discardPending(recQ!.queueId);
    check(
      '39 discard: refused under wrong scope, exact queueId removed under right scope, server untouched',
      outB.ok === false &&
        outB.reason === 'scope' &&
        outA.ok === true &&
        h.coord.getState().goal.scopeOps.length === 0 &&
        !h.coord.getState().goal.failedIds.has('goal-1') &&
        h.server.get('goal-1')?.target === 9999999,
      JSON.stringify({ outB, outA, server: h.server.get('goal-1')?.target }),
    );
  }

  // 40 — a budget op in the same queue is unaffected by goal dispatch
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueGoalCreate({ scope: A, entityId: 'goal-1', payload: gd() });
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: { category: 'food', amount: 100 } });
    await settle();
    const st = h.coord.getState();
    check(
      '40 goal + budget in one queue -> both tracked independently, keyed separately',
      st.goal.pendingIds.has('goal-1') && st.budget.scopeOps.some((o) => o.entityId === 'food'),
      JSON.stringify({ goal: [...st.goal.pendingIds], budget: st.budget.scopeOps.map((o) => o.entityId) }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
