/**
 * Static verification for STEP 16-H2-C2-0 — the transport-taxonomy hardening
 * of the card / custom-category / budget remote write services.
 *
 * The full write flows call `supabase` directly and cannot run here (same
 * limitation as src/services/remoteFinanceWrite.cases.ts). What this STEP
 * changed is:
 *   1. every result union gained an additive optional `transport?: boolean`;
 *   2. every primary write error is now tagged via `isTransportError`;
 *   3. every reconcile-read error is now routed through
 *      `classifyWriteReadError` — transport read failure -> `transport:true`,
 *      non-transport read error -> plain server error, a SUCCESSFUL empty
 *      read still falls through unchanged to `gone` / the idempotent-match
 *      branch.
 * `saveCategoryOrder` is deliberately NOT hardened.
 *
 * These cases pin (1)–(3) against the shared pure helpers each service now
 * uses, entity-labelled to the spec's numbered checklist. The unchanged
 * ordering branches (`deleted` / `conflict` / `gone` / field-match idempotent
 * success) are covered by STEP 16-G2-C2/C3/C4's contracts + device tests;
 * here we only prove the transport layer never SHADOWS them (a successful
 * reconcile read -> helper returns `undefined` -> fall through).
 */
import { classifyWriteReadError, isTransportError } from '@/lib/transportError';
import type { CreateCardResult, SoftDeleteCardResult, UpdateCardResult } from '@/services/remoteCardWrite';
import type {
  CreateCategoryResult,
  SaveCategoryOrderResult,
  SoftDeleteCategoryResult,
  UpdateCategoryResult,
} from '@/services/remoteCategoryWrite';
import type { SaveBudgetResult, SoftDeleteBudgetResult } from '@/services/remoteBudgetWrite';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

// Representative PostgREST error shapes (see transportError.ts analysis).
const NET = { message: 'TypeError: Network request failed', code: '' };
const TIMEOUT = { message: 'AbortError', hint: 'Request was aborted (timeout or manual cancellation)', code: '' };
const RLS = { message: 'new row violates row-level security policy', code: '42501' };
const HTTP500 = { message: 'Internal Server Error', code: '', status: 500 };
const DUP = { message: 'duplicate key value violates unique constraint', code: '23505' };

const cardCopy = (e: { message?: string }) =>
  /network|fetch|timeout/i.test(e.message ?? '') ? '네트워크 연결을 확인한 뒤 다시 시도해주세요.' : '카드를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const catCopy = (e: { message?: string }) =>
  /network|fetch|timeout/i.test(e.message ?? '') ? '네트워크 연결을 확인한 뒤 다시 시도해주세요.' : '카테고리를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const budgetCopy = (e: { message?: string }) =>
  /network|fetch|timeout/i.test(e.message ?? '') ? '네트워크 연결을 확인한 뒤 다시 시도해주세요.' : '예산을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';

/** Mirror of each service's primary-error branch: `...(isTransportError(e) ? { transport:true } : {})`. */
const primaryTag = (e: unknown) => (isTransportError(e) ? { transport: true as const } : {});
/** Mirror of each service's reconcile-read branch. `undefined` => fall through unchanged. */
const reconcile = (readErr: unknown, copy: (e: { message?: string }) => string) => {
  const c = classifyWriteReadError(readErr as { message?: string } | null, copy);
  if (!c) return undefined; // -> service proceeds to !existing / field-match branches, unchanged
  return { ok: false as const, reason: 'error' as const, message: c.message, ...(c.transport ? { transport: true as const } : {}) };
};

export async function runEntityWriteTransportCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ============================ CARD ============================ */

  // 1 — create primary transport
  check('CARD 1 createCard primary transport -> { transport:true }', JSON.stringify(primaryTag(NET)) === '{"transport":true}');
  // 2 — create 23505 reconcile transport
  {
    const r = reconcile(NET, cardCopy);
    check('CARD 2 create 23505 reconcile transport -> transport:true', !!r && r.transport === true && r.reason === 'error');
  }
  // 3 — create matching existing -> idempotent (a SUCCESSFUL read is not intercepted)
  check('CARD 3 create 23505 reconcile with NO read error -> falls through (idempotent branch unchanged)', reconcile(null, cardCopy) === undefined);
  // 4 — update primary transport
  check('CARD 4 updateCard primary transport -> transport:true', isTransportError(TIMEOUT) === true);
  // 5 — update reconcile transport
  check('CARD 5 update 0-row reconcile transport -> transport:true', reconcile(TIMEOUT, cardCopy)?.transport === true);
  // 6 — update non-transport read error != gone
  {
    const r = reconcile(HTTP500, cardCopy);
    check('CARD 6 update reconcile non-transport readErr -> reason:error (NOT gone), no transport', !!r && r.reason === 'error' && !('transport' in r));
  }
  // 7 — update matching existing -> idempotent unchanged (successful read not shadowed)
  check('CARD 7 update reconcile, read ok -> undefined (cardFieldsMatch / conflict branch runs)', reconcile(null, cardCopy) === undefined);
  // 8 — update conflict retained: still reached only when the read succeeds
  check('CARD 8 conflict path only reachable after a SUCCESSFUL reconcile read', reconcile(null, cardCopy) === undefined);
  // 9 — delete primary transport
  check('CARD 9 softDeleteCard primary transport -> transport:true', JSON.stringify(primaryTag(NET)) === '{"transport":true}');
  // 10 — delete reconcile transport
  check('CARD 10 delete reconcile transport -> transport:true', reconcile(NET, cardCopy)?.transport === true);
  // 11 — already deleted idempotent: successful read, not intercepted
  check('CARD 11 delete reconcile read ok -> undefined (already-deleted idempotent branch unchanged)', reconcile(null, cardCopy) === undefined);
  // type: transport is additive/optional on every card result
  {
    const a: CreateCardResult = { ok: false, message: 'x', transport: true };
    const b: UpdateCardResult = { ok: false, reason: 'error', message: 'x', transport: true };
    const c: SoftDeleteCardResult = { ok: false, reason: 'gone', message: 'x' }; // still valid WITHOUT transport
    check('CARD type: transport?: boolean is additive on all three result unions', a.ok === false && b.ok === false && c.ok === false);
  }

  /* ====================== CUSTOM CATEGORY ====================== */

  // 12 — create primary transport
  check('CAT 12 createCustomCategory primary transport -> transport:true', isTransportError(NET) === true);
  // 13 — create 23505 reconcile transport
  check('CAT 13 create 23505 reconcile transport -> transport:true', reconcile(NET, catCopy)?.transport === true);
  // 14 — matching existing idempotent: successful read not shadowed
  check('CAT 14 create reconcile read ok -> undefined (isSameCreateRow idempotent branch unchanged)', reconcile(null, catCopy) === undefined);
  // 15 — update primary transport
  check('CAT 15 updateCustomCategory primary transport -> transport:true', JSON.stringify(primaryTag(TIMEOUT)) === '{"transport":true}');
  // 16 — update reconcile transport
  check('CAT 16 update 0-row reconcile transport -> transport:true', reconcile(NET, catCopy)?.transport === true);
  // 17 — update conflict retained (only after a successful read)
  check('CAT 17 conflict / deleted / gone only reachable after a SUCCESSFUL reconcile read', reconcile(null, catCopy) === undefined);
  // 18 — delete primary transport
  check('CAT 18 softDeleteCustomCategory primary transport -> transport:true', isTransportError(NET) === true);
  // 19 — delete reconcile transport
  check('CAT 19 delete reconcile transport -> transport:true', reconcile(TIMEOUT, catCopy)?.transport === true);
  // 20 — already deleted idempotent unchanged
  check('CAT 20 delete reconcile read ok -> undefined (already-deleted idempotent branch unchanged)', reconcile(null, catCopy) === undefined);
  // non-transport readErr must NOT be mislabelled gone/transport
  {
    const r = reconcile(RLS, catCopy);
    check('CAT non-transport readErr (RLS) -> reason:error, no transport, not gone', !!r && r.reason === 'error' && !('transport' in r));
  }
  // type: additive
  {
    const a: CreateCategoryResult = { ok: false, reason: 'error', message: 'x', transport: true };
    const b: UpdateCategoryResult = { ok: false, reason: 'conflict', message: 'x' };
    const c: SoftDeleteCategoryResult = { ok: false, reason: 'error', message: 'x', transport: true };
    check('CAT type: transport?: boolean additive on create/update/softDelete', a.ok === false && b.ok === false && c.ok === false);
  }
  // saveCategoryOrder is UNTOUCHED — its result union has NO transport field.
  {
    const ok: SaveCategoryOrderResult = { ok: true };
    // @ts-expect-error — `transport` is intentionally NOT part of SaveCategoryOrderResult
    const bad: SaveCategoryOrderResult = { ok: false, reason: 'error', message: 'x', transport: true };
    void bad;
    check('CAT saveCategoryOrder result union has NO transport field (deliberately not queue-able)', ok.ok === true);
  }

  /* ============================ BUDGET ============================ */

  // 21 — guarded UPDATE primary transport
  check('BUD 21 saveBudget guarded-UPDATE primary transport -> transport:true', isTransportError(NET) === true);
  // 22 — guarded UPDATE reconcile transport
  check('BUD 22 reconcileUpdate readErr transport -> transport:true', reconcile(NET, budgetCopy)?.transport === true);
  // 23 — INSERT primary transport (non-23505)
  check('BUD 23 saveBudget INSERT primary transport -> transport:true', JSON.stringify(primaryTag(NET)) === '{"transport":true}');
  // 24 — 23505 reconcile transport
  check('BUD 24 reconcileInsertConflict readErr transport -> transport:true', reconcile(TIMEOUT, budgetCopy)?.transport === true);
  // 25 — INSERT same-request idempotent: a 23505 is a verdict, and a successful reselect is not intercepted
  check(
    'BUD 25 23505 is a verdict (not transport) AND read-ok reselect falls through to amount+created_by idempotent branch',
    isTransportError(DUP) === false && reconcile(null, budgetCopy) === undefined,
  );
  // 26 — revive primary transport
  check('BUD 26 reviveTombstone guarded-UPDATE primary transport -> transport:true', isTransportError(NET) === true);
  // 27 — revive reconcile transport
  check('BUD 27 reviveTombstone 0-row reselect transport -> transport:true', reconcile(NET, budgetCopy)?.transport === true);
  // 28 — revive already-applied idempotent: successful reselect not shadowed
  check('BUD 28 revive reselect read ok -> undefined (now-active-with-our-amount idempotent branch unchanged)', reconcile(null, budgetCopy) === undefined);
  // 29 — delete primary transport
  check('BUD 29 softDeleteBudget primary transport -> transport:true', JSON.stringify(primaryTag(NET)) === '{"transport":true}');
  // 30 — delete reconcile transport
  check('BUD 30 softDeleteBudget reconcile readErr transport -> transport:true', reconcile(TIMEOUT, budgetCopy)?.transport === true);
  // 31 — already deleted idempotent unchanged
  check('BUD 31 delete reconcile read ok -> undefined (already-deleted idempotent branch unchanged)', reconcile(null, budgetCopy) === undefined);
  // non-transport readErr on any budget reconcile -> reason:error, not gone/transport
  {
    const r = reconcile(HTTP500, budgetCopy);
    check('BUD non-transport reconcile readErr -> reason:error, no transport (never mistaken for gone)', !!r && r.reason === 'error' && !('transport' in r));
  }
  // type: additive on both budget result unions; still valid WITHOUT transport
  {
    const a: SaveBudgetResult = { ok: false, reason: 'exists', message: 'x' };
    const b: SaveBudgetResult = { ok: false, reason: 'error', message: 'x', transport: true };
    const c: SoftDeleteBudgetResult = { ok: false, reason: 'conflict', message: 'x' };
    const d: SoftDeleteBudgetResult = { ok: false, reason: 'error', message: 'x', transport: true };
    check('BUD type: transport?: boolean additive on SaveBudgetResult + SoftDeleteBudgetResult', a.ok === false && b.ok === false && c.ok === false && d.ok === false);
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
