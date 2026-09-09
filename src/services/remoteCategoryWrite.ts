/**
 * Remote household custom-category WRITE layer — STEP 16-G2-C4-B.
 *
 * Four direct writes, no RPC:
 *   - createCustomCategory     : `.insert()` one `public.custom_categories`
 *   - updateCustomCategory     : `.update()` name/bg/color/icon (NEVER type)
 *   - softDeleteCustomCategory : `.update({ deleted_at })` — never hard DELETE
 *   - saveCategoryOrder        : `.update()` ONE of
 *       `public.household_settings.cat_order_expense` /
 *       `cat_order_income` — the shared display order.
 *
 * `public.custom_categories` has a client-generated TEXT PK (no
 * `unique(household_id, id)`), so a 23505 on INSERT can ONLY be that exact
 * client id already existing — a lost-response retry, never a "duplicate
 * name" (there is no name uniqueness in the DB). `type` is product-
 * immutable after create and is never in an UPDATE payload.
 *
 * STEP 16-G2-C4-B established direct writes are safe: custom_categories_*
 * RLS policies permit any household member (owner OR member);
 * private.trg_lock_identity() forces created_by = auth.uid() on INSERT and
 * freezes id/household_id/created_by/created_at on UPDATE;
 * private.trg_touch_updated_at() stamps updated_at on every UPDATE;
 * `authenticated` has no DELETE grant / no DELETE policy so a hard delete
 * is impossible. For household_settings: `grant update (notes,
 * cat_order_expense, cat_order_income)` + a member-scoped policy, and
 * private.trg_household_settings_guard() force-sets
 * household_id/updated_by/updated_at.
 *
 * This module writes ONLY `public.custom_categories` and
 * `public.household_settings`. It NEVER writes transactions, cards,
 * budgets, or any other table. The A+C budget cleanup that accompanies a
 * category delete lives in the CALLER (app/categories.tsx), which reuses
 * the existing src/services/remoteBudgetWrite.ts `softDeleteBudget()` —
 * this module does not touch budgets.
 *
 * Session identity: every write re-checks the live session and refuses if
 * it no longer matches `expectedUserId` (same HARDEN as card/budget).
 */
import type { PostgrestError } from '@supabase/supabase-js';

import type { TxnType } from '@/data/categories';
import { supabase } from '@/lib/supabase';
import {
  buildCustomCategoryInsert,
  buildCustomCategoryUpdate,
  isValidCustomCategoryDraft,
  type CustomCategoryInsertRow,
  type NewCustomCategoryDraft,
} from '@/lib/remoteCategoryWriteMapping';
import { classifyWriteReadError, isTransportError } from '@/lib/transportError';

export type CategoryWriteReason =
  | 'identity'
  | 'invalid'
  | 'conflict'
  | 'deleted'
  | 'gone'
  | 'error';

/**
 * `transport: true` (STEP 16-H2-C2-0) marks a NETWORK/TRANSPORT failure of a
 * custom-category CRUD write — the request never reached a server verdict —
 * as opposed to a 23505, an RLS/PGRST verdict, or a successful-but-empty
 * reconcile read. ONLY a `transport` failure is safe for the Offline Write
 * Queue to enqueue. Additive/optional; existing `res.ok`/`res.reason`
 * callers are unaffected. `saveCategoryOrder` is DELIBERATELY excluded — it
 * has no optimistic-concurrency contract and must not look queue-able.
 */
export type CreateCategoryResult =
  | { ok: true; id: string }
  | { ok: false; reason: CategoryWriteReason; message: string; transport?: boolean };

export type UpdateCategoryResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: CategoryWriteReason; message: string; transport?: boolean };

export type SoftDeleteCategoryResult =
  | { ok: true }
  | {
      ok: false;
      reason: Exclude<CategoryWriteReason, 'invalid' | 'deleted'>;
      message: string;
      transport?: boolean;
    };

export type SaveCategoryOrderResult =
  | { ok: true }
  | { ok: false; reason: 'identity' | 'invalid' | 'error'; message: string };

const GENERIC_ERROR = '카테고리를 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const INVALID = '카테고리 정보를 확인해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 카테고리예요. 최신 내용을 불러올게요.';
const ORDER_ERROR = '카테고리 순서를 저장하지 못했어요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors remoteCardWrite.ts). */
function describeWriteError(error: PostgrestError): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return GENERIC_ERROR;
}

async function assertLiveUser(
  expectedUserId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const liveUserId = sessionData.session?.user?.id ?? null;
  if (!liveUserId) return { ok: false, message: RELOGIN };
  if (liveUserId !== expectedUserId) return { ok: false, message: IDENTITY_CHANGED };
  return { ok: true };
}

/** Does a row read back after a 23505 represent the SAME create, by the SAME user? */
function isSameCreateRow(
  existing: Record<string, unknown>,
  row: CustomCategoryInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.type === row.type &&
    existing.name === row.name &&
    existing.bg === row.bg &&
    existing.color === row.color &&
    existing.icon === row.icon
  );
}

/** Does the stored row already hold exactly what this edit would write? */
function categoryFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildCustomCategoryUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    existing.bg === row.bg &&
    existing.color === row.color &&
    existing.icon === row.icon
  );
}

export async function createCustomCategory(args: {
  /** Client-generated `c-...` id, stable across retries of ONE add session. */
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewCustomCategoryDraft;
}): Promise<CreateCategoryResult> {
  if (!isValidCustomCategoryDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildCustomCategoryInsert(args.draft, {
    id: args.id,
    householdId: args.householdId,
  });

  const { data, error } = await supabase
    .from('custom_categories')
    .insert(row)
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true, id: data.id as string };

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('custom_categories')
      .select('id,household_id,created_by,type,name,bg,color,icon')
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    // STEP 16-H2-C2-0: a TRANSPORT failure during the 23505 reconcile read is
    // retryable; a non-transport read error stays terminal; a successful
    // empty read (RLS says it isn't ours) stays terminal.
    const readClass = classifyWriteReadError(readErr, describeWriteError);
    if (readClass) {
      return {
        ok: false,
        reason: 'error',
        message: readClass.message,
        ...(readClass.transport ? { transport: true } : {}),
      };
    }
    if (!existing) return { ok: false, reason: 'error', message: GENERIC_ERROR };
    if (isSameCreateRow(existing as Record<string, unknown>, row, args.expectedUserId)) {
      return { ok: true, id: args.id };
    }
    return { ok: false, reason: 'conflict', message: GENERIC_ERROR };
  }

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  return { ok: false, reason: 'error', message: GENERIC_ERROR };
}

export async function updateCustomCategory(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured at edit-sheet open — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewCustomCategoryDraft;
}): Promise<UpdateCategoryResult> {
  if (!isValidCustomCategoryDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildCustomCategoryUpdate(args.draft); // { name, bg, color, icon } — no type

  const { data, error } = await supabase
    .from('custom_categories')
    .update(row)
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — reconcile.
  const { data: existing, error: readErr } = await supabase
    .from('custom_categories')
    .select('name,bg,color,icon,deleted_at,updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-C2-0: transport read failure -> retryable (transport:true);
  // non-transport read error -> plain server error; only a successful empty
  // reselect is 'gone'.
  const readClass = classifyWriteReadError(readErr, describeWriteError);
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (categoryFieldsMatch(existingRow, row)) {
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeleteCustomCategory(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured BEFORE the confirm Alert — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteCategoryResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('custom_categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, deleted_at, updated_at')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      reason: 'error',
      message: describeWriteError(error),
      ...(isTransportError(error) ? { transport: true } : {}),
    };
  }
  if (data?.id) return { ok: true };

  // 0 rows — reconcile.
  const { data: existing, error: readErr } = await supabase
    .from('custom_categories')
    .select('deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-C2-0: transport read failure -> retryable (transport:true);
  // non-transport -> plain server error; only a successful empty reselect is 'gone'.
  const readClass = classifyWriteReadError(readErr, describeWriteError);
  if (readClass) {
    return {
      ok: false,
      reason: 'error',
      message: readClass.message,
      ...(readClass.transport ? { transport: true } : {}),
    };
  }
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  // Still active but our updated_at no longer matches — someone renamed it first.
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

/**
 * Persist the shared display order for ONE category type into
 * `public.household_settings`. Column is chosen from `type` in code —
 * NEVER from caller-supplied text — so an expense reorder can only touch
 * `cat_order_expense` and an income reorder only `cat_order_income`
 * (STEP 16-G2-C4-B §25/§27). Last-write-wins: reorder is a display
 * preference, not financial data, so no `updated_at` guard.
 */
export async function saveCategoryOrder(args: {
  householdId: string;
  expectedUserId: string;
  type: TxnType;
  orderedIds: string[];
}): Promise<SaveCategoryOrderResult> {
  const ids = args.orderedIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((x) => typeof x !== 'string' || x.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    return { ok: false, reason: 'invalid', message: ORDER_ERROR };
  }
  if (args.type !== 'income' && args.type !== 'expense') {
    return { ok: false, reason: 'invalid', message: ORDER_ERROR };
  }

  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const patch =
    args.type === 'expense'
      ? { cat_order_expense: ids }
      : { cat_order_income: ids };

  const { data, error } = await supabase
    .from('household_settings')
    .update(patch)
    .eq('household_id', args.householdId)
    .select('household_id')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (!data) return { ok: false, reason: 'error', message: ORDER_ERROR };
  return { ok: true };
}
