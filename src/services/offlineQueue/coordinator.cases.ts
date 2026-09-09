/**
 * Static verification for the Offline Write Queue coordinator
 * (src/services/offlineQueue/coordinator.ts) — STEP 16-H2-A2, extended for
 * STEP 16-H2-B2 (UPDATE + soft DELETE enqueue APIs, op-aware ack).
 *
 * Fully faked: in-memory storage, scriptable `createTransaction` /
 * `updateTransaction` / `softDeleteTransaction`, a manual timer, a
 * synchronous `requestRefresh`, and a mutable "server snapshot" (a
 * `Map<id, Transaction>` of ACTIVE rows). No React, no Supabase.
 */
import { QUEUE_SCHEMA_VERSION, type PendingTransactionCreate } from '@/lib/offlineQueue';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type {
  CreateCardResult,
  SoftDeleteCardResult,
  UpdateCardResult,
} from '@/services/remoteCardWrite';
import type {
  CreateTransactionResult,
  SoftDeleteResult,
  UpdateTransactionResult,
} from '@/services/remoteFinanceWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { CreditCard, Transaction } from '@/store/types';

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

/** A server row that reflects `d` — mirrors `createDraftToDomain`. */
const draftToTxn = (id: string, d: NewTransactionDraft): Transaction => ({
  id,
  type: d.type,
  category: d.category,
  amount: d.amount,
  memo: d.memo,
  date: d.date,
  ...(d.paymentMethod !== undefined ? { paymentMethod: d.paymentMethod } : {}),
  ...(d.cardId !== undefined ? { cardId: d.cardId } : {}),
  ...(d.installment !== undefined ? { installment: d.installment } : {}),
  ...(d.splits !== undefined && d.splits.length > 0 ? { splits: d.splits } : {}),
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
  /** trusted server snapshot's ACTIVE transactions, keyed by id. */
  server: Map<string, Transaction>;
  cards: Set<string>;
  /** trusted server snapshot's ACTIVE cards, keyed by id (STEP 16-H2-C2-A1). */
  cardServer: Map<string, CreditCard>;
  storage: ReturnType<typeof memStorage>;
  createLog: { id: string; householdId: string; expectedUserId: string; knownCardIds: ReadonlySet<string> }[];
  updateLog: HUpdateArgs[];
  deleteLog: HDeleteArgs[];
  cardCreateLog: HCardCreateArgs[];
  cardUpdateLog: HCardUpdateArgs[];
  cardDeleteLog: HCardDeleteArgs[];
  maxConcurrentCreates: number;
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setRemoteReady: (b: boolean) => void;
  setCreate: (f: (args: HCreateArgs) => Promise<CreateTransactionResult>) => void;
  setUpdate: (f: (args: HUpdateArgs) => Promise<UpdateTransactionResult>) => void;
  setDelete: (f: (args: HDeleteArgs) => Promise<SoftDeleteResult>) => void;
  setCardCreate: (f: (args: HCardCreateArgs) => Promise<CreateCardResult>) => void;
  setCardUpdate: (f: (args: HCardUpdateArgs) => Promise<UpdateCardResult>) => void;
  setCardDelete: (f: (args: HCardDeleteArgs) => Promise<SoftDeleteCardResult>) => void;
  /** put/replace a server row (id present + fields set). */
  serverPut: (id: string, d: NewTransactionDraft) => void;
  /** remove a server row (id absent == deleted/gone in the read model). */
  serverDelete: (id: string) => void;
  cardServerPut: (id: string, d: NewCardDraft) => void;
  cardServerDelete: (id: string) => void;
  runTimers: () => void;
  refreshes: () => number;
}

const cardDraft = (over: Partial<NewCardDraft> = {}): NewCardDraft => ({ name: 'Visa', ...over });
const draftToCard = (id: string, d: NewCardDraft): CreditCard => ({
  id,
  name: d.name,
  ...(d.color !== undefined ? { color: d.color } : {}),
  ...(d.paymentDay !== undefined ? { paymentDay: d.paymentDay } : {}),
  ...(d.closingDay !== undefined ? { closingDay: d.closingDay } : {}),
  createdAt: '2026-09-10T00:00:00.000Z',
});

type HCardCreateArgs = { id: string; householdId: string; expectedUserId: string; draft: NewCardDraft };
type HCardUpdateArgs = HCardCreateArgs & { expectedUpdatedAt: string };
type HCardDeleteArgs = { id: string; householdId: string; expectedUserId: string; expectedUpdatedAt: string };

type HCreateArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewTransactionDraft;
  knownCardIds: ReadonlySet<string>;
};

type HUpdateArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  expectedUpdatedAt: string;
  draft: NewTransactionDraft;
  knownCardIds: ReadonlySet<string>;
  originalRawCardId?: string | null;
};

type HDeleteArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  expectedUpdatedAt: string;
};

function makeHarness(opts?: { seed?: string; remoteReady?: boolean; scope?: CoordinatorScope | null }): Harness {
  const server = new Map<string, Transaction>();
  const cards = new Set<string>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = opts?.scope === undefined ? A : opts.scope;
  let remoteReady = opts?.remoteReady ?? true;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const createLog: Harness['createLog'] = [];
  const updateLog: HUpdateArgs[] = [];
  const deleteLog: HDeleteArgs[] = [];
  const cardServer = new Map<string, CreditCard>();
  const cardCreateLog: HCardCreateArgs[] = [];
  const cardUpdateLog: HCardUpdateArgs[] = [];
  const cardDeleteLog: HCardDeleteArgs[] = [];
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
    server.set(args.id, draftToTxn(args.id, args.draft));
    return { ok: true, id: args.id };
  };

  // default updateTransaction: "server applied it + snapshot reflects the draft"
  let updateImpl = async (args: HUpdateArgs): Promise<UpdateTransactionResult> => {
    updateLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.set(args.id, draftToTxn(args.id, args.draft));
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };

  // default softDeleteTransaction: "server applied it + row gone from snapshot"
  let deleteImpl = async (args: HDeleteArgs): Promise<SoftDeleteResult> => {
    deleteLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.delete(args.id);
    return { ok: true };
  };

  // default card services: "server accepted + snapshot reflects it"
  let cardCreateImpl = async (args: HCardCreateArgs): Promise<CreateCardResult> => {
    cardCreateLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    cardServer.set(args.id, draftToCard(args.id, args.draft));
    return { ok: true, id: args.id };
  };
  let cardUpdateImpl = async (args: HCardUpdateArgs): Promise<UpdateCardResult> => {
    cardUpdateLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    cardServer.set(args.id, draftToCard(args.id, args.draft));
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };
  let cardDeleteImpl = async (args: HCardDeleteArgs): Promise<SoftDeleteCardResult> => {
    cardDeleteLog.push(args);
    await new Promise<void>((r) => setTimeout(r, 0));
    cardServer.delete(args.id);
    return { ok: true };
  };

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => remoteReady,
    getKnownCardIds: () => cards,
    getServerTransactions: () => server,
    getServerCards: () => cardServer,
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    createTransaction: (args) => createImpl(args as HCreateArgs),
    updateTransaction: (args) => updateImpl(args as HUpdateArgs),
    softDeleteTransaction: (args) => deleteImpl(args as HDeleteArgs),
    createCard: (args) => cardCreateImpl(args as HCardCreateArgs),
    updateCard: (args) => cardUpdateImpl(args as HCardUpdateArgs),
    softDeleteCard: (args) => cardDeleteImpl(args as HCardDeleteArgs),
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
  h.cardServer = cardServer;
  h.storage = storage;
  h.createLog = createLog;
  h.updateLog = updateLog;
  h.deleteLog = deleteLog;
  h.cardCreateLog = cardCreateLog;
  h.cardUpdateLog = cardUpdateLog;
  h.cardDeleteLog = cardDeleteLog;
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
  h.setUpdate = (f) => {
    updateImpl = f;
  };
  h.setDelete = (f) => {
    deleteImpl = f;
  };
  h.setCardCreate = (f) => {
    cardCreateImpl = f;
  };
  h.setCardUpdate = (f) => {
    cardUpdateImpl = f;
  };
  h.setCardDelete = (f) => {
    cardDeleteImpl = f;
  };
  h.serverPut = (id, d) => {
    server.set(id, draftToTxn(id, d));
  };
  h.serverDelete = (id) => {
    server.delete(id);
  };
  h.cardServerPut = (id, d) => {
    cardServer.set(id, draftToCard(id, d));
  };
  h.cardServerDelete = (id) => {
    cardServer.delete(id);
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

const seedWith = (recs: PendingTransactionCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingTransactionCreate> = {}): PendingTransactionCreate => ({
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
      `enq=${JSON.stringify(enq)} server=${[...h.server.keys()]} pending=${h.coord.getState().pendingCount}`,
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
      if (calls >= 2) h.serverPut(args.id, args.draft); // 2nd replay lands
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
      h.serverPut(args.id, args.draft);
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
      h.serverPut(args.id, args.draft);
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
      h.serverPut(args.id, args.draft);
      return Promise.resolve({ ok: true, id: args.id });
    });
    h.coord.requestFlush();
    await settle(8);
    const ranForA = h.createLog.slice(beforeSwitch).some((c) => c.id === 'txn-21');
    check(
      'CASE 21 A op never flushed while B is the active scope',
      ranForA === false && !h.server.has('txn-21'),
      `ranForA=${ranForA} server=${[...h.server.keys()]}`,
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
      h.serverPut(args.id, args.draft);
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
      h.serverPut(args.id, args.draft);
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
      h.serverPut(args.id, args.draft);
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

  /* ================================================================= *
   * STEP 16-H2-B2 — transaction UPDATE + soft DELETE enqueue / ack
   * ================================================================= */

  const U_TRANSPORT: UpdateTransactionResult = { ok: false, reason: 'error', message: 'net', transport: true };
  const U_CONFLICT: UpdateTransactionResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됐어요' };
  const U_DELETED: UpdateTransactionResult = { ok: false, reason: 'deleted', message: '이미 삭제된 거래예요' };
  const U_GONE: UpdateTransactionResult = { ok: false, reason: 'gone', message: '거래를 찾을 수 없어요' };
  const D_TRANSPORT: SoftDeleteResult = { ok: false, reason: 'error', message: 'net', transport: true };
  const D_CONFLICT: SoftDeleteResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됐어요' };

  const updSeedObj = (over: Record<string, unknown> = {}) => ({
    queueId: 'q-useed',
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: A,
    entity: 'transaction',
    op: 'update',
    entityId: 'txn-useed',
    payload: draft(),
    expectedUpdatedAt: 'V1-TOKEN',
    originalRawCardId: null,
    enqueuedAt: '2026-09-10T09:00:00.000Z',
    attemptCount: 0,
    ...over,
  });

  // CASE 26 — enqueue UPDATE before hydrate -> not-hydrated
  {
    const h = makeHarness();
    const enq = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-26', payload: draft(), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    check(
      'CASE 26 enqueue UPDATE before hydrate -> not-hydrated',
      enq.ok === false && enq.reason === 'not-hydrated',
      JSON.stringify(enq),
    );
  }

  // CASE 27 — UPDATE transport -> enqueued, visible as a pending UPDATE
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-27', draft({ amount: 100 }));
    h.setUpdate(() => Promise.resolve(U_TRANSPORT));
    const enq = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-27', payload: draft({ amount: 777 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 27 UPDATE transport -> pending, opByEntity=update, not acked',
      enq.ok === true &&
        st.pendingIds.has('txn-27') &&
        st.opByEntity.get('txn-27') === 'update' &&
        st.pendingCount === 1,
      `enq=${JSON.stringify(enq)} op=${st.opByEntity.get('txn-27')} pending=${[...st.pendingIds]}`,
    );
  }

  // CASE 28 — UPDATE online -> flushes, server row matches draft, reconcile acks
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-28', draft({ amount: 100, memo: 'old' }));
    const enq = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-28', payload: draft({ amount: 250, memo: 'new' }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(8);
    check(
      'CASE 28 UPDATE online -> applied, field-matched, queue empty',
      enq.ok === true &&
        h.updateLog.length === 1 &&
        h.server.get('txn-28')?.amount === 250 &&
        h.server.get('txn-28')?.memo === 'new' &&
        h.coord.getState().pendingCount === 0,
      `updates=${h.updateLog.length} row=${JSON.stringify(h.server.get('txn-28'))} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 29 — the FROZEN token + originalRawCardId reach updateTransaction verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-29', draft());
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-29', payload: draft({ amount: 42 }),
      expectedUpdatedAt: 'FROZEN-AT-MOUNT', originalRawCardId: 'card-was-deleted',
    });
    await settle(8);
    check(
      'CASE 29 UPDATE forwards frozen expectedUpdatedAt + originalRawCardId verbatim',
      h.updateLog.length === 1 &&
        h.updateLog[0].expectedUpdatedAt === 'FROZEN-AT-MOUNT' &&
        h.updateLog[0].originalRawCardId === 'card-was-deleted',
      JSON.stringify(h.updateLog[0]),
    );
  }

  // CASE 30 — coordinator NEVER re-reads a newer token at flush time
  {
    const h = makeHarness();
    await h.coord.hydrate();
    // server row already moved on to a newer token/state, but the queued op
    // must still carry the token frozen at enqueue.
    h.serverPut('txn-30', draft({ amount: 999 }));
    h.setUpdate((args) => {
      h.updateLog.push(args);
      return Promise.resolve(U_TRANSPORT); // stay offline: 2 attempts
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-30', payload: draft({ amount: 1 }), expectedUpdatedAt: 'V1-ONLY', originalRawCardId: null,
    });
    await settle();
    h.runTimers(); // backoff retry
    await settle(6);
    check(
      'CASE 30 every replay uses the SAME frozen token (no refresh)',
      h.updateLog.length >= 2 && h.updateLog.every((u) => u.expectedUpdatedAt === 'V1-ONLY'),
      `tokens=${JSON.stringify(h.updateLog.map((u) => u.expectedUpdatedAt))}`,
    );
  }

  // CASE 31 — UPDATE ack needs FIELD match, not just id presence
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-31', draft({ amount: 100 }));
    // service says ok but the snapshot is still stale (row unchanged). The
    // `await` yields a macrotask so the "unconfirmed -> replay" cycle can't
    // starve the test's own `settle`.
    let applied = false;
    h.setUpdate(async (args) => {
      h.updateLog.push(args);
      await new Promise<void>((r) => setTimeout(r, 0));
      if (applied) h.serverPut(args.id, args.draft);
      return { ok: true, updatedAt: 'V2' };
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-31', payload: draft({ amount: 500 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(8);
    const stalePending = h.coord.getState().pendingCount === 1; // not acked yet
    applied = true;
    h.coord.requestFlush();
    await settle(10);
    check(
      'CASE 31 stale snapshot -> NOT acked (replays); acked once fields match',
      stalePending &&
        h.server.get('txn-31')?.amount === 500 &&
        h.coord.getState().pendingCount === 0,
      `stalePending=${stalePending} row=${JSON.stringify(h.server.get('txn-31'))} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 32 — UPDATE terminal conflict -> retained + failed + reason, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-32', draft({ amount: 100 }));
    let calls = 0;
    h.setUpdate(() => {
      calls += 1;
      return Promise.resolve(U_CONFLICT);
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-32', payload: draft({ amount: 9 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle();
    const afterEnqueue = calls;
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 32 UPDATE conflict -> failedIds + failedReasons=conflict, not auto-retried',
      st.failedIds.has('txn-32') &&
        st.failedReasons.get('txn-32') === 'conflict' &&
        st.pendingCount === 1 &&
        afterEnqueue === 1 &&
        calls === afterEnqueue,
      `failed=${[...st.failedIds]} reason=${st.failedReasons.get('txn-32')} calls ${afterEnqueue}->${calls}`,
    );
  }

  // CASE 33 — UPDATE conflict NEVER overwrites the other device's value (no blind LWW)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-33', draft({ amount: 9999, memo: 'device-B' })); // B already won
    h.setUpdate((args) => {
      h.updateLog.push(args);
      return Promise.resolve(U_CONFLICT);
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-33', payload: draft({ amount: 1, memo: 'device-A' }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(8);
    check(
      "CASE 33 conflict -> B's row untouched, queue retained durably, one attempt only",
      h.server.get('txn-33')?.amount === 9999 &&
        h.server.get('txn-33')?.memo === 'device-B' &&
        h.updateLog.length === 1 &&
        h.coord.getState().pendingCount === 1 &&
        (h.storage.dump() ?? '').includes('txn-33'),
      `row=${JSON.stringify(h.server.get('txn-33'))} attempts=${h.updateLog.length}`,
    );
  }

  // CASE 34 — terminal reason is PERSISTED (lastErrorReason) for restart
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-34', draft());
    h.setUpdate(() => Promise.resolve(U_CONFLICT));
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-34', payload: draft({ amount: 2 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(6);
    check(
      'CASE 34 terminal UPDATE persists lastErrorReason:"conflict" (schema still 1)',
      (h.storage.dump() ?? '').includes('"lastErrorReason":"conflict"') &&
        (h.storage.dump() ?? '').includes('"schemaVersion":1'),
      `storage=${h.storage.dump()}`,
    );
  }

  // CASE 35 — restart RESTORE: a seeded terminal-failed UPDATE comes back failed with its reason
  {
    const seed = JSON.stringify([
      updSeedObj({ queueId: 'q-35', entityId: 'txn-35', lastError: 'conflict', lastErrorReason: 'conflict' }),
    ]);
    const h = makeHarness({ seed, remoteReady: false }); // offline so it can't flush away
    await h.coord.hydrate();
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 35 restart -> seeded failed UPDATE restored with failedReasons=conflict',
      st.failedIds.has('txn-35') &&
        st.failedReasons.get('txn-35') === 'conflict' &&
        st.opByEntity.get('txn-35') === 'update' &&
        st.pendingCount === 1,
      `failed=${[...st.failedIds]} reason=${st.failedReasons.get('txn-35')} op=${st.opByEntity.get('txn-35')}`,
    );
  }

  // CASE 36 — enqueue DELETE before hydrate -> not-hydrated
  {
    const h = makeHarness();
    const enq = await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-36', expectedUpdatedAt: 'V1' });
    check(
      'CASE 36 enqueue DELETE before hydrate -> not-hydrated',
      enq.ok === false && enq.reason === 'not-hydrated',
      JSON.stringify(enq),
    );
  }

  // CASE 37 — DELETE transport -> enqueued, visible as a pending DELETE
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-37', draft());
    h.setDelete(() => Promise.resolve(D_TRANSPORT));
    const enq = await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-37', expectedUpdatedAt: 'V1' });
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 37 DELETE transport -> pending, opByEntity=delete',
      enq.ok === true &&
        st.pendingIds.has('txn-37') &&
        st.opByEntity.get('txn-37') === 'delete' &&
        st.pendingCount === 1,
      `enq=${JSON.stringify(enq)} op=${st.opByEntity.get('txn-37')}`,
    );
  }

  // CASE 38 — DELETE online -> flushes, row leaves the snapshot, reconcile acks
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-38', draft());
    const enq = await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-38', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      'CASE 38 DELETE online -> row gone, queue empty',
      enq.ok === true &&
        h.deleteLog.length === 1 &&
        !h.server.has('txn-38') &&
        h.coord.getState().pendingCount === 0,
      `deletes=${h.deleteLog.length} present=${h.server.has('txn-38')} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 39 — DELETE forwards the FROZEN token verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-39', draft());
    await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-39', expectedUpdatedAt: 'DEL-FROZEN' });
    await settle(8);
    check(
      'CASE 39 DELETE forwards frozen expectedUpdatedAt verbatim',
      h.deleteLog.length === 1 && h.deleteLog[0].expectedUpdatedAt === 'DEL-FROZEN',
      JSON.stringify(h.deleteLog[0]),
    );
  }

  // CASE 40 — DELETE ack requires the id to be ABSENT; still-present -> replays
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-40', draft());
    let reallyDelete = false;
    h.setDelete(async (args) => {
      h.deleteLog.push(args);
      await new Promise<void>((r) => setTimeout(r, 0));
      if (reallyDelete) h.serverDelete(args.id);
      return { ok: true };
    });
    await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-40', expectedUpdatedAt: 'V1' });
    await settle(8);
    const stillPending = h.coord.getState().pendingCount === 1;
    reallyDelete = true;
    h.coord.requestFlush();
    await settle(10);
    check(
      'CASE 40 DELETE not acked while row still present; acked once absent',
      stillPending && !h.server.has('txn-40') && h.coord.getState().pendingCount === 0,
      `stillPending=${stillPending} present=${h.server.has('txn-40')} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 41 — DELETE terminal conflict -> retained + failed + reason
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-41', draft({ amount: 100 }));
    h.setDelete(() => Promise.resolve(D_CONFLICT));
    await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-41', expectedUpdatedAt: 'V1' });
    await settle(6);
    const st = h.coord.getState();
    check(
      'CASE 41 DELETE conflict -> failedReasons=conflict, row still on server, retained',
      st.failedIds.has('txn-41') &&
        st.failedReasons.get('txn-41') === 'conflict' &&
        h.server.has('txn-41') &&
        st.pendingCount === 1,
      `reason=${st.failedReasons.get('txn-41')} present=${h.server.has('txn-41')}`,
    );
  }

  // CASE 42 — DELETE is idempotent: service reports ok for an already-gone row -> acked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    // row already absent from the snapshot
    h.setDelete((args) => {
      h.deleteLog.push(args);
      return Promise.resolve({ ok: true }); // idempotent success, touches nothing
    });
    const enq = await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-42', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      'CASE 42 DELETE already-gone -> ok -> acked, queue empty, no failure',
      enq.ok === true &&
        h.coord.getState().pendingCount === 0 &&
        h.coord.getState().failedIds.size === 0,
      `pending=${h.coord.getState().pendingCount} failed=${[...h.coord.getState().failedIds]}`,
    );
  }

  // CASE 43 — a DIFFERING same-op pending change for the same id is REFUSED
  // (no silent overwrite). Two different UPDATEs for one transaction.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-43', draft({ amount: 1 }));
    h.setUpdate(() => Promise.resolve(U_TRANSPORT));
    const up1 = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-43', payload: draft({ amount: 5 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle();
    const up2 = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-43', payload: draft({ amount: 6 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    const stored = (h.storage.dump() ?? '');
    check(
      'CASE 43 differing 2nd UPDATE(same id) -> existing-pending, 1st kept verbatim',
      up1.ok === true &&
        up2.ok === false && up2.reason === 'existing-pending' &&
        h.coord.getState().pendingCount === 1 &&
        stored.includes('"amount":5') && !stored.includes('"amount":6'),
      `up1=${JSON.stringify(up1)} up2=${JSON.stringify(up2)} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 44 — NO COMPACTION across ops: a pending CREATE and a later pending
  // UPDATE for the same id are kept as TWO separate FIFO records (never
  // merged), so a flush replays create-then-update in order (§24).
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT));
    h.setUpdate(() => Promise.resolve(U_TRANSPORT));
    const cr = await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-44', payload: draft() });
    await settle();
    const up = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-44', payload: draft({ amount: 5 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle();
    const ops = h.coord.getState().scopeOps.map((o) => o.op).join(',');
    check(
      'CASE 44 pending CREATE + UPDATE(same id) -> 2 FIFO records, not compacted',
      cr.ok === true && up.ok === true &&
        h.coord.getState().pendingCount === 2 &&
        ops === 'create,update',
      `cr=${JSON.stringify(cr)} up=${JSON.stringify(up)} ops=[${ops}] pending=${h.coord.getState().pendingCount}`,
    );
  }

  // CASE 44b — same, UPDATE then DELETE for one id -> both kept, FIFO order
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-44b', draft());
    h.setUpdate(() => Promise.resolve(U_TRANSPORT));
    h.setDelete(() => Promise.resolve(D_TRANSPORT));
    const up = await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-44b', payload: draft({ amount: 5 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle();
    const del = await h.coord.enqueueTransactionDelete({ scope: A, entityId: 'txn-44b', expectedUpdatedAt: 'V1' });
    await settle();
    const ops = h.coord.getState().scopeOps.map((o) => o.op).join(',');
    check(
      'CASE 44b pending UPDATE + DELETE(same id) -> 2 FIFO records, not compacted',
      up.ok === true && del.ok === true &&
        h.coord.getState().pendingCount === 2 && ops === 'update,delete',
      `up=${JSON.stringify(up)} del=${JSON.stringify(del)} ops=[${ops}]`,
    );
  }

  // CASE 45 — scope isolation: A's pending UPDATE is invisible + never flushed under B
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-45', draft());
    h.setUpdate(() => Promise.resolve(U_TRANSPORT));
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-45', payload: draft({ amount: 5 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState();
    const beforeB = h.updateLog.length;
    h.setUpdate((args) => {
      h.updateLog.push(args);
      h.serverPut(args.id, args.draft);
      return Promise.resolve({ ok: true, updatedAt: 'V2' });
    });
    h.coord.requestFlush();
    await settle(8);
    const ranUnderB = h.updateLog.slice(beforeB).some((u) => u.id === 'txn-45');
    h.setScope(A);
    const underA = h.coord.getState();
    check(
      'CASE 45 UPDATE scope-isolated: hidden + not flushed under B, visible again under A',
      underB.pendingCount === 0 &&
        ranUnderB === false &&
        underA.pendingIds.has('txn-45') &&
        underA.opByEntity.get('txn-45') === 'update',
      `B=${underB.pendingCount} ranUnderB=${ranUnderB} A=${[...underA.pendingIds]}`,
    );
  }

  // CASE 46 — getState().failedReasons is SCOPED, and rebuilt from durable records on return
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-46', draft({ amount: 100 }));
    h.setUpdate(() => Promise.resolve(U_CONFLICT));
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-46', payload: draft({ amount: 3 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(6);
    const underA1 = h.coord.getState().failedReasons.get('txn-46');
    h.setScope(B);
    const underB = h.coord.getState().failedReasons.has('txn-46');
    h.setScope(A);
    const underA2 = h.coord.getState().failedReasons.get('txn-46');
    check(
      'CASE 46 failedReasons scoped: A sees conflict, B does not, A sees it again (from disk)',
      underA1 === 'conflict' && underB === false && underA2 === 'conflict',
      `A1=${underA1} B=${underB} A2=${underA2}`,
    );
  }

  // CASE 47 — requestFlush({includeFailed}) clears reasons AND drops the durable marker
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-47', draft({ amount: 100 }));
    let mode: 'conflict' | 'ok' = 'conflict';
    h.setUpdate((args) => {
      h.updateLog.push(args);
      if (mode === 'ok') {
        h.serverPut(args.id, args.draft);
        return Promise.resolve({ ok: true, updatedAt: 'V2' });
      }
      return Promise.resolve(U_CONFLICT);
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-47', payload: draft({ amount: 7 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(6);
    const hadReason =
      h.coord.getState().failedReasons.get('txn-47') === 'conflict' &&
      (h.storage.dump() ?? '').includes('"lastErrorReason"');
    mode = 'ok';
    h.coord.requestFlush({ includeFailed: true });
    await settle(10);
    check(
      'CASE 47 includeFailed -> reason cleared, durable lastErrorReason dropped, op retried & acked',
      hadReason &&
        h.coord.getState().failedReasons.size === 0 &&
        !(h.storage.dump() ?? '').includes('"lastErrorReason"') &&
        h.coord.getState().pendingCount === 0 &&
        h.server.get('txn-47')?.amount === 7,
      `hadReason=${hadReason} reasons=${h.coord.getState().failedReasons.size} pending=${h.coord.getState().pendingCount} storage=${h.storage.dump()}`,
    );
  }

  /* ---- STEP 16-H2-B2.1 — failed UPDATE whose server row is GONE ---- */

  // CASE 48 — terminal 'deleted' UPDATE (row removed by another device):
  // retained, failedReasons='deleted', op stays 'update', NOT auto-retried,
  // frozen token never bumped. The durable record is the data the read
  // layer needs to resurface a synthetic failed row.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-48', draft({ amount: 100 })); // exists at edit time…
    let calls = 0;
    h.setUpdate((args) => {
      calls += 1;
      h.updateLog.push(args);
      h.serverDelete(args.id); // …device B deletes it; server now says 'deleted'
      return Promise.resolve(U_DELETED);
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-48', payload: draft({ amount: 12000 }), expectedUpdatedAt: 'V1-FROZEN', originalRawCardId: null,
    });
    await settle(6);
    const afterEnqueue = calls;
    h.coord.requestFlush(); // plain trigger must NOT re-run a terminal item
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 48 terminal "deleted" UPDATE -> retained, reason=deleted, op=update, no auto-retry, token frozen',
      st.failedIds.has('txn-48') &&
        st.failedReasons.get('txn-48') === 'deleted' &&
        st.opByEntity.get('txn-48') === 'update' &&
        st.pendingCount === 1 &&
        afterEnqueue === 1 && calls === 1 &&
        h.updateLog.every((u) => u.expectedUpdatedAt === 'V1-FROZEN') &&
        !h.server.has('txn-48'),
      `reason=${st.failedReasons.get('txn-48')} op=${st.opByEntity.get('txn-48')} calls=${calls} present=${h.server.has('txn-48')}`,
    );
  }

  // CASE 49 — restart RESTORE: a seeded terminal 'deleted'/'gone' UPDATE
  // whose server row is absent still comes back as a failed UPDATE (so the
  // read layer can rebuild its synthetic row).
  {
    const seed = JSON.stringify([
      updSeedObj({ queueId: 'q-49a', entityId: 'txn-49a', payload: draft({ amount: 12000, memo: '점심' }), lastError: 'deleted', lastErrorReason: 'deleted' }),
      updSeedObj({ queueId: 'q-49b', entityId: 'txn-49b', payload: draft({ amount: 900 }), lastError: 'gone', lastErrorReason: 'gone' }),
    ]);
    const h = makeHarness({ seed, remoteReady: false }); // server has neither row
    await h.coord.hydrate();
    await settle();
    const st = h.coord.getState();
    check(
      'CASE 49 restart -> seeded terminal deleted/gone UPDATE restored with op+reason (row-gone visibility data)',
      st.failedIds.has('txn-49a') && st.failedReasons.get('txn-49a') === 'deleted' &&
        st.opByEntity.get('txn-49a') === 'update' &&
        st.failedIds.has('txn-49b') && st.failedReasons.get('txn-49b') === 'gone' &&
        st.opByEntity.get('txn-49b') === 'update' &&
        st.pendingCount === 2,
      `a=${st.failedReasons.get('txn-49a')} b=${st.failedReasons.get('txn-49b')} pending=${st.pendingCount}`,
    );
  }

  // CASE 50 — scope isolation: A's failed row-gone UPDATE is invisible under B
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('txn-50', draft({ amount: 1 }));
    h.setUpdate((args) => {
      h.updateLog.push(args);
      h.serverDelete(args.id);
      return Promise.resolve(U_DELETED);
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-50', payload: draft({ amount: 9 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(6);
    h.setScope(B);
    const underB = h.coord.getState();
    h.setScope(A);
    const underA = h.coord.getState();
    check(
      'CASE 50 failed row-gone UPDATE: nothing under B, restored under A',
      underB.pendingCount === 0 &&
        underB.opByEntity.has('txn-50') === false &&
        underB.failedReasons.has('txn-50') === false &&
        underA.failedIds.has('txn-50') &&
        underA.failedReasons.get('txn-50') === 'deleted' &&
        underA.opByEntity.get('txn-50') === 'update',
      `B.pending=${underB.pendingCount} A.reason=${underA.failedReasons.get('txn-50')}`,
    );
  }

  // CASE 51 — terminal 'gone' UPDATE: same retention + reason plumbing
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate((args) => {
      h.updateLog.push(args);
      return Promise.resolve(U_GONE);
    });
    await h.coord.enqueueTransactionUpdate({
      scope: A, entityId: 'txn-51', payload: draft({ amount: 3 }), expectedUpdatedAt: 'V1', originalRawCardId: null,
    });
    await settle(6);
    const st = h.coord.getState();
    check(
      'CASE 51 terminal "gone" UPDATE -> failedReasons=gone, op=update, retained',
      st.failedIds.has('txn-51') && st.failedReasons.get('txn-51') === 'gone' &&
        st.opByEntity.get('txn-51') === 'update' && st.pendingCount === 1,
      `reason=${st.failedReasons.get('txn-51')}`,
    );
  }

  /* ================================================================= *
   * STEP 16-H2-C2-A1 — CARD enqueue / runOp forwarding / ack / scope
   * ================================================================= */

  const CU_TRANSPORT: UpdateCardResult = { ok: false, reason: 'error', message: 'net', transport: true };
  const CU_CONFLICT: UpdateCardResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };
  const CC_TRANSPORT: CreateCardResult = { ok: false, message: 'net', transport: true };
  const CD_TRANSPORT: SoftDeleteCardResult = { ok: false, reason: 'error', message: 'net', transport: true };
  const CD_CONFLICT: SoftDeleteCardResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };

  // C1 (§28.25) — CREATE forwards exact id / draft / scope
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueCardCreate({ scope: A, entityId: 'card-c1', payload: cardDraft({ name: 'C1', paymentDay: 7 }) });
    await settle(6);
    const a = h.cardCreateLog[0];
    check(
      'C1 card CREATE runOp forwards exact id/draft/scope',
      h.cardCreateLog.length === 1 && a.id === 'card-c1' && a.householdId === A.householdId &&
        a.expectedUserId === A.userId && a.draft.name === 'C1' && a.draft.paymentDay === 7,
      JSON.stringify(a),
    );
  }

  // C2 (§28.26/27) — CREATE success -> acked (fields match) ; CREATE transport -> pending
  {
    const h = makeHarness();
    await h.coord.hydrate();
    const enq = await h.coord.enqueueCardCreate({ scope: A, entityId: 'card-c2', payload: cardDraft({ name: 'C2' }) });
    await settle(8);
    check(
      'C2 card CREATE online -> server has it + fields match -> queue empty',
      enq.ok === true && h.cardServer.get('card-c2')?.name === 'C2' &&
        h.coord.getState().card.pendingIds.size === 0 && h.coord.getState().pendingCount === 0,
      `present=${h.cardServer.has('card-c2')} pending=${h.coord.getState().pendingCount}`,
    );
  }
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCardCreate(() => Promise.resolve(CC_TRANSPORT));
    const enq = await h.coord.enqueueCardCreate({ scope: A, entityId: 'card-c2t', payload: cardDraft() });
    await settle();
    const st = h.coord.getState();
    check(
      'C2t card CREATE transport -> pending card op, not on server',
      enq.ok === true && st.card.pendingIds.has('card-c2t') &&
        st.card.opByEntity.get('card-c2t') === 'create' && !h.cardServer.has('card-c2t'),
      `pending=${[...st.card.pendingIds]}`,
    );
  }

  // C3 (§28.28) — UPDATE forwards the FROZEN token verbatim; (§28.29) success; (§28.30) transport
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c3', cardDraft({ name: 'old' }));
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c3', payload: cardDraft({ name: 'new' }), expectedUpdatedAt: 'FROZEN-1' });
    await settle(8);
    check(
      'C3 card UPDATE forwards frozen token; applied; acked',
      h.cardUpdateLog.length === 1 && h.cardUpdateLog[0].expectedUpdatedAt === 'FROZEN-1' &&
        h.cardServer.get('card-c3')?.name === 'new' && h.coord.getState().pendingCount === 0,
      JSON.stringify(h.cardUpdateLog[0]),
    );
  }
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c3t', cardDraft());
    h.setCardUpdate((args) => { h.cardUpdateLog.push(args); return Promise.resolve(CU_TRANSPORT); });
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c3t', payload: cardDraft({ name: 'x' }), expectedUpdatedAt: 'V1' });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      'C3t card UPDATE transport -> every replay reuses the SAME frozen token',
      h.cardUpdateLog.length >= 2 && h.cardUpdateLog.every((u) => u.expectedUpdatedAt === 'V1'),
      JSON.stringify(h.cardUpdateLog.map((u) => u.expectedUpdatedAt)),
    );
  }

  // C4 (§28.31) — UPDATE conflict reason preserved, retained, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c4', cardDraft({ name: 'B-won' }));
    let calls = 0;
    h.setCardUpdate(() => { calls += 1; return Promise.resolve(CU_CONFLICT); });
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c4', payload: cardDraft({ name: 'A' }), expectedUpdatedAt: 'V1' });
    await settle(6);
    const after = calls;
    h.coord.requestFlush();
    await settle();
    const st = h.coord.getState();
    check(
      'C4 card UPDATE conflict -> failed + reason=conflict, B row untouched, no auto-retry',
      st.card.failedIds.has('card-c4') && st.card.failedReasons.get('card-c4') === 'conflict' &&
        h.cardServer.get('card-c4')?.name === 'B-won' && after === 1 && calls === 1 &&
        st.card.opByEntity.get('card-c4') === 'update',
      `reason=${st.card.failedReasons.get('card-c4')} calls=${calls}`,
    );
  }

  // C5 (§28.32–35) — DELETE forwards frozen token; success; transport; conflict reason
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c5', cardDraft());
    await h.coord.enqueueCardDelete({ scope: A, entityId: 'card-c5', expectedUpdatedAt: 'DEL-FROZEN' });
    await settle(8);
    check(
      'C5 card DELETE forwards frozen token; row gone; acked',
      h.cardDeleteLog.length === 1 && h.cardDeleteLog[0].expectedUpdatedAt === 'DEL-FROZEN' &&
        !h.cardServer.has('card-c5') && h.coord.getState().pendingCount === 0,
      JSON.stringify(h.cardDeleteLog[0]),
    );
  }
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c5c', cardDraft());
    h.setCardDelete(() => Promise.resolve(CD_CONFLICT));
    await h.coord.enqueueCardDelete({ scope: A, entityId: 'card-c5c', expectedUpdatedAt: 'V1' });
    await settle(6);
    const st = h.coord.getState();
    check(
      'C5c card DELETE conflict -> failed + reason=conflict, card still on server',
      st.card.failedIds.has('card-c5c') && st.card.failedReasons.get('card-c5c') === 'conflict' &&
        h.cardServer.has('card-c5c') && st.pendingCount === 1,
      `reason=${st.card.failedReasons.get('card-c5c')}`,
    );
  }
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c5t', cardDraft());
    h.setCardDelete(() => Promise.resolve(CD_TRANSPORT));
    const enq = await h.coord.enqueueCardDelete({ scope: A, entityId: 'card-c5t', expectedUpdatedAt: 'V1' });
    await settle();
    check(
      'C5t card DELETE transport -> pending delete op',
      enq.ok === true && h.coord.getState().card.opByEntity.get('card-c5t') === 'delete' &&
        h.coord.getState().card.pendingIds.has('card-c5t'),
      '',
    );
  }

  // C6 (§28.36) — CREATE ack: id exists but fields MISMATCH -> NOT acked (replays)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let applied = false;
    h.setCardCreate(async (args) => {
      h.cardCreateLog.push(args);
      await new Promise<void>((r) => setTimeout(r, 0));
      // server ends up with a DIFFERENT card for this id until `applied`
      h.cardServer.set(args.id, draftToCard(args.id, cardDraft({ name: applied ? args.draft.name : 'WRONG' })));
      return { ok: true, id: args.id };
    });
    await h.coord.enqueueCardCreate({ scope: A, entityId: 'card-c6', payload: cardDraft({ name: 'RIGHT' }) });
    await settle(8);
    const stalePending = h.coord.getState().pendingCount === 1;
    applied = true;
    h.coord.requestFlush();
    await settle(10);
    check(
      'C6 card CREATE ack requires FIELD match, not just id -> stale mismatch replays, then acks',
      stalePending && h.cardServer.get('card-c6')?.name === 'RIGHT' && h.coord.getState().pendingCount === 0,
      `stalePending=${stalePending} name=${h.cardServer.get('card-c6')?.name}`,
    );
  }

  // C7 (§28.38/39) — UPDATE ack: stale fields -> no ack; match -> ack
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c7', cardDraft({ name: 'v0' }));
    let applied = false;
    h.setCardUpdate(async (args) => {
      h.cardUpdateLog.push(args);
      await new Promise<void>((r) => setTimeout(r, 0));
      if (applied) h.cardServerPut(args.id, args.draft);
      return { ok: true, updatedAt: 'V2' };
    });
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c7', payload: cardDraft({ name: 'v9' }), expectedUpdatedAt: 'V1' });
    await settle(8);
    const stale = h.coord.getState().pendingCount === 1;
    applied = true;
    h.coord.requestFlush();
    await settle(10);
    check(
      'C7 card UPDATE ack: stale snapshot -> replays; acked once fields match',
      stale && h.cardServer.get('card-c7')?.name === 'v9' && h.coord.getState().pendingCount === 0,
      `stale=${stale}`,
    );
  }

  // C8 (§28.40/41) — DELETE ack: still active -> no ack; absent -> ack
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c8', cardDraft());
    let reallyDelete = false;
    h.setCardDelete(async (args) => {
      h.cardDeleteLog.push(args);
      await new Promise<void>((r) => setTimeout(r, 0));
      if (reallyDelete) h.cardServerDelete(args.id);
      return { ok: true };
    });
    await h.coord.enqueueCardDelete({ scope: A, entityId: 'card-c8', expectedUpdatedAt: 'V1' });
    await settle(8);
    const stillPending = h.coord.getState().pendingCount === 1;
    reallyDelete = true;
    h.coord.requestFlush();
    await settle(10);
    check(
      'C8 card DELETE ack: not acked while card still present; acked once absent',
      stillPending && !h.cardServer.has('card-c8') && h.coord.getState().pendingCount === 0,
      `stillPending=${stillPending}`,
    );
  }

  // C9 (§28.42) — untrusted remote -> no ack (queue retained)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c9', cardDraft({ name: 'old' }));
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c9', payload: cardDraft({ name: 'new' }), expectedUpdatedAt: 'V1' });
    // flush ran (updateLog) but make remote untrusted before the reconcile can ack
    h.setRemoteReady(false);
    await settle(8);
    check(
      'C9 card op settled but remote untrusted -> NOT acked, queue retained',
      h.cardUpdateLog.length >= 1 && h.coord.getState().pendingCount === 1,
      `updates=${h.cardUpdateLog.length} pending=${h.coord.getState().pendingCount}`,
    );
  }

  // C10 (§28.44–46) — scope isolation: A's pending card op invisible + not flushed under B; resumes under A
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c10', cardDraft());
    h.setCardUpdate(() => Promise.resolve(CU_TRANSPORT));
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c10', payload: cardDraft({ name: 'x' }), expectedUpdatedAt: 'V1' });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState();
    const beforeB = h.cardUpdateLog.length;
    h.setCardUpdate((args) => { h.cardUpdateLog.push(args); h.cardServerPut(args.id, args.draft); return Promise.resolve({ ok: true, updatedAt: 'V2' }); });
    h.coord.requestFlush();
    await settle(8);
    const ranUnderB = h.cardUpdateLog.slice(beforeB).some((u) => u.id === 'card-c10');
    h.setScope(A);
    const underA = h.coord.getState();
    check(
      'C10 card op scope-isolated: nothing under B, not flushed under B, resumes under A',
      underB.card.pendingIds.size === 0 && underB.pendingCount === 0 && ranUnderB === false &&
        underA.card.pendingIds.has('card-c10') && underA.card.opByEntity.get('card-c10') === 'update',
      `B.pending=${underB.pendingCount} ranUnderB=${ranUnderB}`,
    );
  }

  // C11 (§28.47/48) — restart hydrate restores pending + failed card op with reason
  {
    const seed = JSON.stringify([
      { queueId: 'q-r1', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'card', op: 'update',
        entityId: 'card-r1', payload: cardDraft({ name: 'restored' }), expectedUpdatedAt: 'V1',
        enqueuedAt: '2026-09-10T09:00:00.000Z', attemptCount: 0, lastError: 'conflict', lastErrorReason: 'conflict' },
      { queueId: 'q-r2', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'card', op: 'create',
        entityId: 'card-r2', payload: cardDraft(), enqueuedAt: '2026-09-10T09:00:00.000Z', attemptCount: 0 },
    ]);
    const h = makeHarness({ seed, remoteReady: false });
    await h.coord.hydrate();
    await settle();
    const st = h.coord.getState();
    check(
      'C11 restart -> pending card CREATE + terminal-failed card UPDATE(reason) restored',
      st.card.failedIds.has('card-r1') && st.card.failedReasons.get('card-r1') === 'conflict' &&
        st.card.opByEntity.get('card-r1') === 'update' &&
        st.card.pendingIds.has('card-r2') && st.card.opByEntity.get('card-r2') === 'create' &&
        st.pendingCount === 2,
      `r1reason=${st.card.failedReasons.get('card-r1')} pending=${st.pendingCount}`,
    );
  }

  // C12 (§28.49/50) — transport backoff scheduled; terminal not auto-retried
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.cardServerPut('card-c12', cardDraft());
    h.setCardUpdate(() => Promise.resolve(CU_TRANSPORT));
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'card-c12', payload: cardDraft({ name: 'x' }), expectedUpdatedAt: 'V1' });
    await settle();
    const t = h.timers.find((x) => !x.cancelled && x.ms === 5000);
    check('C12 card transport -> backoff scheduled at 5000ms', !!t, `timers=${JSON.stringify(h.timers.map((x) => x.ms))}`);
  }

  // C13 (§28.51) — pending identity collision: same id for a transaction AND a card cannot corrupt state
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut('dup-id', draft({ amount: 100 }));       // a transaction with id 'dup-id'
    h.cardServerPut('dup-id', cardDraft({ name: 'card' })); // a card ALSO with id 'dup-id'
    h.setUpdate(() => Promise.resolve(U_CONFLICT));       // transaction UPDATE -> terminal conflict
    h.setCardUpdate(() => Promise.resolve(CU_TRANSPORT)); // card UPDATE -> stays pending (transport)
    await h.coord.enqueueTransactionUpdate({ scope: A, entityId: 'dup-id', payload: draft({ amount: 9 }), expectedUpdatedAt: 'V1', originalRawCardId: null });
    await settle(6);
    await h.coord.enqueueCardUpdate({ scope: A, entityId: 'dup-id', payload: cardDraft({ name: 'edited' }), expectedUpdatedAt: 'V1' });
    await settle(4);
    const st = h.coord.getState();
    check(
      'C13 same id across entities: txn UPDATE failed, card UPDATE still pending — no cross-contamination',
      st.failedIds.has('dup-id') && st.failedReasons.get('dup-id') === 'conflict' &&
        st.opByEntity.get('dup-id') === 'update' &&
        st.card.pendingIds.has('dup-id') && st.card.failedIds.has('dup-id') === false &&
        st.card.opByEntity.get('dup-id') === 'update' &&
        st.pendingCount === 2,
      `txnFailed=${st.failedIds.has('dup-id')} cardFailed=${st.card.failedIds.has('dup-id')} pending=${st.pendingCount}`,
    );
  }

  // C14 (§28.52) — a card op in the queue does NOT change transaction-only getState views
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCardCreate(() => Promise.resolve(CC_TRANSPORT));
    h.setCreate(() => Promise.resolve(TRANSPORT));
    await h.coord.enqueueTransactionCreate({ scope: A, entityId: 'txn-c14', payload: draft() });
    await settle();
    await h.coord.enqueueCardCreate({ scope: A, entityId: 'card-c14', payload: cardDraft() });
    await settle();
    const st = h.coord.getState();
    check(
      'C14 transaction getState views unchanged by a queued card op; pendingCount counts BOTH',
      st.pendingIds.has('txn-c14') && st.pendingIds.size === 1 &&
        st.opByEntity.size === 1 && st.opByEntity.get('txn-c14') === 'create' &&
        st.card.pendingIds.has('card-c14') && st.card.pendingIds.size === 1 &&
        st.pendingCount === 2,
      `txnPending=${[...st.pendingIds]} cardPending=${[...st.card.pendingIds]} count=${st.pendingCount}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
