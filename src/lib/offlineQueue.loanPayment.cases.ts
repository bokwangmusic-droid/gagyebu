/**
 * Static verification for STEP 16-H2-L1 — loan repayment create/delete
 * (`entity:'loanPayment'`) added to the pure Offline Write Queue core:
 * record shape, the union-aware validator (incl. the explicit "no update"
 * guard — a payment is ALWAYS create or delete, never update), the dedup /
 * existing-pending policy at the RECORD level (the "one change per loan"
 * LOCK itself lives in the coordinator's `enqueueLoanPaymentCreate` /
 * `enqueueLoanDelete` — see coordinator.loanPayment.cases.ts, not exercised
 * here), and the DISPLAY-ONLY repayment overlay inside
 * `composeLoanManagement` (NEVER merged into `data.loans` / `data.loanMeta`
 * / `data.loanPaymentMeta`).
 *
 * UNLIKE a goal movement (whose ack/overlay is a baseline+delta
 * approximation on the goal's aggregate `saved`, because individual
 * `goal_movements` rows are never fetched), a loan payment's overlay
 * operates on REAL `Loan.payments` rows — `loan_payments` ARE individually
 * fetched into the finance snapshot (see src/services/remoteFinance.ts) —
 * so a DELETE overlay can look up the actual target payment by id and
 * reverse its EXACT `principalPart`, and the eventual ack (coordinator) is a
 * plain ID-presence check, never an approximation.
 *
 * Mirrors src/lib/offlineQueue.goalMovement.cases.ts structurally, and
 * src/lib/offlineQueue.loan.cases.ts for the loan-domain helpers. ENGINE
 * ONLY — no UI wiring is exercised here. RunOp dispatch + the ack reconcile
 * (ID-presence against `getServerLoans()`) live in
 * coordinator.loanPayment.cases.ts.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import { splitPayment } from '@/lib/loan';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewLoanDraft, NewLoanPaymentDraft } from '@/lib/remoteLoanWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingLoanCreate,
  makePendingLoanDelete,
  makePendingLoanPaymentCreate,
  makePendingLoanPaymentDelete,
  makePendingLoanUpdate,
  opsForScope,
  sanitizePendingWrites,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { Loan } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { userId: 'u-A', householdId: 'h-A' };
const B = { userId: 'u-B', householdId: 'h-B' };
const T0 = '2026-09-10T09:00:00.000Z';

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
const pd = (over: Partial<NewLoanPaymentDraft> = {}): NewLoanPaymentDraft => ({
  date: '2026-09-15',
  amount: 1000000,
  ...over,
});

const lpCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-lpc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loanPayment',
  op: 'create',
  entityId: 'lp-1',
  loanId: 'loan-1',
  payload: pd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const lpDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-lpd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loanPayment',
  op: 'delete',
  entityId: 'lp-1',
  loanId: 'loan-1',
  expectedUpdatedAt: '2026-09-10T09:00:00.000+00:00',
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverLoan = (id: string, over: Partial<Loan> = {}): Loan => ({
  id,
  name: '전세자금대출',
  lender: '국민은행',
  principal: 100000000,
  annualRate: 0, // 0 by default so principalPart === amount, keeping arithmetic obvious
  termMonths: 24,
  startDate: '2026-01-15',
  paymentDay: 15,
  repayType: 'amortizing',
  paid: 0,
  payments: [],
  createdAt: T0,
  ...over,
});

function financeWith(
  loans: Loan[],
  loanMeta: Record<string, { updatedAt: string; createdBy: string | null }> = {},
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
    goals: [],
    goalMeta: {},
    loans,
    loanMeta:
      Object.keys(loanMeta).length > 0
        ? loanMeta
        : Object.fromEntries(loans.map((l) => [l.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }])),
    loanPaymentMeta: {},
    customCats: DEFAULT_CUSTOM_CATS,
    notes: '',
    catOrder: DEFAULT_CAT_ORDER,
  };
}

/** Thin wrapper so callers don't have to count 10 leading `undefined`s to
 *  reach the `failedLoanPaymentIds` slot (param 13). */
function composeWithFailedLoanPayment(
  server: RemoteFinanceData,
  ops: readonly PendingWrite[],
  failedLoanPaymentIds?: ReadonlySet<string>,
) {
  return composeFinance(
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
    undefined,
    undefined,
    failedLoanPaymentIds,
  );
}

export async function runOfflineQueueLoanPaymentCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ SCHEMA ============================ */

  // 1 — valid CREATE record round-trips
  {
    const v = validatePendingWrite(lpCreateObj());
    check(
      '1 valid loanPayment CREATE parses with loanId + payload, no expectedUpdatedAt',
      !!v &&
        v.entity === 'loanPayment' &&
        v.op === 'create' &&
        'loanId' in v &&
        v.loanId === 'loan-1' &&
        !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
  }

  // 2 — valid DELETE record round-trips
  {
    const v = validatePendingWrite(lpDeleteObj());
    check(
      '2 valid loanPayment DELETE parses with loanId + expectedUpdatedAt, no payload',
      !!v &&
        v.entity === 'loanPayment' &&
        v.op === 'delete' &&
        'loanId' in v &&
        v.loanId === 'loan-1' &&
        'expectedUpdatedAt' in v &&
        !('payload' in v),
      JSON.stringify(v),
    );
  }

  // 3 — a payment can NEVER be `op:'update'` — structurally unreachable, and
  // the validator explicitly guards it even if a persisted record were
  // somehow tampered with.
  {
    const asUpdate = { ...lpCreateObj(), op: 'update' };
    check(
      '3 op:"update" loanPayment record is rejected (a payment is create/delete only)',
      validatePendingWrite(asUpdate) === null,
      '',
    );
  }

  // 4 — malformed persisted loanPayment records are rejected
  {
    const bad = [
      lpCreateObj({ loanId: undefined }),
      lpCreateObj({ loanId: '' }),
      lpCreateObj({ payload: pd({ date: '2026-13-40' }) }), // not a real calendar date
      lpCreateObj({ payload: pd({ amount: 0 }) }), // amount must be > 0
      lpCreateObj({ payload: pd({ amount: -5 }) }),
      lpCreateObj({ payload: pd({ amount: 1.5 }) }), // not an integer
      lpCreateObj({ payload: { ...pd(), loan_id: 'loan-1' } }), // server/identity field in payload
      lpCreateObj({ payload: { ...pd(), id: 'lp-1' } }),
      lpCreateObj({ payload: { ...pd(), principal_part: 1000 } }), // server-derived field NEVER in payload
      lpCreateObj({ payload: { ...pd(), interest_part: 0 } }),
      lpDeleteObj({ loanId: undefined }),
      lpDeleteObj({ expectedUpdatedAt: undefined }),
      lpDeleteObj({ expectedUpdatedAt: '' }),
      lpDeleteObj({ payload: pd() }), // DELETE carries no payload
      { ...lpCreateObj(), entityId: '' },
    ];
    check(
      '4 malformed loanPayment persisted ops all reject',
      bad.every((b) => validatePendingWrite(b) === null),
      JSON.stringify(bad.map((b) => validatePendingWrite(b))),
    );
  }

  // 5 — old persisted entity variants (incl. plain loan) still hydrate unchanged
  {
    const mixed = [
      makePendingLoanCreate({ scope: A, entityId: 'loan-9', payload: ld(), queueId: 'q-l' }),
      lpCreateObj({ queueId: 'q-lp2' }),
    ];
    const { records, dropped } = sanitizePendingWrites(mixed);
    check(
      '5 loan + loanPayment both hydrate, none dropped',
      dropped === 0 && records.length === 2 && records.map((r) => r.entity).join(',') === 'loan,loanPayment',
      JSON.stringify({ dropped, entities: records.map((r) => r.entity) }),
    );
  }

  /* ============================= DEDUP ============================= */

  const base: PendingWrite[] = [];

  // 6 — identical CREATE retry (same entityId+loanId+payload) is an idempotent no-op
  {
    const m1 = makePendingLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, m1);
    const m2 = makePendingLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd(), queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], m2);
    check(
      '6 identical payment retry (same entityId+loanId+payload) -> deduped, queue length 1',
      r2.ok === true && r2.deduped === true && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }

  // 7 — a DIFFERING payment for the SAME payment id is existing-pending (never overwritten)
  {
    const m1 = makePendingLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 1000000 }),
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, m1);
    const m2 = makePendingLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 2000000 }), // different amount, same payment id
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], m2);
    check(
      '7 differing payment (amount) at the SAME entityId -> refused existing-pending',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 8 — TWO DIFFERENT payment ids for the SAME loan are NOT deduped at this
  // pure layer (dedup is per-entityId, i.e. per payment) — the "one change
  // per loan" LOCK is a coordinator-level policy
  // (enqueueLoanPaymentCreate/enqueueLoanDelete), deliberately NOT
  // re-implemented here. This case documents that boundary rather than
  // asserting a rejection.
  {
    const m1 = makePendingLoanPaymentCreate({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      payload: pd({ amount: 1000000 }),
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, m1);
    const m2 = makePendingLoanPaymentCreate({
      scope: A,
      entityId: 'lp-2', // a DIFFERENT payment id, same loan
      loanId: 'loan-1',
      payload: pd({ amount: 500000 }),
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], m2);
    check(
      '8 pure core allows two different payment ids for the same loan (lock is coordinator-level, not here)',
      r2.ok === true && r2.deduped === false && r2.queue.length === 2,
      JSON.stringify(r2),
    );
  }

  // 9 — DELETE: a token difference is a different request
  {
    const d1 = makePendingLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'SRV-V1',
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, d1);
    const d2 = makePendingLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'SRV-V2',
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], d2);
    const d3 = makePendingLoanPaymentDelete({
      scope: A,
      entityId: 'lp-1',
      loanId: 'loan-1',
      expectedUpdatedAt: 'SRV-V1',
      queueId: 'q3',
    });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], d3);
    check(
      '9 DELETE differing token -> existing-pending; same token -> deduped',
      r2.ok === false && r2.reason === 'existing-pending' && r3.ok === true && r3.deduped === true,
      JSON.stringify({ r2, r3 }),
    );
  }

  /* ========================= MANAGEMENT OVERLAY ========================= */

  // 10 — pending CREATE (annualRate=0, so principalPart === amount exactly):
  // optimistic `paid` increase, overlay only, data.loans untouched
  {
    const server = financeWith([serverLoan('loan-1', { principal: 100000000, paid: 0 })]);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 1000000 }),
        queueId: 'q1',
      }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '10 pending payment create -> loanManagement shows paid+principalPart, data.loans untouched',
      data.loans[0].paid === 0 &&
        loanManagement.rows[0].paid === 1000000 &&
        loanManagement.opById.get('loan-1') === 'update' &&
        !loanManagement.failedIds.has('loan-1') &&
        loanManagement.paymentById.get('loan-1')?.kind === 'create' &&
        loanManagement.paymentById.get('loan-1')?.amount === 1000000,
      JSON.stringify(loanManagement),
    );
  }

  // 11 — pending CREATE with a NONZERO rate: the overlay's math matches
  // `splitPayment()` EXACTLY (reused verbatim, never re-derived)
  {
    const principal = 100000000;
    const paid = 20000000;
    const annualRate = 4.5;
    const amount = 1000000;
    const remaining = principal - paid;
    const { principalPart } = splitPayment(remaining, annualRate, amount);
    const server = financeWith([serverLoan('loan-1', { principal, paid, annualRate })]);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount }),
        queueId: 'q1',
      }),
    ];
    const { loanManagement } = composeFinance(server, ops);
    check(
      '11 pending payment create with interest -> overlay paid = server paid + splitPayment().principalPart, exactly',
      loanManagement.rows[0].paid === paid + principalPart,
      JSON.stringify({ expected: paid + principalPart, actual: loanManagement.rows[0].paid }),
    );
  }

  // 12 — pending DELETE: reverses by the target payment's OWN `principalPart`
  // (never the raw `amount`), removes it from `payments`, overlay only
  {
    const server = financeWith([
      serverLoan('loan-1', {
        principal: 100000000,
        paid: 3000000,
        payments: [
          { id: 'lp-1', date: '2026-08-15', amount: 2000000, principalPart: 1800000, interestPart: 200000 },
          { id: 'lp-2', date: '2026-09-15', amount: 1300000, principalPart: 1200000, interestPart: 100000 },
        ],
      }),
    ]);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentDelete({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '12 pending payment delete -> paid decreases by principalPart (1800000), payment removed from overlay, data.loans untouched',
      data.loans[0].paid === 3000000 &&
        data.loans[0].payments.length === 2 &&
        loanManagement.rows[0].paid === 1200000 &&
        loanManagement.rows[0].payments.length === 1 &&
        loanManagement.rows[0].payments[0].id === 'lp-2' &&
        loanManagement.opById.get('loan-1') === 'update' &&
        loanManagement.paymentById.get('loan-1')?.kind === 'delete' &&
        loanManagement.paymentById.get('loan-1')?.amount === 2000000,
      JSON.stringify(loanManagement),
    );
  }

  // 13 — pending DELETE whose target payment is NOT found on the server row
  // (e.g. it already landed and the id no longer exists) -> defensive no-op,
  // never crashes, never invents a marker
  {
    const server = financeWith([
      serverLoan('loan-1', {
        principal: 100000000,
        paid: 500000,
        payments: [{ id: 'lp-OTHER', date: '2026-09-01', amount: 500000, principalPart: 500000, interestPart: 0 }],
      }),
    ]);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentDelete({
        scope: A,
        entityId: 'lp-1', // not present in `payments`
        loanId: 'loan-1',
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '13 payment delete with no matching target payment -> no-op, no marker invented, no crash',
      data.loans[0].paid === 500000 &&
        loanManagement.rows[0].paid === 500000 &&
        loanManagement.rows[0].payments.length === 1 &&
        !loanManagement.opById.has('loan-1') &&
        !loanManagement.paymentById.has('loan-1'),
      JSON.stringify(loanManagement),
    );
  }

  // 14 — failed CREATE + server row present -> AUTHORITATIVE paid wins, never overwritten
  {
    const server = financeWith([serverLoan('loan-1', { principal: 100000000, paid: 5000000 })]); // e.g. another device also repaid meanwhile
    const ops: PendingWrite[] = [
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 1000000 }),
        queueId: 'q1',
      }),
    ];
    const failedPaymentIds = new Set(['lp-1']);
    const { data, loanManagement } = composeWithFailedLoanPayment(server, ops, failedPaymentIds);
    check(
      '14 failed payment create + server row -> management row shows AUTHORITATIVE 5000000, never the optimistic estimate',
      data.loans[0].paid === 5000000 &&
        loanManagement.rows[0].paid === 5000000 &&
        loanManagement.failedIds.has('loan-1') &&
        loanManagement.paymentById.get('loan-1')?.kind === 'create' &&
        loanManagement.paymentById.get('loan-1')?.amount === 1000000,
      JSON.stringify(loanManagement),
    );
  }

  // 15 — failed DELETE + server row present -> AUTHORITATIVE paid/payments
  // stay UNTOUCHED (never optimistically removed), marker still surfaces
  {
    const server = financeWith([
      serverLoan('loan-1', {
        principal: 100000000,
        paid: 1800000,
        payments: [{ id: 'lp-1', date: '2026-08-15', amount: 2000000, principalPart: 1800000, interestPart: 200000 }],
      }),
    ]);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentDelete({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failedPaymentIds = new Set(['lp-1']);
    const { data, loanManagement } = composeWithFailedLoanPayment(server, ops, failedPaymentIds);
    check(
      '15 failed payment delete + server row -> AUTHORITATIVE paid/payments untouched, never optimistically removed',
      data.loans[0].paid === 1800000 &&
        loanManagement.rows[0].paid === 1800000 &&
        loanManagement.rows[0].payments.length === 1 &&
        loanManagement.failedIds.has('loan-1') &&
        loanManagement.paymentById.get('loan-1')?.kind === 'delete' &&
        loanManagement.paymentById.get('loan-1')?.amount === 2000000,
      JSON.stringify(loanManagement),
    );
  }

  // 16 — orphan payment (server loan row gone entirely) -> skipped, no crash, no synthetic row invented
  {
    const server = financeWith([]); // loan deleted on another device while this device was offline
    const ops: PendingWrite[] = [
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 1000000 }),
        queueId: 'q1',
      }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '16 orphan payment (loan row absent) -> no rows invented, data.loans stays empty',
      data.loans.length === 0 && loanManagement.rows.length === 0 && loanManagement.opById.size === 0,
      JSON.stringify(loanManagement),
    );
  }

  // 17 — a loan UPDATE already claims the row -> the payment is skipped (first-come-wins), never double-marked
  {
    const server = financeWith([serverLoan('loan-1', { paid: 1000000, principal: 100000000 })]);
    const ops: PendingWrite[] = [
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-1',
        payload: ld({ principal: 90000000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 1000000 }),
        queueId: 'q2',
      }),
    ];
    const { loanManagement } = composeFinance(server, ops);
    check(
      '17 loan UPDATE already claims the row -> payment overlay skipped, paid untouched by the payment',
      loanManagement.rows[0].principal === 90000000 &&
        loanManagement.rows[0].paid === 1000000 && // the payment's delta was NOT applied
        loanManagement.opById.get('loan-1') === 'update' &&
        !loanManagement.paymentById.has('loan-1'),
      JSON.stringify(loanManagement),
    );
  }

  // 18 — a loan DELETE already claims the row -> the payment is skipped too
  {
    const server = financeWith([serverLoan('loan-1', { paid: 1000000, principal: 100000000 })]);
    const ops: PendingWrite[] = [
      makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 1000000 }),
        queueId: 'q2',
      }),
    ];
    const { loanManagement } = composeFinance(server, ops);
    check(
      '18 loan DELETE already claims the row -> payment overlay skipped, row hidden not paid-bumped',
      loanManagement.hiddenIds.includes('loan-1') &&
        loanManagement.rows.length === 0 &&
        !loanManagement.paymentById.has('loan-1'),
      JSON.stringify(loanManagement),
    );
  }

  /* ====================== DATA SEPARATION ====================== */

  // 19 — data.loans / loanMeta are NEVER mutated by a pending payment op
  {
    const meta = { 'loan-1': { updatedAt: 'SRV-V1', createdBy: 'u-A' } };
    const server = financeWith([serverLoan('loan-1', { paid: 1000000 })], meta);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 500000 }),
        queueId: 'q1',
      }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '19 data.loans / loanMeta untouched by a pending payment (same references, unchanged paid)',
      data.loans === server.loans && data.loans[0].paid === 1000000 && data.loanMeta === server.loanMeta,
      JSON.stringify(data.loans),
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 20 — scope isolation: household B never sees household A's payment op
  {
    const q: PendingWrite[] = [
      makePendingLoanPaymentCreate({ scope: A, entityId: 'lp-1', loanId: 'loan-1', payload: pd(), queueId: 'qa' }),
      makePendingLoanPaymentCreate({ scope: B, entityId: 'lp-2', loanId: 'loan-2', payload: pd(), queueId: 'qb' }),
    ];
    const forA = opsForScope(q, A.userId, A.householdId);
    const forB = opsForScope(q, B.userId, B.householdId);
    check(
      '20 opsForScope isolates loanPayment ops per (userId, householdId)',
      forA.length === 1 && forA[0].queueId === 'qa' && forB.length === 1 && forB[0].queueId === 'qb',
      JSON.stringify({ forA: forA.map((o) => o.queueId), forB: forB.map((o) => o.queueId) }),
    );
  }

  // 21 — a loan + loanPayment mix for DIFFERENT loans leaves both independent
  {
    const server = financeWith([
      serverLoan('loan-1', { paid: 1000000, principal: 100000000 }),
      serverLoan('loan-2', { paid: 5000000, principal: 50000000, name: '신용대출' }),
    ]);
    const ops: PendingWrite[] = [
      makePendingLoanPaymentCreate({
        scope: A,
        entityId: 'lp-1',
        loanId: 'loan-1',
        payload: pd({ amount: 1000000 }),
        queueId: 'q1',
      }),
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-2',
        payload: ld({ principal: 40000000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q2',
      }),
    ];
    const { loanManagement } = composeFinance(server, ops);
    const row1 = loanManagement.rows.find((l) => l.id === 'loan-1');
    const row2 = loanManagement.rows.find((l) => l.id === 'loan-2');
    check(
      '21 payment on loan-1 and update on loan-2 both apply independently',
      row1?.paid === 2000000 && row2?.principal === 40000000 && row2?.paid === 5000000,
      JSON.stringify({ row1, row2 }),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
