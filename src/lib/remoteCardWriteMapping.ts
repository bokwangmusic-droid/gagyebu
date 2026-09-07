/**
 * Local input draft -> `public.cards` INSERT / UPDATE row — STEP 16-G2-C2.
 *
 * The card counterpart of src/lib/remoteFinanceWriteMapping.ts. Pure
 * transform: no Supabase, no AsyncStorage, no React state. Takes a
 * UI-shaped `NewCardDraft` plus the trusted context the form can't be
 * allowed to put in the draft itself (the client-generated id, the active
 * household id) and returns exactly the snake_case row
 * `supabase.from('cards').insert(...)` / `.update(...)` should send.
 *
 * ---- deliberately NOT in either payload (STEP 16-G2-C2 §7/§8) ----
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
 * `public.cards` has no `issuer` / `last4` / `member_id` column — the app
 * has never modelled those and this STEP does not add them.
 *
 * Optional fields cleared in the UI are sent as explicit `null`
 * (color_bg / color_fg / payment_day / closing_day) so a previous value is
 * removed rather than left behind — same convention as the transaction
 * UPDATE mapper.
 */

/**
 * What the card form produces. Purely the user-editable shape — carries no
 * id, no household id, no ownership/identity/timestamp field.
 */
export interface NewCardDraft {
  name: string;
  /** { bg, color } from CAT_COLOR_PALETTE; absent = no accent colour. */
  color?: { bg: string; color: string };
  /** 결제일 1–31. */
  paymentDay?: number;
  /** 마감일 1–31. */
  closingDay?: number;
}

export interface BuildCardInsertContext {
  /** Client-generated `card-...` id (src/lib/id.ts), fixed for the lifetime of one form. */
  id: string;
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
}

/** The exact column set sent to `public.cards` on INSERT. */
export interface CardInsertRow {
  id: string;
  household_id: string;
  name: string;
  color_bg: string | null;
  color_fg: string | null;
  payment_day: number | null;
  closing_day: number | null;
}

export function buildCardInsert(
  draft: NewCardDraft,
  ctx: BuildCardInsertContext,
): CardInsertRow {
  return {
    id: ctx.id,
    household_id: ctx.householdId,
    name: draft.name,
    color_bg: draft.color?.bg ?? null,
    color_fg: draft.color?.color ?? null,
    payment_day: draft.paymentDay ?? null,
    closing_day: draft.closingDay ?? null,
  };
}

/* ================================================================== *
 * UPDATE — the PATCH body for an existing card. ONLY the user-editable
 * columns; everything else is left out so PostgREST never touches it.
 * ================================================================== */

export interface CardUpdateRow {
  name: string;
  color_bg: string | null;
  color_fg: string | null;
  payment_day: number | null;
  closing_day: number | null;
}

export function buildCardUpdate(draft: NewCardDraft): CardUpdateRow {
  return {
    name: draft.name,
    color_bg: draft.color?.bg ?? null,
    color_fg: draft.color?.color ?? null,
    payment_day: draft.paymentDay ?? null,
    closing_day: draft.closingDay ?? null,
  };
}
