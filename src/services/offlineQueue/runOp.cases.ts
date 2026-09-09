/**
 * Static verification for the Offline Write Queue replay adapter
 * (src/services/offlineQueue/runOp.ts). Uses a fake `createTransaction`;
 * never touches Supabase. Covers STEP 16-H2-A1 §8 and STEP 16-H2-A1.1
 * FIX 2 (knownCardIds is a REQUIRED dependency).
 */
import { QUEUE_SCHEMA_VERSION, type PendingWrite } from '@/lib/offlineQueue';
import type { CreateTransactionResult } from '@/services/remoteFinanceWrite';
import { runPendingWrite, type RunOpDeps } from '@/services/offlineQueue/runOp';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const op = (over: Partial<PendingWrite> = {}): PendingWrite => ({
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
  draft: PendingWrite['payload'];
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

  // CASE 32b — unsupported entity/op -> terminal, service never called
  {
    const sink = { args: null as CreateArgs | null, called: false };
    const out = await runPendingWrite(
      { ...op(), entity: 'card' as PendingWrite['entity'] },
      { knownCardIds: new Set<string>(), createTransaction: fakeCreate({ ok: true, id: 'x' }, sink) },
    );
    check(
      'CASE 32b unsupported op -> terminal, createTransaction not called',
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

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
