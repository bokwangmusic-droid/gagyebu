/**
 * Static verification for Offline Write Queue persistence
 * (src/services/offlineQueue/persistence.ts) — in-memory / failing / flaky
 * storage stubs, never real AsyncStorage. Covers STEP 16-H2-A1 §4/§5 and the
 * STEP 16-H2-A1.1 FIX 1 read-failure contract.
 */
import { QUEUE_SCHEMA_VERSION, type PendingWrite } from '@/lib/offlineQueue';
import {
  createQueueController,
  loadPendingWrites,
  persistPendingWrites,
  type QueueStorage,
} from '@/services/offlineQueue/persistence';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const rec = (over: Partial<PendingWrite> = {}): PendingWrite => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: { userId: 'u-A', householdId: 'h-A' },
  entity: 'transaction',
  op: 'create',
  entityId: 'txn-1',
  payload: {
    type: 'expense',
    category: 'food',
    amount: 1000,
    memo: '',
    date: '2026-09-10T09:00:00.000Z',
  },
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

/** In-memory storage with an inspectable backing value. */
function memStorage(seed?: string) {
  let value: string | null = seed ?? null;
  return {
    getItem: () => Promise.resolve(value),
    setItem: (_k: string, v: string) => {
      value = v;
      return Promise.resolve();
    },
    dump: () => value,
  };
}

function slowMemStorage() {
  let value: string | null = null;
  return {
    getItem: () => Promise.resolve(value),
    setItem: async (_k: string, v: string) => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8)));
      value = v;
    },
    dump: () => value,
  };
}

/** getItem rejects the first `failFirst` calls, then serves `seed`. setItem always works. */
function flakyStorage(seed: string, failFirst: number) {
  let value: string | null = seed;
  let gets = 0;
  return {
    getItem: () => {
      gets += 1;
      if (gets <= failFirst) return Promise.reject(new Error(`getItem transient #${gets}`));
      return Promise.resolve(value);
    },
    setItem: (_k: string, v: string) => {
      value = v;
      return Promise.resolve();
    },
    dump: () => value,
  };
}

const failStorage: QueueStorage = {
  getItem: () => Promise.reject(new Error('boom-get')),
  setItem: () => Promise.reject(new Error('disk full')),
};

const idsOf = (json: string | null): string[] =>
  json == null ? [] : (JSON.parse(json) as PendingWrite[]).map((r) => r.entityId);

export async function runQueuePersistenceCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // CASE 13 — missing key -> ok:true, []
  {
    const res = await loadPendingWrites(memStorage());
    check(
      'CASE 13 missing key -> {ok:true, records:[]}',
      res.ok === true && res.records.length === 0 && res.dropped === 0,
      JSON.stringify(res),
    );
  }

  // CASE 14 — valid round-trip
  {
    const s = memStorage();
    const p = await persistPendingWrites([rec({ queueId: 'q-a', entityId: 'txn-a' })], s);
    const res = await loadPendingWrites(s);
    check(
      'CASE 14 persist -> load round-trip',
      p.ok === true && res.ok === true && res.records.length === 1 && res.records[0].entityId === 'txn-a',
      `p=${JSON.stringify(p)}`,
    );
  }

  // CASE 15 — corrupt JSON -> ok:true, [] (unrecoverable, distinct from read failure)
  {
    const res = await loadPendingWrites(memStorage('{not json'));
    check('CASE 15 corrupt JSON -> {ok:true, records:[]}', res.ok === true && res.records.length === 0, JSON.stringify(res));
  }

  // CASE 15b — non-array JSON -> ok:true, []
  {
    const res = await loadPendingWrites(memStorage('{"a":1}'));
    check('CASE 15b non-array JSON -> {ok:true, records:[]}', res.ok === true && res.records.length === 0, JSON.stringify(res));
  }

  // CASE 16 — mixed valid/invalid -> valid only, count dropped, order kept
  {
    const stored = JSON.stringify([
      rec({ queueId: 'q-1', entityId: 'txn-1' }),
      { junk: true },
      { ...rec({ queueId: 'q-2', entityId: 'txn-2' }), schemaVersion: 999 },
      rec({ queueId: 'q-3', entityId: 'txn-3' }),
    ] as unknown[]);
    const res = await loadPendingWrites(memStorage(stored));
    check(
      'CASE 16 mixed valid/invalid -> valid subset in order, dropped counted',
      res.ok === true &&
        res.records.map((r) => r.entityId).join(',') === 'txn-1,txn-3' &&
        res.dropped === 2,
      JSON.stringify(res),
    );
  }

  // CASE 17 — getItem reject -> {ok:false, error}  (NOT an empty queue)
  {
    let threw = false;
    let res: Awaited<ReturnType<typeof loadPendingWrites>> | undefined;
    try {
      res = await loadPendingWrites(failStorage);
    } catch {
      threw = true;
    }
    check(
      'CASE 17 getItem reject -> {ok:false, error} (no throw, NOT [])',
      threw === false && res?.ok === false && res.error != null,
      `threw=${threw} res=${JSON.stringify(res)}`,
    );
  }

  // CASE 18 — persistence failure is OBSERVABLE (not silent)
  {
    const p = await persistPendingWrites([rec()], failStorage);
    check(
      'CASE 18 persist failure returns {ok:false, error}',
      p.ok === false && typeof p.error === 'string' && p.error.length > 0,
      JSON.stringify(p),
    );
  }

  // CASE 19 — concurrent mutations are serialized (no lost update)
  {
    const s = slowMemStorage();
    const ctrl = createQueueController();
    const hy = await ctrl.hydrate(s);
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(
        ctrl.mutate(
          (cur) => ({
            next: [...cur, rec({ queueId: `q-${i}`, entityId: `txn-${i}` })],
            result: i,
          }),
          s,
        ),
      );
    }
    const outcomes = await Promise.all(jobs);
    const allPersisted = outcomes.every((o) => o.persist.ok);
    const inMem = ctrl.read().map((r) => r.entityId).join(',');
    const reloaded = idsOf(s.dump()).join(',');
    check(
      'CASE 19 serialized mutate: all 10 present, in order, memory == storage',
      hy.ok === true &&
        allPersisted &&
        inMem === 'txn-0,txn-1,txn-2,txn-3,txn-4,txn-5,txn-6,txn-7,txn-8,txn-9' &&
        reloaded === inMem,
      `inMem=${inMem} reloaded=${reloaded}`,
    );
  }

  // CASE 19b — persist failure -> in-memory unchanged, caller sees {ok:false}
  {
    const good = memStorage();
    const ctrl = createQueueController();
    await ctrl.hydrate(good);
    await ctrl.mutate((cur) => ({ next: [...cur, rec({ queueId: 'q-keep', entityId: 'txn-keep' })], result: 0 }), good);
    const before = ctrl.read().map((r) => r.entityId).join(',');
    const out = await ctrl.mutate(
      (cur) => ({ next: [...cur, rec({ queueId: 'q-lost', entityId: 'txn-lost' })], result: 0 }),
      failStorage,
    );
    const after = ctrl.read().map((r) => r.entityId).join(',');
    check(
      'CASE 19b persist failure -> in-memory unchanged, caller sees {ok:false}',
      out.persist.ok === false && before === after,
      `before=${before} after=${after}`,
    );
  }

  // ---- STEP 16-H2-A1.1 FIX 1: read-failure must not become an empty queue ----

  // CASE F1-1..8 — A/B/C in storage; first hydrate's getItem rejects; the
  // controller stays NOT hydrated; enqueue D is REFUSED (storage untouched);
  // a later hydrate retry succeeds and recovers A/B/C; then D enqueues;
  // storage ends as A,B,C,D.
  {
    const seeded = JSON.stringify([
      rec({ queueId: 'q-A', entityId: 'txn-A' }),
      rec({ queueId: 'q-B', entityId: 'txn-B' }),
      rec({ queueId: 'q-C', entityId: 'txn-C' }),
    ]);
    const s = flakyStorage(seeded, 1); // first getItem rejects, then works
    const ctrl = createQueueController();

    const hy1 = await ctrl.hydrate(s); // getItem rejects
    const notHydrated = ctrl.isHydrated() === false && hy1.ok === false;

    const d = await ctrl.mutate(
      (cur) => ({ next: [...cur, rec({ queueId: 'q-D', entityId: 'txn-D' })], result: 0 }),
      s,
    );
    const refused = d.blockedNotHydrated === true && d.persist.ok === false;
    const storageStillABC = idsOf(s.dump()).join(',') === 'txn-A,txn-B,txn-C';

    const hy2 = await ctrl.hydrate(s); // retry succeeds
    const recovered =
      hy2.ok === true && ctrl.isHydrated() && ctrl.read().map((r) => r.entityId).join(',') === 'txn-A,txn-B,txn-C';

    const d2 = await ctrl.mutate(
      (cur) => ({ next: [...cur, rec({ queueId: 'q-D', entityId: 'txn-D' })], result: 0 }),
      s,
    );
    const finalOk = d2.persist.ok === true && idsOf(s.dump()).join(',') === 'txn-A,txn-B,txn-C,txn-D';

    check(
      'CASE F1 read failure -> not hydrated -> enqueue refused (no overwrite) -> retry recovers A/B/C -> D appends',
      notHydrated && refused && storageStillABC && recovered && finalOk,
      `notHydrated=${notHydrated} refused=${refused} stillABC=${storageStillABC} recovered=${recovered} final=${idsOf(s.dump()).join(',')}`,
    );
  }

  // CASE F1-9 — missing key still hydrates as a normal empty queue (regression)
  {
    const ctrl = createQueueController();
    const hy = await ctrl.hydrate(memStorage());
    const d = await ctrl.mutate(
      (cur) => ({ next: [...cur, rec({ queueId: 'q-x', entityId: 'txn-x' })], result: 0 }),
      memStorage(),
    );
    check(
      'CASE F1-9 missing key -> hydrated empty, enqueue allowed',
      hy.ok === true && ctrl.isHydrated() && d.persist.ok === true,
      `hy=${JSON.stringify(hy)} d=${JSON.stringify(d)}`,
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
