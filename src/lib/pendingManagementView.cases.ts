/**
 * Static verification for `buildPendingCategoryOps` / `buildPendingBudgetOps`
 * (src/lib/pendingManagementView.ts) — STEP 16-H2 A4.3. The glue that folds a
 * composite (`entity:'categoryBudget'`) delete's marker into the same per-row
 * offline-op map the CATEGORY / BUDGET management screens read, resolving its
 * `queueId` + failure `reason` from the composite queue. Plain data + runner.
 *
 * Key contracts checked:
 *   - a composite marker gets the COMPOSITE record's real durable `queueId`
 *     (never a fabricated one) + the composite failure reason;
 *   - the SAME composite `queueId` appears in BOTH the category and the
 *     budget map (discard-from-either-screen consistency);
 *   - a single-table op wins the lookup when it is the one backing the id
 *     (deterministic fallback for a malformed both-present state);
 *   - `synthetic` is always false for a composite;
 *   - single-table `attemptedName` / `attemptedAmount` still flow.
 */
import {
  makePendingBudgetDelete,
  makePendingBudgetUpdate,
  makePendingCategoryBudgetDelete,
  makePendingCategoryUpdate,
  type BudgetManagementView,
  type CategoryManagementView,
} from '@/lib/offlineQueue';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
import {
  buildPendingBudgetOps,
  buildPendingCategoryOps,
} from '@/lib/pendingManagementView';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const SCOPE = { userId: 'u1', householdId: 'h1' };

const catView = (over: Partial<CategoryManagementView> = {}): CategoryManagementView => ({
  rows: { expense: [], income: [] },
  opById: new Map(),
  failedIds: new Set(),
  hiddenIds: [],
  syntheticIds: new Set(),
  attemptedNameById: new Map(),
  ...over,
});
const budView = (over: Partial<BudgetManagementView> = {}): BudgetManagementView => ({
  rows: {},
  opById: new Map(),
  failedIds: new Set(),
  hiddenIds: [],
  syntheticIds: new Set(),
  attemptedAmountById: new Map(),
  ...over,
});

const cbd = (entityId: string, queueId: string) =>
  makePendingCategoryBudgetDelete({
    scope: SCOPE,
    entityId,
    expectedCategoryUpdatedAt: 'CT',
    expectedBudgetUpdatedAt: 'BT',
    queueId,
  });

const noReasons = new Map<string, WriteConflictReason | undefined>();

export async function runPendingManagementViewCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- category ---- */

  check('H1 composite FAILED -> category entry: op delete, failed, composite queueId + reason, not synthetic', (() => {
    const view = catView({ opById: new Map([['c-1', 'delete']]), failedIds: new Set(['c-1']) });
    const rec = cbd('c-1', 'Q-COMPOSITE');
    const out = buildPendingCategoryOps(
      view,
      [], // no single-table category op
      [rec],
      noReasons,
      new Map([['c-1', 'conflict']]),
    );
    const e = out.get('c-1');
    return (
      !!e &&
      e.op === 'delete' &&
      e.failed === true &&
      e.queueId === 'Q-COMPOSITE' &&
      e.reason === 'conflict' &&
      e.synthetic === false &&
      e.attemptedName === undefined
    );
  })());

  check('H4 composite PENDING (not failed) -> queueId present, NO reason key', (() => {
    const view = catView({ hiddenIds: ['c-1'] }); // not-failed delete -> no opById entry
    // a not-failed composite has no opById marker, so nothing to fold; the
    // map is empty and the row is simply hidden by `hiddenIds`.
    const out = buildPendingCategoryOps(view, [], [cbd('c-1', 'Q1')], noReasons, noReasons);
    return out.size === 0;
  })());

  check('H4b composite marker present but not failed -> queueId set, reason absent', (() => {
    // exercised when a screen surfaces a not-failed composite via opById
    // (defensive: the composer only sets opById on the failed branch, but the
    // helper must still behave if a caller passes such a view).
    const view = catView({ opById: new Map([['c-1', 'delete']]) }); // failedIds empty
    const out = buildPendingCategoryOps(view, [], [cbd('c-1', 'Q1')], noReasons, new Map([['c-1', 'conflict']]));
    const e = out.get('c-1');
    return !!e && e.failed === false && e.queueId === 'Q1' && !('reason' in e);
  })());

  check('H5 single-table category delete FAILED -> uses single-table queueId + single-table reason', (() => {
    const view = catView({ opById: new Map([['c-9', 'delete']]), failedIds: new Set(['c-9']) });
    const stDel = makePendingCategoryUpdate({
      scope: SCOPE,
      entityId: 'c-9',
      payload: { type: 'expense', name: 'x', icon: 'heart', bg: '#eeeeee', color: '#111111' },
      expectedUpdatedAt: 'V',
      queueId: 'Q-SINGLE',
    });
    const out = buildPendingCategoryOps(
      view,
      [stDel],
      [cbd('c-9', 'Q-COMPOSITE-SHOULD-NOT-WIN')],
      new Map([['c-9', 'gone']]),
      new Map([['c-9', 'conflict']]),
    );
    const e = out.get('c-9');
    return !!e && e.queueId === 'Q-SINGLE' && e.reason === 'gone';
  })());

  check('H6 malformed both-present -> single-table wins the queueId/reason (deterministic)', (() => {
    const view = catView({ opById: new Map([['c-1', 'delete']]), failedIds: new Set(['c-1']) });
    const st = makePendingCategoryUpdate({
      scope: SCOPE,
      entityId: 'c-1',
      payload: { type: 'expense', name: 'x', icon: 'heart', bg: '#eeeeee', color: '#111111' },
      expectedUpdatedAt: 'V',
      queueId: 'Q-ST',
    });
    const out = buildPendingCategoryOps(
      view,
      [st],
      [cbd('c-1', 'Q-CB')],
      new Map([['c-1', 'gone']]),
      new Map([['c-1', 'conflict']]),
    );
    const e = out.get('c-1');
    return !!e && e.queueId === 'Q-ST' && e.reason === 'gone';
  })());

  check('H8 single-table failed UPDATE still carries attemptedName', (() => {
    const view = catView({
      opById: new Map([['c-9', 'update']]),
      failedIds: new Set(['c-9']),
      attemptedNameById: new Map([['c-9', 'Tried Name']]),
    });
    const st = makePendingCategoryUpdate({
      scope: SCOPE,
      entityId: 'c-9',
      payload: { type: 'expense', name: 'Tried Name', icon: 'heart', bg: '#eeeeee', color: '#111111' },
      expectedUpdatedAt: 'V',
      queueId: 'Q-ST',
    });
    const out = buildPendingCategoryOps(view, [st], [], new Map([['c-9', 'conflict']]), noReasons);
    return out.get('c-9')?.attemptedName === 'Tried Name';
  })());

  /* ---- budget ---- */

  check('H2 composite FAILED -> budget entry mirrors category: op delete, composite queueId + reason', (() => {
    const view = budView({ opById: new Map([['c-1', 'delete']]), failedIds: new Set(['c-1']) });
    const out = buildPendingBudgetOps(
      view,
      [],
      [cbd('c-1', 'Q-COMPOSITE')],
      noReasons,
      new Map([['c-1', 'conflict']]),
    );
    const e = out.get('c-1');
    return !!e && e.op === 'delete' && e.failed && e.queueId === 'Q-COMPOSITE' && e.reason === 'conflict' && e.synthetic === false;
  })());

  check('H3 discard consistency: category map + budget map expose the SAME composite queueId', (() => {
    const rec = cbd('c-1', 'Q-SHARED');
    const cm = buildPendingCategoryOps(
      catView({ opById: new Map([['c-1', 'delete']]), failedIds: new Set(['c-1']) }),
      [],
      [rec],
      noReasons,
      new Map([['c-1', 'conflict']]),
    );
    const bm = buildPendingBudgetOps(
      budView({ opById: new Map([['c-1', 'delete']]), failedIds: new Set(['c-1']) }),
      [],
      [rec],
      noReasons,
      new Map([['c-1', 'conflict']]),
    );
    return cm.get('c-1')?.queueId === 'Q-SHARED' && bm.get('c-1')?.queueId === 'Q-SHARED';
  })());

  check('H7 not-failed -> no reason key in the budget entry', (() => {
    const view = budView({ opById: new Map([['c-1', 'delete']]) }); // failedIds empty
    const out = buildPendingBudgetOps(view, [], [cbd('c-1', 'Q1')], noReasons, new Map([['c-1', 'conflict']]));
    const e = out.get('c-1');
    return !!e && e.failed === false && !('reason' in e) && e.queueId === 'Q1';
  })());

  check('H9 single-table failed budget UPDATE still carries attemptedAmount', (() => {
    const view = budView({
      opById: new Map([['c-9', 'update']]),
      failedIds: new Set(['c-9']),
      attemptedAmountById: new Map([['c-9', 12345]]),
    });
    const st = makePendingBudgetUpdate({
      scope: SCOPE,
      entityId: 'c-9',
      payload: { category: 'c-9', amount: 12345 },
      expectedUpdatedAt: 'V',
      queueId: 'Q-ST',
    });
    const out = buildPendingBudgetOps(view, [st], [], new Map([['c-9', 'conflict']]), noReasons);
    return out.get('c-9')?.attemptedAmount === 12345;
  })());

  check('H10 single-table budget delete wins over a stray composite for the same id', (() => {
    const view = budView({ opById: new Map([['c-1', 'delete']]), failedIds: new Set(['c-1']) });
    const st = makePendingBudgetDelete({ scope: SCOPE, entityId: 'c-1', expectedUpdatedAt: 'V', queueId: 'Q-ST' });
    const out = buildPendingBudgetOps(
      view,
      [st],
      [cbd('c-1', 'Q-CB')],
      new Map([['c-1', 'gone']]),
      new Map([['c-1', 'conflict']]),
    );
    return out.get('c-1')?.queueId === 'Q-ST' && out.get('c-1')?.reason === 'gone';
  })());

  check('H11 empty view -> empty map', (() =>
    buildPendingCategoryOps(catView(), [], [], noReasons, noReasons).size === 0 &&
    buildPendingBudgetOps(budView(), [], [], noReasons, noReasons).size === 0)());

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
