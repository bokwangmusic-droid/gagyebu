/**
 * Static verification for STEP 16-H2-G1 — savings-goal CREATE / UPDATE / soft
 * DELETE added to the pure Offline Write Queue core: record shapes, the
 * union-aware validator, the dedup / existing-pending policy, the
 * DISPLAY-ONLY `goalManagement` overlay (NEVER merged into `data.goals` /
 * `data.goalMeta` — any other consumer keeps reading authoritative server
 * data), the `saved` field NEVER being part of any payload or ever being
 * overwritten by an UPDATE overlay, and the `serverGoalConfirmsUpdate` ack
 * matcher.
 *
 * Mirrors src/lib/offlineQueue.planned.cases.ts. Goal-movement
 * (deposit/withdraw) is OUT OF SCOPE this step and is never modelled as a
 * `PendingWrite` — not exercised here. ENGINE ONLY — no UI wiring is
 * exercised. RunOp dispatch + the ack reconcile live in
 * src/services/offlineQueue/coordinator.goal.cases.ts.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewGoalDraft } from '@/lib/remoteGoalWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingCardCreate,
  makePendingGoalCreate,
  makePendingGoalDelete,
  makePendingGoalUpdate,
  makePendingTransactionCreate,
  opsForScope,
  sanitizePendingWrites,
  serverGoalConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { Goal } from '@/store/types';

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

const gd = (over: Partial<NewGoalDraft> = {}): NewGoalDraft => ({
  name: '내 집 마련',
  target: 5000000,
  deadline: '2027-01-01',
  icon: '🏠',
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

const goCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-gc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'goal',
  op: 'create',
  entityId: 'goal-1',
  payload: gd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const goUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-gu',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'goal',
  op: 'update',
  entityId: 'goal-1',
  payload: gd(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const goDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-gd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'goal',
  op: 'delete',
  entityId: 'goal-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverGoal = (id: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name: '내 집 마련',
  target: 5000000,
  saved: 0,
  deadline: '2027-01-01',
  icon: '🏠',
  createdAt: T0,
  ...over,
});

function financeWith(
  goals: Goal[],
  goalMeta: Record<string, { updatedAt: string; createdBy: string | null }> = {},
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
    planned: [],
    plannedMeta: {},
    goals,
    goalMeta:
      Object.keys(goalMeta).length > 0
        ? goalMeta
        : Object.fromEntries(goals.map((g) => [g.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }])),
    loans: [],
    loanMeta: {},
    loanPaymentMeta: {},
    customCats: DEFAULT_CUSTOM_CATS,
    notes: '',
    catOrder: DEFAULT_CAT_ORDER,
  };
}

export async function runOfflineQueueGoalCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ SCHEMA ============================ */

  // 1 — CREATE valid; a CREATE carries no token
  {
    const v = validatePendingWrite(goCreateObj());
    check(
      '1 CREATE valid, no expectedUpdatedAt',
      !!v && v.entity === 'goal' && v.op === 'create' && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
    check(
      '1b CREATE with an expectedUpdatedAt is rejected',
      validatePendingWrite(goCreateObj({ expectedUpdatedAt: FROZEN })) === null,
      '',
    );
  }

  // 2 — UPDATE valid + frozen token REQUIRED
  {
    const v = validatePendingWrite(goUpdateObj());
    check(
      '2 UPDATE valid with frozen token',
      !!v && v.op === 'update' && v.entity === 'goal' && v.expectedUpdatedAt === FROZEN,
      JSON.stringify(v),
    );
    check(
      '2b UPDATE without a token is rejected',
      validatePendingWrite(goUpdateObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(goUpdateObj({ expectedUpdatedAt: '' })) === null,
      '',
    );
  }

  // 3 — DELETE valid + frozen token REQUIRED, no payload
  {
    const v = validatePendingWrite(goDeleteObj());
    check(
      '3 DELETE valid with frozen token, no payload',
      !!v && v.op === 'delete' && v.entity === 'goal' && !('payload' in v),
      JSON.stringify(v),
    );
    check(
      '3b DELETE without a token / with a payload is rejected',
      validatePendingWrite(goDeleteObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(goDeleteObj({ payload: gd() })) === null,
      '',
    );
  }

  // 4 — malformed persisted goal queue records are rejected
  {
    const bad = [
      goCreateObj({ payload: gd({ target: 0 }) }), // target must be > 0
      goCreateObj({ payload: gd({ target: -5 }) }),
      goCreateObj({ payload: gd({ target: 1.5 }) }), // not an integer
      goCreateObj({ payload: gd({ deadline: '2026-13-40' }) }), // not a real calendar date
      goCreateObj({ payload: gd({ name: '   ' }) }), // blank name
      goCreateObj({ payload: gd({ icon: '' }) }), // blank icon
      goCreateObj({ payload: { ...gd(), saved: 500 } }), // `saved` NEVER in a payload
      goCreateObj({ payload: { ...gd(), id: 'goal-1' } }), // server/identity field in payload
      goCreateObj({ payload: { ...gd(), household_id: 'h-A' } }),
      goCreateObj({ payload: { ...gd(), updated_at: T0 } }),
      goUpdateObj({ payload: { ...gd(), deleted_at: T0 } }),
      { ...goCreateObj(), entityId: '' },
    ];
    check(
      '4 malformed goal persisted ops all reject',
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
      goCreateObj({ queueId: 'q-g' }),
    ];
    const { records, dropped } = sanitizePendingWrites(mixed);
    check(
      '5 transaction/card/categoryBudget + goal all hydrate, none dropped',
      dropped === 0 &&
        records.length === 4 &&
        records.map((r) => r.entity).join(',') === 'transaction,card,categoryBudget,goal',
      JSON.stringify({ dropped, entities: records.map((r) => r.entity) }),
    );
  }

  /* ============================= DEDUP ============================= */

  const base: PendingWrite[] = [];

  // 6 — identical CREATE re-enqueue is an idempotent no-op (same request)
  {
    const c1 = makePendingGoalCreate({ scope: A, entityId: 'goal-1', payload: gd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingGoalCreate({ scope: A, entityId: 'goal-1', payload: gd(), queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '6 identical CREATE -> deduped, queue length 1, original kept',
      r2.ok === true && r2.deduped === true && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }

  // 7 — a DIFFERING CREATE for the same id is existing-pending (never overwritten)
  {
    const c1 = makePendingGoalCreate({ scope: A, entityId: 'goal-1', payload: gd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingGoalCreate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 9000000 }),
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '7 differing CREATE (target) -> refused existing-pending, original untouched',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 8 — UPDATE: token OR draft difference is respected (never blind-merged)
  {
    const u1 = makePendingGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 6000000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, u1);
    // same token, DIFFERENT draft -> existing-pending
    const u2 = makePendingGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 7000000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], u2);
    // DIFFERENT token, same draft -> existing-pending
    const u3 = makePendingGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 6000000 }),
      expectedUpdatedAt: FROZEN2,
      queueId: 'q3',
    });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], u3);
    // identical token + draft -> deduped
    const u4 = makePendingGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 6000000 }),
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
    const d1 = makePendingGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, d1);
    const d2 = makePendingGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: FROZEN2, queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], d2);
    const d3 = makePendingGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: FROZEN, queueId: 'q3' });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], d3);
    check(
      '9 DELETE differing token -> existing-pending; same token -> deduped',
      r2.ok === false && r2.reason === 'existing-pending' && r3.ok === true && r3.deduped === true,
      JSON.stringify({ r2, r3 }),
    );
  }

  /* ==================== ACK MATCHER (pure) ==================== */

  // 17/19 — serverGoalConfirmsUpdate: content match (trim-aware name), never `saved`
  {
    const row = serverGoal('goal-1', { name: '내 집 마련', deadline: '2027-01-01', icon: '🏠', saved: 1200000 });
    check(
      '17/19 same content (raw draft has untrimmed name), saved irrelevant -> confirms',
      serverGoalConfirmsUpdate(row, gd({ name: '  내 집 마련  ' })) === true,
      '',
    );
    check(
      '18/20 different target -> does NOT confirm',
      serverGoalConfirmsUpdate(row, gd({ target: 999 })) === false,
      '',
    );
    check(
      '21 different deadline -> does NOT confirm (stale concurrent server edit never "matched")',
      serverGoalConfirmsUpdate(serverGoal('goal-1', { deadline: '2028-01-01' }), gd({ deadline: '2027-01-01' })) ===
        false,
      '',
    );
  }

  /* ========================= MANAGEMENT ========================= */

  // 24 — pending CREATE: synthetic management row ONLY, absent from data.goals, saved=0
  {
    const server = financeWith([]);
    const ops: PendingWrite[] = [
      makePendingGoalCreate({ scope: A, entityId: 'goal-1', payload: gd({ target: 3000000 }), queueId: 'q1' }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '24 pending CREATE -> synthetic row in goalManagement only, NOT in data.goals, saved defaults to 0',
      data.goals.length === 0 &&
        goalManagement.rows.length === 1 &&
        goalManagement.rows[0].id === 'goal-1' &&
        goalManagement.rows[0].target === 3000000 &&
        goalManagement.rows[0].saved === 0 &&
        goalManagement.syntheticIds.has('goal-1') &&
        goalManagement.opById.get('goal-1') === 'create',
      JSON.stringify(goalManagement),
    );
  }

  // 25 — pending UPDATE: management overlay only, data.goals authoritative, `saved` PRESERVED
  {
    const server = financeWith([serverGoal('goal-1', { target: 5000000, saved: 1000000 })]);
    const ops: PendingWrite[] = [
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-1',
        payload: gd({ target: 8000000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '25 pending UPDATE -> overlay ONLY in goalManagement, data.goals still 5000000, `saved` untouched by the overlay',
      data.goals[0].target === 5000000 &&
        goalManagement.rows[0].target === 8000000 &&
        goalManagement.rows[0].saved === 1000000 &&
        goalManagement.opById.get('goal-1') === 'update' &&
        !goalManagement.syntheticIds.has('goal-1'),
      JSON.stringify(goalManagement),
    );
  }

  // 26 — pending (not-failed) DELETE: hidden from management rows, kept in data.goals
  {
    const server = financeWith([serverGoal('goal-1'), serverGoal('goal-2', { name: '여행 자금' })]);
    const ops: PendingWrite[] = [
      makePendingGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '26 pending DELETE -> hidden from goalManagement.rows, still authoritative in data.goals',
      data.goals.length === 2 &&
        goalManagement.rows.length === 1 &&
        goalManagement.rows[0].id === 'goal-2' &&
        goalManagement.hiddenIds.includes('goal-1'),
      JSON.stringify(goalManagement),
    );
  }

  // 27/28 — failed UPDATE + server row present -> AUTHORITATIVE wins (incl. `saved`), attempted kept as metadata
  {
    const server = financeWith([serverGoal('goal-1', { target: 5000000, saved: 2000000 })]); // e.g. a deposit landed meanwhile
    const ops: PendingWrite[] = [
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-1',
        payload: gd({ target: 4000000 }), // A's stale offline draft
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failed = new Set(['goal-1']);
    const { data, goalManagement } = composeFinance(
      server,
      ops,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      failed,
    );
    check(
      '27 failed UPDATE + server row -> management row shows AUTHORITATIVE 5000000/saved 2000000, never the stale draft',
      data.goals[0].target === 5000000 &&
        goalManagement.rows[0].target === 5000000 &&
        goalManagement.rows[0].saved === 2000000 &&
        goalManagement.failedIds.has('goal-1') &&
        !goalManagement.syntheticIds.has('goal-1'),
      JSON.stringify(goalManagement),
    );
    check(
      '28 attempted local draft preserved as conflict metadata only',
      goalManagement.attemptedDraftById.get('goal-1')?.target === 4000000,
      JSON.stringify([...goalManagement.attemptedDraftById]),
    );
  }

  // 29 — orphan failed UPDATE (server row gone) -> synthetic display-only row, saved=0
  {
    const server = financeWith([]); // B deleted it while A was offline
    const ops: PendingWrite[] = [
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-1',
        payload: gd({ target: 4000000 }),
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failed = new Set(['goal-1']);
    const { data, goalManagement } = composeFinance(
      server,
      ops,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      failed,
    );
    check(
      '29 orphan failed UPDATE -> synthetic display-only row, absent from data.goals',
      data.goals.length === 0 &&
        goalManagement.rows.length === 1 &&
        goalManagement.rows[0].target === 4000000 &&
        goalManagement.rows[0].saved === 0 &&
        goalManagement.syntheticIds.has('goal-1') &&
        goalManagement.failedIds.has('goal-1') &&
        goalManagement.attemptedDraftById.get('goal-1')?.target === 4000000,
      JSON.stringify(goalManagement),
    );
  }

  // 30 — failed DELETE -> authoritative row restored/visible, marked failed
  {
    const server = financeWith([serverGoal('goal-1', { target: 5000000 })]);
    const ops: PendingWrite[] = [
      makePendingGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['goal-1']);
    const { data, goalManagement } = composeFinance(
      server,
      ops,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      failed,
    );
    check(
      '30 failed DELETE -> authoritative row stays visible, marked failed (never permanently hidden)',
      data.goals.length === 1 &&
        goalManagement.rows.length === 1 &&
        goalManagement.rows[0].id === 'goal-1' &&
        goalManagement.opById.get('goal-1') === 'delete' &&
        goalManagement.failedIds.has('goal-1') &&
        goalManagement.hiddenIds.length === 0,
      JSON.stringify(goalManagement),
    );
  }

  /* ====================== DATA SEPARATION ====================== */

  // 31/32/33 — data.goals / goalMeta are NEVER mutated by any goal op
  {
    const meta = { 'goal-1': { updatedAt: 'SRV-V1', createdBy: 'u-A' } };
    const server = financeWith([serverGoal('goal-1', { target: 5000000 })], meta);
    const ops: PendingWrite[] = [
      makePendingGoalCreate({ scope: A, entityId: 'goal-2', payload: gd(), queueId: 'q1' }),
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-1',
        payload: gd({ target: 777 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q2',
      }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '31/32 data.goals untouched by pending CREATE + UPDATE',
      data.goals.length === 1 && data.goals[0].target === 5000000 && data.goals === server.goals,
      JSON.stringify(data.goals),
    );
    check(
      '34 goalMeta remains authoritative (same reference)',
      data.goalMeta === server.goalMeta && data.goalMeta['goal-1'].updatedAt === 'SRV-V1',
      JSON.stringify(data.goalMeta),
    );
  }
  {
    const server = financeWith([serverGoal('goal-1')]);
    const ops: PendingWrite[] = [
      makePendingGoalDelete({ scope: A, entityId: 'goal-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '33 data.goals untouched by pending DELETE (only goalManagement hides it)',
      data.goals.length === 1 && data.goals === server.goals,
      JSON.stringify(data.goals),
    );
  }

  // 35 — with only non-goal ops present, the authoritative goal source
  // (`data.goals` === the server snapshot's array) is NOT replaced, and
  // goalManagement just mirrors it 1:1.
  {
    const server = financeWith([serverGoal('goal-1')]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '35 no goal ops -> data.goals untouched (=== server.goals), goalManagement mirrors it',
      data.goals === server.goals &&
        goalManagement.rows.length === 1 &&
        goalManagement.rows[0].id === 'goal-1' &&
        goalManagement.opById.size === 0 &&
        goalManagement.failedIds.size === 0,
      '',
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 36 — scope isolation: household B never sees household A's goal op
  {
    const q: PendingWrite[] = [
      makePendingGoalCreate({ scope: A, entityId: 'goal-1', payload: gd(), queueId: 'qa' }),
      makePendingGoalCreate({ scope: B, entityId: 'goal-2', payload: gd(), queueId: 'qb' }),
    ];
    const forA = opsForScope(q, A.userId, A.householdId);
    const forB = opsForScope(q, B.userId, B.householdId);
    check(
      '36 opsForScope isolates goal ops per (userId, householdId)',
      forA.length === 1 && forA[0].queueId === 'qa' && forB.length === 1 && forB[0].queueId === 'qb',
      JSON.stringify({ forA: forA.map((o) => o.queueId), forB: forB.map((o) => o.queueId) }),
    );
  }

  // 40 — a mix with transaction + card ops leaves BOTH goal data and the
  // other entities' behaviour unchanged (no cross-entity regression)
  {
    const server = financeWith([serverGoal('goal-1', { target: 5000000 })]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
      makePendingCardCreate({ scope: A, entityId: 'card-1', payload: { name: 'Visa' } as NewCardDraft, queueId: 'q2' }),
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-1',
        payload: gd({ target: 500 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q3',
      }),
    ];
    const { data, goalManagement, cardManagement } = composeFinance(server, ops);
    check(
      '40 transaction + card + goal mix -> goal data authoritative, card overlay still works',
      data.goals[0].target === 5000000 &&
        goalManagement.rows[0].target === 500 &&
        data.transactions.some((t) => t.id === 'txn-1') &&
        cardManagement.rows.some((c) => c.id === 'card-1'),
      '',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
