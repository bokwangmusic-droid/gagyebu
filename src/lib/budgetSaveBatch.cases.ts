/**
 * Static verification for the Budget batch-save algorithm —
 * STEP 16-H2-C2-BUDGET A2 §4/§22 (BATCH cases 1-6). Pure; no React, no
 * Supabase. Every dependency is a scriptable fake.
 */
import {
  runBudgetSaveBatch,
  type BudgetItemEnqueueResult,
  type BudgetItemWriteResult,
  type BudgetSavePlanItem,
  type RunBudgetSaveBatchDeps,
} from '@/lib/budgetSaveBatch';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const item = (over: Partial<BudgetSavePlanItem> = {}): BudgetSavePlanItem => ({
  categoryId: 'food',
  amount: 10000,
  op: 'create',
  expectedUpdatedAt: null,
  ...over,
});

const CAPS_ON = { budgetCreate: true, budgetEdit: true };
const OK: BudgetItemWriteResult = { ok: true };
const TRANSPORT: BudgetItemWriteResult = { ok: false, message: 'net', transport: true };
const CONFLICT: BudgetItemWriteResult = { ok: false, message: '다른 곳에서 변경됐어요', reason: 'conflict' };
const INVALID: BudgetItemWriteResult = { ok: false, message: '금액을 확인해 주세요', reason: undefined };
const ENQ_OK: BudgetItemEnqueueResult = { ok: true };

function makeDeps(over: Partial<RunBudgetSaveBatchDeps> = {}): RunBudgetSaveBatchDeps & {
  saveCalls: BudgetSavePlanItem[];
  createCalls: BudgetSavePlanItem[];
  updateCalls: BudgetSavePlanItem[];
} {
  const saveCalls: BudgetSavePlanItem[] = [];
  const createCalls: BudgetSavePlanItem[] = [];
  const updateCalls: BudgetSavePlanItem[] = [];
  return {
    pendingBudgetIds: new Set(),
    saveBudget: async (i) => {
      saveCalls.push(i);
      return OK;
    },
    enqueueBudgetCreate: async (i) => {
      createCalls.push(i);
      return ENQ_OK;
    },
    enqueueBudgetUpdate: async (i) => {
      updateCalls.push(i);
      return ENQ_OK;
    },
    saveCalls,
    createCalls,
    updateCalls,
    ...over,
  };
}

export async function runBudgetSaveBatchCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  // 1 — all direct success
  {
    const plan = [item({ categoryId: 'food' }), item({ categoryId: 'shopping', op: 'update', expectedUpdatedAt: 'V1' })];
    const deps = makeDeps();
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '1 all direct success -> done=2, queued=0, no failure',
      res.done === 2 && res.queued === 0 && res.attempted === 2 && res.failure === null,
      JSON.stringify(res),
    );
  }

  // 2 — first direct success + second transport queued + third continues
  {
    const plan = [
      item({ categoryId: 'a' }),
      item({ categoryId: 'b' }),
      item({ categoryId: 'c' }),
    ];
    let call = 0;
    const deps = makeDeps({
      saveBudget: async () => {
        call += 1;
        return call === 2 ? TRANSPORT : OK; // only the 2nd item hits transport
      },
    });
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '2 direct success + transport-queued middle item + third continues',
      res.done === 2 && res.queued === 1 && res.attempted === 3 && res.failure === null &&
        deps.createCalls.length === 1 && deps.createCalls[0].categoryId === 'b',
      JSON.stringify(res),
    );
  }

  // 3 — multiple transport failures, each durably queued
  {
    const plan = [item({ categoryId: 'a' }), item({ categoryId: 'b' }), item({ categoryId: 'c' })];
    const deps = makeDeps({ saveBudget: async () => TRANSPORT });
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '3 every item hits transport -> all 3 durably queued, none dropped, no failure',
      res.done === 0 && res.queued === 3 && res.attempted === 3 && res.failure === null &&
        deps.createCalls.map((c) => c.categoryId).join(',') === 'a,b,c',
      JSON.stringify(res),
    );
  }

  // 4 — enqueue persistence failure -> stop immediately, never claim success
  {
    const plan = [item({ categoryId: 'a' }), item({ categoryId: 'b' }), item({ categoryId: 'c' })];
    const deps = makeDeps({
      saveBudget: async () => TRANSPORT,
      enqueueBudgetCreate: async (i) => (i.categoryId === 'b' ? { ok: false, reason: 'persist' } : ENQ_OK),
    });
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '4 enqueue persist failure on 2nd item -> stop, 3rd never attempted, not claimed success',
      res.queued === 1 && res.attempted === 2 && res.failure !== null && res.failure!.changedElsewhere === false,
      JSON.stringify(res),
    );
  }

  // 5 — non-transport failure -> never queued, stop immediately
  {
    const plan = [item({ categoryId: 'a' }), item({ categoryId: 'b' }), item({ categoryId: 'c' })];
    let call = 0;
    const deps = makeDeps({
      saveBudget: async () => {
        call += 1;
        return call === 2 ? CONFLICT : OK;
      },
    });
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '5 non-transport conflict on 2nd item -> stop, never queued, changedElsewhere=true, 3rd never attempted',
      res.done === 1 && res.queued === 0 && res.attempted === 2 && deps.createCalls.length === 0 &&
        res.failure !== null && res.failure!.changedElsewhere === true,
      JSON.stringify(res),
    );
  }
  // 5b — `invalid` (reason undefined after runOp normalization) -> generic stop, changedElsewhere=false
  {
    const plan = [item({ categoryId: 'a' })];
    const deps = makeDeps({ saveBudget: async () => INVALID });
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '5b invalid (no reason) -> stop, not queued, changedElsewhere=false',
      res.done === 0 && res.queued === 0 && deps.createCalls.length === 0 &&
        res.failure !== null && res.failure!.changedElsewhere === false,
      JSON.stringify(res),
    );
  }

  // 6 — frozen plan values reach the deps verbatim (amount + expectedUpdatedAt),
  // never recomputed mid-batch, for BOTH create and update items.
  {
    const plan = [
      item({ categoryId: 'food', op: 'create', amount: 77000, expectedUpdatedAt: null }),
      item({ categoryId: 'shopping', op: 'update', amount: 55000, expectedUpdatedAt: 'FROZEN-V1' }),
    ];
    const deps = makeDeps();
    deps.saveBudget = async (i) => {
      deps.saveCalls.push(i);
      return TRANSPORT;
    };
    await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '6 frozen plan (amount + expectedUpdatedAt) reaches saveBudget AND the enqueue call verbatim',
      deps.saveCalls[0].amount === 77000 &&
        deps.saveCalls[0].expectedUpdatedAt === null &&
        deps.saveCalls[1].amount === 55000 &&
        deps.saveCalls[1].expectedUpdatedAt === 'FROZEN-V1' &&
        deps.createCalls[0].amount === 77000 &&
        deps.updateCalls[0].amount === 55000 &&
        deps.updateCalls[0].expectedUpdatedAt === 'FROZEN-V1',
      JSON.stringify({ saveCalls: deps.saveCalls, createCalls: deps.createCalls, updateCalls: deps.updateCalls }),
    );
  }

  /* ---------------- bonus coverage: guards before the write is even attempted ---------------- */

  // 7 — §18: a category with an unresolved pending op is refused before any write
  {
    const plan = [item({ categoryId: 'food' })];
    const deps = makeDeps({ pendingBudgetIds: new Set(['food']) });
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '7 pending-op guard: refused before saveBudget is ever called',
      res.attempted === 0 && deps.saveCalls.length === 0 && res.failure !== null,
      JSON.stringify(res),
    );
  }

  // 8 — capability off (budgetEdit) -> UPDATE item refused, never attempted
  {
    const plan = [item({ categoryId: 'food', op: 'update', expectedUpdatedAt: 'V1' })];
    const deps = makeDeps();
    const res = await runBudgetSaveBatch(plan, { budgetCreate: true, budgetEdit: false }, deps);
    check(
      '8 budgetEdit capability off -> UPDATE item refused before write',
      res.attempted === 0 && deps.saveCalls.length === 0 && res.failure !== null,
      JSON.stringify(res),
    );
  }

  // 9 — defensive: an UPDATE item with a null token is refused, never a blind write
  {
    const plan = [item({ categoryId: 'food', op: 'update', expectedUpdatedAt: null })];
    const deps = makeDeps();
    const res = await runBudgetSaveBatch(plan, CAPS_ON, deps);
    check(
      '9 UPDATE item missing its frozen token -> refused, never written',
      res.attempted === 0 && deps.saveCalls.length === 0 && res.failure !== null,
      JSON.stringify(res),
    );
  }

  // 10 — empty plan (nothing changed) -> no-op, no failure
  {
    const deps = makeDeps();
    const res = await runBudgetSaveBatch([], CAPS_ON, deps);
    check('10 empty plan -> done=0 queued=0 attempted=0 no failure', res.done === 0 && res.queued === 0 && res.attempted === 0 && res.failure === null, JSON.stringify(res));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
