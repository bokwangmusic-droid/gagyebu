/**
 * Atomic custom-category + budget delete — STEP 16-H2-C2-BUDGET,
 * "CATEGORY DELETE WITH BUDGET A1" (server/write contract only).
 *
 * A composite write, DELIBERATELY kept out of both remoteCategoryWrite.ts
 * ("This module writes ONLY public.custom_categories and
 * public.household_settings ... NEVER ... budgets") and
 * remoteBudgetWrite.ts ("This module writes ONLY public.budgets") — this
 * file is the one place allowed to touch both tables in a single call,
 * because it does so through ONE Postgres RPC transaction
 * (`public.delete_custom_category_with_budget`,
 * supabase/migrations/20260910001000_delete_custom_category_with_budget.sql),
 * never through two separate PostgREST requests. `softDeleteCustomCategory`
 * / `softDeleteBudget` are UNCHANGED and still the right call for a
 * standalone delete of either entity alone (e.g. the Budget tab's own
 * delete, which has no category side-effect).
 *
 * Session identity: same HARDEN as every other write service — the caller
 * passes the `expectedUserId` its trusted screen was validated against; if
 * the live Supabase session's user id no longer matches, no RPC call is
 * attempted. The RPC itself additionally uses `auth.uid()` as the ONLY
 * identity source server-side — `expectedUserId` never reaches the RPC as
 * an argument, exactly per the audit's §2 requirement ("서버에서
 * auth.uid()를 identity source로 사용").
 *
 * STEP 16-H2-C2-BUDGET A1 scope: this file adds the write contract only.
 * Nothing calls it yet (app/categories.tsx is unchanged) and it is not
 * wired into the offline queue — both are deferred to A2/A3.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { isTransportError } from '@/lib/transportError';

export type DeleteCategoryWithBudgetReason = 'identity' | 'conflict' | 'gone' | 'error';

export type SoftDeleteCustomCategoryWithBudgetResult =
  | { ok: true; categoryDeletedAt: string; budgetDeletedAt: string | null }
  | { ok: false; reason: DeleteCategoryWithBudgetReason; message: string; transport?: boolean };

const GENERIC_ERROR = '카테고리를 삭제하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const NETWORK_ERROR = '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
const NOT_FOUND = '이미 변경됐거나 삭제된 항목이에요. 최신 내용을 불러올게요.';
const CONFLICT = '다른 곳에서 카테고리 또는 예산이 변경됐어요. 최신 내용을 불러올게요.';

/** The live session must be exactly the user the trusted screen was built for. */
async function assertLiveUser(
  expectedUserId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, message: RELOGIN };
  if (liveUserId !== expectedUserId) return { ok: false, message: IDENTITY_CHANGED };
  return { ok: true };
}

/**
 * Maps the RPC's distinct short exception codes (raised server-side by
 * `delete_custom_category_with_budget` — see the migration for the exact
 * list) down to the shared `identity | conflict | gone | error` vocabulary.
 * Mirrors `src/store/household.tsx`'s existing `describeHouseholdError`
 * `.includes(...)` technique for reading an RPC's raised exception code
 * back out of `PostgrestError.message`, but returns the write-service
 * `{ reason, message, transport? }` shape (STEP 16-H2 audit §13) rather
 * than a bare message.
 *
 * A TRANSPORT failure (the request never reached a server verdict) is
 * checked FIRST via the shared `isTransportError` — every one of this
 * RPC's business-logic exceptions carries a real Postgres SQLSTATE
 * (`errcode`), so `isTransportError` already returns `false` for all of
 * them without this function needing to special-case anything.
 */
export function classifyDeleteCategoryWithBudgetError(
  error: PostgrestError,
): { ok: false; reason: DeleteCategoryWithBudgetReason; message: string; transport?: true } {
  if (isTransportError(error)) {
    return { ok: false, reason: 'error', message: NETWORK_ERROR, transport: true };
  }

  const code = error.message ?? '';
  if (code.includes('AUTH_REQUIRED') || code.includes('NOT_MEMBER')) {
    return { ok: false, reason: 'identity', message: IDENTITY_CHANGED };
  }
  if (code.includes('CATEGORY_NOT_FOUND') || code.includes('BUDGET_NOT_FOUND')) {
    return { ok: false, reason: 'gone', message: NOT_FOUND };
  }
  if (code.includes('CATEGORY_CONFLICT') || code.includes('BUDGET_CONFLICT')) {
    return { ok: false, reason: 'conflict', message: CONFLICT };
  }
  return { ok: false, reason: 'error', message: GENERIC_ERROR };
}

/**
 * Soft-delete a custom category AND (if one was live at intent time) its
 * budget, atomically, via ONE Postgres transaction. Never a hard DELETE on
 * either table (the RPC itself only ever sets `deleted_at`).
 *
 * `expectedBudgetUpdatedAt`:
 *   - a string : the caller's snapshot had a LIVE budget for this category
 *                at the moment delete was confirmed — go in guarded on
 *                that exact token. A CURRENTLY-ACTIVE budget with a
 *                DIFFERENT token (someone else's edit, or a revive after
 *                an earlier delete) is a `conflict`, nothing on either
 *                table touched. A budget that's ALREADY a tombstone is
 *                NEVER a conflict here regardless of its token — a soft
 *                delete itself changes `updated_at`, so this is what makes
 *                a lost-response retry of our OWN successful delete
 *                idempotent (STEP 16-H2 audit A1.1 fix) rather than a
 *                false conflict every time.
 *   - null     : the caller's snapshot had NO live budget for this
 *                category — go in guarded on "still none"; a budget that
 *                appeared since (any device, any amount) is ALSO a
 *                `conflict`, and nothing on either table is touched. This
 *                is NOT "delete regardless of budget state" — see the
 *                migration's own comments (STEP 16-H2 audit §3).
 */
export async function softDeleteCustomCategoryWithBudget(args: {
  householdId: string;
  categoryId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string for the category, captured BEFORE
   *  the confirm Alert — never re-parsed. */
  expectedCategoryUpdatedAt: string;
  /** RAW PostgREST timestamptz string for the budget, or `null` if the
   *  caller's snapshot had none — captured at the SAME moment as
   *  `expectedCategoryUpdatedAt`. */
  expectedBudgetUpdatedAt: string | null;
}): Promise<SoftDeleteCustomCategoryWithBudgetResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase.rpc('delete_custom_category_with_budget', {
    p_household_id: args.householdId,
    p_category_id: args.categoryId,
    p_expected_category_updated_at: args.expectedCategoryUpdatedAt,
    p_expected_budget_updated_at: args.expectedBudgetUpdatedAt,
  });

  if (error) return classifyDeleteCategoryWithBudgetError(error);

  // `returns table (...)` comes back from supabase-js as an array of rows.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { category_deleted_at: string | null; budget_deleted_at: string | null }
    | null
    | undefined;

  if (!row?.category_deleted_at) {
    return { ok: false, reason: 'error', message: GENERIC_ERROR };
  }
  return {
    ok: true,
    categoryDeletedAt: row.category_deleted_at,
    budgetDeletedAt: row.budget_deleted_at ?? null,
  };
}
