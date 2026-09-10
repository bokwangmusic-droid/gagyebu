/**
 * Static verification for the Offline Write Queue coordinator's COMPOSITE
 * category+budget delete wiring — STEP 16-H2 A4.2 (REPLAY + COORDINATOR +
 * ACK). Self-contained harness (separate from coordinator.cases.ts /
 * coordinator.budget.cases.ts), no React, no Supabase.
 *
 * Exercises: `enqueueCategoryBudgetDelete` (durable persist + the
 * category/budget collision guard), the ONE-RPC replay via
 * `softDeleteCustomCategoryWithBudget`, the "both category AND budget
 * absent" ack reconcile, terminal-conflict retention, `categoryBudget:<id>`
 * failed-state namespace isolation, restart rebuild, scope isolation,
 * `discardPending`, `pendingCount`, and the response-loss / legacy-partial
 * paths. Projection is NOT exercised (that is A4.3).
 */
import {
  QUEUE_SCHEMA_VERSION,
  type PendingCategoryBudgetDelete,
} from '@/lib/offlineQueue';
import type { Category } from '@/data/categories';
import type { SoftDeleteCustomCategoryWithBudgetResult } from '@/services/remoteCategoryBudgetWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A: CoordinatorScope = { userId: 'u-A', householdId: 'h-A' };
const B: CoordinatorScope = { userId: 'u-B', householdId: 'h-B' };
const T0 = '2026-09-10T09:00:00.000Z';

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const cat = (id: string): Category => ({
  id,
  name: id,
  bg: '#eeeeee',
  color: '#111111',
  icon: 'heart',
  custom: true,
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

type RpcArgs = {
  householdId: string;
  categoryId: string;
  expectedUserId: string;
  expectedCategoryUpdatedAt: string;
  expectedBudgetUpdatedAt: string | null;
};

const OK_RES: SoftDeleteCustomCategoryWithBudgetResult = {
  ok: true,
  categoryDeletedAt: '2026-09-11T00:00:00.000Z',
  budgetDeletedAt: '2026-09-11T00:00:00.000Z',
};
const TRANSPORT_RES: SoftDeleteCustomCategoryWithBudgetResult = {
  ok: false,
  reason: 'error',
  message: 'net',
  transport: true,
};
const CONFLICT_RES: SoftDeleteCustomCategoryWithBudgetResult = {
  ok: false,
  reason: 'conflict',
  message: '다른 기기에서 변경됐어요',
};
/** A never-resolving-successfully single-table stub so a seeded / enqueued
 *  category|budget op just stays pending (its backoff timers are never run). */
const SINGLE_TABLE_TRANSPORT = () =>
  Promise.resolve({ ok: false, reason: 'error', message: 'net', transport: true });

function makeHarness(opts?: { seed?: string }) {
  const categories = new Map<string, Category>();
  const budgets = new Map<string, number>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = A;
  const remoteReady = true;
  let refreshCount = 0;
  const timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[] = [];
  let timerSeq = 0;
  const rpcLog: RpcArgs[] = [];

  // default: server accepts + both rows vanish from the snapshot.
  let rpcImpl = async (args: RpcArgs): Promise<SoftDeleteCustomCategoryWithBudgetResult> => {
    rpcLog.push(args);
    await tick();
    categories.delete(args.categoryId);
    budgets.delete(args.categoryId);
    return OK_RES;
  };

  const coord = createPendingWriteCoordinator({
    storage: storage as unknown as QueueStorage,
    getScope: () => scope,
    getRemoteReady: () => remoteReady,
    getKnownCardIds: () => new Set(),
    getServerTransactions: () => new Map(),
    getServerCards: () => new Map(),
    getServerCategories: () => categories,
    getServerBudgets: () => budgets,
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    softDeleteCustomCategoryWithBudget: (args) => rpcImpl(args as RpcArgs),
    // keep any single-table category/budget op that gets enqueued "pending"
    softDeleteCategory: SINGLE_TABLE_TRANSPORT as never,
    saveBudget: SINGLE_TABLE_TRANSPORT as never,
    softDeleteBudget: SINGLE_TABLE_TRANSPORT as never,
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
    categories,
    budgets,
    storage,
    rpcLog,
    timers,
    setScope: (s: CoordinatorScope | null) => {
      scope = s;
      coord.setScope(s);
    },
    setRpc: (f: (args: RpcArgs) => Promise<SoftDeleteCustomCategoryWithBudgetResult>) => {
      rpcImpl = f;
    },
    catPut: (id: string) => categories.set(id, cat(id)),
    catDelete: (id: string) => categories.delete(id),
    budPut: (id: string, amt = 1000) => budgets.set(id, amt),
    budDelete: (id: string) => budgets.delete(id),
    runTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    refreshes: () => refreshCount,
  };
}

type Harness = ReturnType<typeof makeHarness>;

const enqCbd = (
  h: Harness,
  over: Partial<{ scope: CoordinatorScope; entityId: string; catTok: string; budTok: string | null }> = {},
) =>
  h.coord.enqueueCategoryBudgetDelete({
    scope: over.scope ?? A,
    entityId: over.entityId ?? 'c-1',
    expectedCategoryUpdatedAt: over.catTok ?? 'CAT-V1',
    expectedBudgetUpdatedAt: over.budTok === undefined ? 'BUD-V1' : over.budTok,
  });

const seedCbd = (over: Partial<PendingCategoryBudgetDelete> = {}): PendingCategoryBudgetDelete => ({
  queueId: 'q-seed',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'categoryBudget',
  op: 'delete',
  entityId: 'c-1',
  expectedCategoryUpdatedAt: 'CAT-V1',
  expectedBudgetUpdatedAt: 'BUD-V1',
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorCategoryBudgetCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ===================== enqueue + collision guard ===================== */

  // 1 — enqueue with no existing op -> durable success (kept pending while offline)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    h.catPut('c-1');
    h.budPut('c-1');
    const enq = await enqCbd(h);
    await settle();
    const st = h.coord.getState().categoryBudget;
    check(
      '1 enqueue (no existing op) -> {ok:true}, pending, server rows untouched',
      enq.ok === true &&
        st.pendingIds.has('c-1') &&
        h.categories.has('c-1') &&
        h.budgets.has('c-1'),
      `enq=${JSON.stringify(enq)} pending=${[...st.pendingIds]}`,
    );
  }

  // 2 — same request (identical frozen tokens) -> idempotent dedup, one record
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    const e1 = await enqCbd(h, { catTok: 'CT', budTok: 'BT' });
    const e2 = await enqCbd(h, { catTok: 'CT', budTok: 'BT' });
    await settle();
    check(
      '2 same composite request -> deduped {ok:true}, still ONE queued record',
      e1.ok === true && e2.ok === true && h.coord.getState().categoryBudget.scopeOps.length === 1,
      `e2=${JSON.stringify(e2)} ops=${h.coord.getState().categoryBudget.scopeOps.length}`,
    );
  }

  // 3 — differing frozen token -> existing-pending (never overwritten)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    await enqCbd(h, { catTok: 'CT', budTok: 'BT' });
    const eCat = await enqCbd(h, { catTok: 'CT-DIFF', budTok: 'BT' });
    const eBud = await enqCbd(h, { catTok: 'CT', budTok: 'BT-DIFF' });
    check(
      '3 differing category OR budget token -> existing-pending',
      eCat.ok === false &&
        eCat.reason === 'existing-pending' &&
        eBud.ok === false &&
        eBud.reason === 'existing-pending',
      `eCat=${JSON.stringify(eCat)} eBud=${JSON.stringify(eBud)}`,
    );
  }

  // 4 — a pending single-table CATEGORY op for the same id -> composite blocked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueCategoryDelete({ scope: A, entityId: 'c-1', expectedUpdatedAt: 'X' });
    await settle();
    const enq = await enqCbd(h, { entityId: 'c-1' });
    check(
      '4 existing category delete op (same id) -> composite refused existing-pending',
      enq.ok === false && enq.reason === 'existing-pending',
      JSON.stringify(enq),
    );
  }

  // 5 — a pending single-table BUDGET op for the same id -> composite blocked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'c-1', payload: { category: 'c-1', amount: 5000 } });
    await settle();
    const enq = await enqCbd(h, { entityId: 'c-1' });
    check(
      '5 existing budget op (same id) -> composite refused existing-pending',
      enq.ok === false && enq.reason === 'existing-pending',
      JSON.stringify(enq),
    );
  }

  // 6 — a category op in a DIFFERENT scope does NOT block
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueCategoryDelete({ scope: B, entityId: 'c-1', expectedUpdatedAt: 'X' });
    await settle();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    const enq = await enqCbd(h, { scope: A, entityId: 'c-1' });
    check(
      '6 same-id category op under a DIFFERENT scope -> composite NOT blocked',
      enq.ok === true,
      JSON.stringify(enq),
    );
  }

  // 7 — a category op for a DIFFERENT id does NOT block
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueCategoryDelete({ scope: A, entityId: 'c-2', expectedUpdatedAt: 'X' });
    await settle();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    const enq = await enqCbd(h, { scope: A, entityId: 'c-1' });
    check('7 same-scope category op for a DIFFERENT id -> composite NOT blocked', enq.ok === true, JSON.stringify(enq));
  }

  /* ============================== ACK ============================== */

  // 8 — flush success then reconcile: both rows absent -> durable ack removal
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1');
    const enq = await enqCbd(h);
    await settle(8);
    check(
      '8 online composite delete -> RPC once, both rows gone, refresh requested, queue empty (acked)',
      enq.ok === true &&
        h.rpcLog.length === 1 &&
        !h.categories.has('c-1') &&
        !h.budgets.has('c-1') &&
        h.refreshes() >= 1 &&
        h.coord.getState().categoryBudget.scopeOps.length === 0,
      `rpc=${h.rpcLog.length} cats=${[...h.categories.keys()]} buds=${[...h.budgets.keys()]}`,
    );
  }

  // 9 — category ABSENT but budget PRESENT -> NOT acked (record retained, still pending)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1');
    let n = 0;
    h.setRpc(async (args) => {
      n += 1;
      h.rpcLog.push(args);
      await tick();
      h.categories.delete(args.categoryId); // only the category vanishes
      return n === 1 ? OK_RES : TRANSPORT_RES; // stop replaying after the first
    });
    await enqCbd(h);
    await settle(10);
    const st = h.coord.getState().categoryBudget;
    check(
      '9 category absent + budget present -> NOT acked (retained, pending, not failed)',
      st.scopeOps.length === 1 &&
        !st.failedIds.has('c-1') &&
        st.pendingIds.has('c-1') &&
        !h.categories.has('c-1') &&
        h.budgets.has('c-1'),
      `ops=${st.scopeOps.length} failed=${[...st.failedIds]}`,
    );
  }

  // 10 — category PRESENT but budget ABSENT -> NOT acked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1');
    let n = 0;
    h.setRpc(async (args) => {
      n += 1;
      h.rpcLog.push(args);
      await tick();
      h.budgets.delete(args.categoryId); // only the budget vanishes
      return n === 1 ? OK_RES : TRANSPORT_RES;
    });
    await enqCbd(h);
    await settle(10);
    const st = h.coord.getState().categoryBudget;
    check(
      '10 category present + budget absent -> NOT acked (retained, pending)',
      st.scopeOps.length === 1 && !st.failedIds.has('c-1') && h.categories.has('c-1') && !h.budgets.has('c-1'),
      `ops=${st.scopeOps.length}`,
    );
  }

  // 11 — BOTH still present -> NOT acked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1');
    let n = 0;
    h.setRpc(async (args) => {
      n += 1;
      h.rpcLog.push(args);
      await tick();
      return n === 1 ? OK_RES : TRANSPORT_RES; // server "accepted" but snapshot never changes
    });
    await enqCbd(h);
    await settle(10);
    const st = h.coord.getState().categoryBudget;
    check(
      '11 both rows still present -> NOT acked (retained, pending)',
      st.scopeOps.length === 1 && !st.failedIds.has('c-1'),
      `ops=${st.scopeOps.length}`,
    );
  }

  // 12 — expectedBudgetUpdatedAt=null: ack STILL requires budget absent too
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1'); // no budget row at intent time
    let n = 0;
    h.setRpc(async (args) => {
      n += 1;
      h.rpcLog.push(args);
      await tick();
      h.categories.delete(args.categoryId);
      h.budgets.set(args.categoryId, 4242); // a budget APPEARED in the offline window
      return n === 1 ? OK_RES : TRANSPORT_RES;
    });
    await enqCbd(h, { budTok: null });
    await settle(10);
    const st = h.coord.getState().categoryBudget;
    check(
      '12 null budget token -> NOT special-cased; appeared budget blocks the ack',
      st.scopeOps.length === 1 && h.budgets.get('c-1') === 4242,
      `ops=${st.scopeOps.length} bud=${h.budgets.get('c-1')}`,
    );
  }

  /* ==================== terminal conflict retention ==================== */

  // 13 — RPC conflict -> retained failed, reason preserved, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1');
    let calls = 0;
    h.setRpc(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_RES);
    });
    await enqCbd(h);
    await settle();
    const st = h.coord.getState().categoryBudget;
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    check(
      '13 RPC conflict -> retained failed, reason "conflict", server rows untouched, one attempt',
      st.failedIds.has('c-1') &&
        st.failedReasons.get('c-1') === 'conflict' &&
        st.scopeOps.length === 1 &&
        h.categories.has('c-1') &&
        h.budgets.has('c-1') &&
        calls === 1,
      `failed=${[...st.failedIds]} reason=${st.failedReasons.get('c-1')} calls=${calls}`,
    );
  }

  // 14 — the conflict marker is DURABLE (lastError + lastErrorReason on the record)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(CONFLICT_RES));
    await enqCbd(h);
    await settle();
    const dump = h.storage.dump() ?? '';
    check(
      '14 conflict persisted as lastErrorReason on the record',
      dump.includes('"lastErrorReason":"conflict"') && dump.includes('"entity":"categoryBudget"'),
      dump,
    );
  }

  // 15 — failed-state namespace: categoryBudget:<id>, NOT category:<id> / budget:<id>
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(CONFLICT_RES));
    await enqCbd(h, { entityId: 'c-1' });
    await settle();
    const s = h.coord.getState();
    check(
      '15 failed state lives in the categoryBudget view only, not category / budget',
      s.categoryBudget.failedIds.has('c-1') &&
        !s.category.failedIds.has('c-1') &&
        !s.budget.failedIds.has('c-1'),
      `cb=${[...s.categoryBudget.failedIds]} c=${[...s.category.failedIds]} b=${[...s.budget.failedIds]}`,
    );
  }

  // 16 — a normal (non-includeFailed) flush does NOT re-run a terminal-failed composite
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setRpc(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_RES);
    });
    await enqCbd(h);
    await settle();
    h.coord.requestFlush();
    h.coord.requestFlush();
    await settle();
    check('16 auto flush does not blindly repeat a terminal-failed composite', calls === 1, `calls=${calls}`);
  }

  // 17 — includeFailed DOES give it one more attempt (existing manual-retry policy)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setRpc(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_RES);
    });
    await enqCbd(h);
    await settle();
    h.coord.requestFlush({ includeFailed: true });
    await settle();
    check('17 requestFlush({includeFailed}) retries the terminal-failed composite once more', calls === 2, `calls=${calls}`);
  }

  // 18 — restart: terminal-failed composite persisted -> fresh coordinator rebuilds failed state
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(CONFLICT_RES));
    await enqCbd(h);
    await settle();
    h.coord.dispose();
    const stored = h.storage.dump();

    const h2 = makeHarness({ seed: stored ?? undefined });
    h2.setRpc(() => Promise.resolve(CONFLICT_RES));
    await h2.coord.hydrate();
    await settle();
    const st = h2.coord.getState().categoryBudget;
    check(
      '18 restart -> failed composite restored, reason rebuilt from lastErrorReason',
      st.scopeOps.length === 1 && st.failedIds.has('c-1') && st.failedReasons.get('c-1') === 'conflict',
      `ops=${st.scopeOps.length} failed=${[...st.failedIds]} reason=${st.failedReasons.get('c-1')}`,
    );
  }

  /* ===================== scope / discard / count ===================== */

  // 19 — scope isolation: household B never sees household A's composite op
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    await enqCbd(h, { scope: A, entityId: 'c-1' });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState().categoryBudget;
    h.setScope(A);
    const underA = h.coord.getState().categoryBudget;
    check(
      '19 scope isolation: composite op hidden under B, visible again under A; durable record kept',
      underB.scopeOps.length === 0 &&
        underA.pendingIds.has('c-1') &&
        (h.storage.dump() ?? '').includes('categoryBudget'),
      `B=${underB.scopeOps.length} A=${[...underA.pendingIds]}`,
    );
  }

  // 20 — discard a terminal-failed composite: record removed, failed state cleared
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(CONFLICT_RES));
    await enqCbd(h);
    await settle();
    const rec = h.coord.getState().categoryBudget.scopeOps.find((o) => o.entityId === 'c-1');
    const out = await h.coord.discardPending(rec!.queueId);
    const st = h.coord.getState().categoryBudget;
    check(
      '20 discard a failed composite -> record gone, failed state cleared',
      out.ok === true && st.scopeOps.length === 0 && !st.failedIds.has('c-1'),
      JSON.stringify({ out, ops: st.scopeOps.length, failed: [...st.failedIds] }),
    );
  }

  // 21 — discard scope isolation: a queueId from A cannot be discarded under B
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    await enqCbd(h, { scope: A });
    await settle();
    const rec = h.coord.getState().categoryBudget.scopeOps.find((o) => o.entityId === 'c-1');
    h.setScope(B);
    const out = await h.coord.discardPending(rec!.queueId);
    h.setScope(A);
    const stillThere = h.coord.getState().categoryBudget.scopeOps.some((o) => o.queueId === rec!.queueId);
    check(
      "21 discard refuses a composite queueId not in the CURRENT scope",
      out.ok === false && out.reason === 'scope' && stillThere,
      JSON.stringify({ out, stillThere }),
    );
  }

  // 22 — discard causes NO server write (categories / budgets untouched)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1', 12345);
    h.setRpc(() => Promise.resolve(CONFLICT_RES));
    await enqCbd(h);
    await settle();
    const rpcBefore = h.rpcLog.length;
    const rec = h.coord.getState().categoryBudget.scopeOps.find((o) => o.entityId === 'c-1');
    await h.coord.discardPending(rec!.queueId);
    check(
      '22 discard is local-only: server category + budget rows untouched, no extra RPC',
      h.categories.has('c-1') && h.budgets.get('c-1') === 12345 && h.rpcLog.length === rpcBefore,
      `cats=${h.categories.has('c-1')} bud=${h.budgets.get('c-1')} rpc=${h.rpcLog.length}/${rpcBefore}`,
    );
  }

  // 23 — pendingCount includes the composite record (no +1 special-case needed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    await enqCbd(h);
    await settle();
    check(
      '23 pendingCount counts the composite delete',
      h.coord.getState().pendingCount === 1,
      `count=${h.coord.getState().pendingCount}`,
    );
  }

  /* ============ response-loss & legacy partial-state paths ============ */

  // 24 — response-loss: first attempt "transport" (reply lost) but the server
  // actually applied it; replay is idempotent -> both absent -> ack.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.catPut('c-1');
    h.budPut('c-1');
    let calls = 0;
    h.setRpc(async (args) => {
      calls += 1;
      h.rpcLog.push(args);
      await tick();
      if (calls === 1) {
        // server committed, then the response was lost on the wire
        h.categories.delete(args.categoryId);
        h.budgets.delete(args.categoryId);
        return TRANSPORT_RES;
      }
      return OK_RES; // idempotent replay
    });
    await enqCbd(h);
    await settle();
    h.runTimers(); // fire the backoff retry
    await settle(8);
    const st = h.coord.getState().categoryBudget;
    check(
      '24 response-loss -> idempotent replay -> both absent -> acked, no duplicate',
      calls === 2 && st.scopeOps.length === 0 && !h.categories.has('c-1') && !h.budgets.has('c-1'),
      `calls=${calls} ops=${st.scopeOps.length}`,
    );
  }

  // 25 — legacy partial (category already absent, budget present): replay with a
  // MATCHING budget token cleans it up -> eventual ack.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.budPut('c-1'); // category already gone, orphan budget remains
    h.setRpc(async (args) => {
      h.rpcLog.push(args);
      await tick();
      h.budgets.delete(args.categoryId); // token matched -> budget tombstoned
      return OK_RES;
    });
    await enqCbd(h);
    await settle(8);
    const st = h.coord.getState().categoryBudget;
    check(
      '25 legacy partial + matching token -> budget cleaned, both absent -> acked',
      h.rpcLog.length === 1 && st.scopeOps.length === 0 && !h.budgets.has('c-1'),
      `rpc=${h.rpcLog.length} ops=${st.scopeOps.length} bud=${h.budgets.has('c-1')}`,
    );
  }

  // 26 — legacy partial + MISMATCHED budget token -> RPC conflict -> retained failed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.budPut('c-1');
    let calls = 0;
    h.setRpc(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_RES);
    });
    await enqCbd(h);
    await settle();
    const st = h.coord.getState().categoryBudget;
    check(
      '26 legacy partial + token mismatch -> terminal conflict retained, budget untouched',
      calls === 1 && st.failedIds.has('c-1') && st.scopeOps.length === 1 && h.budgets.has('c-1'),
      `calls=${calls} failed=${[...st.failedIds]}`,
    );
  }

  // 27 — enqueue persist failure -> {ok:false, persist}, never visible
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setRpc(() => Promise.resolve(TRANSPORT_RES));
    h.storage.failSet(1);
    const enq = await enqCbd(h);
    await settle();
    check(
      '27 enqueue persist failure -> {ok:false, persist}, composite NOT visible',
      enq.ok === false &&
        enq.reason === 'persist' &&
        h.coord.getState().categoryBudget.scopeOps.length === 0,
      JSON.stringify(enq),
    );
  }

  // 28 — seeded from storage: flushes, both rows vanish -> ack removes it durably
  {
    const h = makeHarness({ seed: JSON.stringify([seedCbd({ queueId: 'q-s28', entityId: 'c-1' })]) });
    h.catPut('c-1');
    h.budPut('c-1');
    await h.coord.hydrate();
    await settle(8);
    check(
      '28 seeded composite -> flushes once, both rows gone -> durably acked',
      h.rpcLog.length === 1 &&
        h.coord.getState().categoryBudget.scopeOps.length === 0 &&
        !h.categories.has('c-1') &&
        !h.budgets.has('c-1'),
      `rpc=${h.rpcLog.length} ops=${h.coord.getState().categoryBudget.scopeOps.length}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
