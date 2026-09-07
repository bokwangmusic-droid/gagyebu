/**
 * Local input draft -> `public.custom_categories` INSERT / UPDATE row —
 * STEP 16-G2-C4-B.
 *
 * The custom-category counterpart of src/lib/remoteBudgetWriteMapping.ts.
 * Pure transform: no Supabase, no AsyncStorage, no React state.
 *
 * `public.custom_categories` has a client-generated TEXT primary key `id`
 * (no db default, no `unique(household_id, id)`), a `type` CHECK
 * (`income` | `expense`), and NOT-NULL `name` / `bg` / `color` / `icon`.
 * There is NO name uniqueness constraint — duplicate-name prevention is a
 * client concern only (STEP 16-G2-C4-B §8).
 *
 * ---- deliberately NOT in any payload (STEP 16-G2-C4-B §6) ----
 *   - created_by : server-forced by private.trg_lock_identity() to
 *                  auth.uid() on INSERT, immutable on UPDATE.
 *   - created_at / updated_at : server-managed.
 *   - deleted_at : soft-delete is its own service call.
 *   - id / household_id : on UPDATE they are `.eq(...)` filters and are
 *                  trigger-locked.
 *   - type : allowed by schema on UPDATE, but PRODUCT-IMMUTABLE after
 *            create (§2/§16/§18) — `buildCustomCategoryUpdate` never emits
 *            it, so a rename can never silently move a category's type and
 *            orphan its transactions/budgets.
 */
import { CAT_COLOR_PALETTE, CAT_ICON_PALETTE, type IconKey, type TxnType } from '@/data/categories';

/** UI-editable shape per category. `type` is only meaningful on create. */
export interface NewCustomCategoryDraft {
  type: TxnType;
  name: string;
  /** One of CAT_ICON_PALETTE. */
  icon: IconKey;
  /** bg + color are a MATCHED pair taken from CAT_COLOR_PALETTE. */
  bg: string;
  color: string;
}

/** Same 12-char cap the add UI has always enforced. */
export const MAX_CATEGORY_NAME = 12;

export function normalizeCategoryName(raw: string): string {
  return raw.trim().slice(0, MAX_CATEGORY_NAME);
}

const ICON_KEYS: ReadonlySet<string> = new Set(CAT_ICON_PALETTE);
const COLOR_PAIRS: ReadonlySet<string> = new Set(
  CAT_COLOR_PALETTE.map((p) => `${p.bg}|${p.color}`),
);

/**
 * Client-side guard — never lean on DB CHECK/NOT-NULL for UX
 * (STEP 16-G2-C4-B §7). `bg`/`color` must be a real CAT_COLOR_PALETTE pair
 * and `icon` a real CAT_ICON_PALETTE key, so a hand-crafted payload can't
 * store garbage strings.
 */
export function isValidCustomCategoryDraft(draft: NewCustomCategoryDraft): boolean {
  if (draft.type !== 'income' && draft.type !== 'expense') return false;
  if (normalizeCategoryName(draft.name).length === 0) return false;
  if (!ICON_KEYS.has(draft.icon)) return false;
  if (!COLOR_PAIRS.has(`${draft.bg}|${draft.color}`)) return false;
  return true;
}

/**
 * case-insensitive, trimmed name-collision check against an existing name
 * list (built-in + live custom of the SAME type). The caller builds
 * `existingNames` from `getAllCats(type, …)` and, when editing, excludes
 * the category's own current name (STEP 16-G2-C4-B §8).
 */
export function isCategoryNameTaken(
  name: string,
  existingNames: readonly string[],
): boolean {
  const norm = name.trim().toLowerCase();
  if (norm.length === 0) return false;
  return existingNames.some((n) => n.trim().toLowerCase() === norm);
}

export interface BuildCustomCategoryInsertContext {
  /** Client-generated `c-...` id (src/lib/id.ts), fixed for one add session. */
  id: string;
  /** CURRENT trusted active household id. */
  householdId: string;
}

export interface CustomCategoryInsertRow {
  id: string;
  household_id: string;
  type: TxnType;
  name: string;
  bg: string;
  color: string;
  icon: string;
}

export function buildCustomCategoryInsert(
  draft: NewCustomCategoryDraft,
  ctx: BuildCustomCategoryInsertContext,
): CustomCategoryInsertRow {
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    type: draft.type,
    name: normalizeCategoryName(draft.name),
    bg: draft.bg,
    color: draft.color,
    icon: draft.icon,
  };
}

/** The PATCH body for an existing custom category. NEVER carries `type`. */
export interface CustomCategoryUpdateRow {
  name: string;
  bg: string;
  color: string;
  icon: string;
}

export function buildCustomCategoryUpdate(
  draft: NewCustomCategoryDraft,
): CustomCategoryUpdateRow {
  return {
    name: normalizeCategoryName(draft.name),
    bg: draft.bg,
    color: draft.color,
    icon: draft.icon,
  };
}
