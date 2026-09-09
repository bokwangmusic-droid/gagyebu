/**
 * Static verification for the STEP 16-H2-B1 additions to the Offline Write
 * Queue pure core: the UPDATE/DELETE record union, the union-aware
 * validator, the differing-pending dedup policy, and the UPDATE/DELETE read
 * overlays. Plain data + runner.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { RemoteFinanceData, RemoteTransactionMeta } from '@/lib/remoteFinanceMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingTransactionCreate,
  makePendingTransactionDelete,
  makePendingTransactionUpdate,
  serverRowConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { Transaction } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { userId: 'u-A', householdId: 'h-A' };
const T0 = '2026-09-10T09:00:00.000Z';
const FROZEN = '2026-09-10T09:00:00.000+00:00';

const draft = (over: Partial<NewTransactionDraft> = {}): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: T0,
  ...over,
});

const updateRecObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-u',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'transaction',
  op: 'update',
  entityId: 'txn-1',
  payload: draft(),
  expectedUpdatedAt: FROZEN,
  originalRawCardId: null,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const deleteRecObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-d',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'transaction',
  op: 'delete',
  entityId: 'txn-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverTxn = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  type: 'expense',
  category: 'food',
  amount: 5000,
  memo: 'server memo',
  date: '2026-09-01T00:00:00.000Z',
  ...over,
});

const serverMeta = (over: Partial<RemoteTransactionMeta> = {}): RemoteTransactionMeta => ({
  updatedAt: 'SERVER-TOKEN-V1',
  createdBy: 'u-A',
  rawCardId: null,
  ...over,
});

function financeWith(txns: Transaction[], meta: Record<string, RemoteTransactionMeta>): RemoteFinanceData {
  return {
    transactions: txns,
    transactionMeta: meta,
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
  };
}

export async function runOfflineQueueB1Cases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  /* ---------------- validator / queue ---------------- */

  // 1 — valid UPDATE record
  {
    const v = validatePendingWrite(updateRecObj());
    check(
      'CASE 1 valid UPDATE record accepted',
      v != null && v.op === 'update' && v.expectedUpdatedAt === FROZEN && v.originalRawCardId === null,
      JSON.stringify(v),
    );
  }
  // 2 — UPDATE missing expectedUpdatedAt -> reject
  {
    const v = validatePendingWrite(updateRecObj({ expectedUpdatedAt: '' }));
    const v2 = validatePendingWrite(updateRecObj({ expectedUpdatedAt: undefined }));
    check('CASE 2 UPDATE without expectedUpdatedAt rejected', v === null && v2 === null, `${v} ${v2}`);
  }
  // 3 — UPDATE invalid payload / missing originalRawCardId -> reject
  {
    const bad = validatePendingWrite(updateRecObj({ payload: draft({ amount: 0 }) }));
    const noRaw = validatePendingWrite(updateRecObj({ originalRawCardId: undefined }));
    const badRaw = validatePendingWrite(updateRecObj({ originalRawCardId: 5 }));
    check(
      'CASE 3 UPDATE invalid payload / originalRawCardId rejected',
      bad === null && noRaw === null && badRaw === null,
      `${bad} ${noRaw} ${badRaw}`,
    );
  }
  // 4 — valid DELETE record
  {
    const v = validatePendingWrite(deleteRecObj());
    check(
      'CASE 4 valid DELETE record accepted',
      v != null && v.op === 'delete' && v.expectedUpdatedAt === FROZEN && !('payload' in v),
      JSON.stringify(v),
    );
  }
  // 5 — DELETE missing expectedUpdatedAt -> reject
  {
    const v = validatePendingWrite(deleteRecObj({ expectedUpdatedAt: '' }));
    check('CASE 5 DELETE without expectedUpdatedAt rejected', v === null, `${v}`);
  }
  // 6 — DELETE carrying a payload / server-polluted -> reject
  {
    const withPayload = validatePendingWrite(deleteRecObj({ payload: draft() }));
    const updWithId = validatePendingWrite(updateRecObj({ payload: { ...draft(), household_id: 'h' } }));
    check(
      'CASE 6 DELETE with payload / UPDATE payload with server field rejected',
      withPayload === null && updWithId === null,
      `${withPayload} ${updWithId}`,
    );
  }
  // 7 — an old H2-A2 CREATE record still validates unchanged
  {
    const createObj = {
      queueId: 'q-c',
      schemaVersion: QUEUE_SCHEMA_VERSION,
      scope: A,
      entity: 'transaction',
      op: 'create',
      entityId: 'txn-old',
      payload: draft(),
      enqueuedAt: T0,
      attemptCount: 0,
    };
    const v = validatePendingWrite(createObj);
    check(
      'CASE 7 old CREATE-only record still valid (schema v1, no migration)',
      v != null && v.op === 'create' && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
  }
  // 8 — a mixed CREATE/UPDATE/DELETE array hydrates in order
  {
    const raw = [
      { ...updateRecObj({ queueId: 'q1', entityId: 'txn-1' }) },
      {
        queueId: 'q2',
        schemaVersion: QUEUE_SCHEMA_VERSION,
        scope: A,
        entity: 'transaction',
        op: 'create',
        entityId: 'txn-2',
        payload: draft(),
        enqueuedAt: T0,
        attemptCount: 0,
      },
      { ...deleteRecObj({ queueId: 'q3', entityId: 'txn-3' }) },
    ];
    const out = raw.map(validatePendingWrite);
    check(
      'CASE 8 mixed CREATE/UPDATE/DELETE validate & keep order',
      out.every((x) => x != null) &&
        out.map((x) => x!.op).join(',') === 'update,create,delete',
      `ops=${out.map((x) => x?.op)}`,
    );
  }
  // 9 — identical UPDATE re-enqueue -> idempotent dedup
  {
    const rec = makePendingTransactionUpdate({
      scope: A,
      entityId: 'txn-1',
      payload: draft(),
      expectedUpdatedAt: FROZEN,
      originalRawCardId: null,
      queueId: 'q-first',
    });
    const q1 = enqueuePendingWrite([], rec);
    const dupe = makePendingTransactionUpdate({
      scope: A,
      entityId: 'txn-1',
      payload: draft(),
      expectedUpdatedAt: FROZEN,
      originalRawCardId: null,
      queueId: 'q-second',
    });
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], dupe);
    check(
      'CASE 9 identical UPDATE re-enqueue -> deduped, one entry, existing returned',
      q2.ok === true && q2.deduped === true && q2.queue.length === 1 && q2.record.queueId === 'q-first',
      JSON.stringify(q2),
    );
  }
  // 10 — differing pending UPDATE (payload OR token) -> existing-pending, no overwrite
  {
    const base = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ memo: 'v1' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q-1',
    });
    const q1 = enqueuePendingWrite([], base);
    const diffPayload = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ memo: 'v2' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q-2',
    });
    const diffToken = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ memo: 'v1' }),
      expectedUpdatedAt: 'OTHER-TOKEN', originalRawCardId: null, queueId: 'q-3',
    });
    const r1 = enqueuePendingWrite(q1.ok ? q1.queue : [], diffPayload);
    const r2 = enqueuePendingWrite(q1.ok ? q1.queue : [], diffToken);
    check(
      'CASE 10 differing pending UPDATE -> existing-pending (no silent overwrite/drop)',
      r1.ok === false && r1.reason === 'existing-pending' && r1.queue.length === 1 &&
        r2.ok === false && r2.reason === 'existing-pending' &&
        (q1.ok ? q1.queue[0].op === 'update' && (q1.queue[0] as { payload: NewTransactionDraft }).payload.memo === 'v1' : false),
      `r1=${JSON.stringify(r1)} r2=${r2.ok}`,
    );
  }
  // 11 — identical DELETE re-enqueue -> dedup
  {
    const d = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q-1' });
    const q1 = enqueuePendingWrite([], d);
    const dup = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q-2' });
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], dup);
    check(
      'CASE 11 identical DELETE re-enqueue -> deduped, one entry',
      q2.ok === true && q2.deduped === true && q2.queue.length === 1,
      JSON.stringify(q2),
    );
  }
  // 12 — DELETE with a different frozen token -> existing-pending
  {
    const d = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q-1' });
    const q1 = enqueuePendingWrite([], d);
    const d2 = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: 'OTHER', queueId: 'q-2' });
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], d2);
    check(
      'CASE 12 differing-token DELETE -> existing-pending (no silent merge)',
      q2.ok === false && q2.reason === 'existing-pending' && q2.queue.length === 1,
      JSON.stringify(q2),
    );
  }

  /* ---------------- compose ---------------- */

  const baseFinance = () =>
    financeWith([serverTxn('txn-1')], { 'txn-1': serverMeta() });

  // 13 — UPDATE overlays amount/memo/category/date/type
  {
    const server = baseFinance();
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1',
      payload: draft({ type: 'income', category: 'salary', amount: 12345, memo: 'edited', date: '2026-09-20T00:00:00.000Z' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const { data, pendingIds } = composeFinance(server, [op]);
    const row = data.transactions.find((t) => t.id === 'txn-1')!;
    check(
      'CASE 13 UPDATE overlay: fields reflect the user draft',
      row.type === 'income' && row.category === 'salary' && row.amount === 12345 &&
        row.memo === 'edited' && row.date === '2026-09-20T00:00:00.000Z' &&
        pendingIds.includes('txn-1'),
      JSON.stringify(row),
    );
  }
  // 14 — UPDATE clears cardId (paymentMethod no longer credit)
  {
    const server = financeWith(
      [serverTxn('txn-1', { paymentMethod: 'credit', cardId: 'card-9' })],
      { 'txn-1': serverMeta({ rawCardId: 'card-9' }) },
    );
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ paymentMethod: 'cash' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: 'card-9', queueId: 'q1',
    });
    const row = composeFinance(server, [op]).data.transactions.find((t) => t.id === 'txn-1')!;
    check(
      'CASE 14 UPDATE clears cardId when not credit',
      row.paymentMethod === 'cash' && row.cardId === undefined,
      JSON.stringify(row),
    );
  }
  // 15 — UPDATE clears installment
  {
    const server = financeWith(
      [serverTxn('txn-1', { installment: { months: 6 } })],
      { 'txn-1': serverMeta() },
    );
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ installment: undefined }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const row = composeFinance(server, [op]).data.transactions.find((t) => t.id === 'txn-1')!;
    check('CASE 15 UPDATE clears installment', row.installment === undefined, JSON.stringify(row));
  }
  // 16 — UPDATE clears splits
  {
    const server = financeWith(
      [serverTxn('txn-1', { splits: [{ category: 'a', amount: 1 }, { category: 'b', amount: 2 }] })],
      { 'txn-1': serverMeta() },
    );
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ splits: [] }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const row = composeFinance(server, [op]).data.transactions.find((t) => t.id === 'txn-1')!;
    check('CASE 16 UPDATE clears splits (empty -> undefined)', row.splits === undefined, JSON.stringify(row));
  }
  // 17 — UPDATE preserves the server transactionMeta token (NOT a fake enqueuedAt)
  {
    const server = baseFinance();
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ memo: 'x' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1', now: () => 'ENQ-TIME',
    });
    const { data } = composeFinance(server, [op]);
    check(
      'CASE 17 UPDATE keeps real server transactionMeta.updatedAt',
      data.transactionMeta['txn-1'].updatedAt === 'SERVER-TOKEN-V1' &&
        data.transactionMeta['txn-1'] === server.transactionMeta['txn-1'],
      JSON.stringify(data.transactionMeta['txn-1']),
    );
  }
  // 18 — compose does not mutate serverData / its arrays
  {
    const server = baseFinance();
    const txnsRef = server.transactions;
    const metaRef = server.transactionMeta;
    const rowRef = server.transactions[0];
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ memo: 'new' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const { data } = composeFinance(server, [op]);
    check(
      'CASE 18 serverData immutable across an UPDATE overlay',
      server.transactions === txnsRef &&
        server.transactionMeta === metaRef &&
        server.transactions[0] === rowRef &&
        rowRef.memo === 'server memo' &&
        data.transactions !== txnsRef &&
        data.transactions[0].memo === 'new',
      `orig=${rowRef.memo} new=${data.transactions[0].memo}`,
    );
  }
  // 19 — DELETE hides the transaction
  {
    const server = financeWith([serverTxn('txn-1'), serverTxn('txn-2')], { 'txn-1': serverMeta(), 'txn-2': serverMeta() });
    const op = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const { data, hiddenIds, pendingIds } = composeFinance(server, [op]);
    check(
      'CASE 19 DELETE hides the row',
      !data.transactions.some((t) => t.id === 'txn-1') &&
        data.transactions.some((t) => t.id === 'txn-2') &&
        hiddenIds.includes('txn-1') &&
        !pendingIds.includes('txn-1'),
      `ids=${data.transactions.map((t) => t.id)}`,
    );
  }
  // 20 — DELETE also removes the corresponding transactionMeta entry
  {
    const server = baseFinance();
    const op = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const { data } = composeFinance(server, [op]);
    check(
      'CASE 20 DELETE drops transactionMeta[id] in the composed view',
      !('txn-1' in data.transactionMeta) && 'txn-1' in server.transactionMeta,
      `composedHas=${'txn-1' in data.transactionMeta} serverHas=${'txn-1' in server.transactionMeta}`,
    );
  }
  // 21 — DELETE changes only the composed list; server source is untouched
  {
    const server = baseFinance();
    const txnsRef = server.transactions;
    const op = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const { data } = composeFinance(server, [op]);
    check(
      'CASE 21 DELETE: serverData.transactions immutable',
      server.transactions === txnsRef && server.transactions.length === 1 && data.transactions.length === 0,
      `serverLen=${server.transactions.length} composedLen=${data.transactions.length}`,
    );
  }
  // 22 — a FAILED delete keeps the server row visible (not hidden)
  {
    const server = baseFinance();
    const op = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: FROZEN, queueId: 'q-DEL' });
    const failed = new Set<string>(['txn-1']); // entity-id set
    const { data, hiddenIds, pendingIds } = composeFinance(server, [op], failed);
    check(
      'CASE 22 failed DELETE -> server row restored/kept + marked pending (not hidden)',
      data.transactions.some((t) => t.id === 'txn-1') &&
        hiddenIds.length === 0 &&
        pendingIds.includes('txn-1') &&
        'txn-1' in data.transactionMeta,
      `hidden=${hiddenIds} pending=${pendingIds}`,
    );
  }
  // 23 — CREATE overlay regression (H2-A2 behaviour unchanged)
  {
    const server = financeWith([], {});
    const c = makePendingTransactionCreate({ scope: A, entityId: 'txn-new', payload: draft({ memo: 'pending' }), queueId: 'q1' });
    const { data, pendingIds, hiddenIds } = composeFinance(server, [c]);
    check(
      'CASE 23 CREATE overlay still adds a synthetic row + meta + pendingIds',
      data.transactions.some((t) => t.id === 'txn-new' && t.memo === 'pending') &&
        data.transactionMeta['txn-new']?.createdBy === 'u-A' &&
        pendingIds.includes('txn-new') &&
        hiddenIds.length === 0,
      JSON.stringify(pendingIds),
    );
  }
  // 23b — CREATE then UPDATE for the same id in one compose pass
  {
    const server = financeWith([], {});
    const c = makePendingTransactionCreate({ scope: A, entityId: 'txn-x', payload: draft({ memo: 'created' }), queueId: 'q1' });
    const u = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-x', payload: draft({ memo: 'then-edited', amount: 999 }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q2',
    });
    const ops: PendingWrite[] = [c, u];
    const row = composeFinance(server, ops).data.transactions.find((t) => t.id === 'txn-x')!;
    check(
      'CASE 23b create+update in enqueue order -> update applied on the synthetic row',
      row.memo === 'then-edited' && row.amount === 999,
      JSON.stringify(row),
    );
  }

  /* --- STEP 16-H2-B2.1/B2.2 — failed UPDATE whose server row is gone --- */

  // 23c — failed UPDATE + server row STILL EXISTS -> normal overlay in
  // data.transactions + pending; NEVER an orphan (a real row is present, so
  // showing the un-sent draft as a pending-finance row is the kept policy).
  {
    const server = baseFinance();
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ amount: 12000, memo: '점심' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const { data, pendingIds, orphanedFailedUpdates } = composeFinance(server, [op], new Set(['txn-1']));
    const r = data.transactions.find((t) => t.id === 'txn-1')!;
    check(
      'CASE 23c failed UPDATE + row present -> draft overlaid on the real row, pending, NOT orphan',
      r.amount === 12000 && r.memo === '점심' &&
        pendingIds.includes('txn-1') &&
        data.transactionMeta['txn-1'] === server.transactionMeta['txn-1'] && // real token kept
        data.transactions.length === 1 &&
        orphanedFailedUpdates.length === 0,
      `row=${JSON.stringify(r)} orphans=${orphanedFailedUpdates.length}`,
    );
  }

  // 23d — failed UPDATE + server row MISSING -> DISPLAY-ONLY orphan row.
  // NOT in data.transactions / pendingIds / transactionMeta (so no finance
  // calc sees it); IS in orphanedFailedUpdates with the frozen draft fields.
  {
    const server = financeWith([], {}); // row deleted on the server
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-gone', payload: draft({ amount: 12000, memo: '점심', category: 'food', type: 'expense' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: 'card-3', queueId: 'q1',
    });
    const { data, pendingIds, hiddenIds, orphanedFailedUpdates } = composeFinance(
      server, [op], new Set(['txn-gone']),
    );
    const orphan = orphanedFailedUpdates.find((t) => t.id === 'txn-gone');
    check(
      'CASE 23d failed UPDATE + row gone -> display-only orphan, NOT in data.transactions',
      !data.transactions.some((t) => t.id === 'txn-gone') &&
        !pendingIds.includes('txn-gone') &&
        !('txn-gone' in data.transactionMeta) &&
        hiddenIds.length === 0 &&
        !!orphan && orphan.amount === 12000 && orphan.memo === '점심' && orphan.category === 'food',
      `orphan=${JSON.stringify(orphan)} txns=${data.transactions.map((t) => t.id)} pending=${pendingIds}`,
    );
  }

  // 23d2 — AGGREGATE ISOLATION: an active server row is counted; the orphan
  // amount is NOT (proves stats/budget/합계 inputs stay clean).
  {
    const server = financeWith(
      [serverTxn('txn-a', { type: 'expense', amount: 10000 })],
      { 'txn-a': serverMeta() },
    );
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-b', payload: draft({ type: 'expense', amount: 12000 }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const { data, orphanedFailedUpdates } = composeFinance(server, [op], new Set(['txn-b']));
    const calcExpense = data.transactions
      .filter((t) => t.type === 'expense')
      .reduce((s, t) => s + t.amount, 0);
    check(
      'CASE 23d2 orphan amount excluded from finance calc source; server row still counted',
      calcExpense === 10000 &&
        data.transactions.length === 1 &&
        !data.transactions.some((t) => t.id === 'txn-b') &&
        orphanedFailedUpdates.some((t) => t.id === 'txn-b' && t.amount === 12000),
      `calcExpense=${calcExpense} txns=${data.transactions.map((t) => t.id)}`,
    );
  }

  // 23e — NOT-failed pending UPDATE + server row transiently MISSING -> NOT
  // synthesized anywhere (no data row, no pendingId, no orphan)
  {
    const server = financeWith([], {});
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-wait', payload: draft({ amount: 5 }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const { data, pendingIds, hiddenIds, orphanedFailedUpdates } = composeFinance(server, [op]); // no failed set
    check(
      'CASE 23e pending (not failed) UPDATE + row missing -> nothing synthesized, no orphan',
      !data.transactions.some((t) => t.id === 'txn-wait') &&
        !pendingIds.includes('txn-wait') &&
        !hiddenIds.includes('txn-wait') &&
        !('txn-wait' in data.transactionMeta) &&
        orphanedFailedUpdates.length === 0,
      `txns=${data.transactions.map((t) => t.id)} orphans=${orphanedFailedUpdates.length}`,
    );
  }

  // 23f — the orphan path never mutates serverData and returns the SAME
  // data reference when nothing else applied (only an orphan was produced)
  {
    const server = financeWith([], {});
    const txnsRef = server.transactions;
    const metaRef = server.transactionMeta;
    const op = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-gone', payload: draft({ memo: 'local' }),
      expectedUpdatedAt: FROZEN, originalRawCardId: null, queueId: 'q1',
    });
    const { data, orphanedFailedUpdates } = composeFinance(server, [op], new Set(['txn-gone']));
    check(
      'CASE 23f orphan-only compose: serverData untouched, data ref unchanged',
      server.transactions === txnsRef && server.transactions.length === 0 &&
        server.transactionMeta === metaRef && !('txn-gone' in server.transactionMeta) &&
        data === server && data.transactions.length === 0 &&
        orphanedFailedUpdates.length === 1,
      `dataSame=${data === server} orphans=${orphanedFailedUpdates.length}`,
    );
  }

  // 23g — failed CREATE regression: still overlaid in data.transactions via
  // the CREATE path (NOT routed to orphanedFailedUpdates)
  {
    const server = financeWith([], {});
    const c = makePendingTransactionCreate({ scope: A, entityId: 'txn-fc', payload: draft({ memo: 'fc' }), queueId: 'q1' });
    const { data, pendingIds, orphanedFailedUpdates } = composeFinance(server, [c], new Set(['txn-fc']));
    check(
      'CASE 23g failed CREATE still overlays as a real synthetic row (unchanged, not orphan)',
      data.transactions.some((t) => t.id === 'txn-fc' && t.memo === 'fc') &&
        pendingIds.includes('txn-fc') &&
        orphanedFailedUpdates.length === 0,
      `pending=${pendingIds} orphans=${orphanedFailedUpdates.length}`,
    );
  }

  /* ---------------- response-loss retry contract ---------------- */

  // 24 — UPDATE response-loss: the FROZEN expectedUpdatedAt never changes
  // across replays. (The service's 0-row `financialFieldsMatch` reconcile is
  // what turns replay #2 into an idempotent success; unchanged here, proven
  // by src/services/remoteFinanceWrite.ts's own G2-B contract. This case
  // pins the queue side: the record's token is identical on every read.)
  {
    const rec = makePendingTransactionUpdate({
      scope: A, entityId: 'txn-1', payload: draft({ memo: 'v1' }),
      expectedUpdatedAt: 'V1-FROZEN', originalRawCardId: null, queueId: 'q1',
    });
    const q1 = enqueuePendingWrite([], rec);
    // a re-enqueue of the SAME request is a no-op; the stored token is V1 still
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...rec, queueId: 'q2' });
    const stored = (q2.ok ? q2.queue[0] : rec) as { op: string; expectedUpdatedAt: string };
    check(
      'CASE 24 UPDATE replay uses the SAME frozen expectedUpdatedAt (never refreshed)',
      q2.ok === true && q2.deduped === true && stored.expectedUpdatedAt === 'V1-FROZEN',
      JSON.stringify(stored),
    );
  }

  // 25 — DELETE response-loss: same frozen token across replays; a
  // re-enqueue with a DIFFERENT (newer) token is refused, not merged — so a
  // stale offline delete can never be silently re-pointed at V2.
  {
    const rec = makePendingTransactionDelete({ scope: A, entityId: 'txn-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], rec);
    const sameAgain = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...rec, queueId: 'q2' });
    const newerToken = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...rec, queueId: 'q3', expectedUpdatedAt: 'V2' });
    check(
      'CASE 25 DELETE replay keeps V1 token; a newer-token re-enqueue is refused',
      sameAgain.ok === true &&
        sameAgain.deduped === true &&
        newerToken.ok === false &&
        newerToken.reason === 'existing-pending',
      `same=${sameAgain.ok} newer=${JSON.stringify(newerToken)}`,
    );
  }

  /* ---------------- serverRowConfirmsUpdate (STEP 16-H2-B2 §16 ack matcher) ---------------- */

  const NO_CARDS: ReadonlySet<string> = new Set();
  const LIVE_CARDS: ReadonlySet<string> = new Set(['card-live']);
  // A server row that exactly reflects `d`.
  const rowOf = (d: NewTransactionDraft): Transaction => ({
    id: 'txn-1',
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

  // 26 — exact field match -> confirmed
  {
    const d = draft({ amount: 4200, memo: 'lunch' });
    check(
      'CASE 26 serverRowConfirmsUpdate: exact match -> true',
      serverRowConfirmsUpdate(rowOf(d), d, NO_CARDS) === true,
      'exact',
    );
  }
  // 27 — amount differs -> not confirmed
  {
    const d = draft({ amount: 4200 });
    const row = rowOf(draft({ amount: 4201 }));
    check(
      'CASE 27 amount mismatch -> false',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === false,
      'amount',
    );
  }
  // 28 — string amount vs number amount -> Number()-compared, confirmed
  {
    const d = draft({ amount: 1500 });
    const row = { ...rowOf(d), amount: '1500' as unknown as number };
    check(
      'CASE 28 amount "1500" == 1500 (Number compare) -> true',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === true,
      'coerce',
    );
  }
  // 29 — memo undefined on the row vs '' in the draft -> lenient, confirmed
  {
    const d = draft({ memo: '' });
    const row = { ...rowOf(d), memo: undefined as unknown as string };
    check(
      'CASE 29 memo undefined vs "" -> true',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === true,
      'memo empty',
    );
  }
  // 30 — same instant, different ISO spelling -> confirmed
  {
    const d = draft({ date: '2026-09-10T09:00:00.000Z' });
    const row = { ...rowOf(d), date: '2026-09-10T09:00:00+00:00' };
    check(
      'CASE 30 date same instant, different string -> true',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === true,
      'date instant',
    );
  }
  // 31 — category / type differences -> not confirmed
  {
    const d = draft();
    check(
      'CASE 31 category & type mismatch -> false',
      serverRowConfirmsUpdate(rowOf(draft({ category: 'cafe' })), d, NO_CARDS) === false &&
        serverRowConfirmsUpdate(rowOf(draft({ type: 'income' })), d, NO_CARDS) === false,
      'cat/type',
    );
  }
  // 32 — installment months differ -> not confirmed
  {
    const d = draft({ installment: { months: 3 } });
    const row = rowOf(draft({ installment: { months: 6 } }));
    check(
      'CASE 32 installment.months mismatch -> false',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === false,
      'installment',
    );
  }
  // 33 — paymentMethod differs -> not confirmed
  {
    const d = draft({ paymentMethod: 'cash' });
    const row = rowOf(draft({ paymentMethod: 'credit', cardId: 'card-x' }));
    check(
      'CASE 33 paymentMethod mismatch -> false',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === false,
      'pm',
    );
  }
  // 34 — splits: order-significant compare
  {
    const s1 = [
      { category: 'food', amount: 600 },
      { category: 'cafe', amount: 400 },
    ];
    const d = draft({ amount: 1000, splits: s1 });
    const same = rowOf(draft({ amount: 1000, splits: s1 }));
    const reordered = rowOf(
      draft({ amount: 1000, splits: [s1[1], s1[0]] }),
    );
    check(
      'CASE 34 splits match in order -> true; reordered -> false',
      serverRowConfirmsUpdate(same, d, NO_CARDS) === true &&
        serverRowConfirmsUpdate(reordered, d, NO_CARDS) === false,
      'splits',
    );
  }
  // 35 — splits length differs -> not confirmed
  {
    const d = draft({ splits: [{ category: 'food', amount: 1000 }] });
    const row = rowOf(draft({ splits: undefined }));
    check(
      'CASE 35 splits length mismatch -> false',
      serverRowConfirmsUpdate(row, d, NO_CARDS) === false,
      'splits len',
    );
  }
  // 36 — cardId mismatch, draft card is CURRENTLY LIVE -> disqualifying
  {
    const d = draft({ paymentMethod: 'credit', cardId: 'card-live' });
    const row = rowOf(draft({ paymentMethod: 'credit', cardId: 'card-other' }));
    check(
      'CASE 36 cardId mismatch + draft card is live -> false',
      serverRowConfirmsUpdate(row, d, LIVE_CARDS) === false,
      'live card',
    );
  }
  // 37 — cardId mismatch, draft card NOT live (dangling / soft-deleted) -> lenient, confirmed
  {
    const d = draft({ paymentMethod: 'credit', cardId: 'card-dangling' });
    const row = { ...rowOf(d), cardId: undefined as unknown as string };
    check(
      'CASE 37 cardId mismatch + draft card NOT live -> true (lenient)',
      serverRowConfirmsUpdate(row, d, LIVE_CARDS) === true,
      'dangling card',
    );
  }
  // 38 — cardId exactly equal -> confirmed regardless of liveness set
  {
    const d = draft({ paymentMethod: 'credit', cardId: 'card-live' });
    check(
      'CASE 38 cardId exact equal -> true',
      serverRowConfirmsUpdate(rowOf(d), d, LIVE_CARDS) === true &&
        serverRowConfirmsUpdate(rowOf(d), d, NO_CARDS) === true,
      'equal card',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
