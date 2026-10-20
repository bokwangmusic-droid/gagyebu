/**
 * Static verification for /input's "already in the ledger?" check
 * (existingPayment.ts) and the 후보함 record it leaves (candidateAutoHandle.ts
 * / candidateInbox.ts). Same convention as the other *.cases.ts files: plain
 * data + a runner, never imported by the app.
 *
 * `inputSave` below walks /input's create branch (app/input.tsx save()) step
 * by step over a fake server that behaves like migration 20261019002300 and
 * the transactions primary key: a soft-deleted row still holds its id, and a
 * handled event is never re-linked. The Alert itself is real-device QA; here
 * the user's answer is a parameter.
 */
import {
  autoSavePaymentCandidate,
  paymentAutoSaveTransactionId,
  paymentCandidateTransactionId,
  PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED,
  runPaymentAutoSaveJobs,
  selectPaymentLinkJobs,
  applyPaymentAutoSaveOutcomes,
  type PaymentAutoSaveIO,
  type PaymentEventCompleteStatus,
} from '@/lib/paymentNotification/autoSave';
import { settleSourceCandidate, type CandidateStateIO } from '@/lib/paymentNotification/candidateAutoHandle';
import {
  markCandidatePending,
  markCandidateSavedAs,
  prunePaymentCandidateState,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import {
  checkExistingPayment,
  checkRefusedPaymentInsert,
  queuedTransactionLiveness,
  type ExistingPaymentIO,
  type PaymentTransactionLiveness,
  type QueuedTransactionOp,
} from '@/lib/paymentNotification/existingPayment';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const EVENT = '22222222-2222-4222-8222-222222222222';
const DERIVED = paymentAutoSaveTransactionId(EVENT)!;
const FP = 'pc1_abc123';

interface FakeTxn {
  householdId: string;
  deleted: boolean;
}

/** The server: one event, the transactions table, call counters. */
function fakeServer(init: {
  event: { status: 'pending' | 'handled'; linked: string | null } | null;
  txns?: Record<string, FakeTxn>;
  fail?: { getLink?: boolean; liveness?: boolean };
  /** This device's offline-queue op per transaction id (usePendingWrites). */
  queued?: Record<string, QueuedTransactionOp>;
}) {
  const event = init.event ? { ...init.event } : null;
  const txns: Record<string, FakeTxn> = { ...(init.txns ?? {}) };
  const calls = { getLink: 0, liveness: 0, confirm: 0, complete: 0, creates: [] as string[] };
  const queued = init.queued ?? {};

  const complete = (transactionId: string): PaymentEventCompleteStatus => {
    calls.complete += 1;
    if (!event) throw new Error('NOT_FOUND');
    if (event.status === 'handled') return event.linked === transactionId ? 'already_linked' : 'conflict';
    const t = txns[transactionId];
    // Soft-deleted rows count as existing (no deleted_at filter in the RPC).
    if (!t || t.householdId !== HH) return 'transaction_missing';
    event.status = 'handled';
    event.linked = transactionId;
    return 'linked';
  };
  const liveness = async (id: string): Promise<PaymentTransactionLiveness> => {
    calls.liveness += 1;
    // existingPaymentIO: the queue first, then the server row.
    const fromQueue = queuedTransactionLiveness(queued[id] ?? null);
    if (fromQueue) return fromQueue;
    if (init.fail?.liveness) return 'unknown';
    const t = txns[id];
    if (!t || t.householdId !== HH) return 'missing';
    return t.deleted ? 'deleted' : 'live';
  };
  const getLink: ExistingPaymentIO['getLink'] = async () => {
    calls.getLink += 1;
    if (init.fail?.getLink || !event) return { ok: false, transport: !!init.fail?.getLink };
    return { ok: true, status: event.status, transactionId: event.linked };
  };
  const io: ExistingPaymentIO = {
    getLink,
    liveness,
    confirm: async (_e, id) => {
      calls.confirm += 1;
      const s = complete(id);
      return s === 'linked' || s === 'already_linked' ? 'exists' : s === 'transaction_missing' ? 'missing' : 'unknown';
    },
  };
  const autoIO: PaymentAutoSaveIO = {
    getLink,
    create: async (id) => {
      calls.creates.push(id);
      if (txns[id]) return { ok: false, transport: false };
      txns[id] = { householdId: HH, deleted: false };
      return { ok: true, createdNow: true };
    },
    complete: async (_e, id) => ({ ok: true, status: complete(id) }),
  };
  /** createTransaction: the PK refuses any id already taken — deleted rows too. */
  const create = (id: string): 'ok' | 'refused' => {
    calls.creates.push(id);
    if (txns[id]) return 'refused';
    txns[id] = { householdId: HH, deleted: false };
    return 'ok';
  };
  return { event, txns, calls, io, autoIO, create };
}
type FakeServer = ReturnType<typeof fakeServer>;

/** AsyncStorage-like candidate store (JSON round trip). */
function memoryStore(initial: PaymentCandidateState) {
  let raw = JSON.stringify(initial);
  const io: CandidateStateIO = {
    load: async () => JSON.parse(raw) as unknown,
    save: async (state) => {
      raw = JSON.stringify(state);
    },
  };
  return {
    io,
    read: (): PaymentCandidateState => prunePaymentCandidateState(JSON.parse(raw), NOW),
    write: (s: PaymentCandidateState) => {
      raw = JSON.stringify(s);
    },
  };
}
type Store = ReturnType<typeof memoryStore>;

const registered = (extra: Record<string, unknown> = {}): PaymentCandidateState => ({
  [FP]: { registeredAt: NOW - 60_000, registeredHouseholdId: HH, registeredEventId: EVENT, sentAt: NOW - 1000, ...extra },
});

type SaveResult =
  | { result: 'exists' | 'saved'; transactionId: string; prompted: boolean }
  | { result: 'unknown' | 'cancelled' | 'failed'; prompted: boolean };

/** /input save(), create branch, from candidate FP (app/input.tsx). */
async function inputSave(srv: FakeServer, store: Store, answer: { reenter: boolean; newId: string }): Promise<SaveResult> {
  const state = store.read();
  const derived = paymentCandidateTransactionId(state, FP, HH);
  let transactionId = derived?.transactionId ?? 'txn-ordinary';
  let eventId = derived?.eventId ?? null;
  let link: 'linked' | 'pending' | 'never' | null = null;
  let prompted = false;
  const settle = (id: string, l: typeof link) =>
    settleSourceCandidate(store.io, FP, 'saved', NOW, { transactionId: id, householdId: HH, ...(l ? { link: l } : {}) });

  const entry = state[FP];
  const manualTxnId = entry?.manualTxnId && entry.manualHouseholdId === HH ? entry.manualTxnId : null;
  const verdict = await checkExistingPayment({ manualTxnId, eventId }, srv.io);
  if (verdict.kind === 'exists') {
    await settle(verdict.transactionId, verdict.link);
    return { result: 'exists', transactionId: verdict.transactionId, prompted };
  }
  if (verdict.kind === 'unknown') return { result: 'unknown', prompted };
  if (verdict.kind === 'stale') {
    prompted = true;
    if (!answer.reenter) return { result: 'cancelled', prompted };
    link = verdict.link;
    transactionId = answer.newId;
    eventId = null;
  }

  for (;;) {
    if (srv.create(transactionId) === 'ok') {
      await settle(transactionId, link);
      return { result: 'saved', transactionId, prompted };
    }
    if (!eventId) return { result: 'failed', prompted };
    const refused = await checkRefusedPaymentInsert(eventId, transactionId, srv.io);
    if (refused.kind === 'exists') {
      await settle(refused.transactionId, refused.link);
      return { result: 'exists', transactionId: refused.transactionId, prompted };
    }
    if (refused.kind === 'unknown') return { result: 'unknown', prompted };
    if (refused.kind === 'failed') return { result: 'failed', prompted };
    prompted = true;
    if (!answer.reenter) return { result: 'cancelled', prompted };
    link = refused.link;
    transactionId = answer.newId;
    eventId = null;
  }
}

/** The shared pass's link step (processor.ts step 2) over the stored state. */
async function runLinks(srv: FakeServer, store: Store) {
  const jobs = selectPaymentLinkJobs(store.read(), HH);
  const out = await runPaymentAutoSaveJobs(jobs, [], srv.autoIO, NOW);
  if (out.length > 0) store.write(applyPaymentAutoSaveOutcomes(store.read(), out, NOW));
  return { jobs: jobs.length, out };
}

export async function runExistingPaymentCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const NO = { reenter: false, newId: 'txn-new-1' };
  const YES = { reenter: true, newId: 'txn-new-1' };

  // CASE 1 — handled, linked transaction alive.
  {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, txns: { [DERIVED]: { householdId: HH, deleted: false } } });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    const e = store.read()[FP];
    const links = await runLinks(srv, store);
    check(
      'CASE 1 handled + linked alive → already, create 0, manualTxnId = linked id, handled, nothing left to link',
      r.result === 'exists' && !r.prompted && srv.calls.creates.length === 0 &&
        e.manualTxnId === DERIVED && e.handledAt != null && e.manualLinkedAt != null && links.jobs === 0,
      JSON.stringify({ r, e, links }),
    );
  }

  // CASE 2 — handled, linked transaction soft-deleted → ask; 취소 keeps everything.
  {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, txns: { [DERIVED]: { householdId: HH, deleted: true } } });
    const store = memoryStore(registered());
    const before = JSON.stringify(store.read());
    const r = await inputSave(srv, store, NO);
    check(
      'CASE 2 handled + linked soft-deleted → not "already": the user is asked; 취소 → create 0, candidate stays pending, state unchanged',
      r.result === 'cancelled' && r.prompted && srv.calls.creates.length === 0 &&
        store.read()[FP].handledAt == null && JSON.stringify(store.read()) === before,
      JSON.stringify(r),
    );
  }

  // CASE 3 — CASE 2, then 다시 입력.
  {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, txns: { [DERIVED]: { householdId: HH, deleted: true } } });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, YES);
    const links = await runLinks(srv, store);
    const e = store.read()[FP];
    check(
      'CASE 3 다시 입력 → one create with a NEW ordinary id (not txn-pn-), no complete/link at all, manualTxnId = new id, handled',
      r.result === 'saved' && r.transactionId === 'txn-new-1' &&
        JSON.stringify(srv.calls.creates) === '["txn-new-1"]' && !srv.calls.creates[0].startsWith('txn-pn-') &&
        srv.calls.complete === 0 && srv.calls.confirm === 0 && links.jobs === 0 &&
        e.manualTxnId === 'txn-new-1' && e.manualSavedAt != null && e.handledAt != null &&
        srv.event!.linked === DERIVED,
      JSON.stringify({ r, calls: srv.calls, e }),
    );
  }

  // CASE 4 — handled, the row is gone (household reset hard-delete) / another household's.
  for (const [label, txns] of [
    ['no row', {}],
    ['another household', { [DERIVED]: { householdId: OTHER_HH, deleted: false } }],
  ] as const) {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, txns });
    const store = memoryStore(registered());
    const asked = await inputSave(srv, store, NO);
    const pendingAfterAsk = store.read()[FP].handledAt == null;
    const r = await inputSave(srv, store, YES);
    check(
      `CASE 4 handled + ${label} → like CASE 2 (asked, nothing recorded) and CASE 3 (new id, no link)`,
      asked.result === 'cancelled' && asked.prompted && pendingAfterAsk &&
        r.result === 'saved' && r.transactionId === 'txn-new-1' && srv.calls.complete === 0 &&
        store.read()[FP].manualTxnId === 'txn-new-1',
      JSON.stringify({ asked, r, calls: srv.calls }),
    );
  }

  // CASE 5 — linked to an ordinary id, not the derived one.
  {
    const ORD = 'txn-1790000000000-abcd';
    const srv = fakeServer({
      event: { status: 'handled', linked: ORD },
      txns: { [ORD]: { householdId: HH, deleted: false }, [DERIVED]: { householdId: HH, deleted: true } },
    });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    const links = await runLinks(srv, store);
    const e = store.read()[FP];
    check(
      'CASE 5 linked_transaction_id is an ordinary id → that id is used and recorded (never txn-pn-<event>), no conflict link',
      r.result === 'exists' && r.transactionId === ORD && e.manualTxnId === ORD &&
        srv.calls.creates.length === 0 && links.jobs === 0 && e.linkConflictAt == null,
      JSON.stringify({ r, e }),
    );
  }

  // CASE 6 / 7 — re-entered, then opened again (확인 대기로 되돌리기).
  {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, txns: { [DERIVED]: { householdId: HH, deleted: true } } });
    const store = memoryStore(registered());
    await inputSave(srv, store, YES);
    store.write(markCandidatePending(store.read(), FP));
    const getLinkBefore = srv.calls.getLink;
    const r = await inputSave(srv, store, YES);
    check(
      'CASE 6 re-entered transaction alive → already (the stale event pointing at the deleted one is not even asked), no second create',
      r.result === 'exists' && r.transactionId === 'txn-new-1' && !r.prompted &&
        JSON.stringify(srv.calls.creates) === '["txn-new-1"]' && srv.calls.getLink === getLinkBefore &&
        store.read()[FP].manualTxnId === 'txn-new-1' && store.read()[FP].handledAt != null,
      JSON.stringify({ r, calls: srv.calls }),
    );

    srv.txns['txn-new-1'].deleted = true;
    store.write(markCandidatePending(store.read(), FP));
    const cancelled = await inputSave(srv, store, NO);
    const r2 = await inputSave(srv, store, { reenter: true, newId: 'txn-new-2' });
    check(
      'CASE 7 the re-entered one deleted too → asked again; 다시 입력 → another new id, recorded, still no link',
      cancelled.result === 'cancelled' && cancelled.prompted &&
        r2.result === 'saved' && r2.transactionId === 'txn-new-2' &&
        store.read()[FP].manualTxnId === 'txn-new-2' && srv.calls.complete === 0,
      JSON.stringify({ cancelled, r2, calls: srv.calls }),
    );
  }

  // CASE 8 — the linked transaction cannot be read.
  {
    const srv = fakeServer({
      event: { status: 'handled', linked: DERIVED },
      txns: { [DERIVED]: { householdId: HH, deleted: true } },
      fail: { liveness: true },
    });
    const store = memoryStore(registered());
    const before = JSON.stringify(store.read());
    const r = await inputSave(srv, store, YES);
    check(
      'CASE 8 handled + transaction read fails → unknown: create 0, not asked, candidate pending, state unchanged',
      r.result === 'unknown' && !r.prompted && srv.calls.creates.length === 0 && JSON.stringify(store.read()) === before,
      JSON.stringify(r),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, fail: { getLink: true } });
    const store = memoryStore(registered({ manualTxnId: 'txn-old', manualHouseholdId: HH, manualSavedAt: NOW - 5000 }));
    const r = await inputSave(srv, store, YES);
    check(
      'CASE 8b saved before (record deleted/gone) + event unreadable → unknown, create 0 (never re-entered blind)',
      r.result === 'unknown' && srv.calls.creates.length === 0,
      JSON.stringify(r),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null }, fail: { liveness: true } });
    const store = memoryStore(registered({ manualTxnId: 'txn-new-1', manualHouseholdId: HH, manualSavedAt: NOW - 5000 }));
    const before = JSON.stringify(store.read());
    const r = await inputSave(srv, store, YES);
    check(
      'CASE 8d own record unreadable → unknown (not taken as deleted): create 0, not asked, state unchanged',
      r.result === 'unknown' && !r.prompted && srv.calls.creates.length === 0 && JSON.stringify(store.read()) === before,
      JSON.stringify(r),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null }, fail: { getLink: true } });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    check(
      'CASE 8c first save + event unreadable (offline) → saves as before with the derived id (the PK is the dedup)',
      r.result === 'saved' && r.transactionId === DERIVED && !r.prompted,
      JSON.stringify(r),
    );
  }

  // CASE 9 — a pending event: the existing derived-id flow.
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null } });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    const e1 = store.read()[FP];
    const links = await runLinks(srv, store);
    check(
      'CASE 9 pending event → create txn-pn-<event> once, recorded first-record-wins, linked by the shared pass',
      r.result === 'saved' && r.transactionId === DERIVED && JSON.stringify(srv.calls.creates) === JSON.stringify([DERIVED]) &&
        e1.manualTxnId === DERIVED && e1.manualLinkedAt == null && links.jobs === 1 &&
        srv.event!.status === 'handled' && srv.event!.linked === DERIVED && store.read()[FP].manualLinkedAt != null,
      JSON.stringify({ r, links }),
    );
  }
  {
    const store = memoryStore({});
    const srv = fakeServer({ event: null });
    const r = await inputSave(srv, store, NO);
    check(
      'CASE 9b not registered, no record → no server check at all, ordinary id as before',
      r.result === 'saved' && r.transactionId === 'txn-ordinary' && srv.calls.getLink === 0 && srv.calls.liveness === 0,
      JSON.stringify({ r, calls: srv.calls }),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null }, queued: { [DERIVED]: { op: 'create', failed: false } } });
    const store = memoryStore(registered({ manualTxnId: DERIVED, manualHouseholdId: HH, manualSavedAt: NOW - 5000 }));
    const r = await inputSave(srv, store, YES);
    check(
      'CASE 9c own record still waiting in the offline queue as a create → alive: already, no second create',
      r.result === 'exists' && r.transactionId === DERIVED && srv.calls.creates.length === 0,
      JSON.stringify(r),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null }, txns: { 'txn-old': { householdId: HH, deleted: true } } });
    const store = memoryStore(registered({ manualTxnId: 'txn-old', manualHouseholdId: HH, manualSavedAt: NOW - 5000 }));
    const r = await inputSave(srv, store, YES);
    const links = await runLinks(srv, store);
    check(
      'CASE 9d saved before + deleted, event still pending → asked; 다시 입력 → new id, linked to the pending event later',
      r.result === 'saved' && r.prompted && r.transactionId === 'txn-new-1' &&
        links.jobs === 1 && srv.event!.linked === 'txn-new-1' && store.read()[FP].manualLinkedAt != null,
      JSON.stringify({ r, links, event: srv.event }),
    );
  }

  // The second "exists" path: the derived-id insert was refused.
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null }, txns: { [DERIVED]: { householdId: HH, deleted: true } } });
    const store = memoryStore(registered());
    const asked = await inputSave(srv, store, NO);
    const confirmAfterAsk = srv.calls.confirm;
    const pendingAfterAsk = store.read()[FP].handledAt == null;
    const r = await inputSave(srv, store, YES);
    check(
      'REFUSED 1 insert refused, derived row soft-deleted → never linked to it; asked; 다시 입력 → new id, no link',
      asked.result === 'cancelled' && asked.prompted && confirmAfterAsk === 0 && srv.event!.status === 'pending' &&
        pendingAfterAsk &&
        r.result === 'saved' && r.transactionId === 'txn-new-1' && srv.calls.complete === 0,
      JSON.stringify({ asked, r, calls: srv.calls, event: srv.event }),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null }, txns: { [DERIVED]: { householdId: HH, deleted: false } } });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    const e = store.read()[FP];
    check(
      'REFUSED 2 insert refused, derived row alive (saved first elsewhere) → linked now, already, recorded with it',
      r.result === 'exists' && r.transactionId === DERIVED && srv.calls.confirm === 1 &&
        srv.event!.linked === DERIVED && e.manualTxnId === DERIVED && e.manualLinkedAt != null,
      JSON.stringify({ r, e }),
    );
  }
  {
    const srv = fakeServer({ event: { status: 'pending', linked: null } });
    const out = await checkRefusedPaymentInsert(EVENT, DERIVED, srv.io);
    const srvU = fakeServer({ event: { status: 'pending', linked: null }, fail: { liveness: true } });
    const outU = await checkRefusedPaymentInsert(EVENT, DERIVED, srvU.io);
    check(
      'REFUSED 3 refused for another reason (no such row) → failed (the form message); unreadable → unknown; no link tried',
      out.kind === 'failed' && outU.kind === 'unknown' && srv.calls.confirm === 0 && srvU.calls.confirm === 0,
      JSON.stringify({ out, outU }),
    );
  }

  // QUEUE — this device's offline queue, before the server row.
  check(
    'QUEUE 0 queuedTransactionLiveness: create (pending / held) alive, pending delete deleted, failed delete / update / none → server decides',
    queuedTransactionLiveness({ op: 'create', failed: false }) === 'live' &&
      queuedTransactionLiveness({ op: 'create', failed: true }) === 'live' &&
      queuedTransactionLiveness({ op: 'delete', failed: false }) === 'deleted' &&
      queuedTransactionLiveness({ op: 'delete', failed: true }) === null &&
      queuedTransactionLiveness({ op: 'update', failed: false }) === null &&
      queuedTransactionLiveness({ op: 'update', failed: true }) === null &&
      queuedTransactionLiveness(null) === null,
  );
  {
    // A. linked transaction alive on the server, its DELETE pending here.
    const srv = fakeServer({
      event: { status: 'handled', linked: DERIVED },
      txns: { [DERIVED]: { householdId: HH, deleted: false } },
      queued: { [DERIVED]: { op: 'delete', failed: false } },
    });
    const store = memoryStore(registered());
    const before = JSON.stringify(store.read());
    const asked = await inputSave(srv, store, NO);
    const unchanged = JSON.stringify(store.read()) === before;
    const r = await inputSave(srv, store, YES);
    check(
      'QUEUE A linked alive on the server + pending DELETE here → not "already": asked (nothing recorded); 다시 입력 → new id, no link',
      asked.result === 'cancelled' && asked.prompted && unchanged &&
        r.result === 'saved' && r.transactionId === 'txn-new-1' && srv.calls.complete === 0 &&
        JSON.stringify(srv.calls.creates) === '["txn-new-1"]' && store.read()[FP].manualTxnId === 'txn-new-1',
      JSON.stringify({ asked, r, calls: srv.calls }),
    );
  }
  {
    // B. the candidate's own record alive on the server, its DELETE pending here.
    const srv = fakeServer({
      event: { status: 'handled', linked: DERIVED },
      txns: { [DERIVED]: { householdId: HH, deleted: true }, 'txn-new-1': { householdId: HH, deleted: false } },
      queued: { 'txn-new-1': { op: 'delete', failed: false } },
    });
    const store = memoryStore(registered({ handledAt: NOW - 5000, manualTxnId: 'txn-new-1', manualHouseholdId: HH, manualSavedAt: NOW - 5000, manualLinkFailedAt: NOW - 5000 }));
    store.write(markCandidatePending(store.read(), FP));
    const r = await inputSave(srv, store, { reenter: true, newId: 'txn-new-2' });
    check(
      'QUEUE B own manualTxnId alive on the server + pending DELETE here → not "already": asked; 다시 입력 → another new id',
      r.result === 'saved' && r.prompted && r.transactionId === 'txn-new-2' &&
        JSON.stringify(srv.calls.creates) === '["txn-new-2"]' && store.read()[FP].manualTxnId === 'txn-new-2' &&
        srv.calls.complete === 0,
      JSON.stringify({ r, calls: srv.calls }),
    );
  }
  {
    // C. only a CREATE queued (pending, and held after a terminal failure).
    for (const failed of [false, true]) {
      const srv = fakeServer({
        event: { status: 'pending', linked: null },
        queued: { [DERIVED]: { op: 'create', failed } },
      });
      const store = memoryStore(registered({ handledAt: NOW - 5000, manualTxnId: DERIVED, manualHouseholdId: HH, manualSavedAt: NOW - 5000 }));
      store.write(markCandidatePending(store.read(), FP));
      const r = await inputSave(srv, store, YES);
      const links = await runLinks(srv, store);
      check(
        `QUEUE C only a ${failed ? 'held (terminal-failed)' : 'pending'} CREATE → alive as before: already, no second create, link left pending (not refused)`,
        r.result === 'exists' && r.transactionId === DERIVED && !r.prompted && srv.calls.creates.length === 0 &&
          store.read()[FP].manualLinkFailedAt == null && links.out.every((o) => o.kind === 'link' && o.result === 'pending'),
        JSON.stringify({ r, links }),
      );
    }
  }
  {
    // D. alive, nothing queued — and an UPDATE queued does not change that.
    for (const queued of [undefined, { [DERIVED]: { op: 'update' as const, failed: false } }]) {
      const srv = fakeServer({
        event: { status: 'handled', linked: DERIVED },
        txns: { [DERIVED]: { householdId: HH, deleted: false } },
        ...(queued ? { queued } : {}),
      });
      const store = memoryStore(registered());
      const r = await inputSave(srv, store, YES);
      check(
        `QUEUE D alive on the server${queued ? ' + pending UPDATE' : ', nothing queued'} → already as before, create 0`,
        r.result === 'exists' && r.transactionId === DERIVED && !r.prompted && srv.calls.creates.length === 0 &&
          store.read()[FP].manualTxnId === DERIVED,
        JSON.stringify(r),
      );
    }
  }
  {
    // E. the DELETE hit a terminal failure: held, the server row stays visible
    // ("삭제 전송 실패") — the server row decides, as the ledger shows it.
    const alive = fakeServer({
      event: { status: 'handled', linked: DERIVED },
      txns: { [DERIVED]: { householdId: HH, deleted: false } },
      queued: { [DERIVED]: { op: 'delete', failed: true } },
    });
    const ra = await inputSave(alive, memoryStore(registered()), YES);
    const gone = fakeServer({
      event: { status: 'handled', linked: DERIVED },
      txns: { [DERIVED]: { householdId: HH, deleted: true } },
      queued: { [DERIVED]: { op: 'delete', failed: true } },
    });
    const rg = await inputSave(gone, memoryStore(registered()), NO);
    const unread = fakeServer({
      event: { status: 'handled', linked: DERIVED },
      queued: { [DERIVED]: { op: 'delete', failed: true } },
      fail: { liveness: true },
    });
    const ru = await inputSave(unread, memoryStore(registered()), YES);
    check(
      'QUEUE E terminal-failed DELETE → the server row decides: alive → already (row still in the ledger); deleted → asked; unreadable → unknown',
      ra.result === 'exists' && alive.calls.creates.length === 0 &&
        rg.result === 'cancelled' && rg.prompted &&
        ru.result === 'unknown' && unread.calls.creates.length === 0,
      JSON.stringify({ ra, rg, ru }),
    );
  }
  {
    // Refused-insert path: the derived row alive on the server, DELETE pending here.
    const srv = fakeServer({
      event: { status: 'pending', linked: null },
      txns: { [DERIVED]: { householdId: HH, deleted: false } },
      queued: { [DERIVED]: { op: 'delete', failed: false } },
    });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    check(
      'QUEUE F refused insert, derived row alive but DELETE pending here → not linked, not "already": asked',
      r.result === 'cancelled' && r.prompted && srv.calls.confirm === 0 && srv.event!.status === 'pending',
      JSON.stringify({ r, calls: srv.calls }),
    );
  }

  // CASE 10 — the automatic save keeps its policy, and stays off.
  {
    const srv = fakeServer({ event: { status: 'handled', linked: DERIVED }, txns: { [DERIVED]: { householdId: HH, deleted: true } } });
    const item = { fingerprint: FP, candidate: { amount: 28_400, merchantCandidate: '쿠팡', occurredAt: NOW } } as unknown as PaymentInboxItem;
    const o = await autoSavePaymentCandidate(item, EVENT, srv.autoIO);
    check(
      'CASE 10 automatic save: handled event (deleted transaction) → already, never re-created; gate still OFF',
      o.kind === 'already' && srv.calls.creates.length === 0 && PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED === false,
      JSON.stringify(o),
    );
  }

  // The record helper itself.
  {
    const base = registered({
      handledAt: NOW - 9000,
      manualTxnId: DERIVED,
      manualHouseholdId: HH,
      manualSavedAt: NOW - 9000,
      manualLinkedAt: NOW - 8000,
      refundTxnId: 'txn-x',
      refundedAt: NOW - 7000,
    });
    const never = prunePaymentCandidateState(JSON.parse(JSON.stringify(markCandidateSavedAs(base, FP, 'txn-new', HH, NOW, 'never'))), NOW)[FP];
    const linked = markCandidateSavedAs(base, FP, 'txn-new', HH, NOW, 'linked')[FP];
    const pend = markCandidateSavedAs(base, FP, 'txn-new', HH, NOW, 'pending')[FP];
    check(
      'STATE markCandidateSavedAs replaces the record, keeps handledAt / other fields, sets the link state, survives prune',
      never.manualTxnId === 'txn-new' && never.manualSavedAt === NOW && never.handledAt === NOW - 9000 &&
        never.manualLinkFailedAt === NOW && never.manualLinkedAt == null && never.refundTxnId === 'txn-x' &&
        never.registeredEventId === EVENT &&
        linked.manualLinkedAt === NOW && linked.manualLinkFailedAt == null &&
        pend.manualLinkedAt == null && pend.manualLinkFailedAt == null,
      JSON.stringify({ never, linked, pend }),
    );
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
