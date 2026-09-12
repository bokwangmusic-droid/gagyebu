/**
 * Static verification for the Offline Write Queue coordinator's
 * GOAL-MOVEMENT (deposit/withdraw) wiring — STEP 16-H2-G3. A small,
 * self-contained harness (separate from coordinator.goal.cases.ts)
 * exercising `addGoalMovement` dispatch, the STABLE `movementId` forwarded
 * verbatim on every replay, the baseline+delta ack reconcile against
 * `getServerGoals()`, the "one offline change per goal" LOCK
 * (`enqueueGoalMovementCreate` refusing a second movement — or a
 * create/update/delete — for the same goalId), transport-vs-terminal
 * normalization (incl. `insufficient`), discard, and scope safety. No
 * React, no Supabase. ENGINE ONLY — no UI call site is exercised.
 *
 * NOTE: like every other `coordinator.*.cases.ts` file, this cannot be
 * executed directly under plain Node/tsx in this environment — importing
 * the real coordinator pulls in `@/lib/supabase` -> `react-native`, whose
 * Flow syntax the available tooling (esbuild/tsx, and a sucrase-based
 * reconstruction) cannot parse on this Node version. This is a pre-existing,
 * already-diagnosed environment limitation affecting every coordinator-level
 * test file, not something specific to this one. It is still written in
 * full, mirroring `coordinator.goal.cases.ts` exactly, so it is correct and
 * ready to run once that limitation is resolved (or under Metro/Jest+RN
 * preset tooling).
 */
import { QUEUE_SCHEMA_VERSION, type PendingGoalMovementCreate } from '@/lib/offlineQueue';
import type { NewGoalDraft, NewGoalMovementDraft } from '@/lib/remoteGoalWriteMapping';
import type { AddGoalMovementResult, UpdateGoalResult } from '@/services/remoteGoalWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { Goal } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A: CoordinatorScope = { userId: 'u-A', householdId: 'h-A' };
const B: CoordinatorScope = { userId: 'u-B', householdId: 'h-B' };

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const md = (over: Partial<NewGoalMovementDraft> = {}): NewGoalMovementDraft => ({
  mode: 'deposit',
  amount: 30000,
  ...over,
});
const gd = (over: Partial<NewGoalDraft> = {}): NewGoalDraft => ({
  name: '내 집 마련',
  target: 5000000,
  deadline: '2027-01-01',
  icon: '🏠',
  ...over,
});

const srvGoal = (id: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name: '내 집 마련',
  target: 5000000,
  saved: 100000,
  deadline: '2027-01-01',
  icon: '🏠',
  createdAt: '2026-09-10T09:00:00.000Z',
  ...over,
});

function memStorage(seed?: string) {
  let value: string | null = seed ?? null;
  let failNextSet = 0;
  return {
    getItem: () => Promise.resolve(value),
    setItem: (_k: string, v: string) => {
      if (failNextSet > 0) {
        failNextSet -= 1;
        return Promise.reject(new Error('disk full'));
      }
      value = v;
      return Promise.resolve();
    },
    failSet: (n: number) => {
      failNextSet = n;
    },
    dump: () => value,
  };
}

type MoveArgs = {
  movementId: string;
  householdId: string;
  goalId: string;
  expectedUserId: string;
  draft: NewGoalMovementDraft;
};
type UpdateArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  expectedUpdatedAt: string;
  draft: NewGoalDraft;
};

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  goals: Map<string, Goal>;
  storage: ReturnType<typeof memStorage>;
  moveLog: MoveArgs[];
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setMove: (f: (a: MoveArgs) => Promise<AddGoalMovementResult>) => void;
  setUpdate: (f: (a: UpdateArgs) => Promise<UpdateGoalResult>) => void;
  goalPut: (row: Goal) => void;
  goalDelete: (id: string) => void;
  runTimers: () => void;
  refreshes: () => number;
}

function makeHarness(opts?: { seed?: string }): Harness {
  const goals = new Map<string, Goal>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = A;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const moveLog: MoveArgs[] = [];

  // default: server accepts, applies the signed delta to the goal's `saved`
  // aggregate (mirrors trg_apply_goal_movement — the client never computes
  // this itself in the real service; this stub reproduces the OBSERVABLE
  // effect the coordinator's ack check relies on).
  let moveImpl = async (a: MoveArgs): Promise<AddGoalMovementResult> => {
    moveLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    const prev = goals.get(a.goalId);
    if (prev) {
      const delta = a.draft.mode === 'deposit' ? a.draft.amount : -a.draft.amount;
      goals.set(a.goalId, { ...prev, saved: prev.saved + delta });
    }
    return { ok: true };
  };
  // default: unused unless a test opts in via setUpdate (only case 25 needs
  // a real goal-UPDATE dispatch, to reproduce the STEP 16-H2-G4 regression:
  // a terminal-failed update must never permanently lock the goal).
  let updateImpl = async (_a: UpdateArgs): Promise<UpdateGoalResult> => ({
    ok: false,
    reason: 'error',
    message: 'not stubbed',
  });

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => true,
    getKnownCardIds: () => new Set(),
    getServerTransactions: () => new Map(),
    getServerCards: () => new Map(),
    getServerCategories: () => new Map(),
    getServerBudgets: () => new Map(),
    getServerPlanned: () => new Map(),
    getServerRecurring: () => new Map(),
    getServerGoals: () => goals,
    getServerLoans: () => new Map(),
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    addGoalMovement: (a) => moveImpl(a as MoveArgs),
    updateGoal: (a) => updateImpl(a as UpdateArgs),
    schedule: (fn, ms) => {
      const id = ++timerSeq;
      timers.push({ id, fn, ms, cancelled: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (t) => {
      const e = timers.find((x) => x.id === (t as unknown as number));
      if (e) e.cancelled = true;
    },
    yieldToShell: () => Promise.resolve(),
  });

  return {
    coord,
    goals,
    storage,
    moveLog,
    timers,
    setScope: (s) => {
      scope = s;
      coord.setScope(s);
    },
    setMove: (f) => {
      moveImpl = f;
    },
    setUpdate: (f) => {
      updateImpl = f;
    },
    goalPut: (row) => {
      goals.set(row.id, row);
    },
    goalDelete: (id) => {
      goals.delete(id);
    },
    runTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    refreshes: () => refreshCount,
  };
}

const TRANSPORT_M: AddGoalMovementResult = { ok: false, reason: 'error', message: 'net', transport: true };
const CONFLICT_M: AddGoalMovementResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };
const GONE_M: AddGoalMovementResult = { ok: false, reason: 'gone', message: '삭제된 목표' };
const INSUFFICIENT_M: AddGoalMovementResult = { ok: false, reason: 'insufficient', message: '인출 초과' };

const seedWith = (recs: PendingGoalMovementCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingGoalMovementCreate> = {}): PendingGoalMovementCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'goalMovement',
  op: 'create',
  entityId: 'gm-1',
  goalId: 'goal-1',
  payload: md(),
  expectedBaselineSaved: 100000,
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorGoalMovementCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ RUNOP ============================ */

  // 10 — dispatch: addGoalMovement called with movementId === entityId, goalId forwarded
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.goalPut(srvGoal('goal-1', { saved: 100000 }));
    const enq = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ amount: 30000 }),
      expectedBaselineSaved: 100000,
    });
    await settle(8);
    check(
      '10 dispatch -> addGoalMovement(movementId=entityId, goalId), lands on server, queue empties',
      enq.ok === true &&
        h.moveLog.length === 1 &&
        h.moveLog[0].movementId === 'gm-1' &&
        h.moveLog[0].goalId === 'goal-1' &&
        h.goals.get('goal-1')?.saved === 130000 &&
        h.coord.getState().goalMovement.scopeOps.length === 0,
      JSON.stringify({ log: h.moveLog, goal: h.goals.get('goal-1') }),
    );
  }

  // 11 — movementId is STABLE across every replay (never regenerated)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.goalPut(srvGoal('goal-1', { saved: 100000 }));
    h.setMove((a) => {
      h.moveLog.push(a);
      return Promise.resolve(TRANSPORT_M); // stay "offline" across retries
    });
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ amount: 30000 }),
      expectedBaselineSaved: 100000,
    });
    await settle();
    h.runTimers(); // backoff retry
    await settle(6);
    check(
      '11 every replay uses the SAME movementId (never regenerated)',
      h.moveLog.length >= 2 && h.moveLog.every((m) => m.movementId === 'gm-1'),
      JSON.stringify(h.moveLog.map((m) => m.movementId)),
    );
  }

  // 12 — transport:true is normalized to a retryable transport halt (enqueued, not failed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(TRANSPORT_M));
    const enq = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    await settle();
    const st = h.coord.getState().goalMovement;
    check(
      '12 transport:true -> retained pending (not failed), a backoff timer is scheduled',
      enq.ok === true &&
        st.pendingIds.has('gm-1') &&
        !st.failedIds.has('gm-1') &&
        h.timers.some((t) => !t.cancelled),
      JSON.stringify({ enq, pending: [...st.pendingIds], failed: [...st.failedIds] }),
    );
  }

  // 13 — a non-transport conflict is TERMINAL: retained failed, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setMove(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_M);
    });
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    await settle();
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    const st = h.coord.getState().goalMovement;
    check(
      '13 conflict -> terminal-failed, reason retained, exactly one attempt',
      st.failedIds.has('gm-1') && st.failedReasons.get('gm-1') === 'conflict' && calls === 1,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('gm-1'), calls }),
    );
  }

  // 14 — gone (goal deleted) is TERMINAL with reason preserved
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(GONE_M));
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    await settle();
    const st = h.coord.getState().goalMovement;
    check(
      '14 gone -> terminal-failed with reason "gone"',
      st.failedIds.has('gm-1') && st.failedReasons.get('gm-1') === 'gone',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('gm-1') }),
    );
  }

  // 15 — insufficient (discovered on replay) -> reason-less terminal (flattened, like 'invalid')
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(INSUFFICIENT_M));
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ mode: 'withdraw', amount: 999999 }),
      expectedBaselineSaved: 100000,
    });
    await settle();
    const st = h.coord.getState().goalMovement;
    check(
      '15 insufficient -> terminal-failed with NO stored reason (flattened, mirrors invalid)',
      st.failedIds.has('gm-1') && st.failedReasons.get('gm-1') === undefined,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('gm-1') }),
    );
  }

  /* ========================= ACK (baseline+delta) ========================= */

  // 16 — server saved matches baseline+delta after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.goalPut(srvGoal('goal-1', { saved: 100000 }));
    const enq = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ mode: 'deposit', amount: 30000 }),
      expectedBaselineSaved: 100000,
    });
    await settle(8);
    check(
      '16 ack online -> applied, saved matches baseline+delta, queue empty, refresh requested',
      enq.ok === true &&
        h.goals.get('goal-1')?.saved === 130000 &&
        h.refreshes() >= 1 &&
        h.coord.getState().goalMovement.scopeOps.length === 0,
      JSON.stringify({ saved: h.goals.get('goal-1')?.saved, refreshes: h.refreshes() }),
    );
  }

  // 17 — FALSE NEGATIVE: saved does NOT match baseline+delta (server response
  // lost, snapshot lags, or another device's DIFFERENT-amount movement
  // landed) -> NOT acked, op RETAINED — never durably removed. The op stays
  // queued and simply replays; a replay of the SAME movementId is safe
  // (addGoalMovement's own 23505-by-content reconcile).
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.goalPut(srvGoal('goal-1', { saved: 100000 }));
    let calls = 0;
    h.setMove((a) => {
      calls += 1;
      h.moveLog.push(a);
      if (calls === 1) {
        // "succeeds" but — simulating a lost response / stale snapshot — the
        // goal's `saved` the coordinator observes on refresh does NOT yet
        // reflect it.
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(TRANSPORT_M); // subsequent replay halts on backoff
    });
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ mode: 'deposit', amount: 30000 }),
      expectedBaselineSaved: 100000,
    });
    await settle(8);
    check(
      '17 saved != baseline+delta -> not acked, op still queued (never durably removed), goal saved untouched by us',
      h.coord.getState().goalMovement.scopeOps.length === 1 &&
        calls >= 1 &&
        h.goals.get('goal-1')?.saved === 100000 &&
        !h.coord.getState().goalMovement.failedIds.has('gm-1'),
      JSON.stringify({ ops: h.coord.getState().goalMovement.scopeOps.length, calls }),
    );
  }

  // 18 — ANOTHER DEVICE changed `saved` by a DIFFERENT amount while this
  // movement was pending -> STILL not acked (strict baseline+delta match,
  // not just "changed"); the record is safely retained and replays, whose
  // OWN 23505-by-content reconcile is what actually resolves it (either
  // idempotent-confirm if ours already landed too, or applies fresh).
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.goalPut(srvGoal('goal-1', { saved: 100000 }));
    let calls = 0;
    h.setMove((a) => {
      calls += 1;
      h.moveLog.push(a);
      if (calls === 1) {
        // our own delta WOULD land as +30000 (100000 -> 130000), but by the
        // time of the refresh another device's own +50000 deposit is what
        // the snapshot shows instead (130000 vs 150000 — never coincides).
        h.goals.set('goal-1', { ...h.goals.get('goal-1')!, saved: 150000 });
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(TRANSPORT_M);
    });
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ mode: 'deposit', amount: 30000 }),
      expectedBaselineSaved: 100000,
    });
    await settle(8);
    check(
      '18 concurrent different-amount change -> strict match fails, NOT acked, never silently dropped',
      h.coord.getState().goalMovement.scopeOps.length === 1 && h.goals.get('goal-1')?.saved === 150000,
      JSON.stringify({ ops: h.coord.getState().goalMovement.scopeOps.length, saved: h.goals.get('goal-1')?.saved }),
    );
  }

  // 19 — same id + server already reflects it (lost-response idempotent
  // retry) -> ack removes it durably on restart/hydrate too
  {
    const h = makeHarness({
      seed: seedWith([rec({ queueId: 'q-19', entityId: 'gm-1', goalId: 'goal-1', expectedBaselineSaved: 100000 })]),
    });
    h.goalPut(srvGoal('goal-1', { saved: 130000 })); // our earlier deposit already landed
    let calls = 0;
    h.setMove((a) => {
      calls += 1;
      return Promise.resolve({ ok: true }); // real service: 23505 reconcile confirms idempotent
    });
    await h.coord.hydrate();
    await settle(8);
    check(
      '19 restart + server already reflects the movement -> ack removes it durably',
      h.coord.getState().goalMovement.scopeOps.length === 0 && h.goals.get('goal-1')?.saved === 130000,
      JSON.stringify({ ops: h.coord.getState().goalMovement.scopeOps, calls }),
    );
  }

  /* ======================== LOCK (one op per goal) ======================== */

  // 20 — a SECOND movement for the SAME goal while one is pending -> refused existing-pending
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(TRANSPORT_M));
    const enq1 = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md({ amount: 10000 }),
      expectedBaselineSaved: 100000,
    });
    const enq2 = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-2', // a DIFFERENT movement id, same goal
      goalId: 'goal-1',
      payload: md({ amount: 20000 }),
      expectedBaselineSaved: 100000,
    });
    await settle();
    check(
      '20 second movement for the SAME goal -> refused existing-pending, only the first is queued',
      enq1.ok === true &&
        enq2.ok === false &&
        enq2.reason === 'existing-pending' &&
        h.coord.getState().goalMovement.scopeOps.length === 1,
      JSON.stringify({ enq1, enq2 }),
    );
  }

  // 21 — a movement while a goal UPDATE is already pending for the same goal -> refused
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: { name: '수정', target: 6000000, deadline: null, icon: '🏠' },
      expectedUpdatedAt: 'V1',
    });
    const enq = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    check(
      '21 movement refused while a goal UPDATE is pending for the same goal',
      enq.ok === false && enq.reason === 'existing-pending',
      JSON.stringify(enq),
    );
  }

  // 22 — a movement for a DIFFERENT goal is unaffected by another goal's lock
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(TRANSPORT_M));
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    const enq2 = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-2',
      goalId: 'goal-2', // a DIFFERENT goal
      payload: md(),
      expectedBaselineSaved: 0,
    });
    check(
      '22 movement for a different goal is NOT blocked by goal-1\'s lock',
      enq2.ok === true,
      JSON.stringify(enq2),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 23 — scope isolation: household B never sees household A's movement op
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(TRANSPORT_M));
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState().goalMovement;
    h.setScope(A);
    const underA = h.coord.getState().goalMovement;
    check(
      '23 scope isolation: movement op hidden under B, visible again under A',
      underB.scopeOps.length === 0 && underA.pendingIds.has('gm-1'),
      `B=${underB.scopeOps.length} A=${[...underA.pendingIds]}`,
    );
  }

  // 24 — discardPending: exact queueId removal, scope isolation, goal lock released
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setMove(() => Promise.resolve(CONFLICT_M));
    await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    await settle();
    const recQ = h.coord.getState().goalMovement.scopeOps.find((o) => o.entityId === 'gm-1');
    h.setScope(B);
    const outB = await h.coord.discardPending(recQ!.queueId);
    h.setScope(A);
    const outA = await h.coord.discardPending(recQ!.queueId);
    // the lock is released -> a fresh movement for the same goal can be queued
    const enqAfter = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-2',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    check(
      '24 discard: refused under wrong scope, removed under right scope, lock released for the same goal',
      outB.ok === false &&
        outB.reason === 'scope' &&
        outA.ok === true &&
        !h.coord.getState().goalMovement.failedIds.has('gm-1') &&
        enqAfter.ok === true,
      JSON.stringify({ outB, outA, enqAfter }),
    );
  }

  // 25 — REGRESSION (the STEP 16-H2-G4 on-device bug, symmetric side): a
  // TERMINAL-FAILED update for the SAME goal (retained forever — no discard
  // UI) must NEVER permanently block a later movement. Only an ACTIVELY
  // pending op (no `lastError` yet) may lock the row.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() =>
      Promise.resolve({ ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' } as UpdateGoalResult),
    );
    await h.coord.enqueueGoalUpdate({
      scope: A,
      entityId: 'goal-1',
      payload: gd({ target: 1 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(); // let the update actually terminal-fail (lastError persisted)
    const preState = h.coord.getState().goal;
    const enq = await h.coord.enqueueGoalMovementCreate({
      scope: A,
      entityId: 'gm-1',
      goalId: 'goal-1',
      payload: md(),
      expectedBaselineSaved: 100000,
    });
    check(
      '25 movement is NOT refused by a terminal-failed (not merely pending) update on the SAME goal',
      preState.failedIds.has('goal-1') && // sanity: the update really did terminal-fail first
        enq.ok === true,
      JSON.stringify({ preFailed: [...preState.failedIds], enq }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
