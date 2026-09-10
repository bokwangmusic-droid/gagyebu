/**
 * Static verification for the Offline Write Queue replay adapter
 * (src/services/offlineQueue/runOp.ts). Uses a fake `createTransaction`;
 * never touches Supabase. Covers STEP 16-H2-A1 §8 and STEP 16-H2-A1.1
 * FIX 2 (knownCardIds is a REQUIRED dependency).
 */
import {
  QUEUE_SCHEMA_VERSION,
  type PendingCategoryBudgetDelete,
  type PendingTransactionCreate,
  type PendingTransactionDelete,
  type PendingTransactionUpdate,
} from '@/lib/offlineQueue';
import type { SoftDeleteCustomCategoryWithBudgetResult } from '@/services/remoteCategoryBudgetWrite';
import type {
  CreateTransactionResult,
  SoftDeleteResult,
  UpdateTransactionResult,
} from '@/services/remoteFinanceWrite';
import { runPendingWrite, type RunOpDeps } from '@/services/offlineQueue/runOp';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const op = (over: Partial<PendingTransactionCreate> = {}): PendingTransactionCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: { userId: 'u-A', householdId: 'h-A' },
  entity: 'transaction',
  op: 'create',
  entityId: 'txn-1',
  payload: {
    type: 'expense',
    category: 'food',
    amount: 1234,
    memo: 'x',
    date: '2026-09-10T09:00:00.000Z',
  },
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

type CreateArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: PendingTransactionCreate['payload'];
  knownCardIds: ReadonlySet<string>;
};

/** A fake createTransaction that records its args and returns `res`. */
function fakeCreate(
  res: CreateTransactionResult,
  sink?: { args: CreateArgs | null; called: boolean },
): RunOpDeps['createTransaction'] {
  return (args) => {
    if (sink) {
      sink.args = args;
      sink.called = true;
    }
    return Promise.resolve(res);
  };
}

export async function runQueueRunOpCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 29 — maps exact scope / id / draft to createTransaction args
  {
    const sink = { args: null as CreateArgs | null, called: false };
    const o = op({ entityId: 'txn-42', scope: { userId: 'u-X', householdId: 'h-Y' } });
    await runPendingWrite(o, {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: true, id: 'txn-42' }, sink),
    });
    check(
      'CASE 29 runOp maps entityId/householdId/expectedUserId/draft exactly',
      sink.args != null &&
        sink.args.id === 'txn-42' &&
        sink.args.householdId === 'h-Y' &&
        sink.args.expectedUserId === 'u-X' &&
        sink.args.draft === o.payload,
      `args=${JSON.stringify(sink.args)}`,
    );
  }

  // CASE 30 — success normalization
  {
    const out = await runPendingWrite(op(), {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: true, id: 'txn-1' }),
    });
    check('CASE 30 {ok:true} -> success', out.kind === 'success', JSON.stringify(out));
  }

  // CASE 31 — transport normalization
  {
    const out = await runPendingWrite(op(), {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: false, message: 'net', transport: true }),
    });
    check(
      'CASE 31 {ok:false, transport:true} -> transport',
      out.kind === 'transport' && out.message === 'net',
      JSON.stringify(out),
    );
  }

  // CASE 32 — terminal normalization (transport false OR absent)
  {
    const a = await runPendingWrite(op(), {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: false, message: 'bad', transport: false }),
    });
    const b = await runPendingWrite(op(), {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: false, message: 'weird' }),
    });
    check(
      'CASE 32 {ok:false} without transport -> terminal',
      a.kind === 'terminal' && b.kind === 'terminal',
      `a=${a.kind} b=${b.kind}`,
    );
  }

  // CASE 32b — an UNSUPPORTED entity (not transaction / not card) -> terminal,
  // service never called. `card` is supported since STEP 16-H2-C2-A1, so this
  // now uses a genuinely-unsupported entity.
  {
    const sink = { args: null as CreateArgs | null, called: false };
    const out = await runPendingWrite(
      { ...op(), entity: 'budget' as PendingTransactionCreate['entity'] },
      { knownCardIds: new Set<string>(), createTransaction: fakeCreate({ ok: true, id: 'x' }, sink) },
    );
    check(
      'CASE 32b unsupported entity -> terminal, no service called',
      out.kind === 'terminal' && sink.called === false,
      `out=${JSON.stringify(out)} called=${sink.called}`,
    );
  }

  // CASE 32c — a thrown service call is treated as transport (retry, not lost)
  {
    const out = await runPendingWrite(op(), {
      knownCardIds: new Set<string>(),
      createTransaction: () => {
        throw new Error('unexpected');
      },
    });
    check('CASE 32c thrown service -> transport', out.kind === 'transport', JSON.stringify(out));
  }

  // ---- STEP 16-H2-A1.1 FIX 2: knownCardIds is a required dependency ----

  // CASE F2-A — no cardId in the draft -> runs fine
  {
    const sink = { args: null as CreateArgs | null, called: false };
    const out = await runPendingWrite(op({ payload: { ...op().payload } }), {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: true, id: 'txn-1' }, sink),
    });
    check(
      'CASE F2-A no cardId -> success, empty knownCardIds passed through',
      out.kind === 'success' && sink.args?.knownCardIds.size === 0,
      JSON.stringify(out),
    );
  }

  // CASE F2-B — cardId present + in knownCardIds -> passed through exactly
  {
    const sink = { args: null as CreateArgs | null, called: false };
    await runPendingWrite(op({ payload: { ...op().payload, cardId: 'card-1' } }), {
      knownCardIds: new Set(['card-1']),
      createTransaction: fakeCreate({ ok: true, id: 'txn-1' }, sink),
    });
    check(
      'CASE F2-B known cardId -> knownCardIds forwarded to createTransaction',
      sink.args != null &&
        sink.args.knownCardIds.has('card-1') &&
        sink.args.draft.cardId === 'card-1',
      `args=${JSON.stringify({ has: sink.args?.knownCardIds.has('card-1'), cardId: sink.args?.draft.cardId })}`,
    );
  }

  // CASE F2-C — cardId present but knownCardIds empty -> forwarded as-is
  // (runOp does NOT change createTransaction's unknown-card policy)
  {
    const sink = { args: null as CreateArgs | null, called: false };
    const out = await runPendingWrite(op({ payload: { ...op().payload, cardId: 'card-1' } }), {
      knownCardIds: new Set<string>(),
      createTransaction: fakeCreate({ ok: true, id: 'txn-1' }, sink),
    });
    check(
      'CASE F2-C empty knownCardIds forwarded verbatim (policy unchanged, op still runs)',
      out.kind === 'success' &&
        sink.args?.knownCardIds.size === 0 &&
        sink.args?.draft.cardId === 'card-1',
      JSON.stringify({ size: sink.args?.knownCardIds.size, cardId: sink.args?.draft.cardId }),
    );
  }

  // CASE F2-D — a JS caller that omits knownCardIds (bypassing the type) is
  // NOT silently given an empty Set — it gets a terminal internal failure.
  {
    const sink = { args: null as CreateArgs | null, called: false };
    const out = await runPendingWrite(
      op(),
      { createTransaction: fakeCreate({ ok: true, id: 'txn-1' }, sink) } as unknown as RunOpDeps,
    );
    check(
      'CASE F2-D omitted knownCardIds -> terminal internal failure, service not called',
      out.kind === 'terminal' && out.message.includes('knownCardIds') && sink.called === false,
      `out=${JSON.stringify(out)} called=${sink.called}`,
    );
  }

  /* ---------------- STEP 16-H2-B1: UPDATE / DELETE adapters ---------------- */

  const upd = (over: Partial<PendingTransactionUpdate> = {}): PendingTransactionUpdate => ({
    queueId: 'q-u',
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: 'u-A', householdId: 'h-A' },
    entity: 'transaction',
    op: 'update',
    entityId: 'txn-1',
    payload: { type: 'expense', category: 'food', amount: 1234, memo: 'x', date: '2026-09-10T09:00:00.000Z' },
    expectedUpdatedAt: 'FROZEN-V1',
    originalRawCardId: null,
    enqueuedAt: '2026-09-10T09:00:00.000Z',
    attemptCount: 0,
    ...over,
  });
  const del = (over: Partial<PendingTransactionDelete> = {}): PendingTransactionDelete => ({
    queueId: 'q-d',
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: 'u-A', householdId: 'h-A' },
    entity: 'transaction',
    op: 'delete',
    entityId: 'txn-1',
    expectedUpdatedAt: 'FROZEN-V1',
    enqueuedAt: '2026-09-10T09:00:00.000Z',
    attemptCount: 0,
    ...over,
  });

  type UpdArgs = {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
    draft: PendingTransactionUpdate['payload'];
    knownCardIds: ReadonlySet<string>;
    originalRawCardId?: string | null;
  };
  type DelArgs = { id: string; householdId: string; expectedUserId: string; expectedUpdatedAt: string };

  const fakeUpdate =
    (res: UpdateTransactionResult, sink?: { args: UpdArgs | null }): RunOpDeps['updateTransaction'] =>
    (args) => {
      if (sink) sink.args = args;
      return Promise.resolve(res);
    };
  const fakeDelete =
    (res: SoftDeleteResult, sink?: { args: DelArgs | null }): RunOpDeps['softDeleteTransaction'] =>
    (args) => {
      if (sink) sink.args = args;
      return Promise.resolve(res);
    };

  // CASE 33 — UPDATE forwards the EXACT frozen expectedUpdatedAt + draft + knownCardIds + originalRawCardId
  {
    const sink = { args: null as UpdArgs | null };
    const o = upd({
      entityId: 'txn-9',
      scope: { userId: 'u-X', householdId: 'h-Y' },
      expectedUpdatedAt: 'V1-FROZEN',
      originalRawCardId: 'card-dead',
    });
    await runPendingWrite(o, {
      knownCardIds: new Set(['card-live']),
      updateTransaction: fakeUpdate({ ok: true, updatedAt: 'V2' }, sink),
    });
    check(
      'CASE 33 UPDATE runOp forwards frozen token / draft / knownCardIds / originalRawCardId verbatim',
      !!sink.args &&
        sink.args.id === 'txn-9' &&
        sink.args.householdId === 'h-Y' &&
        sink.args.expectedUserId === 'u-X' &&
        sink.args.expectedUpdatedAt === 'V1-FROZEN' &&
        sink.args.draft === o.payload &&
        sink.args.originalRawCardId === 'card-dead' &&
        sink.args.knownCardIds.has('card-live'),
      JSON.stringify(sink.args),
    );
  }

  // CASE 34 — UPDATE success normalize
  {
    const out = await runPendingWrite(upd(), {
      knownCardIds: new Set<string>(),
      updateTransaction: fakeUpdate({ ok: true, updatedAt: 'V2' }),
    });
    check('CASE 34 UPDATE {ok:true} -> success', out.kind === 'success', JSON.stringify(out));
  }

  // CASE 35 — UPDATE transport normalize
  {
    const out = await runPendingWrite(upd(), {
      knownCardIds: new Set<string>(),
      updateTransaction: fakeUpdate({ ok: false, reason: 'error', message: 'net', transport: true }),
    });
    check('CASE 35 UPDATE transport -> {kind:transport}', out.kind === 'transport', JSON.stringify(out));
  }

  // CASE 36 — UPDATE conflict reason PRESERVED (not collapsed to message)
  {
    const out = await runPendingWrite(upd(), {
      knownCardIds: new Set<string>(),
      updateTransaction: fakeUpdate({ ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' }),
    });
    check(
      'CASE 36 UPDATE conflict -> {kind:terminal, reason:"conflict"}',
      out.kind === 'terminal' && out.reason === 'conflict',
      JSON.stringify(out),
    );
  }

  // CASE 37 — UPDATE deleted / gone reasons preserved
  {
    const d = await runPendingWrite(upd(), {
      knownCardIds: new Set<string>(),
      updateTransaction: fakeUpdate({ ok: false, reason: 'deleted', message: 'x' }),
    });
    const g = await runPendingWrite(upd(), {
      knownCardIds: new Set<string>(),
      updateTransaction: fakeUpdate({ ok: false, reason: 'gone', message: 'x' }),
    });
    check(
      'CASE 37 UPDATE deleted/gone reasons preserved',
      d.kind === 'terminal' && d.reason === 'deleted' && g.kind === 'terminal' && g.reason === 'gone',
      `d=${JSON.stringify(d)} g=${JSON.stringify(g)}`,
    );
  }

  // CASE 38 — DELETE forwards the EXACT frozen expectedUpdatedAt; no draft/knownCardIds needed
  {
    const sink = { args: null as DelArgs | null };
    const o = del({ entityId: 'txn-7', scope: { userId: 'u-P', householdId: 'h-Q' }, expectedUpdatedAt: 'DEL-V1' });
    await runPendingWrite(o, {
      knownCardIds: new Set<string>(),
      softDeleteTransaction: fakeDelete({ ok: true }, sink),
    });
    check(
      'CASE 38 DELETE runOp forwards id / household / user / frozen token',
      !!sink.args &&
        sink.args.id === 'txn-7' &&
        sink.args.householdId === 'h-Q' &&
        sink.args.expectedUserId === 'u-P' &&
        sink.args.expectedUpdatedAt === 'DEL-V1',
      JSON.stringify(sink.args),
    );
  }

  // CASE 39 — DELETE success normalize (incl. the already-deleted idempotent path,
  // which the SERVICE surfaces as {ok:true} — runOp just passes it through)
  {
    const out = await runPendingWrite(del(), {
      knownCardIds: new Set<string>(),
      softDeleteTransaction: fakeDelete({ ok: true }),
    });
    check('CASE 39 DELETE {ok:true} (incl. already-deleted) -> success', out.kind === 'success', JSON.stringify(out));
  }

  // CASE 40 — DELETE transport normalize
  {
    const out = await runPendingWrite(del(), {
      knownCardIds: new Set<string>(),
      softDeleteTransaction: fakeDelete({ ok: false, reason: 'error', message: 'net', transport: true }),
    });
    check('CASE 40 DELETE transport -> {kind:transport}', out.kind === 'transport', JSON.stringify(out));
  }

  // CASE 41 — DELETE conflict / gone reasons preserved
  {
    const c = await runPendingWrite(del(), {
      knownCardIds: new Set<string>(),
      softDeleteTransaction: fakeDelete({ ok: false, reason: 'conflict', message: 'x' }),
    });
    const g = await runPendingWrite(del(), {
      knownCardIds: new Set<string>(),
      softDeleteTransaction: fakeDelete({ ok: false, reason: 'gone', message: 'x' }),
    });
    check(
      'CASE 41 DELETE conflict/gone reasons preserved',
      c.kind === 'terminal' && c.reason === 'conflict' && g.kind === 'terminal' && g.reason === 'gone',
      `c=${JSON.stringify(c)} g=${JSON.stringify(g)}`,
    );
  }

  // CASE 42 — UPDATE/DELETE: a thrown service is treated as transport (not lost)
  {
    const u = await runPendingWrite(upd(), {
      knownCardIds: new Set<string>(),
      updateTransaction: () => {
        throw new Error('boom');
      },
    });
    const d = await runPendingWrite(del(), {
      knownCardIds: new Set<string>(),
      softDeleteTransaction: () => {
        throw new Error('boom');
      },
    });
    check(
      'CASE 42 thrown UPDATE/DELETE service -> transport (conservative retain)',
      u.kind === 'transport' && d.kind === 'transport',
      `${u.kind} ${d.kind}`,
    );
  }

  /* ------- STEP 16-H2 A4.2: composite category+budget delete adapter ------- */

  const cbd = (
    over: Partial<PendingCategoryBudgetDelete> = {},
  ): PendingCategoryBudgetDelete => ({
    queueId: 'q-cbd',
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: 'u-A', householdId: 'h-A' },
    entity: 'categoryBudget',
    op: 'delete',
    entityId: 'c-1',
    expectedCategoryUpdatedAt: 'CAT-FROZEN',
    expectedBudgetUpdatedAt: 'BUD-FROZEN',
    enqueuedAt: '2026-09-10T09:00:00.000Z',
    attemptCount: 0,
    ...over,
  });

  type CbdArgs = {
    householdId: string;
    categoryId: string;
    expectedUserId: string;
    expectedCategoryUpdatedAt: string;
    expectedBudgetUpdatedAt: string | null;
  };
  const fakeCbd =
    (
      res: SoftDeleteCustomCategoryWithBudgetResult,
      sink?: { args: CbdArgs | null; calls: number },
    ): RunOpDeps['softDeleteCustomCategoryWithBudget'] =>
    (args) => {
      if (sink) {
        sink.args = args;
        sink.calls += 1;
      }
      return Promise.resolve(res);
    };

  // CASE 43 — composite success normalize
  {
    const out = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd({
        ok: true,
        categoryDeletedAt: '2026-09-11T00:00:00.000Z',
        budgetDeletedAt: '2026-09-11T00:00:00.000Z',
      }),
    });
    check('CASE 43 composite {ok:true} -> success', out.kind === 'success', JSON.stringify(out));
  }

  // CASE 44 — transport normalize
  {
    const out = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd({
        ok: false,
        reason: 'error',
        message: 'net',
        transport: true,
      }),
    });
    check(
      'CASE 44 composite transport -> {kind:transport}',
      out.kind === 'transport' && out.message === 'net',
      JSON.stringify(out),
    );
  }

  // CASE 45 — conflict reason preserved (terminal, not collapsed)
  {
    const out = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd({ ok: false, reason: 'conflict', message: 'x' }),
    });
    check(
      'CASE 45 composite conflict -> {kind:terminal, reason:"conflict"}',
      out.kind === 'terminal' && out.reason === 'conflict',
      JSON.stringify(out),
    );
  }

  // CASE 46/47 — identity / gone reasons preserved
  {
    const i = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd({ ok: false, reason: 'identity', message: 'x' }),
    });
    const g = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd({ ok: false, reason: 'gone', message: 'x' }),
    });
    check(
      'CASE 46/47 composite identity/gone reasons preserved',
      i.kind === 'terminal' &&
        i.reason === 'identity' &&
        g.kind === 'terminal' &&
        g.reason === 'gone',
      `i=${JSON.stringify(i)} g=${JSON.stringify(g)}`,
    );
  }

  // CASE 48 — generic error reason preserved
  {
    const out = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd({ ok: false, reason: 'error', message: 'boom' }),
    });
    check(
      'CASE 48 composite generic error -> {kind:terminal, reason:"error"}',
      out.kind === 'terminal' && out.reason === 'error',
      JSON.stringify(out),
    );
  }

  // CASE 49 — scope/id + BOTH frozen tokens forwarded verbatim (string budget token)
  {
    const sink = { args: null as CbdArgs | null, calls: 0 };
    const o = cbd({
      entityId: 'c-42',
      scope: { userId: 'u-X', householdId: 'h-Y' },
      expectedCategoryUpdatedAt: 'CAT-V1',
      expectedBudgetUpdatedAt: 'BUD-V1',
    });
    await runPendingWrite(o, {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd(
        { ok: true, categoryDeletedAt: 't', budgetDeletedAt: 't' },
        sink,
      ),
    });
    check(
      'CASE 49 composite forwards householdId/categoryId/expectedUserId + BOTH frozen tokens verbatim',
      !!sink.args &&
        sink.args.householdId === 'h-Y' &&
        sink.args.categoryId === 'c-42' &&
        sink.args.expectedUserId === 'u-X' &&
        sink.args.expectedCategoryUpdatedAt === 'CAT-V1' &&
        sink.args.expectedBudgetUpdatedAt === 'BUD-V1',
      JSON.stringify(sink.args),
    );
  }

  // CASE 50 — expectedBudgetUpdatedAt null forwarded as null; RPC called EXACTLY once
  {
    const sink = { args: null as CbdArgs | null, calls: 0 };
    await runPendingWrite(cbd({ expectedBudgetUpdatedAt: null }), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd(
        { ok: true, categoryDeletedAt: 't', budgetDeletedAt: null },
        sink,
      ),
    });
    check(
      'CASE 50 composite: null budget token forwarded verbatim, RPC called exactly once',
      sink.args?.expectedBudgetUpdatedAt === null && sink.calls === 1,
      JSON.stringify({ tok: sink.args?.expectedBudgetUpdatedAt, calls: sink.calls }),
    );
  }

  // CASE 51 — replay = ONE atomic RPC; the single-table category / budget
  // delete services are NEVER called for a composite record.
  {
    const rpcSink = { args: null as CbdArgs | null, calls: 0 };
    const catCalls = { n: 0 };
    const budCalls = { n: 0 };
    const out = await runPendingWrite(cbd(), {
      knownCardIds: new Set<string>(),
      softDeleteCustomCategoryWithBudget: fakeCbd(
        { ok: true, categoryDeletedAt: 't', budgetDeletedAt: 't' },
        rpcSink,
      ),
      softDeleteCategory: (() => {
        catCalls.n += 1;
        return Promise.resolve({ ok: true });
      }) as RunOpDeps['softDeleteCategory'],
      softDeleteBudget: (() => {
        budCalls.n += 1;
        return Promise.resolve({ ok: true });
      }) as RunOpDeps['softDeleteBudget'],
    });
    check(
      'CASE 51 composite replay = ONE atomic RPC; single-table category/budget delete never called',
      out.kind === 'success' && rpcSink.calls === 1 && catCalls.n === 0 && budCalls.n === 0,
      JSON.stringify({ rpc: rpcSink.calls, cat: catCalls.n, bud: budCalls.n }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
