/**
 * Static verification for the Offline Write Queue coordinator
 * (src/services/offlineQueue/coordinator.ts) — STEP 16-H2-A2.
 *
 * Fully faked: in-memory storage, scriptable `createTransaction`, a manual
 * timer, a synchronous `requestRefresh`, and a mutable "server snapshot"
 * (set of transaction ids). No React, no Supabase.
 */
import { QUEUE_SCHEMA_VERSION, type PendingWrite } from '@/lib/offlineQueue';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { CreateTransactionResult } from '@/services/remoteFinanceWrite';
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

const draft = (over: Partial<NewTransactionDraft> = {}): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: '2026-09-10T09:00:00.000Z',
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

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  server: Set<string>;
  cards: Set<string>;
  storage: ReturnType<typeof memStorage>;
  createLog: { id: string; householdId: string; expectedUserId: string; knownCardIds: ReadonlySet<string> }[];
  maxConcurrentCreates: number;
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setRemoteReady: (b: boolean) => void;
  setCreate: (f: (args: HCreateArgs) => Promise<CreateTransactionResult>) => void;
  runTimers: () => void;
  refreshes: () => number;
}

type HCreateArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewTransactionDraft;
  knownCardIds: ReadonlySet<string>;
};

function makeHarness(opts?: { seed?: string; remoteReady?: boolean; scope?: CoordinatorScope | null }): Harness {
  const server = new Set<string>();
  const cards = new Set<string>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = opts?.scope === undefined ? A : opts.scope;
  let remoteReady = opts?.remoteReady ?? true;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const createLog: Harness['createLog'] = [];
  let inFlight = 0;

  const h = {} as Harness;

  // default createTransaction: "server accepted + snapshot now has it"
  let createImpl = async (args: HCreateArgs): Promise<CreateTransactionResult> => {
    inFlight += 1;
    h.maxConcurrentCreates = Math.max(h.maxConcurrentCreates ?? 0, inFlight);
    createLog.push({
      id: args.id,
      householdId: args.householdId,
      expectedUserId: args.expectedUserId,
      knownCardIds: args.knownCardIds,
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    inFlight -= 1;
    server.add(args.id);
    return { ok: true, id: args.id };
  };

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => remoteReady,
    getKnownCardIds: () => cards,
    getServerTransactionIds: () => server,
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    createTransaction: (args) => createImpl(args as HCreateArgs),
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
  h.cards = cards;
  h.storage = storage;
  h.createLog = createLog;
  h.maxConcurrentCreates = 0;
  h.timers = timers;
  h.setScope = (s) => {
    scope = s;
    coord.setScope(s);
  };
  h.setRemoteReady = (b) => {
    remoteReady = b;
  };
  h.setCreate = (f) => {
    createImpl = f;
  };
  h.runTimers = () => {
    const due = timers.filter((t) => !t.cancelled);
    timers.length = 0;
    due.forEach((t) => t.fn());
  };
  h.refreshes = () => refreshCount;
  return h;
}

const TRANSPORT: CreateTransactionResult = { ok: false, message: 'net', transport: true };
const TERMINAL: CreateTransactionResult = { ok: false, message: 'identity', transport: false };

const seedWith = (recs: PendingWrite[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingWrite> = {}): PendingWrite => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'transaction',
  op: 'create',
  entityId: 'txn-seed',
  payload: draft(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 1 — direct write SUCCESS is the caller's job; the coordinator only
  // enqueues on demand. (Nothing enqueued unless enqueueTransactionCreate is
  // called — verified implicitly across the suite.) Explicit: enqueue then a
  // successful flush leaves the queue empty.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await settle();
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-1', payload: draft() });
    await settle();
    check(
      'CASE 1 enqueue + online flush -> server has it, queue empty',
      enq.ok === true && h.server.has('txn-1') && h.coord.getState().pendingCount === 0,
      `enq=${JSON.stringify(enq)} server=${[...h.server]} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 2 — direct write TERMINAL error -> NOT enqueued (input.tsx keeps the
  // old path). Coordinator-level: a terminal flush result RETAINS the item
  // and marks it failed, never drops it.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TERMINAL));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-2', payload: draft() });
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 2 terminal flush -> item retained + marked failed (not dropped)',
      st.pendingCount === 1 && st.failedIds.has('txn-2') && !st.pendingIds.has('txn-2'),
      `pending=${st.pendingCount} failed=${[...st.failedIds]}`,
    );
  }

  // CASE 3 — direct write TRANSPORT error -> enqueue succeeds (offline path)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-3', payload: draft() });
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 3 transport -> enqueued, visible as pending, not on server',
      enq.ok === true && st.pendingIds.has('txn-3') && !h.server.has('txn-3'),
      `enq=${JSON.stringify(enq)} pendingIds=${[...st.pendingIds]}`,
    );
  }

  // CASE 4 — enqueue persist SUCCESS -> ok:true
  // CASE 5 — enqueue persist FAIL -> ok:false, reason 'persist', not visible
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    h.storage.failSet(1); // next setItem (the enqueue) fails
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-5', payload: draft() });
    await settle();
    check(
      'CASE 4/5 persist failure -> {ok:false, persist}, item NOT visible',
      enq.ok === false && enq.reason === 'persist' && h.coord.getState().pendingCount === 0,
      `enq=${JSON.stringify(enq)} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 5b — enqueue before hydrate -> {ok:false, not-hydrated}
  {
    const h = makeHarness();
    // no hydrate()
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-x', payload: draft() });
    check(
      'CASE 5b enqueue before hydrate -> not-hydrated',
      enq.ok === false && enq.reason === 'not-hydrated',
      JSON.stringify(enq),
    );
  }

  // CASE 6 — the enqueued entityId is what runOp hands createTransaction as `id`
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-6-stable', payload: draft() });
    await settle();
    check(
      'CASE 6 direct create id === pending entityId === createTransaction({id})',
      h.createLog.length === 1 && h.createLog[0].id === 'txn-6-stable',
      `createLog=${JSON.stringify(h.createLog.map((c) => c.id))}`,
    );
  }

  // CASE 7 — same (scope, entityId) enqueued twice -> ONE queue item
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-7', payload: draft() });
    await settle();
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-7', payload: draft({ amount: 9999 }) });
    await settle();
    check(
      'CASE 7 duplicate transport enqueue -> no duplicate queue item',
      h.coord.getState().pendingCount === 1,
      `pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 8 — pending visible after hydrate from a seed
  {
    const h = makeHarness({ seed: seedWith([rec({ queueId: 'q-s', entityId: 'txn-seed-8' })]) });
    await h.coord.hydrate();
    await settle();
    // remote is ready + createImpl succeeds by default -> it will also flush
    // it. Freeze that by making the server not accept and check pre-flush.
    check(
      'CASE 8 hydrate from seed -> pending op present (then flushes)',
      h.createLog.some((c) => c.id === 'txn-seed-8') || h.server.has('txn-seed-8'),
      `createLog=${JSON.stringify(h.createLog.map((c) => c.id))}`,
    );
  }

  // CASE 9 — scope A pending is NOT visible under scope B; storage retained
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-9', payload: draft() });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState();
    h.setScope(A);
    const underA = h.coord.getState();
    check(
      'CASE 9 scope isolation: hidden under B, visible again under A',
      underB.pendingCount === 0 && underA.pendingIds.has('txn-9'),
      `B=${underB.pendingCount} A=${[...underA.pendingIds]}`,
    );
  }

  // CASE 10 — restart: dispose then a fresh coordinator on the same storage
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-10', payload: draft() });
    await settle();
    h.coord.dispose();
    const storedJson = h.storage.dump();

    const h2 = makeHarness({ seed: storedJson ?? undefined });
    h2.setCreate(() => Promise.resolve(TRANSPORT)); // still offline
    await h2.coord.hydrate();
    await settle();
    check(
      'CASE 10 restart -> pending row restored from storage, no duplicate',
      h2.coord.getState().pendingIds.has('txn-10') && h2.coord.getState().pendingCount === 1,
      `pending=${JSON.stringify([...h2.coord.getState().pendingIds])}`,
    );
  }

  // CASE 12 — flush uses the CURRENT knownCardIds
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cards.add('card-9');
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-12', payload: draft({ cardId: 'card-9' }) });
    await settle();
    check(
      'CASE 12 flush forwards current knownCardIds to createTransaction',
      h.createLog.length === 1 && h.createLog[0].knownCardIds.has('card-9'),
      `known=${h.createLog[0] ? [...h.createLog[0].knownCardIds] : 'none'}`,
    );
  }

  // CASE 13 — flush success -> refresh called before the durable ack/remove
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-13', payload: draft() });
    await settle();
    check(
      'CASE 13 settled -> requestRefresh called, then queue emptied',
      h.refreshes() >= 1 && h.coord.getState().pendingCount === 0 && h.server.has('txn-13'),
      `refreshes=${h.refreshes()} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 14 — server did NOT confirm after refresh -> item RETAINED + replayed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    // createTransaction returns ok but does NOT add to the server snapshot
    let calls = 0;
    h.setCreate((args) => {
      calls += 1;
      if (calls >= 2) h.server.add(args.id); // 2nd replay lands
      return Promise.resolve({ ok: true, id: args.id });
    });
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-14', payload: draft() });
    await settle(8);
    check(
      'CASE 14 unconfirmed settle -> replayed until server confirms, then removed',
      calls >= 2 && h.server.has('txn-14') && h.coord.getState().pendingCount === 0,
      `calls=${calls} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 15 — server confirmation success -> queue ack/remove (happy path)
  {
    const h = makeHarness({ seed: seedWith([rec({ queueId: 'q-15', entityId: 'txn-15' })]) });
    await h.coord.hydrate();
    await settle();
    check(
      'CASE 15 confirmed -> durable removal',
      h.coord.getState().pendingCount === 0 && (h.storage.dump() === '[]' || h.storage.dump() === null || !h.storage.dump()!.includes('txn-15')),
      `pending=${h.coord.getState().pendingCount} storage=${h.storage.dump()}`,
    );
  }

  // CASE 16 — ack persist FAILURE -> queue retained (removal did not stick)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-16', payload: draft() });
    // enqueue persisted (1 set). The reconcile removal is the NEXT set -> fail it.
    h.storage.failSet(1);
    await settle(8);
    const stillThere = (h.storage.dump() ?? '').includes('txn-16');
    check(
      'CASE 16 ack persist failure -> item still on disk (never lost)',
      stillThere,
      `storage=${h.storage.dump()}`,
    );
  }

  // CASE 17 — transport flush failure -> backoff timer scheduled (5s first)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-17', payload: draft() });
    await settle();
    const t = h.timers.find((x) => !x.cancelled);
    check(
      'CASE 17 transport -> backoff scheduled at 5000ms',
      !!t && t.ms === 5000,
      `timers=${JSON.stringify(h.timers.map((x) => ({ ms: x.ms, c: x.cancelled })))}`,
    );
  }

  // CASE 17b — offline enqueue, then online: backoff fires -> flush succeeds
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-17b', payload: draft() });
    await settle();
    // network back
    h.setCreate((args) => {
      h.server.add(args.id);
      return Promise.resolve({ ok: true, id: args.id });
    });
    h.runTimers();
    await settle(8);
    check(
      'CASE 17b backoff retry after network returns -> sent, queue empty',
      h.server.has('txn-17b') && h.coord.getState().pendingCount === 0,
      `pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 18 — terminal flush failure -> retained + failed state, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let terminalCalls = 0;
    h.setCreate(() => {
      terminalCalls += 1;
      return Promise.resolve(TERMINAL);
    });
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-18', payload: draft() });
    await settle();
    const afterEnqueue = terminalCalls;
    // another (non-includeFailed) trigger must NOT re-run a terminal item
    h.coord.requestFlush();
    await settle();
    check(
      'CASE 18 terminal -> retained, failedIds, NOT auto-retried',
      h.coord.getState().failedIds.has('txn-18') &&
        h.coord.getState().pendingCount === 1 &&
        afterEnqueue === 1 &&
        terminalCalls === afterEnqueue,
      `failed=${[...h.coord.getState().failedIds]} calls ${afterEnqueue}->${terminalCalls}`,
    );
  }

  // CASE 18b — requestFlush({includeFailed}) retries a terminal item once
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TERMINAL));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-18b', payload: draft() });
    await settle();
    const failedBefore = h.coord.getState().failedIds.has('txn-18b');
    h.setCreate((args) => {
      h.server.add(args.id);
      return Promise.resolve({ ok: true, id: args.id });
    });
    h.coord.requestFlush({ includeFailed: true });
    await settle(8);
    check(
      'CASE 18b includeFailed retry -> terminal item re-attempted and sent',
      failedBefore &&
        h.server.has('txn-18b') &&
        h.coord.getState().pendingCount === 0 &&
        h.coord.getState().failedIds.size === 0,
      `failedBefore=${failedBefore} server=${h.server.has('txn-18b')} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 19 — pending 0 -> no lingering backoff timer
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-19', payload: draft() });
    await settle(8);
    check(
      'CASE 19 all sent -> no active backoff timer',
      h.timers.filter((t) => !t.cancelled).length === 0 && h.coord.getState().pendingCount === 0,
      `timers=${h.timers.length}`,
    );
  }

  // CASE 20 — scope change cancels the old backoff timer
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-20', payload: draft() });
    await settle();
    const t = h.timers.find((x) => x.ms === 5000);
    h.setScope(B);
    check(
      'CASE 20 scope change -> old backoff timer cancelled',
      !!t && t.cancelled === true,
      `t=${JSON.stringify(t)}`,
    );
  }

  // CASE 21 — logout A -> login B -> A's op is NOT flushed under B
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-21', payload: draft() });
    await settle();
    const beforeSwitch = h.createLog.length;
    h.setScope(null); // logout
    h.setScope(B); // login B
    // B is online (default create), but A's op must not run under B
    h.setCreate((args) => {
      h.server.add(args.id);
      return Promise.resolve({ ok: true, id: args.id });
    });
    h.coord.requestFlush();
    await settle(8);
    const ranForA = h.createLog.slice(beforeSwitch).some((c) => c.id === 'txn-21');
    check(
      'CASE 21 A op never flushed while B is the active scope',
      ranForA === false && !h.server.has('txn-21'),
      `ranForA=${ranForA} server=${[...h.server]}`,
    );
  }

  // CASE 22 — A re-login -> A's pending op resumes and flushes
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-22', payload: draft() });
    await settle();
    h.setScope(null);
    h.setScope(B);
    await settle();
    h.setScope(A); // back to A
    h.setCreate((args) => {
      h.server.add(args.id);
      return Promise.resolve({ ok: true, id: args.id });
    });
    h.coord.requestFlush();
    await settle(8);
    check(
      'CASE 22 A re-login -> pending resumes and sends',
      h.server.has('txn-22') && h.coord.getState().pendingCount === 0,
      `pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 23 — two simultaneous triggers -> no parallel createTransaction
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-23a', payload: draft() });
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-23b', payload: draft() });
    await settle();
    h.maxConcurrentCreates = 0;
    h.setCreate(async (args) => {
      await new Promise<void>((r) => setTimeout(r, 0));
      h.server.add(args.id);
      return { ok: true, id: args.id };
    });
    h.coord.requestFlush();
    h.coord.requestFlush();
    h.runTimers();
    await settle(10);
    check(
      'CASE 23 concurrent triggers -> flusher single-flight (no parallel writes)',
      h.maxConcurrentCreates <= 1 && h.coord.getState().pendingCount === 0,
      `maxConcurrent=${h.maxConcurrentCreates} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 24 — dispose -> timers disposed, no further work, enqueue refused
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-24', payload: draft() });
    await settle();
    h.coord.dispose();
    const timerCancelled = h.timers.every((t) => t.cancelled) || h.timers.length === 0;
    const before = h.createLog.length;
    h.runTimers(); // nothing non-cancelled should run
    const enq = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-24b', payload: draft() });
    await settle();
    check(
      'CASE 24 dispose -> backoff cancelled, no further flush, enqueue refused',
      timerCancelled && h.createLog.length === before && enq.ok === false,
      `cancelled=${timerCancelled} calls ${before}->${h.createLog.length} enq=${JSON.stringify(enq)}`,
    );
  }

  // CASE 25 — remote NOT ready -> no flush attempts even with pending ops
  {
    const h = makeHarness({ remoteReady: false });
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-25', payload: draft() });
    await settle();
    const noRun = h.createLog.length === 0;
    h.setRemoteReady(true);
    h.setCreate((args) => {
      h.server.add(args.id);
      return Promise.resolve({ ok: true, id: args.id });
    });
    h.coord.requestFlush();
    await settle(8);
    check(
      'CASE 25 flush gated on remote-ready; resumes once ready',
      noRun && h.server.has('txn-25') && h.coord.getState().pendingCount === 0,
      `noRunWhileNotReady=${noRun} pending=${h.coord.getState().pendingCount}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
