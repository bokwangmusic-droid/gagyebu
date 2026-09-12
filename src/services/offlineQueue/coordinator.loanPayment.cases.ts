/**
 * Static verification for the Offline Write Queue coordinator's LOAN-PAYMENT
 * (repayment create/delete) wiring — STEP 16-H2-L1. A small, self-contained
 * harness (separate from coordinator.loan.cases.ts) exercising
 * `addLoanPayment`/`softDeleteLoanPayment` dispatch, the STABLE `paymentId`
 * forwarded verbatim on every CREATE replay, the FROZEN `expectedUpdatedAt`
 * forwarded verbatim on every DELETE replay, the ID-PRESENCE ack reconcile
 * against `getServerLoans()` (a real per-payment lookup — UNLIKE goal
 * movement's baseline+delta approximation, because `loan_payments` rows ARE
 * individually fetched), the "one offline change per loan" LOCK
 * (`enqueueLoanPaymentCreate`/`enqueueLoanPaymentDelete` refusing a second
 * payment op — or a loan create/update/delete — for the same loanId),
 * transport-vs-terminal normalization (incl. `paid_off`/`stale`), discard,
 * and scope safety. Mirrors coordinator.goalMovement.cases.ts structurally.
 * No React, no Supabase. ENGINE ONLY — no UI call site is exercised.
 *
 * NOTE: like every other `coordinator.*.cases.ts` file, this cannot be
 * executed directly under plain Node/tsx in this environment — importing
 * the real coordinator pulls in `@/lib/supabase` -> `react-native`, whose
 * Flow syntax the available tooling (esbuild/tsx, and a sucrase-based
 * reconstruction) cannot parse on this Node version. This is a pre-existing,
 * already-diagnosed environment limitation affecting every coordinator-level
 * test file, not something specific to this one. It is still written in
 * full, mirroring `coordinator.goalMovement.cases.ts` exactly, so it is
 * correct and ready to run once that limitation is resolved (or under
 * Metro/Jest+RN preset tooling). It IS included in the `npx tsc --noEmit`
 * verification.
 */
import { QUEUE_SCHEMA_VERSION, type PendingLoanPaymentCreate } from '@/lib/offlineQueue';
import type { NewLoanDraft, NewLoanPaymentDraft } from '@/lib/remoteLoanWriteMapping';
import type {
  AddLoanPaymentResult,
  SoftDeleteLoanPaymentResult,
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

const pd = (over: Partial<NewLoanPaymentDraft> = {}): NewLoanPaymentDraft => ({
  date: '2026-09-15',
  amount: 1000000,
  ...over,
});
const ld = (over: Partial<NewLoanDraft> = {}): NewLoanDraft => ({
  name: '전세자금대출',
  lender: '국민은행',
  principal: 100000000,
  annualRate: 0,
  termMonths: 24,
  startDate: '2026-01-15',
  paymentDay: 15,
  repayType: 'amortizing',
  ...over,
});

const srvLoan = (id: string, over: Partial<Loan> = {}): Loan => ({
  id,
  name: '전세자금대출',
  lender: '국민은행',
  principal: 100000000,
  annualRate: 0, // 0 keeps principalPart === amount, so ack math stays obvious
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

type CreateArgs = {
  paymentId: string;
  householdId: string;
  loanId: string;
  expectedUserId: string;
  draft: NewLoanPaymentDraft;
};
type DeleteArgs = { paymentId: string; householdId: string; expectedUserId: string; expectedUpdatedAt: string };
type UpdateArgs = {
  id: string;
  householdId: string;
  expectedUserId: string;
  expectedUpdatedAt: string;
  draft: NewLoanDraft;
};

interface Harness {
  coord: ReturnType<typeof createPendingWriteCoordinator>;
  loans: Map<string, Loan>;
  storage: ReturnType<typeof memStorage>;
  createLog: CreateArgs[];
  deleteLog: DeleteArgs[];
  timers: { id: number; fn: () => void; ms: number; cancelled: boolean }[];
  setScope: (s: CoordinatorScope | null) => void;
  setCreate: (f: (a: CreateArgs) => Promise<AddLoanPaymentResult>) => void;
  setDelete: (f: (a: DeleteArgs) => Promise<SoftDeleteLoanPaymentResult>) => void;
  setUpdate: (f: (a: UpdateArgs) => Promise<UpdateLoanResult>) => void;
  loanPut: (row: Loan) => void;
  loanDelete: (id: string) => void;
  runTimers: () => void;
  refreshes: () => number;
}

function makeHarness(opts?: { seed?: string }): Harness {
  const loans = new Map<string, Loan>();
  const storage = memStorage(opts?.seed);
  let scope: CoordinatorScope | null = A;
  let refreshCount = 0;
  const timers: Harness['timers'] = [];
  let timerSeq = 0;
  const createLog: CreateArgs[] = [];
  const deleteLog: DeleteArgs[] = [];

  // default: server accepts, appends the payment row to `loan.payments` and
  // bumps `paid` by its principalPart (mirrors trg_apply_loan_payment — the
  // client never computes this itself in the real service; this stub
  // reproduces the OBSERVABLE effect the coordinator's ID-presence ack
  // check relies on). `annualRate: 0` on every test loan keeps
  // principalPart === amount, so the stub needn't reimplement splitPayment.
  let createImpl = async (a: CreateArgs): Promise<AddLoanPaymentResult> => {
    createLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    const prev = loans.get(a.loanId);
    if (prev) {
      const principalPart = a.draft.amount;
      loans.set(a.loanId, {
        ...prev,
        paid: prev.paid + principalPart,
        payments: [
          ...prev.payments,
          { id: a.paymentId, date: a.draft.date, amount: a.draft.amount, principalPart, interestPart: 0 },
        ],
      });
    }
    return { ok: true };
  };
  // default: soft-deletes the payment row and reverses `paid` by its OWN
  // stored principalPart (mirrors the DB trigger reversing on delete).
  let deleteImpl = async (a: DeleteArgs): Promise<SoftDeleteLoanPaymentResult> => {
    deleteLog.push(a);
    await new Promise<void>((r) => setTimeout(r, 0));
    for (const [loanId, loan] of loans) {
      const target = loan.payments.find((p) => p.id === a.paymentId);
      if (target) {
        loans.set(loanId, {
          ...loan,
          paid: Math.max(0, loan.paid - target.principalPart),
          payments: loan.payments.filter((p) => p.id !== a.paymentId),
        });
        break;
      }
    }
    return { ok: true };
  };
  // default: unused unless a test opts in via setUpdate (mirrors goalMovement's
  // symmetric-lock regression case 27 on the loan side).
  let updateImpl = async (_a: UpdateArgs): Promise<UpdateLoanResult> => ({
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
    getServerGoals: () => new Map(),
    getServerLoans: () => loans,
    requestRefresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    onChange: () => {},
    addLoanPayment: (a) => createImpl(a as CreateArgs),
    softDeleteLoanPayment: (a) => deleteImpl(a as DeleteArgs),
    updateLoan: (a) => updateImpl(a as UpdateArgs),
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
    loans,
    storage,
    createLog,
    deleteLog,
    timers,
    setScope: (s) => {
      scope = s;
      coord.setScope(s);
    },
    setCreate: (f) => {
      createImpl = f;
    },
    setDelete: (f) => {
      deleteImpl = f;
    },
    setUpdate: (f) => {
      updateImpl = f;
    },
    loanPut: (row) => {
      loans.set(row.id, row);
    },
    loanDelete: (id) => {
      loans.delete(id);
    },
    runTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    refreshes: () => refreshCount,
  };
}

const TRANSPORT_C: AddLoanPaymentResult = { ok: false, reason: 'error', message: 'net', transport: true };
const TRANSPORT_D: SoftDeleteLoanPaymentResult = { ok: false, reason: 'error', message: 'net', transport: true };
const CONFLICT_C: AddLoanPaymentResult = { ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' };
const GONE_C: AddLoanPaymentResult = { ok: false, reason: 'gone', message: '삭제된 대출' };
const PAID_OFF_C: AddLoanPaymentResult = { ok: false, reason: 'paid_off', message: '이미 모두 상환' };
const STALE_C: AddLoanPaymentResult = { ok: false, reason: 'stale', message: '잔액이 바뀌었어요' };
const CONFLICT_D: SoftDeleteLoanPaymentResult = { ok: false, reason: 'conflict', message: '다른 곳에서 이미 변경됨' };

const seedWith = (recs: PendingLoanPaymentCreate[]) => JSON.stringify(recs);
const rec = (over: Partial<PendingLoanPaymentCreate> = {}): PendingLoanPaymentCreate => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loanPayment',
  op: 'create',
  entityId: 'lp-1',
  loanId: 'loan-1',
  payload: pd(),
  enqueuedAt: '2026-09-10T09:00:00.000Z',
  attemptCount: 0,
  ...over,
});

export async function runCoordinatorLoanPaymentCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  /* ============================ RUNOP ============================ */

  // 1 — dispatch: addLoanPayment called with paymentId === entityId, loanId forwarded
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(srvLoan('loan-1', { paid: 0 }));
    const enq = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 1000000 }),
    });
    await settle(8);
    check(
      '1 dispatch -> addLoanPayment(paymentId=entityId, loanId), lands on server, queue empties',
      enq.ok === true &&
        h.createLog.length === 1 &&
        h.createLog[0].paymentId === 'lp-1' &&
        h.createLog[0].loanId === 'loan-1' &&
        h.loans.get('loan-1')?.paid === 1000000 &&
        h.coord.getState().loanPayment.scopeOps.length === 0,
      JSON.stringify({ log: h.createLog, loan: h.loans.get('loan-1') }),
    );
  }

  // 2 — paymentId is STABLE across every CREATE replay (never regenerated)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(srvLoan('loan-1', { paid: 0 }));
    h.setCreate((a) => {
      h.createLog.push(a);
      return Promise.resolve(TRANSPORT_C); // stay "offline" across retries
    });
    await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 1000000 }),
    });
    await settle();
    h.runTimers(); // backoff retry
    await settle(6);
    check(
      '2 every CREATE replay uses the SAME paymentId (never regenerated)',
      h.createLog.length >= 2 && h.createLog.every((c) => c.paymentId === 'lp-1'),
      JSON.stringify(h.createLog.map((c) => c.paymentId)),
    );
  }

  // 3 — DELETE: frozen expectedUpdatedAt forwarded verbatim on every replay
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(
      srvLoan('loan-1', {
        paid: 1000000,
        payments: [{ id: 'lp-1', date: '2026-09-15', amount: 1000000, principalPart: 1000000, interestPart: 0 }],
      }),
    );
    h.setDelete((a) => {
      h.deleteLog.push(a);
      return Promise.resolve(TRANSPORT_D);
    });
    await h.coord.enqueueLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'FROZEN-DEL',
    });
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
    const enq = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd(),
    });
    await settle();
    const st = h.coord.getState().loanPayment;
    check(
      '4 transport:true -> retained pending (not failed), a backoff timer is scheduled',
      enq.ok === true &&
        st.pendingIds.has('lp-1') &&
        !st.failedIds.has('lp-1') &&
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
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    await settle();
    h.coord.requestFlush(); // non-includeFailed must NOT re-run it
    await settle();
    const st = h.coord.getState().loanPayment;
    check(
      '5 conflict -> terminal-failed, reason retained, exactly one attempt',
      st.failedIds.has('lp-1') && st.failedReasons.get('lp-1') === 'conflict' && calls === 1,
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('lp-1'), calls }),
    );
  }

  // 6 — gone (loan deleted) is TERMINAL with reason preserved
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(GONE_C));
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    await settle();
    const st = h.coord.getState().loanPayment;
    check(
      '6 gone -> terminal-failed with reason "gone"',
      st.failedIds.has('lp-1') && st.failedReasons.get('lp-1') === 'gone',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('lp-1') }),
    );
  }

  // 7 — paid_off -> TERMINAL, reason preserved (widened WriteConflictReason, never flattened)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(PAID_OFF_C));
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    await settle();
    const st = h.coord.getState().loanPayment;
    check(
      '7 paid_off -> terminal-failed with reason "paid_off"',
      st.failedIds.has('lp-1') && st.failedReasons.get('lp-1') === 'paid_off',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('lp-1') }),
    );
  }

  // 8 — stale (23514 concurrent paid bump) -> TERMINAL, reason preserved
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(STALE_C));
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    await settle();
    const st = h.coord.getState().loanPayment;
    check(
      '8 stale -> terminal-failed with reason "stale"',
      st.failedIds.has('lp-1') && st.failedReasons.get('lp-1') === 'stale',
      JSON.stringify({ failed: [...st.failedIds], reason: st.failedReasons.get('lp-1') }),
    );
  }

  /* ========================= CREATE ACK (ID-presence) ========================= */

  // 9 — server loan's `payments` contains the paymentId after replay -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(srvLoan('loan-1', { paid: 0 }));
    const enq = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 1000000 }),
    });
    await settle(8);
    check(
      '9 ack online -> applied, payment id present on the loan, queue empty, refresh requested',
      enq.ok === true &&
        !!h.loans.get('loan-1')?.payments.some((p) => p.id === 'lp-1') &&
        h.refreshes() >= 1 &&
        h.coord.getState().loanPayment.scopeOps.length === 0,
      JSON.stringify({ payments: h.loans.get('loan-1')?.payments, refreshes: h.refreshes() }),
    );
  }

  // 10 — FALSE NEGATIVE: paymentId absent after "success" (lost response /
  // stale snapshot) -> NOT acked, op RETAINED — never durably removed. The op
  // stays queued and simply replays.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(srvLoan('loan-1', { paid: 0 }));
    let calls = 0;
    h.setCreate((a) => {
      calls += 1;
      h.createLog.push(a);
      if (calls === 1) {
        // "succeeds" but the snapshot the coordinator observes on refresh
        // does not yet show the new payment row.
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(TRANSPORT_C);
    });
    await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 1000000 }),
    });
    await settle(8);
    check(
      '10 payment id absent from snapshot -> not acked, op still queued (never durably removed)',
      h.coord.getState().loanPayment.scopeOps.length === 1 &&
        calls >= 1 &&
        !h.loans.get('loan-1')?.payments.some((p) => p.id === 'lp-1') &&
        !h.coord.getState().loanPayment.failedIds.has('lp-1'),
      JSON.stringify({ ops: h.coord.getState().loanPayment.scopeOps.length, calls }),
    );
  }

  // 11 — same id + server already reflects it (lost-response idempotent
  // retry) -> ack removes it durably on restart/hydrate too
  {
    const h = makeHarness({
      seed: seedWith([rec({ queueId: 'q-11', entityId: 'lp-1', loanId: 'loan-1' })]),
    });
    h.loanPut(
      srvLoan('loan-1', {
        paid: 1000000, // our earlier payment already landed
        payments: [{ id: 'lp-1', date: '2026-09-15', amount: 1000000, principalPart: 1000000, interestPart: 0 }],
      }),
    );
    let calls = 0;
    h.setCreate(() => {
      calls += 1;
      return Promise.resolve({ ok: true }); // real service: 23505 reconcile confirms idempotent
    });
    await h.coord.hydrate();
    await settle(8);
    check(
      '11 restart + server already reflects the payment -> ack removes it durably',
      h.coord.getState().loanPayment.scopeOps.length === 0 &&
        !!h.loans.get('loan-1')?.payments.some((p) => p.id === 'lp-1'),
      JSON.stringify({ ops: h.coord.getState().loanPayment.scopeOps, calls }),
    );
  }

  /* ========================= DELETE ACK (ID-presence) ========================= */

  // 12 — server loan's `payments` still contains the paymentId after replay -> NOT acked
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(
      srvLoan('loan-1', {
        paid: 1000000,
        payments: [{ id: 'lp-1', date: '2026-09-15', amount: 1000000, principalPart: 1000000, interestPart: 0 }],
      }),
    );
    let calls = 0;
    h.setDelete((a) => {
      calls += 1;
      h.deleteLog.push(a);
      return Promise.resolve(calls === 1 ? { ok: true } : TRANSPORT_D);
    });
    await h.coord.enqueueLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '12 DELETE: payment id still present -> not acked, op still queued',
      h.coord.getState().loanPayment.scopeOps.length === 1 &&
        calls >= 1 &&
        !!h.loans.get('loan-1')?.payments.some((p) => p.id === 'lp-1'),
      JSON.stringify({ ops: h.coord.getState().loanPayment.scopeOps.length, calls }),
    );
  }

  // 13 — server loan's `payments` no longer contains the paymentId -> ack (durable removal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(
      srvLoan('loan-1', {
        paid: 1000000,
        payments: [{ id: 'lp-1', date: '2026-09-15', amount: 1000000, principalPart: 1000000, interestPart: 0 }],
      }),
    );
    const enq = await h.coord.enqueueLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '13 DELETE online -> payment id gone, paid reversed, queue empty, refresh requested',
      enq.ok === true &&
        !h.loans.get('loan-1')?.payments.some((p) => p.id === 'lp-1') &&
        h.loans.get('loan-1')?.paid === 0 &&
        h.refreshes() >= 1 &&
        h.coord.getState().loanPayment.scopeOps.length === 0,
      JSON.stringify({ payments: h.loans.get('loan-1')?.payments, paid: h.loans.get('loan-1')?.paid }),
    );
  }

  // 14 — the parent loan itself is gone from the snapshot -> DELETE ack
  // CANNOT be confirmed this way either; op stays queued and replays (whose
  // own reconcile inside softDeleteLoanPayment classifies it terminal)
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(
      srvLoan('loan-1', {
        paid: 1000000,
        payments: [{ id: 'lp-1', date: '2026-09-15', amount: 1000000, principalPart: 1000000, interestPart: 0 }],
      }),
    );
    let calls = 0;
    h.setDelete((a) => {
      calls += 1;
      h.deleteLog.push(a);
      if (calls === 1) {
        h.loanDelete('loan-1'); // the parent loan vanished from the snapshot
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(TRANSPORT_D);
    });
    await h.coord.enqueueLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'V1',
    });
    await settle(8);
    check(
      '14 parent loan absent from snapshot -> DELETE not acked either way, op still queued (never silently dropped)',
      h.coord.getState().loanPayment.scopeOps.length === 1 && calls >= 1,
      JSON.stringify({ ops: h.coord.getState().loanPayment.scopeOps.length, calls }),
    );
  }

  // 15 — failed DELETE -> retained + failed; authoritative payment NEVER removed
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.loanPut(
      srvLoan('loan-1', {
        paid: 1000000,
        payments: [{ id: 'lp-1', date: '2026-09-15', amount: 1000000, principalPart: 1000000, interestPart: 0 }],
      }),
    );
    h.setDelete(() => Promise.resolve(CONFLICT_D));
    await h.coord.enqueueLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'V1',
    });
    await settle();
    const st = h.coord.getState().loanPayment;
    check(
      '15 failed DELETE -> retained + failedIds, authoritative payment still present',
      st.failedIds.has('lp-1') &&
        !!h.loans.get('loan-1')?.payments.some((p) => p.id === 'lp-1') &&
        st.scopeOps.length === 1,
      JSON.stringify({ failed: [...st.failedIds], payments: h.loans.get('loan-1')?.payments }),
    );
  }

  /* ======================== LOCK (one change per loan) ======================== */

  // 16 — a SECOND payment op for the SAME loan while one is pending -> refused existing-pending
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    const enq1 = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 10000 }),
    });
    const enq2 = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-2', // a DIFFERENT payment id, same loan
      loanId: 'loan-1',
      payload: pd({ amount: 20000 }),
    });
    await settle();
    check(
      '16 second payment for the SAME loan -> refused existing-pending, only the first is queued',
      enq1.ok === true &&
        enq2.ok === false &&
        enq2.reason === 'existing-pending' &&
        h.coord.getState().loanPayment.scopeOps.length === 1,
      JSON.stringify({ enq1, enq2 }),
    );
  }

  // 17 — a payment while a loan UPDATE is already pending for the same loan -> refused
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 60000000 }),
      expectedUpdatedAt: 'V1',
    });
    const enq = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd(),
    });
    check(
      '17 payment refused while a loan UPDATE is pending for the same loan',
      enq.ok === false && enq.reason === 'existing-pending',
      JSON.stringify(enq),
    );
  }

  // 18 — a DELETE payment op is refused under the SAME lock as a create
  {
    const h = makeHarness();
    await h.coord.hydrate();
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 60000000 }),
      expectedUpdatedAt: 'V1',
    });
    const enq = await h.coord.enqueueLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'V1',
    });
    check(
      '18 payment DELETE refused while a loan UPDATE is pending for the same loan',
      enq.ok === false && enq.reason === 'existing-pending',
      JSON.stringify(enq),
    );
  }

  // 19 — a payment for a DIFFERENT loan is unaffected by another loan's lock
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    const enq2 = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-2',
      loanId: 'loan-2', // a DIFFERENT loan
      payload: pd(),
    });
    check(
      "19 payment for a different loan is NOT blocked by loan-1's lock",
      enq2.ok === true,
      JSON.stringify(enq2),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 20 — scope isolation: household B never sees household A's payment op
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(TRANSPORT_C));
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    await settle();
    h.setScope(B);
    const underB = h.coord.getState().loanPayment;
    h.setScope(A);
    const underA = h.coord.getState().loanPayment;
    check(
      '20 scope isolation: payment op hidden under B, visible again under A',
      underB.scopeOps.length === 0 && underA.pendingIds.has('lp-1'),
      `B=${underB.scopeOps.length} A=${[...underA.pendingIds]}`,
    );
  }

  // 21 — discardPending: exact queueId removal, scope isolation, loan lock released
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setCreate(() => Promise.resolve(CONFLICT_C));
    await h.coord.enqueueLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd() });
    await settle();
    const recQ = h.coord.getState().loanPayment.scopeOps.find((o) => o.entityId === 'lp-1');
    h.setScope(B);
    const outB = await h.coord.discardPending(recQ!.queueId);
    h.setScope(A);
    const outA = await h.coord.discardPending(recQ!.queueId);
    // the lock is released -> a fresh payment for the same loan can be queued
    const enqAfter = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-2',
      loanId: 'loan-1',
      payload: pd(),
    });
    check(
      '21 discard: refused under wrong scope, removed under right scope, lock released for the same loan',
      outB.ok === false &&
        outB.reason === 'scope' &&
        outA.ok === true &&
        !h.coord.getState().loanPayment.failedIds.has('lp-1') &&
        enqAfter.ok === true,
      JSON.stringify({ outB, outA, enqAfter }),
    );
  }

  // 22 — REGRESSION-STYLE (mirrors the STEP 16-H2-G4 goal bug, symmetric side,
  // applied preemptively to loan from the start): a TERMINAL-FAILED update
  // for the SAME loan (retained forever — no discard UI on a loan screen
  // yet) must NEVER permanently block a later payment. Only an ACTIVELY
  // pending op (no `lastError` yet) may lock the row.
  {
    const h = makeHarness();
    await h.coord.hydrate();
    h.setUpdate(() =>
      Promise.resolve({ ok: false, reason: 'conflict', message: '다른 곳에서 변경됨' } as UpdateLoanResult),
    );
    await h.coord.enqueueLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 1 }),
      expectedUpdatedAt: 'V1',
    });
    await settle(); // let the update actually terminal-fail (lastError persisted)
    const preState = h.coord.getState().loan;
    const enq = await h.coord.enqueueLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd(),
    });
    check(
      '22 payment is NOT refused by a terminal-failed (not merely pending) update on the SAME loan',
      preState.failedIds.has('loan-1') && // sanity: the update really did terminal-fail first
        enq.ok === true,
      JSON.stringify({ preFailed: [...preState.failedIds], enq }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
