/**
 * Static verification for the Offline Write Queue pure core
 * (src/lib/offlineQueue.ts). Plain data + runner.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingTransactionCreate,
  opsForScope,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const draft = (over: Partial<NewTransactionDraft> = {}): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: '2026-09-10T09:00:00.000Z',
  ...over,
});

const rec = (over: Partial<PendingWrite> = {}): PendingWrite => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: { userId: 'u-A', householdId: 'h-A' },
  entity: 'transaction',
  op: 'create',
  entityId: 'txn-1',
  payload: draft(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

const emptyFinance = (): RemoteFinanceData => ({
  transactions: [],
  transactionMeta: {},
  cards: [],
  cardMeta: {},
  budgets: {},
  budgetMeta: {},
  categoryMeta: {},
  recurring: [],
  recurringMeta: {},
  planned: [],
  plannedMeta: {},
  goals: [],
  goalMeta: {},
  loans: [],
  loanMeta: {},
  loanPaymentMeta: {},
  customCats: DEFAULT_CUSTOM_CATS,
  notes: '',
  catOrder: DEFAULT_CAT_ORDER,
});

export async function runOfflineQueueCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 1 — a valid transaction-create record validates and round-trips
  {
    const v = validatePendingWrite(rec());
    check(
      'CASE 1 valid transaction-create record accepted',
      v != null && v.entity === 'transaction' && v.op === 'create' && v.entityId === 'txn-1',
      `v=${JSON.stringify(v)}`,
    );
  }

  // CASE 2 — wrong schemaVersion rejected
  {
    const v = validatePendingWrite({ ...rec(), schemaVersion: 999 });
    check('CASE 2 wrong schemaVersion rejected', v === null, `v=${JSON.stringify(v)}`);
  }

  // CASE 3 — invalid scope rejected (missing householdId)
  {
    const v = validatePendingWrite({ ...rec(), scope: { userId: 'u-A' } });
    check('CASE 3 invalid scope rejected', v === null, `v=${JSON.stringify(v)}`);
  }

  // CASE 4 — missing / invalid payload rejected
  {
    const noPayload = validatePendingWrite({ ...rec(), payload: undefined });
    const badAmount = validatePendingWrite({ ...rec(), payload: draft({ amount: 0 }) });
    const serverField = validatePendingWrite({
      ...rec(),
      payload: { ...draft(), created_by: 'x' } as unknown as NewTransactionDraft,
    });
    check(
      'CASE 4 missing/invalid/server-tainted payload rejected',
      noPayload === null && badAmount === null && serverField === null,
      `noPayload=${noPayload} badAmount=${badAmount} serverField=${serverField}`,
    );
  }

  // CASE 5 — opsForScope: user isolation
  {
    const q = [
      rec({ queueId: 'q-1', entityId: 'txn-1', scope: { userId: 'u-A', householdId: 'h-A' } }),
      rec({ queueId: 'q-2', entityId: 'txn-2', scope: { userId: 'u-B', householdId: 'h-A' } }),
    ];
    const forA = opsForScope(q, 'u-A', 'h-A').map((o) => o.queueId);
    check(
      'CASE 5 opsForScope filters by userId',
      forA.length === 1 && forA[0] === 'q-1',
      `forA=${JSON.stringify(forA)}`,
    );
  }

  // CASE 6 — opsForScope: household isolation
  {
    const q = [
      rec({ queueId: 'q-1', entityId: 'txn-1', scope: { userId: 'u-A', householdId: 'h-A' } }),
      rec({ queueId: 'q-2', entityId: 'txn-2', scope: { userId: 'u-A', householdId: 'h-B' } }),
    ];
    const forHA = opsForScope(q, 'u-A', 'h-A').map((o) => o.queueId);
    check(
      'CASE 6 opsForScope filters by householdId',
      forHA.length === 1 && forHA[0] === 'q-1',
      `forHA=${JSON.stringify(forHA)}`,
    );
  }

  // CASE 7 — enqueue preserves FIFO order
  {
    let q: PendingWrite[] = [];
    for (const id of ['txn-1', 'txn-2', 'txn-3']) {
      const r = enqueuePendingWrite(
        q,
        makePendingTransactionCreate({
          scope: { userId: 'u-A', householdId: 'h-A' },
          entityId: id,
          payload: draft(),
          queueId: `q-${id}`,
          now: () => '2026-09-10T09:00:00.000Z',
        }),
      );
      if (r.ok) q = r.queue;
    }
    check(
      'CASE 7 enqueue keeps FIFO order',
      q.map((x) => x.entityId).join(',') === 'txn-1,txn-2,txn-3',
      q.map((x) => x.entityId).join(','),
    );
  }

  // CASE 8 — duplicate enqueue of the same create is idempotent
  {
    const base = makePendingTransactionCreate({
      scope: { userId: 'u-A', householdId: 'h-A' },
      entityId: 'txn-1',
      payload: draft(),
      queueId: 'q-first',
      now: () => 't0',
    });
    const r1 = enqueuePendingWrite([], base);
    const q1 = r1.ok ? r1.queue : [];
    // a fresh record for the SAME scope+entity+op+entityId (different queueId)
    const dupe = makePendingTransactionCreate({
      scope: { userId: 'u-A', householdId: 'h-A' },
      entityId: 'txn-1',
      payload: draft({ amount: 9999 }),
      queueId: 'q-second',
      now: () => 't1',
    });
    const r2 = enqueuePendingWrite(q1, dupe);
    check(
      'CASE 8 duplicate create enqueue -> no 2nd entry, existing returned',
      r2.ok &&
        r2.deduped === true &&
        r2.queue.length === 1 &&
        r2.record.queueId === 'q-first',
      `r2=${JSON.stringify(r2)}`,
    );
  }

  // CASE 8b — cap: at MAX_PENDING_WRITES a genuinely new record is refused
  {
    const q: PendingWrite[] = [];
    for (let i = 0; i < 200; i++) {
      q.push(rec({ queueId: `q-${i}`, entityId: `txn-${i}` }));
    }
    const over = enqueuePendingWrite(q, rec({ queueId: 'q-new', entityId: 'txn-new' }));
    // but a DUPLICATE at cap is still idempotently accepted (no growth)
    const dup = enqueuePendingWrite(q, rec({ queueId: 'q-dup', entityId: 'txn-5' }));
    check(
      'CASE 8b cap refuses new, still dedups existing, never evicts',
      over.ok === false &&
        over.reason === 'cap' &&
        over.queue.length === 200 &&
        dup.ok === true &&
        dup.deduped === true &&
        dup.queue.length === 200,
      `over=${JSON.stringify(over)} dupOk=${dup.ok}`,
    );
  }

  // CASE 9 — composeFinance adds a pending transaction row + meta
  {
    const server = emptyFinance();
    const ops = [rec({ entityId: 'txn-1', payload: draft({ memo: 'pending A', amount: 4444 }) })];
    const { data, pendingIds } = composeFinance(server, ops);
    const row = data.transactions.find((t) => t.id === 'txn-1');
    check(
      'CASE 9 composeFinance adds pending row + meta + pendingIds',
      row?.memo === 'pending A' &&
        row?.amount === 4444 &&
        data.transactionMeta['txn-1']?.createdBy === 'u-A' &&
        pendingIds.length === 1 &&
        pendingIds[0] === 'txn-1',
      `row=${JSON.stringify(row)} meta=${JSON.stringify(data.transactionMeta['txn-1'])}`,
    );
  }

  // CASE 10 — composeFinance does NOT duplicate a row already on the server
  {
    const server = emptyFinance();
    server.transactions = [
      { id: 'txn-1', type: 'expense', category: 'food', amount: 1, memo: 'server', date: '2026-09-10T00:00:00.000Z' },
    ];
    const ops = [rec({ entityId: 'txn-1', payload: draft({ memo: 'pending dupe' }) })];
    const { data, pendingIds } = composeFinance(server, ops);
    const rows = data.transactions.filter((t) => t.id === 'txn-1');
    check(
      'CASE 10 no duplicate when server already has the id',
      rows.length === 1 && rows[0].memo === 'server' && pendingIds.length === 0 && data === server,
      `rows=${JSON.stringify(rows)} sameRef=${data === server}`,
    );
  }

  // CASE 11 — composeFinance never mutates serverData or its arrays
  {
    const server = emptyFinance();
    const txnsRef = server.transactions;
    const metaRef = server.transactionMeta;
    const ops = [rec({ entityId: 'txn-9' })];
    const { data } = composeFinance(server, ops);
    check(
      'CASE 11 serverData immutable (new refs, originals untouched)',
      server.transactions === txnsRef &&
        server.transactionMeta === metaRef &&
        server.transactions.length === 0 &&
        data.transactions !== txnsRef &&
        data.transactions.length === 1,
      `origLen=${server.transactions.length} newLen=${data.transactions.length}`,
    );
  }

  // CASE 12 — multiple pending creates: deterministic, enqueue order, all present
  {
    const server = emptyFinance();
    const ops = [
      rec({ queueId: 'q-1', entityId: 'txn-1699999999003-c', enqueuedAt: 't3' }),
      rec({ queueId: 'q-2', entityId: 'txn-1699999999001-a', enqueuedAt: 't1' }),
      rec({ queueId: 'q-3', entityId: 'txn-1699999999002-b', enqueuedAt: 't2' }),
    ];
    const a = composeFinance(server, ops).data.transactions.map((t) => t.id);
    const b = composeFinance(server, ops).data.transactions.map((t) => t.id);
    check(
      'CASE 12 multiple pending creates -> all present, enqueue order, deterministic',
      JSON.stringify(a) === JSON.stringify(b) &&
        a.length === 3 &&
        a[0] === 'txn-1699999999003-c',
      `a=${JSON.stringify(a)}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
