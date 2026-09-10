/**
 * Static verification for STEP 16-H2-C2-BUDGET A1 — budget CREATE / UPDATE /
 * soft DELETE added to the pure Offline Write Queue core: record shapes, the
 * union-aware validator, the dedup / existing-pending policy, the
 * DISPLAY-ONLY `budgetManagement` overlay (NEVER merged into `data.budgets` /
 * `data.budgetMeta` — the one entity where that separation matters most,
 * since `budgets` feeds `monthlyTotals` / every other finance aggregate
 * directly), and the `serverBudgetConfirmsUpdate` ack matcher.
 *
 * Mirrors src/lib/offlineQueue.category.cases.ts. ENGINE ONLY — no UI wiring
 * is exercised here.
 */
import { DEFAULT_CAT_ORDER } from '@/data/categories';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { NewBudgetDraft } from '@/lib/remoteBudgetWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingBudgetCreate,
  makePendingBudgetDelete,
  makePendingBudgetUpdate,
  makePendingTransactionCreate,
  opsForScope,
  sanitizePendingWrites,
  serverBudgetConfirmsUpdate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import type { BudgetMap } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const A = { userId: 'u-A', householdId: 'h-A' };
const B = { userId: 'u-B', householdId: 'h-B' };
const T0 = '2026-09-10T09:00:00.000Z';
const FROZEN = '2026-09-10T09:00:00.000+00:00';

const bd = (over: Partial<NewBudgetDraft> = {}): NewBudgetDraft => ({
  category: 'food',
  amount: 100000,
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

const budCreateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-bc',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'budget',
  op: 'create',
  entityId: 'food',
  payload: bd(),
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const budUpdateObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-bu',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'budget',
  op: 'update',
  entityId: 'food',
  payload: bd(),
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});
const budDeleteObj = (over: Record<string, unknown> = {}) => ({
  queueId: 'q-bd',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: A,
  entity: 'budget',
  op: 'delete',
  entityId: 'food',
  expectedUpdatedAt: FROZEN,
  enqueuedAt: T0,
  attemptCount: 0,
  ...over,
});

function financeWith(budgets: BudgetMap, budgetMeta: Record<string, { updatedAt: string; createdBy: string }> = {}): RemoteFinanceData {
  return {
    transactions: [],
    transactionMeta: {},
    cards: [],
    cardMeta: {},
    budgets,
    budgetMeta,
    categoryMeta: {},
    recurring: [],
    recurringMeta: {},
    planned: [],
    plannedMeta: {},
    goals: [],
    goalMeta: {},
    loans: [],
    loanMeta: {},
    loanPaymentMeta: {},
    customCats: { expense: [], income: [] },
    notes: '',
    catOrder: DEFAULT_CAT_ORDER,
  };
}

export async function runOfflineQueueBudgetCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---------------- record / validator (CREATE #1, QUEUE SAFETY #23) ---------------- */

  // 1 — valid budget CREATE accepted; entityId IS payload.category (no client id)
  {
    const v = validatePendingWrite(budCreateObj());
    check(
      '1 valid budget CREATE accepted, entityId === payload.category',
      !!v && v.entity === 'budget' && v.op === 'create' && v.entityId === 'food' &&
        v.payload.category === 'food' && v.payload.amount === 100000 && !('expectedUpdatedAt' in v),
      JSON.stringify(v),
    );
  }
  // 2 — valid UPDATE / DELETE accepted
  {
    const u = validatePendingWrite(budUpdateObj());
    const d = validatePendingWrite(budDeleteObj());
    check(
      '2 valid budget UPDATE/DELETE accepted with frozen expectedUpdatedAt',
      !!u && u.entity === 'budget' && u.op === 'update' && (u as { expectedUpdatedAt: string }).expectedUpdatedAt === FROZEN &&
        !!d && d.entity === 'budget' && d.op === 'delete' && (d as { expectedUpdatedAt: string }).expectedUpdatedAt === FROZEN,
      JSON.stringify({ u, d }),
    );
  }
  // 3 — malformed payloads rejected (§23): missing fields, wrong types, server/timestamp fields present
  {
    const bad = [
      validatePendingWrite(budCreateObj({ payload: { amount: 100 } })), // no category
      validatePendingWrite(budCreateObj({ payload: { category: 'food' } })), // no amount
      validatePendingWrite(budCreateObj({ payload: { category: 'food', amount: 'x' } })), // wrong type
      validatePendingWrite(budCreateObj({ payload: { category: 'food', amount: 0 } })), // amount must be > 0
      validatePendingWrite(budCreateObj({ payload: { category: 'food', amount: -5 } })),
      validatePendingWrite(budCreateObj({ payload: { ...bd(), id: 'x' } })),
      validatePendingWrite(budCreateObj({ payload: { ...bd(), household_id: 'h-A' } })),
      validatePendingWrite(budCreateObj({ payload: { ...bd(), category_id: 'food' } })),
      validatePendingWrite(budCreateObj({ payload: { ...bd(), updated_at: T0 } })),
      validatePendingWrite(budCreateObj({ payload: { ...bd(), deleted_at: T0 } })),
      validatePendingWrite(budCreateObj({ expectedUpdatedAt: FROZEN })), // CREATE carries no token
      validatePendingWrite(budUpdateObj({ expectedUpdatedAt: undefined as unknown as string })),
      validatePendingWrite(budUpdateObj({ expectedUpdatedAt: '' })),
      validatePendingWrite(budDeleteObj({ payload: bd() })), // DELETE carries no payload
      validatePendingWrite(budDeleteObj({ expectedUpdatedAt: '' })),
      validatePendingWrite({ ...budCreateObj(), schemaVersion: 2 }),
      validatePendingWrite(null),
      validatePendingWrite('nope'),
    ];
    check('3 malformed budget PendingWrite rejected in every case', bad.every((x) => x === null), JSON.stringify(bad));
  }
  // 4 — sanitizePendingWrites drops only the bad ones, keeps the good ones in order
  {
    const raw = [budCreateObj({ queueId: 'q1' }), { entity: 'budget', op: 'create' }, budUpdateObj({ queueId: 'q2' })];
    const { records, dropped } = sanitizePendingWrites(raw);
    check(
      '4 sanitizePendingWrites: 2 kept in order, 1 dropped',
      records.length === 2 && dropped === 1 && records[0].queueId === 'q1' && records[1].queueId === 'q2',
      JSON.stringify({ records, dropped }),
    );
  }
  // 5 — REGRESSION (§24): an old transaction record persisted before budget
  // existed still validates unchanged (additive union — no migration needed).
  {
    const oldTxn = {
      queueId: 'q-old',
      schemaVersion: QUEUE_SCHEMA_VERSION,
      scope: A,
      entity: 'transaction',
      op: 'create',
      entityId: 'txn-old',
      payload: td(),
      enqueuedAt: T0,
      attemptCount: 0,
    };
    const v = validatePendingWrite(oldTxn);
    check(
      '5 pre-budget transaction record still validates (additive union, schemaVersion unchanged)',
      !!v && v.entity === 'transaction' && QUEUE_SCHEMA_VERSION === 1,
      JSON.stringify(v),
    );
  }

  /* ---------------- dedup / sameRequest (CREATE #3) ---------------- */

  // 6 — same scope+entity+op+entityId, SAME amount -> idempotent dedup (no growth)
  {
    const c1 = makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 5000 }), queueId: 'q1' });
    const c2 = makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 5000 }), queueId: 'q2' });
    const r1 = enqueuePendingWrite([], c1);
    const r2 = enqueuePendingWrite(r1.queue, c2);
    check(
      '6 identical budget CREATE re-enqueued -> deduped, queue length 1',
      r1.ok && r2.ok && r2.deduped === true && r2.queue.length === 1,
      JSON.stringify(r2),
    );
  }
  // 7 — same identity, DIFFERENT amount -> refused as existing-pending (never silently overwritten)
  {
    const c1 = makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 5000 }), queueId: 'q1' });
    const c2 = makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 9999 }), queueId: 'q2' });
    const r1 = enqueuePendingWrite([], c1);
    const r2 = enqueuePendingWrite(r1.queue, c2);
    check(
      '7 differing budget CREATE amount for same category -> existing-pending, not overwritten',
      r1.ok && !r2.ok && r2.reason === 'existing-pending' && r2.queue.length === 1 && r2.queue[0].queueId === 'q1',
      JSON.stringify(r2),
    );
  }
  // 8 — UPDATE dedup requires same expectedUpdatedAt AND same amount
  {
    const u1 = makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 5000 }), expectedUpdatedAt: 'V1', queueId: 'q1' });
    const uSame = makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 5000 }), expectedUpdatedAt: 'V1', queueId: 'q2' });
    const uDiffToken = makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 5000 }), expectedUpdatedAt: 'V2', queueId: 'q3' });
    const r1 = enqueuePendingWrite([], u1);
    const rSame = enqueuePendingWrite(r1.queue, uSame);
    const rDiff = enqueuePendingWrite(r1.queue, uDiffToken);
    check(
      '8 UPDATE: same token+amount dedups; different token is existing-pending',
      rSame.ok && rSame.deduped === true && !rDiff.ok && rDiff.reason === 'existing-pending',
      JSON.stringify({ rSame, rDiff }),
    );
  }
  // 9 — DELETE dedup on expectedUpdatedAt alone
  {
    const d1 = makePendingBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'V1', queueId: 'q1' });
    const dSame = makePendingBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'V1', queueId: 'q2' });
    const r1 = enqueuePendingWrite([], d1);
    const rSame = enqueuePendingWrite(r1.queue, dSame);
    check('9 DELETE same frozen token -> deduped', rSame.ok && rSame.deduped === true, JSON.stringify(rSame));
  }
  // 10 — entityId is the natural key: a budget op and a category op sharing the
  // SAME id string never collide (entity is part of the dedup key).
  {
    const budOp = makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite([], budOp);
    const scoped = opsForScope(r1.queue, A.userId, A.householdId);
    check(
      '10 budget entity participates in scope filter like every other entity',
      scoped.length === 1 && scoped[0].entity === 'budget' && scoped[0].entityId === 'food',
      JSON.stringify(scoped),
    );
  }
  // 21 (QUEUE SAFETY) — scope isolation: household B never sees household A's budget op
  {
    const budOp = makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd(), queueId: 'q1' });
    const r1 = enqueuePendingWrite([], budOp);
    const underB = opsForScope(r1.queue, B.userId, B.householdId);
    const underA = opsForScope(r1.queue, A.userId, A.householdId);
    check(
      '21 scope isolation: budget op invisible under a different (userId,householdId)',
      underB.length === 0 && underA.length === 1,
      JSON.stringify({ underB, underA }),
    );
  }

  /* ---------------- serverBudgetConfirmsUpdate (§7/§9 ack matcher) ---------------- */

  // 11 — exact amount match -> true
  {
    check('11 serverBudgetConfirmsUpdate exact match -> true', serverBudgetConfirmsUpdate(100000, bd({ amount: 100000 })) === true);
  }
  // 12 — different amount -> false (never a blind "id present" ack)
  {
    check('12 serverBudgetConfirmsUpdate amount mismatch -> false', serverBudgetConfirmsUpdate(200000, bd({ amount: 100000 })) === false);
  }

  /* ---------------- composeBudgetManagement (§6 items A–H) + data separation (§16–20) ---------------- */

  // 13 — item A: pending CREATE, no server row -> synthetic row in budgetManagement,
  // but data.budgets/data.budgetMeta stay UNTOUCHED (§16/§20).
  {
    const server = financeWith({}, {});
    const ops: PendingWrite[] = [makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 30000 }), queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops);
    check(
      '13 item A: pending CREATE -> synthetic budgetManagement row; data.budgets untouched',
      data.budgets === server.budgets && // reference-identical: composeFinance never rebuilds it
        Object.keys(data.budgets).length === 0 &&
        budgetManagement.rows.food === 30000 &&
        budgetManagement.syntheticIds.has('food') &&
        budgetManagement.opById.get('food') === 'create' &&
        !budgetManagement.failedIds.has('food'),
      JSON.stringify({ dataBudgets: data.budgets, bm: budgetManagement }),
    );
  }
  // 14 — item B: FAILED CREATE, no server row -> synthetic row marked failed; still not in data.budgets
  {
    const server = financeWith({}, {});
    const ops: PendingWrite[] = [makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 30000 }), queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops, undefined, undefined, undefined, new Set(['food']));
    check(
      '14 item B: FAILED CREATE, no server row -> synthetic + failed; data.budgets still empty',
      Object.keys(data.budgets).length === 0 &&
        budgetManagement.rows.food === 30000 &&
        budgetManagement.syntheticIds.has('food') &&
        budgetManagement.failedIds.has('food'),
      JSON.stringify(budgetManagement),
    );
  }
  // 15 — item C: CREATE became a TERMINAL conflict AND the natural-key slot is
  // now occupied by someone else's row (different amount) -> authoritative
  // server amount wins in `rows`; attempted amount is METADATA ONLY; NOT synthetic.
  {
    const server = financeWith({ food: 200000 }, { food: { updatedAt: 'SRV-V1', createdBy: 'u-B' } });
    const ops: PendingWrite[] = [makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 100000 }), queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops, undefined, undefined, undefined, new Set(['food']));
    check(
      '15 item C: failed CREATE conflict + server row exists -> authoritative amount wins, attempted is metadata only, not synthetic',
      data.budgets.food === 200000 &&
        budgetManagement.rows.food === 200000 && // NEVER replaced by the local 100000
        budgetManagement.attemptedAmountById.get('food') === 100000 &&
        budgetManagement.failedIds.has('food') &&
        !budgetManagement.syntheticIds.has('food'),
      JSON.stringify(budgetManagement),
    );
  }
  // 15b — same scenario but NOT-failed (still pending / awaiting ack): our own
  // create landed (response lost) -> no marker, authoritative row shown as-is.
  {
    const server = financeWith({ food: 100000 }, { food: { updatedAt: 'SRV-V1', createdBy: 'u-A' } });
    const ops: PendingWrite[] = [makePendingBudgetCreate({ scope: A, entityId: 'food', payload: bd({ amount: 100000 }), queueId: 'q1' })];
    const { budgetManagement } = composeFinance(server, ops); // no failed set
    check(
      '15b not-failed CREATE + server row already present (our own, response lost) -> no marker',
      budgetManagement.rows.food === 100000 && !budgetManagement.opById.has('food') && !budgetManagement.failedIds.has('food'),
      JSON.stringify(budgetManagement),
    );
  }
  // 16 — item D: pending (not-failed) UPDATE + server row exists -> management
  // view overlays the draft, but data.budgets/budgetMeta stay authoritative (§17/§20).
  {
    const server = financeWith({ food: 100000 }, { food: { updatedAt: 'V1', createdBy: 'u-A' } });
    const ops: PendingWrite[] = [makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 250000 }), expectedUpdatedAt: 'V1', queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops);
    check(
      '16 item D: pending UPDATE overlays budgetManagement only; data.budgets/budgetMeta untouched',
      data.budgets.food === 100000 &&
        data.budgetMeta === server.budgetMeta &&
        budgetManagement.rows.food === 250000 &&
        budgetManagement.opById.get('food') === 'update' &&
        !budgetManagement.failedIds.has('food'),
      JSON.stringify({ dataBudgets: data.budgets, bm: budgetManagement }),
    );
  }
  // 17/11 — item E: FAILED UPDATE + server row exists -> authoritative amount
  // wins verbatim; attempted amount is metadata ONLY; never synthetic; never
  // replaces the displayed row (the category A-edit/B-edit bug, NOT repeated).
  {
    const server = financeWith({ food: 999999 }, { food: { updatedAt: 'V2', createdBy: 'u-B' } }); // B already won
    const ops: PendingWrite[] = [makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 1 }), expectedUpdatedAt: 'V1', queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops, undefined, undefined, undefined, new Set(['food']));
    check(
      '17 item E: failed UPDATE + server row exists -> authoritative amount wins, attempted is metadata only',
      data.budgets.food === 999999 &&
        budgetManagement.rows.food === 999999 && // NEVER replaced by the stale local 1
        budgetManagement.attemptedAmountById.get('food') === 1 &&
        budgetManagement.failedIds.has('food') &&
        !budgetManagement.syntheticIds.has('food'),
      JSON.stringify(budgetManagement),
    );
  }
  // 18 — item F: FAILED UPDATE + server row GONE -> orphan synthetic display-only row
  {
    const server = financeWith({}, {});
    const ops: PendingWrite[] = [makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 42 }), expectedUpdatedAt: 'V1', queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops, undefined, undefined, undefined, new Set(['food']));
    check(
      '18 item F: failed UPDATE + server row gone -> synthetic orphan row, data.budgets stays empty',
      Object.keys(data.budgets).length === 0 &&
        budgetManagement.rows.food === 42 &&
        budgetManagement.syntheticIds.has('food') &&
        budgetManagement.failedIds.has('food') &&
        budgetManagement.attemptedAmountById.get('food') === 42,
      JSON.stringify(budgetManagement),
    );
  }
  // 18b — a NOT-failed UPDATE whose server row is missing just waits (no synthetic row at all)
  {
    const server = financeWith({}, {});
    const ops: PendingWrite[] = [makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 42 }), expectedUpdatedAt: 'V1', queueId: 'q1' })];
    const { budgetManagement } = composeFinance(server, ops); // no failed set
    check(
      '18b not-failed UPDATE + server row missing -> waits silently, no row at all',
      budgetManagement.rows.food === undefined && !budgetManagement.opById.has('food'),
      JSON.stringify(budgetManagement),
    );
  }
  // 19 — item G: pending (not-failed) DELETE -> hidden from budgetManagement,
  // but data.budgets is UNCHANGED (§18/§20 — never mutated by an offline op).
  {
    const server = financeWith({ food: 100000 }, { food: { updatedAt: 'V1', createdBy: 'u-A' } });
    const ops: PendingWrite[] = [makePendingBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'V1', queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops);
    check(
      '19 item G: pending DELETE hides the row in budgetManagement only; data.budgets untouched',
      data.budgets.food === 100000 &&
        budgetManagement.rows.food === undefined &&
        budgetManagement.hiddenIds.includes('food'),
      JSON.stringify({ dataBudgets: data.budgets, bm: budgetManagement }),
    );
  }
  // 20 — item H: FAILED DELETE -> authoritative row STAYS VISIBLE in
  // budgetManagement (failed marker only); data.budgets unchanged either way.
  {
    const server = financeWith({ food: 100000 }, { food: { updatedAt: 'V1', createdBy: 'u-A' } });
    const ops: PendingWrite[] = [makePendingBudgetDelete({ scope: A, entityId: 'food', expectedUpdatedAt: 'V1', queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops, undefined, undefined, undefined, new Set(['food']));
    check(
      '20 item H: failed DELETE -> authoritative row restored/visible, marked failed',
      data.budgets.food === 100000 &&
        budgetManagement.rows.food === 100000 &&
        budgetManagement.opById.get('food') === 'delete' &&
        budgetManagement.failedIds.has('food'),
      JSON.stringify(budgetManagement),
    );
  }
  // 22 — a mix that also has a TRANSACTION op still leaves budgets authoritative
  {
    const server = financeWith({ food: 100000 }, { food: { updatedAt: 'V1', createdBy: 'u-A' } });
    const ops: PendingWrite[] = [
      makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' }),
      makePendingBudgetUpdate({ scope: A, entityId: 'food', payload: bd({ amount: 500 }), expectedUpdatedAt: 'V1', queueId: 'q2' }),
    ];
    const { data, budgetManagement } = composeFinance(server, ops);
    check(
      '22 transaction op present -> data.budgets authoritative, only budgetManagement overlaid',
      data.budgets.food === 100000 &&
        budgetManagement.rows.food === 500 &&
        data.transactions.some((t) => t.id === 'txn-1'),
      '',
    );
  }
  // 23 — no budget ops at all -> budgetManagement.rows IS data.budgets (same reference)
  {
    const server = financeWith({ food: 100000 });
    const ops: PendingWrite[] = [makePendingTransactionCreate({ scope: A, entityId: 'txn-1', payload: td(), queueId: 'q1' })];
    const { data, budgetManagement } = composeFinance(server, ops);
    check(
      '23 no budget ops -> budgetManagement.rows === data.budgets (identity, no copy)',
      budgetManagement.rows === data.budgets,
      '',
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
