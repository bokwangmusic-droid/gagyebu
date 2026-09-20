/**
 * Local input draft -> `public.assets` INSERT / UPDATE row — 전체자산/순자산
 * STEP 4.
 *
 * The asset counterpart of src/lib/remoteCardWriteMapping.ts. Pure
 * transform: no Supabase, no AsyncStorage, no React state. Takes a
 * UI-shaped `NewAssetDraft` plus the trusted context the form can't be
 * allowed to put in the draft itself (the client-generated id, the active
 * household id) and returns exactly the snake_case row
 * `supabase.from('assets').insert(...)` / `.update(...)` should send.
 *
 * ---- deliberately NOT in either payload (mirrors cards §7/§8) ----
 *   - created_by : server-forced by private.trg_lock_identity() to
 *                  auth.uid() on INSERT, and immutable on UPDATE — never
 *                  sent from the client.
 *   - created_at / updated_at : server-managed (default now() on INSERT,
 *                  private.trg_touch_updated_at() on UPDATE).
 *   - deleted_at : soft-delete is its own service call, never a plain
 *                  create/edit — omitted here entirely.
 *   - id / household_id : on UPDATE they are addressed by `.eq(...)`
 *                  filters and are server-locked by trg_lock_identity(), so
 *                  they never belong in the PATCH body.
 *
 * `balance` validation follows the loans convention (src/lib/
 * remoteLoanWriteMapping.ts's `isValidLoanDraft`), not the DB CHECK alone:
 * this app's money fields are always a whole-won INTEGER at the client
 * boundary even though the column itself is `numeric`. Reusing `isInt()`
 * (which is `false` for `NaN`/`Infinity`/non-integers) covers the "block
 * NaN/Infinity" requirement and the "balance >= 0" requirement with the
 * SAME check — no separate `Number.isFinite` guard needed on top.
 */
import type { AssetType } from '@/store/types';

/**
 * What the asset form produces. Purely the user-editable shape — carries no
 * id, no household id, no ownership/identity/timestamp field.
 */
export interface NewAssetDraft {
  name: string;
  type: AssetType;
  /** Won, integer, >= 0 — see file header for why `isInt` alone is enough. */
  balance: number;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

const ASSET_TYPES: readonly AssetType[] = ['cash', 'bank', 'savings', 'investment', 'other'];

/**
 * Client-side guard — never lean on the DB CHECK alone for UX (mirrors
 * `isValidLoanDraft`). Shared by CREATE and UPDATE.
 */
export function isValidAssetDraft(draft: NewAssetDraft): boolean {
  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) return false;
  if (!ASSET_TYPES.includes(draft.type)) return false;
  if (!isInt(draft.balance) || draft.balance < 0) return false;
  return true;
}

export interface BuildAssetInsertContext {
  /** Client-generated `asset-...` id (src/lib/id.ts), fixed for one form mount. */
  id: string;
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
}

/** The exact column set sent to `public.assets` on INSERT. */
export interface AssetInsertRow {
  id: string;
  household_id: string;
  name: string;
  type: AssetType;
  balance: number;
}

export function buildAssetInsert(
  draft: NewAssetDraft,
  ctx: BuildAssetInsertContext,
): AssetInsertRow {
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    name: draft.name.trim(),
    type: draft.type,
    balance: draft.balance,
  };
}

/**
 * The PATCH body for an existing asset. ONLY the user-editable columns —
 * NEVER `id`, `household_id`, or any server/identity column.
 */
export interface AssetUpdateRow {
  name: string;
  type: AssetType;
  balance: number;
}

export function buildAssetUpdate(draft: NewAssetDraft): AssetUpdateRow {
  return {
    name: draft.name.trim(),
    type: draft.type,
    balance: draft.balance,
  };
}
