/**
 * Static verification for the Offline Write Queue coordinator's BUDGET
 * wiring — STEP 16-H2-C2-BUDGET A1. A small, self-contained harness
 * (separate from coordinator.cases.ts, which stays transaction/card/
 * category-focused) exercising `saveBudget`/`softDeleteBudget` dispatch,
 * frozen `expectedUpdatedAt` forwarding, the CREATE/UPDATE/DELETE ack
 * reconcile against `getServerBudgets()`, `exists -> conflict` /
 * `invalid -> reason-less` normalization, and persistence safety. No React,
 * no Supabase. ENGINE ONLY — no UI call site is exercised.
 */
import { QUEUE_SCHEMA_VERSION, type PendingBudgetCreate } from '@/lib/offlineQueue';
import type { NewBudgetDraft } from '@/lib/remoteBudgetWriteMapping';
import type { SaveBudgetResult, SoftDeleteBudgetResult } from '@/services/remoteBudgetWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A: CoordinatorScope = { userId: 'u-A', householdId: 'h-A' };
const B: CoordinatorScope = { userId: 'u-B', householdId: 'h-B' };

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const bd = (over: Partial<NewBudgetDraft> = {}): NewBudgetDraft => ({
  category: 'food',
  amount: 100000,
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

type SaveArgs = {
  householdId: string;
  expectedUserId: string;
  category: string;
  amount: number;
  expectedUpdatedAt: string | null;
};
type DeleteArgs = {
  householdId: string;
  expectedUserId: string;
  category: string;
  expectedUpdatedAt: string;
};

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  /** trusted server snapshot's ACTIVE budgets, keyed by category_id. */
  server: Map<string, number>;
  storage: ReturnType<typeof memStorage>;
  saveLog: SaveArgs[];
  deleteLog: DeleteArgs[];
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setSave: (f: (args: SaveArgs) => Promise<SaveBudgetResult>) => void;
  setDelete: (f: (args: DeleteArgs) => Promise<SoftDeleteBudgetResult>) => void;
  serverPut: (id: string, amount: number) => void;
  serverDelete: (id: string) => void;
  runTimers: () => void;
  refreshes: () => number;
}

function makeHarness(opts?: { seed?: string; remoteReady?: boolean; scope?: CoordinatorScope | null }): Harness {
  const server = new Map<string, number>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = opts?.scope === undefined ? A : opts.scope;
  let remoteReady = opts?.remoteReady ?? true;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const saveLog: SaveArgs[] = [];
  const deleteLog: DeleteArgs[] = [];

  // default saveBudget: "server accepted + snapshot reflects the amount"
  let saveImpl = async (args: SaveArgs): Promise<SaveBudgetResult> => {
    saveLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.set(args.category, args.amount);
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };
  // default softDeleteBudget: "server applied it + row gone from snapshot"
  let deleteImpl = async (args: DeleteArgs): Promise<SoftDeleteBudgetResult> => {
    deleteLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.delete(args.category);
    return { ok: true };
  };

  const h = {} as Harness;

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => remoteReady,
    getKnownCardIds: () => new Set(),
    getServerTransactions: () => new Map(),
    getServerCards: () => new Map(),
    getServerCategories: () => new Map(),
    getServerBudgets: () => server,
    getServerPlanned: () => new Map(),
    getServerRecurring: () => new Map(),
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    saveBudget: (args) => saveImpl(args as SaveArgs),
    softDeleteBudget: (args) => deleteImpl(args as DeleteArgs),
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

  h.coord = coord;
  h.server = server;
  h.storage = storage;
  h.saveLog = saveLog;
  h.deleteLog = deleteLog;
  h.timers = timers;
  h.setScope = (s) => {
    scope = s;
    coord.setScope(s);
  };
  h.setSave = (f) => {
    saveImpl = f;
  };
  h.setDelete = (f) => {
    deleteImpl = f;
  };
  h.serverPut = (id, amount) => {
    server.set(id, amount);
  };
  h.serverDelete = (id) => {
    server.delete(id);
  };
  h.runTimers = () => {
    const due = timers.filter((t) => !t.cancelled);
    timers.length = 0;
    due.forEach((t) => t.fn());
  };
  h.refreshes = () => refreshCount;
  return h;
}

const TRANSPORT: SaveBudgetResult = { ok: false, reason: 'error', message: 'net', transport: true };
const EXISTS: SaveBudgetResult = { ok: false, reason: 'exists', message: '이미 이 카테고리 예산이 있어요' };
const INVALID: SaveBudgetResult = { ok: false, reason: 'invalid', message: '예산 금액을 확인해 주세요' };
const D_TRANSPORT: SoftDeleteBudgetResult = { ok: false, reason: 'error', message: 'net', transport: true };

const seedWith = (recs: PendingBudgetCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingBudgetCreate> = {}): PendingBudgetCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'budget',
  op: 'create',
  entityId: 'food',
  payload: bd(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorBudgetCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ CREATE ============================ */

  // 2 — CREATE transport failure -> enqueued (offline path), not on server
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(TRANSPORT));
    const enq = await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd() });
    await settle();
    const st = h.coord.getState().budget;
    check(
      '2 CREATE transport -> enqueued, pending, not on server',
      enq.ok === true && st.pendingIds.has('food') && !h.server.has('food'),
      `enq=${JSON.stringify(enq)} pendingIds=${[...st.pendingIds]}`,
    );
  }

  // 4 — CREATE, server absent -> flushes and lands (entityId === category === saveBudget arg)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    const enq = await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 30000 }) });
    await settle(8);
    check(
      '4 CREATE with no server row -> flushes, saveBudget called with expectedUpdatedAt:null, category==entityId',
      enq.ok === true &&
        h.saveLog.length === 1 &&
        h.saveLog[0].category === 'food' &&
        h.saveLog[0].expectedUpdatedAt === null &&
        h.server.get('food') === 30000 &&
        h.coord.getState().budget.pendingIds.size === 0,
      JSON.stringify({ log: h.saveLog, server: [...h.server] }),
    );
  }

  // 5 — hydrate from a seeded CREATE; once it flushes and the server amount
  // matches the queued draft, the ack reconcile durably removes it (the
  // idempotent "response was lost, replay confirms the same amount" path).
  {
    const h = makeHarness({ seed: seedWith([rec({ queueId: 'q-5', entityId: 'food', payload: bd({ amount: 77000 }) })]) });
    await h.coord.hydrate();
    await settle(8);
    check(
      '5 CREATE seeded from storage -> flushes, server amount matches draft -> ack removes it durably',
      h.coord.getState().budget.scopeOps.length === 0 && h.server.get('food') === 77000,
      `ops=${JSON.stringify(h.coord.getState().budget.scopeOps)} server=${h.server.get('food')}`,
    );
  }

  // 6 — CREATE reconcile: server holds the SAME category with a DIFFERENT
  // amount (someone else's row) -> `exists` normalizes to `conflict`,
  // RETAINED terminal-failed, server amount is NEVER overwritten.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 200000); // another household member's budget
    let calls = 0;
    h.setSave(() => {
      calls += 1;
      return Promise.resolve(EXISTS);
    });
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 100000 }) });
    await settle();
    const st = h.coord.getState().budget;
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    check(
      "6 CREATE exists -> normalized to 'conflict', retained failed, server amount untouched, no auto-retry",
      st.failedIds.has('food') &&
        st.failedReasons.get('food') === 'conflict' &&
        h.server.get('food') === 200000 &&
        calls === 1,
      `failed=${[...st.failedIds]} reason=${st.failedReasons.get('food')} server=${h.server.get('food')} calls=${calls}`,
    );
  }

  // 6b — CREATE `invalid` -> reason-less generic terminal (never retried automatically)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(INVALID));
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd() });
    await settle();
    const st = h.coord.getState().budget;
    check(
      "6b CREATE invalid -> terminal-failed with NO reason (not 'invalid', not surfaced as a stored WriteConflictReason)",
      st.failedIds.has('food') && st.failedReasons.get('food') === undefined,
      `failed=${[...st.failedIds]} reason=${st.failedReasons.get('food')}`,
    );
  }

  /* ============================ UPDATE ============================ */

  // 7 — frozen expectedUpdatedAt reaches saveBudget verbatim, never refreshed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 999); // server moved on already
    h.setSave((args) => {
      h.saveLog.push(args);
      return Promise.resolve(TRANSPORT); // stay offline for 2 attempts
    });
    await h.coord.enqueueBudgetUpdate({
      scope: A, entityId: 'food', payload: bd({ amount: 1 }), expectedUpdatedAt: 'FROZEN-V1',
    });
    await settle();
    h.runTimers(); // backoff retry
    await settle(6);
    check(
      '7 UPDATE: every replay uses the SAME frozen expectedUpdatedAt (no refresh)',
      h.saveLog.length >= 2 && h.saveLog.every((s) => s.expectedUpdatedAt === 'FROZEN-V1'),
      JSON.stringify(h.saveLog.map((s) => s.expectedUpdatedAt)),
    );
  }

  // 8 — successful UPDATE + refresh + amount match -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 100000);
    const enq = await h.coord.enqueueBudgetUpdate({
      scope: A, entityId: 'food', payload: bd({ amount: 250000 }), expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '8 UPDATE online -> applied, amount-matched, queue empty, refresh requested',
      enq.ok === true &&
        h.saveLog.length === 1 &&
        h.server.get('food') === 250000 &&
        h.refreshes() >= 1 &&
        h.coord.getState().budget.scopeOps.length === 0,
      `server=${h.server.get('food')} refreshes=${h.refreshes()}`,
    );
  }

  // 9 — concurrent server UPDATE (another device already changed it): our
  // stale-token write is BLOCKED — the service itself returns a conflict
  // (normalized identically to `conflict`), server amount is untouched.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 9999); // device B already won with this amount
    let calls = 0;
    h.setSave(() => {
      calls += 1;
      // Simulates the REAL saveBudget's guarded UPDATE 0-row reconcile: our
      // frozen token no longer matches -> conflict, never a blind overwrite.
      return Promise.resolve({ ok: false, reason: 'conflict', message: '다른 곳에서 변경됐어요' } as SaveBudgetResult);
    });
    await h.coord.enqueueBudgetUpdate({
      scope: A, entityId: 'food', payload: bd({ amount: 1 }), expectedUpdatedAt: 'STALE-V1',
    });
    await settle(8);
    const st = h.coord.getState().budget;
    check(
      '9 UPDATE conflict (stale token) -> server untouched, one attempt only, retained failed (no blind LWW)',
      h.server.get('food') === 9999 &&
        calls === 1 &&
        st.failedIds.has('food') &&
        st.failedReasons.get('food') === 'conflict' &&
        (h.storage.dump() ?? '').includes('food'),
      `server=${h.server.get('food')} calls=${calls} failed=${[...st.failedIds]}`,
    );
  }

  /* ============================ DELETE ============================ */

  // 13 — frozen expectedUpdatedAt reaches softDeleteBudget verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 100000);
    h.setDelete((args) => {
      h.deleteLog.push(args);
      return Promise.resolve(D_TRANSPORT);
    });
    await h.coord.enqueueBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'FROZEN-DEL-V1' });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      '13 DELETE: every replay uses the SAME frozen expectedUpdatedAt',
      h.deleteLog.length >= 2 && h.deleteLog.every((d) => d.expectedUpdatedAt === 'FROZEN-DEL-V1'),
      JSON.stringify(h.deleteLog.map((d) => d.expectedUpdatedAt)),
    );
  }

  // 14 — successful DELETE + server absent -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 100000);
    const enq = await h.coord.enqueueBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      '14 DELETE online -> server row gone, queue empty, refresh requested',
      enq.ok === true &&
        !h.server.has('food') &&
        h.refreshes() >= 1 &&
        h.coord.getState().budget.scopeOps.length === 0,
      `server has food=${h.server.has('food')} pending=${h.coord.getState().budget.scopeOps.length}`,
    );
  }

  // 15 — failed DELETE -> retained + failed; authoritative server row is
  // NEVER removed (still there for the read-model to show as "삭제 전송 실패").
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 100000);
    h.setDelete(() => Promise.resolve({ ok: false, reason: 'conflict', message: '이미 변경됨' }));
    await h.coord.enqueueBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'V1' });
    await settle();
    const st = h.coord.getState().budget;
    check(
      '15 failed DELETE -> retained + failedIds, authoritative server row still present (restored/visible)',
      st.failedIds.has('food') && h.server.get('food') === 100000 && st.scopeOps.length === 1,
      `failed=${[...st.failedIds]} server=${h.server.get('food')}`,
    );
  }

  /* ====================== DISCARD ("변경 버리기") ====================== */
  // §22 items 12/17: discardPending removes ONLY the local failed record —
  // never a new budget-specific removal API (the existing generic
  // coordinator.discardPending(queueId) already handles any entity).

  // 16 — discard a terminal-failed budget CREATE: queue cleared, failed state
  // gone; a fresh write for the SAME category is possible again right after.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(EXISTS));
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd() });
    await settle();
    const before = h.coord.getState().budget;
    const rec = before.scopeOps.find((o) => o.entityId === 'food');
    const out = await h.coord.discardPending(rec!.queueId);
    const after = h.coord.getState().budget;
    check(
      '16 discard a failed budget CREATE -> record removed, failed state cleared',
      out.ok === true && after.scopeOps.length === 0 && !after.failedIds.has('food'),
      JSON.stringify({ out, after: { ops: after.scopeOps.length, failed: [...after.failedIds] } }),
    );
  }

  // 17 — discard a terminal-failed budget UPDATE: server row (if any) is
  // UNTOUCHED — discard only drops the local record, never a server write.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('food', 999999); // authoritative — must stay exactly this
    h.setSave(() => Promise.resolve({ ok: false, reason: 'conflict', message: '충돌' } as SaveBudgetResult));
    await h.coord.enqueueBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 1 }), expectedUpdatedAt: 'V1' });
    await settle();
    const rec = h.coord.getState().budget.scopeOps.find((o) => o.entityId === 'food');
    const out = await h.coord.discardPending(rec!.queueId);
    check(
      '17 discard a failed budget UPDATE -> local record gone, server amount untouched',
      out.ok === true &&
        h.coord.getState().budget.scopeOps.length === 0 &&
        h.server.get('food') === 999999,
      JSON.stringify({ out, server: h.server.get('food') }),
    );
  }

  // 25 — discard scope isolation: a queueId from household A cannot be
  // discarded while household B is the active scope.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd() });
    await settle();
    const rec = h.coord.getState().budget.scopeOps.find((o) => o.entityId === 'food');
    h.setScope(B);
    const out = await h.coord.discardPending(rec!.queueId);
    h.setScope(A);
    const stillThere = h.coord.getState().budget.scopeOps.some((o) => o.queueId === rec!.queueId);
    check(
      "25 discard refuses a queueId that isn't in the CURRENT scope",
      out.ok === false && out.reason === 'scope' && stillThere,
      JSON.stringify({ out, stillThere }),
    );
  }

  /* ======================== QUEUE SAFETY =========================== */

  // 21 — scope isolation: household B never sees household A's budget op
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd() });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState().budget;
    h.setScope(A);
    const underA = h.coord.getState().budget;
    check(
      '21 scope isolation: budget op hidden under B, visible again under A',
      underB.scopeOps.length === 0 && underA.pendingIds.has('food'),
      `B=${underB.scopeOps.length} A=${[...underA.pendingIds]}`,
    );
  }

  // 22 — enqueue persist failure -> {ok:false, persist}, never visible
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(TRANSPORT));
    h.storage.failSet(1); // next setItem (the enqueue) fails
    const enq = await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd() });
    await settle();
    check(
      '22 enqueue persist failure -> {ok:false, persist}, item NOT visible',
      enq.ok === false && enq.reason === 'persist' && h.coord.getState().budget.scopeOps.length === 0,
      JSON.stringify(enq),
    );
  }

  // 22b — restart: dispose then a fresh coordinator on the same storage
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setSave(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 55555 }) });
    await settle();
    h.coord.dispose();
    const storedJson = h.storage.dump();

    const h2 = makeHarness({ seed: storedJson ?? undefined });
    h2.setSave(() => Promise.resolve(TRANSPORT)); // still offline
    await h2.coord.hydrate();
    await settle();
    check(
      '22b restart -> pending budget row restored from storage, no duplicate',
      h2.coord.getState().budget.pendingIds.has('food') && h2.coord.getState().budget.scopeOps.length === 1,
      JSON.stringify([...h2.coord.getState().budget.pendingIds]),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
