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
  PAYMENT_MANUAL_LINK_MAX_AGE_MS,
  PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED,
  runPaymentAutoSaveJobs,
  selectPaymentLinkJobs,
  applyPaymentAutoSaveOutcomes,
  type PaymentAutoSaveIO,
  type PaymentEventCompleteStatus,
} from '@/lib/paymentNotification/autoSave';
import {
  createdSaveOutcome,
  settleSourceCandidate,
  type CandidateStateIO,
  type CreateSaveOutcome,
} from '@/lib/paymentNotification/candidateAutoHandle';
import {
  clearOrphanedManualSave,
  markCandidatePending,
  markCandidateSavedAs,
  prunePaymentCandidateState,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import {
  checkExistingPayment,
  checkRefusedPaymentInsert,
  findOrphanedManualSaves,
  queuedTransactionLiveness,
  type ExistingPaymentIO,
  type PaymentTransactionLiveness,
  type QueuedTransactionOp,
} from '@/lib/paymentNotification/existingPayment';
import { buildTransactionInsert, type TransactionInsertRow } from '@/lib/remoteFinanceWriteMapping';
import { isReconcilableCreate } from '@/services/remoteFinanceWrite';

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
  /** The stored row (created_by USER) when a case needs createTransaction's 23505 reconcile; unset = never the same request. */
  row?: TransactionInsertRow;
}

const USER = 'user-1';
/** The draft every inputSave sends (the same request each time). */
const DRAFT = { type: 'expense', category: 'food', amount: 5100, memo: '청계상회', date: '2026-11-09T03:04:05.000Z' } as const;
const draftRow = (id: string) => buildTransactionInsert(DRAFT, { id, householdId: HH, knownCardIds: new Set() });

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
    queued: (id) => queued[id] ?? null,
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
  /**
   * createTransaction: the PK refuses any id already taken — deleted rows
   * too; the 23505 then reconciles only by the real isReconcilableCreate
   * (same request, same creator, alive).
   */
  const create = (id: string, row: TransactionInsertRow = draftRow(id)): 'ok' | 'reconciled' | 'refused' => {
    calls.creates.push(id);
    const t = txns[id];
    if (t) {
      const stored = t.row && { ...t.row, created_by: USER, deleted_at: t.deleted ? '2026-11-09T05:00:00.000Z' : null };
      return stored && t.householdId === HH && isReconcilableCreate(stored, row, USER) ? 'reconciled' : 'refused';
    }
    txns[id] = { householdId: HH, deleted: false, row };
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
  | { result: 'queued' | 'queued-failed'; transactionId: string; prompted: boolean }
  | { result: 'unknown' | 'cancelled' | 'failed'; prompted: boolean };

/** /input save(), create branch, from candidate FP (app/input.tsx). */
async function inputSave(srv: FakeServer, store: Store, answer: { reenter: boolean; newId: string }): Promise<SaveResult> {
  const state = store.read();
  const derived = paymentCandidateTransactionId(state, FP, HH);
  let transactionId = derived?.transactionId ?? 'txn-ordinary';
  let eventId = derived?.eventId ?? null;
  let link: 'linked' | 'pending' | 'never' | null = null;
  let prompted = false;
  const settle = (id: string, l: typeof link, outcome: CreateSaveOutcome = 'saved') =>
    settleSourceCandidate(store.io, FP, outcome, NOW, { transactionId: id, householdId: HH, ...(l ? { link: l } : {}) });

  const entry = state[FP];
  const manualTxnId = entry?.manualTxnId && entry.manualHouseholdId === HH ? entry.manualTxnId : null;
  const verdict = await checkExistingPayment({ manualTxnId, eventId }, srv.io);
  if (verdict.kind === 'exists') {
    await settle(verdict.transactionId, verdict.link);
    return { result: 'exists', transactionId: verdict.transactionId, prompted };
  }
  if (verdict.kind === 'queued') {
    if (verdict.failed) return { result: 'queued-failed', transactionId: verdict.transactionId, prompted };
    await settle(verdict.transactionId, null, 'queued');
    return { result: 'queued', transactionId: verdict.transactionId, prompted };
  }
  if (verdict.kind === 'unknown') return { result: 'unknown', prompted };
  if (verdict.kind === 'stale') {
    if (verdict.orphaned) store.write(clearOrphanedManualSave(store.read(), FP, verdict.orphaned, HH));
    prompted = true;
    if (!answer.reenter) return { result: 'cancelled', prompted };
    link = verdict.link;
    transactionId = answer.newId;
    eventId = null;
  }

  for (;;) {
    const created = srv.create(transactionId);
    if (created !== 'refused') {
      // res.ok: a reconciled create is read back before the candidate is marked.
      const liveness = created === 'reconciled' ? await srv.io.liveness(transactionId) : null;
      if (liveness === 'deleted' || liveness === 'missing') return { result: 'failed', prompted };
      await settle(transactionId, link, createdSaveOutcome(created === 'reconciled', liveness));
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
      'CASE 9c own record still waiting in the offline queue as a create → queued (not "already"), no second create',
      r.result === 'queued' && r.transactionId === DERIVED && srv.calls.creates.length === 0,
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

  // RETRY — the derived id's row is soft-deleted AND field-for-field this
  // very request (the worst case: its 23505 used to reconcile as saved).
  // The event is still pending (never linked), so the check before the
  // insert says `new` and the derived id is tried.
  {
    const srv = fakeServer({
      event: { status: 'pending', linked: null },
      txns: { [DERIVED]: { householdId: HH, deleted: true, row: draftRow(DERIVED) } },
    });
    const store = memoryStore(registered());
    const first = await inputSave(srv, store, NO);
    const e1 = store.read()[FP];
    check(
      'RETRY-1 pending event + soft-deleted txn-pn row of the same request → not reconciled as saved; asked; candidate pending, nothing recorded, row stays deleted, event not linked',
      first.result === 'cancelled' && first.prompted &&
        JSON.stringify(srv.calls.creates) === JSON.stringify([DERIVED]) &&
        e1.handledAt == null && e1.manualTxnId == null &&
        srv.txns[DERIVED].deleted && srv.event!.status === 'pending' && srv.calls.complete === 0,
      JSON.stringify({ first, calls: srv.calls, e1, event: srv.event }),
    );

    const second = await inputSave(srv, store, YES);
    const links = await runLinks(srv, store);
    const e2 = store.read()[FP];
    check(
      'RETRY-2 saved again → derived id refused again (never reconciled), 다시 입력 → NEW ordinary id created live; only then handled with it; no link, derived row still deleted',
      second.result === 'saved' && second.transactionId === 'txn-new-1' && !second.transactionId.startsWith('txn-pn-') &&
        JSON.stringify(srv.calls.creates) === JSON.stringify([DERIVED, DERIVED, 'txn-new-1']) &&
        srv.txns['txn-new-1']?.deleted === false &&
        e2.handledAt != null && e2.manualTxnId === 'txn-new-1' && e2.manualLinkFailedAt != null &&
        links.jobs === 0 && srv.calls.complete === 0 && srv.event!.status === 'pending' && srv.txns[DERIVED].deleted,
      JSON.stringify({ second, calls: srv.calls, e2, event: srv.event }),
    );

    // Opened once more (확인 대기로 되돌리기): the re-entered row is found, no third create.
    store.write(markCandidatePending(store.read(), FP));
    const third = await inputSave(srv, store, YES);
    check(
      'RETRY-2b after the re-entry, a further save → already (its own live row), no new create',
      third.result === 'exists' && third.transactionId === 'txn-new-1' && srv.calls.creates.length === 3,
      JSON.stringify({ third, calls: srv.calls }),
    );
  }

  // RETRY-0 — the dedup that stays: the derived row is ALIVE and this very
  // request (an earlier attempt landed, its reply lost) → reconciled, read
  // back live, handled with the derived id; nobody is asked, nothing re-entered.
  {
    const srv = fakeServer({
      event: { status: 'pending', linked: null },
      txns: { [DERIVED]: { householdId: HH, deleted: false, row: draftRow(DERIVED) } },
    });
    const store = memoryStore(registered());
    const r = await inputSave(srv, store, NO);
    const links = await runLinks(srv, store);
    const e = store.read()[FP];
    check(
      'RETRY-0 lost response: derived row alive + same request → reconciled, read back live, handled with txn-pn id, linked later',
      r.result === 'saved' && r.transactionId === DERIVED && !r.prompted &&
        JSON.stringify(srv.calls.creates) === JSON.stringify([DERIVED]) &&
        e.handledAt != null && e.manualTxnId === DERIVED && links.jobs === 1 && srv.event!.linked === DERIVED,
      JSON.stringify({ r, calls: srv.calls, e, links }),
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
        `QUEUE C only a ${failed ? 'held (terminal-failed)' : 'pending'} CREATE → ${failed ? 'queued-failed: left 확인 대기' : 'queued: 처리 완료 as at enqueue'}, never "already", no second create, link left pending (not refused)`,
        r.result === (failed ? 'queued-failed' : 'queued') && r.transactionId === DERIVED && !r.prompted &&
          srv.calls.creates.length === 0 &&
          (failed ? store.read()[FP].handledAt == null : store.read()[FP].handledAt != null) &&
          store.read()[FP].manualTxnId === DERIVED &&
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

  // BUG — "이미 저장됨" only for a transaction really in this household's
  // ledger; a 처리 완료 whose manual save is not there at all goes back to
  // 확인 대기 (findOrphanedManualSaves / clearOrphanedManualSave).
  const manual = (txn: string, extra: Record<string, unknown> = {}): PaymentCandidateState => ({
    // As on the device where registration never landed: no server event.
    [FP]: { sentAt: NOW - 9000, handledAt: NOW - 8000, manualTxnId: txn, manualHouseholdId: HH, manualSavedAt: NOW - 8000, ...extra },
  });
  /** The 후보함 focus check over a fake server (+ this device's queue). */
  const orphansOf = (srv: FakeServer, state: PaymentCandidateState, queued: Record<string, QueuedTransactionOp> = {}) =>
    findOrphanedManualSaves(state, HH, {
      queued: (id) => queued[id] ?? null,
      serverLiveness: async (id) => {
        const t = srv.txns[id];
        if (!t || t.householdId !== HH) return 'missing';
        return t.deleted ? 'deleted' : 'live';
      },
    });
  {
    const srv = fakeServer({ event: null });
    const store = memoryStore(manual('txn-gone'));
    const asked = await inputSave(srv, store, NO);
    const afterAsk = store.read()[FP];
    const r = await inputSave(srv, store, YES);
    const e = store.read()[FP];
    check(
      'BUG-1 manualTxnId + handledAt but no transaction → not "already": back to 확인 대기 (record dropped), asked; 다시 입력 → one new create, handled with it',
      asked.result === 'cancelled' && asked.prompted &&
        afterAsk.handledAt == null && afterAsk.manualTxnId == null && afterAsk.manualSavedAt == null && afterAsk.sentAt === NOW - 9000 &&
        r.result === 'saved' && r.transactionId === 'txn-ordinary' && !r.prompted &&
        JSON.stringify(srv.calls.creates) === '["txn-ordinary"]' &&
        e.handledAt != null && e.manualTxnId === 'txn-ordinary',
      JSON.stringify({ asked, afterAsk, r, e }),
    );
  }
  {
    const srv = fakeServer({ event: null, txns: { 'txn-live': { householdId: HH, deleted: false } } });
    const store = memoryStore(manual('txn-live'));
    const r = await inputSave(srv, store, YES);
    const orphans = await orphansOf(srv, store.read());
    check(
      'BUG-2 manualTxnId alive in this household → "already" as before, create 0, candidate kept; not an orphan',
      r.result === 'exists' && r.transactionId === 'txn-live' && !r.prompted && srv.calls.creates.length === 0 &&
        store.read()[FP].handledAt != null && orphans.length === 0,
      JSON.stringify({ r, orphans }),
    );
  }
  {
    const srv = fakeServer({ event: null, txns: { 'txn-del': { householdId: HH, deleted: true } } });
    const store = memoryStore(manual('txn-del'));
    const before = JSON.stringify(store.read());
    const asked = await inputSave(srv, store, NO);
    const orphans = await orphansOf(srv, store.read());
    check(
      'BUG-3 manualTxnId soft-deleted → not "already": asked (re-entry as before); 취소 keeps the record; not cleared as an orphan',
      asked.result === 'cancelled' && asked.prompted && srv.calls.creates.length === 0 &&
        JSON.stringify(store.read()) === before && orphans.length === 0,
      JSON.stringify({ asked, orphans }),
    );
  }
  {
    // The same id alive only in ANOTHER household.
    const srv = fakeServer({ event: null, txns: { 'txn-x': { householdId: OTHER_HH, deleted: false } } });
    const store = memoryStore(manual('txn-x'));
    const r = await inputSave(srv, store, NO);
    // A record made in the other household is not this household's to judge.
    const otherRecord = manual('txn-x', { manualHouseholdId: OTHER_HH });
    const srv2 = fakeServer({ event: null, txns: { 'txn-x': { householdId: OTHER_HH, deleted: false } } });
    const store2 = memoryStore(otherRecord);
    const r2 = await inputSave(srv2, store2, NO);
    const orphans2 = await orphansOf(srv2, otherRecord);
    check(
      "BUG-4 another household's transaction with the same id → never \"already\" here (missing in this household); a record from the other household is neither used nor cleared",
      r.result === 'cancelled' && r.prompted && srv.calls.creates.length === 0 &&
        r2.result === 'saved' && r2.transactionId === 'txn-ordinary' && orphans2.length === 0,
      JSON.stringify({ r, r2, orphans2 }),
    );
  }
  {
    const srv = fakeServer({ event: null });
    const state: PaymentCandidateState = {
      ...manual('txn-gone', { registeredAt: NOW - 9000, registeredHouseholdId: HH, linkConflictAt: NOW - 7000 }),
      pc1_refund: { handledAt: NOW - 8000, manualTxnId: 'txn-r', manualHouseholdId: HH, manualSavedAt: NOW - 8000, refundTxnId: 'txn-orig', refundedAt: NOW - 8000 },
      pc1_auto: { handledAt: NOW - 8000, manualTxnId: 'txn-a', manualHouseholdId: HH, manualSavedAt: NOW - 8000, autoSaveTxnId: 'txn-a2', autoSavedAt: NOW - 8000 },
      pc1_queued: { handledAt: NOW - 8000, manualTxnId: 'txn-q', manualHouseholdId: HH, manualSavedAt: NOW - 8000 },
      pc1_pending: { sentAt: NOW - 8000, manualTxnId: 'txn-p', manualHouseholdId: HH, manualSavedAt: NOW - 8000 },
      pc1_promo: { sentAt: NOW - 8000 },
    };
    const orphans = await orphansOf(srv, state, { 'txn-q': { op: 'create', failed: false } });
    let next = state;
    for (const o of orphans) next = clearOrphanedManualSave(next, o.fingerprint, o.transactionId, HH);
    const store = memoryStore(next);
    const r = await inputSave(srv, store, NO);
    const e = next[FP];
    check(
      'BUG-5 stale manual state recovered → only that candidate: 확인 대기, record dropped (registration / 보냄 / conflict kept); refund / auto / queued / pending / others untouched; /input then saves it as new, nobody asked',
      JSON.stringify(orphans) === JSON.stringify([{ fingerprint: FP, transactionId: 'txn-gone' }]) &&
        e.handledAt == null && e.manualTxnId == null && e.manualHouseholdId == null && e.manualSavedAt == null &&
        e.registeredHouseholdId === HH && e.sentAt === NOW - 9000 && e.linkConflictAt === NOW - 7000 &&
        ['pc1_refund', 'pc1_auto', 'pc1_queued', 'pc1_pending', 'pc1_promo'].every((k) => next[k] === state[k]) &&
        clearOrphanedManualSave(state, FP, 'txn-other', HH) === state &&
        r.result === 'saved' && !r.prompted && r.transactionId === 'txn-ordinary',
      JSON.stringify({ orphans, e, r }),
    );
  }
  for (const failed of [false, true]) {
    const srv = fakeServer({ event: null, queued: { 'txn-q': { op: 'create', failed } } });
    const store = memoryStore(manual('txn-q'));
    store.write(markCandidatePending(store.read(), FP));
    const r = await inputSave(srv, store, YES);
    const orphans = await orphansOf(srv, manual('txn-q'), { 'txn-q': { op: 'create', failed } });
    check(
      `BUG-6 offline ${failed ? 'held (terminal-failed)' : 'pending'} create, nothing on the server → ${failed ? 'queued-failed (not handled)' : 'queued (handled as at enqueue — offline policy kept)'}; never "already", no second create, not an orphan`,
      r.result === (failed ? 'queued-failed' : 'queued') && !r.prompted && srv.calls.creates.length === 0 &&
        srv.calls.liveness === 0 &&
        (failed ? store.read()[FP].handledAt == null : store.read()[FP].handledAt != null) &&
        store.read()[FP].manualTxnId === 'txn-q' && orphans.length === 0,
      JSON.stringify({ r, orphans }),
    );
  }
  {
    // Registered event, manual record, the transaction never landed: the
    // link keeps answering transaction_missing until it gives up.
    const savedAt = NOW - PAYMENT_MANUAL_LINK_MAX_AGE_MS - 1;
    const srv = fakeServer({ event: { status: 'pending', linked: null } });
    const store = memoryStore(registered({ handledAt: savedAt, manualTxnId: 'txn-never', manualHouseholdId: HH, manualSavedAt: savedAt }));
    const links = await runLinks(srv, store);
    const linkFailed = store.read()[FP];
    const orphans = await orphansOf(srv, store.read());
    let next = store.read();
    for (const o of orphans) next = clearOrphanedManualSave(next, o.fingerprint, o.transactionId, HH);
    store.write(next);
    const r = await inputSave(srv, store, NO);
    const relinked = await runLinks(srv, store);
    check(
      'BUG-7 event registered, link refused as transaction_missing → candidate not kept handled: orphan cleared → 확인 대기; /input then creates txn-pn-<event>, linked by the next pass',
      links.out.length === 1 && links.out[0].kind === 'link' && links.out[0].result === 'refused' &&
        linkFailed.manualLinkFailedAt != null && linkFailed.handledAt != null &&
        orphans.length === 1 && next[FP].handledAt == null && next[FP].manualTxnId == null && next[FP].manualLinkFailedAt == null &&
        next[FP].registeredEventId === EVENT &&
        r.result === 'saved' && r.transactionId === DERIVED && !r.prompted &&
        relinked.jobs === 1 && srv.event!.status === 'handled' && srv.event!.linked === DERIVED,
      JSON.stringify({ links: links.out, linkFailed, orphans, next: next[FP], r, relinked: relinked.out }),
    );
  }

  {
    // As on the device (23,000원 / 4,800원, no public.transactions row at
    // all): saved offline → enqueued → 처리 완료 with the queued id; the
    // create never landed and its op left the queue.
    const FP2 = 'pc1_def456';
    const enqueued = async () => {
      const store = memoryStore({ ...registered(), [FP2]: { sentAt: NOW - 1000 } });
      await settleSourceCandidate(store.io, FP, 'queued', NOW - 5000, { transactionId: DERIVED, householdId: HH });
      await settleSourceCandidate(store.io, FP2, 'queued', NOW - 5000, { transactionId: 'txn-q2', householdId: HH });
      return store;
    };
    const focus = async (store: Store, srvLive: (id: string) => Promise<PaymentTransactionLiveness>, queued: Record<string, QueuedTransactionOp> = {}) => {
      const orphans = await findOrphanedManualSaves(store.read(), HH, { queued: (id) => queued[id] ?? null, serverLiveness: srvLive });
      let next = store.read();
      for (const o of orphans) next = clearOrphanedManualSave(next, o.fingerprint, o.transactionId, HH);
      store.write(next);
      return orphans;
    };
    const gone = async () => 'missing' as const;

    // Server read fails (offline / no session → unknown): nothing cleared, /input refuses blind.
    const sU = await enqueued();
    const beforeU = JSON.stringify(sU.read());
    const oU = await focus(sU, async () => 'unknown');
    const rU = await inputSave(fakeServer({ event: { status: 'pending', linked: null }, fail: { liveness: true } }), sU, YES);

    // The create still held after a terminal failure: kept, /input says so.
    const sF = await enqueued();
    const held = { [DERIVED]: { op: 'create', failed: true }, 'txn-q2': { op: 'create', failed: true } } as const;
    const oF = await focus(sF, gone, held);
    sF.write(markCandidatePending(sF.read(), FP));
    const rF = await inputSave(fakeServer({ event: { status: 'pending', linked: null }, queued: held }), sF, YES);

    // Op gone, no row: both back to 확인 대기 on the 후보함 focus; /input then saves each once.
    const sA = await enqueued();
    const handledBefore = [FP, FP2].every((k) => sA.read()[k].handledAt != null);
    const oA = await focus(sA, gone);
    const after = sA.read();
    const srvA = fakeServer({ event: { status: 'pending', linked: null } });
    const rA = await inputSave(srvA, sA, NO);
    check(
      'BUG-8 device case (2 candidates, enqueued, op gone, no row) → focus clears both to 확인 대기 (registration / 보냄 kept); /input saves once with txn-pn-<event>, not "already"; unreadable server → nothing cleared, unknown; held create → kept, queued-failed',
      handledBefore &&
        oA.length === 2 &&
        [FP, FP2].every((k) => after[k].handledAt == null && after[k].manualTxnId == null && after[k].sentAt === NOW - 1000) &&
        after[FP].registeredEventId === EVENT &&
        rA.result === 'saved' && rA.transactionId === DERIVED && !rA.prompted && JSON.stringify(srvA.calls.creates) === JSON.stringify([DERIVED]) &&
        oU.length === 0 && JSON.stringify(sU.read()) === beforeU && rU.result === 'unknown' &&
        oF.length === 0 && sF.read()[FP2].handledAt != null && rF.result === 'queued-failed',
      JSON.stringify({ oA, after, rA, oU, rU, oF, rF }),
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
