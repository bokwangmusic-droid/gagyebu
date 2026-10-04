/**
 * Local input draft -> `public.recurring_rules` INSERT / UPDATE row —
 * STEP 16-G2-D2.
 *
 * The recurring-rule counterpart of src/lib/remotePlannedWriteMapping.ts.
 * Pure transform: no Supabase, no AsyncStorage, no React state.
 *
 * `public.recurring_rules` has a client-generated TEXT primary key `id`
 * plus `unique(household_id, id)`, so a 23505 on INSERT can ONLY be that
 * exact `(household_id, id)` already existing — a lost-response retry.
 * There is NO natural-key uniqueness, so this mapper never tries to
 * "revive" a soft-deleted row — a new rule is always a brand-new `rec-...`
 * id (STEP 16-G2-D2 §4-CREATE).
 *
 * ---- deliberately NOT in any payload (STEP 16-G2-D2 §3) ----
 *   - created_by : server-forced by the INSERT trigger to auth.uid(), and
 *                  frozen on UPDATE — never sent from the client.
 *   - created_at / updated_at : server-managed (default now() on INSERT,
 *                  auto-touch on UPDATE).
 *   - deleted_at : soft-delete is its own service call.
 *   - last_run : auto-generation bookkeeping — NEVER written by any client
 *                path in this STEP (create / update / toggle / delete).
 *   - id / household_id : on UPDATE they are `.eq(...)` filters and are
 *                  trigger-locked, so they never belong in the PATCH body.
 *   - type : allowed by the schema on UPDATE, but PRODUCT-IMMUTABLE after
 *            create (STEP 16-G2-D2 §0.3) — `buildRecurringUpdate` never
 *            emits it, so an edit can never silently flip income<->expense.
 *   - active : NOT part of the edit payload — `active` on/off has its own
 *            `setRecurringActive` service action (STEP 16-G2-D2 §0.4).
 *            `buildRecurringInsert` also omits it so the DB default `true`
 *            applies.
 *
 * frequency <-> day columns: exactly ONE of `day_of_month` / `day_of_week`
 * is ever meaningful, and the other is written as an explicit `null` on
 * both INSERT and UPDATE so switching 매월 <-> 매주 always clears the stale
 * value (STEP 16-G2-D2 §3).
 *
 * 결제수단 / 입금처 (결제수단 연결 BATCH): payment_method / card_id /
 * source_asset_id / destination_asset_id, kept or NULL-ed by the SAME rules
 * transactions use (src/lib/paymentLink.ts). INSERT always sends all four.
 * UPDATE sends them only when the draft carries `paymentMethod` (a value or
 * an explicit `null` = "none") — a draft without the key (an offline
 * UPDATE queued by a build that predates this) leaves the stored link as is.
 */
import type { TxnType } from '@/data/categories';
import { paymentLinkColumns } from '@/lib/paymentLink';
import type { Frequency, PaymentMethod } from '@/store/types';

const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'debit', 'credit', 'transfer', 'other'];

/**
 * What the recurring-rule form produces. Purely the user-editable shape —
 * carries no id, no household id, no ownership/identity/timestamp field,
 * and no `active` (that is toggled separately). `type` is only meaningful
 * on create; on edit it is the row's existing (immutable) value, carried
 * so the validator can still accept the draft.
 */
export interface NewRecurringDraft {
  type: TxnType;
  name: string;
  amount: number;
  category: string;
  frequency: Frequency;
  /** Read only when `frequency === 'monthly'`. Integer 1–31. */
  dayOfMonth: number | null;
  /** Read only when `frequency === 'weekly'`. Integer 0 (일) – 6 (토). */
  dayOfWeek: number | null;
  /** 결제수단 (지출) / 입금 방식 (수입). `null` = none; absent = "not edited" (see header). */
  paymentMethod?: PaymentMethod | null;
  /** 신용/체크카드 (지출). A 체크카드 rule stores the card only — no account snapshot. */
  cardId?: string;
  /** 이체 출금 계좌 (지출). */
  sourceAssetId?: string;
  /** 입금처 계좌 (수입, 'transfer'). */
  destinationAssetId?: string;
}

/** The payment-link columns for a draft (paymentLink.ts rules). */
function recurringLinkColumns(draft: NewRecurringDraft) {
  return paymentLinkColumns(draft.type, {
    paymentMethod: draft.paymentMethod ?? undefined,
    cardId: draft.cardId,
    sourceAssetId: draft.sourceAssetId,
    destinationAssetId: draft.destinationAssetId,
  });
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * Client-side guard — never lean on the DB CHECK / NOT-NULL for UX
 * (STEP 16-G2-D2 §3). Shared by CREATE and UPDATE; `type` is validated in
 * both cases (the form always carries a real type) even though the UPDATE
 * mapper never emits it. Only the day field that matches `frequency` is
 * required to be valid.
 */
export function isValidRecurringDraft(draft: NewRecurringDraft): boolean {
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) return false;
  if (typeof draft.amount !== 'number' || !Number.isFinite(draft.amount) || draft.amount <= 0) {
    return false;
  }
  if (typeof draft.category !== 'string' || draft.category.trim().length === 0) return false;
  if (draft.type !== 'income' && draft.type !== 'expense') return false;
  if (draft.frequency !== 'monthly' && draft.frequency !== 'weekly') return false;
  if (draft.frequency === 'monthly') {
    if (!isInt(draft.dayOfMonth) || draft.dayOfMonth < 1 || draft.dayOfMonth > 31) return false;
  } else {
    if (!isInt(draft.dayOfWeek) || draft.dayOfWeek < 0 || draft.dayOfWeek > 6) return false;
  }
  if (draft.paymentMethod != null && !PAYMENT_METHODS.includes(draft.paymentMethod)) return false;
  for (const id of [draft.cardId, draft.sourceAssetId, draft.destinationAssetId]) {
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) return false;
  }
  return true;
}

export interface BuildRecurringInsertContext {
  /** Client-generated `rec-...` id (src/lib/id.ts), fixed for one form mount. */
  id: string;
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
}

/** The exact column set sent to `public.recurring_rules` on INSERT. */
export interface RecurringInsertRow {
  id: string;
  household_id: string;
  type: TxnType;
  name: string;
  amount: number;
  category: string;
  frequency: Frequency;
  day_of_month: number | null;
  day_of_week: number | null;
  payment_method: PaymentMethod | null;
  card_id: string | null;
  source_asset_id: string | null;
  destination_asset_id: string | null;
}

export function buildRecurringInsert(
  draft: NewRecurringDraft,
  ctx: BuildRecurringInsertContext,
): RecurringInsertRow {
  const monthly = draft.frequency === 'monthly';
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    type: draft.type,
    name: draft.name.trim(),
    amount: draft.amount,
    category: draft.category,
    frequency: draft.frequency,
    day_of_month: monthly ? draft.dayOfMonth : null,
    day_of_week: monthly ? null : draft.dayOfWeek,
    ...recurringLinkColumns(draft),
  };
}

/**
 * The PATCH body for an existing recurring rule. ONLY the user-editable
 * schedule fields — NEVER `type`, `active`, `id`, `household_id`,
 * `last_run`, or any server/identity column.
 */
export interface RecurringUpdateRow {
  name: string;
  amount: number;
  category: string;
  frequency: Frequency;
  day_of_month: number | null;
  day_of_week: number | null;
  /* The four link columns travel together — all present or all omitted. */
  payment_method?: PaymentMethod | null;
  card_id?: string | null;
  source_asset_id?: string | null;
  destination_asset_id?: string | null;
}

export function buildRecurringUpdate(draft: NewRecurringDraft): RecurringUpdateRow {
  const monthly = draft.frequency === 'monthly';
  return {
    name: draft.name.trim(),
    amount: draft.amount,
    category: draft.category,
    frequency: draft.frequency,
    day_of_month: monthly ? draft.dayOfMonth : null,
    day_of_week: monthly ? null : draft.dayOfWeek,
    ...(draft.paymentMethod !== undefined ? recurringLinkColumns(draft) : {}),
  };
}
