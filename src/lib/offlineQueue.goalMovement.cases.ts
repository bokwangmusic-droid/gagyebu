/**
 * Static verification for STEP 16-H2-G3 — savings-goal deposit/withdraw
 * (`entity:'goalMovement'`) added to the pure Offline Write Queue core:
 * record shape, the union-aware validator, the dedup / existing-pending
 * policy at the RECORD level (the "one movement per goal" LOCK itself lives
 * in the coordinator's `enqueueGoalMovementCreate` — see
 * coordinator.goalMovement.cases.ts, not exercised here), and the
 * DISPLAY-ONLY movement overlay inside `composeGoalManagement` (NEVER
 * merged into `data.goals` / `data.goalMeta`).
 *
 * Mirrors src/lib/offlineQueue.goal.cases.ts. ENGINE ONLY — no UI wiring is
 * exercised here. RunOp dispatch + the ack reconcile (baseline+delta against
 * `getServerGoals()`) live in coordinator.goalMovement.cases.ts.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewGoalDraft, NewGoalMovementDraft } from '@/lib/remoteGoalWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingGoalCreate,
  makePendingGoalMovementCreate,
  makePendingGoalUpdate,
  opsForScope,
  sanitizePendingWrites,
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

const gd = (over: Partial<NewGoalDraft> = {}): NewGoalDraft => ({
  name: '내 집 마련',
  target: 5000000,
  deadline: '2027-01-01',
  icon: '🏠',
  ...over,
});
const md = (over: Partial<NewGoalMovementDraft> = {}): NewGoalMovementDraft => ({
  mode: 'deposit',
  amount: 30000,
  ...over,
});

const mvCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-mv',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'goalMovement',
  op: 'create',
  entityId: 'gm-1',
  goalId: 'goal-1',
  payload: md(),
  expectedBaselineSaved: 100000,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverGoal = (id: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name: '내 집 마련',
  target: 5000000,
  saved: 100000,
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

export async function runOfflineQueueGoalMovementCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ SCHEMA ============================ */

  // 1 — valid movement record round-trips
  {
    const v = validatePendingWrite(mvCreateObj());
    check(
      '1 valid goalMovement CREATE parses with goalId + payload + expectedBaselineSaved',
      !!v &&
        v.entity === 'goalMovement' &&
        v.op === 'create' &&
        'goalId' in v &&
        v.goalId === 'goal-1' &&
        'expectedBaselineSaved' in v &&
        v.expectedBaselineSaved === 100000,
      JSON.stringify(v),
    );
  }

  // 2 — malformed movement records are rejected
  {
    const bad = [
      mvCreateObj({ op: 'update' }), // ALWAYS create
      mvCreateObj({ op: 'delete' }),
      mvCreateObj({ goalId: undefined }),
      mvCreateObj({ goalId: '' }),
      mvCreateObj({ expectedBaselineSaved: undefined }),
      mvCreateObj({ expectedBaselineSaved: 'not-a-number' }),
      mvCreateObj({ expectedBaselineSaved: NaN }),
      mvCreateObj({ payload: md({ mode: 'transfer' as never }) }), // bad mode
      mvCreateObj({ payload: md({ amount: 0 }) }), // amount must be > 0
      mvCreateObj({ payload: md({ amount: -5 }) }),
      mvCreateObj({ payload: md({ amount: 1.5 }) }), // not an integer
      mvCreateObj({ payload: { ...md(), goalId: 'goal-1' } }), // server/identity field in payload
      mvCreateObj({ payload: { ...md(), id: 'gm-1' } }),
      mvCreateObj({ payload: { ...md(), household_id: 'h-A' } }),
      { ...mvCreateObj(), entityId: '' },
    ];
    check(
      '2 malformed goalMovement persisted ops all reject',
      bad.every((b) => validatePendingWrite(b) === null),
      JSON.stringify(bad.map((b) => validatePendingWrite(b))),
    );
  }

  // 3 — old persisted entity variants (incl. plain goal) still hydrate unchanged
  {
    const mixed = [
      makePendingGoalCreate({ scope: A, entityId: 'goal-9', payload: gd(), queueId: 'q-g' }),
      mvCreateObj({ queueId: 'q-mv2' }),
    ];
    const { records, dropped } = sanitizePendingWrites(mixed);
    check(
      '3 goal + goalMovement both hydrate, none dropped',
      dropped === 0 && records.length === 2 && records.map((r) => r.entity).join(',') === 'goal,goalMovement',
      JSON.stringify({ dropped, entities: records.map((r) => r.entity) }),
    );
  }

  /* ============================= DEDUP ============================= */

  const base: PendingWrite[] = [];

  // 4 — identical movement re-enqueue is an idempotent no-op (same request)
  {
    const m1 = makePendingGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, m1);
    const m2 = makePendingGoalMovementCreate({
      scope: A,
      entityId: 'gm-1', // SAME movement id — a genuine retry of the same sheet
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], m2);
    check(
      '4 identical movement retry (same entityId+goalId+payload+baseline) -> deduped, queue length 1',
      r2.ok === true && r2.deduped === true && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }

  // 5 — a DIFFERING movement for the SAME movement id is existing-pending (never overwritten)
  {
    const m1 = makePendingGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ amount: 30000 }),
      expectedBaselineSaved: 100000,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, m1);
    const m2 = makePendingGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ amount: 50000 }), // different amount, same movement id
      expectedBaselineSaved: 100000,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], m2);
    check(
      '5 differing movement (amount) at the SAME entityId -> refused existing-pending',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 6 — TWO DIFFERENT movement ids for the SAME goal are NOT deduped at this
  // pure layer (dedup is per-entityId, i.e. per movement) — the "one
  // movement per goal" LOCK is a coordinator-level policy
  // (enqueueGoalMovementCreate), deliberately NOT re-implemented here. This
  // case documents that boundary rather than asserting a rejection.
  {
    const m1 = makePendingGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ amount: 30000 }),
      expectedBaselineSaved: 100000,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, m1);
    const m2 = makePendingGoalMovementCreate({
      scope: A,
      entityId: 'gm-2', // a DIFFERENT movement id, same goal
      goalId: 'goal-1',
      payload: md({ amount: 20000 }),
      expectedBaselineSaved: 100000,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], m2);
    check(
      '6 pure core allows two different movement ids for the same goal (lock is coordinator-level, not here)',
      r2.ok === true && r2.deduped === false && r2.queue.length === 2,
      JSON.stringify(r2),
    );
  }

  /* ========================= MANAGEMENT OVERLAY ========================= */

  // 7 — pending DEPOSIT: optimistic saved increase, overlay only, data.goals untouched
  {
    const server = financeWith([serverGoal('goal-1', { saved: 100000 })]);
    const ops: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'deposit', amount: 30000 }),
        expectedBaselineSaved: 100000,
        queueId: 'q1',
      }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '7 pending deposit -> goalManagement shows saved+delta, data.goals untouched',
      data.goals[0].saved === 100000 &&
        goalManagement.rows[0].saved === 130000 &&
        goalManagement.opById.get('goal-1') === 'update' &&
        !goalManagement.failedIds.has('goal-1') &&
        goalManagement.movementById.get('goal-1')?.mode === 'deposit' &&
        goalManagement.movementById.get('goal-1')?.amount === 30000,
      JSON.stringify(goalManagement),
    );
  }

  // 8 — pending WITHDRAW: optimistic saved decrease, clamped at 0
  {
    const server = financeWith([serverGoal('goal-1', { saved: 20000 })]);
    const ops: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'withdraw', amount: 50000 }), // exceeds baseline — display-clamp only
        expectedBaselineSaved: 20000,
        queueId: 'q1',
      }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '8 pending withdraw exceeding saved -> composed row clamps to 0 (display only), server untouched',
      data.goals[0].saved === 20000 && goalManagement.rows[0].saved === 0,
      JSON.stringify(goalManagement),
    );
  }

  // 9 — failed movement + server row present -> AUTHORITATIVE saved wins, never overwritten
  {
    const server = financeWith([serverGoal('goal-1', { saved: 150000 })]); // e.g. another device also deposited meanwhile
    const ops: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'deposit', amount: 30000 }),
        expectedBaselineSaved: 100000, // stale baseline
        queueId: 'q1',
      }),
    ];
    const failedMovementIds = new Set(['gm-1']);
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
      undefined,
      failedMovementIds,
    );
    check(
      '9 failed movement + server row -> management row shows AUTHORITATIVE 150000, never the optimistic 130000',
      data.goals[0].saved === 150000 &&
        goalManagement.rows[0].saved === 150000 &&
        goalManagement.failedIds.has('goal-1') &&
        goalManagement.movementById.get('goal-1')?.amount === 30000,
      JSON.stringify(goalManagement),
    );
  }

  // 10 — orphan movement (server goal row gone entirely) -> skipped, no crash, no synthetic row invented
  {
    const server = financeWith([]); // goal deleted on another device while this device was offline
    const ops: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'deposit', amount: 30000 }),
        expectedBaselineSaved: 100000,
        queueId: 'q1',
      }),
    ];
    const { data, goalManagement } = composeFinance(server, ops);
    check(
      '10 orphan movement (goal row absent) -> no rows invented, data.goals stays empty',
      data.goals.length === 0 && goalManagement.rows.length === 0 && goalManagement.opById.size === 0,
      JSON.stringify(goalManagement),
    );
  }

  // 11 — a goal UPDATE already claims the row -> the movement is skipped (first-come-wins), never double-marked
  {
    const server = financeWith([serverGoal('goal-1', { saved: 100000, target: 5000000 })]);
    const ops: PendingWrite[] = [
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-1',
        payload: gd({ target: 9000000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'deposit', amount: 30000 }),
        expectedBaselineSaved: 100000,
        queueId: 'q2',
      }),
    ];
    const { goalManagement } = composeFinance(server, ops);
    check(
      '11 goal UPDATE already claims the row -> movement overlay skipped, saved untouched by the movement',
      goalManagement.rows[0].target === 9000000 &&
        goalManagement.rows[0].saved === 100000 && // the movement's delta was NOT applied
        goalManagement.opById.get('goal-1') === 'update' &&
        !goalManagement.movementById.has('goal-1'),
      JSON.stringify(goalManagement),
    );
  }

  /* ====================== DATA SEPARATION ====================== */

  // 12 — data.goals / goalMeta are NEVER mutated by a pending movement
  {
    const meta = { 'goal-1': { updatedAt: 'SRV-V1', createdBy: 'u-A' } };
    const server = financeWith([serverGoal('goal-1', { saved: 100000 })], meta);
    const ops: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'deposit', amount: 30000 }),
        expectedBaselineSaved: 100000,
        queueId: 'q1',
      }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '12 data.goals / goalMeta untouched by a pending movement (same references, unchanged saved)',
      data.goals === server.goals &&
        data.goals[0].saved === 100000 &&
        data.goalMeta === server.goalMeta,
      JSON.stringify(data.goals),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 13 — scope isolation: household B never sees household A's movement op
  {
    const q: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md(),
        expectedBaselineSaved: 100000,
        queueId: 'qa',
      }),
      makePendingGoalMovementCreate({
        scope: B,
        entityId: 'gm-2',
        goalId: 'goal-2',
        payload: md(),
        expectedBaselineSaved: 0,
        queueId: 'qb',
      }),
    ];
    const forA = opsForScope(q, A.userId, A.householdId);
    const forB = opsForScope(q, B.userId, B.householdId);
    check(
      '13 opsForScope isolates goalMovement ops per (userId, householdId)',
      forA.length === 1 && forA[0].queueId === 'qa' && forB.length === 1 && forB[0].queueId === 'qb',
      JSON.stringify({ forA: forA.map((o) => o.queueId), forB: forB.map((o) => o.queueId) }),
    );
  }

  // 14 — a goal + goalMovement mix for DIFFERENT goals leaves both independent
  {
    const server = financeWith([
      serverGoal('goal-1', { saved: 100000 }),
      serverGoal('goal-2', { saved: 500000, target: 1000000 }),
    ]);
    const ops: PendingWrite[] = [
      makePendingGoalMovementCreate({
        scope: A,
        entityId: 'gm-1',
        goalId: 'goal-1',
        payload: md({ mode: 'deposit', amount: 30000 }),
        expectedBaselineSaved: 100000,
        queueId: 'q1',
      }),
      makePendingGoalUpdate({
        scope: A,
        entityId: 'goal-2',
        payload: gd({ target: 2000000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q2',
      }),
    ];
    const { goalManagement } = composeFinance(server, ops);
    const row1 = goalManagement.rows.find((g) => g.id === 'goal-1');
    const row2 = goalManagement.rows.find((g) => g.id === 'goal-2');
    check(
      '14 movement on goal-1 and update on goal-2 both apply independently',
      row1?.saved === 130000 && row2?.target === 2000000 && row2?.saved === 500000,
      JSON.stringify({ row1, row2 }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
