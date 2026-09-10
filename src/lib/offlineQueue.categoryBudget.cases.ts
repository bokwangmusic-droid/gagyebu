/**
 * Static verification for the composite category+budget delete queue
 * variant — STEP 16-H2 A4.1 (pure core) + A4.3 (read-model projection).
 * Plain data + runner, same convention as the other offlineQueue.*.cases.ts
 * files.
 *
 * A4.1 core:
 *   - `PendingCategoryBudgetDelete` shape / `validatePendingWrite` /
 *     `makePendingCategoryBudgetDelete` / `sameRequest` / dedup-key isolation
 * A4.3 projection (via `composeFinance` -> `categoryManagement` /
 * `budgetManagement`):
 *   - pending composite -> management row hidden on BOTH screens
 *   - terminal-failed composite -> authoritative row restored + `op:'delete'`
 *     marker + `failedIds`, never synthetic
 *   - NO synthetic budget row is ever invented (incl. `expectedBudgetUpdatedAt:
 *     null`)
 *   - `data.customCats` / `data.budgets` / aggregates untouched
 *   - single-table category/budget/card/txn projections unchanged
 */
import {
  QUEUE_SCHEMA_VERSION,
  composeFinance,
  enqueuePendingWrite,
  makePendingBudgetCreate,
  makePendingBudgetDelete,
  makePendingBudgetUpdate,
  makePendingCardCreate,
  makePendingCategoryBudgetDelete,
  makePendingCategoryCreate,
  makePendingCategoryDelete,
  makePendingCategoryUpdate,
  makePendingTransactionCreate,
  validatePendingWrite,
  type PendingWrite,
} from '@/lib/offlineQueue';
import { DEFAULT_CAT_ORDER, type Category } from '@/data/categories';
import type { RemoteFinanceData } from '@/lib/remoteFinanceMapping';
import type { BudgetMap } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const SCOPE = { userId: 'u1', householdId: 'h1' };
const roundTrip = (r: unknown): unknown => JSON.parse(JSON.stringify(r));

/** A structurally-valid raw composite-delete record (as it would sit in storage). */
const validRaw = () => ({
  queueId: 'q-1',
  schemaVersion: QUEUE_SCHEMA_VERSION,
  scope: { userId: 'u1', householdId: 'h1' },
  entity: 'categoryBudget',
  op: 'delete',
  entityId: 'c-1',
  enqueuedAt: '2026-09-10T00:00:00.000Z',
  attemptCount: 0,
  expectedCategoryUpdatedAt: '2026-09-01T00:00:00.000Z',
  expectedBudgetUpdatedAt: '2026-09-02T00:00:00.000Z',
});

export async function runOfflineQueueCategoryBudgetCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ------------------------- validator: accept ------------------------- */

  check('CASE 1 valid record — budget token string -> validates', (() => {
    const v = validatePendingWrite(validRaw());
    return (
      !!v &&
      v.entity === 'categoryBudget' &&
      v.op === 'delete' &&
      v.entityId === 'c-1' &&
      (v as { expectedCategoryUpdatedAt: string }).expectedCategoryUpdatedAt ===
        '2026-09-01T00:00:00.000Z' &&
      (v as { expectedBudgetUpdatedAt: string | null }).expectedBudgetUpdatedAt ===
        '2026-09-02T00:00:00.000Z'
    );
  })());

  check('CASE 2 valid record — budget token null -> validates, null preserved', (() => {
    const v = validatePendingWrite({ ...validRaw(), expectedBudgetUpdatedAt: null });
    return (
      !!v &&
      v.entity === 'categoryBudget' &&
      (v as { expectedBudgetUpdatedAt: string | null }).expectedBudgetUpdatedAt === null
    );
  })());

  /* ------------------------- validator: reject ------------------------- */

  check('CASE 3 expectedBudgetUpdatedAt KEY MISSING -> reject (malformed, not null)', (() => {
    const raw = validRaw() as Record<string, unknown>;
    delete raw.expectedBudgetUpdatedAt;
    return validatePendingWrite(raw) === null;
  })());

  check('CASE 4 expectedCategoryUpdatedAt missing -> reject', (() => {
    const raw = validRaw() as Record<string, unknown>;
    delete raw.expectedCategoryUpdatedAt;
    return validatePendingWrite(raw) === null;
  })());

  check(
    'CASE 5 expectedCategoryUpdatedAt empty string -> reject',
    validatePendingWrite({ ...validRaw(), expectedCategoryUpdatedAt: '' }) === null,
  );

  check(
    'CASE 6 expectedBudgetUpdatedAt empty string -> reject',
    validatePendingWrite({ ...validRaw(), expectedBudgetUpdatedAt: '' }) === null,
  );

  check(
    'CASE 7 expectedBudgetUpdatedAt wrong type (number/bool/object) -> reject',
    validatePendingWrite({ ...validRaw(), expectedBudgetUpdatedAt: 123 }) === null &&
      validatePendingWrite({ ...validRaw(), expectedBudgetUpdatedAt: false }) === null &&
      validatePendingWrite({ ...validRaw(), expectedBudgetUpdatedAt: {} }) === null,
  );

  check(
    'CASE 8 payload present -> reject',
    validatePendingWrite({ ...validRaw(), payload: { amount: 1 } }) === null,
  );

  check(
    'CASE 9 top-level expectedUpdatedAt present -> reject',
    validatePendingWrite({ ...validRaw(), expectedUpdatedAt: '2026-09-03T00:00:00.000Z' }) === null,
  );

  check('CASE 10 op=create -> reject', validatePendingWrite({ ...validRaw(), op: 'create' }) === null);
  check('CASE 11 op=update -> reject', validatePendingWrite({ ...validRaw(), op: 'update' }) === null);

  check(
    'CASE 12 wrong schemaVersion -> reject',
    validatePendingWrite({ ...validRaw(), schemaVersion: 2 }) === null,
  );

  check(
    'CASE 12b entityId empty -> reject',
    validatePendingWrite({ ...validRaw(), entityId: '' }) === null,
  );

  check(
    'CASE 12c validated record carries NO payload / NO base expectedUpdatedAt key',
    (() => {
      const v = validatePendingWrite(validRaw()) as Record<string, unknown> | null;
      return !!v && !('payload' in v) && !('expectedUpdatedAt' in v);
    })(),
  );

  /* --------------------------- maker --------------------------- */

  check('CASE 13 maker produces the exact shape', (() => {
    const r = makePendingCategoryBudgetDelete({
      scope: SCOPE,
      entityId: 'c-9',
      expectedCategoryUpdatedAt: 'CT',
      expectedBudgetUpdatedAt: 'BT',
      now: () => '2026-09-10T12:00:00.000Z',
    });
    return (
      r.entity === 'categoryBudget' &&
      r.op === 'delete' &&
      r.entityId === 'c-9' &&
      r.expectedCategoryUpdatedAt === 'CT' &&
      r.expectedBudgetUpdatedAt === 'BT' &&
      r.schemaVersion === QUEUE_SCHEMA_VERSION &&
      r.attemptCount === 0 &&
      r.enqueuedAt === '2026-09-10T12:00:00.000Z' &&
      typeof r.queueId === 'string' &&
      r.queueId.length > 0 &&
      r.scope.userId === 'u1' &&
      r.scope.householdId === 'h1' &&
      !('payload' in r) &&
      !('expectedUpdatedAt' in r)
    );
  })());

  check('CASE 14 maker preserves an explicit null budget token + round-trips through validate', (() => {
    const r = makePendingCategoryBudgetDelete({
      scope: SCOPE,
      entityId: 'c-10',
      expectedCategoryUpdatedAt: 'CT',
      expectedBudgetUpdatedAt: null,
      queueId: 'q-mk',
    });
    if (!('expectedBudgetUpdatedAt' in r) || r.expectedBudgetUpdatedAt !== null) return false;
    const v = validatePendingWrite(roundTrip(r));
    return (
      !!v &&
      v.entity === 'categoryBudget' &&
      (v as { expectedBudgetUpdatedAt: string | null }).expectedBudgetUpdatedAt === null
    );
  })());

  check('CASE 14b maker (string budget token) round-trips through validate', (() => {
    const r = makePendingCategoryBudgetDelete({
      scope: SCOPE,
      entityId: 'c-11',
      expectedCategoryUpdatedAt: 'CT',
      expectedBudgetUpdatedAt: 'BT',
    });
    return validatePendingWrite(roundTrip(r)) !== null;
  })());

  /* -------------- sameRequest / dedup via enqueuePendingWrite -------------- */

  const mk = (over: Partial<{ catTok: string; budTok: string | null; queueId: string; entityId: string }>) =>
    makePendingCategoryBudgetDelete({
      scope: SCOPE,
      entityId: over.entityId ?? 'c-1',
      expectedCategoryUpdatedAt: over.catTok ?? 'CT',
      expectedBudgetUpdatedAt: over.budTok === undefined ? 'BT' : over.budTok,
      queueId: over.queueId ?? 'q-a',
    });

  const seeded = enqueuePendingWrite([], mk({ queueId: 'q-a' }));

  check('CASE 15 same identity + BOTH tokens equal (diff queueId) -> idempotent dedup', (() => {
    const r = enqueuePendingWrite(seeded.queue, mk({ queueId: 'q-b' }));
    return r.ok && r.deduped === true && r.queue.length === 1 && r.record === seeded.queue[0];
  })());

  check('CASE 16 category token differs -> existing-pending (never overwritten)', (() => {
    const r = enqueuePendingWrite(seeded.queue, mk({ queueId: 'q-c', catTok: 'CT-DIFF' }));
    return !r.ok && r.reason === 'existing-pending' && r.queue.length === 1;
  })());

  check('CASE 17 budget token differs -> existing-pending', (() => {
    const r = enqueuePendingWrite(seeded.queue, mk({ queueId: 'q-d', budTok: 'BT-DIFF' }));
    return !r.ok && r.reason === 'existing-pending';
  })());

  check('CASE 18 null vs string budget token -> existing-pending (different request)', (() => {
    const r = enqueuePendingWrite(seeded.queue, mk({ queueId: 'q-e', budTok: null }));
    return !r.ok && r.reason === 'existing-pending';
  })());

  check('CASE 18b null vs null budget token -> idempotent dedup', (() => {
    const q = enqueuePendingWrite([], mk({ queueId: 'q-n1', budTok: null }));
    const r = enqueuePendingWrite(q.queue, mk({ queueId: 'q-n2', budTok: null }));
    return r.ok && r.deduped === true && r.queue.length === 1;
  })());

  check('CASE 19 exact same queueId re-enqueue -> idempotent no-op', (() => {
    const r = enqueuePendingWrite(seeded.queue, mk({ queueId: 'q-a' }));
    return r.ok && r.deduped === true && r.queue.length === 1;
  })());

  check('CASE 20 same dedup key + different frozen token -> existing-pending (standard semantics)', (() => {
    const r = enqueuePendingWrite(seeded.queue, mk({ queueId: 'q-z', catTok: 'X', budTok: 'Y' }));
    return !r.ok && r.reason === 'existing-pending';
  })());

  /* -------------- dedup-key isolation from category / budget -------------- */

  check('CASE 21/22 categoryBudget|delete|c-1 does NOT collide with category|delete|c-1 or budget|delete|c-1', (() => {
    let q = enqueuePendingWrite([], mk({ queueId: 'q-cbd', entityId: 'c-1' })).queue; // [cbd]
    const e2 = enqueuePendingWrite(
      q,
      makePendingCategoryDelete({ scope: SCOPE, entityId: 'c-1', expectedUpdatedAt: 'CAT-TOK', queueId: 'q-cd' }),
    );
    if (!e2.ok || e2.deduped || e2.queue.length !== 2) return false;
    q = e2.queue; // [cbd, category-delete]
    const e3 = enqueuePendingWrite(
      q,
      makePendingBudgetDelete({ scope: SCOPE, entityId: 'c-1', expectedUpdatedAt: 'BUD-TOK', queueId: 'q-bd' }),
    );
    if (!e3.ok || e3.deduped || e3.queue.length !== 3) return false;
    q = e3.queue; // [cbd, category-delete, budget-delete]
    // the composite record's own key is still stable & distinct -> re-enqueue dedups
    const e4 = enqueuePendingWrite(q, mk({ queueId: 'q-cbd-2', entityId: 'c-1' }));
    return e4.ok && e4.deduped === true && e4.queue.length === 3;
  })());

  /* -------------- existing variants regress unchanged -------------- */

  check('CASE 23 pre-existing transaction CREATE record still validates', (() => {
    const r = makePendingTransactionCreate({
      scope: SCOPE,
      entityId: 'txn-1',
      payload: { type: 'expense', category: 'food', amount: 1000, memo: '', date: '2026-09-10' },
    });
    return validatePendingWrite(roundTrip(r)) !== null;
  })());

  check('CASE 24 pre-existing card CREATE record still validates', (() => {
    const r = makePendingCardCreate({ scope: SCOPE, entityId: 'card-1', payload: { name: 'Visa' } });
    return validatePendingWrite(roundTrip(r)) !== null;
  })());

  check('CASE 25 pre-existing category CREATE record still validates', (() => {
    const r = makePendingCategoryCreate({
      scope: SCOPE,
      entityId: 'c-x',
      payload: { type: 'expense', name: 'Pets', icon: 'heart', bg: '#eeeeee', color: '#111111' },
    });
    return validatePendingWrite(roundTrip(r)) !== null;
  })());

  check('CASE 26 pre-existing single-table category DELETE record still validates', (() => {
    const r = makePendingCategoryDelete({ scope: SCOPE, entityId: 'c-y', expectedUpdatedAt: 'TOK' });
    const v = validatePendingWrite(roundTrip(r));
    return !!v && v.entity === 'category' && v.op === 'delete';
  })());

  check('CASE 27 pre-existing budget CREATE record still validates', (() => {
    const r = makePendingBudgetCreate({
      scope: SCOPE,
      entityId: 'c-1',
      payload: { category: 'c-1', amount: 50000 },
    });
    return validatePendingWrite(roundTrip(r)) !== null;
  })());

  check('CASE 28 pre-existing single-table budget DELETE record still validates', (() => {
    const r = makePendingBudgetDelete({ scope: SCOPE, entityId: 'c-1', expectedUpdatedAt: 'TOK' });
    const v = validatePendingWrite(roundTrip(r));
    return !!v && v.entity === 'budget' && v.op === 'delete';
  })());

  check('CASE 29 the new variant is assignable to PendingWrite (compile + runtime tag)', (() => {
    const w: PendingWrite = makePendingCategoryBudgetDelete({
      scope: SCOPE,
      entityId: 'c-1',
      expectedCategoryUpdatedAt: 'CT',
      expectedBudgetUpdatedAt: null,
    });
    return w.entity === 'categoryBudget' && w.op === 'delete';
  })());

  /* ============ STEP 16-H2 A4.3 — read-model projection ============ */

  const srvCat = (id: string): Category => ({
    id,
    name: id,
    bg: '#eeeeee',
    color: '#111111',
    icon: 'heart',
    custom: true,
  });
  function financeWith(o: {
    expense?: Category[];
    budgets?: BudgetMap;
  }): RemoteFinanceData {
    const expense = o.expense ?? [];
    return {
      transactions: [],
      transactionMeta: {},
      cards: [],
      cardMeta: {},
      budgets: o.budgets ?? {},
      budgetMeta: {},
      categoryMeta: Object.fromEntries(
        expense.map((c) => [c.id, { updatedAt: 'SRV-V1', createdBy: 'u-A' }]),
      ),
      recurring: [],
      recurringMeta: {},
      planned: [],
      plannedMeta: {},
      goals: [],
      goalMeta: {},
      loans: [],
      loanMeta: {},
      loanPaymentMeta: {},
      customCats: { expense, income: [] },
      notes: '',
      catOrder: DEFAULT_CAT_ORDER,
    };
  }
  const cbdOp = (entityId: string, budTok: string | null = 'BT', queueId = 'q-p') =>
    makePendingCategoryBudgetDelete({
      scope: SCOPE,
      entityId,
      expectedCategoryUpdatedAt: 'CT',
      expectedBudgetUpdatedAt: budTok,
      queueId,
    });
  /** composeFinance(server, ops, _, _, _, _, failedCategoryBudgetIds) */
  const FCB = (...ids: string[]) => new Set(ids);

  // --- Category management ---

  check('P1 pending composite + server category -> category row hidden, not marked', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-2')] });
    const { categoryManagement: cm } = composeFinance(server, [cbdOp('c-1')]);
    return (
      !cm.rows.expense.some((c) => c.id === 'c-1') &&
      cm.rows.expense.some((c) => c.id === 'c-2') &&
      cm.hiddenIds.includes('c-1') &&
      !cm.opById.has('c-1') &&
      !cm.syntheticIds.has('c-1')
    );
  })());

  check('P2/P3 failed composite + server category -> row restored + opById "delete" + failedIds', (() => {
    const server = financeWith({ expense: [srvCat('c-1')] });
    const { categoryManagement: cm } = composeFinance(
      server,
      [cbdOp('c-1')],
      undefined,
      undefined,
      undefined,
      undefined,
      FCB('c-1'),
    );
    return (
      cm.rows.expense.some((c) => c.id === 'c-1') &&
      cm.opById.get('c-1') === 'delete' &&
      cm.failedIds.has('c-1') &&
      !cm.hiddenIds.includes('c-1') &&
      !cm.syntheticIds.has('c-1')
    );
  })());

  check('P6/P7 composite (pending OR failed) never mutates data.customCats', (() => {
    const server = financeWith({ expense: [srvCat('c-1')] });
    const pend = composeFinance(server, [cbdOp('c-1')]);
    const fail = composeFinance(server, [cbdOp('c-1')], undefined, undefined, undefined, undefined, FCB('c-1'));
    return (
      pend.data === server && // no txn ops -> same authoritative reference
      fail.data === server &&
      server.customCats.expense.some((c) => c.id === 'c-1')
    );
  })());

  // --- Budget management ---

  check('P8 pending composite + server budget -> budget row hidden', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: { 'c-1': 50000, 'c-2': 9000 } });
    const { budgetManagement: bm } = composeFinance(server, [cbdOp('c-1')]);
    return (
      !Object.prototype.hasOwnProperty.call(bm.rows, 'c-1') &&
      bm.rows['c-2'] === 9000 &&
      bm.hiddenIds.includes('c-1') &&
      !bm.opById.has('c-1')
    );
  })());

  check('P9 pending composite + NO server budget -> no synthetic row, no marker', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: {} });
    const { budgetManagement: bm } = composeFinance(server, [cbdOp('c-1')]);
    return (
      Object.keys(bm.rows).length === 0 &&
      bm.hiddenIds.length === 0 &&
      bm.opById.size === 0 &&
      bm.syntheticIds.size === 0 &&
      bm.failedIds.size === 0
    );
  })());

  check('P10/P11 failed composite + server budget -> amount restored + opById "delete" + failedIds', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: { 'c-1': 77000 } });
    const { budgetManagement: bm } = composeFinance(
      server,
      [cbdOp('c-1')],
      undefined,
      undefined,
      undefined,
      undefined,
      FCB('c-1'),
    );
    return (
      bm.rows['c-1'] === 77000 &&
      bm.opById.get('c-1') === 'delete' &&
      bm.failedIds.has('c-1') &&
      !bm.hiddenIds.includes('c-1') &&
      !bm.syntheticIds.has('c-1')
    );
  })());

  check('P14 failed composite + NO server budget -> still no synthetic row / marker', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: {} });
    const { budgetManagement: bm } = composeFinance(
      server,
      [cbdOp('c-1')],
      undefined,
      undefined,
      undefined,
      undefined,
      FCB('c-1'),
    );
    return bm.opById.size === 0 && bm.failedIds.size === 0 && bm.syntheticIds.size === 0 && Object.keys(bm.rows).length === 0;
  })());

  // --- null budget token ---

  check('P15 expectedBudgetUpdatedAt=null + no server budget -> no budget marker/synthetic', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: {} });
    const { budgetManagement: bm } = composeFinance(server, [cbdOp('c-1', null)]);
    return bm.opById.size === 0 && bm.syntheticIds.size === 0 && bm.hiddenIds.length === 0;
  })());

  check('P16 expectedBudgetUpdatedAt=null + server budget exists -> mgmt hides it, data.budgets authoritative', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: { 'c-1': 33000 } });
    const res = composeFinance(server, [cbdOp('c-1', null)]);
    return (
      res.budgetManagement.hiddenIds.includes('c-1') &&
      !Object.prototype.hasOwnProperty.call(res.budgetManagement.rows, 'c-1') &&
      res.data.budgets['c-1'] === 33000 && // authoritative aggregate untouched
      res.data === server
    );
  })());

  check('P17 terminal conflict (null token) + authoritative budget -> restored + failed marker', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: { 'c-1': 41000 } });
    const { budgetManagement: bm } = composeFinance(
      server,
      [cbdOp('c-1', null)],
      undefined,
      undefined,
      undefined,
      undefined,
      FCB('c-1'),
    );
    return bm.rows['c-1'] === 41000 && bm.opById.get('c-1') === 'delete' && bm.failedIds.has('c-1');
  })());

  // --- aggregate invariants ---

  check('P18/P20 composite (pending OR failed) never mutates data.budgets', (() => {
    const server = financeWith({ expense: [srvCat('c-1')], budgets: { 'c-1': 60000 } });
    const pend = composeFinance(server, [cbdOp('c-1')]);
    const fail = composeFinance(server, [cbdOp('c-1')], undefined, undefined, undefined, undefined, FCB('c-1'));
    return (
      pend.data.budgets === server.budgets &&
      fail.data.budgets === server.budgets &&
      server.budgets['c-1'] === 60000
    );
  })());

  check('P21 unrelated budget categories unchanged by a composite delete', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-2')], budgets: { 'c-1': 10000, 'c-2': 20000 } });
    const { budgetManagement: bm } = composeFinance(server, [cbdOp('c-1')]);
    return bm.rows['c-2'] === 20000 && !Object.prototype.hasOwnProperty.call(bm.rows, 'c-1');
  })());

  // --- isolation ---

  check('P22 a composite delete for one id leaves other category rows alone', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-2')] });
    const { categoryManagement: cm } = composeFinance(server, [cbdOp('c-1')]);
    return cm.rows.expense.some((c) => c.id === 'c-2') && !cm.rows.expense.some((c) => c.id === 'c-1');
  })());

  check('P23 single-table PendingCategoryDelete projection is unchanged alongside a composite', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-9')] });
    const stDel = makePendingCategoryDelete({ scope: SCOPE, entityId: 'c-9', expectedUpdatedAt: 'V', queueId: 'q-st' });
    // c-9 failed single-table delete, c-1 pending composite delete
    const { categoryManagement: cm } = composeFinance(
      server,
      [stDel, cbdOp('c-1')],
      undefined,
      undefined,
      new Set(['c-9']), // failedCategoryIds
      undefined,
      undefined,
    );
    return (
      cm.opById.get('c-9') === 'delete' &&
      cm.failedIds.has('c-9') &&
      cm.rows.expense.some((c) => c.id === 'c-9') && // failed single-table -> stays visible
      cm.hiddenIds.includes('c-1') && // composite pending -> hidden
      !cm.opById.has('c-1')
    );
  })());

  check('P24 single-table PendingBudgetDelete projection is unchanged alongside a composite', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-9')], budgets: { 'c-1': 5000, 'c-9': 8000 } });
    const stDel = makePendingBudgetDelete({ scope: SCOPE, entityId: 'c-9', expectedUpdatedAt: 'V', queueId: 'q-st' });
    const { budgetManagement: bm } = composeFinance(
      server,
      [stDel, cbdOp('c-1')],
      undefined,
      undefined,
      undefined,
      new Set(['c-9']), // failedBudgetIds
      undefined,
    );
    return (
      bm.opById.get('c-9') === 'delete' &&
      bm.failedIds.has('c-9') &&
      bm.rows['c-9'] === 8000 &&
      bm.hiddenIds.includes('c-1') &&
      !Object.prototype.hasOwnProperty.call(bm.rows, 'c-1')
    );
  })());

  check('P25 a normal category UPDATE still overlays alongside a composite delete', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-9')] });
    const upd = makePendingCategoryUpdate({
      scope: SCOPE,
      entityId: 'c-9',
      payload: { type: 'expense', name: 'Renamed', icon: 'heart', bg: '#eeeeee', color: '#111111' },
      expectedUpdatedAt: 'V',
      queueId: 'q-u',
    });
    const { categoryManagement: cm } = composeFinance(server, [upd, cbdOp('c-1')]);
    return (
      cm.rows.expense.find((c) => c.id === 'c-9')?.name === 'Renamed' &&
      cm.hiddenIds.includes('c-1')
    );
  })());

  check('P26 a normal budget UPDATE still overlays alongside a composite delete', (() => {
    const server = financeWith({ expense: [srvCat('c-1'), srvCat('c-9')], budgets: { 'c-1': 5000, 'c-9': 8000 } });
    const upd = makePendingBudgetUpdate({
      scope: SCOPE,
      entityId: 'c-9',
      payload: { category: 'c-9', amount: 99999 },
      expectedUpdatedAt: 'V',
      queueId: 'q-u',
    });
    const { budgetManagement: bm } = composeFinance(server, [upd, cbdOp('c-1')]);
    return bm.rows['c-9'] === 99999 && !Object.prototype.hasOwnProperty.call(bm.rows, 'c-1');
  })());

  check('P27 card + transaction projections are untouched by a composite delete', (() => {
    const server = financeWith({ expense: [srvCat('c-1')] });
    const res = composeFinance(server, [cbdOp('c-1')]);
    return (
      res.cardManagement.rows.length === 0 &&
      res.cardManagement.opById.size === 0 &&
      res.data.transactions === server.transactions &&
      res.pendingIds.length === 0
    );
  })());

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
