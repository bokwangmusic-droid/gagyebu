/**
 * Static verification for the Offline Write Queue coordinator's
 * RECURRING-RULE wiring — STEP 16-H2-F1. A small, self-contained harness
 * (separate from coordinator.cases.ts) exercising
 * `createRecurring`/`updateRecurring`/`setRecurringActive`/
 * `softDeleteRecurring` dispatch, FROZEN `expectedUpdatedAt` forwarding
 * (verbatim for BOTH the full-update and the active-toggle path), the
 * CREATE/FULL-UPDATE/ACTIVE-toggle/DELETE ack reconcile against
 * `getServerRecurring()`, the "authoritative server value is never
 * overwritten by a stale local draft/toggle" rule, transport-vs-terminal
 * normalization, discard, and scope safety. No React, no Supabase. ENGINE
 * ONLY — no UI call site is exercised.
 */
import { QUEUE_SCHEMA_VERSION, type PendingRecurringCreate } from '@/lib/offlineQueue';
import type { NewRecurringDraft } from '@/lib/remoteRecurringWriteMapping';
import type {
  CreateRecurringResult,
  SoftDeleteRecurringResult,
  UpdateRecurringResult,
} from '@/services/remoteRecurringWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { RecurringRule } from '@/store/types';

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

const rd = (over: Partial<NewRecurringDraft> = {}): NewRecurringDraft => ({
  type: 'expense',
  name: '넷플릭스',
  amount: 17000,
  category: 'subscription',
  frequency: 'monthly',
  dayOfMonth: 15,
  dayOfWeek: null,
  ...over,
});

const srvRow = (id: string, over: Partial<RecurringRule> = {}): RecurringRule => ({
  id,
  type: 'expense',
  name: '넷플릭스',
  amount: 17000,
  category: 'subscription',
  frequency: 'monthly',
  dayOfMonth: 15,
  active: true,
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

type CreateArgs = { id: string; householdId: string; expectedUserId: string; draft: NewRecurringDraft };
type UpdateArgs = CreateArgs & { expectedUpdatedAt: string };
type ActiveArgs = {
  householdId: string;
  recurringId: string;
  expectedUserId: string;
  active: boolean;
  expectedUpdatedAt: string;
};
type DeleteArgs = { id: string; householdId: string; expectedUserId: string; expectedUpdatedAt: string };

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  server: Map<string, RecurringRule>;
  storage: ReturnType<typeof memStorage>;
  createLog: CreateArgs[];
  updateLog: UpdateArgs[];
  activeLog: ActiveArgs[];
  deleteLog: DeleteArgs[];
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setCreate: (f: (a: CreateArgs) => Promise<CreateRecurringResult>) => void;
  setUpdate: (f: (a: UpdateArgs) => Promise<UpdateRecurringResult>) => void;
  setActive: (f: (a: ActiveArgs) => Promise<UpdateRecurringResult>) => void;
  setDelete: (f: (a: DeleteArgs) => Promise<SoftDeleteRecurringResult>) => void;
  serverPut: (row: RecurringRule) => void;
  runTimers: () => void;
  refreshes: () => number;
}

function makeHarness(opts?: { seed?: string }): Harness {
  const server = new Map<string, RecurringRule>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = A;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const createLog: CreateArgs[] = [];
  const updateLog: UpdateArgs[] = [];
  const activeLog: ActiveArgs[] = [];
  const deleteLog: DeleteArgs[] = [];

  let createImpl = async (a: CreateArgs): Promise<CreateRecurringResult> => {
    createLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.set(a.id, {
      id: a.id,
      type: a.draft.type,
      name: a.draft.name.trim(),
      amount: a.draft.amount,
      category: a.draft.category,
      frequency: a.draft.frequency,
      dayOfMonth: a.draft.dayOfMonth ?? undefined,
      dayOfWeek: a.draft.dayOfWeek ?? undefined,
      active: true,
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    return { ok: true, id: a.id };
  };
  let updateImpl = async (a: UpdateArgs): Promise<UpdateRecurringResult> => {
    updateLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    const prev = server.get(a.id);
    if (prev) {
      server.set(a.id, {
        ...prev,
        name: a.draft.name.trim(),
        amount: a.draft.amount,
        category: a.draft.category,
        frequency: a.draft.frequency,
        dayOfMonth: a.draft.dayOfMonth ?? undefined,
        dayOfWeek: a.draft.dayOfWeek ?? undefined,
      });
    }
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };
  let activeImpl = async (a: ActiveArgs): Promise<UpdateRecurringResult> => {
    activeLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    const prev = server.get(a.recurringId);
    if (prev) server.set(a.recurringId, { ...prev, active: a.active });
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };
  let deleteImpl = async (a: DeleteArgs): Promise<SoftDeleteRecurringResult> => {
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
    getServerRecurring: () => server,
    getServerGoals: () => new Map(),
    getServerLoans: () => new Map(),
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    createRecurring: (a) => createImpl(a as CreateArgs),
    updateRecurring: (a) => updateImpl(a as UpdateArgs),
    setRecurringActive: (a) => activeImpl(a as ActiveArgs),
    softDeleteRecurring: (a) => deleteImpl(a as DeleteArgs),
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
    activeLog,
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
    setActive: (f) => {
      activeImpl = f;
    },
    setDelete: (f) => {
      deleteImpl = f;
    },
    serverPut: (row) => {
      server.set(row.id, row);
    },
    runTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    refreshes: () => refreshCount,
  };
}

const TRANSPORT_C: CreateRecurringResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_U: UpdateRecurringResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_D: SoftDeleteRecurringResult = { ok: false, reason: 'error', message: 'net', transport: true };
const CONFLICT_C: CreateRecurringResult = { ok: false, reason: 'conflict', message: '충돌' };
const INVALID_C: CreateRecurringResult = { ok: false, reason: 'invalid', message: '확인해 주세요' };
const CONFLICT_U: UpdateRecurringResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };
const GONE_U: UpdateRecurringResult = { ok: false, reason: 'gone', message: '삭제된 항목' };
const CONFLICT_D: SoftDeleteRecurringResult = { ok: false, reason: 'conflict', message: '이미 변경됨' };

const seedWith = (recs: PendingRecurringCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingRecurringCreate> = {}): PendingRecurringCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'recurring',
  op: 'create',
  entityId: 'rec-1',
  payload: rd(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorRecurringCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ RUNOP ============================ */

  // 13 — CREATE dispatch: createRecurring called with id === entityId, no token
  {
    const h = makeHarness();
    await h.coord.hydrate();
    const enq = await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 30000 }) });
    await settle(8);
    check(
      '13 CREATE dispatch -> createRecurring(id=entityId, draft), lands on server, queue empties',
      enq.ok === true &&
        h.createLog.length === 1 &&
        h.createLog[0].id === 'rec-1' &&
        h.server.get('rec-1')?.amount === 30000 &&
        h.coord.getState().recurring.scopeOps.length === 0,
      JSON.stringify({ log: h.createLog, server: [...h.server] }),
    );
  }

  // 14 — FULL UPDATE: frozen expectedUpdatedAt forwarded verbatim on EVERY replay
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { amount: 999 }));
    h.setUpdate((a) => {
      h.updateLog.push(a);
      return Promise.resolve(TRANSPORT_U);
    });
    await h.coord.enqueueRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 1 }),
      expectedUpdatedAt: 'FROZEN-V1',
    });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      '14 FULL UPDATE: every replay uses the SAME frozen expectedUpdatedAt (never refreshed)',
      h.updateLog.length >= 2 && h.updateLog.every((u) => u.expectedUpdatedAt === 'FROZEN-V1'),
      JSON.stringify(h.updateLog.map((u) => u.expectedUpdatedAt)),
    );
  }

  // 15 — ACTIVE UPDATE: frozen expectedUpdatedAt AND the desired bool forwarded verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { active: true }));
    h.setActive((a) => {
      h.activeLog.push(a);
      return Promise.resolve(TRANSPORT_U);
    });
    await h.coord.enqueueRecurringActiveUpdate({
      scope: A,
      entityId: 'rec-1',
      active: false,
      expectedUpdatedAt: 'FROZEN-ACT-V1',
    });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      '15 ACTIVE UPDATE: every replay uses the SAME frozen token AND desired active verbatim',
      h.activeLog.length >= 2 &&
        h.activeLog.every((a) => a.expectedUpdatedAt === 'FROZEN-ACT-V1' && a.active === false && a.recurringId === 'rec-1'),
      JSON.stringify(h.activeLog),
    );
  }

  // 16 — DELETE: frozen expectedUpdatedAt forwarded verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1'));
    h.setDelete((a) => {
      h.deleteLog.push(a);
      return Promise.resolve(TRANSPORT_D);
    });
    await h.coord.enqueueRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'FROZEN-DEL' });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      '16 DELETE: every replay uses the SAME frozen expectedUpdatedAt',
      h.deleteLog.length >= 2 && h.deleteLog.every((d) => d.expectedUpdatedAt === 'FROZEN-DEL'),
      JSON.stringify(h.deleteLog.map((d) => d.expectedUpdatedAt)),
    );
  }

  // 17 — transport:true is normalized to a retryable transport halt (enqueued, not failed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    const enq = await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd() });
    await settle();
    const st = h.coord.getState().recurring;
    check(
      '17 transport:true -> retained pending (not failed), a backoff timer is scheduled',
      enq.ok === true && st.pendingIds.has('rec-1') && !st.failedIds.has('rec-1') && h.timers.some((t) => !t.cancelled),
      JSON.stringify({ enq, pending: [...st.pendingIds], failed: [...st.failedIds] }),
    );
  }

  // 18 — a non-transport conflict is TERMINAL: retained failed, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_C);
    });
    await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd() });
    await settle();
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    const st = h.coord.getState().recurring;
    check(
      '18 CREATE conflict -> terminal-failed, reason retained, exactly one attempt',
      st.failedIds.has('rec-1') && st.failedReasons.get('rec-1') === 'conflict' && calls === 1,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('rec-1'), calls }),
    );
  }

  // 19 — gone/deleted FULL UPDATE is TERMINAL (reason preserved) + CREATE invalid -> reason-less
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1'));
    h.setUpdate(() => Promise.resolve(GONE_U));
    await h.coord.enqueueRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 5 }),
      expectedUpdatedAt: 'V0',
    });
    await settle();
    const st = h.coord.getState().recurring;

    const h2 = makeHarness();
    await h2.coord.hydrate();
    h2.setCreate(() => Promise.resolve(INVALID_C));
    await h2.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-2', payload: rd() });
    await settle();
    const st2 = h2.coord.getState().recurring;

    check(
      '19 FULL UPDATE gone -> terminal "gone"; CREATE invalid -> terminal with NO stored reason',
      st.failedIds.has('rec-1') &&
        st.failedReasons.get('rec-1') === 'gone' &&
        st2.failedIds.has('rec-2') &&
        st2.failedReasons.get('rec-2') === undefined,
      JSON.stringify({ r1: st.failedReasons.get('rec-1'), r2: st2.failedReasons.get('rec-2') }),
    );
  }

  /* ========================= CREATE ACK ========================= */

  // 20 — server absent after replay -> NOT acked, op RETAINED
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setCreate((a) => {
      calls += 1;
      h.createLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true, id: a.id } : TRANSPORT_C);
    });
    await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd() });
    await settle(8);
    check(
      '20 CREATE: server row never appears in snapshot -> not acked, op still queued',
      h.coord.getState().recurring.scopeOps.length === 1 &&
        calls >= 1 &&
        !h.server.has('rec-1') &&
        !h.coord.getState().recurring.failedIds.has('rec-1'),
      JSON.stringify({ ops: h.coord.getState().recurring.scopeOps.length, calls }),
    );
  }

  // 21 — same id + same server payload -> ack (idempotent lost-response)
  {
    const h = makeHarness({ seed: seedWith([rec({ queueId: 'q-21', entityId: 'rec-1', payload: rd({ amount: 77000 }) })]) });
    h.serverPut(srvRow('rec-1', { amount: 77000 }));
    await h.coord.hydrate();
    await settle(8);
    check(
      '21 CREATE lost-response: server row matches draft -> ack removes it durably',
      h.coord.getState().recurring.scopeOps.length === 0 && h.server.get('rec-1')?.amount === 77000,
      JSON.stringify(h.coord.getState().recurring.scopeOps),
    );
  }

  // 22 — same id + DIFFERENT server payload -> NOT acked; terminal conflict retained
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { amount: 200000 }));
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_C);
    });
    await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 100000 }) });
    await settle();
    h.coord.requestFlush();
    await settle();
    const st = h.coord.getState().recurring;
    check(
      '22 CREATE same id / different payload -> terminal conflict retained, server row untouched',
      st.failedIds.has('rec-1') &&
        st.failedReasons.get('rec-1') === 'conflict' &&
        h.server.get('rec-1')?.amount === 200000 &&
        calls === 1,
      JSON.stringify({ failed: [...st.failedIds], server: h.server.get('rec-1')?.amount, calls }),
    );
  }

  /* ========================= FULL UPDATE ACK ========================= */

  // 23 — matching server draft after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { amount: 17000 }));
    const enq = await h.coord.enqueueRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 25000 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '23 FULL UPDATE online -> applied, content-matched, queue empty, refresh requested',
      enq.ok === true &&
        h.updateLog.length === 1 &&
        h.server.get('rec-1')?.amount === 25000 &&
        h.refreshes() >= 1 &&
        h.coord.getState().recurring.scopeOps.length === 0,
      JSON.stringify({ server: h.server.get('rec-1')?.amount, refreshes: h.refreshes() }),
    );
  }

  // 24 — server shows a DIFFERENT draft than attempted -> NOT acked, op retained
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { amount: 17000 }));
    let calls = 0;
    h.setUpdate((a) => {
      calls += 1;
      h.updateLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true, updatedAt: 'V2' } : TRANSPORT_U);
    });
    await h.coord.enqueueRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 25000 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(10);
    check(
      '24 FULL UPDATE: snapshot content != attempted draft -> not acked, op still queued',
      h.coord.getState().recurring.scopeOps.length === 1 && calls >= 1,
      JSON.stringify({ ops: h.coord.getState().recurring.scopeOps.length, calls }),
    );
  }

  // 25 — stale concurrent server edit is NEVER overwritten (service conflict, one attempt)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { amount: 30000 })); // device B already won
    let calls = 0;
    h.setUpdate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_U);
    });
    await h.coord.enqueueRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 20000 }), // A's stale draft
      expectedUpdatedAt: 'STALE-V0',
    });
    await settle(8);
    const st = h.coord.getState().recurring;
    check(
      '25 FULL UPDATE stale token -> server stays 30000, one attempt, retained failed (no blind LWW)',
      h.server.get('rec-1')?.amount === 30000 &&
        calls === 1 &&
        st.failedIds.has('rec-1') &&
        st.failedReasons.get('rec-1') === 'conflict' &&
        (h.storage.dump() ?? '').includes('rec-1'),
      JSON.stringify({ server: h.server.get('rec-1')?.amount, calls, failed: [...st.failedIds] }),
    );
  }

  /* ========================= ACTIVE ACK ========================= */

  // 26 — desired false + server false -> ack
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { active: true }));
    const enq = await h.coord.enqueueRecurringActiveUpdate({
      scope: A,
      entityId: 'rec-1',
      active: false,
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '26 ACTIVE toggle desired false + server false -> ack, queue empty',
      enq.ok === true &&
        h.server.get('rec-1')?.active === false &&
        h.coord.getState().recurring.scopeOps.length === 0,
      JSON.stringify({ active: h.server.get('rec-1')?.active, ops: h.coord.getState().recurring.scopeOps.length }),
    );
  }

  // 27 — desired false + server (still) true -> NOT acked, retained
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { active: true }));
    let calls = 0;
    h.setActive((a) => {
      calls += 1;
      h.activeLog.push(a);
      // "accepted" but the snapshot never flips (stale read / raced back)
      return Promise.resolve(calls === 1 ? { ok: true, updatedAt: 'V2' } : TRANSPORT_U);
    });
    await h.coord.enqueueRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: 'V1' });
    await settle(10);
    check(
      '27 ACTIVE toggle desired false + server stays true -> not acked, op still queued',
      h.coord.getState().recurring.scopeOps.length === 1 && calls >= 1,
      JSON.stringify({ ops: h.coord.getState().recurring.scopeOps.length, calls }),
    );
  }

  // 28 — desired true + server true -> ack
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { active: false }));
    const enq = await h.coord.enqueueRecurringActiveUpdate({
      scope: A,
      entityId: 'rec-1',
      active: true,
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '28 ACTIVE toggle desired true + server true -> ack, queue empty',
      enq.ok === true &&
        h.server.get('rec-1')?.active === true &&
        h.coord.getState().recurring.scopeOps.length === 0,
      JSON.stringify({ active: h.server.get('rec-1')?.active, ops: h.coord.getState().recurring.scopeOps.length }),
    );
  }

  // 29 — desired true + server false -> NOT acked; also: a stale toggle
  // NEVER wins over a concurrent server change (conflict, one attempt).
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { active: false })); // device B paused it
    let calls = 0;
    h.setActive(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_U); // frozen token no longer matches
    });
    await h.coord.enqueueRecurringActiveUpdate({
      scope: A,
      entityId: 'rec-1',
      active: true, // A's stale desired state
      expectedUpdatedAt: 'STALE-V0',
    });
    await settle(8);
    const st = h.coord.getState().recurring;
    check(
      '29 ACTIVE toggle desired true + server stays false -> terminal conflict, server never flipped',
      h.server.get('rec-1')?.active === false &&
        calls === 1 &&
        st.failedIds.has('rec-1') &&
        st.failedReasons.get('rec-1') === 'conflict',
      JSON.stringify({ active: h.server.get('rec-1')?.active, calls, failed: [...st.failedIds] }),
    );
  }

  /* ========================= DELETE ACK ========================= */

  // 30 — active server row still present after replay -> NOT acked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1'));
    let calls = 0;
    h.setDelete((a) => {
      calls += 1;
      h.deleteLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true } : TRANSPORT_D);
    });
    await h.coord.enqueueRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'V1' });
    await settle(10);
    check(
      '30 DELETE: active server row still present -> not acked, op still queued',
      h.coord.getState().recurring.scopeOps.length === 1 && calls >= 1 && h.server.has('rec-1'),
      JSON.stringify({ ops: h.coord.getState().recurring.scopeOps.length, calls }),
    );
  }

  // 31 — server row absent after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1'));
    const enq = await h.coord.enqueueRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      '31 DELETE online -> server row gone, queue empty, refresh requested',
      enq.ok === true &&
        !h.server.has('rec-1') &&
        h.refreshes() >= 1 &&
        h.coord.getState().recurring.scopeOps.length === 0,
      JSON.stringify({ hasRow: h.server.has('rec-1'), ops: h.coord.getState().recurring.scopeOps.length }),
    );
  }

  // 42b — failed DELETE -> retained + failed; authoritative row NEVER removed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-1', { amount: 17000 }));
    h.setDelete(() => Promise.resolve(CONFLICT_D));
    await h.coord.enqueueRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'V1' });
    await settle();
    const st = h.coord.getState().recurring;
    check(
      '42b failed DELETE -> retained + failedIds, authoritative server row still present',
      st.failedIds.has('rec-1') && h.server.get('rec-1')?.amount === 17000 && st.scopeOps.length === 1,
      JSON.stringify({ failed: [...st.failedIds], server: h.server.get('rec-1')?.amount }),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 50 — enqueue persist failure -> {ok:false, persist}, item NOT visible
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    h.storage.failSet(1);
    const enq = await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd() });
    await settle();
    check(
      '50 enqueue persist failure -> {ok:false, persist}, not visible',
      enq.ok === false && enq.reason === 'persist' && h.coord.getState().recurring.scopeOps.length === 0,
      JSON.stringify(enq),
    );
  }

  // 51 — restart/hydrate: a seeded recurring CREATE is restored, no duplicate
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 55555 }) });
    await settle();
    h.coord.dispose();
    const stored = h.storage.dump();

    const h2 = makeHarness({ seed: stored ?? undefined });
    h2.setCreate(() => Promise.resolve(TRANSPORT_C)); // still offline
    await h2.coord.hydrate();
    await settle();
    check(
      '51 restart -> pending recurring row restored from storage, exactly one',
      h2.coord.getState().recurring.pendingIds.has('rec-1') &&
        h2.coord.getState().recurring.scopeOps.length === 1,
      JSON.stringify([...h2.coord.getState().recurring.pendingIds]),
    );
  }

  // 52 — discardPending: exact queueId removal, scope isolation, other entity untouched
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() => Promise.resolve(CONFLICT_U));
    h.serverPut(srvRow('rec-1', { amount: 999999 }));
    await h.coord.enqueueRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 1 }),
      expectedUpdatedAt: 'V1',
    });
    await settle();
    const recQ = h.coord.getState().recurring.scopeOps.find((o) => o.entityId === 'rec-1');
    h.setScope(B);
    const outB = await h.coord.discardPending(recQ!.queueId);
    h.setScope(A);
    const outA = await h.coord.discardPending(recQ!.queueId);
    check(
      '52 discard: refused under wrong scope, exact queueId removed under right scope, server untouched',
      outB.ok === false &&
        outB.reason === 'scope' &&
        outA.ok === true &&
        h.coord.getState().recurring.scopeOps.length === 0 &&
        !h.coord.getState().recurring.failedIds.has('rec-1') &&
        h.server.get('rec-1')?.amount === 999999,
      JSON.stringify({ outB, outA, server: h.server.get('rec-1')?.amount }),
    );
  }

  // 53 — a budget op in the same queue is unaffected by recurring dispatch
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd() });
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: { category: 'food', amount: 100 } });
    await settle();
    const st = h.coord.getState();
    check(
      '53 recurring + budget in one queue -> both tracked independently, keyed separately',
      st.recurring.pendingIds.has('rec-1') && st.budget.scopeOps.some((o) => o.entityId === 'food'),
      JSON.stringify({ recurring: [...st.recurring.pendingIds], budget: st.budget.scopeOps.map((o) => o.entityId) }),
    );
  }

  /* ============ CROSS-ROW CONTAMINATION (device QA regression #2) ============
   * Real-device finding: deleting row A (실시간반복테스트) offline was
   * observed to also produce a pending ACTIVE-toggle op for an UNTOUCHED
   * row B (넷플릭스-테스트). This exercises the REAL coordinator end to
   * end — enqueue ONLY a delete for A via the public API, never touching
   * B's toggle — and asserts the durable queue contains EXACTLY that one
   * op, with NOTHING for B, both in memory and in what gets persisted.
   */

  // G — enqueueing A's delete creates exactly one queue op (A, delete);
  // zero ops of ANY kind exist for B, and B's per-entity state is entirely
  // absent (not just "not failed" — literally not present at all).
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('rec-A', { amount: 1000, active: true }));
    h.serverPut(srvRow('rec-B', { amount: 50000, active: true }));
    h.setDelete(() => Promise.resolve(TRANSPORT_D)); // stay "offline" so the op is retained, not acked away
    const enq = await h.coord.enqueueRecurringDelete({ scope: A, entityId: 'rec-A', expectedUpdatedAt: 'V1' });
    await settle();
    const st = h.coord.getState().recurring;
    const opsForB = st.scopeOps.filter((o) => o.entityId === 'rec-B');
    check(
      'G enqueue A-delete -> durable queue has EXACTLY one op (A, delete), literally zero ops for B',
      enq.ok === true &&
        st.scopeOps.length === 1 &&
        st.scopeOps[0].entityId === 'rec-A' &&
        st.scopeOps[0].op === 'delete' &&
        opsForB.length === 0 &&
        !st.opByEntity.has('rec-B') &&
        !st.pendingIds.has('rec-B') &&
        !st.failedIds.has('rec-B'),
      JSON.stringify({
        ops: st.scopeOps.map((o) => ({ id: o.entityId, op: o.op })),
        opByEntity: [...st.opByEntity],
      }),
    );
    // Also verify what's actually PERSISTED to storage — not just the
    // in-memory view — contains no trace of B.
    const persisted = JSON.parse(h.storage.dump() ?? '[]') as Array<{ entityId: string }>;
    check(
      'G the durably PERSISTED queue also contains no record referencing rec-B',
      persisted.every((r) => r.entityId !== 'rec-B'),
      JSON.stringify(persisted.map((r) => r.entityId)),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
