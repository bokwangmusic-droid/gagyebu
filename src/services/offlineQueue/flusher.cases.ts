/**
 * Static verification for the Offline Write Queue flusher
 * (src/services/offlineQueue/flusher.ts). Fake getOps / runOp / onPass;
 * no Supabase, no persistence.
 */
import { QUEUE_SCHEMA_VERSION, type PendingTransactionCreate } from '@/lib/offlineQueue';
import {
  createWriteQueueFlusher,
  type FlushPassResult,
  type FlushScope,
} from '@/services/offlineQueue/flusher';
import type { RunOpOutcome } from '@/services/offlineQueue/runOp';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const op = (queueId: string, over: Partial<PendingTransactionCreate> = {}): PendingTransactionCreate => ({
  queueId,
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: { userId: 'u-A', householdId: 'h-A' },
  entity: 'transaction',
  op: 'create',
  entityId: `txn-${queueId}`,
  payload: { type: 'expense', category: 'food', amount: 1, memo: '', date: '2026-09-10T00:00:00.000Z' },
  enqueuedAt: '2026-09-10T00:00:00.000Z',
  attemptCount: 0,
  ...over,
});

const A: FlushScope = { userId: 'u-A', householdId: 'h-A' };
const B: FlushScope = { userId: 'u-A', householdId: 'h-B' };

interface Harness {
  queue: PendingTransactionCreate[];
  script: Map<string, RunOpOutcome[]>; // queueId -> outcomes per attempt
  runCalls: string[];
  maxConcurrent: number;
  passes: FlushPassResult[];
  flusher: ReturnType<typeof createWriteQueueFlusher>;
}

function makeHarness(initial: PendingTransactionCreate[], script: Record<string, RunOpOutcome | RunOpOutcome[]>): Harness {
  const h: Harness = {
    queue: initial.slice(),
    script: new Map(
      Object.entries(script).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : [v]]),
    ),
    runCalls: [],
    maxConcurrent: 0,
    passes: [],
    flusher: null as unknown as ReturnType<typeof createWriteQueueFlusher>,
  };
  let inFlight = 0;
  h.flusher = createWriteQueueFlusher({
    getOps: (scope) =>
      h.queue.filter(
        (o) => o.scope.userId === scope.userId && o.scope.householdId === scope.householdId,
      ),
    runOp: async (o) => {
      inFlight += 1;
      h.maxConcurrent = Math.max(h.maxConcurrent, inFlight);
      h.runCalls.push(o.queueId);
      await flush();
      inFlight -= 1;
      const seq = h.script.get(o.queueId) ?? [{ kind: 'success' } as RunOpOutcome];
      return seq.length > 1 ? (seq.shift() as RunOpOutcome) : seq[0];
    },
    onPass: (res) => {
      h.passes.push(res);
      // simulate the caller: durably remove settled + terminal AFTER "refresh"
      const remove = new Set([
        ...res.settled.map((s) => s.queueId),
        ...res.terminal.map((t) => t.queueId),
      ]);
      h.queue = h.queue.filter((o) => !remove.has(o.queueId));
    },
  });
  return h;
}

export async function runQueueFlusherCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 20 — one trigger -> one pass, item drained
  {
    const h = makeHarness([op('q1')], { q1: { kind: 'success' } });
    h.flusher.setScope(A);
    await h.flusher.request();
    await flush();
    check(
      'CASE 20 one trigger -> one pass, settled',
      h.passes.length === 1 && h.passes[0].settled.length === 1 && h.queue.length === 0,
      `passes=${h.passes.length} settled=${h.passes[0]?.settled.length}`,
    );
  }

  // CASE 21 — simultaneous triggers -> single-flight, no parallel runOp
  {
    const h = makeHarness([op('q1'), op('q2')], { q1: { kind: 'success' }, q2: { kind: 'success' } });
    h.flusher.setScope(A);
    const p1 = h.flusher.request();
    const p2 = h.flusher.request();
    const p3 = h.flusher.request();
    await Promise.all([p1, p2, p3]);
    await flush();
    check(
      'CASE 21 concurrent triggers coalesced, runOp never parallel',
      h.maxConcurrent === 1 && h.queue.length === 0,
      `maxConcurrent=${h.maxConcurrent}`,
    );
  }

  // CASE 22 — FIFO order
  {
    const h = makeHarness([op('q1'), op('q2'), op('q3')], {
      q1: { kind: 'success' },
      q2: { kind: 'success' },
      q3: { kind: 'success' },
    });
    h.flusher.setScope(A);
    await h.flusher.request();
    await flush();
    check('CASE 22 runOp called in FIFO order', h.runCalls.join(',') === 'q1,q2,q3', h.runCalls.join(','));
  }

  // CASE 23 — transport failure halts the pass; later items retained
  {
    const h = makeHarness([op('q1'), op('q2'), op('q3')], {
      q1: { kind: 'success' },
      q2: { kind: 'transport', message: 'offline' },
      q3: { kind: 'success' },
    });
    h.flusher.setScope(A);
    await h.flusher.request();
    await flush();
    check(
      'CASE 23 transport halts: q3 not attempted, q2+q3 retained',
      h.runCalls.join(',') === 'q1,q2' &&
        h.passes[0].haltedByTransport === true &&
        h.queue.map((o) => o.queueId).join(',') === 'q2,q3',
      `runCalls=${h.runCalls.join(',')} queue=${h.queue.map((o) => o.queueId).join(',')}`,
    );
  }

  // CASE 24 — terminal failure is reported, pass continues
  {
    const h = makeHarness([op('q1'), op('q2'), op('q3')], {
      q1: { kind: 'success' },
      q2: { kind: 'terminal', message: 'identity' },
      q3: { kind: 'success' },
    });
    h.flusher.setScope(A);
    await h.flusher.request();
    await flush();
    check(
      'CASE 24 terminal reported, q3 still attempted',
      h.runCalls.join(',') === 'q1,q2,q3' &&
        h.passes[0].terminal.length === 1 &&
        h.passes[0].terminal[0].queueId === 'q2' &&
        h.passes[0].settled.map((s) => s.queueId).join(',') === 'q1,q3',
      `terminal=${JSON.stringify(h.passes[0].terminal)}`,
    );
  }

  // CASE 25 — scope change mid-pass aborts remaining items
  {
    const h = makeHarness([op('q1'), op('q2'), op('q3')], {
      q1: { kind: 'success' },
      q2: { kind: 'success' },
      q3: { kind: 'success' },
    });
    h.flusher.setScope(A);
    const p = h.flusher.request();
    await flush(); // q1 in flight
    h.flusher.setScope(B); // switch account/household mid-pass
    await p;
    await flush();
    check(
      'CASE 25 scope change aborts: not all items run, pass marked aborted',
      h.runCalls.length < 3 && h.passes.some((x) => x.aborted === true),
      `runCalls=${JSON.stringify(h.runCalls)} aborted=${h.passes.map((x) => x.aborted)}`,
    );
  }

  // CASE 26 — dispose stops future work
  {
    const h = makeHarness([op('q1')], { q1: { kind: 'success' } });
    h.flusher.setScope(A);
    h.flusher.dispose();
    await h.flusher.request();
    await flush();
    check(
      'CASE 26 dispose -> request is a no-op, runOp never called',
      h.runCalls.length === 0 && h.passes.length === 0,
      `runCalls=${h.runCalls.length}`,
    );
  }

  // CASE 27 — success is NOT durably removed by the flusher itself
  {
    const removals: string[] = [];
    const queue = [op('q1')];
    const flusher = createWriteQueueFlusher({
      getOps: (s) => queue.filter((o) => o.scope.userId === s.userId && o.scope.householdId === s.householdId),
      runOp: () => Promise.resolve({ kind: 'success' } as RunOpOutcome),
      onPass: (res) => {
        // caller deliberately does NOT remove anything here
        removals.push(...res.settled.map((s) => s.queueId));
      },
    });
    flusher.setScope(A);
    await flusher.request();
    await flush();
    check(
      'CASE 27 flusher reports settled but leaves the item in the queue (caller acks)',
      queue.length === 1 && removals.join(',') === 'q1',
      `queueLen=${queue.length} reported=${removals.join(',')}`,
    );
  }

  // CASE 28 — crash/reload: a settled-but-unacked item is replayed safely
  {
    // pass 1: runOp says success, but the "caller" crashes before removing it
    const queue = [op('q1')];
    let attempts = 0;
    const mkFlusher = () =>
      createWriteQueueFlusher({
        getOps: (s) => queue.filter((o) => o.scope.userId === s.userId && o.scope.householdId === s.householdId),
        runOp: () => {
          attempts += 1;
          return Promise.resolve({ kind: 'success' } as RunOpOutcome); // idempotent server (23505 reconcile)
        },
        onPass: () => {
          /* crash: no durable removal */
        },
      });
    const f1 = mkFlusher();
    f1.setScope(A);
    await f1.request();
    await flush();
    f1.dispose();
    // "reload": brand new flusher, same still-present queue
    const f2 = mkFlusher();
    f2.setScope(A);
    await f2.request();
    await flush();
    check(
      'CASE 28 unacked success replays without error (idempotent); item still queued',
      attempts === 2 && queue.length === 1,
      `attempts=${attempts} queueLen=${queue.length}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
