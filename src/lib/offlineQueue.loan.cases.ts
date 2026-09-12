/**
 * Static verification for STEP 16-H2-L1 — loan CREATE / UPDATE / soft DELETE
 * added to the pure Offline Write Queue core: record shapes, the
 * union-aware validator, the dedup / existing-pending policy, the
 * DISPLAY-ONLY `loanManagement` overlay (NEVER merged into `data.loans` /
 * `data.loanMeta` — any other consumer keeps reading authoritative server
 * data), `paid`/`payments` NEVER being part of any payload or ever being
 * overwritten by a plain UPDATE overlay, and the `serverLoanConfirmsUpdate`
 * ack matcher.
 *
 * Mirrors src/lib/offlineQueue.goal.cases.ts. Repayment create/delete
 * (`entity:'loanPayment'`) is a SEPARATE file
 * (offlineQueue.loanPayment.cases.ts) — not exercised here. ENGINE ONLY — no
 * UI wiring is exercised. RunOp dispatch + the ack reconcile live in
 * coordinator.loan.cases.ts (typecheck-only — see that file's header).
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS } from '@/data/categories';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewGoalDraft } from '@/lib/remoteGoalWriteMapping';
import type { NewLoanDraft } from '@/lib/remoteLoanWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingCardCreate,
  makePendingGoalCreate,
  makePendingLoanCreate,
  makePendingLoanDelete,
  makePendingLoanUpdate,
  makePendingTransactionCreate,
  opsForScope,
  sanitizePendingWrites,
  serverLoanConfirmsUpdate,
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
const FROZEN = '2026-09-10T09:00:00.000+00:00';
const FROZEN2 = '2026-09-10T10:00:00.000+00:00';

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
const gd = (over: Partial<NewGoalDraft> = {}): NewGoalDraft => ({
  name: '내 집 마련',
  target: 5000000,
  deadline: '2027-01-01',
  icon: '🏠',
  ...over,
});
const td = (over: Partial<NewTransactionDraft> = {}): NewTransactionDraft => ({
  type: 'expense',
  category: 'food',
  amount: 1000,
  memo: '',
  date: T0,
  ...over,
});

const loCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-lc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loan',
  op: 'create',
  entityId: 'loan-1',
  payload: ld(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const loUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-lu',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loan',
  op: 'update',
  entityId: 'loan-1',
  payload: ld(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const loDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-ld',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'loan',
  op: 'delete',
  entityId: 'loan-1',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

const serverLoan = (id: string, over: Partial<Loan> = {}): Loan => ({
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

/** Thin wrapper so callers don't have to count 9 leading `undefined`s to
 *  reach the `failedLoanIds` slot (param 12). */
function composeWithFailedLoan(
  server: RemoteFinanceData,
  ops: readonly PendingWrite[],
  failedLoanIds?: ReadonlySet<string>,
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
    failedLoanIds,
  );
}

export async function runOfflineQueueLoanCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ SCHEMA ============================ */

  // 1 — CREATE valid; a CREATE carries no token
  {
    const v = validatePendingWrite(loCreateObj());
    check(
      '1 CREATE valid, no expectedUpdatedAt',
      !!v && v.entity === 'loan' && v.op === 'create' && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
    check(
      '1b CREATE with an expectedUpdatedAt is rejected',
      validatePendingWrite(loCreateObj({ expectedUpdatedAt: FROZEN })) === null,
      '',
    );
  }

  // 2 — UPDATE valid + frozen token REQUIRED
  {
    const v = validatePendingWrite(loUpdateObj());
    check(
      '2 UPDATE valid with frozen token',
      !!v && v.op === 'update' && v.entity === 'loan' && v.expectedUpdatedAt === FROZEN,
      JSON.stringify(v),
    );
    check(
      '2b UPDATE without a token is rejected',
      validatePendingWrite(loUpdateObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(loUpdateObj({ expectedUpdatedAt: '' })) === null,
      '',
    );
  }

  // 3 — DELETE valid + frozen token REQUIRED, no payload
  {
    const v = validatePendingWrite(loDeleteObj());
    check(
      '3 DELETE valid with frozen token, no payload',
      !!v && v.op === 'delete' && v.entity === 'loan' && !('payload' in v),
      JSON.stringify(v),
    );
    check(
      '3b DELETE without a token / with a payload is rejected',
      validatePendingWrite(loDeleteObj({ expectedUpdatedAt: undefined })) === null &&
        validatePendingWrite(loDeleteObj({ payload: ld() })) === null,
      '',
    );
  }

  // 4 — malformed persisted loan queue records are rejected
  {
    const bad = [
      loCreateObj({ payload: ld({ name: '   ' }) }), // blank name
      loCreateObj({ payload: ld({ principal: 0 }) }), // principal must be > 0
      loCreateObj({ payload: ld({ principal: -5 }) }),
      loCreateObj({ payload: ld({ principal: 1.5 }) }), // not an integer
      loCreateObj({ payload: ld({ annualRate: -0.1 }) }), // annualRate must be >= 0
      loCreateObj({ payload: ld({ termMonths: 0 }) }),
      loCreateObj({ payload: ld({ termMonths: 1.5 }) }),
      loCreateObj({ payload: ld({ startDate: '2026-13-40' }) }), // not a real calendar date
      loCreateObj({ payload: ld({ paymentDay: 0 }) }), // out of 1..31
      loCreateObj({ payload: ld({ paymentDay: 32 }) }),
      loCreateObj({ payload: ld({ paymentDay: 1.5 }) }),
      loCreateObj({ payload: ld({ repayType: 'transfer' as never }) }), // bad enum
      loCreateObj({ payload: { ...ld(), paid: 5000 } }), // `paid` NEVER in a payload
      loCreateObj({ payload: { ...ld(), payments: [] } }), // `payments` NEVER in a payload
      loCreateObj({ payload: { ...ld(), id: 'loan-1' } }), // server/identity field in payload
      loCreateObj({ payload: { ...ld(), household_id: 'h-A' } }),
      loCreateObj({ payload: { ...ld(), updated_at: T0 } }),
      loUpdateObj({ payload: { ...ld(), deleted_at: T0 } }),
      { ...loCreateObj(), entityId: '' },
    ];
    check(
      '4 malformed loan persisted ops all reject',
      bad.every((b) => validatePendingWrite(b) === null),
      JSON.stringify(bad.map((b) => validatePendingWrite(b))),
    );
  }

  // 5 — old persisted entity variants (incl. plain goal) still hydrate unchanged
  {
    const mixed = [
      {
        queueId: 'q-t',
        schemaVersion: QUEUE_SCHEMA_VERSION,
        scope: A,
        entity: 'transaction',
        op: 'create',
        entityId: 'txn-1',
        payload: td(),
        enqueuedAt: T0,
        attemptCount: 0,
      },
      {
        queueId: 'q-c',
        schemaVersion: QUEUE_SCHEMA_VERSION,
        scope: A,
        entity: 'card',
        op: 'create',
        entityId: 'card-1',
        payload: { name: 'Visa' } as NewCardDraft,
        enqueuedAt: T0,
        attemptCount: 0,
      },
      makePendingGoalCreate({ scope: A, entityId: 'goal-9', payload: gd(), queueId: 'q-g' }),
      loCreateObj({ queueId: 'q-l' }),
    ];
    const { records, dropped } = sanitizePendingWrites(mixed);
    check(
      '5 transaction/card/goal + loan all hydrate, none dropped',
      dropped === 0 &&
        records.length === 4 &&
        records.map((r) => r.entity).join(',') === 'transaction,card,goal,loan',
      JSON.stringify({ dropped, entities: records.map((r) => r.entity) }),
    );
  }

  /* ============================= DEDUP ============================= */

  const base: PendingWrite[] = [];

  // 6 — identical CREATE re-enqueue is an idempotent no-op (same request)
  {
    const c1 = makePendingLoanCreate({ scope: A, entityId: 'loan-1', payload: ld(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingLoanCreate({ scope: A, entityId: 'loan-1', payload: ld(), queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '6 identical CREATE -> deduped, queue length 1, original kept',
      r2.ok === true && r2.deduped === true && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }

  // 7 — a DIFFERING CREATE for the same id is existing-pending (never overwritten)
  {
    const c1 = makePendingLoanCreate({ scope: A, entityId: 'loan-1', payload: ld(), queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, c1);
    const c2 = makePendingLoanCreate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 200000000 }),
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], c2);
    check(
      '7 differing CREATE (principal) -> refused existing-pending, original untouched',
      r2.ok === false && r2.reason === 'existing-pending' && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }

  // 8 — UPDATE: token OR draft difference is respected (never blind-merged)
  {
    const u1 = makePendingLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 60000000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q1',
    });
    const r1 = enqueuePendingWrite(base, u1);
    // same token, DIFFERENT draft -> existing-pending
    const u2 = makePendingLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 70000000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q2',
    });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], u2);
    // DIFFERENT token, same draft -> existing-pending
    const u3 = makePendingLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 60000000 }),
      expectedUpdatedAt: FROZEN2,
      queueId: 'q3',
    });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], u3);
    // identical token + draft -> deduped
    const u4 = makePendingLoanUpdate({
      scope: A,
      entityId: 'loan-1',
      payload: ld({ principal: 60000000 }),
      expectedUpdatedAt: FROZEN,
      queueId: 'q4',
    });
    const r4 = enqueuePendingWrite(r1.ok ? r1.queue : [], u4);
    check(
      '8 UPDATE token/draft difference respected; identical is deduped',
      r2.ok === false &&
        r2.reason === 'existing-pending' &&
        r3.ok === false &&
        r3.reason === 'existing-pending' &&
        r4.ok === true &&
        r4.deduped === true,
      JSON.stringify({ r2, r3, r4 }),
    );
  }

  // 9 — DELETE: a token difference is a different request
  {
    const d1 = makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: FROZEN, queueId: 'q1' });
    const r1 = enqueuePendingWrite(base, d1);
    const d2 = makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: FROZEN2, queueId: 'q2' });
    const r2 = enqueuePendingWrite(r1.ok ? r1.queue : [], d2);
    const d3 = makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: FROZEN, queueId: 'q3' });
    const r3 = enqueuePendingWrite(r1.ok ? r1.queue : [], d3);
    check(
      '9 DELETE differing token -> existing-pending; same token -> deduped',
      r2.ok === false && r2.reason === 'existing-pending' && r3.ok === true && r3.deduped === true,
      JSON.stringify({ r2, r3 }),
    );
  }

  /* ==================== ACK MATCHER (pure) ==================== */

  // 10 — serverLoanConfirmsUpdate: content match (trim-aware name/lender), never `paid`/`payments`
  {
    const row = serverLoan('loan-1', { paid: 12000000 });
    check(
      '10 same content (raw draft has untrimmed name/lender), paid irrelevant -> confirms',
      serverLoanConfirmsUpdate(row, ld({ name: '  전세자금대출  ', lender: ' 국민은행 ' })) === true,
      '',
    );
    check(
      '10b different principal -> does NOT confirm',
      serverLoanConfirmsUpdate(row, ld({ principal: 1 })) === false,
      '',
    );
    check(
      '10c different repayType -> does NOT confirm (stale concurrent server edit never "matched")',
      serverLoanConfirmsUpdate(serverLoan('loan-1', { repayType: 'bullet' }), ld({ repayType: 'amortizing' })) ===
        false,
      '',
    );
  }

  /* ========================= MANAGEMENT ========================= */

  // 11 — pending CREATE: synthetic management row ONLY, absent from data.loans, paid=0/payments=[]
  {
    const server = financeWith([]);
    const ops: PendingWrite[] = [
      makePendingLoanCreate({ scope: A, entityId: 'loan-1', payload: ld({ principal: 30000000 }), queueId: 'q1' }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '11 pending CREATE -> synthetic row in loanManagement only, NOT in data.loans, paid=0/payments=[]',
      data.loans.length === 0 &&
        loanManagement.rows.length === 1 &&
        loanManagement.rows[0].id === 'loan-1' &&
        loanManagement.rows[0].principal === 30000000 &&
        loanManagement.rows[0].paid === 0 &&
        loanManagement.rows[0].payments.length === 0 &&
        loanManagement.syntheticIds.has('loan-1') &&
        loanManagement.opById.get('loan-1') === 'create',
      JSON.stringify(loanManagement),
    );
  }

  // 12 — pending UPDATE: management overlay only, data.loans authoritative, `paid` PRESERVED
  {
    const server = financeWith([serverLoan('loan-1', { principal: 100000000, paid: 10000000 })]);
    const ops: PendingWrite[] = [
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-1',
        payload: ld({ principal: 80000000 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q1',
      }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '12 pending UPDATE -> overlay ONLY in loanManagement, data.loans still 100000000, `paid` untouched by the overlay',
      data.loans[0].principal === 100000000 &&
        loanManagement.rows[0].principal === 80000000 &&
        loanManagement.rows[0].paid === 10000000 &&
        loanManagement.opById.get('loan-1') === 'update' &&
        !loanManagement.syntheticIds.has('loan-1'),
      JSON.stringify(loanManagement),
    );
  }

  // 13 — pending (not-failed) DELETE: hidden from management rows, kept in data.loans
  {
    const server = financeWith([serverLoan('loan-1'), serverLoan('loan-2', { name: '신용대출' })]);
    const ops: PendingWrite[] = [
      makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '13 pending DELETE -> hidden from loanManagement.rows, still authoritative in data.loans',
      data.loans.length === 2 &&
        loanManagement.rows.length === 1 &&
        loanManagement.rows[0].id === 'loan-2' &&
        loanManagement.hiddenIds.includes('loan-1'),
      JSON.stringify(loanManagement),
    );
  }

  // 14 — failed UPDATE + server row present -> AUTHORITATIVE wins (incl. `paid`), attempted kept as metadata
  {
    const server = financeWith([serverLoan('loan-1', { principal: 100000000, paid: 20000000 })]); // e.g. a repayment landed meanwhile
    const ops: PendingWrite[] = [
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-1',
        payload: ld({ principal: 40000000 }), // A's stale offline draft
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failed = new Set(['loan-1']);
    const { data, loanManagement } = composeWithFailedLoan(server, ops, failed);
    check(
      '14 failed UPDATE + server row -> management row shows AUTHORITATIVE 100000000/paid 20000000, never the stale draft',
      data.loans[0].principal === 100000000 &&
        loanManagement.rows[0].principal === 100000000 &&
        loanManagement.rows[0].paid === 20000000 &&
        loanManagement.failedIds.has('loan-1') &&
        !loanManagement.syntheticIds.has('loan-1'),
      JSON.stringify(loanManagement),
    );
    check(
      '14b attempted local draft preserved as conflict metadata only',
      loanManagement.attemptedDraftById.get('loan-1')?.principal === 40000000,
      JSON.stringify([...loanManagement.attemptedDraftById]),
    );
  }

  // 15 — orphan failed UPDATE (server row gone) -> synthetic display-only row, paid=0/payments=[]
  {
    const server = financeWith([]); // B deleted it while A was offline
    const ops: PendingWrite[] = [
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-1',
        payload: ld({ principal: 40000000 }),
        expectedUpdatedAt: 'SRV-V0',
        queueId: 'q1',
      }),
    ];
    const failed = new Set(['loan-1']);
    const { data, loanManagement } = composeWithFailedLoan(server, ops, failed);
    check(
      '15 orphan failed UPDATE -> synthetic display-only row, absent from data.loans',
      data.loans.length === 0 &&
        loanManagement.rows.length === 1 &&
        loanManagement.rows[0].principal === 40000000 &&
        loanManagement.rows[0].paid === 0 &&
        loanManagement.rows[0].payments.length === 0 &&
        loanManagement.syntheticIds.has('loan-1') &&
        loanManagement.failedIds.has('loan-1') &&
        loanManagement.attemptedDraftById.get('loan-1')?.principal === 40000000,
      JSON.stringify(loanManagement),
    );
  }

  // 16 — failed DELETE -> authoritative row restored/visible, marked failed
  {
    const server = financeWith([serverLoan('loan-1', { principal: 100000000 })]);
    const ops: PendingWrite[] = [
      makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'SRV-V0', queueId: 'q1' }),
    ];
    const failed = new Set(['loan-1']);
    const { data, loanManagement } = composeWithFailedLoan(server, ops, failed);
    check(
      '16 failed DELETE -> authoritative row stays visible, marked failed (never permanently hidden)',
      data.loans.length === 1 &&
        loanManagement.rows.length === 1 &&
        loanManagement.rows[0].id === 'loan-1' &&
        loanManagement.opById.get('loan-1') === 'delete' &&
        loanManagement.failedIds.has('loan-1') &&
        loanManagement.hiddenIds.length === 0,
      JSON.stringify(loanManagement),
    );
  }

  /* ====================== DATA SEPARATION ====================== */

  // 17/18 — data.loans / loanMeta are NEVER mutated by any loan op
  {
    const meta = { 'loan-1': { updatedAt: 'SRV-V1', createdBy: 'u-A' } };
    const server = financeWith([serverLoan('loan-1', { principal: 100000000 })], meta);
    const ops: PendingWrite[] = [
      makePendingLoanCreate({ scope: A, entityId: 'loan-2', payload: ld(), queueId: 'q1' }),
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-1',
        payload: ld({ principal: 777 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q2',
      }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '17 data.loans untouched by pending CREATE + UPDATE',
      data.loans.length === 1 && data.loans[0].principal === 100000000 && data.loans === server.loans,
      JSON.stringify(data.loans),
    );
    check(
      '18 loanMeta remains authoritative (same reference)',
      data.loanMeta === server.loanMeta && data.loanMeta['loan-1'].updatedAt === 'SRV-V1',
      JSON.stringify(data.loanMeta),
    );
  }
  {
    const server = financeWith([serverLoan('loan-1')]);
    const ops: PendingWrite[] = [
      makePendingLoanDelete({ scope: A, entityId: 'loan-1', expectedUpdatedAt: 'SRV-V1', queueId: 'q1' }),
    ];
    const { data } = composeFinance(server, ops);
    check(
      '19 data.loans untouched by pending DELETE (only loanManagement hides it)',
      data.loans.length === 1 && data.loans === server.loans,
      JSON.stringify(data.loans),
    );
  }

  // 20 — with only non-loan ops present, the authoritative loan source
  // (`data.loans` === the server snapshot's array) is NOT replaced, and
  // loanManagement just mirrors it 1:1.
  {
    const server = financeWith([serverLoan('loan-1')]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
    ];
    const { data, loanManagement } = composeFinance(server, ops);
    check(
      '20 no loan ops -> data.loans untouched (=== server.loans), loanManagement mirrors it',
      data.loans === server.loans &&
        loanManagement.rows.length === 1 &&
        loanManagement.rows[0].id === 'loan-1' &&
        loanManagement.opById.size === 0 &&
        loanManagement.failedIds.size === 0,
      '',
    );
  }

  /* ======================== QUEUE SAFETY ======================== */

  // 21 — scope isolation: household B never sees household A's loan op
  {
    const q: PendingWrite[] = [
      makePendingLoanCreate({ scope: A, entityId: 'loan-1', payload: ld(), queueId: 'qa' }),
      makePendingLoanCreate({ scope: B, entityId: 'loan-2', payload: ld(), queueId: 'qb' }),
    ];
    const forA = opsForScope(q, A.userId, A.householdId);
    const forB = opsForScope(q, B.userId, B.householdId);
    check(
      '21 opsForScope isolates loan ops per (userId, householdId)',
      forA.length === 1 && forA[0].queueId === 'qa' && forB.length === 1 && forB[0].queueId === 'qb',
      JSON.stringify({ forA: forA.map((o) => o.queueId), forB: forB.map((o) => o.queueId) }),
    );
  }

  // 22 — a mix with transaction + card + goal ops leaves BOTH loan data and the
  // other entities' behaviour unchanged (no cross-entity regression)
  {
    const server = financeWith([serverLoan('loan-1', { principal: 100000000 })]);
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
      makePendingCardCreate({ scope: A, entityId: 'card-1', payload: { name: 'Visa' } as NewCardDraft, queueId: 'q2' }),
      makePendingGoalCreate({ scope: A, entityId: 'goal-1', payload: gd(), queueId: 'q3' }),
      makePendingLoanUpdate({
        scope: A,
        entityId: 'loan-1',
        payload: ld({ principal: 500 }),
        expectedUpdatedAt: 'SRV-V1',
        queueId: 'q4',
      }),
    ];
    const { data, loanManagement, cardManagement, goalManagement } = composeFinance(server, ops);
    check(
      '22 transaction + card + goal + loan mix -> loan data authoritative, other overlays still work',
      data.loans[0].principal === 100000000 &&
        loanManagement.rows[0].principal === 500 &&
        data.transactions.some((t) => t.id === 'txn-1') &&
        cardManagement.rows.some((c) => c.id === 'card-1') &&
        goalManagement.rows.some((g) => g.id === 'goal-1'),
      '',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
