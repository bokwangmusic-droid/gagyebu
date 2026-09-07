/**
 * Remote household budget WRITE layer — STEP 16-G2-C3-B.
 *
 * The budget counterpart of src/services/remoteCardWrite.ts. Two direct
 * writes against `public.budgets`:
 *   - saveBudget        : set a category's budget amount — resolves to an
 *                         INSERT, a conditional UPDATE of an existing live
 *                         row, or a conditional revive of a soft-deleted
 *                         tombstone, depending on state.
 *   - softDeleteBudget  : `.update({ deleted_at })` — never a hard DELETE.
 *
 * `public.budgets` has NO surrogate id and NO `month` column. Its natural
 * PRIMARY KEY is `(household_id, category_id)`, so a budget is addressed by
 * `household_id + category_id`, and there is exactly one row per category
 * per household — tombstones included. That is why:
 *   - a 23505 on INSERT is ALWAYS the natural-key collision, never a
 *     "same client id retry" (there is no client id) — §16/§18.
 *   - re-adding a category whose budget was soft-deleted is an UPDATE that
 *     clears `deleted_at`, not a second INSERT — §18.
 *   - `supabase.from('budgets').upsert(...)` is NOT used — it cannot carry
 *     the `updated_at` optimistic-concurrency condition — §38.
 *
 * No RPC. STEP 16-G2-C3-A established direct writes are safe: the
 * budgets_insert / budgets_update RLS policies already permit any
 * household member (owner OR member); private.trg_lock_budget_identity()
 * forces created_by = auth.uid() on INSERT and freezes
 * household_id/category_id/created_by/created_at on UPDATE; the column
 * grant is `update (amount, deleted_at)` so only those two are writable;
 * private.trg_touch_updated_at() stamps updated_at = now() on every
 * UPDATE. `authenticated` has no DELETE grant and no budgets DELETE
 * policy, so a hard delete is impossible from here.
 *
 * This module writes ONLY `public.budgets` — never transactions, cards,
 * custom_categories, or any other table (STEP 16-G2-C3-B §36).
 *
 * Session identity: the caller passes the `expectedUserId` its trusted
 * screen was validated against; if the live Supabase session's user id no
 * longer matches, no write is attempted (same HARDEN as card/transaction).
 *
 * Small, deliberate duplication with remoteCardWrite.ts (error describer,
 * reason union, 0-row reconcile shape) is accepted — safety over a
 * premature shared-helper refactor.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  buildBudgetInsert,
  buildBudgetRevive,
  buildBudgetUpdate,
  isValidBudgetDraft,
  type NewBudgetDraft,
} from '@/lib/remoteBudgetWriteMapping';

export type BudgetWriteReason =
  | 'identity'
  | 'invalid'
  | 'conflict'
  | 'exists'
  | 'deleted'
  | 'gone'
  | 'error';

export type SaveBudgetResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: BudgetWriteReason; message: string };

export type SoftDeleteBudgetResult =
  | { ok: true }
  | { ok: false; reason: Exclude<BudgetWriteReason, 'invalid' | 'exists' | 'deleted'>; message: string };

const GENERIC_ERROR = '예산을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const INVALID = '예산 금액을 확인해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 예산이 변경됐거나 삭제됐어요. 최신 내용을 불러올게요.';
const BUDGET_EXISTS = '이미 이 카테고리 예산이 있어요. 최신 내용을 불러올게요.';
const DELETE_CONFLICT = '다른 곳에서 이미 변경됐거나 삭제된 예산이에요.';

/** Never surfaces raw Postgres/PostgREST internals (mirrors remoteCardWrite.ts). */
function describeWriteError(error: PostgrestError): string {
  const m = (error.message ?? '').toLowerCase();
  if (m.includes('network') || m.includes('fetch') || m.includes('timeout')) {
    return '네트워크 연결을 확인한 뒤 다시 시도해주세요.';
  }
  return GENERIC_ERROR;
}

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

type BudgetRowKey = { householdId: string; category: string };

/** Re-read the one `(household_id, category_id)` row — no updated_at/deleted_at filter. */
async function reselect(key: BudgetRowKey) {
  return supabase
    .from('budgets')
    .select('amount, created_by, deleted_at, updated_at')
    .eq('household_id', key.householdId)
    .eq('category_id', key.category)
    .maybeSingle();
}

/**
 * Set `category`'s budget to `amount`.
 *
 * `expectedUpdatedAt`:
 *   - string : the form saw a LIVE budget for this category at mount — go
 *              straight to a `updated_at`-guarded UPDATE.
 *   - null   : the form saw NO live budget — INSERT, and reconcile a 23505
 *              (tombstone -> revive, live row -> idempotent-or-exists).
 */
export async function saveBudget(args: {
  householdId: string;
  expectedUserId: string;
  category: string;
  amount: number;
  expectedUpdatedAt: string | null;
}): Promise<SaveBudgetResult> {
  const draft: NewBudgetDraft = { category: args.category, amount: args.amount };
  if (!isValidBudgetDraft(draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }

  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const key: BudgetRowKey = { householdId: args.householdId, category: args.category };

  // ---- known-live path: conditional UPDATE of amount ----
  if (args.expectedUpdatedAt != null) {
    const { data, error } = await supabase
      .from('budgets')
      .update(buildBudgetUpdate(draft))
      .eq('household_id', key.householdId)
      .eq('category_id', key.category)
      .eq('updated_at', args.expectedUpdatedAt)
      .is('deleted_at', null)
      .select('category_id, updated_at')
      .maybeSingle();

    if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
    if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

    return reconcileUpdate(key, args.amount);
  }

  // ---- snapshot said "no live row": INSERT, reconcile 23505 ----
  const { data, error } = await supabase
    .from('budgets')
    .insert(buildBudgetInsert(draft, { householdId: key.householdId }))
    .select('category_id, updated_at')
    .single();

  if (!error && data?.updated_at) {
    return { ok: true, updatedAt: data.updated_at as string };
  }

  if (error?.code === '23505') {
    return reconcileInsertConflict(key, args.amount, args.expectedUserId);
  }
  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  return { ok: false, reason: 'error', message: GENERIC_ERROR };
}

/** 0-row after a guarded amount UPDATE — classify (STEP 16-G2-C3-B §13/§19). */
async function reconcileUpdate(key: BudgetRowKey, desiredAmount: number): Promise<SaveBudgetResult> {
  const { data: existing, error: readErr } = await reselect(key);
  // A failed reselect (network / RLS / transient) is NOT "the row is gone".
  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const row = existing as Record<string, unknown>;
  if (row.deleted_at != null) return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  if (Number(row.amount) === desiredAmount) {
    // Our earlier UPDATE already landed; only the response was lost.
    return { ok: true, updatedAt: row.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

/** 23505 after an INSERT — the `(household_id, category_id)` slot is taken. */
async function reconcileInsertConflict(
  key: BudgetRowKey,
  desiredAmount: number,
  expectedUserId: string,
): Promise<SaveBudgetResult> {
  const { data: existing, error: readErr } = await reselect(key);
  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: GENERIC_ERROR };

  const row = existing as Record<string, unknown>;

  // Tombstone occupies the PK slot -> revive (never a second INSERT).
  if (row.deleted_at != null) {
    return reviveTombstone(key, desiredAmount, row.updated_at as string);
  }

  // Live row already exists.
  if (Number(row.amount) === desiredAmount && row.created_by === expectedUserId) {
    // Our own INSERT landed; response was lost -> idempotent success.
    return { ok: true, updatedAt: row.updated_at as string };
  }
  // Different amount, or someone else's row -> never a blind overwrite.
  return { ok: false, reason: 'exists', message: BUDGET_EXISTS };
}

/** Conditionally clear a tombstone's `deleted_at` and set the new amount (STEP 16-G2-C3-B §18/§19). */
async function reviveTombstone(
  key: BudgetRowKey,
  desiredAmount: number,
  tombstoneUpdatedAt: string,
): Promise<SaveBudgetResult> {
  const { data, error } = await supabase
    .from('budgets')
    .update(buildBudgetRevive({ category: key.category, amount: desiredAmount }))
    .eq('household_id', key.householdId)
    .eq('category_id', key.category)
    .eq('updated_at', tombstoneUpdatedAt)
    .not('deleted_at', 'is', null) // deleted_at IS NOT NULL — only revive an actual tombstone
    .select('category_id, updated_at')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (data?.updated_at) return { ok: true, updatedAt: data.updated_at as string };

  // 0 rows — someone raced us. Reconcile.
  const { data: existing, error: readErr } = await reselect(key);
  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: EDIT_CONFLICT };

  const row = existing as Record<string, unknown>;
  if (row.deleted_at != null) {
    // Still a tombstone but our token no longer matches — someone else touched it.
    return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
  }
  if (Number(row.amount) === desiredAmount) {
    // Now active with exactly our amount — our revive effectively landed.
    return { ok: true, updatedAt: row.updated_at as string };
  }
  // Now active with a different amount — a concurrent create/revive won.
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeleteBudget(args: {
  householdId: string;
  expectedUserId: string;
  category: string;
  /** RAW PostgREST timestamptz string captured when the delete was initiated — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteBudgetResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const key: BudgetRowKey = { householdId: args.householdId, category: args.category };

  // Soft delete = UPDATE deleted_at, ONLY on public.budgets. No hard
  // DELETE, no transactions write, no migration.
  const { data, error } = await supabase
    .from('budgets')
    .update({ deleted_at: new Date().toISOString() })
    .eq('household_id', key.householdId)
    .eq('category_id', key.category)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('category_id, deleted_at, updated_at')
    .maybeSingle();

  if (error) return { ok: false, reason: 'error', message: describeWriteError(error) };
  if (data?.category_id) return { ok: true };

  // 0 rows — reconcile.
  const { data: existing, error: readErr } = await reselect(key);
  if (readErr) return { ok: false, reason: 'error', message: describeWriteError(readErr) };
  if (!existing) return { ok: false, reason: 'gone', message: DELETE_CONFLICT };
  if ((existing as Record<string, unknown>).deleted_at != null) {
    // Already soft-deleted — our earlier delete landed, response was lost.
    return { ok: true };
  }
  // Row is still active but our updated_at no longer matches: someone edited it first.
  return { ok: false, reason: 'conflict', message: DELETE_CONFLICT };
}
