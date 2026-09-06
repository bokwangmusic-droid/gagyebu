/**
 * Local input draft -> `public.transactions` INSERT row — STEP 16-G2-A.
 *
 * The OUTBOUND counterpart of src/lib/remoteFinanceMapping.ts (which goes
 * remote -> local read model). Pure transform: no Supabase, no AsyncStorage,
 * no React state. Takes a UI-shaped `NewTransactionDraft` plus the trusted
 * context the form can't be allowed to put in the draft itself (the
 * client-generated id, the active household id, the set of the household's
 * own card ids) and returns exactly the snake_case row
 * `supabase.from('transactions').insert(...)` should send.
 *
 * ---- deliberately NOT in the payload (STEP 16-G2-A2 §6/§8) ----
 *   - created_by  : server-forced by private.trg_lock_identity() to
 *                   auth.uid() on INSERT — never sent from the client.
 *   - member_id   : always null this STEP. created_by answers "who created
 *                   this row"; member_id is a future "which household member
 *                   is this transaction attributed to" field, and the input
 *                   UI has no member picker, so its meaning is left
 *                   undecided rather than silently set to the current user.
 *   - created_at / updated_at / deleted_at : server-managed.
 *   - from_recurring / recurring_occurrence_date / from_planned : this is a
 *     manual transaction; provenance columns stay null (and the
 *     transactions_recurring_fields_together CHECK is satisfied by all-null).
 *
 * A `cardId` that isn't among the household's current (non-deleted) cards is
 * sent as `card_id: null` — same "카드 미지정" semantics the read mapping
 * and the import RPC already use for a dangling card reference.
 */
import type { TxnType } from '@/data/categories';
import type { PaymentMethod, TransactionSplit } from '@/store/types';

/**
 * What the input form produces. Purely the user-editable shape — carries no
 * id, no household id, no ownership/identity/timestamp field.
 */
export interface NewTransactionDraft {
  type: TxnType;
  category: string;
  amount: number;
  memo: string;
  /** ISO 8601 instant. */
  date: string;
  paymentMethod?: PaymentMethod;
  cardId?: string;
  installment?: { months: number };
  splits?: TransactionSplit[];
}

export interface BuildTransactionInsertContext {
  /** Client-generated `txn-...` id (src/lib/id.ts), fixed for the lifetime of one form. */
  id: string;
  /** The CURRENT trusted active household id — never a cached/previous one. */
  householdId: string;
  /** Ids of the household's own live cards, for the dangling-cardId guard. */
  knownCardIds: ReadonlySet<string>;
}

/**
 * The exact column set sent to `public.transactions`. `member_id` is typed
 * as the literal `null` and `tags` as `null` on purpose — this STEP never
 * writes either.
 */
export interface TransactionInsertRow {
  id: string;
  household_id: string;
  member_id: null;
  type: TxnType;
  category: string;
  amount: number;
  memo: string;
  date: string;
  payment_method: PaymentMethod | null;
  card_id: string | null;
  installment_months: number | null;
  splits: TransactionSplit[] | null;
  tags: null;
}

export function buildTransactionInsert(
  draft: NewTransactionDraft,
  ctx: BuildTransactionInsertContext,
): TransactionInsertRow {
  const cardId =
    draft.cardId && ctx.knownCardIds.has(draft.cardId) ? draft.cardId : null;

  return {
    id: ctx.id,
    household_id: ctx.householdId,
    member_id: null,
    type: draft.type,
    category: draft.category,
    amount: draft.amount,
    memo: draft.memo,
    date: draft.date,
    payment_method: draft.paymentMethod ?? null,
    card_id: cardId,
    installment_months: draft.installment?.months ?? null,
    splits: draft.splits && draft.splits.length > 0 ? draft.splits : null,
    tags: null,
  };
}

/* ================================================================== *
 * UPDATE — STEP 16-G2-B
 *
 * The PATCH body for an existing transaction. ONLY the user-editable
 * financial columns. Everything else is left out of the object entirely so
 * PostgREST never touches it:
 *   - id / household_id : addressed by `.eq(...)` filters, never the body
 *   - created_by / created_at : server-locked by private.trg_lock_identity()
 *   - updated_at : server-forced to now() by private.trg_touch_updated_at()
 *   - deleted_at : soft-delete is its own service, never a plain edit
 *   - from_recurring / from_planned / recurring_occurrence_date :
 *     server-locked by private.trg_lock_transaction_provenance()
 *   - member_id / tags : no editor in the UI — OMITTED (not null-ed) so the
 *     stored value is preserved
 *
 * A feature turned OFF during an edit is sent as an explicit `null`
 * (splits / card_id / installment_months), so the previous value is
 * cleared rather than left behind.
 * ================================================================== */

export interface BuildTransactionUpdateContext {
  knownCardIds: ReadonlySet<string>;
}

export interface TransactionUpdateRow {
  type: TxnType;
  category: string;
  amount: number;
  memo: string;
  date: string;
  payment_method: PaymentMethod | null;
  card_id: string | null;
  installment_months: number | null;
  splits: TransactionSplit[] | null;
}

export function buildTransactionUpdate(
  draft: NewTransactionDraft,
  ctx: BuildTransactionUpdateContext,
): TransactionUpdateRow {
  const cardId =
    draft.cardId && ctx.knownCardIds.has(draft.cardId) ? draft.cardId : null;

  return {
    type: draft.type,
    category: draft.category,
    amount: draft.amount,
    memo: draft.memo,
    date: draft.date,
    payment_method: draft.paymentMethod ?? null,
    card_id: cardId,
    installment_months: draft.installment?.months ?? null,
    splits: draft.splits && draft.splits.length > 0 ? draft.splits : null,
  };
}
