/**
 * Static verification for STEP 16-H2-C2-B1 — custom-category CREATE / UPDATE /
 * soft DELETE added to the pure Offline Write Queue core: record shapes, the
 * union-aware validator, the dedup / existing-pending policy, the
 * DISPLAY-ONLY `categoryManagement` overlay (never merged into
 * `data.customCats` / `data.categoryMeta` / `data.catOrder`), and the
 * `serverCategoryConfirmsUpdate` ack matcher.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS, type Category } from '@/data/categories';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewCustomCategoryDraft } from '@/lib/remoteCategoryWriteMapping';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingCardCreate,
  makePendingCategoryCreate,
  makePendingCategoryDelete,
  makePendingCategoryUpdate,
  makePendingTransactionCreate,
  sanitizePendingWrites,
  serverCategoryConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { userId: 'u-A', householdId: 'h-A' };
const T0 = '2026-09-10T09:00:00.000Z';
const FROZEN = '2026-09-10T09:00:00.000+00:00';

const kd = (over: Partial<NewCustomCategoryDraft> = {}): NewCustomCategoryDraft => ({
  type: 'expense',
  name: 'Groceries',
  icon: 'utensils',
  bg: '#EDE9FE',
  color: '#7C63D4',
  ...over,
});
const td = (over: Partial<NewTransactionDraft> = {}): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: T0,
  ...over,
});

const catCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-kc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'category',
  op: 'create',
  entityId: 'cat-1',
  payload: kd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const catUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-ku',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'category',
  op: 'update',
  entityId: 'cat-1',
  payload: kd(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const catDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-kd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'category',
  op: 'delete',
  entityId: 'cat-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverCat = (id: string, over: Partial<Category> = {}): Category => ({
  id,
  name: 'Server Cat',
  bg: '#D1FAE5',
  color: '#059669',
  icon: 'bus',
  custom: true,
  ...over,
});

function financeWith(expense: Category[], income: Category[] = []): RemoteFinanceData {
  const all = [...expense, ...income];
  return {
    transactions: [],
    transactionMeta: {},
    cards: [],
    cardMeta: {},
    budgets: {},
    budgetMeta: {},
    categoryMeta: Object.fromEntries(all.map((c) => [c.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }])),
    recurring: [],
    recurringMeta: {},
    planned: [],
    plannedMeta: {},
    goals: [],
    goalMeta: {},
    loans: [],
    loanMeta: {},
    loanPaymentMeta: {},
    customCats: { expense, income },
    notes: '',
    catOrder: DEFAULT_CAT_ORDER,
  };
}

export async function runOfflineQueueCategoryCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---------------- record / validator (§33.1–10) ---------------- */

  // 1
  {
    const v = validatePendingWrite(catCreateObj());
    check(
      '1 valid category CREATE accepted',
      !!v && v.entity === 'category' && v.op === 'create' && v.payload.name === 'Groceries' &&
        v.payload.type === 'expense' && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
  }
  // 2 — server / identity / read-model fields in the draft -> reject
  {
    const bad = [
      validatePendingWrite(catCreateObj({ payload: { ...kd(), id: 'cat-1' } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), created_by: 'u-A' } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), updated_at: T0 } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), deleted_at: T0 } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), custom: true } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), householdId: 'h-A' } })),
      validatePendingWrite(catCreateObj({ expectedUpdatedAt: FROZEN })), // CREATE carries no token
    ];
    check('2 category CREATE rejects server/identity/read-model fields + a stray token', bad.every((x) => x === null), JSON.stringify(bad));
  }
  // 3 — invalid shape (bad type / empty name / missing icon/bg/color) -> reject
  {
    const bad = [
      validatePendingWrite(catCreateObj({ payload: { ...kd(), type: 'nope' } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), name: '' } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), icon: '' } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), bg: '' } })),
      validatePendingWrite(catCreateObj({ payload: { ...kd(), color: '' } })),
    ];
    check('3 category draft with bad/empty editable fields rejected', bad.every((x) => x === null), JSON.stringify(bad));
  }
  // 4
  {
    const v = validatePendingWrite(catUpdateObj());
    check('4 valid category UPDATE accepted', !!v && v.entity === 'category' && v.op === 'update' && v.expectedUpdatedAt === FROZEN, JSON.stringify(v));
  }
  // 5
  {
    const a = validatePendingWrite(catUpdateObj({ expectedUpdatedAt: '' }));
    const b = validatePendingWrite(catUpdateObj({ expectedUpdatedAt: undefined }));
    check('5 category UPDATE without expectedUpdatedAt rejected', a === null && b === null, `${a} ${b}`);
  }
  // 6 — forbidden field on UPDATE payload -> reject
  {
    const a = validatePendingWrite(catUpdateObj({ payload: { ...kd(), updated_at: T0 } }));
    const b = validatePendingWrite(catUpdateObj({ payload: { ...kd(), id: 'cat-1' } }));
    check('6 category UPDATE rejects forbidden server/identity fields', a === null && b === null, `${a} ${b}`);
  }
  // 7
  {
    const v = validatePendingWrite(catDeleteObj());
    check('7 valid category DELETE accepted', !!v && v.entity === 'category' && v.op === 'delete' && v.expectedUpdatedAt === FROZEN, JSON.stringify(v));
  }
  // 8
  {
    const withPayload = validatePendingWrite(catDeleteObj({ payload: kd() }));
    const noToken = validatePendingWrite(catDeleteObj({ expectedUpdatedAt: '' }));
    check('8 category DELETE with payload -> reject; without token -> reject', withPayload === null && noToken === null, `${withPayload} ${noToken}`);
  }
  // 9 — pre-existing transaction / card records still validate unchanged
  {
    const txn = { queueId: 'q-t', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'transaction', op: 'create', entityId: 'txn-1', payload: td(), enqueuedAt: T0, attemptCount: 0 };
    const card = { queueId: 'q-c', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'card', op: 'create', entityId: 'card-1', payload: { name: 'Visa' } as NewCardDraft, enqueuedAt: T0, attemptCount: 0 };
    const vt = validatePendingWrite(txn);
    const vc = validatePendingWrite(card);
    check('9 pre-existing transaction + card CREATE records still valid', !!vt && vt.entity === 'transaction' && !!vc && vc.entity === 'card', `${JSON.stringify(vt)} ${JSON.stringify(vc)}`);
  }
  // 10 — mixed txn/card/category array hydrates IN ORDER
  {
    const arr = [
      catUpdateObj({ queueId: 'q1', entityId: 'cat-9' }),
      { queueId: 'q2', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'transaction', op: 'create', entityId: 'txn-2', payload: td(), enqueuedAt: T0, attemptCount: 0 },
      { queueId: 'q3', schemaVersion: QUEUE_SCHEMA_VERSION, scope: A, entity: 'card', op: 'delete', entityId: 'card-2', expectedUpdatedAt: FROZEN, enqueuedAt: T0, attemptCount: 0 },
      catCreateObj({ queueId: 'q4', entityId: 'cat-3' }),
      catDeleteObj({ queueId: 'q5', entityId: 'cat-2' }),
    ];
    const { records, dropped } = sanitizePendingWrites(arr);
    check(
      '10 mixed transaction+card+category validate & keep order',
      dropped === 0 &&
        records.map((r) => `${r.entity}:${r.op}`).join(',') ===
          'category:update,transaction:create,card:delete,category:create,category:delete',
      records.map((r) => `${r.entity}:${r.op}`).join(','),
    );
  }

  /* ---------------- dedup / existing-pending (§33.11–17) ---------------- */

  // 11 — identical category CREATE -> deduped
  {
    const r = makePendingCategoryCreate({ scope: A, entityId: 'cat-1', payload: kd(), queueId: 'q1' });
    const q1 = enqueuePendingWrite([], r);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...r, queueId: 'q2' });
    check('11 identical category CREATE -> deduped, one entry', q2.ok === true && q2.deduped === true && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 12 — differing category CREATE draft, same id -> existing-pending
  {
    const a = makePendingCategoryCreate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'Food' }), queueId: 'q1' });
    const b = makePendingCategoryCreate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'Grub' }), queueId: 'q2' });
    const q1 = enqueuePendingWrite([], a);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], b);
    check('12 differing category CREATE (same id) -> existing-pending, 1st kept', q2.ok === false && q2.reason === 'existing-pending' && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 13 — identical category UPDATE -> deduped
  {
    const r = makePendingCategoryUpdate({ scope: A, entityId: 'cat-1', payload: kd(), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], r);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...r, queueId: 'q2' });
    check('13 identical category UPDATE -> deduped', q2.ok === true && q2.deduped === true && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 14 + 15 — differing category UPDATE payload OR token -> existing-pending
  {
    const base = makePendingCategoryUpdate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'v1' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], base);
    const diffPayload = enqueuePendingWrite(q1.ok ? q1.queue : [], makePendingCategoryUpdate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'v2' }), expectedUpdatedAt: 'V1', queueId: 'q2' }));
    const diffToken = enqueuePendingWrite(q1.ok ? q1.queue : [], makePendingCategoryUpdate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'v1' }), expectedUpdatedAt: 'V2', queueId: 'q3' }));
    check(
      '14/15 differing category UPDATE (payload or token) -> existing-pending',
      diffPayload.ok === false && diffPayload.reason === 'existing-pending' &&
        diffToken.ok === false && diffToken.reason === 'existing-pending',
      `p=${diffPayload.ok} t=${diffToken.ok}`,
    );
  }
  // 16 — identical category DELETE -> deduped
  {
    const r = makePendingCategoryDelete({ scope: A, entityId: 'cat-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], r);
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], { ...r, queueId: 'q2' });
    check('16 identical category DELETE -> deduped', q2.ok === true && q2.deduped === true && q2.queue.length === 1, JSON.stringify(q2));
  }
  // 17 — differing category DELETE token -> existing-pending; also CREATE→UPDATE not compacted
  {
    const d1 = makePendingCategoryDelete({ scope: A, entityId: 'cat-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const q1 = enqueuePendingWrite([], d1);
    const d2 = enqueuePendingWrite(q1.ok ? q1.queue : [], makePendingCategoryDelete({ scope: A, entityId: 'cat-1', expectedUpdatedAt: 'V2', queueId: 'q2' }));
    const c = makePendingCategoryCreate({ scope: A, entityId: 'cat-2', payload: kd(), queueId: 'q3' });
    const qc = enqueuePendingWrite([], c);
    const qcu = enqueuePendingWrite(qc.ok ? qc.queue : [], makePendingCategoryUpdate({ scope: A, entityId: 'cat-2', payload: kd({ name: 'x' }), expectedUpdatedAt: 'V1', queueId: 'q4' }));
    check(
      '17 differing category DELETE token -> existing-pending; CREATE+UPDATE(same id) -> 2 records, not compacted',
      d2.ok === false && d2.reason === 'existing-pending' &&
        qcu.ok === true && qcu.deduped === false && (qcu.ok ? qcu.queue.length : 0) === 2,
      `d2=${d2.ok} qcu.len=${qcu.ok ? qcu.queue.length : 'n/a'}`,
    );
  }
  // 17b — a category UPDATE and a same-id CARD UPDATE never collide (entity in dedup key)
  {
    const cardOp = makePendingCardCreate({ scope: A, entityId: 'dup', payload: { name: 'Visa' } as NewCardDraft, queueId: 'q1' });
    const q1 = enqueuePendingWrite([], cardOp);
    const catOp = makePendingCategoryCreate({ scope: A, entityId: 'dup', payload: kd(), queueId: 'q2' });
    const q2 = enqueuePendingWrite(q1.ok ? q1.queue : [], catOp);
    check('17b same id, different entity -> both kept (entity in dedup identity)', q2.ok === true && q2.deduped === false && (q2.ok ? q2.queue.length : 0) === 2, JSON.stringify(q2));
  }

  /* ---------------- composeFinance category overlay (§33.18–29) ---------------- */

  // 18 + 19 — pending category CREATE: management-visible, NOT in data.customCats
  {
    const server = financeWith([serverCat('cat-srv')]);
    const op = makePendingCategoryCreate({ scope: A, entityId: 'cat-new', payload: kd({ type: 'expense', name: 'New' }), queueId: 'q1' });
    const { data, categoryManagement } = composeFinance(server, [op]);
    const mgmt = categoryManagement.rows.expense.find((c) => c.id === 'cat-new');
    check(
      '18/19 pending category CREATE -> in categoryManagement.rows; NOT in data.customCats; data.customCats ref unchanged',
      !!mgmt && mgmt.name === 'New' && mgmt.custom === true &&
        !data.customCats.expense.some((c) => c.id === 'cat-new') &&
        data.customCats === server.customCats &&
        categoryManagement.opById.get('cat-new') === 'create',
      `mgmt=${JSON.stringify(mgmt)} sameRef=${data.customCats === server.customCats}`,
    );
  }
  // 20 + 21 — pending category UPDATE: management overlay; server customCats + categoryMeta untouched
  {
    const server = financeWith([serverCat('cat-1', { name: 'Old', icon: 'bus' })]);
    const op = makePendingCategoryUpdate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'Edited', icon: 'coffee' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { data, categoryManagement } = composeFinance(server, [op]);
    const row = categoryManagement.rows.expense.find((c) => c.id === 'cat-1')!;
    check(
      '20/21 pending category UPDATE -> overlay on management row; data.customCats + categoryMeta untouched',
      row.name === 'Edited' && row.icon === 'coffee' &&
        data.customCats.expense.find((c) => c.id === 'cat-1')!.name === 'Old' && // authoritative unchanged
        data.categoryMeta === server.categoryMeta &&
        data.catOrder === server.catOrder &&
        categoryManagement.opById.get('cat-1') === 'update',
      JSON.stringify(row),
    );
  }
  // 22 + 23 — not-failed pending category DELETE: management HIDDEN, authoritative kept
  {
    const server = financeWith([serverCat('cat-1'), serverCat('cat-2')]);
    const op = makePendingCategoryDelete({ scope: A, entityId: 'cat-1', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { data, categoryManagement } = composeFinance(server, [op]);
    check(
      '22/23 pending category DELETE -> hidden from categoryManagement.rows; still in authoritative data.customCats',
      !categoryManagement.rows.expense.some((c) => c.id === 'cat-1') &&
        categoryManagement.rows.expense.some((c) => c.id === 'cat-2') &&
        categoryManagement.hiddenIds.includes('cat-1') &&
        data.customCats.expense.some((c) => c.id === 'cat-1'),
      `rows=${categoryManagement.rows.expense.map((c) => c.id)} hidden=${categoryManagement.hiddenIds}`,
    );
  }
  // 24 — FAILED category CREATE: display-only / management-visible, NOT in data.customCats
  {
    const server = financeWith([]);
    const op = makePendingCategoryCreate({ scope: A, entityId: 'cat-fc', payload: kd({ type: 'income', name: 'FC' }), queueId: 'q1' });
    const { data, categoryManagement } = composeFinance(server, [op], undefined, undefined, new Set(['cat-fc']));
    check(
      '24 failed category CREATE -> synthetic management row + failed marker; NOT in data.customCats',
      categoryManagement.rows.income.some((c) => c.id === 'cat-fc' && c.name === 'FC') &&
        categoryManagement.failedIds.has('cat-fc') &&
        !data.customCats.income.some((c) => c.id === 'cat-fc'),
      `rows=${categoryManagement.rows.income.map((c) => c.id)}`,
    );
  }
  // 25 — FAILED category UPDATE, server row exists: management draft overlay + failed
  {
    const server = financeWith([serverCat('cat-fu', { name: 'srv' })]);
    const op = makePendingCategoryUpdate({ scope: A, entityId: 'cat-fu', payload: kd({ name: 'Local' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { categoryManagement } = composeFinance(server, [op], undefined, undefined, new Set(['cat-fu']));
    const row = categoryManagement.rows.expense.find((c) => c.id === 'cat-fu')!;
    check(
      '25 failed category UPDATE (server row exists) -> draft overlay + failed marker',
      row.name === 'Local' && categoryManagement.opById.get('cat-fu') === 'update' && categoryManagement.failedIds.has('cat-fu'),
      JSON.stringify(row),
    );
  }
  // 26 — FAILED category UPDATE + server row GONE: display-only synthetic, NOT in data.customCats
  {
    const server = financeWith([]); // deleted elsewhere
    const op = makePendingCategoryUpdate({ scope: A, entityId: 'cat-gone', payload: kd({ type: 'expense', name: 'Local Edit' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { data, categoryManagement } = composeFinance(server, [op], undefined, undefined, new Set(['cat-gone']));
    const row = categoryManagement.rows.expense.find((c) => c.id === 'cat-gone');
    check(
      '26 failed category UPDATE + row gone -> display-only synthetic; NOT in data.customCats',
      !!row && row.name === 'Local Edit' &&
        !data.customCats.expense.some((c) => c.id === 'cat-gone') &&
        categoryManagement.opById.get('cat-gone') === 'update' &&
        categoryManagement.failedIds.has('cat-gone'),
      `row=${JSON.stringify(row)}`,
    );
  }
  // 26b — NOT-failed pending category UPDATE + row missing -> nothing synthesized
  {
    const server = financeWith([]);
    const op = makePendingCategoryUpdate({ scope: A, entityId: 'cat-wait', payload: kd({ name: 'x' }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { categoryManagement } = composeFinance(server, [op]);
    check(
      '26b pending (not failed) category UPDATE + row missing -> no synthetic row, no marker',
      !categoryManagement.rows.expense.some((c) => c.id === 'cat-wait') &&
        !categoryManagement.rows.income.some((c) => c.id === 'cat-wait') &&
        !categoryManagement.opById.has('cat-wait'),
      '',
    );
  }
  // 27 — FAILED category DELETE: server row restored/kept + marked
  {
    const server = financeWith([serverCat('cat-fd')]);
    const op = makePendingCategoryDelete({ scope: A, entityId: 'cat-fd', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const { categoryManagement } = composeFinance(server, [op], undefined, undefined, new Set(['cat-fd']));
    check(
      '27 failed category DELETE -> server row visible in categoryManagement.rows + failed marker',
      categoryManagement.rows.expense.some((c) => c.id === 'cat-fd') &&
        categoryManagement.hiddenIds.length === 0 &&
        categoryManagement.opById.get('cat-fd') === 'delete' &&
        categoryManagement.failedIds.has('cat-fd'),
      `rows=${categoryManagement.rows.expense.map((c) => c.id)} failed=${[...categoryManagement.failedIds]}`,
    );
  }
  // 28 — the category PICKERS' source (data.customCats) is NEVER touched by ANY category op mix
  {
    const server = financeWith([serverCat('cat-keep'), serverCat('cat-del')]);
    const ops: PendingWrite[] = [
      makePendingCategoryCreate({ scope: A, entityId: 'cat-new', payload: kd({ name: 'New' }), queueId: 'q1' }),
      makePendingCategoryUpdate({ scope: A, entityId: 'cat-keep', payload: kd({ name: 'Renamed' }), expectedUpdatedAt: 'V1', queueId: 'q2' }),
      makePendingCategoryDelete({ scope: A, entityId: 'cat-del', expectedUpdatedAt: 'V1', queueId: 'q3' }),
    ];
    const { data } = composeFinance(server, ops, undefined, undefined, new Set(['cat-new']));
    check(
      '28 category pickers (data.customCats) unaffected by create/update/delete/failed category ops',
      data.customCats === server.customCats &&
        data.customCats.expense.map((c) => `${c.id}:${c.name}`).join(',') === 'cat-keep:Server Cat,cat-del:Server Cat',
      data.customCats.expense.map((c) => c.id).join(','),
    );
  }
  // 29 — catOrder is NEVER synthetically mutated by pending CREATE / DELETE
  {
    const server = financeWith([serverCat('cat-1')]);
    const before = server.catOrder;
    const ops: PendingWrite[] = [
      makePendingCategoryCreate({ scope: A, entityId: 'cat-new', payload: kd({ name: 'New' }), queueId: 'q1' }),
      makePendingCategoryDelete({ scope: A, entityId: 'cat-1', expectedUpdatedAt: 'V1', queueId: 'q2' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '29 catOrder unchanged by pending category CREATE / DELETE (same ref, same arrays)',
      data.catOrder === before &&
        data.catOrder.expense === before.expense &&
        !data.catOrder.expense.includes('cat-new'),
      '',
    );
  }
  // 29b — a mix that also has a TRANSACTION op still leaves customCats/categoryMeta authoritative
  {
    const server = financeWith([serverCat('cat-1', { name: 'Keep' })]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
      makePendingCategoryUpdate({ scope: A, entityId: 'cat-1', payload: kd({ name: 'Overlaid' }), expectedUpdatedAt: 'V1', queueId: 'q2' }),
    ];
    const { data, categoryManagement } = composeFinance(server, ops);
    check(
      '29b transaction op present -> customCats authoritative, only categoryManagement overlaid',
      data.customCats.expense.find((c) => c.id === 'cat-1')!.name === 'Keep' &&
        categoryManagement.rows.expense.find((c) => c.id === 'cat-1')!.name === 'Overlaid' &&
        data.transactions.some((t) => t.id === 'txn-1'),
      '',
    );
  }

  /* ---------------- serverCategoryConfirmsUpdate (§33 ack matcher, §24) ---------------- */

  // 30 — exact match -> true
  {
    const d = kd({ name: 'N', bg: '#111', color: '#fff', icon: 'gift' });
    const row: Category = { id: 'cat-1', name: 'N', bg: '#111', color: '#fff', icon: 'gift', custom: true };
    check('30 serverCategoryConfirmsUpdate exact match -> true', serverCategoryConfirmsUpdate(row, d) === true);
  }
  // 31 — any editable field differs -> false
  {
    const d = kd({ name: 'N', bg: '#111', color: '#fff', icon: 'gift' });
    check(
      '31 name / bg / color / icon mismatch -> false',
      serverCategoryConfirmsUpdate({ id: 'c', name: 'M', bg: '#111', color: '#fff', icon: 'gift', custom: true }, d) === false &&
        serverCategoryConfirmsUpdate({ id: 'c', name: 'N', bg: '#222', color: '#fff', icon: 'gift', custom: true }, d) === false &&
        serverCategoryConfirmsUpdate({ id: 'c', name: 'N', bg: '#111', color: '#000', icon: 'gift', custom: true }, d) === false &&
        serverCategoryConfirmsUpdate({ id: 'c', name: 'N', bg: '#111', color: '#fff', icon: 'coffee', custom: true }, d) === false,
    );
  }
  // 32 — `type` is NOT part of the match (product-immutable / never written by UPDATE)
  {
    const d = kd({ type: 'income', name: 'N', bg: '#111', color: '#fff', icon: 'gift' });
    const row: Category = { id: 'c', name: 'N', bg: '#111', color: '#fff', icon: 'gift', custom: true };
    check('32 serverCategoryConfirmsUpdate ignores draft.type', serverCategoryConfirmsUpdate(row, d) === true);
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
