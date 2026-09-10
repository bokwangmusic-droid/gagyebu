/**
 * Remote household recurring-rule WRITE layer — STEP 16-G2-D2.
 *
 * Four direct writes, no RPC:
 *   - createRecurring     : `.insert()` one `public.recurring_rules` row
 *   - updateRecurring     : conditional `.update()` of the schedule fields
 *                           (name/amount/category/frequency/day_of_month/
 *                           day_of_week) — NEVER `type`, NEVER `active`,
 *                           NEVER `last_run`
 *   - setRecurringActive  : conditional `.update({ active })` ONLY — the
 *                           정지/재개 toggle, its own action so it never
 *                           rides on an edit form save
 *   - softDeleteRecurring : `.update({ deleted_at })` — never a hard DELETE
 *
 * This module writes ONLY `public.recurring_rules`. It NEVER writes
 * `transactions`, never sets `from_recurring` / `recurring_occurrence_date`,
 * never touches `last_run`, and does NOT generate any real transaction.
 * Recurring-driven transaction auto-generation is a separate future STEP
 * (the dead `BootEffects` in app/_layout.tsx is left untouched).
 *
 * `public.recurring_rules` has a client-generated TEXT PK `id` plus
 * `unique(household_id, id)`, so a 23505 on INSERT can ONLY be that exact
 * `(household_id, id)` already existing — a lost-response retry. A 23505 is
 * reconciled by re-reading the row and confirming it is the SAME create by
 * the SAME user, still ACTIVE (`deleted_at IS NULL` AND `active = true`),
 * before reporting idempotent success — never a blind success. A row that
 * exists but is soft-deleted is treated as an id collision (NOT revived).
 * `type` is product-immutable after create and is never in an UPDATE
 * payload; `active` is only ever changed through `setRecurringActive`.
 *
 * RLS / triggers (from the STEP 16-G2-D audit): recurring_rules_* policies
 * permit any household member (owner OR member) to SELECT / INSERT /
 * UPDATE; the INSERT trigger forces `created_by = auth.uid()`; the UPDATE
 * trigger freezes id/household_id/created_by/created_at and auto-touches
 * updated_at; `authenticated` has NO DELETE grant / NO DELETE policy, so a
 * hard delete is impossible — every "delete" here is an UPDATE of
 * deleted_at.
 *
 * Session identity: every write re-checks the live session and refuses if
 * it no longer matches `expectedUserId` (same HARDEN as card/budget/
 * category/planned).
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { classifyWriteReadError, isTransportError } from '@/lib/transportError';
import {
  buildRecurringInsert,
  buildRecurringUpdate,
  isValidRecurringDraft,
  type NewRecurringDraft,
  type RecurringInsertRow,
} from '@/lib/remoteRecurringWriteMapping';

export type RecurringWriteReason =
  | 'identity'
  | 'invalid'
  | 'conflict'
  | 'deleted'
  | 'gone'
  | 'error';

/**
 * `transport: true` (STEP 16-H2-D0, mirrors STEP 16-H2-C2-0 for card /
 * category / budget) marks a NETWORK/TRANSPORT failure of a recurring-rule
 * write — the request never reached a server verdict — as opposed to a
 * 23505, an RLS/PGRST verdict, or a successful-but-empty reconcile read.
 * ONLY a `transport` failure is safe for a future Offline Write Queue to
 * enqueue. Additive/optional; existing `res.ok`/`res.reason` callers are
 * unaffected. This D0 step adds the flag ONLY — no queue wiring.
 */
export type CreateRecurringResult =
  | { ok: true; id: string }
  | { ok: false; reason: RecurringWriteReason; message: string; transport?: boolean };

export type UpdateRecurringResult =
  | { ok: true; updatedAt: string }
  | { ok: false; reason: RecurringWriteReason; message: string; transport?: boolean };

export type SoftDeleteRecurringResult =
  | { ok: true }
  | {
      ok: false;
      reason: Exclude<RecurringWriteReason, 'invalid' | 'deleted'>;
      message: string;
      transport?: boolean;
    };

const GENERIC_ERROR = '반복 항목을 저장하지 못했어요. 잠시 후 다시 시도해주세요.';
const IDENTITY_CHANGED = '로그인 정보가 변경됐어요. 다시 시도해 주세요.';
const RELOGIN = '다시 로그인해 주세요.';
const INVALID = '반복 항목 정보를 확인해 주세요.';
const EDIT_CONFLICT = '다른 곳에서 변경됐거나 삭제된 반복 항목이에요. 최신 내용을 불러올게요.';

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

/**
 * Does a row read back after a 23505 represent the SAME create, by the SAME
 * user, still ACTIVE? A soft-deleted row (`deleted_at != null`) or one with
 * `active !== true` is NOT a match — that is an id collision, never an
 * idempotent success (STEP 16-G2-D2 §4-CREATE).
 */
function isSameCreateRow(
  existing: Record<string, unknown>,
  row: RecurringInsertRow,
  expectedUserId: string,
): boolean {
  return (
    existing.deleted_at == null &&
    existing.active === true &&
    existing.created_by === expectedUserId &&
    existing.household_id === row.household_id &&
    existing.type === row.type &&
    existing.name === row.name &&
    existing.amount === row.amount &&
    existing.category === row.category &&
    existing.frequency === row.frequency &&
    existing.day_of_month === row.day_of_month &&
    existing.day_of_week === row.day_of_week
  );
}

/** Does the stored row already hold exactly what this edit would write? */
function recurringFieldsMatch(
  existing: Record<string, unknown>,
  row: ReturnType<typeof buildRecurringUpdate>,
): boolean {
  return (
    existing.name === row.name &&
    existing.amount === row.amount &&
    existing.category === row.category &&
    existing.frequency === row.frequency &&
    existing.day_of_month === row.day_of_month &&
    existing.day_of_week === row.day_of_week
  );
}

export async function createRecurring(args: {
  /** Client-generated `rec-...` id, stable across retries of ONE form mount. */
  id: string;
  householdId: string;
  expectedUserId: string;
  draft: NewRecurringDraft;
}): Promise<CreateRecurringResult> {
  if (!isValidRecurringDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const row = buildRecurringInsert(args.draft, {
    id: args.id,
    householdId: args.householdId,
  });

  const { data, error } = await supabase
    .from('recurring_rules')
    .insert(row) // `active` omitted -> DB default true; `created_by` set by trigger
    .select('id')
    .single();

  if (!error && data?.id) return { ok: true, id: data.id as string };

  if (error?.code === '23505') {
    const { data: existing, error: readErr } = await supabase
      .from('recurring_rules')
      .select(
        'id,household_id,created_by,type,name,amount,category,frequency,day_of_month,day_of_week,active,deleted_at',
      )
      .eq('household_id', args.householdId)
      .eq('id', args.id)
      .maybeSingle();

    // STEP 16-H2-D0: a TRANSPORT failure during the 23505 reconcile read is
    // retryable; a non-transport read error stays terminal; a successful
    // empty read stays terminal.
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
    // Different payload, different author, soft-deleted, or paused -> a real
    // id collision. Never a blind success, never a revive.
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

export async function updateRecurring(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured at form MOUNT — never re-parsed. */
  expectedUpdatedAt: string;
  draft: NewRecurringDraft;
}): Promise<UpdateRecurringResult> {
  if (!isValidRecurringDraft(args.draft)) {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  // { name, amount, category, frequency, day_of_month, day_of_week } —
  // no type, no active, no last_run, no identity.
  const row = buildRecurringUpdate(args.draft);

  const { data, error } = await supabase
    .from('recurring_rules')
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

  // 0 rows — reconcile against the authoritative row.
  const { data: existing, error: readErr } = await supabase
    .from('recurring_rules')
    .select('name,amount,category,frequency,day_of_month,day_of_week,deleted_at,updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-D0: transport read failure -> retryable (transport:true);
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

  const existingRow = existing as Record<string, unknown>;
  if (existingRow.deleted_at != null) {
    return { ok: false, reason: 'deleted', message: EDIT_CONFLICT };
  }
  if (recurringFieldsMatch(existingRow, row)) {
    // Our earlier edit already landed; the response was lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

/**
 * 정지/재개 toggle. Writes `{ active }` and NOTHING else — never `last_run`,
 * never a schedule field. Same updated_at + deleted_at guard as an edit.
 */
export async function setRecurringActive(args: {
  householdId: string;
  recurringId: string;
  expectedUserId: string;
  active: boolean;
  /** RAW PostgREST timestamptz string captured BEFORE the toggle — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<UpdateRecurringResult> {
  if (typeof args.active !== 'boolean') {
    return { ok: false, reason: 'invalid', message: INVALID };
  }
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('recurring_rules')
    .update({ active: args.active })
    .eq('household_id', args.householdId)
    .eq('id', args.recurringId)
    .eq('updated_at', args.expectedUpdatedAt)
    .is('deleted_at', null)
    .select('id, active, updated_at')
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
    .from('recurring_rules')
    .select('active, deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.recurringId)
    .maybeSingle();

  // STEP 16-H2-D0: transport read failure -> retryable (transport:true).
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
  if (existingRow.active === args.active) {
    // Already in the desired state — our earlier toggle landed, response lost.
    return { ok: true, updatedAt: existingRow.updated_at as string };
  }
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}

export async function softDeleteRecurring(args: {
  id: string;
  householdId: string;
  expectedUserId: string;
  /** RAW PostgREST timestamptz string captured BEFORE the confirm Alert — never re-parsed. */
  expectedUpdatedAt: string;
}): Promise<SoftDeleteRecurringResult> {
  const live = await assertLiveUser(args.expectedUserId);
  if (!live.ok) return { ok: false, reason: 'identity', message: live.message };

  const { data, error } = await supabase
    .from('recurring_rules')
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
    .from('recurring_rules')
    .select('deleted_at, updated_at')
    .eq('household_id', args.householdId)
    .eq('id', args.id)
    .maybeSingle();

  // STEP 16-H2-D0: transport read failure -> retryable (transport:true).
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
  // Still active but our updated_at no longer matches — someone edited it first.
  return { ok: false, reason: 'conflict', message: EDIT_CONFLICT };
}
