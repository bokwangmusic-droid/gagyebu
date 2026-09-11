/**
 * Static verification for STEP 16-H2-E1 — planned-expense CREATE / UPDATE /
 * soft DELETE added to the pure Offline Write Queue core: record shapes, the
 * union-aware validator, the dedup / existing-pending policy, the
 * DISPLAY-ONLY `plannedManagement` overlay (NEVER merged into `data.planned`
 * / `data.plannedMeta` — the Home upcoming banner and the planned list's own
 * read path keep reading authoritative server data), and the
 * `serverPlannedConfirmsUpdate` ack matcher.
 *
 * Mirrors src/lib/offlineQueue.category.cases.ts. ENGINE ONLY — no UI wiring
 * is exercised here. RunOp dispatch + the ack reconcile live in
 * src/services/offlineQueue/coordinator.planned.cases.ts.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewPlannedExpenseDraft } from '@/lib/remotePlannedWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingCardCreate,
  makePendingPlannedCreate,
  makePendingPlannedDelete,
  makePendingPlannedUpdate,
  makePendingTransactionCreate,
  opsForScope,
  sanitizePendingWrites,
  serverPlannedConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { PlannedExpense } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { userId: 'u-A', householdId: 'h-A' };
const B = { userId: 'u-B', householdId: 'h-B' };
const T0 = '2026-09-10T09:00:00.000Z';
const FROZEN = '2026-09-10T09:00:00.000+00:00';
const FROZEN2 = '2026-09-10T10:00:00.000+00:00';

const pd = (over: Partial<NewPlannedExpenseDraft> = {}): NewPlannedExpenseDraft => ({
  name: '월세',
  amount: 100000,
  category: 'housing',
  date: '2026-10-01',
  memo: '',
  type: 'expense',
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

const plCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-pc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'planned',
  op: 'create',
  entityId: 'p-1',
  payload: pd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const plUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-pu',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'planned',
  op: 'update',
  entityId: 'p-1',
  payload: pd(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const plDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-pd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'planned',
  op: 'delete',
  entityId: 'p-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverPl = (id: string, over: Partial<PlannedExpense> = {}): PlannedExpense => ({
  id,
  name: '월세',
  amount: 100000,
  category: 'housing',
  date: '2026-10-01',
  memo: '',
  type: 'expense',
  createdAt: T0,
  ...over,
});

function financeWith(
  planned: PlannedExpense[],
  plannedMeta: Record<string, { updatedAt: string; createdBy: string | null }> = {},
): RemoteFinanceData {
  return {
    transactions: [],
    transactionMeta: {},
    cards: [],
    cardMeta: {},
    budgets: {},
    budgetMeta: {},
    categoryMeta: {},
    recurring: [],
    recurringMeta: {},
    planned,
    plannedMeta:
      Object.keys(plannedMeta).length > 0
        ? plannedMeta
        : Object.fromEntries(planned.map((p) => [p.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }])),
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

export async function runOfflineQueuePlannedCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ SCHEMA ============================ */

  // 1 — CREATE valid; a CREATE carries no token
  {
    const v = validatePendingWrite(plCreateObj());
    check(
      '1 CREATE valid, no expectedUpdatedAt',
      !!v && v.entity === 'planned' && v.op === 'create' && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
    check(
      '1b CREATE with an expectedUpdatedAt is rejected',
      validatePendingWrite(plCreateObj({ expectedUpdatedAt: FROZEN })) === null,
      '',
    );
  }

  // 2 — UPDATE valid + frozen token REQUIRED
  {
    const v = validatePendingWrite(plUpdateObj());
    check(
      '2 UPDATE valid with frozen token',
      !!v && v.op === 'update' && v.entity === 'planned' && v.expectedUpdatedAt === FROZEN,
      JSON.stringify(v),
    );
    check(
      '2b UPDATE without a token is rejected',
      validatePendingWrite(plUpdateObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(plUpdateObj({ expectedUpdatedAt: '' })) === null,
      '',
    );
  }

  // 3 — DELETE valid + frozen token REQUIRED, no payload
  {
    const v = validatePendingWrite(plDeleteObj());
    check(
      '3 DELETE valid with frozen token, no payload',
      !!v && v.op === 'delete' && v.entity === 'planned' && !('payload' in v),
      JSON.stringify(v),
    );
    check(
      '3b DELETE without a token / with a payload is rejected',
      validatePendingWrite(plDeleteObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(plDeleteObj({ payload: pd() })) === null,
      '',
    );
  }

  // 4 — malformed persisted planned queue records are rejected
  {
    const bad = [
      plCreateObj({ payload: pd({ amount: 0 }) }), // amount must be > 0
      plCreateObj({ payload: pd({ amount: -5 }) }),
      plCreateObj({ payload: pd({ date: '2026-13-40' }) }), // not a real calendar date
      plCreateObj({ payload: pd({ name: '   ' }) }), // blank name
      plCreateObj({ payload: { ...pd(), id: 'p-1' } }), // server/identity field in payload
      plCreateObj({ payload: { ...pd(), household_id: 'h-A' } }),
      plCreateObj({ payload: { ...pd(), updated_at: T0 } }),
      plCreateObj({ payload: { ...pd(), type: 'transfer' } }), // bad type
      plUpdateObj({ payload: { ...pd(), deleted_at: T0 } }),
      { ...plCreateObj(), entityId: '' },
    ];
    check(
      '4 malformed planned persisted ops all reject',
      bad.every((b) => validatePendingWrite(b) === null),
      JSON.stringify(bad.map((b) => validatePendingWrite(b))),
    );
  }

  // 5 — old persisted entity variants still hydrate unchanged (additive union)
  {
    const mixed = [
      {
        queueId: 'q-t',
        schemaVersion: QUEUE_SCHEMA_VERSION,
        scope: A,
        entity: 'transaction',
        op: 'create',
        entityId: 'txn-1',
        payload: td(),
        enqueuedAt: T0,
        attemptCount: 0,
      },
      {
        queueId: 'q-c',
        schemaVersion: QUEUE_SCHEMA_VERSION,
        scope: A,
        entity: 'card',
        op: 'create',
        entityId: 'card-1',
        payload: { name: 'Visa' } as NewCardDraft,
        enqueuedAt: T0,
        attemptCount: 0,
      },
      {
        queueId: 'q-cb',
        schemaVersion: QUEUE_SCHEMA_VERSION,
        scope: A,
        entity: 'categoryBudget',
        op: 'delete',
        entityId: 'cat-9',
        expectedCategoryUpdatedAt: FROZEN,
        expectedBudgetUpdatedAt: null,
        enqueuedAt: T0,
        attemptCount: 0,
      },
      plCreateObj({ queueId: 'q-p' }),
    ];
    const { records, dropped } = sanitizePendingWrites(mixed);
    check(
      '5 transaction/card/categoryBudget + planned all hydrate, none dropped',
      dropped === 0 &&
        records.length === 4 &&
        records.map((r) => r.entity).join(',') === 'transaction,card,categoryBudget,planned',
      JSON.stringify({ dropped, entities: records.map((r) => r.entity) }),
    );
  }

  /* ============================= DEDUP ============================= */

  const base: PendingWrite[] = [];

  // 6 — identical CREATE re-enqueue is an idempotent no-op (same request)
  {
    const c1 = makePendingPlannedCreate({ scope: A, entityId: 'p-1', payload: pd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingPlannedCreate({ scope: A, entityId: 'p-1', payload: pd(), queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '6 identical CREATE -> deduped, queue length 1, original kept',
      r2.ok === true && r2.deduped === true && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }

  // 7 — a DIFFERING CREATE for the same id is existing-pending (never overwritten)
  {
    const c1 = makePendingPlannedCreate({ scope: A, entityId: 'p-1', payload: pd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingPlannedCreate({
      scope: A,
      entityId: 'p-1',
      payload: pd({ amount: 250000 }),
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '7 differing CREATE (amount) -> refused existing-pending, original untouched',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 8 — UPDATE: token OR draft difference is respected (never blind-merged)
  {
    const u1 = makePendingPlannedUpdate({
      scope: A,
      entityId: 'p-1',
      payload: pd({ amount: 120000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, u1);
    // same token, DIFFERENT draft -> existing-pending
    const u2 = makePendingPlannedUpdate({
      scope: A,
      entityId: 'p-1',
      payload: pd({ amount: 150000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], u2);
    // DIFFERENT token, same draft -> existing-pending
    const u3 = makePendingPlannedUpdate({
      scope: A,
      entityId: 'p-1',
      payload: pd({ amount: 120000 }),
      expectedUpdatedAt: FROZEN2,
      queueId: 'q3',
    });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], u3);
    // identical token + draft -> deduped
    const u4 = makePendingPlannedUpdate({
      scope: A,
      entityId: 'p-1',
      payload: pd({ amount: 120000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q4',
    });
    const r4 = enqueuePendingWrite(r1.ok ? r1.queue : [], u4);
    check(
      '8 UPDATE token/draft difference respected; identical is deduped',
      r2.ok === false &&
        r2.reason === 'existing-pending' &&
        r3.ok === false &&
        r3.reason === 'existing-pending' &&
        r4.ok === true &&
        r4.deduped === true,
      JSON.stringify({ r2, r3, r4 }),
    );
  }

  // 9 — DELETE: a token difference is a different request
  {
    const d1 = makePendingPlannedDelete({ scope: A, entityId: 'p-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, d1);
    const d2 = makePendingPlannedDelete({ scope: A, entityId: 'p-1', expectedUpdatedAt: FROZEN2, queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], d2);
    const d3 = makePendingPlannedDelete({ scope: A, entityId: 'p-1', expectedUpdatedAt: FROZEN, queueId: 'q3' });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], d3);
    check(
      '9 DELETE differing token -> existing-pending; same token -> deduped',
      r2.ok === false && r2.reason === 'existing-pending' && r3.ok === true && r3.deduped === true,
      JSON.stringify({ r2, r3 }),
    );
  }

  /* ==================== ACK MATCHER (pure) ==================== */

  // 17/19 — serverPlannedConfirmsUpdate: content match (trim-aware), not updatedAt
  {
    const row = serverPl('p-1', { name: '월세', memo: '집주인' });
    check(
      '17/19 same content (raw draft has untrimmed name/memo) -> confirms',
      serverPlannedConfirmsUpdate(row, pd({ name: '  월세  ', memo: '  집주인  ' })) === true,
      '',
    );
    check(
      '18/20 different amount -> does NOT confirm',
      serverPlannedConfirmsUpdate(row, pd({ name: '월세', memo: '집주인', amount: 999 })) === false,
      '',
    );
    check(
      '21 different name -> does NOT confirm (stale concurrent server edit never "matched")',
      serverPlannedConfirmsUpdate(serverPl('p-1', { name: '전세' }), pd({ name: '월세' })) === false,
      '',
    );
  }

  /* ========================= MANAGEMENT ========================= */

  // 24 — pending CREATE: synthetic management row ONLY, absent from data.planned
  {
    const server = financeWith([]);
    const ops: PendingWrite[] = [
      makePendingPlannedCreate({ scope: A, entityId: 'p-1', payload: pd({ amount: 55000 }), queueId: 'q1' }),
    ];
    const { data, plannedManagement } = composeFinance(server, ops);
    check(
      '24 pending CREATE -> synthetic row in plannedManagement only, NOT in data.planned',
      data.planned.length === 0 &&
        plannedManagement.rows.length === 1 &&
        plannedManagement.rows[0].id === 'p-1' &&
        plannedManagement.rows[0].amount === 55000 &&
        plannedManagement.syntheticIds.has('p-1') &&
        plannedManagement.opById.get('p-1') === 'create',
      JSON.stringify(plannedManagement),
    );
  }

  // 25 — pending UPDATE: management overlay only, data.planned authoritative
  {
    const server = financeWith([serverPl('p-1', { amount: 100000 })]);
    const ops: PendingWrite[] = [
      makePendingPlannedUpdate({
        scope: A,
        entityId: 'p-1',
        payload: pd({ amount: 120000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
    ];
    const { data, plannedManagement } = composeFinance(server, ops);
    check(
      '25 pending UPDATE -> overlay ONLY in plannedManagement, data.planned still 100000',
      data.planned[0].amount === 100000 &&
        plannedManagement.rows[0].amount === 120000 &&
        plannedManagement.opById.get('p-1') === 'update' &&
        !plannedManagement.syntheticIds.has('p-1'),
      JSON.stringify(plannedManagement),
    );
  }

  // 26 — pending (not-failed) DELETE: hidden from management rows, kept in data.planned
  {
    const server = financeWith([serverPl('p-1'), serverPl('p-2', { name: '보험' })]);
    const ops: PendingWrite[] = [
      makePendingPlannedDelete({ scope: A, entityId: 'p-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, plannedManagement } = composeFinance(server, ops);
    check(
      '26 pending DELETE -> hidden from plannedManagement.rows, still authoritative in data.planned',
      data.planned.length === 2 &&
        plannedManagement.rows.length === 1 &&
        plannedManagement.rows[0].id === 'p-2' &&
        plannedManagement.hiddenIds.includes('p-1'),
      JSON.stringify(plannedManagement),
    );
  }

  // 27/28 — failed UPDATE + server row present -> AUTHORITATIVE wins, attempted kept as metadata
  {
    const server = financeWith([serverPl('p-1', { amount: 150000 })]); // device B already won with 150k
    const ops: PendingWrite[] = [
      makePendingPlannedUpdate({
        scope: A,
        entityId: 'p-1',
        payload: pd({ amount: 120000 }), // A's stale offline draft
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failed = new Set(['p-1']);
    const { data, plannedManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '27 failed UPDATE + server row -> management row shows AUTHORITATIVE 150000, never the 120000 draft',
      data.planned[0].amount === 150000 &&
        plannedManagement.rows[0].amount === 150000 &&
        plannedManagement.failedIds.has('p-1') &&
        !plannedManagement.syntheticIds.has('p-1'),
      JSON.stringify(plannedManagement),
    );
    check(
      '28 attempted local draft preserved as conflict metadata only',
      plannedManagement.attemptedDraftById.get('p-1')?.amount === 120000,
      JSON.stringify([...plannedManagement.attemptedDraftById]),
    );
  }

  // 29 — orphan failed UPDATE (server row gone) -> synthetic display-only row
  {
    const server = financeWith([]); // B deleted it while A was offline
    const ops: PendingWrite[] = [
      makePendingPlannedUpdate({
        scope: A,
        entityId: 'p-1',
        payload: pd({ amount: 120000 }),
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failed = new Set(['p-1']);
    const { data, plannedManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '29 orphan failed UPDATE -> synthetic display-only row, absent from data.planned',
      data.planned.length === 0 &&
        plannedManagement.rows.length === 1 &&
        plannedManagement.rows[0].amount === 120000 &&
        plannedManagement.syntheticIds.has('p-1') &&
        plannedManagement.failedIds.has('p-1') &&
        plannedManagement.attemptedDraftById.get('p-1')?.amount === 120000,
      JSON.stringify(plannedManagement),
    );
  }

  // 30 — failed DELETE -> authoritative row restored/visible, marked failed
  {
    const server = financeWith([serverPl('p-1', { amount: 100000 })]);
    const ops: PendingWrite[] = [
      makePendingPlannedDelete({ scope: A, entityId: 'p-1', expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['p-1']);
    const { data, plannedManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '30 failed DELETE -> authoritative row stays visible, marked failed (never permanently hidden)',
      data.planned.length === 1 &&
        plannedManagement.rows.length === 1 &&
        plannedManagement.rows[0].id === 'p-1' &&
        plannedManagement.opById.get('p-1') === 'delete' &&
        plannedManagement.failedIds.has('p-1') &&
        plannedManagement.hiddenIds.length === 0,
      JSON.stringify(plannedManagement),
    );
  }

  /* ====================== DATA SEPARATION ====================== */

  // 31/32/33 — data.planned / plannedMeta are NEVER mutated by any planned op
  {
    const meta = { 'p-1': { updatedAt: 'SRV-V1', createdBy: 'u-A' } };
    const server = financeWith([serverPl('p-1', { amount: 100000 })], meta);
    const ops: PendingWrite[] = [
      makePendingPlannedCreate({ scope: A, entityId: 'p-2', payload: pd(), queueId: 'q1' }),
      makePendingPlannedUpdate({
        scope: A,
        entityId: 'p-1',
        payload: pd({ amount: 777 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q2',
      }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '31/32 data.planned untouched by pending CREATE + UPDATE',
      data.planned.length === 1 && data.planned[0].amount === 100000 && data.planned === server.planned,
      JSON.stringify(data.planned),
    );
    check(
      '34 plannedMeta remains authoritative (same reference)',
      data.plannedMeta === server.plannedMeta && data.plannedMeta['p-1'].updatedAt === 'SRV-V1',
      JSON.stringify(data.plannedMeta),
    );
  }
  {
    const server = financeWith([serverPl('p-1')]);
    const ops: PendingWrite[] = [
      makePendingPlannedDelete({ scope: A, entityId: 'p-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '33 data.planned untouched by pending DELETE (only plannedManagement hides it)',
      data.planned.length === 1 && data.planned === server.planned,
      JSON.stringify(data.planned),
    );
  }

  // 35 — with only non-planned ops present, the Home-authoritative planned
  // source (`data.planned` === the server snapshot's array) is NOT replaced,
  // and plannedManagement just mirrors it 1:1.
  {
    const server = financeWith([serverPl('p-1')]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
    ];
    const { data, plannedManagement } = composeFinance(server, ops);
    check(
      '35 no planned ops -> data.planned untouched (=== server.planned), plannedManagement mirrors it',
      data.planned === server.planned &&
        plannedManagement.rows.length === 1 &&
        plannedManagement.rows[0].id === 'p-1' &&
        plannedManagement.opById.size === 0 &&
        plannedManagement.failedIds.size === 0,
      '',
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 36 — scope isolation: household B never sees household A's planned op
  {
    const q: PendingWrite[] = [
      makePendingPlannedCreate({ scope: A, entityId: 'p-1', payload: pd(), queueId: 'qa' }),
      makePendingPlannedCreate({ scope: B, entityId: 'p-2', payload: pd(), queueId: 'qb' }),
    ];
    const forA = opsForScope(q, A.userId, A.householdId);
    const forB = opsForScope(q, B.userId, B.householdId);
    check(
      '36 opsForScope isolates planned ops per (userId, householdId)',
      forA.length === 1 && forA[0].queueId === 'qa' && forB.length === 1 && forB[0].queueId === 'qb',
      JSON.stringify({ forA: forA.map((o) => o.queueId), forB: forB.map((o) => o.queueId) }),
    );
  }

  // 40 — a mix with transaction + card ops leaves BOTH planned data and the
  // other entities' behaviour unchanged (no cross-entity regression)
  {
    const server = financeWith([serverPl('p-1', { amount: 100000 })]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
      makePendingCardCreate({ scope: A, entityId: 'card-1', payload: { name: 'Visa' } as NewCardDraft, queueId: 'q2' }),
      makePendingPlannedUpdate({
        scope: A,
        entityId: 'p-1',
        payload: pd({ amount: 500 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q3',
      }),
    ];
    const { data, plannedManagement, cardManagement } = composeFinance(server, ops);
    check(
      '40 transaction + card + planned mix -> planned data authoritative, card overlay still works',
      data.planned[0].amount === 100000 &&
        plannedManagement.rows[0].amount === 500 &&
        data.transactions.some((t) => t.id === 'txn-1') &&
        cardManagement.rows.some((c) => c.id === 'card-1'),
      '',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
