/**
 * Static verification for the Offline Write Queue coordinator's LOAN
 * wiring — STEP 16-H2-L1. A small, self-contained harness (separate from
 * coordinator.loanPayment.cases.ts) exercising `createLoan`/`updateLoan`/
 * `softDeleteLoan` dispatch, FROZEN `expectedUpdatedAt` forwarding, the
 * CREATE/UPDATE/DELETE ack reconcile against `getServerLoans()`, the
 * "authoritative server row (incl. `paid`/`payments`) is never overwritten
 * by a stale local draft" rule, transport-vs-terminal normalization (incl.
 * `principal_low`), the "one offline change per loan" LOCK (a payment also
 * counts, from the loan side), discard, and scope safety. Mirrors
 * coordinator.goal.cases.ts exactly. `addLoanPayment`/`softDeleteLoanPayment`
 * are OUT OF SCOPE here — see coordinator.loanPayment.cases.ts. No React, no
 * Supabase. ENGINE ONLY — no UI call site is exercised.
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
 * preset tooling). It IS included in the `npx tsc --noEmit` verification.
 */
import { QUEUE_SCHEMA_VERSION, type PendingLoanCreate } from '@/lib/offlineQueue';
import type { NewLoanDraft } from '@/lib/remoteLoanWriteMapping';
import type {
  CreateLoanResult,
  SoftDeleteLoanResult,
  UpdateLoanResult,
} from '@/services/remoteLoanWrite';
import {
  createPendingWriteCoordinator,
  type CoordinatorScope,
} from '@/services/offlineQueue/coordinator';
import type { QueueStorage } from '@/services/offlineQueue/persistence';
import type { Loan } from '@/store/types';

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

const ld = (over: Partial<NewLoanDraft> = {}): NewLoanDraft => ({
  name: '전세자금대출',
  lender: '국민은행',
  principal: 100000000,
  annualRate: 4.5,
  termMonths: 24,
  startDate: '2026-01-15',
  paymentDay: 15,
  repayType: 'amortizing',
  ...over,
});

const srvRow = (id: string, over: Partial<Loan> = {}): Loan => ({
  id,
  name: '전세자금대출',
  lender: '국민은행',
  principal: 100000000,
  annualRate: 4.5,
  termMonths: 24,
  startDate: '2026-01-15',
  paymentDay: 15,
  repayType: 'amortizing',
  paid: 0,
  payments: [],
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

type CreateArgs = { id: string; householdId: string; expectedUserId: string; draft: NewLoanDraft };
type UpdateArgs = CreateArgs & { expectedUpdatedAt: string };
type DeleteArgs = { id: string; householdId: string; expectedUserId: string; expectedUpdatedAt: string };

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  server: Map<string, Loan>;
  storage: ReturnType<typeof memStorage>;
  createLog: CreateArgs[];
  updateLog: UpdateArgs[];
  deleteLog: DeleteArgs[];
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setCreate: (f: (a: CreateArgs) => Promise<CreateLoanResult>) => void;
  setUpdate: (f: (a: UpdateArgs) => Promise<UpdateLoanResult>) => void;
  setDelete: (f: (a: DeleteArgs) => Promise<SoftDeleteLoanResult>) => void;
  serverPut: (row: Loan) => void;
  serverDelete: (id: string) => void;
  runTimers: () => void;
  refreshes: () => number;
}

function makeHarness(opts?: { seed?: string }): Harness {
  const server = new Map<string, Loan>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = A;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const createLog: CreateArgs[] = [];
  const updateLog: UpdateArgs[] = [];
  const deleteLog: DeleteArgs[] = [];

  // default create: server accepts + snapshot reflects it. `paid`/`payments`
  // are NEVER set by a CREATE — the DB default applies, mirroring the real
  // `createLoan()` (neither is in the insert row).
  let createImpl = async (a: CreateArgs): Promise<CreateLoanResult> => {
    createLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.set(a.id, {
      id: a.id,
      name: a.draft.name.trim(),
      lender: a.draft.lender.trim(),
      principal: a.draft.principal,
      annualRate: a.draft.annualRate,
      termMonths: a.draft.termMonths,
      startDate: a.draft.startDate,
      paymentDay: a.draft.paymentDay,
      repayType: a.draft.repayType,
      paid: 0,
      payments: [],
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    return { ok: true, id: a.id };
  };
  // default update: `paid`/`payments` are NEVER touched — mirrors the real
  // `updateLoan()` (the UPDATE grant on `loans` doesn't even include `paid`).
  let updateImpl = async (a: UpdateArgs): Promise<UpdateLoanResult> => {
    updateLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    const prev = server.get(a.id);
    if (prev) {
      server.set(a.id, {
        ...prev,
        name: a.draft.name.trim(),
        lender: a.draft.lender.trim(),
        principal: a.draft.principal,
        annualRate: a.draft.annualRate,
        termMonths: a.draft.termMonths,
        startDate: a.draft.startDate,
        paymentDay: a.draft.paymentDay,
        repayType: a.draft.repayType,
      });
    }
    return { ok: true, updatedAt: '2026-09-11T00:00:00.000Z' };
  };
  let deleteImpl = async (a: DeleteArgs): Promise<SoftDeleteLoanResult> => {
    deleteLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    server.delete(a.id);
    return { ok: true };
  };

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
    getServerGoals: () => new Map(),
    getServerLoans: () => server,
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    createLoan: (a) => createImpl(a as CreateArgs),
    updateLoan: (a) => updateImpl(a as UpdateArgs),
    softDeleteLoan: (a) => deleteImpl(a as DeleteArgs),
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
    server,
    storage,
    createLog,
    updateLog,
    deleteLog,
    timers,
    setScope: (s) => {
      scope = s;
      coord.setScope(s);
    },
    setCreate: (f) => {
      createImpl = f;
    },
    setUpdate: (f) => {
      updateImpl = f;
    },
    setDelete: (f) => {
      deleteImpl = f;
    },
    serverPut: (row) => {
      server.set(row.id, row);
    },
    serverDelete: (id) => {
      server.delete(id);
    },
    runTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    refreshes: () => refreshCount,
  };
}

const TRANSPORT_C: CreateLoanResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_U: UpdateLoanResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_D: SoftDeleteLoanResult = { ok: false, reason: 'error', message: 'net', transport: true };
const CONFLICT_C: CreateLoanResult = { ok: false, reason: 'conflict', message: '충돌' };
const INVALID_C: CreateLoanResult = { ok: false, reason: 'invalid', message: '확인해 주세요' };
const CONFLICT_U: UpdateLoanResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };
const GONE_U: UpdateLoanResult = { ok: false, reason: 'gone', message: '삭제된 항목' };
const PRINCIPAL_LOW_U: UpdateLoanResult = { ok: false, reason: 'principal_low', message: '원금을 낮출 수 없어요' };
const CONFLICT_D: SoftDeleteLoanResult = { ok: false, reason: 'conflict', message: '이미 변경됨' };

const seedWith = (recs: PendingLoanCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingLoanCreate> = {}): PendingLoanCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loan',
  op: 'create',
  entityId: 'loan-1',
  payload: ld(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorLoanCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ RUNOP ============================ */

  // 1 — CREATE dispatch: createLoan called with id === entityId, no token, `paid` defaults to 0
  {
    const h = makeHarness();
    await h.coord.hydrate();
    const enq = await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld({ principal: 30000000 }) });
    await settle(8);
    check(
      '1 CREATE dispatch -> createLoan(id=entityId, draft), lands on server with paid=0, queue empties',
      enq.ok === true &&
        h.createLog.length === 1 &&
        h.createLog[0].id === 'loan-1' &&
        h.server.get('loan-1')?.principal === 30000000 &&
        h.server.get('loan-1')?.paid === 0 &&
        h.coord.getState().loan.scopeOps.length === 0,
      JSON.stringify({ log: h.createLog, server: [...h.server] }),
    );
  }

  // 2 — UPDATE: frozen expectedUpdatedAt forwarded verbatim on EVERY replay
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { principal: 999 }));
    h.setUpdate((a) => {
      h.updateLog.push(a);
      return Promise.resolve(TRANSPORT_U); // stay "offline" across retries
    });
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 1 }),
      expectedUpdatedAt: 'FROZEN-V1',
    });
    await settle();
    h.runTimers(); // backoff retry
    await settle(6);
    check(
      '2 UPDATE: every replay uses the SAME frozen expectedUpdatedAt (never refreshed)',
      h.updateLog.length >= 2 && h.updateLog.every((u) => u.expectedUpdatedAt === 'FROZEN-V1'),
      JSON.stringify(h.updateLog.map((u) => u.expectedUpdatedAt)),
    );
  }

  // 3 — DELETE: frozen expectedUpdatedAt forwarded verbatim
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1'));
    h.setDelete((a) => {
      h.deleteLog.push(a);
      return Promise.resolve(TRANSPORT_D);
    });
    await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'FROZEN-DEL' });
    await settle();
    h.runTimers();
    await settle(6);
    check(
      '3 DELETE: every replay uses the SAME frozen expectedUpdatedAt',
      h.deleteLog.length >= 2 && h.deleteLog.every((d) => d.expectedUpdatedAt === 'FROZEN-DEL'),
      JSON.stringify(h.deleteLog.map((d) => d.expectedUpdatedAt)),
    );
  }

  // 4 — transport:true is normalized to a retryable transport halt (enqueued, not failed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    const enq = await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await settle();
    const st = h.coord.getState().loan;
    check(
      '4 transport:true -> retained pending (not failed), a backoff timer is scheduled',
      enq.ok === true &&
        st.pendingIds.has('loan-1') &&
        !st.failedIds.has('loan-1') &&
        h.timers.some((t) => !t.cancelled),
      JSON.stringify({ enq, pending: [...st.pendingIds], failed: [...st.failedIds] }),
    );
  }

  // 5 — a non-transport conflict is TERMINAL: retained failed, no auto-retry
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_C);
    });
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await settle();
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    const st = h.coord.getState().loan;
    check(
      '5 CREATE conflict -> terminal-failed, reason retained, exactly one attempt',
      st.failedIds.has('loan-1') && st.failedReasons.get('loan-1') === 'conflict' && calls === 1,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('loan-1'), calls }),
    );
  }

  // 6 — gone UPDATE is TERMINAL (reason preserved, not collapsed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1'));
    h.setUpdate(() => Promise.resolve(GONE_U));
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 5 }),
      expectedUpdatedAt: 'V0',
    });
    await settle();
    const st = h.coord.getState().loan;
    check(
      '6 UPDATE gone -> terminal-failed with reason "gone"',
      st.failedIds.has('loan-1') && st.failedReasons.get('loan-1') === 'gone',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('loan-1') }),
    );
  }

  // 7 — UPDATE principal_low -> TERMINAL, reason preserved (not flattened)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { paid: 90000000 }));
    h.setUpdate(() => Promise.resolve(PRINCIPAL_LOW_U));
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 50000000 }), // below the current paid
      expectedUpdatedAt: 'V0',
    });
    await settle();
    const st = h.coord.getState().loan;
    check(
      '7 UPDATE principal_low -> terminal-failed with reason "principal_low" (widened WriteConflictReason)',
      st.failedIds.has('loan-1') && st.failedReasons.get('loan-1') === 'principal_low',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('loan-1') }),
    );
  }

  // 8 — CREATE `invalid` -> reason-less generic terminal (mirrors card/category/planned/recurring/goal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(INVALID_C));
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await settle();
    const st = h.coord.getState().loan;
    check(
      '8 CREATE invalid -> terminal-failed with NO stored reason',
      st.failedIds.has('loan-1') && st.failedReasons.get('loan-1') === undefined,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('loan-1') }),
    );
  }

  /* ========================= CREATE ACK ========================= */

  // 9 — server absent after replay -> NOT acked, op RETAINED (never durably removed)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    let calls = 0;
    h.setCreate((a) => {
      calls += 1;
      h.createLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true, id: a.id } : TRANSPORT_C);
    });
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await settle(8);
    check(
      '9 CREATE: server row never appears in snapshot -> not acked, op still queued (not durably removed)',
      h.coord.getState().loan.scopeOps.length === 1 &&
        calls >= 1 &&
        !h.server.has('loan-1') &&
        !h.coord.getState().loan.failedIds.has('loan-1'),
      JSON.stringify({ ops: h.coord.getState().loan.scopeOps.length, calls }),
    );
  }

  // 10 — same id + same payload on server -> ack (idempotent lost-response)
  {
    const h = makeHarness({
      seed: seedWith([rec({ queueId: 'q-10', entityId: 'loan-1', payload: ld({ principal: 77000000 }) })]),
    });
    // server already holds the exact same create (response was lost)
    h.serverPut(srvRow('loan-1', { principal: 77000000 }));
    let calls = 0;
    h.setCreate((a) => {
      calls += 1;
      return Promise.resolve({ ok: true, id: a.id });
    });
    await h.coord.hydrate();
    await settle(8);
    check(
      '10 CREATE lost-response: server row matches draft -> ack removes it durably',
      h.coord.getState().loan.scopeOps.length === 0 && h.server.get('loan-1')?.principal === 77000000,
      JSON.stringify({ ops: h.coord.getState().loan.scopeOps, calls }),
    );
  }

  // 11 — same id + DIFFERENT server payload -> NOT acked; a service conflict is retained terminal
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { principal: 20000000 })); // someone else's row on the same id
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_C); // real service: 23505 reconcile says "different create"
    });
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld({ principal: 10000000 }) });
    await settle();
    h.coord.requestFlush();
    await settle();
    const st = h.coord.getState().loan;
    check(
      '11 CREATE same id / different payload -> terminal conflict retained, server row untouched, no auto-retry',
      st.failedIds.has('loan-1') &&
        st.failedReasons.get('loan-1') === 'conflict' &&
        h.server.get('loan-1')?.principal === 20000000 &&
        calls === 1,
      JSON.stringify({ failed: [...st.failedIds], server: h.server.get('loan-1')?.principal, calls }),
    );
  }

  /* ========================= UPDATE ACK ========================= */

  // 12 — matching server draft after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { principal: 10000000 }));
    const enq = await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 25000000 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '12 UPDATE online -> applied, content-matched, queue empty, refresh requested',
      enq.ok === true &&
        h.updateLog.length === 1 &&
        h.server.get('loan-1')?.principal === 25000000 &&
        h.refreshes() >= 1 &&
        h.coord.getState().loan.scopeOps.length === 0,
      JSON.stringify({ server: h.server.get('loan-1')?.principal, refreshes: h.refreshes() }),
    );
  }

  // 13 — server shows a DIFFERENT draft than attempted -> NOT acked (content mismatch)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { principal: 10000000 }));
    let calls = 0;
    h.setUpdate((a) => {
      calls += 1;
      h.updateLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true, updatedAt: 'V2' } : TRANSPORT_U);
    });
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 25000000 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '13 UPDATE: snapshot content != attempted draft -> not acked, op still queued, server never overwritten to 25000000',
      h.coord.getState().loan.scopeOps.length === 1 &&
        calls >= 1 &&
        h.server.get('loan-1')?.principal === 10000000,
      JSON.stringify({
        ops: h.coord.getState().loan.scopeOps.length,
        calls,
        server: h.server.get('loan-1')?.principal,
      }),
    );
  }

  // 14 — stale concurrent server edit is NEVER overwritten (service conflict, one attempt)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { principal: 15000000 })); // device B already won
    let calls = 0;
    h.setUpdate(() => {
      calls += 1;
      return Promise.resolve(CONFLICT_U); // frozen token no longer matches
    });
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 12000000 }), // A's stale draft
      expectedUpdatedAt: 'STALE-V0',
    });
    await settle(8);
    const st = h.coord.getState().loan;
    check(
      '14 UPDATE stale token -> server stays 15000000, one attempt, retained failed (no blind LWW)',
      h.server.get('loan-1')?.principal === 15000000 &&
        calls === 1 &&
        st.failedIds.has('loan-1') &&
        st.failedReasons.get('loan-1') === 'conflict' &&
        (h.storage.dump() ?? '').includes('loan-1'),
      JSON.stringify({ server: h.server.get('loan-1')?.principal, calls, failed: [...st.failedIds] }),
    );
  }

  /* ========================= DELETE ACK ========================= */

  // 15 — active server row still present after replay -> NOT acked; op retained
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1'));
    let calls = 0;
    h.setDelete((a) => {
      calls += 1;
      h.deleteLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true } : TRANSPORT_D);
    });
    await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      '15 DELETE: active server row still present -> not acked, op still queued',
      h.coord.getState().loan.scopeOps.length === 1 && calls >= 1 && h.server.has('loan-1'),
      JSON.stringify({ ops: h.coord.getState().loan.scopeOps.length, calls }),
    );
  }

  // 16 — server row absent after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1'));
    const enq = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    await settle(8);
    check(
      '16 DELETE online -> server row gone, queue empty, refresh requested',
      enq.ok === true &&
        !h.server.has('loan-1') &&
        h.refreshes() >= 1 &&
        h.coord.getState().loan.scopeOps.length === 0,
      JSON.stringify({ hasRow: h.server.has('loan-1'), ops: h.coord.getState().loan.scopeOps.length }),
    );
  }

  // 17 — failed DELETE -> retained + failed; authoritative row NEVER removed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.serverPut(srvRow('loan-1', { principal: 10000000 }));
    h.setDelete(() => Promise.resolve(CONFLICT_D));
    await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    await settle();
    const st = h.coord.getState().loan;
    check(
      '17 failed DELETE -> retained + failedIds, authoritative server row still present',
      st.failedIds.has('loan-1') && h.server.get('loan-1')?.principal === 10000000 && st.scopeOps.length === 1,
      JSON.stringify({ failed: [...st.failedIds], server: h.server.get('loan-1')?.principal }),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 18 — scope isolation: household B never sees household A's loan op
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState().loan;
    h.setScope(A);
    const underA = h.coord.getState().loan;
    check(
      '18 scope isolation: loan op hidden under B, visible again under A',
      underB.scopeOps.length === 0 && underA.pendingIds.has('loan-1'),
      `B=${underB.scopeOps.length} A=${[...underA.pendingIds]}`,
    );
  }

  // 19 — enqueue persist failure -> {ok:false, persist}, item NOT visible
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    h.storage.failSet(1);
    const enq = await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await settle();
    check(
      '19 enqueue persist failure -> {ok:false, persist}, not visible',
      enq.ok === false && enq.reason === 'persist' && h.coord.getState().loan.scopeOps.length === 0,
      JSON.stringify(enq),
    );
  }

  // 20 — restart/hydrate: a seeded loan CREATE is restored, no duplicate
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld({ principal: 55555000 }) });
    await settle();
    h.coord.dispose();
    const stored = h.storage.dump();

    const h2 = makeHarness({ seed: stored ?? undefined });
    h2.setCreate(() => Promise.resolve(TRANSPORT_C)); // still offline
    await h2.coord.hydrate();
    await settle();
    check(
      '20 restart -> pending loan row restored from storage, exactly one',
      h2.coord.getState().loan.pendingIds.has('loan-1') && h2.coord.getState().loan.scopeOps.length === 1,
      JSON.stringify([...h2.coord.getState().loan.pendingIds]),
    );
  }

  // 21 — discardPending: exact queueId removal, scope isolation, other entity untouched
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() => Promise.resolve(CONFLICT_U));
    h.serverPut(srvRow('loan-1', { principal: 99999900 }));
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 1 }),
      expectedUpdatedAt: 'V1',
    });
    await settle();
    const recQ = h.coord.getState().loan.scopeOps.find((o) => o.entityId === 'loan-1');
    // scope isolation: cannot discard A's record while B is active
    h.setScope(B);
    const outB = await h.coord.discardPending(recQ!.queueId);
    h.setScope(A);
    const outA = await h.coord.discardPending(recQ!.queueId);
    check(
      '21 discard: refused under wrong scope, exact queueId removed under right scope, server untouched',
      outB.ok === false &&
        outB.reason === 'scope' &&
        outA.ok === true &&
        h.coord.getState().loan.scopeOps.length === 0 &&
        !h.coord.getState().loan.failedIds.has('loan-1') &&
        h.server.get('loan-1')?.principal === 99999900,
      JSON.stringify({ outB, outA, server: h.server.get('loan-1')?.principal }),
    );
  }

  // 22 — a budget op in the same queue is unaffected by loan dispatch
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueLoanCreate({ scope: A, entityId: 'loan-1', payload: ld() });
    await h.coord.enqueueBudgetCreate({ scope: A, entityId: 'food', payload: { category: 'food', amount: 100 } });
    await settle();
    const st = h.coord.getState();
    check(
      '22 loan + budget in one queue -> both tracked independently, keyed separately',
      st.loan.pendingIds.has('loan-1') && st.budget.scopeOps.some((o) => o.entityId === 'food'),
      JSON.stringify({ loan: [...st.loan.pendingIds], budget: st.budget.scopeOps.map((o) => o.entityId) }),
    );
  }

  /* ======================== DELETE LOCK ======================== */

  // 23 — DELETE refused while an UPDATE is already pending for the SAME loan
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() => Promise.resolve(TRANSPORT_U));
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 1 }),
      expectedUpdatedAt: 'V1',
    });
    const enq = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    check(
      '23 DELETE refused (existing-pending) while an UPDATE is queued for the same loan',
      enq.ok === false && enq.reason === 'existing-pending' && h.coord.getState().loan.scopeOps.length === 1,
      JSON.stringify(enq),
    );
  }

  // 24 — DELETE refused while a PAYMENT is already pending for the SAME loan
  {
    const h = makeHarness();
    await h.coord.hydrate();
    const enqPay = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: { date: '2026-09-15', amount: 100000 },
    });
    const enqDel = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    check(
      '24 DELETE refused (existing-pending) while a PAYMENT targets the same loan',
      enqPay.ok === true && enqDel.ok === false && enqDel.reason === 'existing-pending',
      JSON.stringify({ enqPay, enqDel }),
    );
  }

  // 25 — a genuine retry of the SAME delete (same entityId) is NOT caught by
  // its own lock — idempotent dedup / existing-pending-on-differing-token
  // still applies normally.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setDelete(() => Promise.resolve(TRANSPORT_D));
    const enq1 = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    const enq2 = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' }); // same token -> idempotent
    const enq3 = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V2' }); // different token -> existing-pending
    check(
      '25 delete retry (same token) is NOT blocked by its own lock; a differing token still refuses normally',
      enq1.ok === true &&
        enq2.ok === true &&
        enq3.ok === false &&
        enq3.reason === 'existing-pending' &&
        h.coord.getState().loan.scopeOps.length === 1,
      JSON.stringify({ enq1, enq2, enq3 }),
    );
  }

  // 26 — DELETE for a DIFFERENT loan is unaffected by another loan's lock
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() => Promise.resolve(TRANSPORT_U));
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 1 }),
      expectedUpdatedAt: 'V1',
    });
    const enq = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-2', expectedUpdatedAt: 'V1' });
    check(
      "26 DELETE for a different loan is NOT blocked by loan-1's update lock",
      enq.ok === true,
      JSON.stringify(enq),
    );
  }

  // 27 — REGRESSION-STYLE (mirrors the actual STEP 16-H2-G4 goal bug, applied
  // preemptively to loan from the start): a TERMINAL-FAILED update for the
  // SAME loan (retained forever — no discard UI on a loan screen yet) must
  // NEVER permanently block a later delete. Only an ACTIVELY pending op (no
  // `lastError` yet) may lock the row.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() => Promise.resolve(CONFLICT_U)); // terminal, not transport
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 1 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(); // let the update actually terminal-fail (lastError persisted)
    const preState = h.coord.getState().loan;
    const enq = await h.coord.enqueueLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'V1' });
    check(
      '27 DELETE is NOT refused by a terminal-failed (not merely pending) update on the SAME loan',
      preState.failedIds.has('loan-1') && // sanity: the update really did terminal-fail first
        enq.ok === true &&
        h.coord.getState().loan.scopeOps.some((o) => o.op === 'delete' && o.entityId === 'loan-1'),
      JSON.stringify({ preFailed: [...preState.failedIds], enq }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
