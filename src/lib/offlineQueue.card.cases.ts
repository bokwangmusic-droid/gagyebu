/**
 * Static verification for STEP 16-H2-C2-A1 — card CREATE / UPDATE / soft
 * DELETE added to the pure Offline Write Queue core: record shapes, the
 * union-aware validator, the dedup / existing-pending policy, the
 * DISPLAY-ONLY `cardManagement` overlay (never merged into `data.cards`),
 * and the `serverCardConfirmsUpdate` ack matcher.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingCardCreate,
  makePendingCardDelete,
  makePendingCardUpdate,
  makePendingTransactionCreate,
  makePendingTransactionUpdate,
  sanitizePendingWrites,
  serverCardConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { CreditCard } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { userId: 'u-A', householdId: 'h-A' };
const T0 = '2026-09-10T09:00:00.000Z';
const FROZEN = '2026-09-10T09:00:00.000+00:00';

const cd = (over: Partial<NewCardDraft> = {}): NewCardDraft => ({ name: 'Visa', ...over });
const td = (over: Partial<NewTransactionDraft> = {}): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: T0,
  ...over,
});

const cardCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-cc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'card',
  op: 'create',
  entityId: 'card-1',
  payload: cd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const cardUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-cu',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'card',
  op: 'update',
  entityId: 'card-1',
  payload: cd(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const cardDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-cd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'card',
  op: 'delete',
  entityId: 'card-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverCard = (id: string, over: Partial<CreditCard> = {}): CreditCard => ({
  id,
  name: 'Server Card',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

function financeWith(cards: CreditCard[]): RemoteFinanceData {
  return {
    transactions: [],
    transactionMeta: {},
    cards,
    cardMeta: Object.fromEntries(cards.map((c) => [c.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }])),
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

export async function runOfflineQueueCardCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---------------- record / validator (§28.1–8) ---------------- */

  // 1
  {
    const v = validatePendingWrite(cardCreateObj());
    check(
      '1 valid card CREATE accepted',
      !!v && v.entity === 'card' && v.op === 'create' && v.payload.name === 'Visa' && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
  }
  // 2 — server / identity fields in the draft -> reject
  {
    const bad = [
      validatePendingWrite(cardCreateObj({ payload: { name: 'x', id: 'card-1' } })),
      validatePendingWrite(cardCreateObj({ payload: { name: 'x', createdAt: T0 } })),
      validatePendingWrite(cardCreateObj({ payload: { name: 'x', updated_at: T0 } })),
      validatePendingWrite(cardCreateObj({ payload: { name: '' } })),
      validatePendingWrite(cardCreateObj({ payload: { name: 'x', paymentDay: 40 } })),
      validatePendingWrite(cardCreateObj({ expectedUpdatedAt: FROZEN })), // CREATE carries no token
    ];
    check('2 card CREATE rejects server/identity fields + bad values + a stray token', bad.every((x) => x === null), JSON.stringify(bad));
  }
  // 3
  {
    const v = validatePendingWrite(cardUpdateObj());
    check('3 valid card UPDATE accepted', !!v && v.entity === 'card' && v.op === 'update' && v.expectedUpdatedAt === FROZEN, JSON.stringify(v));
  }
  // 4
  {
    const a = validatePendingWrite(cardUpdateObj({ expectedUpdatedAt: '' }));
    const b = validatePendingWrite(cardUpdateObj({ expectedUpdatedAt: undefined }));
    check('4 card UPDATE without expectedUpdatedAt rejected', a === null && b === null, `${a} ${b}`);
  }
  // 5
  {
    const v = validatePendingWrite(cardDeleteObj());
    check('5 valid card DELETE accepted', !!v && v.entity === 'card' && v.op === 'delete' && v.expectedUpdatedAt === FROZEN, JSON.stringify(v));
  }
  // 6
  {
    const withPayload = validatePendingWrite(cardDeleteObj({ payload: cd() }));
    const noToken = validatePendingWrite(cardDeleteObj({ expectedUpdatedAt: '' }));
    check('6 card DELETE with payload -> reject; without token -> reject', withPayload === null && noToken === null, `${withPayload} ${noToken}`);
  }
  // 7 — an old transaction record still validates unchanged
  {
    const txn = {
      queueId: 'q-t', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'transaction',
      op: 'create', entityId: 'txn-1', payload: td(), enqueuedAt: T0, attemptCount: 0,
    };
    const v = validatePendingWrite(txn);
    check('7 pre-existing transaction CREATE record still valid', !!v && v.entity === 'transaction' && v.op === 'create', JSON.stringify(v));
  }
  // 8 — mixed transaction + card array hydrates IN ORDER
  {
    const arr = [
      cardUpdateObj({ queueId: 'q1', entityId: 'card-9' }),
      { queueId: 'q2', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'transaction', op: 'create', entityId: 'txn-2', payload: td(), enqueuedAt: T0, attemptCount: 0 },
      cardDeleteObj({ queueId: 'q3', entityId: 'card-2' }),
      cardCreateObj({ queueId: 'q4', entityId: 'card-3' }),
    ];
    const { records, dropped } = sanitizePendingWrites(arr);
    check(
      '8 mixed transaction+card validate & keep order',
      dropped === 0 && records.map((r) => `${r.entity}:${r.op}`).join(',') === 'card:update,transaction:create,card:delete,card:create',
      records.map((r) => `${r.entity}:${r.op}`).join(','),
    );
  }

  /* ---------------- dedup / existing-pending (§28.9–14) ---------------- */

  // 9 — identical card CREATE -> deduped
  {
    const r = makePendingCardCreate({ scope: A, entityId: 'card-1', payload: cd(), queueId: 'q1' });
    const q1 = enqueuePendingWrite([], r);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...r, queueId: 'q2' });
    check('9 identical card CREATE -> deduped, one entry', q2.ok === true && q2.deduped === true && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 10 — differing card CREATE draft, same id -> existing-pending
  {
    const a = makePendingCardCreate({ scope: A, entityId: 'card-1', payload: cd({ name: 'Visa' }), queueId: 'q1' });
    const b = makePendingCardCreate({ scope: A, entityId: 'card-1', payload: cd({ name: 'Amex' }), queueId: 'q2' });
    const q1 = enqueuePendingWrite([], a);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], b);
    check('10 differing card CREATE (same id) -> existing-pending, 1st kept', q2.ok === false && q2.reason === 'existing-pending' && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 11 — identical card UPDATE -> deduped
  {
    const r = makePendingCardUpdate({ scope: A, entityId: 'card-1', payload: cd(), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], r);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...r, queueId: 'q2' });
    check('11 identical card UPDATE -> deduped', q2.ok === true && q2.deduped === true && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 12 — differing card UPDATE payload OR token -> existing-pending
  {
    const base = makePendingCardUpdate({ scope: A, entityId: 'card-1', payload: cd({ name: 'v1' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], base);
    const diffPayload = enqueuePendingWrite(q1.ok ? q1.queue : [], makePendingCardUpdate({ scope: A, entityId: 'card-1', payload: cd({ name: 'v2' }), expectedUpdatedAt: 'V1', queueId: 'q2' }));
    const diffToken = enqueuePendingWrite(q1.ok ? q1.queue : [], makePendingCardUpdate({ scope: A, entityId: 'card-1', payload: cd({ name: 'v1' }), expectedUpdatedAt: 'V2', queueId: 'q3' }));
    check(
      '12 differing card UPDATE (payload or token) -> existing-pending',
      diffPayload.ok === false && diffPayload.reason === 'existing-pending' && diffToken.ok === false && diffToken.reason === 'existing-pending',
      `p=${diffPayload.ok} t=${diffToken.ok}`,
    );
  }
  // 13 — identical card DELETE -> deduped
  {
    const r = makePendingCardDelete({ scope: A, entityId: 'card-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], r);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...r, queueId: 'q2' });
    check('13 identical card DELETE -> deduped', q2.ok === true && q2.deduped === true && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 14 — differing card DELETE token -> existing-pending; also CREATE→UPDATE not compacted
  {
    const d1 = makePendingCardDelete({ scope: A, entityId: 'card-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], d1);
    const d2 = enqueuePendingWrite(q1.ok ? q1.queue : [], makePendingCardDelete({ scope: A, entityId: 'card-1', expectedUpdatedAt: 'V2', queueId: 'q2' }));
    // CREATE then UPDATE for the same card id -> two FIFO records (no compaction, dedupKey has op)
    const c = makePendingCardCreate({ scope: A, entityId: 'card-2', payload: cd(), queueId: 'q3' });
    const qc = enqueuePendingWrite([], c);
    const qcu = enqueuePendingWrite(qc.ok ? qc.queue : [], makePendingCardUpdate({ scope: A, entityId: 'card-2', payload: cd({ name: 'x' }), expectedUpdatedAt: 'V1', queueId: 'q4' }));
    check(
      '14 differing card DELETE token -> existing-pending; CREATE+UPDATE(same id) -> 2 records, not compacted',
      d2.ok === false && d2.reason === 'existing-pending' &&
        qcu.ok === true && qcu.deduped === false && (qcu.ok ? qcu.queue.length : 0) === 2,
      `d2=${d2.ok} qcu.len=${qcu.ok ? qcu.queue.length : 'n/a'}`,
    );
  }

  /* ---------------- composeFinance card overlay (§28.15–24) ---------------- */

  // 15 + 16 — pending card CREATE: management-visible, NOT in data.cards
  {
    const server = financeWith([serverCard('card-srv')]);
    const op = makePendingCardCreate({ scope: A, entityId: 'card-new', payload: cd({ name: 'New', paymentDay: 5 }), queueId: 'q1' });
    const { data, cardManagement } = composeFinance(server, [op]);
    const mgmt = cardManagement.rows.find((c) => c.id === 'card-new');
    check(
      '15/16 pending card CREATE -> in cardManagement.rows; NOT in data.cards; data.cards ref unchanged',
      !!mgmt && mgmt.name === 'New' && mgmt.paymentDay === 5 &&
        !data.cards.some((c) => c.id === 'card-new') &&
        data.cards === server.cards &&
        cardManagement.opById.get('card-new') === 'create',
      `mgmt=${JSON.stringify(mgmt)} dataHas=${data.cards.some((c) => c.id === 'card-new')} sameRef=${data.cards === server.cards}`,
    );
  }
  // 17 + 18 — pending card UPDATE: management overlay; server cardMeta untouched
  {
    const server = financeWith([serverCard('card-1', { name: 'Old', paymentDay: 1 })]);
    const op = makePendingCardUpdate({ scope: A, entityId: 'card-1', payload: cd({ name: 'Edited', paymentDay: 20 }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { data, cardManagement } = composeFinance(server, [op]);
    const row = cardManagement.rows.find((c) => c.id === 'card-1')!;
    check(
      '17/18 pending card UPDATE -> overlay on management row; data.cards + cardMeta untouched',
      row.name === 'Edited' && row.paymentDay === 20 &&
        data.cards.find((c) => c.id === 'card-1')!.name === 'Old' && // authoritative unchanged
        data.cardMeta === server.cardMeta &&
        cardManagement.opById.get('card-1') === 'update',
      JSON.stringify(row),
    );
  }
  // 19 — not-failed pending card DELETE: management HIDDEN
  {
    const server = financeWith([serverCard('card-1'), serverCard('card-2')]);
    const op = makePendingCardDelete({ scope: A, entityId: 'card-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { data, cardManagement } = composeFinance(server, [op]);
    check(
      '19 pending card DELETE -> hidden from cardManagement.rows; still in authoritative data.cards',
      !cardManagement.rows.some((c) => c.id === 'card-1') &&
        cardManagement.rows.some((c) => c.id === 'card-2') &&
        cardManagement.hiddenIds.includes('card-1') &&
        data.cards.some((c) => c.id === 'card-1'),
      `rows=${cardManagement.rows.map((c) => c.id)} hidden=${cardManagement.hiddenIds}`,
    );
  }
  // 20 — FAILED card DELETE: server card restored/kept + marked
  {
    const server = financeWith([serverCard('card-1')]);
    const op = makePendingCardDelete({ scope: A, entityId: 'card-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { cardManagement } = composeFinance(server, [op], undefined, new Set(['card-1']));
    check(
      '20 failed card DELETE -> server card visible in cardManagement.rows + failed marker',
      cardManagement.rows.some((c) => c.id === 'card-1') &&
        cardManagement.hiddenIds.length === 0 &&
        cardManagement.opById.get('card-1') === 'delete' &&
        cardManagement.failedIds.has('card-1'),
      `rows=${cardManagement.rows.map((c) => c.id)} failed=${[...cardManagement.failedIds]}`,
    );
  }
  // 21 + 22 — FAILED card UPDATE + server card GONE: display-only, NOT in data.cards
  {
    const server = financeWith([]); // card deleted elsewhere
    const op = makePendingCardUpdate({ scope: A, entityId: 'card-gone', payload: cd({ name: 'Local Edit', closingDay: 15 }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { data, cardManagement } = composeFinance(server, [op], undefined, new Set(['card-gone']));
    const row = cardManagement.rows.find((c) => c.id === 'card-gone');
    check(
      '21/22 failed card UPDATE + card gone -> display-only synthetic row; NOT in data.cards',
      !!row && row.name === 'Local Edit' && row.closingDay === 15 &&
        !data.cards.some((c) => c.id === 'card-gone') &&
        cardManagement.opById.get('card-gone') === 'update' &&
        cardManagement.failedIds.has('card-gone'),
      `row=${JSON.stringify(row)} dataHas=${data.cards.some((c) => c.id === 'card-gone')}`,
    );
  }
  // 22b — NOT-failed pending card UPDATE + card missing -> nothing synthesized
  {
    const server = financeWith([]);
    const op = makePendingCardUpdate({ scope: A, entityId: 'card-wait', payload: cd({ name: 'x' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { cardManagement } = composeFinance(server, [op]); // no failed set
    check(
      '22b pending (not failed) card UPDATE + card missing -> no synthetic row, no marker',
      !cardManagement.rows.some((c) => c.id === 'card-wait') && !cardManagement.opById.has('card-wait'),
      `rows=${cardManagement.rows.map((c) => c.id)}`,
    );
  }
  // 23 — FAILED card CREATE: display-only / management-visible, NOT in data.cards
  {
    const server = financeWith([]);
    const op = makePendingCardCreate({ scope: A, entityId: 'card-fc', payload: cd({ name: 'FC' }), queueId: 'q1' });
    const { data, cardManagement } = composeFinance(server, [op], undefined, new Set(['card-fc']));
    check(
      '23 failed card CREATE -> synthetic management row + failed marker; NOT in data.cards',
      cardManagement.rows.some((c) => c.id === 'card-fc' && c.name === 'FC') &&
        cardManagement.failedIds.has('card-fc') &&
        !data.cards.some((c) => c.id === 'card-fc'),
      `rows=${cardManagement.rows.map((c) => c.id)}`,
    );
  }
  // 24 — the transaction card picker source (data.cards) is NEVER touched by ANY card op mix
  {
    const server = financeWith([serverCard('card-keep'), serverCard('card-del')]);
    const ops: PendingWrite[] = [
      makePendingCardCreate({ scope: A, entityId: 'card-new', payload: cd({ name: 'New' }), queueId: 'q1' }),
      makePendingCardUpdate({ scope: A, entityId: 'card-keep', payload: cd({ name: 'Renamed' }), expectedUpdatedAt: 'V1', queueId: 'q2' }),
      makePendingCardDelete({ scope: A, entityId: 'card-del', expectedUpdatedAt: 'V1', queueId: 'q3' }),
    ];
    const { data } = composeFinance(server, ops, undefined, new Set(['card-new']));
    check(
      '24 transaction card picker (data.cards) unaffected by create/update/delete/failed card ops',
      data.cards === server.cards &&
        data.cards.map((c) => `${c.id}:${c.name}`).join(',') === 'card-keep:Server Card,card-del:Server Card',
      data.cards.map((c) => c.id).join(','),
    );
  }

  /* ---------------- serverCardConfirmsUpdate (§28 ack matcher, §25) ---------------- */

  // 25 — exact match -> true
  {
    const d = cd({ name: 'N', color: { bg: '#111', color: '#fff' }, paymentDay: 3, closingDay: 20 });
    const row: CreditCard = { id: 'card-1', name: 'N', color: { bg: '#111', color: '#fff' }, paymentDay: 3, closingDay: 20, createdAt: T0 };
    check('25 serverCardConfirmsUpdate exact match -> true', serverCardConfirmsUpdate(row, d) === true);
  }
  // 26 — any editable field differs -> false
  {
    const d = cd({ name: 'N', paymentDay: 3 });
    check(
      '26 name / colour / paymentDay / closingDay mismatch -> false',
      serverCardConfirmsUpdate({ id: 'c', name: 'M', paymentDay: 3, createdAt: T0 }, d) === false &&
        serverCardConfirmsUpdate({ id: 'c', name: 'N', paymentDay: 3, color: { bg: '#1', color: '#2' }, createdAt: T0 }, d) === false &&
        serverCardConfirmsUpdate({ id: 'c', name: 'N', paymentDay: 4, createdAt: T0 }, d) === false &&
        serverCardConfirmsUpdate({ id: 'c', name: 'N', paymentDay: 3, closingDay: 9, createdAt: T0 }, d) === false,
    );
  }
  // 27 — absent === null: draft has no colour, row has no colour -> true
  {
    const d = cd({ name: 'N' });
    check('27 absent colour/days on both sides -> true', serverCardConfirmsUpdate({ id: 'c', name: 'N', createdAt: T0 }, d) === true);
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
