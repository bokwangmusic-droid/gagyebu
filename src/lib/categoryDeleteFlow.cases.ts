/**
 * Static verification for `gateCategoryDelete` + `categoryDeleteFailureToast`
 * (src/lib/categoryDeleteFlow.ts) — STEP 16-H2 A3 ONLINE UI WIRING.
 *
 * Plain data + runner, same convention as the other *.cases.ts files. No
 * React renderer: the /categories delete branching is a pure function of
 * already-resolved primitives, cased here so app/categories.tsx stays a
 * thin caller.
 */
import {
  CATEGORY_DELETE_MSG,
  categoryDeleteFailureToast,
  gateCategoryDelete,
  type CategoryDeleteGateInput,
} from '@/lib/categoryDeleteFlow';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** a fully-passing gate input — every case overrides just the fields it tests. */
const OK: CategoryDeleteGateInput = {
  canDelete: true,
  deleting: false,
  categoryRowPending: false,
  budgetOpPending: false,
  categoryToken: 'CAT-T1',
  hasLiveBudget: false,
  budgetToken: null,
};

export async function runCategoryDeleteFlowCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ------------------------- gateCategoryDelete ------------------------- */

  // --- silent no-ops: proceed:false with NO toast ---
  check(
    'CASE 1 capability off -> silent no-op',
    (() => {
      const g = gateCategoryDelete({ ...OK, canDelete: false });
      return g.proceed === false && g.toast === null;
    })(),
  );
  check(
    'CASE 2 a delete already running -> silent no-op',
    (() => {
      const g = gateCategoryDelete({ ...OK, deleting: true });
      return g.proceed === false && g.toast === null;
    })(),
  );
  check(
    'CASE 3 category row carries its own pending op -> silent no-op',
    (() => {
      const g = gateCategoryDelete({ ...OK, categoryRowPending: true });
      return g.proceed === false && g.toast === null;
    })(),
  );

  // --- §9 pending BUDGET op guard ---
  check(
    'CASE 4 pending/failed budget op for this category -> blocked with §9 toast',
    (() => {
      const g = gateCategoryDelete({ ...OK, budgetOpPending: true });
      return g.proceed === false && g.toast === CATEGORY_DELETE_MSG.budgetOpInFlight;
    })(),
  );

  // --- §11 frozen-token completeness ---
  check(
    'CASE 5 category token missing -> blocked, "reload category" toast',
    (() => {
      const g = gateCategoryDelete({ ...OK, categoryToken: null });
      return g.proceed === false && g.toast === CATEGORY_DELETE_MSG.needCategoryReload;
    })(),
  );
  check(
    'CASE 6 live budget but no budget token -> blocked, "reload budget" toast',
    (() => {
      const g = gateCategoryDelete({ ...OK, hasLiveBudget: true, budgetToken: null });
      return g.proceed === false && g.toast === CATEGORY_DELETE_MSG.needBudgetReload;
    })(),
  );

  // --- proceed paths: frozen tokens forwarded verbatim ---
  check(
    'CASE 7 no live budget -> proceed, budgetToken forced null',
    (() => {
      const g = gateCategoryDelete({ ...OK, categoryToken: 'CAT-T7' });
      return g.proceed === true && g.categoryToken === 'CAT-T7' && g.budgetToken === null;
    })(),
  );
  check(
    'CASE 8 live budget with token -> proceed, BOTH frozen tokens forwarded',
    (() => {
      const g = gateCategoryDelete({
        ...OK,
        categoryToken: 'CAT-T8',
        hasLiveBudget: true,
        budgetToken: 'BUD-T8',
      });
      return g.proceed === true && g.categoryToken === 'CAT-T8' && g.budgetToken === 'BUD-T8';
    })(),
  );
  check(
    'CASE 9 §10 no-live-budget intent: a stray budgetToken is dropped, RPC gets null',
    (() => {
      const g = gateCategoryDelete({
        ...OK,
        categoryToken: 'CAT-T9',
        hasLiveBudget: false,
        budgetToken: 'BUD-STRAY',
      });
      return g.proceed === true && g.budgetToken === null;
    })(),
  );

  // --- gate ORDER (first failing gate wins) ---
  check(
    'CASE 10 §9 budget-op guard is checked BEFORE the token gates',
    (() => {
      const g = gateCategoryDelete({ ...OK, budgetOpPending: true, categoryToken: null });
      return g.proceed === false && g.toast === CATEGORY_DELETE_MSG.budgetOpInFlight;
    })(),
  );
  check(
    'CASE 11 a silent no-op is checked BEFORE the §9 budget-op guard',
    (() => {
      const g = gateCategoryDelete({ ...OK, canDelete: false, budgetOpPending: true });
      return g.proceed === false && g.toast === null;
    })(),
  );

  /* --------------------- categoryDeleteFailureToast -------------------- */

  check(
    'CASE 12 transport failure -> "check your connection", never offline-success',
    categoryDeleteFailureToast({ reason: 'error', message: 'x', transport: true }) ===
      CATEGORY_DELETE_MSG.transport,
  );
  check(
    'CASE 13 conflict -> unified "changed on another device" copy',
    categoryDeleteFailureToast({ reason: 'conflict', message: 'x' }) === CATEGORY_DELETE_MSG.conflict,
  );
  check(
    'CASE 14 gone -> "category not found" copy',
    categoryDeleteFailureToast({ reason: 'gone', message: 'x' }) === CATEGORY_DELETE_MSG.gone,
  );
  check(
    'CASE 15 identity -> the service message passes through verbatim',
    categoryDeleteFailureToast({ reason: 'identity', message: '로그인 정보가 변경됐어요. 다시 시도해 주세요.' }) ===
      '로그인 정보가 변경됐어요. 다시 시도해 주세요.',
  );
  check(
    'CASE 16 generic error (no transport) -> the service message passes through verbatim',
    categoryDeleteFailureToast({ reason: 'error', message: '카테고리를 삭제하지 못했어요. 잠시 후 다시 시도해주세요.' }) ===
      '카테고리를 삭제하지 못했어요. 잠시 후 다시 시도해주세요.',
  );
  check(
    'CASE 17 transport:true wins even if a reason is also present',
    categoryDeleteFailureToast({ reason: 'conflict', message: 'x', transport: true }) ===
      CATEGORY_DELETE_MSG.transport,
  );
  check(
    'CASE 18 no partial-success string is ever produced',
    (() => {
      const all = [
        categoryDeleteFailureToast({ reason: 'error', message: 'a', transport: true }),
        categoryDeleteFailureToast({ reason: 'conflict', message: 'b' }),
        categoryDeleteFailureToast({ reason: 'gone', message: 'c' }),
        categoryDeleteFailureToast({ reason: 'identity', message: 'd' }),
        categoryDeleteFailureToast({ reason: 'error', message: 'e' }),
      ];
      return all.every((m) => !m.includes('예산 정리에 실패'));
    })(),
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
