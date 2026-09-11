/**
 * Static verification for STEP 16-H2-F1 — recurring-rule CREATE / FULL
 * UPDATE / ACTIVE-toggle UPDATE / soft DELETE added to the pure Offline
 * Write Queue core: record shapes, the union-aware validator, the dedup /
 * existing-pending policy (including FULL-vs-ACTIVE never being the same
 * request even though both share `entity:'recurring', op:'update'`), the
 * DISPLAY-ONLY `recurringManagement` overlay (NEVER merged into
 * `data.recurring` / `data.recurringMeta`), and the
 * `serverRecurringConfirmsUpdate` / `serverRecurringConfirmsActive` ack
 * matchers.
 *
 * Mirrors src/lib/offlineQueue.planned.cases.ts. ENGINE ONLY — no UI wiring
 * is exercised here. RunOp dispatch + the ack reconcile live in
 * src/services/offlineQueue/coordinator.recurring.cases.ts.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewRecurringDraft } from '@/lib/remoteRecurringWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingCardCreate,
  makePendingRecurringActiveUpdate,
  makePendingRecurringCreate,
  makePendingRecurringDelete,
  makePendingRecurringUpdate,
  makePendingTransactionCreate,
  opsForScope,
  sanitizePendingWrites,
  serverRecurringConfirmsActive,
  serverRecurringConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { RecurringRule } from '@/store/types';

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

const rd = (over: Partial<NewRecurringDraft> = {}): NewRecurringDraft => ({
  type: 'expense',
  name: '넷플릭스',
  amount: 17000,
  category: 'subscription',
  frequency: 'monthly',
  dayOfMonth: 15,
  dayOfWeek: null,
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

const recCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-rc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'recurring',
  op: 'create',
  entityId: 'rec-1',
  payload: rd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const recFullUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-ru',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'recurring',
  op: 'update',
  updateKind: 'full',
  entityId: 'rec-1',
  payload: rd(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const recActiveUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-ra',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'recurring',
  op: 'update',
  updateKind: 'active',
  entityId: 'rec-1',
  payload: { active: false },
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const recDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-rd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'recurring',
  op: 'delete',
  entityId: 'rec-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverRec = (id: string, over: Partial<RecurringRule> = {}): RecurringRule => ({
  id,
  type: 'expense',
  name: '넷플릭스',
  amount: 17000,
  category: 'subscription',
  frequency: 'monthly',
  dayOfMonth: 15,
  active: true,
  createdAt: T0,
  ...over,
});

function financeWith(
  recurring: RecurringRule[],
  recurringMeta: Record<string, { updatedAt: string; createdBy: string | null }> = {},
): RemoteFinanceData {
  return {
    transactions: [],
    transactionMeta: {},
    cards: [],
    cardMeta: {},
    budgets: {},
    budgetMeta: {},
    categoryMeta: {},
    recurring,
    recurringMeta:
      Object.keys(recurringMeta).length > 0
        ? recurringMeta
        : Object.fromEntries(recurring.map((r) => [r.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }])),
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

export async function runOfflineQueueRecurringCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ SCHEMA ============================ */

  // 1 — CREATE valid; a CREATE carries no token / no updateKind
  {
    const v = validatePendingWrite(recCreateObj());
    check(
      '1 CREATE valid, no expectedUpdatedAt/updateKind',
      !!v && v.entity === 'recurring' && v.op === 'create' && !('expectedUpdatedAt' in v) && !('updateKind' in v),
      JSON.stringify(v),
    );
    check(
      '1b CREATE with a token or updateKind is rejected',
      validatePendingWrite(recCreateObj({ expectedUpdatedAt: FROZEN })) === null &&
        validatePendingWrite(recCreateObj({ updateKind: 'full' })) === null,
      '',
    );
  }

  // 2 — FULL UPDATE valid + frozen token REQUIRED
  {
    const v = validatePendingWrite(recFullUpdateObj());
    check(
      '2 FULL UPDATE valid, updateKind full, frozen token',
      !!v && v.op === 'update' && v.entity === 'recurring' && 'updateKind' in v && v.updateKind === 'full' && v.expectedUpdatedAt === FROZEN,
      JSON.stringify(v),
    );
    check(
      '2b FULL UPDATE without a token is rejected',
      validatePendingWrite(recFullUpdateObj({ expectedUpdatedAt: undefined })) === null,
      '',
    );
  }

  // 3 — ACTIVE UPDATE valid + frozen token REQUIRED; payload EXACTLY {active}
  {
    const v = validatePendingWrite(recActiveUpdateObj());
    check(
      '3 ACTIVE UPDATE valid, updateKind active, payload exactly {active}',
      !!v && v.op === 'update' && v.entity === 'recurring' && 'updateKind' in v && v.updateKind === 'active' && JSON.stringify(v.payload) === '{"active":false}',
      JSON.stringify(v),
    );
    check(
      '3b ACTIVE UPDATE with an extra field in payload is rejected',
      validatePendingWrite(recActiveUpdateObj({ payload: { active: false, name: 'x' } })) === null &&
        validatePendingWrite(recActiveUpdateObj({ payload: { active: 'nope' } })) === null,
      '',
    );
  }

  // 4 — DELETE valid + frozen token REQUIRED, no payload/updateKind
  {
    const v = validatePendingWrite(recDeleteObj());
    check(
      '4 DELETE valid with frozen token, no payload/updateKind',
      !!v && v.op === 'delete' && v.entity === 'recurring' && !('payload' in v) && !('updateKind' in v),
      JSON.stringify(v),
    );
    check(
      '4b DELETE without a token / with a payload is rejected',
      validatePendingWrite(recDeleteObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(recDeleteObj({ payload: rd() })) === null,
      '',
    );
  }

  // 5 — malformed persisted recurring queue records are rejected
  {
    const bad = [
      recCreateObj({ payload: rd({ amount: 0 }) }),
      recCreateObj({ payload: rd({ frequency: 'monthly', dayOfMonth: 40 }) }),
      recCreateObj({ payload: rd({ frequency: 'weekly', dayOfWeek: 8 }) }),
      recCreateObj({ payload: rd({ name: '   ' }) }),
      recCreateObj({ payload: { ...rd(), id: 'rec-1' } }),
      recCreateObj({ payload: { ...rd(), active: true } }), // active never in a recurring draft
      recCreateObj({ payload: { ...rd(), last_run: T0 } }),
      recFullUpdateObj({ payload: { ...rd(), updated_at: T0 } }),
      recFullUpdateObj({ updateKind: 'bogus' }),
      { ...recFullUpdateObj(), updateKind: undefined }, // update MUST carry a real updateKind
      { ...recCreateObj(), entityId: '' },
    ];
    check(
      '5 malformed recurring persisted ops all reject',
      bad.every((b) => validatePendingWrite(b) === null),
      JSON.stringify(bad.map((b) => validatePendingWrite(b))),
    );
  }

  // 6 — old persisted entity variants still hydrate unchanged (additive union)
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
      recCreateObj({ queueId: 'q-r' }),
    ];
    const { records, dropped } = sanitizePendingWrites(mixed);
    check(
      '6 transaction/card + recurring all hydrate, none dropped',
      dropped === 0 && records.length === 3 && records.map((r) => r.entity).join(',') === 'transaction,card,recurring',
      JSON.stringify({ dropped, entities: records.map((r) => r.entity) }),
    );
  }

  /* ============================= DEDUP ============================= */

  const base: PendingWrite[] = [];

  // 7 — identical CREATE re-enqueue is an idempotent no-op
  {
    const c1 = makePendingRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd(), queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '7 identical CREATE -> deduped, queue length 1, original kept',
      r2.ok === true && r2.deduped === true && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }

  // 8 — a DIFFERING CREATE for the same id is existing-pending
  {
    const c1 = makePendingRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingRecurringCreate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 25000 }),
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '8 differing CREATE (amount) -> refused existing-pending, original untouched',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 9 — FULL UPDATE: same token + same draft -> deduped; differing draft or
  // token -> existing-pending
  {
    const u1 = makePendingRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 20000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, u1);
    const u2 = makePendingRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 30000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], u2);
    const u3 = makePendingRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 20000 }),
      expectedUpdatedAt: FROZEN2,
      queueId: 'q3',
    });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], u3);
    const u4 = makePendingRecurringUpdate({
      scope: A,
      entityId: 'rec-1',
      payload: rd({ amount: 20000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q4',
    });
    const r4 = enqueuePendingWrite(r1.ok ? r1.queue : [], u4);
    check(
      '9 FULL UPDATE token/draft difference respected; identical is deduped',
      r2.ok === false && r2.reason === 'existing-pending' &&
        r3.ok === false && r3.reason === 'existing-pending' &&
        r4.ok === true && r4.deduped === true,
      JSON.stringify({ r2, r3, r4 }),
    );
  }

  // 10 — ACTIVE UPDATE: same token + same desired value -> deduped; differing -> existing-pending
  {
    const a1 = makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, a1);
    const a2 = makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: true, expectedUpdatedAt: FROZEN, queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], a2);
    const a3 = makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: FROZEN2, queueId: 'q3' });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], a3);
    const a4 = makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: FROZEN, queueId: 'q4' });
    const r4 = enqueuePendingWrite(r1.ok ? r1.queue : [], a4);
    check(
      '10 ACTIVE UPDATE token/value difference respected; identical is deduped',
      r2.ok === false && r2.reason === 'existing-pending' &&
        r3.ok === false && r3.reason === 'existing-pending' &&
        r4.ok === true && r4.deduped === true,
      JSON.stringify({ r2, r3, r4 }),
    );
  }

  // 11 — FULL vs ACTIVE at the SAME id is NEVER the same request: the second
  // one queued is refused as existing-pending, never stacked/compacted.
  {
    const full = makePendingRecurringUpdate({ scope: A, entityId: 'rec-1', payload: rd(), expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, full);
    const active = makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: FROZEN, queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], active);
    check(
      '11 FULL vs ACTIVE (same id, same token) -> existing-pending, never stacked',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 12 — DELETE: a token difference is a different request
  {
    const d1 = makePendingRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, d1);
    const d2 = makePendingRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: FROZEN2, queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], d2);
    const d3 = makePendingRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: FROZEN, queueId: 'q3' });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], d3);
    check(
      '12 DELETE differing token -> existing-pending; same token -> deduped',
      r2.ok === false && r2.reason === 'existing-pending' && r3.ok === true && r3.deduped === true,
      JSON.stringify({ r2, r3 }),
    );
  }

  /* ==================== ACK MATCHERS (pure) ==================== */

  {
    const row = serverRec('rec-1', { name: '넷플릭스', amount: 17000 });
    check(
      '23/26/28 serverRecurringConfirmsUpdate: content match (trimmed name) -> confirms',
      serverRecurringConfirmsUpdate(row, rd({ name: '  넷플릭스  ' })) === true,
      '',
    );
    check(
      '24/25 serverRecurringConfirmsUpdate: different amount -> does NOT confirm',
      serverRecurringConfirmsUpdate(row, rd({ amount: 999 })) === false,
      '',
    );
    check(
      '26 serverRecurringConfirmsActive: desired false + server false -> confirms',
      serverRecurringConfirmsActive(serverRec('rec-1', { active: false }), false) === true,
      '',
    );
    check(
      '27 serverRecurringConfirmsActive: desired false + server true -> does NOT confirm',
      serverRecurringConfirmsActive(serverRec('rec-1', { active: true }), false) === false,
      '',
    );
    check(
      '28 serverRecurringConfirmsActive: desired true + server true -> confirms',
      serverRecurringConfirmsActive(serverRec('rec-1', { active: true }), true) === true,
      '',
    );
    check(
      '29 serverRecurringConfirmsActive: desired true + server false -> does NOT confirm',
      serverRecurringConfirmsActive(serverRec('rec-1', { active: false }), true) === false,
      '',
    );
  }

  /* ========================= MANAGEMENT ========================= */

  // 32 — pending CREATE: synthetic management row ONLY, absent from data.recurring
  {
    const server = financeWith([]);
    const ops: PendingWrite[] = [
      makePendingRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 25000 }), queueId: 'q1' }),
    ];
    const { data, recurringManagement } = composeFinance(server, ops);
    check(
      '32 pending CREATE -> synthetic row in recurringManagement only, NOT in data.recurring',
      data.recurring.length === 0 &&
        recurringManagement.rows.length === 1 &&
        recurringManagement.rows[0].id === 'rec-1' &&
        recurringManagement.rows[0].amount === 25000 &&
        recurringManagement.rows[0].active === true &&
        recurringManagement.syntheticIds.has('rec-1') &&
        recurringManagement.opById.get('rec-1') === 'create',
      JSON.stringify(recurringManagement),
    );
  }

  // 33 — pending FULL UPDATE: management overlay only, data.recurring authoritative
  {
    const server = financeWith([serverRec('rec-1', { amount: 17000 })]);
    const ops: PendingWrite[] = [
      makePendingRecurringUpdate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 20000 }), expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, recurringManagement } = composeFinance(server, ops);
    check(
      '33 pending FULL UPDATE -> overlay ONLY in recurringManagement, data.recurring still 17000',
      data.recurring[0].amount === 17000 &&
        recurringManagement.rows[0].amount === 20000 &&
        recurringManagement.opById.get('rec-1') === 'update' &&
        !recurringManagement.syntheticIds.has('rec-1'),
      JSON.stringify(recurringManagement),
    );
  }

  // 34 — pending ACTIVE toggle: optimistic overlay management-only, authoritative active unchanged
  {
    const server = financeWith([serverRec('rec-1', { active: true })]);
    const ops: PendingWrite[] = [
      makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, recurringManagement } = composeFinance(server, ops);
    check(
      '34 pending ACTIVE toggle -> management shows active:false, data.recurring still active:true',
      data.recurring[0].active === true &&
        recurringManagement.rows[0].active === false &&
        recurringManagement.opById.get('rec-1') === 'update',
      JSON.stringify(recurringManagement),
    );
  }

  // 35 — pending (not-failed) DELETE: hidden from management rows, kept in data.recurring
  {
    const server = financeWith([serverRec('rec-1'), serverRec('rec-2', { name: '통신비' })]);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, recurringManagement } = composeFinance(server, ops);
    check(
      '35 pending DELETE -> hidden from recurringManagement.rows, still authoritative in data.recurring',
      data.recurring.length === 2 &&
        recurringManagement.rows.length === 1 &&
        recurringManagement.rows[0].id === 'rec-2' &&
        recurringManagement.hiddenIds.includes('rec-1'),
      JSON.stringify(recurringManagement),
    );
  }

  // 36/38 — failed FULL UPDATE + server row present -> AUTHORITATIVE wins, attempted kept as metadata
  {
    const server = financeWith([serverRec('rec-1', { amount: 30000 })]); // device B already won with 30000
    const ops: PendingWrite[] = [
      makePendingRecurringUpdate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 20000 }), expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['rec-1']);
    const { data, recurringManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '36 failed FULL UPDATE + server row -> management shows AUTHORITATIVE 30000, never the 20000 draft',
      data.recurring[0].amount === 30000 &&
        recurringManagement.rows[0].amount === 30000 &&
        recurringManagement.failedIds.has('rec-1') &&
        !recurringManagement.syntheticIds.has('rec-1'),
      JSON.stringify(recurringManagement),
    );
    check(
      '38 attempted local draft preserved as conflict metadata only',
      recurringManagement.attemptedDraftById.get('rec-1')?.amount === 20000,
      JSON.stringify([...recurringManagement.attemptedDraftById]),
    );
  }

  // 37/39 — failed ACTIVE toggle + server row present -> authoritative active
  // SNAPS BACK, never sticks at the failed attempted value
  {
    const server = financeWith([serverRec('rec-1', { active: true })]); // B re-activated it (or never paused)
    const ops: PendingWrite[] = [
      makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['rec-1']);
    const { data, recurringManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '37 failed ACTIVE toggle + server row -> management shows AUTHORITATIVE active:true, never sticks at false',
      data.recurring[0].active === true &&
        recurringManagement.rows[0].active === true &&
        recurringManagement.failedIds.has('rec-1') &&
        !recurringManagement.syntheticIds.has('rec-1'),
      JSON.stringify(recurringManagement),
    );
    check(
      '39 attempted active value preserved as conflict metadata only',
      recurringManagement.attemptedActiveById.get('rec-1') === false,
      JSON.stringify([...recurringManagement.attemptedActiveById]),
    );
  }

  // 40 — orphan FULL UPDATE (server row gone) -> synthetic display-only row
  {
    const server = financeWith([]); // B deleted it while A was offline
    const ops: PendingWrite[] = [
      makePendingRecurringUpdate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 20000 }), expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['rec-1']);
    const { data, recurringManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '40 orphan FULL UPDATE -> synthetic display-only row, absent from data.recurring',
      data.recurring.length === 0 &&
        recurringManagement.rows.length === 1 &&
        recurringManagement.rows[0].amount === 20000 &&
        recurringManagement.syntheticIds.has('rec-1') &&
        recurringManagement.failedIds.has('rec-1') &&
        recurringManagement.attemptedDraftById.get('rec-1')?.amount === 20000,
      JSON.stringify(recurringManagement),
    );
  }

  // 41 — orphan ACTIVE UPDATE (server row gone): NEVER a fabricated row (an
  // `{active}`-only payload has no name/amount/category to show), but STILL
  // tracked as failed + attempted metadata for traceability/discard.
  {
    const server = financeWith([]);
    const ops: PendingWrite[] = [
      makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['rec-1']);
    const { data, recurringManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '41 orphan ACTIVE UPDATE -> NO fabricated row/opById entry, but failed + attemptedActive tracked',
      data.recurring.length === 0 &&
        recurringManagement.rows.length === 0 &&
        !recurringManagement.opById.has('rec-1') &&
        !recurringManagement.syntheticIds.has('rec-1') &&
        recurringManagement.failedIds.has('rec-1') &&
        recurringManagement.attemptedActiveById.get('rec-1') === false,
      JSON.stringify(recurringManagement),
    );
  }

  // 42 — failed DELETE -> authoritative row restored/visible, marked failed
  {
    const server = financeWith([serverRec('rec-1', { amount: 17000 })]);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['rec-1']);
    const { data, recurringManagement } = composeFinance(server, ops, undefined, undefined, undefined, undefined, undefined, undefined, failed);
    check(
      '42 failed DELETE -> authoritative row stays visible, marked failed (never permanently hidden)',
      data.recurring.length === 1 &&
        recurringManagement.rows.length === 1 &&
        recurringManagement.rows[0].id === 'rec-1' &&
        recurringManagement.opById.get('rec-1') === 'delete' &&
        recurringManagement.failedIds.has('rec-1') &&
        recurringManagement.hiddenIds.length === 0,
      JSON.stringify(recurringManagement),
    );
  }

  /* ====================== DATA SEPARATION ====================== */

  // 43/44/45 — data.recurring / recurringMeta are NEVER mutated by any recurring op
  {
    const meta = { 'rec-1': { updatedAt: 'SRV-V1', createdBy: 'u-A' } };
    const server = financeWith([serverRec('rec-1', { amount: 17000, active: true })], meta);
    const ops: PendingWrite[] = [
      makePendingRecurringCreate({ scope: A, entityId: 'rec-2', payload: rd(), queueId: 'q1' }),
      makePendingRecurringUpdate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 999 }), expectedUpdatedAt: 'SRV-V1', queueId: 'q2' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '43/44 data.recurring untouched by pending CREATE + FULL UPDATE',
      data.recurring.length === 1 && data.recurring[0].amount === 17000 && data.recurring === server.recurring,
      JSON.stringify(data.recurring),
    );
    check(
      '47 recurringMeta remains authoritative (same reference)',
      data.recurringMeta === server.recurringMeta && data.recurringMeta['rec-1'].updatedAt === 'SRV-V1',
      JSON.stringify(data.recurringMeta),
    );
  }
  {
    const server = financeWith([serverRec('rec-1', { active: true })]);
    const ops: PendingWrite[] = [
      makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '45 data.recurring untouched by pending ACTIVE toggle',
      data.recurring[0].active === true && data.recurring === server.recurring,
      JSON.stringify(data.recurring),
    );
  }
  {
    const server = financeWith([serverRec('rec-1')]);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '46 data.recurring untouched by pending DELETE (only recurringManagement hides it)',
      data.recurring.length === 1 && data.recurring === server.recurring,
      JSON.stringify(data.recurring),
    );
  }

  // 48 — no lastRun/materialization mutation: createdAt/lastRun on the
  // authoritative row are untouched by ANY recurring op (composeFinance
  // never rewrites `data.recurring` entries in place).
  {
    const server = financeWith([serverRec('rec-1', { lastRun: '2026-08-01T00:00:00.000Z' })]);
    const ops: PendingWrite[] = [
      makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-1', active: false, expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '48 lastRun on the authoritative row is untouched by a queued op',
      data.recurring[0].lastRun === '2026-08-01T00:00:00.000Z',
      JSON.stringify(data.recurring[0]),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 49 — scope isolation: household B never sees household A's recurring op
  {
    const q: PendingWrite[] = [
      makePendingRecurringCreate({ scope: A, entityId: 'rec-1', payload: rd(), queueId: 'qa' }),
      makePendingRecurringCreate({ scope: B, entityId: 'rec-2', payload: rd(), queueId: 'qb' }),
    ];
    const forA = opsForScope(q, A.userId, A.householdId);
    const forB = opsForScope(q, B.userId, B.householdId);
    check(
      '49 opsForScope isolates recurring ops per (userId, householdId)',
      forA.length === 1 && forA[0].queueId === 'qa' && forB.length === 1 && forB[0].queueId === 'qb',
      JSON.stringify({ forA: forA.map((o) => o.queueId), forB: forB.map((o) => o.queueId) }),
    );
  }

  // 53 — a mix with transaction + card + planned ops leaves recurring data
  // authoritative and every other entity's overlay unchanged (no cross-entity regression)
  {
    const server = financeWith([serverRec('rec-1', { amount: 17000 })]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
      makePendingCardCreate({ scope: A, entityId: 'card-1', payload: { name: 'Visa' } as NewCardDraft, queueId: 'q2' }),
      makePendingRecurringUpdate({ scope: A, entityId: 'rec-1', payload: rd({ amount: 500 }), expectedUpdatedAt: 'SRV-V1', queueId: 'q3' }),
    ];
    const { data, recurringManagement, cardManagement } = composeFinance(server, ops);
    check(
      '53 transaction + card + recurring mix -> recurring data authoritative, card overlay still works',
      data.recurring[0].amount === 17000 &&
        recurringManagement.rows[0].amount === 500 &&
        data.transactions.some((t) => t.id === 'txn-1') &&
        cardManagement.rows.some((c) => c.id === 'card-1'),
      '',
    );
  }

  /* ================ AGGREGATE ISOLATION (device QA regression) ================
   * Real-device finding: the Recurring screen's "이번 달 반복 예정" total /
   * 활성·정지 counts must be computed from AUTHORITATIVE `data.recurring`
   * ONLY (mirrors app/recurring.tsx's `monthlyTotal`/`activeCount`/
   * `pausedCount`, which read `financeRead().recurring` — never
   * `recurringManagementRows`). A pending/failed recurring op — CREATE,
   * FULL UPDATE, ACTIVE toggle, or DELETE — must NEVER move these numbers;
   * only an authoritative server refresh (a NEW snapshot) may. These cases
   * exercise the exact pipeline the screen reads: `composeFinance(...).data`
   * for the aggregate, `composeFinance(...).recurringManagement.rows` for
   * the (separately, correctly overlaid) list.
   */
  const aggregate = (rows: RecurringRule[]) => ({
    activeSum: rows.filter((r) => r.active).reduce((s, r) => s + r.amount, 0),
    activeCount: rows.filter((r) => r.active).length,
    pausedCount: rows.length - rows.filter((r) => r.active).length,
  });

  // A — authoritative baseline: 50,000(active) + 19,000(active) + 1,000(paused)
  //     -> -69,000 total / active 2 / paused 1.
  {
    const server = financeWith([
      serverRec('rec-A', { amount: 50000, active: true }),
      serverRec('rec-B', { amount: 19000, active: true }),
      serverRec('rec-C', { amount: 1000, active: false }),
    ]);
    const agg = aggregate(server.recurring);
    check(
      'A authoritative baseline -> sum 69000 / active 2 / paused 1',
      agg.activeSum === 69000 && agg.activeCount === 2 && agg.pausedCount === 1,
      JSON.stringify(agg),
    );
  }

  // B — pending DELETE on the 19,000 row: `recurringManagement.rows` hides
  // it (list correctly reflects the pending delete), but the AGGREGATE
  // (computed from `data.recurring`, exactly like app/recurring.tsx) MUST
  // stay -69,000 / active 2 / paused 1 until the server actually acks it —
  // this is the exact scenario from the device report.
  {
    const server = financeWith([
      serverRec('rec-A', { amount: 50000, active: true }),
      serverRec('rec-B', { amount: 19000, active: true }),
      serverRec('rec-C', { amount: 1000, active: false }),
    ]);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-B', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, recurringManagement } = composeFinance(server, ops);
    const authoritativeAgg = aggregate(data.recurring);
    check(
      'B pending DELETE (not yet acked) -> authoritative aggregate UNCHANGED at 69000/2/1',
      authoritativeAgg.activeSum === 69000 && authoritativeAgg.activeCount === 2 && authoritativeAgg.pausedCount === 1,
      JSON.stringify(authoritativeAgg),
    );
    check(
      'B management list correctly hides the pending-delete row (list vs aggregate are separate sources)',
      recurringManagement.rows.length === 2 && !recurringManagement.rows.some((r) => r.id === 'rec-B'),
      JSON.stringify(recurringManagement.rows.map((r) => r.id)),
    );
    // Sanity: computing the aggregate from the MANAGEMENT rows instead
    // (the bug the device report described) WOULD wrongly show 50000/1/1 —
    // documented here so a future regression that swaps the source is
    // caught by case B above, not silently "passing" by accident.
    const wrongAggIfMisSourced = aggregate(recurringManagement.rows);
    check(
      'B (contrast) aggregate-from-management-rows would have been the bug: 50000/1/1',
      wrongAggIfMisSourced.activeSum === 50000 && wrongAggIfMisSourced.activeCount === 1,
      JSON.stringify(wrongAggIfMisSourced),
    );
  }

  // C — after the server actually acks the DELETE (a NEW authoritative
  // snapshot with rec-B gone), the aggregate updates for real.
  {
    const refreshedServer = financeWith([
      serverRec('rec-A', { amount: 50000, active: true }),
      serverRec('rec-C', { amount: 1000, active: false }),
    ]);
    const agg = aggregate(refreshedServer.recurring);
    check(
      'C authoritative refresh after ack -> aggregate updates to 50000/1/1',
      agg.activeSum === 50000 && agg.activeCount === 1 && agg.pausedCount === 1,
      JSON.stringify(agg),
    );
  }

  // D — pending ACTIVE toggle (not yet acked) also leaves the authoritative
  // aggregate untouched, even though the management list optimistically
  // shows the row as paused. (Explicitly requested: toggle semantics
  // themselves are NOT changed by this fix — only re-verified.)
  {
    const server = financeWith([
      serverRec('rec-A', { amount: 50000, active: true }),
      serverRec('rec-B', { amount: 19000, active: true }),
      serverRec('rec-C', { amount: 1000, active: false }),
    ]);
    const ops: PendingWrite[] = [
      makePendingRecurringActiveUpdate({ scope: A, entityId: 'rec-A', active: false, expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, recurringManagement } = composeFinance(server, ops);
    const authoritativeAgg = aggregate(data.recurring);
    check(
      'D pending ACTIVE toggle (not yet acked) -> authoritative aggregate UNCHANGED at 69000/2/1',
      authoritativeAgg.activeSum === 69000 && authoritativeAgg.activeCount === 2 && authoritativeAgg.pausedCount === 1,
      JSON.stringify(authoritativeAgg),
    );
    check(
      'D management list optimistically shows the toggled row as paused (list overlay works as designed)',
      recurringManagement.rows.find((r) => r.id === 'rec-A')?.active === false,
      JSON.stringify(recurringManagement.rows),
    );
  }

  /* ============ CROSS-ROW CONTAMINATION (device QA regression) ============
   * Real-device finding #2: deleting row A (실시간반복테스트) offline was
   * observed to also mark an UNRELATED row B (넷플릭스-테스트) as having a
   * pending ACTIVE toggle. These cases prove the pure engine
   * (`composeFinance` / `composeRecurringManagement`) is NOT the source:
   * no row-object mutation, no B-side overlay from an A-only op set, and
   * lookups are strictly `r.id`-keyed (never index/position-based).
   */

  // E — composing a pending DELETE for A must NOT mutate ANY authoritative
  // row object (A's or B's) — id/active/amount/updatedAt(meta) all intact.
  {
    const rowA = serverRec('rec-A', { amount: 1000, active: true });
    const rowB = serverRec('rec-B', { amount: 50000, active: true });
    const snapshotA = JSON.stringify(rowA);
    const snapshotB = JSON.stringify(rowB);
    const meta = {
      'rec-A': { updatedAt: 'SRV-A-V1', createdBy: 'u-A' },
      'rec-B': { updatedAt: 'SRV-B-V1', createdBy: 'u-A' },
    };
    const server = financeWith([rowA, rowB], meta);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-A', expectedUpdatedAt: 'SRV-A-V1', queueId: 'q1' }),
    ];
    composeFinance(server, ops); // compose once; only inspect the ORIGINAL objects afterward
    check(
      'E composing a pending DELETE never mutates the original row objects (A or B) in place',
      JSON.stringify(rowA) === snapshotA && JSON.stringify(rowB) === snapshotB,
      JSON.stringify({ rowA, rowB }),
    );
    check(
      'E recurringMeta object identity/content also untouched',
      server.recurringMeta['rec-A'].updatedAt === 'SRV-A-V1' && server.recurringMeta['rec-B'].updatedAt === 'SRV-B-V1',
      JSON.stringify(server.recurringMeta),
    );
  }

  // F — with ONLY an A-delete op in the queue, B's management row/active/
  // status must be byte-for-byte identical to its authoritative row, and B
  // must have NO entry in opById/failedIds/attemptedActiveById at all.
  {
    const server = financeWith([
      serverRec('rec-A', { amount: 1000, active: true }),
      serverRec('rec-B', { amount: 50000, active: true }),
    ]);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-A', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { recurringManagement } = composeFinance(server, ops);
    const bRow = recurringManagement.rows.find((r) => r.id === 'rec-B');
    check(
      'F an A-only delete op leaves B out of opById/failedIds/attemptedActiveById entirely',
      !recurringManagement.opById.has('rec-B') &&
        !recurringManagement.failedIds.has('rec-B') &&
        !recurringManagement.attemptedActiveById.has('rec-B') &&
        !recurringManagement.syntheticIds.has('rec-B'),
      JSON.stringify({
        opById: [...recurringManagement.opById],
        failedIds: [...recurringManagement.failedIds],
        attemptedActiveById: [...recurringManagement.attemptedActiveById],
      }),
    );
    check(
      'F B\'s management row is deep-equal to its authoritative row (active:true, untouched)',
      JSON.stringify(bRow) === JSON.stringify(serverRec('rec-B', { amount: 50000, active: true })),
      JSON.stringify(bRow),
    );
  }

  // H — deep-equality of the FULL authoritative array (not just spot ids)
  // before vs after composing a pending DELETE for a DIFFERENT row — every
  // untouched row's every field, in original order.
  {
    const rows = [
      serverRec('rec-A', { amount: 1000, active: true }),
      serverRec('rec-B', { amount: 50000, active: true }),
      serverRec('rec-C', { amount: 1, active: false }),
    ];
    const before = JSON.stringify(rows);
    const server = financeWith(rows);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-A', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      'H composeFinance never touches the authoritative array (same reference, same content)',
      data.recurring === server.recurring && JSON.stringify(data.recurring) === before,
      JSON.stringify(data.recurring),
    );
  }

  // I — management-row lookup is by `r.id`, never by array position: reorder
  // the authoritative array so the DELETED row is LAST, not first, and
  // confirm the correct row (by id) is hidden, not "whichever ended up at
  // index 0".
  {
    const server = financeWith([
      serverRec('rec-B', { amount: 50000, active: true }), // B first this time
      serverRec('rec-A', { amount: 1000, active: true }), // A (the one being deleted) last
    ]);
    const ops: PendingWrite[] = [
      makePendingRecurringDelete({ scope: A, entityId: 'rec-A', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { recurringManagement } = composeFinance(server, ops);
    check(
      'I id-based lookup: reordering the array still hides exactly rec-A, never index-0 (rec-B)',
      recurringManagement.rows.length === 1 &&
        recurringManagement.rows[0].id === 'rec-B' &&
        recurringManagement.rows[0].active === true &&
        recurringManagement.hiddenIds.length === 1 &&
        recurringManagement.hiddenIds[0] === 'rec-A',
      JSON.stringify({ rows: recurringManagement.rows, hidden: recurringManagement.hiddenIds }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
