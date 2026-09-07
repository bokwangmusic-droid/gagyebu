/**
 * Local input draft -> `public.planned_expenses` INSERT / UPDATE row —
 * STEP 16-G2-D1.
 *
 * The planned-expense counterpart of src/lib/remoteCategoryWriteMapping.ts
 * / src/lib/remoteCardWriteMapping.ts. Pure transform: no Supabase, no
 * AsyncStorage, no React state.
 *
 * `public.planned_expenses` has a client-generated TEXT primary key `id`
 * plus `unique(household_id, id)`, so a 23505 on INSERT can ONLY be that
 * exact `(household_id, id)` already existing — a lost-response retry.
 * There is NO natural-key uniqueness (name/date/category are free text), so
 * this mapper never tries to "revive" a soft-deleted row — a new planned
 * item is always a brand-new `p-...` id (STEP 16-G2-D1 §4-A).
 *
 * ---- deliberately NOT in any payload (STEP 16-G2-D1 §3) ----
 *   - created_by : server-forced by the INSERT trigger to auth.uid(), and
 *                  frozen on UPDATE — never sent from the client.
 *   - created_at / updated_at : server-managed (default now() on INSERT,
 *                  auto-touch on UPDATE).
 *   - deleted_at : soft-delete is its own service call, never a plain
 *                  create/edit.
 *   - id / household_id : on UPDATE they are `.eq(...)` filters and are
 *                  trigger-locked, so they never belong in the PATCH body.
 *   - type : allowed by the schema on UPDATE, but PRODUCT-IMMUTABLE after
 *            create (STEP 16-G2-D1 §3/§9) — `buildPlannedUpdate` never
 *            emits it, so an edit can never silently flip income<->expense.
 */
import type { TxnType } from '@/data/categories';

/**
 * What the planned-expense form produces. Purely the user-editable shape —
 * carries no id, no household id, no ownership/identity/timestamp field.
 * `type` is only meaningful on create; on edit it is the row's existing
 * (immutable) value, carried so the validator can still accept the draft.
 */
export interface NewPlannedExpenseDraft {
  name: string;
  amount: number;
  category: string;
  /** Local YYYY-MM-DD (same convention as toDateKey / PlannedExpense.date). */
  date: string;
  memo: string;
  type: TxnType;
}

/** Real calendar date in strict `YYYY-MM-DD` form (round-trips through Date). */
export function isValidDateKey(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * Client-side guard — never lean on the DB CHECK / NOT-NULL for UX
 * (STEP 16-G2-D1 §3). Shared by CREATE and UPDATE; `type` is validated in
 * both cases (the form always carries a real type) even though the UPDATE
 * mapper never emits it.
 */
export function isValidPlannedDraft(draft: NewPlannedExpenseDraft): boolean {
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) return false;
  if (typeof draft.amount !== 'number' || !Number.isFinite(draft.amount) || draft.amount <= 0) {
    return false;
  }
  if (typeof draft.category !== 'string' || draft.category.trim().length === 0) return false;
  if (!isValidDateKey(draft.date)) return false;
  if (typeof draft.memo !== 'string') return false;
  if (draft.type !== 'income' && draft.type !== 'expense') return false;
  return true;
}

export interface BuildPlannedInsertContext {
  /** Client-generated `p-...` id (src/lib/id.ts), fixed for one form mount. */
  id: string;
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
}

/** The exact column set sent to `public.planned_expenses` on INSERT. */
export interface PlannedInsertRow {
  id: string;
  household_id: string;
  name: string;
  amount: number;
  category: string;
  date: string;
  memo: string;
  type: TxnType;
}

export function buildPlannedInsert(
  draft: NewPlannedExpenseDraft,
  ctx: BuildPlannedInsertContext,
): PlannedInsertRow {
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    name: draft.name.trim(),
    amount: draft.amount,
    category: draft.category,
    date: draft.date,
    memo: draft.memo.trim(),
    type: draft.type,
  };
}

/**
 * The PATCH body for an existing planned expense. ONLY the user-editable
 * financial fields — NEVER `type`, `id`, `household_id`, or any
 * server/identity column.
 */
export interface PlannedUpdateRow {
  name: string;
  amount: number;
  category: string;
  date: string;
  memo: string;
}

export function buildPlannedUpdate(draft: NewPlannedExpenseDraft): PlannedUpdateRow {
  return {
    name: draft.name.trim(),
    amount: draft.amount,
    category: draft.category,
    date: draft.date,
    memo: draft.memo.trim(),
  };
}
