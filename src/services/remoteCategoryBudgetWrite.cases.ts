/**
 * Static verification for STEP 16-H2-C2-BUDGET "CATEGORY DELETE WITH
 * BUDGET A1": the RPC exception-code -> client `reason` classification
 * (`classifyDeleteCategoryWithBudgetError`) that
 * `softDeleteCustomCategoryWithBudget` routes every `supabase.rpc(...)`
 * error through.
 *
 * The full write flow calls `supabase` directly and can't run here (same
 * limitation as remoteFinanceWrite.cases.ts's own header note) — this
 * covers the one pure, extractable decision point: given the RPC's raised
 * exception (or a genuine transport failure), what `reason`/`message`/
 * `transport` does the client surface? The RPC's own SQL-level behavior
 * (validation-before-mutation, idempotent retry, natural-key isolation) is
 * specified and reasoned about in the migration file's comments and the
 * STEP 16-H2 chain audit; it is exercised by device/manual QA against the
 * real Supabase project in a later step, per this repo's established
 * convention for every other RPC (create_household_invite /
 * redeem_household_invite have no automated SQL test either).
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { classifyDeleteCategoryWithBudgetError } from '@/services/remoteCategoryBudgetWrite';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const pgErr = (over: Partial<PostgrestError>): PostgrestError =>
  ({ message: '', details: '', hint: '', code: '', ...over } as PostgrestError);

// A raised `exception 'CODE' using errcode = '...'` comes back from
// supabase-js as a PostgrestError whose `code` is that real SQLSTATE and
// whose `message` is (at least) the raised string — matching
// src/store/household.tsx's existing `describeHouseholdError` shape for
// create_household_invite / redeem_household_invite.
const AUTH_REQUIRED = pgErr({ message: 'AUTH_REQUIRED', code: '28000' });
const NOT_MEMBER = pgErr({ message: 'NOT_MEMBER', code: '42501' });
const CATEGORY_NOT_FOUND = pgErr({ message: 'CATEGORY_NOT_FOUND', code: 'P0002' });
const CATEGORY_CONFLICT = pgErr({ message: 'CATEGORY_CONFLICT', code: 'P0001' });
const BUDGET_NOT_FOUND = pgErr({ message: 'BUDGET_NOT_FOUND', code: 'P0002' });
const BUDGET_CONFLICT = pgErr({ message: 'BUDGET_CONFLICT', code: 'P0001' });
const UNKNOWN_SERVER_ERROR = pgErr({ message: 'unexpected server error', code: 'XX000' });

// Shapes matching src/lib/transportError.ts's own analysis — an empty
// `code` plus a network-failure phrase means the request never reached a
// server verdict.
const TRANSPORT = pgErr({ message: 'TypeError: Network request failed', code: '' });
const TIMEOUT = pgErr({ message: 'AbortError', hint: 'Request was aborted (timeout or manual cancellation)', code: '' });

export async function runCategoryBudgetWriteCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  // 1/2 — AUTH_REQUIRED / NOT_MEMBER -> identity
  {
    const a = classifyDeleteCategoryWithBudgetError(AUTH_REQUIRED);
    const b = classifyDeleteCategoryWithBudgetError(NOT_MEMBER);
    check(
      '1/2 AUTH_REQUIRED and NOT_MEMBER -> reason:identity, not transport',
      a.reason === 'identity' && !a.transport && b.reason === 'identity' && !b.transport,
      JSON.stringify({ a, b }),
    );
  }

  // 3/4 — CATEGORY_NOT_FOUND / BUDGET_NOT_FOUND -> gone
  {
    const a = classifyDeleteCategoryWithBudgetError(CATEGORY_NOT_FOUND);
    const b = classifyDeleteCategoryWithBudgetError(BUDGET_NOT_FOUND);
    check(
      '3/4 CATEGORY_NOT_FOUND and BUDGET_NOT_FOUND -> reason:gone, not transport',
      a.reason === 'gone' && !a.transport && b.reason === 'gone' && !b.transport,
      JSON.stringify({ a, b }),
    );
  }

  // 5/6 — CATEGORY_CONFLICT / BUDGET_CONFLICT -> conflict
  {
    const a = classifyDeleteCategoryWithBudgetError(CATEGORY_CONFLICT);
    const b = classifyDeleteCategoryWithBudgetError(BUDGET_CONFLICT);
    check(
      '5/6 CATEGORY_CONFLICT and BUDGET_CONFLICT -> reason:conflict, not transport (never a blind overwrite)',
      a.reason === 'conflict' && !a.transport && b.reason === 'conflict' && !b.transport,
      JSON.stringify({ a, b }),
    );
  }

  // 7 — an unrecognized server-side error -> generic reason:'error', not transport
  {
    const c = classifyDeleteCategoryWithBudgetError(UNKNOWN_SERVER_ERROR);
    check(
      '7 unrecognized server error code -> reason:error, transport:false',
      c.reason === 'error' && !c.transport,
      JSON.stringify(c),
    );
  }

  // 8/9 — genuine transport failures -> transport:true, checked BEFORE any
  // code-string match (every business exception carries a real SQLSTATE,
  // so this ordering never misclassifies one of the 6 codes above).
  {
    const a = classifyDeleteCategoryWithBudgetError(TRANSPORT);
    const b = classifyDeleteCategoryWithBudgetError(TIMEOUT);
    check(
      '8/9 network / timeout failures -> transport:true regardless of message text',
      a.transport === true && b.transport === true,
      JSON.stringify({ a, b }),
    );
  }

  // 10 — message is always friendly Korean copy, never the raw exception code
  {
    const all = [
      AUTH_REQUIRED, NOT_MEMBER, CATEGORY_NOT_FOUND, CATEGORY_CONFLICT,
      BUDGET_NOT_FOUND, BUDGET_CONFLICT, UNKNOWN_SERVER_ERROR, TRANSPORT, TIMEOUT,
    ].map((e) => classifyDeleteCategoryWithBudgetError(e));
    const rawCodes = ['AUTH_REQUIRED', 'NOT_MEMBER', 'CATEGORY_NOT_FOUND', 'CATEGORY_CONFLICT', 'BUDGET_NOT_FOUND', 'BUDGET_CONFLICT'];
    const neverRaw = all.every((r) => rawCodes.every((code) => !r.message.includes(code)));
    check('10 client-facing message never leaks the raw RPC exception code', neverRaw, JSON.stringify(all));
  }

  // 11 — every classified result is ok:false (this helper only ever runs
  // when `error` is non-null, i.e. the RPC call itself failed).
  {
    const c = classifyDeleteCategoryWithBudgetError(CATEGORY_CONFLICT);
    check('11 result is always ok:false', c.ok === false, JSON.stringify(c));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
