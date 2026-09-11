/**
 * Offline Write Queue — pure core. STEP 16-H2-A1, widened in H2-B1, again in
 * STEP 16-H2-C2-A1 (card), STEP 16-H2-C2-B1 (custom category), and again in
 * STEP 16-H2-C2-BUDGET A1 (budget, engine only — see below).
 *
 * NO Supabase, NO AsyncStorage, NO React. Just the record shapes, the
 * validator, the FIFO / idempotent enqueue, the scope filter, and the read
 * overlay. Storage side-effects live in
 * src/services/offlineQueue/persistence.ts; server replay in
 * .../runOp.ts; sequencing in .../flusher.ts.
 *
 * Scope: transaction CREATE/UPDATE/soft-DELETE (H2-A/B) + card
 * CREATE/UPDATE/soft-DELETE (H2-C2-A1) + custom-category CREATE/UPDATE/
 * soft-DELETE (H2-C2-B1, engine only — CREATE/UPDATE get UI wiring in B2,
 * DELETE stays UI-blocked on the Budget queue) + budget CREATE/UPDATE/
 * soft-DELETE (H2-C2-BUDGET A1, ENGINE ONLY — no UI enqueue call site yet;
 * `app/budget-add.tsx` / `app/(tabs)/budget.tsx` / the category-delete->
 * budget-delete chain in `app/categories.tsx` still call
 * `saveBudget`/`softDeleteBudget` directly). `entity` is now
 * `'transaction' | 'card' | 'category' | 'budget'`; `op` is a 3-way union
 * per entity — budget reuses the SAME `create'|'update'|'delete'` union
 * (no new `'save'` op kind) even though the server side is ONE `saveBudget()`
 * function, so `PendingOpKind` and every generic op-kind switch elsewhere
 * (label files, management-view shapes) need no changes.
 * `schemaVersion` STAYS 1 — a stored transaction/card/category queue loads
 * with no migration; a budget record simply has `entity:'budget'`.
 *
 * Budget's natural key is `(household_id, category_id)` — there is NO
 * client-generated surrogate id the way `card-…` / `c-…` ids exist for card/
 * category. So a `PendingBudget*` record's `entityId` IS the plain
 * `category_id` string (scoped by `scope.householdId` like every other
 * record). This is a deliberate, unavoidable difference from card/category —
 * NOT a bug — and it means a budget CREATE/UPDATE conflict against a
 * DIFFERENT household member's row for the SAME category is a real,
 * reachable race (unlike a card/category id collision, which is
 * astronomically unlikely since those ids are client-generated per device).
 *
 * IMPORTANT (H2-C2-A1 §8/§9/§15, H2-C2-B1 §12/§13, H2-C2-BUDGET A1 §5): a
 * pending/failed CARD, CATEGORY, or BUDGET is NEVER folded into
 * `RemoteFinanceData.cards` / `.customCats` / `.categoryMeta` / `.catOrder` /
 * `.budgets` / `.budgetMeta`. `composeFinance` returns card, category, and
 * budget display rows in SEPARATE `cardManagement` / `categoryManagement` /
 * `budgetManagement` collections so the transaction/planned/recurring
 * pickers, stats name resolution, backup and household-import snapshots —
 * and, for budget specifically, `monthlyTotals` / every other finance
 * aggregate that reads `data.budgets` directly — only ever see authoritative
 * server data. No cross-entity chaining is structurally possible.
 *
 * STEP 16-H2 A4.1 (PURE CORE ONLY): adds ONE more variant,
 * `PendingCategoryBudgetDelete` (`entity: 'categoryBudget'`, `op: 'delete'`
 * only) - the durable form of an ATOMIC "custom category + its related
 * budget" soft delete, carrying TWO frozen tokens
 * (`expectedCategoryUpdatedAt`, `expectedBudgetUpdatedAt: string | null`).
 * It is deliberately NOT decomposed into a `PendingCategoryDelete` +
 * `PendingBudgetDelete`; its replay (a later step, A4.2) is ONE
 * `softDeleteCustomCategoryWithBudget()` call. `schemaVersion` STILL 1 - a
 * stored transaction/card/category/budget queue loads with no migration; the
 * new record simply has `entity:'categoryBudget'`. No runOp / coordinator /
 * read-model / projection change lands in A4.1.
 */
import type { Category, CustomCatMap } from '@/data/categories';
import { isValidBudgetDraft, type NewBudgetDraft } from '@/lib/remoteBudgetWriteMapping';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewCustomCategoryDraft } from '@/lib/remoteCategoryWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import {
  isValidPlannedDraft,
  type NewPlannedExpenseDraft,
} from '@/lib/remotePlannedWriteMapping';
import {
  isValidRecurringDraft,
  type NewRecurringDraft,
} from '@/lib/remoteRecurringWriteMapping';
import type { RemoteFinanceData, RemoteTransactionMeta } from '@/lib/remoteFinanceMapping';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
import type { BudgetMap, CreditCard, PlannedExpense, RecurringRule, Transaction } from '@/store/types';

export const QUEUE_SCHEMA_VERSION = 1 as const;
export const MAX_PENDING_WRITES = 200;

/**
 * Transport-failure retry backoff (STEP 16-H2-A2 §10): 5s -> 15s -> 30s ->
 * 60s, then held at 60s. `attempt` is 0-based (0 = the first retry). Pure.
 */
export const FLUSH_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const;
export function computeBackoffDelay(attempt: number): number {
  const i = Math.min(Math.max(0, Math.floor(attempt)), FLUSH_BACKOFF_MS.length - 1);
  return FLUSH_BACKOFF_MS[i];
}

export interface PendingWriteScope {
  userId: string;
  householdId: string;
}

/**
 * Fields common to every queued transaction write. Server-derived values are
 * never stored: `created_by` is set by a DB trigger, `household_id` lives
 * only in `scope`, the transaction id lives only in `entityId`, and the
 * optimistic-concurrency token lives in `expectedUpdatedAt` (UPDATE/DELETE),
 * NOT in `payload`.
 */
export type PendingEntity =
  | 'transaction'
  | 'card'
  | 'category'
  | 'budget'
  | 'categoryBudget'
  | 'planned'
  | 'recurring';

interface PendingWriteBase {
  /** Queue-internal identity — distinct from `entityId` (see the dedup rule). */
  queueId: string;
  schemaVersion: typeof QUEUE_SCHEMA_VERSION;
  scope: PendingWriteScope;
  entity: PendingEntity;
  /** The client-stable `txn-…` / `card-…` id of the row this op targets. */
  entityId: string;
  enqueuedAt: string;
  attemptCount: number;
  lastAttemptAt?: string;
  lastError?: string;
  /**
   * STEP 16-H2-B2 §14: the ORIGINAL service reason for the last TERMINAL
   * failure (`conflict` / `deleted` / `gone` / `identity` / `error`), stored
   * so a restart can rebuild the failed-op UX without parsing `lastError`.
   * Additive optional — schema stays 1; a CREATE record from H2-A2 simply
   * has no such key.
   */
  lastErrorReason?: WriteConflictReason;
}

/** `payload` is exactly what `createTransaction()` is re-handed. */
export interface PendingTransactionCreate extends PendingWriteBase {
  entity: 'transaction';
  op: 'create';
  payload: NewTransactionDraft;
}

/**
 * `payload` is exactly what `updateTransaction({ draft })` is re-handed.
 * `expectedUpdatedAt` is FROZEN at enqueue time — the server version the
 * user was editing — and is NEVER refreshed to a newer token (STEP 16-H2-B1
 * §5); a stale token is what lets a genuine concurrent edit surface as a
 * conflict instead of being silently overwritten. `originalRawCardId` is the
 * transaction's raw DB `card_id` at enqueue time (`transactionMeta.rawCardId`)
 * — needed by `buildTransactionUpdate` to preserve a dangling soft-deleted
 * card link; `null` when the row had no card.
 */
export interface PendingTransactionUpdate extends PendingWriteBase {
  entity: 'transaction';
  op: 'update';
  payload: NewTransactionDraft;
  expectedUpdatedAt: string;
  originalRawCardId: string | null;
}

/**
 * A soft delete — `UPDATE deleted_at` guarded on `expectedUpdatedAt`
 * (frozen, same rule as UPDATE). NO `payload`: there is nothing user-shaped
 * to store.
 */
export interface PendingTransactionDelete extends PendingWriteBase {
  entity: 'transaction';
  op: 'delete';
  expectedUpdatedAt: string;
}

/* -------------------- card records (STEP 16-H2-C2-A1) -------------------- */

/** `payload` is exactly what `createCard({ draft })` is re-handed. `entityId`
 *  is the SAME client `card-…` id the direct `createCard` used, so a
 *  lost-response replay hits the service's 23505 idempotency path (§3). */
export interface PendingCardCreate extends PendingWriteBase {
  entity: 'card';
  op: 'create';
  payload: NewCardDraft;
}

/** `payload` is what `updateCard({ draft })` is re-handed. `expectedUpdatedAt`
 *  is FROZEN from the `cardMeta.updatedAt` the edit screen opened against and
 *  is NEVER refreshed (§4) — a stale token is what turns a concurrent edit
 *  into a `conflict` instead of a blind overwrite. Cards have no
 *  `originalRawCardId` analogue. */
export interface PendingCardUpdate extends PendingWriteBase {
  entity: 'card';
  op: 'update';
  payload: NewCardDraft;
  expectedUpdatedAt: string;
}

/** A soft delete — `softDeleteCard` guarded on the FROZEN `expectedUpdatedAt`
 *  (§5). NO `payload`. Never a hard DELETE. */
export interface PendingCardDelete extends PendingWriteBase {
  entity: 'card';
  op: 'delete';
  expectedUpdatedAt: string;
}

/* ---------------- custom-category records (STEP 16-H2-C2-B1) ---------------- */

/** `payload` is exactly what `createCustomCategory({ draft })` is re-handed —
 *  the UI-editable `NewCustomCategoryDraft` (`type` / `name` / `icon` / `bg` /
 *  `color`). `entityId` is the SAME client `c-…` id the direct
 *  `createCustomCategory` used, so a lost-response replay hits the service's
 *  23505 idempotency path (§5). No `expectedUpdatedAt` — a CREATE has no token. */
export interface PendingCategoryCreate extends PendingWriteBase {
  entity: 'category';
  op: 'create';
  payload: NewCustomCategoryDraft;
}

/** `payload` is what `updateCustomCategory({ draft })` is re-handed. Only
 *  `name` / `bg` / `color` / `icon` are ever written on the server (`type` is
 *  product-immutable — `buildCustomCategoryUpdate` drops it), but the draft
 *  keeps its `type` for the management-only display row. `expectedUpdatedAt`
 *  is FROZEN from the `categoryMeta.updatedAt` the edit sheet opened against
 *  and is NEVER refreshed (§6) — a stale token turns a concurrent edit into a
 *  `conflict`, never a blind overwrite. */
export interface PendingCategoryUpdate extends PendingWriteBase {
  entity: 'category';
  op: 'update';
  payload: NewCustomCategoryDraft;
  expectedUpdatedAt: string;
}

/** A soft delete — `softDeleteCustomCategory` guarded on the FROZEN
 *  `expectedUpdatedAt` (§7). NO `payload`. Never a hard DELETE. The
 *  accompanying budget cleanup is the CALLER's concern and is NOT modelled
 *  here (§30) — this record only removes the category row. */
export interface PendingCategoryDelete extends PendingWriteBase {
  entity: 'category';
  op: 'delete';
  expectedUpdatedAt: string;
}

/* ---------------- budget records (STEP 16-H2-C2-BUDGET A1) ---------------- */

/**
 * `payload` is exactly what `saveBudget({ ... })` is re-handed with
 * `expectedUpdatedAt: null` — the UI-editable `NewBudgetDraft`
 * (`category` / `amount`). `entityId` IS `payload.category` (the natural-key
 * `category_id` — there is no separate client-generated budget id). No
 * `expectedUpdatedAt` — a CREATE has no token, same as card/category.
 */
export interface PendingBudgetCreate extends PendingWriteBase {
  entity: 'budget';
  op: 'create';
  payload: NewBudgetDraft;
}

/**
 * `payload` is what `saveBudget({ ... })` is re-handed with a non-null
 * `expectedUpdatedAt`. `expectedUpdatedAt` is FROZEN from the
 * `budgetMeta.updatedAt` the form snapshot was taken against and is NEVER
 * refreshed — a stale token is what turns a concurrent edit into a
 * `conflict`, never a blind overwrite (same rule as every other UPDATE
 * record in this file).
 */
export interface PendingBudgetUpdate extends PendingWriteBase {
  entity: 'budget';
  op: 'update';
  payload: NewBudgetDraft;
  expectedUpdatedAt: string;
}

/** A soft delete — `softDeleteBudget` guarded on the FROZEN
 *  `expectedUpdatedAt`. NO `payload`. Never a hard DELETE. */
export interface PendingBudgetDelete extends PendingWriteBase {
  entity: 'budget';
  op: 'delete';
  expectedUpdatedAt: string;
}

/* ---- composite category + budget delete (STEP 16-H2 A4.1) ---- */

/**
 * The durable form of an ATOMIC "soft-delete this custom category AND its
 * (optional) related budget" intent. Replayed (A4.2) through ONE call to
 * `softDeleteCustomCategoryWithBudget()` (the
 * `delete_custom_category_with_budget` RPC) — NEVER decomposed into a
 * `PendingCategoryDelete` + `PendingBudgetDelete`. `op` is only ever
 * `'delete'` (there is no composite CREATE/UPDATE).
 *
 * `entityId` IS the `category_id` — the same natural key
 * `PendingCategoryDelete` / `PendingBudget*` use.
 *
 * BOTH tokens are FROZEN at enqueue time and handed to the RPC verbatim on
 * every replay — never recomputed, never refreshed to a newer value (the
 * same rule as every other UPDATE/DELETE record in this file).
 * `expectedBudgetUpdatedAt === null` is an EXPLICIT optimistic-concurrency
 * value meaning "the caller's snapshot had NO active budget for this
 * category at delete-intent time" (a budget that has appeared since is a
 * conflict) — it is NOT "don't care about the budget", and a record that is
 * MISSING the field entirely is malformed (see `validatePendingWrite`).
 */
export interface PendingCategoryBudgetDelete extends PendingWriteBase {
  entity: 'categoryBudget';
  op: 'delete';
  /** FROZEN — `custom_categories.updated_at` at delete-confirm time. */
  expectedCategoryUpdatedAt: string;
  /** FROZEN — `budgets.updated_at` at delete-confirm time, or `null` when
   *  the snapshot had NO active budget for this category. */
  expectedBudgetUpdatedAt: string | null;
}

/* ---------------- planned-expense records (STEP 16-H2-E1) ---------------- */

/**
 * `payload` is exactly what `createPlanned({ draft })` is re-handed — the
 * UI-editable `NewPlannedExpenseDraft` (`name` / `amount` / `category` /
 * `date` / `memo` / `type`). `entityId` is the SAME client `p-…` id the
 * direct `createPlanned` used, so a lost-response replay hits the service's
 * `unique(household_id, id)` 23505 idempotency path. No `expectedUpdatedAt`
 * — a CREATE has no token. `planned_expenses` has NO natural-key
 * uniqueness (name/date/category are free text), so a new planned item is
 * always a brand-new id — this record never "revives" a soft-deleted row.
 */
export interface PendingPlannedCreate extends PendingWriteBase {
  entity: 'planned';
  op: 'create';
  payload: NewPlannedExpenseDraft;
}

/**
 * `payload` is what `updatePlanned({ draft })` is re-handed. Only
 * `name` / `amount` / `category` / `date` / `memo` are ever written on the
 * server (`type` is PRODUCT-IMMUTABLE after create — `buildPlannedUpdate`
 * drops it), but the draft keeps its `type` for the management-only display
 * row and so the shared validator still accepts it. `expectedUpdatedAt` is
 * FROZEN from the `plannedMeta.updatedAt` the edit screen opened against and
 * is NEVER refreshed — a stale token turns a concurrent edit into a
 * `conflict`, never a blind overwrite (same rule as every other UPDATE
 * record in this file).
 */
export interface PendingPlannedUpdate extends PendingWriteBase {
  entity: 'planned';
  op: 'update';
  payload: NewPlannedExpenseDraft;
  expectedUpdatedAt: string;
}

/** A soft delete — `softDeletePlanned` guarded on the FROZEN
 *  `expectedUpdatedAt`. NO `payload`. Never a hard DELETE (the table has no
 *  DELETE grant — every "delete" is an `UPDATE deleted_at`). */
export interface PendingPlannedDelete extends PendingWriteBase {
  entity: 'planned';
  op: 'delete';
  expectedUpdatedAt: string;
}

/* ---------------- recurring-rule records (STEP 16-H2-F1) ---------------- */

/**
 * `payload` is exactly what `createRecurring({ draft })` is re-handed — the
 * UI-editable `NewRecurringDraft` (`type` / `name` / `amount` / `category` /
 * `frequency` / `dayOfMonth` / `dayOfWeek`). `entityId` is the SAME client
 * `rec-…` id the direct `createRecurring` used, so a lost-response replay
 * hits the service's `unique(household_id, id)` 23505 idempotency path. No
 * `expectedUpdatedAt` — a CREATE has no token. No natural-key uniqueness, so
 * this record never "revives" a soft-deleted row — a new rule is always a
 * brand-new id.
 */
export interface PendingRecurringCreate extends PendingWriteBase {
  entity: 'recurring';
  op: 'create';
  payload: NewRecurringDraft;
}

/**
 * A FULL schedule edit — `payload` is what `updateRecurring({ draft })` is
 * re-handed. Only `name` / `amount` / `category` / `frequency` /
 * `dayOfMonth` / `dayOfWeek` are ever written on the server (`type` is
 * product-immutable, `active` has its own action — `buildRecurringUpdate`
 * emits neither), but the draft keeps both for the shared validator / a
 * management-only display row. `updateKind: 'full'` is the discriminant
 * against `PendingRecurringActiveUpdate` — both share
 * `entity:'recurring', op:'update'` (STEP 16-H2-F1 §3/§7: this is
 * DELIBERATE — a full edit and an active toggle on the SAME row dedup-collide
 * instead of stacking as two independent pending writes; a differing
 * `updateKind` for the same id is `existing-pending`, never silently
 * replaced or merged). `expectedUpdatedAt` is FROZEN from the
 * `recurringMeta.updatedAt` the edit screen opened against and is NEVER
 * refreshed — a stale token turns a concurrent edit into a `conflict`, never
 * a blind overwrite.
 */
export interface PendingRecurringUpdate extends PendingWriteBase {
  entity: 'recurring';
  op: 'update';
  updateKind: 'full';
  payload: NewRecurringDraft;
  expectedUpdatedAt: string;
}

/**
 * The 정지/재개 toggle — `payload` is EXACTLY `{ active: boolean }`, nothing
 * else (STEP 16-H2-F1 §5): no schedule field ever rides along on a toggle,
 * mirroring `setRecurringActive`'s own `{ active }`-only PATCH body.
 * `updateKind: 'active'` distinguishes it from a full edit at the SAME
 * dedup identity (`entity:'recurring', op:'update'`, same `entityId`).
 * `expectedUpdatedAt` is FROZEN from the `recurringMeta.updatedAt` captured
 * BEFORE the toggle and is NEVER refreshed.
 */
export interface PendingRecurringActiveUpdate extends PendingWriteBase {
  entity: 'recurring';
  op: 'update';
  updateKind: 'active';
  payload: { active: boolean };
  expectedUpdatedAt: string;
}

/** A soft delete — `softDeleteRecurring` guarded on the FROZEN
 *  `expectedUpdatedAt`. NO `payload`. Never a hard DELETE (no DELETE grant —
 *  every "delete" is an `UPDATE deleted_at`). */
export interface PendingRecurringDelete extends PendingWriteBase {
  entity: 'recurring';
  op: 'delete';
  expectedUpdatedAt: string;
}

export type PendingWrite =
  | PendingTransactionCreate
  | PendingTransactionUpdate
  | PendingTransactionDelete
  | PendingCardCreate
  | PendingCardUpdate
  | PendingCardDelete
  | PendingCategoryCreate
  | PendingCategoryUpdate
  | PendingCategoryDelete
  | PendingBudgetCreate
  | PendingBudgetUpdate
  | PendingBudgetDelete
  | PendingCategoryBudgetDelete
  | PendingPlannedCreate
  | PendingPlannedUpdate
  | PendingPlannedDelete
  | PendingRecurringCreate
  | PendingRecurringUpdate
  | PendingRecurringActiveUpdate
  | PendingRecurringDelete;

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const PAYMENT_METHODS = new Set(['cash', 'debit', 'credit', 'transfer', 'other']);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidDraft(p: unknown): p is NewTransactionDraft {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (d.type !== 'income' && d.type !== 'expense') return false;
  if (!isNonEmptyString(d.category)) return false;
  if (!isFiniteNumber(d.amount) || d.amount <= 0) return false;
  if (typeof d.memo !== 'string') return false;
  if (!isNonEmptyString(d.date)) return false;
  if (d.paymentMethod !== undefined && !PAYMENT_METHODS.has(d.paymentMethod as string)) return false;
  if (d.cardId !== undefined && typeof d.cardId !== 'string') return false;
  if (d.installment !== undefined) {
    const inst = d.installment as Record<string, unknown>;
    if (inst == null || !isFiniteNumber(inst.months)) return false;
  }
  if (d.splits !== undefined) {
    if (!Array.isArray(d.splits)) return false;
    for (const s of d.splits) {
      const sp = s as Record<string, unknown>;
      if (sp == null || !isNonEmptyString(sp.category) || !isFiniteNumber(sp.amount)) return false;
      if (sp.memo !== undefined && typeof sp.memo !== 'string') return false;
    }
  }
  // Server-derived / structural fields must NOT be present in a stored draft.
  if ('id' in d || 'household_id' in d || 'householdId' in d || 'created_by' in d || 'createdBy' in d) {
    return false;
  }
  return true;
}

/**
 * Structural validity for a stored `NewCardDraft`. Only the user-editable
 * shape; any server/identity/timestamp field present -> reject (§6).
 */
function isValidCardDraft(p: unknown): p is NewCardDraft {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (!isNonEmptyString(d.name)) return false;
  if (d.color !== undefined) {
    const c = d.color as Record<string, unknown>;
    if (c == null || typeof c !== 'object') return false;
    if (!isNonEmptyString(c.bg) || !isNonEmptyString(c.color)) return false;
  }
  if (d.paymentDay !== undefined && (!isFiniteNumber(d.paymentDay) || d.paymentDay < 1 || d.paymentDay > 31)) {
    return false;
  }
  if (d.closingDay !== undefined && (!isFiniteNumber(d.closingDay) || d.closingDay < 1 || d.closingDay > 31)) {
    return false;
  }
  if (
    'id' in d ||
    'household_id' in d ||
    'householdId' in d ||
    'created_by' in d ||
    'createdBy' in d ||
    'createdAt' in d ||
    'updatedAt' in d ||
    'updated_at' in d
  ) {
    return false;
  }
  return true;
}

/**
 * Structural validity for a stored `NewCustomCategoryDraft` (STEP 16-H2-C2-B1
 * §9). Only the UI-editable shape — `type` / `name` / `icon` / `bg` / `color`,
 * all non-empty strings, `type` one of income|expense. Palette-exactness is
 * NOT re-checked here (the read model's `bg`/`color`/`icon` are opaque
 * strings) — the write service's own `isValidCustomCategoryDraft` re-runs on
 * every replay. Any server / identity / timestamp / read-model field present
 * -> reject.
 */
function isValidCategoryDraft(p: unknown): p is NewCustomCategoryDraft {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (d.type !== 'income' && d.type !== 'expense') return false;
  if (!isNonEmptyString(d.name)) return false;
  if (!isNonEmptyString(d.icon)) return false;
  if (!isNonEmptyString(d.bg)) return false;
  if (!isNonEmptyString(d.color)) return false;
  if (
    'id' in d ||
    'household_id' in d ||
    'householdId' in d ||
    'created_by' in d ||
    'createdBy' in d ||
    'createdAt' in d ||
    'created_at' in d ||
    'updatedAt' in d ||
    'updated_at' in d ||
    'deleted_at' in d ||
    'custom' in d
  ) {
    return false;
  }
  return true;
}

/**
 * Structural validity for a stored `NewBudgetDraft` (STEP 16-H2-C2-BUDGET A1
 * §7 — reuse the canonical `amount` rule rather than re-deriving one).
 * `category` here is the category_id string (== `entityId`), NOT a display
 * name. Any server / identity / timestamp / natural-key-column field present
 * -> reject; the final `> 0` / finite check is delegated to
 * `isValidBudgetDraft` (src/lib/remoteBudgetWriteMapping.ts) — the SAME
 * function `saveBudget()` itself runs — so the queue can never accept a draft
 * the write service would refuse.
 */
function isValidBudgetPayload(p: unknown): p is NewBudgetDraft {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (!isNonEmptyString(d.category)) return false;
  if (!isFiniteNumber(d.amount)) return false;
  if (
    'id' in d ||
    'household_id' in d ||
    'householdId' in d ||
    'category_id' in d ||
    'created_by' in d ||
    'createdBy' in d ||
    'createdAt' in d ||
    'created_at' in d ||
    'updatedAt' in d ||
    'updated_at' in d ||
    'deleted_at' in d
  ) {
    return false;
  }
  return isValidBudgetDraft({ category: d.category, amount: d.amount });
}

/**
 * Structural validity for a stored `NewPlannedExpenseDraft` (STEP 16-H2-E1
 * §3 — reuse `isValidPlannedDraft` from remotePlannedWriteMapping.ts rather
 * than re-deriving the amount/date/name rules). Only the UI-editable shape —
 * `name` / `amount` / `category` / `date` / `memo` / `type`. Any server /
 * identity / timestamp / soft-delete column present -> reject; the final
 * `amount > 0` / real-calendar-`date` / non-empty-`name` checks are delegated
 * to `isValidPlannedDraft` — the SAME function `createPlanned()` /
 * `updatePlanned()` themselves run — so the queue can never accept a draft
 * the write service would refuse.
 */
function isValidPlannedPayload(p: unknown): p is NewPlannedExpenseDraft {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (!isNonEmptyString(d.name)) return false;
  if (!isFiniteNumber(d.amount)) return false;
  if (!isNonEmptyString(d.category)) return false;
  if (!isNonEmptyString(d.date)) return false;
  if (typeof d.memo !== 'string') return false;
  if (d.type !== 'income' && d.type !== 'expense') return false;
  if (
    'id' in d ||
    'household_id' in d ||
    'householdId' in d ||
    'created_by' in d ||
    'createdBy' in d ||
    'createdAt' in d ||
    'created_at' in d ||
    'updatedAt' in d ||
    'updated_at' in d ||
    'deleted_at' in d
  ) {
    return false;
  }
  return isValidPlannedDraft({
    name: d.name,
    amount: d.amount,
    category: d.category,
    date: d.date,
    memo: d.memo,
    type: d.type,
  });
}

/**
 * Structural validity for a stored `NewRecurringDraft` (STEP 16-H2-F1 §5 —
 * reuse `isValidRecurringDraft` from remoteRecurringWriteMapping.ts rather
 * than re-deriving the amount/day-of-month/day-of-week rules). Only the
 * UI-editable shape — `type` / `name` / `amount` / `category` / `frequency` /
 * `dayOfMonth` / `dayOfWeek`. `active` must NEVER be present (it has its own
 * op — `isValidActiveTogglePayload` below). Any server / identity / timestamp
 * / soft-delete / `last_run` column present -> reject; the final
 * amount>0 / day-range checks are delegated to `isValidRecurringDraft` — the
 * SAME function `createRecurring()` / `updateRecurring()` themselves run.
 */
function isValidRecurringPayload(p: unknown): p is NewRecurringDraft {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (d.type !== 'income' && d.type !== 'expense') return false;
  if (!isNonEmptyString(d.name)) return false;
  if (!isFiniteNumber(d.amount)) return false;
  if (!isNonEmptyString(d.category)) return false;
  if (d.frequency !== 'monthly' && d.frequency !== 'weekly') return false;
  if (!(d.dayOfMonth === null || isFiniteNumber(d.dayOfMonth))) return false;
  if (!(d.dayOfWeek === null || isFiniteNumber(d.dayOfWeek))) return false;
  if (
    'id' in d ||
    'household_id' in d ||
    'householdId' in d ||
    'created_by' in d ||
    'createdBy' in d ||
    'createdAt' in d ||
    'created_at' in d ||
    'updatedAt' in d ||
    'updated_at' in d ||
    'deleted_at' in d ||
    'last_run' in d ||
    'lastRun' in d ||
    'active' in d
  ) {
    return false;
  }
  return isValidRecurringDraft({
    type: d.type,
    name: d.name,
    amount: d.amount,
    category: d.category,
    frequency: d.frequency,
    dayOfMonth: d.dayOfMonth as number | null,
    dayOfWeek: d.dayOfWeek as number | null,
  });
}

/**
 * Structural validity for a stored active-toggle payload — EXACTLY
 * `{ active: boolean }` and nothing else (STEP 16-H2-F1 §5): no schedule
 * field is ever allowed to ride along on a toggle record.
 */
function isValidActiveTogglePayload(p: unknown): p is { active: boolean } {
  if (p == null || typeof p !== 'object') return false;
  const d = p as Record<string, unknown>;
  if (typeof d.active !== 'boolean') return false;
  const keys = Object.keys(d);
  return keys.length === 1 && keys[0] === 'active';
}

/** Returns the record narrowed to `PendingWrite`, or `null` if anything is off. */
export function validatePendingWrite(x: unknown): PendingWrite | null {
  if (x == null || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (r.schemaVersion !== QUEUE_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(r.queueId)) return null;
  if (
    r.entity !== 'transaction' &&
    r.entity !== 'card' &&
    r.entity !== 'category' &&
    r.entity !== 'budget' &&
    r.entity !== 'categoryBudget' &&
    r.entity !== 'planned' &&
    r.entity !== 'recurring'
  ) {
    return null;
  }
  if (r.op !== 'create' && r.op !== 'update' && r.op !== 'delete') return null;
  if (!isNonEmptyString(r.entityId)) return null;
  const scope = r.scope as Record<string, unknown> | undefined;
  if (scope == null || !isNonEmptyString(scope.userId) || !isNonEmptyString(scope.householdId)) return null;
  if (!isNonEmptyString(r.enqueuedAt)) return null;
  if (typeof r.attemptCount !== 'number' || !Number.isInteger(r.attemptCount) || r.attemptCount < 0) return null;
  if (r.lastAttemptAt !== undefined && typeof r.lastAttemptAt !== 'string') return null;
  if (r.lastError !== undefined && typeof r.lastError !== 'string') return null;
  if (r.lastErrorReason !== undefined && typeof r.lastErrorReason !== 'string') return null;

  const base = {
    queueId: r.queueId,
    schemaVersion: QUEUE_SCHEMA_VERSION as typeof QUEUE_SCHEMA_VERSION,
    scope: { userId: scope.userId, householdId: scope.householdId },
    entityId: r.entityId,
    enqueuedAt: r.enqueuedAt,
    attemptCount: r.attemptCount,
    ...(r.lastAttemptAt !== undefined ? { lastAttemptAt: r.lastAttemptAt as string } : {}),
    ...(r.lastError !== undefined ? { lastError: r.lastError as string } : {}),
    ...(r.lastErrorReason !== undefined
      ? { lastErrorReason: r.lastErrorReason as WriteConflictReason }
      : {}),
  };

  if (r.entity === 'card') {
    if (r.op === 'create') {
      if ('expectedUpdatedAt' in r) return null; // a CREATE carries no token (§6)
      if (!isValidCardDraft(r.payload)) return null;
      return { ...base, entity: 'card', op: 'create', payload: r.payload };
    }
    if (r.op === 'update') {
      if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
      if (!isValidCardDraft(r.payload)) return null;
      return { ...base, entity: 'card', op: 'update', payload: r.payload, expectedUpdatedAt: r.expectedUpdatedAt };
    }
    // card delete
    if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
    if ('payload' in r) return null; // a DELETE carries no user payload (§6)
    return { ...base, entity: 'card', op: 'delete', expectedUpdatedAt: r.expectedUpdatedAt };
  }

  if (r.entity === 'category') {
    if (r.op === 'create') {
      if ('expectedUpdatedAt' in r) return null; // a CREATE carries no token (§9)
      if (!isValidCategoryDraft(r.payload)) return null;
      return { ...base, entity: 'category', op: 'create', payload: r.payload };
    }
    if (r.op === 'update') {
      if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
      if (!isValidCategoryDraft(r.payload)) return null;
      return {
        ...base,
        entity: 'category',
        op: 'update',
        payload: r.payload,
        expectedUpdatedAt: r.expectedUpdatedAt,
      };
    }
    // category delete
    if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
    if ('payload' in r) return null; // a DELETE carries no user payload (§9)
    return { ...base, entity: 'category', op: 'delete', expectedUpdatedAt: r.expectedUpdatedAt };
  }

  if (r.entity === 'budget') {
    if (r.op === 'create') {
      if ('expectedUpdatedAt' in r) return null; // a CREATE carries no token
      if (!isValidBudgetPayload(r.payload)) return null;
      return { ...base, entity: 'budget', op: 'create', payload: r.payload };
    }
    if (r.op === 'update') {
      if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
      if (!isValidBudgetPayload(r.payload)) return null;
      return {
        ...base,
        entity: 'budget',
        op: 'update',
        payload: r.payload,
        expectedUpdatedAt: r.expectedUpdatedAt,
      };
    }
    // budget delete
    if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
    if ('payload' in r) return null; // a DELETE carries no user payload
    return { ...base, entity: 'budget', op: 'delete', expectedUpdatedAt: r.expectedUpdatedAt };
  }

  if (r.entity === 'categoryBudget') {
    // STEP 16-H2 A4.1 — composite atomic category+budget delete. ONLY
    // `op: 'delete'`; carries two independently-named frozen tokens and NO
    // `payload` / base `expectedUpdatedAt`.
    if (r.op !== 'delete') return null;
    if ('payload' in r) return null;
    if ('expectedUpdatedAt' in r) return null; // uses the two named tokens, not the base one
    if (!isNonEmptyString(r.expectedCategoryUpdatedAt)) return null;
    // `expectedBudgetUpdatedAt` MUST be present: an explicit `null` is a
    // valid semantic value ("no active budget at delete-intent time"), but a
    // record MISSING the key is malformed.
    if (!('expectedBudgetUpdatedAt' in r)) return null;
    if (r.expectedBudgetUpdatedAt !== null && !isNonEmptyString(r.expectedBudgetUpdatedAt)) {
      return null;
    }
    return {
      ...base,
      entity: 'categoryBudget',
      op: 'delete',
      expectedCategoryUpdatedAt: r.expectedCategoryUpdatedAt,
      expectedBudgetUpdatedAt: r.expectedBudgetUpdatedAt as string | null,
    };
  }

  if (r.entity === 'planned') {
    // STEP 16-H2-E1 — planned-expense CREATE / UPDATE / soft DELETE. Mirrors
    // the `category` branch: CREATE carries no token, UPDATE/DELETE carry a
    // FROZEN `expectedUpdatedAt`, DELETE carries no user payload.
    if (r.op === 'create') {
      if ('expectedUpdatedAt' in r) return null; // a CREATE carries no token (§2)
      if (!isValidPlannedPayload(r.payload)) return null;
      return { ...base, entity: 'planned', op: 'create', payload: r.payload };
    }
    if (r.op === 'update') {
      if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
      if (!isValidPlannedPayload(r.payload)) return null;
      return {
        ...base,
        entity: 'planned',
        op: 'update',
        payload: r.payload,
        expectedUpdatedAt: r.expectedUpdatedAt,
      };
    }
    // planned delete
    if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
    if ('payload' in r) return null; // a DELETE carries no user payload (§2)
    return { ...base, entity: 'planned', op: 'delete', expectedUpdatedAt: r.expectedUpdatedAt };
  }

  if (r.entity === 'recurring') {
    // STEP 16-H2-F1 — recurring-rule CREATE / FULL UPDATE / ACTIVE-toggle
    // UPDATE / soft DELETE. FULL and ACTIVE share `op:'update'` and are
    // distinguished by `updateKind` — an update record MISSING/mismatched
    // `updateKind` is malformed.
    if (r.op === 'create') {
      if ('expectedUpdatedAt' in r) return null; // a CREATE carries no token
      if ('updateKind' in r) return null; // a CREATE carries no updateKind
      if (!isValidRecurringPayload(r.payload)) return null;
      return { ...base, entity: 'recurring', op: 'create', payload: r.payload };
    }
    if (r.op === 'update') {
      if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
      if (r.updateKind === 'full') {
        if (!isValidRecurringPayload(r.payload)) return null;
        return {
          ...base,
          entity: 'recurring',
          op: 'update',
          updateKind: 'full',
          payload: r.payload,
          expectedUpdatedAt: r.expectedUpdatedAt,
        };
      }
      if (r.updateKind === 'active') {
        if (!isValidActiveTogglePayload(r.payload)) return null;
        return {
          ...base,
          entity: 'recurring',
          op: 'update',
          updateKind: 'active',
          payload: r.payload,
          expectedUpdatedAt: r.expectedUpdatedAt,
        };
      }
      return null; // unknown/missing updateKind
    }
    // recurring delete
    if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
    if ('payload' in r) return null; // a DELETE carries no user payload
    if ('updateKind' in r) return null; // a DELETE carries no updateKind
    return { ...base, entity: 'recurring', op: 'delete', expectedUpdatedAt: r.expectedUpdatedAt };
  }

  // ---- transaction ----
  if (r.op === 'create') {
    if (!isValidDraft(r.payload)) return null;
    return { ...base, entity: 'transaction', op: 'create', payload: r.payload };
  }

  if (r.op === 'update') {
    if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
    if (!(r.originalRawCardId === null || typeof r.originalRawCardId === 'string')) return null;
    if (!isValidDraft(r.payload)) return null;
    return {
      ...base,
      entity: 'transaction',
      op: 'update',
      payload: r.payload,
      expectedUpdatedAt: r.expectedUpdatedAt,
      originalRawCardId: r.originalRawCardId as string | null,
    };
  }

  // transaction delete
  if (!isNonEmptyString(r.expectedUpdatedAt)) return null;
  if ('payload' in r) return null; // a DELETE carries no user payload (STEP 16-H2-B1 §7)
  return { ...base, entity: 'transaction', op: 'delete', expectedUpdatedAt: r.expectedUpdatedAt };
}

/** Drop invalid entries, keep valid ones in order. Never throws. */
export function sanitizePendingWrites(raw: unknown): { records: PendingWrite[]; dropped: number } {
  if (!Array.isArray(raw)) return { records: [], dropped: 0 };
  const records: PendingWrite[] = [];
  let dropped = 0;
  for (const item of raw) {
    const v = validatePendingWrite(item);
    if (v) records.push(v);
    else dropped += 1;
  }
  return { records, dropped };
}

/* ------------------------------------------------------------------ *
 * Build + enqueue
 * ------------------------------------------------------------------ */

let localSeq = 0;
function defaultQueueId(): string {
  localSeq = (localSeq + 1) % 1_000_000;
  return `q-${Date.now()}-${localSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const nowIso = () => new Date().toISOString();

export function makePendingTransactionCreate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewTransactionDraft;
  queueId?: string;
  now?: () => string;
}): PendingTransactionCreate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'transaction',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingTransactionUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewTransactionDraft;
  /** FROZEN — the server version the user was editing. Never refreshed. */
  expectedUpdatedAt: string;
  /** transactionMeta.rawCardId at enqueue time; `null` if the row had no card. */
  originalRawCardId: string | null;
  queueId?: string;
  now?: () => string;
}): PendingTransactionUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'transaction',
    op: 'update',
    entityId: args.entityId,
    payload: args.payload,
    expectedUpdatedAt: args.expectedUpdatedAt,
    originalRawCardId: args.originalRawCardId,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingTransactionDelete(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** FROZEN — the server version the user was viewing when they hit delete. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingTransactionDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'transaction',
    op: 'delete',
    entityId: args.entityId,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCardCreate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewCardDraft;
  queueId?: string;
  now?: () => string;
}): PendingCardCreate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'card',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCardUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewCardDraft;
  /** FROZEN — the `cardMeta.updatedAt` the edit screen opened against. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingCardUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'card',
    op: 'update',
    entityId: args.entityId,
    payload: args.payload,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCardDelete(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** FROZEN — the server version the user was viewing when they hit delete. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingCardDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'card',
    op: 'delete',
    entityId: args.entityId,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCategoryCreate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewCustomCategoryDraft;
  queueId?: string;
  now?: () => string;
}): PendingCategoryCreate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'category',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCategoryUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewCustomCategoryDraft;
  /** FROZEN — the `categoryMeta.updatedAt` the edit sheet opened against. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingCategoryUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'category',
    op: 'update',
    entityId: args.entityId,
    payload: args.payload,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCategoryDelete(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** FROZEN — the server version the user was viewing when they hit delete. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingCategoryDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'category',
    op: 'delete',
    entityId: args.entityId,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingBudgetCreate(args: {
  scope: PendingWriteScope;
  /** = payload.category (the category_id natural key). */
  entityId: string;
  payload: NewBudgetDraft;
  queueId?: string;
  now?: () => string;
}): PendingBudgetCreate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'budget',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingBudgetUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewBudgetDraft;
  /** FROZEN — the `budgetMeta.updatedAt` the form snapshot opened against. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingBudgetUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'budget',
    op: 'update',
    entityId: args.entityId,
    payload: args.payload,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingBudgetDelete(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** FROZEN — the server version the user was viewing when they hit delete. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingBudgetDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'budget',
    op: 'delete',
    entityId: args.entityId,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingCategoryBudgetDelete(args: {
  scope: PendingWriteScope;
  /** = the category_id natural key. */
  entityId: string;
  /** FROZEN — `custom_categories.updated_at` the user confirmed delete against. */
  expectedCategoryUpdatedAt: string;
  /** FROZEN — `budgets.updated_at` captured at the SAME moment, or `null`
   *  when the snapshot had no active budget. An explicit `null` is preserved
   *  verbatim (never coerced to `undefined` / a missing key). */
  expectedBudgetUpdatedAt: string | null;
  queueId?: string;
  now?: () => string;
}): PendingCategoryBudgetDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'categoryBudget',
    op: 'delete',
    entityId: args.entityId,
    expectedCategoryUpdatedAt: args.expectedCategoryUpdatedAt,
    expectedBudgetUpdatedAt: args.expectedBudgetUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingPlannedCreate(args: {
  scope: PendingWriteScope;
  /** Client-generated `p-…` id — stable across replays of ONE form mount. */
  entityId: string;
  payload: NewPlannedExpenseDraft;
  queueId?: string;
  now?: () => string;
}): PendingPlannedCreate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'planned',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingPlannedUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewPlannedExpenseDraft;
  /** FROZEN — the `plannedMeta.updatedAt` the edit screen opened against.
   *  Handed to `updatePlanned` verbatim on every replay; never refreshed. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingPlannedUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'planned',
    op: 'update',
    entityId: args.entityId,
    payload: args.payload,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingPlannedDelete(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** FROZEN — the server version the user was viewing when they hit delete. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingPlannedDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'planned',
    op: 'delete',
    entityId: args.entityId,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingRecurringCreate(args: {
  scope: PendingWriteScope;
  /** Client-generated `rec-…` id — stable across replays of ONE form mount. */
  entityId: string;
  payload: NewRecurringDraft;
  queueId?: string;
  now?: () => string;
}): PendingRecurringCreate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'recurring',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingRecurringUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewRecurringDraft;
  /** FROZEN — the `recurringMeta.updatedAt` the edit screen opened against.
   *  Handed to `updateRecurring` verbatim on every replay; never refreshed. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingRecurringUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'recurring',
    op: 'update',
    updateKind: 'full',
    entityId: args.entityId,
    payload: args.payload,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingRecurringActiveUpdate(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** The desired 정지/재개 state — FROZEN as `{ active }`, nothing else. */
  active: boolean;
  /** FROZEN — the `recurringMeta.updatedAt` captured BEFORE the toggle. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingRecurringActiveUpdate {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'recurring',
    op: 'update',
    updateKind: 'active',
    entityId: args.entityId,
    payload: { active: args.active },
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

export function makePendingRecurringDelete(args: {
  scope: PendingWriteScope;
  entityId: string;
  /** FROZEN — the server version the user was viewing when they hit delete. */
  expectedUpdatedAt: string;
  queueId?: string;
  now?: () => string;
}): PendingRecurringDelete {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'recurring',
    op: 'delete',
    entityId: args.entityId,
    expectedUpdatedAt: args.expectedUpdatedAt,
    enqueuedAt: (args.now ?? nowIso)(),
    attemptCount: 0,
  };
}

/** `${userId}|${householdId}|${entity}|${op}|${entityId}` — the dedup identity.
 *  `entity` is part of the key, so a card op and a transaction op that happen
 *  to share an id NEVER collide here (STEP 16-H2-C2-A1 §21). */
function dedupKey(w: Pick<PendingWrite, 'scope' | 'entity' | 'op' | 'entityId'>): string {
  return `${w.scope.userId}|${w.scope.householdId}|${w.entity}|${w.op}|${w.entityId}`;
}

/** Structural equality of two update payloads (order-significant splits). */
function draftEqual(a: NewTransactionDraft, b: NewTransactionDraft): boolean {
  if (
    a.type !== b.type ||
    a.category !== b.category ||
    Number(a.amount) !== Number(b.amount) ||
    a.memo !== b.memo ||
    new Date(a.date).getTime() !== new Date(b.date).getTime() ||
    (a.paymentMethod ?? null) !== (b.paymentMethod ?? null) ||
    (a.cardId ?? null) !== (b.cardId ?? null) ||
    (a.installment?.months ?? null) !== (b.installment?.months ?? null)
  ) {
    return false;
  }
  const sa = a.splits ?? [];
  const sb = b.splits ?? [];
  if (sa.length !== sb.length) return false;
  return sa.every(
    (s, i) =>
      s.category === sb[i].category &&
      Number(s.amount) === Number(sb[i].amount) &&
      (s.memo ?? null) === (sb[i].memo ?? null),
  );
}

/** Structural equality of two card drafts (name / colour / days). */
function cardDraftEqual(a: NewCardDraft, b: NewCardDraft): boolean {
  return (
    a.name === b.name &&
    (a.color?.bg ?? null) === (b.color?.bg ?? null) &&
    (a.color?.color ?? null) === (b.color?.color ?? null) &&
    (a.paymentDay ?? null) === (b.paymentDay ?? null) &&
    (a.closingDay ?? null) === (b.closingDay ?? null)
  );
}

/** Equality of the SERVER-editable custom-category fields (name / bg / color /
 *  icon). `type` is create-only (`buildCustomCategoryUpdate` drops it), so it
 *  is NOT compared here (STEP 16-H2-C2-B1 §10); the CREATE matcher adds it. */
function categoryEditableEqual(a: NewCustomCategoryDraft, b: NewCustomCategoryDraft): boolean {
  return a.name === b.name && a.bg === b.bg && a.color === b.color && a.icon === b.icon;
}

/** Equality of the SERVER-editable planned-expense fields
 *  (`name` / `amount` / `category` / `date` / `memo`). `type` is create-only
 *  (`buildPlannedUpdate` drops it), so it is NOT compared here (STEP
 *  16-H2-E1 §5); the CREATE matcher adds it. Raw values — the two drafts
 *  come from the same form, same as the card/category matchers. */
function plannedEditableEqual(a: NewPlannedExpenseDraft, b: NewPlannedExpenseDraft): boolean {
  return (
    a.name === b.name &&
    Number(a.amount) === Number(b.amount) &&
    a.category === b.category &&
    a.date === b.date &&
    a.memo === b.memo
  );
}

/** Equality of the SERVER-editable recurring-rule schedule fields
 *  (`name` / `amount` / `category` / `frequency` / `dayOfMonth` /
 *  `dayOfWeek`). `type` is create-only (`buildRecurringUpdate` drops it, and
 *  `active` is never part of this shape at all — its own op), so neither is
 *  compared here; the CREATE matcher adds `type`. */
function recurringEditableEqual(a: NewRecurringDraft, b: NewRecurringDraft): boolean {
  return (
    a.name === b.name &&
    Number(a.amount) === Number(b.amount) &&
    a.category === b.category &&
    a.frequency === b.frequency &&
    a.dayOfMonth === b.dayOfMonth &&
    a.dayOfWeek === b.dayOfWeek
  );
}

/**
 * Is `b` the EXACT SAME request as `a` — safe to treat a re-enqueue as an
 * idempotent no-op? Same dedup identity (scope+entity+op+entityId) is assumed.
 *   - transaction CREATE: yes by identity alone (STEP 16-H2-A1 §12).
 *   - transaction UPDATE: also same frozen `expectedUpdatedAt`, same
 *     `originalRawCardId`, same draft.
 *   - card CREATE: identity AND same draft — a DIFFERING card CREATE for the
 *     same id is `existing-pending`, never a silent overwrite (§7/§10).
 *   - card UPDATE: same frozen `expectedUpdatedAt` AND same draft.
 *   - budget CREATE/UPDATE: same as card, but only `amount` can differ
 *     (`category` is fixed by the shared `entityId`).
 *   - DELETE (any entity): same frozen `expectedUpdatedAt`.
 */
function sameRequest(a: PendingWrite, b: PendingWrite): boolean {
  if (a.entity !== b.entity || a.op !== b.op) return false;

  if (a.entity === 'card' && b.entity === 'card') {
    if (a.op === 'create' && b.op === 'create') return cardDraftEqual(a.payload, b.payload);
    if (a.op === 'update' && b.op === 'update') {
      return a.expectedUpdatedAt === b.expectedUpdatedAt && cardDraftEqual(a.payload, b.payload);
    }
    if (a.op === 'delete' && b.op === 'delete') return a.expectedUpdatedAt === b.expectedUpdatedAt;
    return false;
  }

  if (a.entity === 'category' && b.entity === 'category') {
    // CREATE: identity + same draft INCLUDING type (create-only field). A
    // DIFFERING CREATE for the same id is `existing-pending`, never a silent
    // overwrite (§11), mirroring the service's isSameCreateRow.
    if (a.op === 'create' && b.op === 'create') {
      return a.payload.type === b.payload.type && categoryEditableEqual(a.payload, b.payload);
    }
    if (a.op === 'update' && b.op === 'update') {
      return a.expectedUpdatedAt === b.expectedUpdatedAt && categoryEditableEqual(a.payload, b.payload);
    }
    if (a.op === 'delete' && b.op === 'delete') return a.expectedUpdatedAt === b.expectedUpdatedAt;
    return false;
  }

  if (a.entity === 'budget' && b.entity === 'budget') {
    // entityId equality (already established by the shared dedup key) means
    // `payload.category` is identical on both sides — `amount` is the only
    // field that can differ.
    if (a.op === 'create' && b.op === 'create') return Number(a.payload.amount) === Number(b.payload.amount);
    if (a.op === 'update' && b.op === 'update') {
      return a.expectedUpdatedAt === b.expectedUpdatedAt && Number(a.payload.amount) === Number(b.payload.amount);
    }
    if (a.op === 'delete' && b.op === 'delete') return a.expectedUpdatedAt === b.expectedUpdatedAt;
    return false;
  }

  if (a.entity === 'categoryBudget' && b.entity === 'categoryBudget') {
    // op is 'delete' on both (established above). The EXACT same request iff
    // BOTH frozen tokens match: `null === null` is the same request, `null`
    // vs a string is a DIFFERENT request (-> `existing-pending`, never a
    // silent overwrite), and a differing category-only or budget-only token
    // is likewise different.
    if (a.op === 'delete' && b.op === 'delete') {
      return (
        a.expectedCategoryUpdatedAt === b.expectedCategoryUpdatedAt &&
        a.expectedBudgetUpdatedAt === b.expectedBudgetUpdatedAt
      );
    }
    return false;
  }

  if (a.entity === 'planned' && b.entity === 'planned') {
    // CREATE: identity + same draft INCLUDING type (create-only field). A
    // DIFFERING CREATE for the same id is `existing-pending`, never a silent
    // overwrite (§5/§15), mirroring the service's isSameCreateRow.
    if (a.op === 'create' && b.op === 'create') {
      return a.payload.type === b.payload.type && plannedEditableEqual(a.payload, b.payload);
    }
    if (a.op === 'update' && b.op === 'update') {
      return a.expectedUpdatedAt === b.expectedUpdatedAt && plannedEditableEqual(a.payload, b.payload);
    }
    if (a.op === 'delete' && b.op === 'delete') return a.expectedUpdatedAt === b.expectedUpdatedAt;
    return false;
  }

  if (a.entity === 'recurring' && b.entity === 'recurring') {
    // CREATE: identity + same draft INCLUDING type (create-only field). A
    // DIFFERING CREATE for the same id is `existing-pending`, never a silent
    // overwrite, mirroring the service's isSameCreateRow.
    if (a.op === 'create' && b.op === 'create') {
      return a.payload.type === b.payload.type && recurringEditableEqual(a.payload, b.payload);
    }
    if (a.op === 'update' && b.op === 'update') {
      // STEP 16-H2-F1 §7: FULL vs ACTIVE at the SAME entityId is NEVER the
      // same request — a differing `updateKind` refuses as `existing-pending`
      // (never cross-op compaction/merge), even though both share
      // `entity:'recurring', op:'update'` (the dedup identity).
      if (a.updateKind !== b.updateKind) return false;
      if (a.updateKind === 'full' && b.updateKind === 'full') {
        return a.expectedUpdatedAt === b.expectedUpdatedAt && recurringEditableEqual(a.payload, b.payload);
      }
      if (a.updateKind === 'active' && b.updateKind === 'active') {
        return a.expectedUpdatedAt === b.expectedUpdatedAt && a.payload.active === b.payload.active;
      }
      return false;
    }
    if (a.op === 'delete' && b.op === 'delete') return a.expectedUpdatedAt === b.expectedUpdatedAt;
    return false;
  }

  if (a.entity === 'transaction' && b.entity === 'transaction') {
    if (a.op === 'create') return true;
    if (a.op === 'update' && b.op === 'update') {
      return (
        a.expectedUpdatedAt === b.expectedUpdatedAt &&
        a.originalRawCardId === b.originalRawCardId &&
        draftEqual(a.payload, b.payload)
      );
    }
    if (a.op === 'delete' && b.op === 'delete') {
      return a.expectedUpdatedAt === b.expectedUpdatedAt;
    }
  }
  return false;
}

export type EnqueueResult =
  | { ok: true; queue: PendingWrite[]; record: PendingWrite; deduped: boolean }
  | { ok: false; reason: 'cap' | 'existing-pending'; queue: PendingWrite[] };

/**
 * Append `record` to `queue` (FIFO). Pure — returns a new array.
 *
 *  - An entry with the same `queueId` OR the same dedup identity already
 *    exists:
 *      · if it is the EXACT same request (`sameRequest`) -> idempotent
 *        no-op: queue unchanged, EXISTING record returned, `deduped: true`.
 *      · otherwise (a DIFFERING pending op for the same row — a changed
 *        UPDATE/DELETE token or payload, or a differing card CREATE draft)
 *        -> REFUSED with `reason: 'existing-pending'`. The existing record is
 *        NEVER silently overwritten or dropped, and no compaction across ops
 *        (CREATE→UPDATE, UPDATE→DELETE, …) is attempted (H2-B1 §8/§20,
 *        H2-C2-A1 §7).
 *  - Cap: at `MAX_PENDING_WRITES` a genuinely new record is refused
 *    (`reason: 'cap'`) — the oldest entry is NEVER evicted.
 */
export function enqueuePendingWrite(
  queue: readonly PendingWrite[],
  record: PendingWrite,
): EnqueueResult {
  const key = dedupKey(record);
  const existing = queue.find((q) => q.queueId === record.queueId || dedupKey(q) === key);
  if (existing) {
    if (sameRequest(existing, record)) {
      return { ok: true, queue: queue.slice(), record: existing, deduped: true };
    }
    return { ok: false, reason: 'existing-pending', queue: queue.slice() };
  }
  if (queue.length >= MAX_PENDING_WRITES) {
    return { ok: false, reason: 'cap', queue: queue.slice() };
  }
  return { ok: true, queue: [...queue, record], record, deduped: false };
}

/* ------------------------------------------------------------------ *
 * Scope filter
 * ------------------------------------------------------------------ */

/**
 * Only the ops whose scope matches BOTH ids exactly, in original order.
 * Other-scope records are returned by NOTHING here — the caller keeps them
 * in storage, never surfaces them, never flushes them (STEP 16-H2-A1 §6).
 */
export function opsForScope(
  queue: readonly PendingWrite[],
  userId: string,
  householdId: string,
): PendingWrite[] {
  if (!userId || !householdId) return [];
  return queue.filter(
    (q) => q.scope.userId === userId && q.scope.householdId === householdId,
  );
}

/* ------------------------------------------------------------------ *
 * Read overlay — transaction CREATE / UPDATE / DELETE
 * ------------------------------------------------------------------ */

/**
 * A CREATE payload -> a synthetic domain `Transaction` row. Also reused
 * (STEP 16-H2-B2.1) to rebuild a read-only row for a TERMINAL-failed UPDATE
 * whose authoritative server row is gone: `NewTransactionDraft` carries
 * every user-editable field, and server-locked provenance
 * (`fromRecurring` / `tags` / `memberId` / …) is all optional on
 * `Transaction`, so this stays type-safe with nothing invented.
 */
function createDraftToDomain(op: PendingTransactionCreate | PendingTransactionUpdate): Transaction {
  const d = op.payload;
  return {
    id: op.entityId,
    type: d.type,
    category: d.category,
    amount: d.amount,
    memo: d.memo,
    date: d.date,
    ...(d.paymentMethod !== undefined ? { paymentMethod: d.paymentMethod } : {}),
    ...(d.cardId !== undefined ? { cardId: d.cardId } : {}),
    ...(d.installment !== undefined ? { installment: d.installment } : {}),
    ...(d.splits !== undefined ? { splits: d.splits } : {}),
  };
}

/**
 * Apply an UPDATE payload onto an existing domain row — the SAME "feature
 * OFF => cleared" semantics `buildTransactionUpdate` uses. Server-locked
 * provenance (`fromRecurring` / `fromPlanned`) and un-editable
 * (`tags` / `memberId`) fields are preserved from `row`. `id` is unchanged.
 *
 * `cardId` shows the user's selection directly; the authoritative flush
 * still applies the real dangling-soft-deleted-card rule via
 * `originalRawCardId`, and the post-flush refresh reconciles any difference.
 */
function applyUpdateDraft(row: Transaction, d: NewTransactionDraft): Transaction {
  return {
    ...row,
    type: d.type,
    category: d.category,
    amount: d.amount,
    memo: d.memo,
    date: d.date,
    paymentMethod: d.paymentMethod,
    cardId: d.cardId,
    installment: d.installment,
    splits: d.splits && d.splits.length > 0 ? d.splits : undefined,
  };
}

function createSyntheticMeta(op: PendingTransactionCreate): RemoteTransactionMeta {
  return {
    updatedAt: op.enqueuedAt,
    createdBy: op.scope.userId,
    rawCardId: op.payload.cardId ?? null,
  };
}

/**
 * Does an authoritative server row already reflect a queued UPDATE's desired
 * draft? STEP 16-H2-B2 §16 — the confirmation before a durable ack. Mirrors
 * the field set of the write service's own `financialFieldsMatch`
 * (src/services/remoteFinanceWrite.ts) at the READ-MODEL level:
 *   - type / category / amount / memo / date(instant) / installment.months /
 *     splits (order-significant) compared strictly;
 *   - paymentMethod compared strictly;
 *   - `cardId` LENIENT: an exact mismatch is only disqualifying when the
 *     draft's card is a CURRENTLY-LIVE card (it should have stuck). When the
 *     draft's card isn't live (soft-deleted / preserved-as-dangling / nulled)
 *     the read model can legitimately show `undefined`, so that difference is
 *     accepted — matching the service's "absent card_id => preserve" rule.
 *
 * A false negative here only costs one extra idempotent replay (the service's
 * 0-row reconcile confirms it), never data loss. Pure.
 */
export function serverRowConfirmsUpdate(
  serverRow: Transaction,
  draft: NewTransactionDraft,
  knownCardIds: ReadonlySet<string>,
): boolean {
  if (serverRow.type !== draft.type) return false;
  if (serverRow.category !== draft.category) return false;
  if (Number(serverRow.amount) !== Number(draft.amount)) return false;
  if ((serverRow.memo ?? '') !== (draft.memo ?? '')) return false;
  if (new Date(serverRow.date).getTime() !== new Date(draft.date).getTime()) return false;
  if ((serverRow.installment?.months ?? null) !== (draft.installment?.months ?? null)) return false;
  if ((serverRow.paymentMethod ?? null) !== (draft.paymentMethod ?? null)) return false;

  const sa = serverRow.splits ?? [];
  const sb = draft.splits ?? [];
  if (sa.length !== sb.length) return false;
  if (
    !sa.every(
      (s, i) =>
        s.category === sb[i].category &&
        Number(s.amount) === Number(sb[i].amount) &&
        (s.memo ?? null) === (sb[i].memo ?? null),
    )
  ) {
    return false;
  }

  const draftCard = draft.cardId ?? null;
  const serverCard = serverRow.cardId ?? null;
  if (draftCard !== serverCard && draftCard != null && knownCardIds.has(draftCard)) {
    return false;
  }
  return true;
}

function cardDraftToDomain(op: PendingCardCreate | PendingCardUpdate): CreditCard {
  const d = op.payload;
  return {
    id: op.entityId,
    name: d.name,
    ...(d.color !== undefined ? { color: d.color } : {}),
    ...(d.paymentDay !== undefined ? { paymentDay: d.paymentDay } : {}),
    ...(d.closingDay !== undefined ? { closingDay: d.closingDay } : {}),
    createdAt: op.enqueuedAt, // synthetic — the row is read-only, never re-edited
  };
}

/** Overlay a card UPDATE draft onto an existing domain card. `id` /
 *  `createdAt` (server identity) are preserved; a cleared colour becomes
 *  `undefined` — the same "feature off => cleared" rule `buildCardUpdate` uses. */
function applyCardUpdate(row: CreditCard, d: NewCardDraft): CreditCard {
  return {
    ...row,
    name: d.name,
    color: d.color,
    paymentDay: d.paymentDay,
    closingDay: d.closingDay,
  };
}

/**
 * Does an authoritative server card already reflect a queued card UPDATE's
 * desired draft? STEP 16-H2-C2-A1 §23/§25 — the confirmation before a durable
 * ack. Mirrors the write service's own `cardFieldsMatch` field set at the
 * READ-MODEL level: name / colour(bg+fg) / paymentDay / closingDay, compared
 * strictly (absent === null). No `JSON.stringify`. Also used for the CREATE
 * ack (§22): id present AND fields match. Pure.
 */
export function serverCardConfirmsUpdate(serverRow: CreditCard, draft: NewCardDraft): boolean {
  if (serverRow.name !== draft.name) return false;
  if ((serverRow.color?.bg ?? null) !== (draft.color?.bg ?? null)) return false;
  if ((serverRow.color?.color ?? null) !== (draft.color?.color ?? null)) return false;
  if ((serverRow.paymentDay ?? null) !== (draft.paymentDay ?? null)) return false;
  if ((serverRow.closingDay ?? null) !== (draft.closingDay ?? null)) return false;
  return true;
}

/* ---------------- custom-category display model (STEP 16-H2-C2-B1) ---------------- */

/** A pending CREATE / failed-orphan UPDATE payload -> a synthetic domain
 *  `Category`. The row is read-only (never re-edited), so it carries no
 *  timestamp — `Category` has none. */
function categoryDraftToDomain(op: PendingCategoryCreate | PendingCategoryUpdate): Category {
  const d = op.payload;
  return { id: op.entityId, name: d.name, bg: d.bg, color: d.color, icon: d.icon, custom: true };
}

/** Overlay an UPDATE draft onto an existing domain category. `id` / `custom`
 *  (identity) preserved; server-immutable `type` is not a `Category` field so
 *  it can't change here. */
function applyCategoryUpdate(row: Category, d: NewCustomCategoryDraft): Category {
  return { ...row, name: d.name, bg: d.bg, color: d.color, icon: d.icon };
}

/**
 * Does an authoritative server custom category already reflect a queued
 * UPDATE's desired draft? STEP 16-H2-C2-B1 §24 — the pre-ack confirmation.
 * Mirrors the write service's own `categoryFieldsMatch` at the READ-MODEL
 * level: name / bg / color / icon compared strictly. `type` is not compared
 * (product-immutable, never written by an UPDATE). Also used for the CREATE
 * ack (§25): id present AND fields match. Pure — no `JSON.stringify`.
 */
export function serverCategoryConfirmsUpdate(
  serverRow: Category,
  draft: NewCustomCategoryDraft,
): boolean {
  return (
    serverRow.name === draft.name &&
    serverRow.bg === draft.bg &&
    serverRow.color === draft.color &&
    serverRow.icon === draft.icon
  );
}

export interface CategoryManagementView {
  /**
   * The custom categories to render on the CATEGORY-management screen ONLY:
   * authoritative server customCats, with a NOT-failed pending UPDATE
   * overlaid, plus a synthetic entry for a pending/failed CREATE, plus a
   * synthetic entry for a FAILED UPDATE whose server row is GONE, minus a
   * not-failed pending DELETE.
   *
   * STEP 16-H2-C2-B2 conflict-UX fix: a TERMINAL-failed UPDATE whose
   * authoritative server row STILL EXISTS keeps the AUTHORITATIVE row verbatim
   * (the other device won) — the stale local draft is NEVER used to replace
   * it. The attempted local name is exposed via `attemptedNameById` as
   * conflict metadata only, and the row id is in `failedIds` so the UI can
   * offer "변경 버리기".
   *
   * DELIBERATELY separate from `data.customCats` (§12/§13) so the
   * transaction/planned/recurring/budget category pickers, stats name
   * resolution, backup and household-import only ever see authoritative server
   * categories. Same `{ expense, income }` shape; equals `data.customCats`
   * when there are no category ops.
   */
  rows: CustomCatMap;
  /** category id -> the pending op that produced or marks it. */
  opById: ReadonlyMap<string, 'create' | 'update' | 'delete'>;
  /** category ids currently in a TERMINAL failed state. */
  failedIds: ReadonlySet<string>;
  /** server category ids hidden from `rows` by a not-failed pending DELETE. */
  hiddenIds: string[];
  /**
   * row ids that are SYNTHETIC — present in `rows` only because of an op, with
   * no authoritative server category behind them (pending/failed CREATE, and
   * a failed UPDATE whose server row is gone). The category-management screen
   * must exclude these from the sortable drag list / `saveCategoryOrder`
   * payload (§6). A failed UPDATE whose server row EXISTS is NOT here — its
   * authoritative row stays a normal, reorderable category.
   */
  syntheticIds: ReadonlySet<string>;
  /**
   * category id -> the name the user attempted in a TERMINAL-failed UPDATE.
   * Conflict metadata ONLY — never used to replace the displayed row when the
   * authoritative row exists (§2/§5). Present for both the "row exists" and
   * the orphan case.
   */
  attemptedNameById: ReadonlyMap<string, string>;
}

function composeCategoryManagement(
  serverCats: CustomCatMap,
  ops: readonly PendingWrite[],
  failedCategoryIds?: ReadonlySet<string>,
  /** STEP 16-H2 A4.3 — bare category-id set of TERMINAL-failed composite
   *  (`entity:'categoryBudget'`) deletes for the current scope. */
  failedCategoryBudgetIds?: ReadonlySet<string>,
): CategoryManagementView {
  const opById = new Map<string, 'create' | 'update' | 'delete'>();
  const failedIds = new Set<string>();
  const hiddenIds: string[] = [];
  const syntheticIds = new Set<string>();
  const attemptedNameById = new Map<string, string>();
  const catOps = ops.filter(
    (o): o is PendingCategoryCreate | PendingCategoryUpdate | PendingCategoryDelete =>
      o.entity === 'category',
  );
  // STEP 16-H2 A4.3 — a composite category+budget delete projects the SAME
  // visual meaning as a single-table category delete onto THIS view (hide
  // the row while pending; restore + mark it failed on a terminal). The
  // record is NEVER converted to a `PendingCategoryDelete` — it stays its own
  // `entity:'categoryBudget'` record and only its DELETE effect is mirrored.
  const cbDeletes = ops.filter(
    (o): o is PendingCategoryBudgetDelete => o.entity === 'categoryBudget',
  );
  if (catOps.length === 0 && cbDeletes.length === 0) {
    return { rows: serverCats, opById, failedIds, hiddenIds, syntheticIds, attemptedNameById };
  }

  const failed = (id: string) => !!failedCategoryIds?.has(id);
  // Fresh arrays — serverCats and its arrays are never mutated.
  const rows: CustomCatMap = { expense: serverCats.expense.slice(), income: serverCats.income.slice() };
  const findIn = (id: string) => {
    let i = rows.expense.findIndex((c) => c.id === id);
    if (i !== -1) return { list: rows.expense, idx: i } as const;
    i = rows.income.findIndex((c) => c.id === id);
    if (i !== -1) return { list: rows.income, idx: i } as const;
    return null;
  };

  for (const op of catOps) {
    const hit = findIn(op.entityId);

    if (op.op === 'create') {
      if (hit) continue; // the flush already landed — no marker
      rows[op.payload.type].push(categoryDraftToDomain(op));
      opById.set(op.entityId, 'create');
      syntheticIds.add(op.entityId); // no authoritative row behind it
      if (failed(op.entityId)) failedIds.add(op.entityId);
      continue;
    }

    if (op.op === 'update') {
      if (hit) {
        if (failed(op.entityId)) {
          // TERMINAL-failed UPDATE + authoritative row still on the server
          // (the other device won). KEEP the authoritative row verbatim — the
          // stale local draft must NOT replace it. Mark it + keep the
          // attempted name as conflict metadata for the UI's "변경 버리기".
          opById.set(op.entityId, 'update');
          failedIds.add(op.entityId);
          attemptedNameById.set(op.entityId, op.payload.name);
          continue;
        }
        // still-pending (non-terminal) UPDATE -> overlay the draft (unchanged).
        hit.list[hit.idx] = applyCategoryUpdate(hit.list[hit.idx], op.payload);
        opById.set(op.entityId, 'update');
        continue;
      }
      // server row GONE: only a TERMINAL-failed UPDATE gets a display-only
      // synthetic row (a not-failed one just waits — like transactions/cards).
      if (failed(op.entityId)) {
        rows[op.payload.type].push(categoryDraftToDomain(op));
        opById.set(op.entityId, 'update');
        failedIds.add(op.entityId);
        syntheticIds.add(op.entityId); // no authoritative row behind it
        attemptedNameById.set(op.entityId, op.payload.name);
      }
      continue;
    }

    // delete
    if (failed(op.entityId)) {
      if (hit) {
        opById.set(op.entityId, 'delete'); // keep the server row visible, mark it failed
        failedIds.add(op.entityId);
      }
      continue;
    }
    if (hit) {
      hit.list.splice(hit.idx, 1);
      hiddenIds.push(op.entityId);
    }
  }

  // STEP 16-H2 A4.3 — composite deletes, applied AFTER the single-table
  // category ops so that, in a malformed/legacy state where BOTH somehow
  // target the same id (the A4.2 collision guard normally prevents it), the
  // single-table op wins deterministically and this is a no-op — never a
  // crash, never a precedence system.
  for (const op of cbDeletes) {
    if (opById.has(op.entityId)) continue; // a single-table category op already covers this id
    const hit = findIn(op.entityId);
    if (!hit) continue; // no authoritative category behind it (composite is never synthetic)
    if (failedCategoryBudgetIds?.has(op.entityId)) {
      opById.set(op.entityId, 'delete'); // restore + mark: authoritative row stays visible
      failedIds.add(op.entityId);
      continue;
    }
    hit.list.splice(hit.idx, 1); // not-failed pending delete -> optimistic hide
    hiddenIds.push(op.entityId);
  }

  return { rows, opById, failedIds, hiddenIds, syntheticIds, attemptedNameById };
}

/* ---------------- budget display model (STEP 16-H2-C2-BUDGET A1) ---------------- */

/**
 * Does an authoritative server budget amount already reflect a queued
 * budget CREATE/UPDATE's desired draft? Mirrors `serverCardConfirmsUpdate` /
 * `serverCategoryConfirmsUpdate` at the READ-MODEL level, but `BudgetMap`'s
 * value is a bare `number` (no row object), so this takes the server amount
 * directly. `serverAmount` MUST already be known-present (existence is the
 * caller's `Map.has()` / `in` check) — this only compares the one editable
 * field. Pure.
 */
export function serverBudgetConfirmsUpdate(serverAmount: number, draft: NewBudgetDraft): boolean {
  return Number(serverAmount) === Number(draft.amount);
}

export interface BudgetManagementView {
  /**
   * The budgets to render on a BUDGET-MANAGEMENT surface ONLY: authoritative
   * server `budgets`, with a NOT-failed pending UPDATE overlaid, plus a
   * synthetic entry for a pending/failed CREATE, plus a synthetic entry for a
   * FAILED UPDATE whose server row is GONE, minus a not-failed pending
   * DELETE.
   *
   * STEP 16-H2-C2-BUDGET A1 §6 item C: a TERMINAL-failed CREATE whose natural
   * key is now occupied by a DIFFERENT household member's row (a genuine
   * `(household_id, category_id)` race — unlike card/category, budget has no
   * client-generated id to make this astronomically unlikely) keeps the
   * AUTHORITATIVE amount verbatim; the attempted local amount is exposed via
   * `attemptedAmountById` as conflict metadata only, never used to replace
   * the displayed row.
   *
   * DELIBERATELY separate from `data.budgets` (§5) so every finance
   * aggregate (`monthlyTotals`, Home, insights, backup, household-import)
   * only ever sees authoritative server budgets — the one entity where this
   * separation matters most, since `budgets` feeds calculations directly
   * (unlike `cards`/`customCats`, which only feed pickers/lookups). Equals
   * `data.budgets` when there are no budget ops.
   */
  rows: BudgetMap;
  /** category id -> the pending op that produced or marks it. */
  opById: ReadonlyMap<string, 'create' | 'update' | 'delete'>;
  /** category ids currently in a TERMINAL failed state. */
  failedIds: ReadonlySet<string>;
  /** server category ids hidden from `rows` by a not-failed pending DELETE. */
  hiddenIds: string[];
  /**
   * category ids that are SYNTHETIC — present in `rows` only because of an
   * op, with no authoritative server budget behind them (pending/failed
   * CREATE, and a failed UPDATE whose server row is gone). A failed CREATE
   * or failed UPDATE whose server row EXISTS (items C/E) is NOT here — its
   * authoritative row stays a normal budget entry.
   */
  syntheticIds: ReadonlySet<string>;
  /**
   * category id -> the amount the user attempted in a TERMINAL-failed
   * CREATE or UPDATE whose authoritative row shows something else. Conflict
   * metadata ONLY — never used to replace the displayed row when the
   * authoritative row exists (§6 items C/E).
   */
  attemptedAmountById: ReadonlyMap<string, number>;
}

function composeBudgetManagement(
  serverBudgets: BudgetMap,
  ops: readonly PendingWrite[],
  failedBudgetIds?: ReadonlySet<string>,
  /** STEP 16-H2 A4.3 — bare category-id set of TERMINAL-failed composite
   *  (`entity:'categoryBudget'`) deletes for the current scope. */
  failedCategoryBudgetIds?: ReadonlySet<string>,
): BudgetManagementView {
  const opById = new Map<string, 'create' | 'update' | 'delete'>();
  const failedIds = new Set<string>();
  const hiddenIds: string[] = [];
  const syntheticIds = new Set<string>();
  const attemptedAmountById = new Map<string, number>();
  const budgetOps = ops.filter(
    (o): o is PendingBudgetCreate | PendingBudgetUpdate | PendingBudgetDelete => o.entity === 'budget',
  );
  // STEP 16-H2 A4.3 — a composite category+budget delete mirrors a single-table
  // budget DELETE's visual meaning here: hide the authoritative row while
  // pending, restore + mark it failed on a terminal. It NEVER creates a
  // synthetic budget row (a budget that was absent at intent time — incl. an
  // `expectedBudgetUpdatedAt: null` record — stays absent here), and is never
  // turned into a `PendingBudgetDelete`.
  const cbDeletes = ops.filter(
    (o): o is PendingCategoryBudgetDelete => o.entity === 'categoryBudget',
  );
  if (budgetOps.length === 0 && cbDeletes.length === 0) {
    return { rows: serverBudgets, opById, failedIds, hiddenIds, syntheticIds, attemptedAmountById };
  }

  const failed = (id: string) => !!failedBudgetIds?.has(id);
  const rows: BudgetMap = { ...serverBudgets }; // fresh object — never mutates serverBudgets
  const hasServerRow = (id: string) => Object.prototype.hasOwnProperty.call(serverBudgets, id);

  for (const op of budgetOps) {
    const catId = op.entityId;

    if (op.op === 'create') {
      if (hasServerRow(catId)) {
        // §6 item C: the natural-key slot is already occupied. A NOT-failed
        // record here means OUR OWN create landed (response lost) — no
        // marker needed, the ack reconcile will clear it. A TERMINAL-failed
        // record means a DIFFERENT row (created/revived by someone else, or
        // with a different amount) won the race — keep the authoritative
        // amount verbatim, mark it, and expose the attempted amount as
        // metadata only. Never synthetic (a real server row exists).
        if (failed(catId)) {
          opById.set(catId, 'create');
          failedIds.add(catId);
          attemptedAmountById.set(catId, op.payload.amount);
        }
        continue;
      }
      // §6 item A/B: no server row yet — synthetic pending/failed row.
      rows[catId] = op.payload.amount;
      opById.set(catId, 'create');
      syntheticIds.add(catId); // no authoritative row behind it
      if (failed(catId)) failedIds.add(catId);
      continue;
    }

    if (op.op === 'update') {
      if (hasServerRow(catId)) {
        if (failed(catId)) {
          // §6 item E: TERMINAL-failed UPDATE + authoritative row still on
          // the server (the other device won). KEEP the authoritative
          // amount verbatim — the stale local draft must NOT replace it.
          opById.set(catId, 'update');
          failedIds.add(catId);
          attemptedAmountById.set(catId, op.payload.amount);
          continue;
        }
        // §6 item D: still-pending (non-terminal) UPDATE -> overlay the draft.
        rows[catId] = op.payload.amount;
        opById.set(catId, 'update');
        continue;
      }
      // §6 item F: server row GONE — only a TERMINAL-failed UPDATE gets a
      // display-only synthetic row (a not-failed one just waits).
      if (failed(catId)) {
        rows[catId] = op.payload.amount;
        opById.set(catId, 'update');
        failedIds.add(catId);
        syntheticIds.add(catId); // no authoritative row behind it
        attemptedAmountById.set(catId, op.payload.amount);
      }
      continue;
    }

    // delete — §6 items G/H
    if (failed(catId)) {
      if (hasServerRow(catId)) {
        opById.set(catId, 'delete'); // keep the server row visible, mark it failed
        failedIds.add(catId);
      }
      continue;
    }
    if (hasServerRow(catId)) {
      delete rows[catId];
      hiddenIds.push(catId);
    }
  }

  // STEP 16-H2 A4.3 — composite deletes, applied AFTER the single-table budget
  // ops (deterministic single-table-wins no-op if both ever target one id).
  // NO synthetic row is ever created: a category with no authoritative budget
  // is simply skipped.
  for (const op of cbDeletes) {
    const catId = op.entityId;
    if (opById.has(catId)) continue; // a single-table budget op already covers this id
    if (!hasServerRow(catId)) continue; // no authoritative budget -> nothing to hide / mark
    if (failedCategoryBudgetIds?.has(catId)) {
      opById.set(catId, 'delete'); // restore + mark: authoritative amount stays visible
      failedIds.add(catId);
      continue;
    }
    delete rows[catId]; // not-failed pending delete -> optimistic hide
    hiddenIds.push(catId);
  }

  return { rows, opById, failedIds, hiddenIds, syntheticIds, attemptedAmountById };
}

/* ---------------- planned-expense display model (STEP 16-H2-E1) ---------------- */

/** A pending CREATE / failed-orphan UPDATE payload -> a synthetic domain
 *  `PlannedExpense`. The row is read-only (never re-edited) — `createdAt` is
 *  a synthetic `enqueuedAt` placeholder, never a real server timestamp. */
function plannedDraftToDomain(op: PendingPlannedCreate | PendingPlannedUpdate): PlannedExpense {
  const d = op.payload;
  return {
    id: op.entityId,
    name: d.name,
    amount: d.amount,
    category: d.category,
    date: d.date,
    memo: d.memo,
    type: d.type,
    createdAt: op.enqueuedAt,
  };
}

/** Overlay an UPDATE draft onto an existing domain planned expense. `id` /
 *  `createdAt` (server identity) and `type` (product-immutable — never
 *  written by an UPDATE) are preserved from `row`. */
function applyPlannedUpdate(row: PlannedExpense, d: NewPlannedExpenseDraft): PlannedExpense {
  return { ...row, name: d.name, amount: d.amount, category: d.category, date: d.date, memo: d.memo };
}

/**
 * Does an authoritative server planned expense already reflect a queued
 * CREATE/UPDATE's desired draft? STEP 16-H2-E1 §10/§11 — the pre-ack
 * confirmation. Mirrors the write service's own `plannedFieldsMatch` /
 * `isSameCreateRow` field set at the READ-MODEL level: `name` (trimmed) /
 * `amount` / `category` / `date` / `memo` (trimmed) compared strictly —
 * `name`/`memo` are trimmed because `buildPlannedInsert` / `buildPlannedUpdate`
 * store them trimmed. `type` is NOT compared (product-immutable, never
 * written by an UPDATE; the CREATE dedup matcher checks it). `updatedAt`
 * changing is NEVER sufficient on its own — content match is what matters.
 * Pure — no `JSON.stringify`.
 */
export function serverPlannedConfirmsUpdate(
  serverRow: PlannedExpense,
  draft: NewPlannedExpenseDraft,
): boolean {
  return (
    serverRow.name === draft.name.trim() &&
    Number(serverRow.amount) === Number(draft.amount) &&
    serverRow.category === draft.category &&
    serverRow.date === draft.date &&
    serverRow.memo === draft.memo.trim()
  );
}

export interface PlannedManagementView {
  /**
   * The planned expenses to render on a PLANNED-MANAGEMENT surface ONLY:
   * authoritative server `planned`, with a NOT-failed pending UPDATE
   * overlaid, plus a synthetic row for a pending/failed CREATE, plus a
   * synthetic row for a FAILED UPDATE whose server row is GONE, minus a
   * not-failed pending DELETE.
   *
   * STEP 16-H2-E1 §14 — a TERMINAL-failed UPDATE whose authoritative server
   * row STILL EXISTS keeps the AUTHORITATIVE row verbatim (the other device
   * won); the stale local draft is NEVER used to replace it. The attempted
   * local draft is exposed via `attemptedDraftById` as conflict metadata
   * only, and the row id is in `failedIds` so the UI can offer "변경 버리기".
   *
   * DELIBERATELY separate from `data.planned` / `data.plannedMeta` (§16/§19)
   * so the Home upcoming banner, the planned list's own read path, backup and
   * household-import only ever see authoritative server data. Equals
   * `data.planned` when there are no planned ops.
   */
  rows: PlannedExpense[];
  /** planned id -> the pending op that produced or marks it. */
  opById: ReadonlyMap<string, 'create' | 'update' | 'delete'>;
  /** planned ids currently in a TERMINAL failed state. */
  failedIds: ReadonlySet<string>;
  /** server planned ids hidden from `rows` by a not-failed pending DELETE. */
  hiddenIds: string[];
  /**
   * row ids that are SYNTHETIC — present in `rows` only because of an op,
   * with no authoritative server planned row behind them (pending/failed
   * CREATE, and a failed UPDATE whose server row is gone). A failed UPDATE
   * whose server row EXISTS is NOT here — its authoritative row stays a
   * normal planned entry.
   */
  syntheticIds: ReadonlySet<string>;
  /**
   * planned id -> the full draft the user attempted in a TERMINAL-failed
   * UPDATE. Conflict metadata ONLY — never used to replace the displayed row
   * when the authoritative row exists (§14). Present for both the "row
   * exists" and the orphan case.
   */
  attemptedDraftById: ReadonlyMap<string, NewPlannedExpenseDraft>;
}

function composePlannedManagement(
  serverPlanned: readonly PlannedExpense[],
  ops: readonly PendingWrite[],
  failedPlannedIds?: ReadonlySet<string>,
): PlannedManagementView {
  const opById = new Map<string, 'create' | 'update' | 'delete'>();
  const failedIds = new Set<string>();
  const hiddenIds: string[] = [];
  const syntheticIds = new Set<string>();
  const attemptedDraftById = new Map<string, NewPlannedExpenseDraft>();
  const plannedOps = ops.filter(
    (o): o is PendingPlannedCreate | PendingPlannedUpdate | PendingPlannedDelete =>
      o.entity === 'planned',
  );
  if (plannedOps.length === 0) {
    return { rows: serverPlanned.slice(), opById, failedIds, hiddenIds, syntheticIds, attemptedDraftById };
  }

  const failed = (id: string) => !!failedPlannedIds?.has(id);
  const rows = serverPlanned.slice(); // never mutates serverPlanned
  const idxOf = (id: string) => rows.findIndex((p) => p.id === id);

  for (const op of plannedOps) {
    const idx = idxOf(op.entityId);

    if (op.op === 'create') {
      if (idx !== -1) continue; // the flush already landed — no marker
      rows.push(plannedDraftToDomain(op));
      opById.set(op.entityId, 'create');
      syntheticIds.add(op.entityId); // no authoritative row behind it
      if (failed(op.entityId)) failedIds.add(op.entityId);
      continue;
    }

    if (op.op === 'update') {
      if (idx !== -1) {
        if (failed(op.entityId)) {
          // §14: TERMINAL-failed UPDATE + authoritative row still on the
          // server (the other device won). KEEP the authoritative row
          // verbatim — the stale local draft must NOT replace it. Mark it +
          // keep the attempted draft as conflict metadata for "변경 버리기".
          opById.set(op.entityId, 'update');
          failedIds.add(op.entityId);
          attemptedDraftById.set(op.entityId, op.payload);
          continue;
        }
        // still-pending (non-terminal) UPDATE -> overlay the draft.
        rows[idx] = applyPlannedUpdate(rows[idx], op.payload);
        opById.set(op.entityId, 'update');
        continue;
      }
      // server row GONE: only a TERMINAL-failed UPDATE gets a display-only
      // synthetic row (a not-failed one just waits — like cards/categories).
      if (failed(op.entityId)) {
        rows.push(plannedDraftToDomain(op));
        opById.set(op.entityId, 'update');
        failedIds.add(op.entityId);
        syntheticIds.add(op.entityId); // no authoritative row behind it
        attemptedDraftById.set(op.entityId, op.payload);
      }
      continue;
    }

    // delete
    if (failed(op.entityId)) {
      if (idx !== -1) {
        opById.set(op.entityId, 'delete'); // keep the server row visible, mark it failed
        failedIds.add(op.entityId);
      }
      continue;
    }
    if (idx !== -1) {
      rows.splice(idx, 1);
      hiddenIds.push(op.entityId);
    }
  }

  return { rows, opById, failedIds, hiddenIds, syntheticIds, attemptedDraftById };
}

/* ---------------- recurring-rule display model (STEP 16-H2-F1) ---------------- */

/** A pending CREATE / failed-orphan FULL-UPDATE payload -> a synthetic
 *  domain `RecurringRule`. The row is read-only (never re-edited) —
 *  `createdAt` is a synthetic `enqueuedAt` placeholder. `active` is assumed
 *  `true`: neither a CREATE draft nor a full-UPDATE draft ever carries the
 *  real `active` state (it has its own action), so for a CREATE this matches
 *  the real DB default, and for an orphaned full-UPDATE it is the best
 *  available guess, NOT a re-derivation of a real value — a limitation
 *  documented here rather than silently assumed. */
function recurringDraftToDomain(op: PendingRecurringCreate | PendingRecurringUpdate): RecurringRule {
  const d = op.payload;
  return {
    id: op.entityId,
    type: d.type,
    name: d.name,
    amount: d.amount,
    category: d.category,
    frequency: d.frequency,
    dayOfMonth: d.dayOfMonth ?? undefined,
    dayOfWeek: d.dayOfWeek ?? undefined,
    active: true,
    createdAt: op.enqueuedAt,
  };
}

/** Overlay a FULL-UPDATE draft onto an existing domain rule. `id` /
 *  `createdAt` (server identity), `type` (product-immutable), and `active`
 *  (its own separate action — a full edit never touches it) are preserved
 *  from `row`. */
function applyRecurringFullUpdate(row: RecurringRule, d: NewRecurringDraft): RecurringRule {
  return {
    ...row,
    name: d.name,
    amount: d.amount,
    category: d.category,
    frequency: d.frequency,
    dayOfMonth: d.dayOfMonth ?? undefined,
    dayOfWeek: d.dayOfWeek ?? undefined,
  };
}

/** Overlay an ACTIVE-toggle onto an existing domain rule — ONLY `active` changes. */
function applyRecurringActiveUpdate(row: RecurringRule, active: boolean): RecurringRule {
  return { ...row, active };
}

/**
 * Does an authoritative server recurring rule already reflect a queued
 * CREATE/FULL-UPDATE's desired draft? STEP 16-H2-F1 §12/§13 — the pre-ack
 * confirmation, reused for BOTH ops (mirrors card/category's one
 * `serverXConfirmsUpdate` for create+update). Mirrors the write service's own
 * `recurringFieldsMatch` / `isSameCreateRow` field set at the READ-MODEL
 * level: `name` (trimmed) / `amount` / `category` / `frequency` /
 * `dayOfMonth` / `dayOfWeek` compared strictly (`undefined` on the domain
 * side normalized to `null` to match the draft's `number | null`). `type` /
 * `active` are NOT compared (product-immutable / a separate op). Pure.
 */
export function serverRecurringConfirmsUpdate(
  serverRow: RecurringRule,
  draft: NewRecurringDraft,
): boolean {
  return (
    serverRow.name === draft.name.trim() &&
    Number(serverRow.amount) === Number(draft.amount) &&
    serverRow.category === draft.category &&
    serverRow.frequency === draft.frequency &&
    (serverRow.dayOfMonth ?? null) === draft.dayOfMonth &&
    (serverRow.dayOfWeek ?? null) === draft.dayOfWeek
  );
}

/**
 * Does an authoritative server recurring rule already reflect a queued
 * ACTIVE-toggle's desired state? STEP 16-H2-F1 §14 — content match on
 * `active` alone; `updatedAt` changing is never sufficient on its own. Pure.
 */
export function serverRecurringConfirmsActive(serverRow: RecurringRule, desiredActive: boolean): boolean {
  return serverRow.active === desiredActive;
}

export interface RecurringManagementView {
  /**
   * The recurring rules to render on a RECURRING-MANAGEMENT surface ONLY:
   * authoritative server `recurring`, with a NOT-failed pending FULL UPDATE
   * or ACTIVE toggle overlaid, plus a synthetic row for a pending/failed
   * CREATE, plus a synthetic row for a FAILED FULL UPDATE whose server row
   * is GONE, minus a not-failed pending DELETE.
   *
   * STEP 16-H2-F1 §21/§22 — a TERMINAL-failed FULL UPDATE or ACTIVE toggle
   * whose authoritative server row STILL EXISTS keeps the AUTHORITATIVE row
   * verbatim (the other device won); the attempted local value is exposed
   * via `attemptedDraftById` / `attemptedActiveById` as conflict metadata
   * only — a failed toggle never "sticks" at the attempted value, it always
   * snaps back to the authoritative `active`.
   *
   * DELIBERATELY separate from `data.recurring` / `data.recurringMeta`
   * (§26) so any other consumer only ever sees authoritative server data.
   * Equals `data.recurring` when there are no recurring ops.
   */
  rows: RecurringRule[];
  /** recurring id -> the pending op that produced or marks it. */
  opById: ReadonlyMap<string, 'create' | 'update' | 'delete'>;
  /** recurring ids currently in a TERMINAL failed state. */
  failedIds: ReadonlySet<string>;
  /** server recurring ids hidden from `rows` by a not-failed pending DELETE. */
  hiddenIds: string[];
  /**
   * row ids that are SYNTHETIC — present in `rows` only because of an op,
   * with no authoritative server row behind them (pending/failed CREATE, and
   * a failed FULL UPDATE whose server row is gone). A failed ACTIVE toggle
   * NEVER contributes a synthetic row here — see `attemptedActiveById`.
   */
  syntheticIds: ReadonlySet<string>;
  /**
   * recurring id -> the FULL draft attempted in a TERMINAL-failed FULL
   * UPDATE. Conflict metadata ONLY — never used to replace the displayed row
   * when the authoritative row exists (§21). Present for both the
   * "row exists" and the orphan case.
   */
  attemptedDraftById: ReadonlyMap<string, NewRecurringDraft>;
  /**
   * recurring id -> the desired `active` value attempted in a TERMINAL-failed
   * ACTIVE toggle. Conflict metadata ONLY (§22). Present for BOTH:
   *   - the row-exists case (the id is ALSO in `opById`/`rows` there), and
   *   - the ORPHAN case (server row gone) — which, UNLIKE a full UPDATE,
   *     gets NO synthetic row and NO `opById` entry: an `{ active }`-only
   *     payload carries no name/amount/category/frequency, so a full
   *     `RecurringRule` can never be honestly reconstructed from it (nothing
   *     is ever invented here). The id is failed + traceable via this map
   *     (and the raw `PendingWrite` queue, `discardPending`-able) even though
   *     it has no row to display (STEP 16-H2-F1 §24).
   */
  attemptedActiveById: ReadonlyMap<string, boolean>;
}

function composeRecurringManagement(
  serverRecurring: readonly RecurringRule[],
  ops: readonly PendingWrite[],
  failedRecurringIds?: ReadonlySet<string>,
): RecurringManagementView {
  const opById = new Map<string, 'create' | 'update' | 'delete'>();
  const failedIds = new Set<string>();
  const hiddenIds: string[] = [];
  const syntheticIds = new Set<string>();
  const attemptedDraftById = new Map<string, NewRecurringDraft>();
  const attemptedActiveById = new Map<string, boolean>();
  const recOps = ops.filter(
    (
      o,
    ): o is
      | PendingRecurringCreate
      | PendingRecurringUpdate
      | PendingRecurringActiveUpdate
      | PendingRecurringDelete => o.entity === 'recurring',
  );
  if (recOps.length === 0) {
    return {
      rows: serverRecurring.slice(),
      opById,
      failedIds,
      hiddenIds,
      syntheticIds,
      attemptedDraftById,
      attemptedActiveById,
    };
  }

  const failed = (id: string) => !!failedRecurringIds?.has(id);
  const rows = serverRecurring.slice(); // never mutates serverRecurring
  const idxOf = (id: string) => rows.findIndex((r) => r.id === id);

  for (const op of recOps) {
    const idx = idxOf(op.entityId);

    if (op.op === 'create') {
      if (idx !== -1) continue; // the flush already landed — no marker
      rows.push(recurringDraftToDomain(op));
      opById.set(op.entityId, 'create');
      syntheticIds.add(op.entityId); // no authoritative row behind it
      if (failed(op.entityId)) failedIds.add(op.entityId);
      continue;
    }

    if (op.op === 'update' && op.updateKind === 'full') {
      if (idx !== -1) {
        if (failed(op.entityId)) {
          // §21: TERMINAL-failed FULL UPDATE + authoritative row still on
          // the server (the other device won). KEEP the authoritative row
          // verbatim — the stale local draft must NOT replace it.
          opById.set(op.entityId, 'update');
          failedIds.add(op.entityId);
          attemptedDraftById.set(op.entityId, op.payload);
          continue;
        }
        // still-pending (non-terminal) FULL UPDATE -> overlay the draft.
        rows[idx] = applyRecurringFullUpdate(rows[idx], op.payload);
        opById.set(op.entityId, 'update');
        continue;
      }
      // server row GONE: only a TERMINAL-failed FULL UPDATE gets a
      // display-only synthetic row (a not-failed one just waits).
      if (failed(op.entityId)) {
        rows.push(recurringDraftToDomain(op));
        opById.set(op.entityId, 'update');
        failedIds.add(op.entityId);
        syntheticIds.add(op.entityId); // no authoritative row behind it
        attemptedDraftById.set(op.entityId, op.payload);
      }
      continue;
    }

    if (op.op === 'update' && op.updateKind === 'active') {
      if (idx !== -1) {
        if (failed(op.entityId)) {
          // §22: TERMINAL-failed ACTIVE toggle + authoritative row still on
          // the server. The row SNAPS BACK to the authoritative `active` —
          // it never sticks at the failed attempted value. The attempted
          // boolean is conflict metadata only.
          opById.set(op.entityId, 'update');
          failedIds.add(op.entityId);
          attemptedActiveById.set(op.entityId, op.payload.active);
          continue;
        }
        // still-pending (non-terminal) toggle -> optimistic overlay.
        rows[idx] = applyRecurringActiveUpdate(rows[idx], op.payload.active);
        opById.set(op.entityId, 'update');
        continue;
      }
      // §24 ORPHAN: server row GONE. An `{ active }`-only payload cannot
      // honestly reconstruct a full `RecurringRule` (no name/amount/category/
      // frequency to show) — so, UNLIKE the full-update orphan above, this
      // NEVER gets a synthetic row / `opById` entry. Only tracked (when
      // terminal-failed) via `failedIds` + `attemptedActiveById` for
      // traceability / `discardPending`; a not-failed orphan toggle is
      // simply left to wait, same as every other entity.
      if (failed(op.entityId)) {
        failedIds.add(op.entityId);
        attemptedActiveById.set(op.entityId, op.payload.active);
      }
      continue;
    }

    // delete
    if (failed(op.entityId)) {
      if (idx !== -1) {
        opById.set(op.entityId, 'delete'); // keep the server row visible, mark it failed
        failedIds.add(op.entityId);
      }
      continue;
    }
    if (idx !== -1) {
      rows.splice(idx, 1);
      hiddenIds.push(op.entityId);
    }
  }

  return { rows, opById, failedIds, hiddenIds, syntheticIds, attemptedDraftById, attemptedActiveById };
}

export interface CardManagementView {
  /**
   * The cards to render on the card-management screen ONLY: authoritative
   * server cards, with a pending UPDATE overlaid, plus a synthetic row for a
   * pending/failed CREATE, plus a synthetic row for a FAILED UPDATE whose
   * server card is gone, minus a not-failed pending DELETE. This array is
   * DELIBERATELY separate from `data.cards` (§8/§9/§15) so the transaction
   * card picker, backup and household-import never see an un-sent card and
   * no cross-entity chaining is possible.
   */
  rows: CreditCard[];
  /** row id -> the pending op that produced or marks it (for the label / read-only gate). */
  opById: ReadonlyMap<string, 'create' | 'update' | 'delete'>;
  /** row ids currently in a TERMINAL failed state. */
  failedIds: ReadonlySet<string>;
  /** server card ids hidden from `rows` by a not-failed pending DELETE. */
  hiddenIds: string[];
}

function composeCardManagement(
  serverCards: readonly CreditCard[],
  ops: readonly PendingWrite[],
  failedCardIds?: ReadonlySet<string>,
): CardManagementView {
  const opById = new Map<string, 'create' | 'update' | 'delete'>();
  const failedIds = new Set<string>();
  const hiddenIds: string[] = [];
  const cardOps = ops.filter(
    (o): o is PendingCardCreate | PendingCardUpdate | PendingCardDelete => o.entity === 'card',
  );
  if (cardOps.length === 0) {
    return { rows: serverCards.slice(), opById, failedIds, hiddenIds };
  }

  const failed = (id: string) => !!failedCardIds?.has(id);
  const rows = serverCards.slice(); // never mutates serverCards
  const idxOf = (id: string) => rows.findIndex((c) => c.id === id);

  for (const op of cardOps) {
    const idx = idxOf(op.entityId);

    if (op.op === 'create') {
      if (idx !== -1) continue; // the flush already landed — no marker
      rows.push(cardDraftToDomain(op));
      opById.set(op.entityId, 'create');
      if (failed(op.entityId)) failedIds.add(op.entityId);
      continue;
    }

    if (op.op === 'update') {
      if (idx !== -1) {
        rows[idx] = applyCardUpdate(rows[idx], op.payload);
        opById.set(op.entityId, 'update');
        if (failed(op.entityId)) failedIds.add(op.entityId);
        continue;
      }
      // server card gone: only a TERMINAL-failed UPDATE gets a display-only
      // synthetic row here (a not-failed one just waits — like transactions).
      if (failed(op.entityId)) {
        rows.push(cardDraftToDomain(op));
        opById.set(op.entityId, 'update');
        failedIds.add(op.entityId);
      }
      continue;
    }

    // delete
    if (failed(op.entityId)) {
      if (idx !== -1) {
        opById.set(op.entityId, 'delete'); // keep the server card visible, mark it failed
        failedIds.add(op.entityId);
      }
      continue;
    }
    if (idx !== -1) {
      rows.splice(idx, 1);
      hiddenIds.push(op.entityId);
    }
  }

  return { rows, opById, failedIds, hiddenIds };
}

export interface ComposedFinance {
  /** `serverData` with pending overlays applied. A NEW object when anything
   *  changed; the SAME reference when nothing applied. `serverData` and its
   *  arrays/maps are never mutated. NOTE: `data.cards` is NEVER touched by a
   *  card op — see `cardManagement`. */
  data: RemoteFinanceData;
  /** transaction ids present in `data.transactions` ONLY because of a pending
   *  CREATE / UPDATE overlay, plus failed-DELETE ids whose server row is
   *  being shown again — i.e. every row IN `data.transactions` that carries a
   *  "전송 대기" / "전송 실패" marker. Never includes `orphanedFailedUpdates`. */
  pendingIds: string[];
  /** transaction ids currently HIDDEN by a not-failed pending DELETE. */
  hiddenIds: string[];
  /**
   * STEP 16-H2-B2.2 — DISPLAY-ONLY rows for a TERMINAL-failed UPDATE whose
   * authoritative server row is GONE (another device deleted it). These are
   * synthetic `Transaction`s rebuilt from the frozen draft so Home / 전체
   * 거래내역 can show the user their un-sent edit read-only. They are
   * DELIBERATELY kept OUT of `data.transactions` so they never reach any
   * finance calculation (stats / budget / 합계 / recentTransactions). `[]`
   * when there are none.
   */
  orphanedFailedUpdates: Transaction[];
  /**
   * STEP 16-H2-C2-A1 — DISPLAY-ONLY card rows + markers for the
   * card-management screen. NEVER merged into `data.cards`. Empty view when
   * there are no card ops.
   */
  cardManagement: CardManagementView;
  /**
   * STEP 16-H2-C2-B1 — DISPLAY-ONLY custom-category rows + markers for the
   * category-management screen. NEVER merged into `data.customCats` /
   * `data.categoryMeta` / `data.catOrder`. Equals `data.customCats` when
   * there are no category ops.
   */
  categoryManagement: CategoryManagementView;
  /**
   * STEP 16-H2-C2-BUDGET A1 — DISPLAY-ONLY budget rows + markers. NEVER
   * merged into `data.budgets` / `data.budgetMeta` — `monthlyTotals` and
   * every other finance aggregate keep reading `data.budgets` untouched.
   * Equals `data.budgets` when there are no budget ops.
   */
  budgetManagement: BudgetManagementView;
  /**
   * STEP 16-H2-E1 — DISPLAY-ONLY planned-expense rows + markers for a
   * planned-management surface. NEVER merged into `data.planned` /
   * `data.plannedMeta` — the Home upcoming banner and the planned list's own
   * read path keep reading `data.planned` untouched (§16/§19). Equals
   * `data.planned` when there are no planned ops.
   */
  plannedManagement: PlannedManagementView;
  /**
   * STEP 16-H2-F1 — DISPLAY-ONLY recurring-rule rows + markers. NEVER merged
   * into `data.recurring` / `data.recurringMeta` — materialization
   * (lastRun / occurrence generation / BootEffects) is UNTOUCHED and reads
   * only authoritative data, never this projection. Equals `data.recurring`
   * when there are no recurring ops.
   */
  recurringManagement: RecurringManagementView;
}

/**
 * Overlay pending transaction ops onto an authoritative snapshot. PURE —
 * `serverData` and its arrays/maps are never mutated.
 *
 *  - CREATE: `entityId` not on the server -> append a synthetic row + meta.
 *    Already on the server -> skip (the flush landed).
 *  - UPDATE: `entityId` on the server (or a just-overlaid CREATE) -> replace
 *    that row with `applyUpdateDraft`. The server `transactionMeta[id]` is
 *    PRESERVED — its `updatedAt` is the real optimistic-concurrency token and
 *    must not be replaced with a fake `enqueuedAt` (STEP 16-H2-B1 §9). Not on
 *    the server: skip UNLESS this UPDATE is in `failedTransactionIds` (a
 *    TERMINAL failure — the row was deleted/gone on the server) — then emit a
 *    read-only synthetic row into `orphanedFailedUpdates` (NOT into
 *    `data.transactions`) so the user's durable edit is visible on Home / 전체
 *    거래내역 without ever entering a finance calculation (STEP 16-H2-B2.2).
 *  - DELETE: not failed -> remove the row from the composed list and its
 *    `transactionMeta` entry (`hiddenIds`). Failed -> DO NOT hide; the server
 *    row stays visible so a screen can label it "삭제 전송 실패" (`pendingIds`).
 *  - `failedTransactionIds` (entity-id set; ≤1 pending op per id by dedup)
 *    changes DELETE behaviour (failed -> keep visible) and routes an
 *    otherwise-lost failed UPDATE into `orphanedFailedUpdates`. A failed
 *    CREATE still overlays via the normal CREATE path (unchanged).
 *  - Ops are applied in enqueue order.
 *  - CARD ops NEVER touch `data.cards` — they feed `cardManagement` only
 *    (STEP 16-H2-C2-A1 §8/§9/§15). `failedCardIds` is a bare card-id set
 *    (the coordinator maps its internal `${entity}:${entityId}` keys down).
 */
export function composeFinance(
  serverData: RemoteFinanceData,
  ops: readonly PendingWrite[],
  failedTransactionIds?: ReadonlySet<string>,
  failedCardIds?: ReadonlySet<string>,
  failedCategoryIds?: ReadonlySet<string>,
  failedBudgetIds?: ReadonlySet<string>,
  /** STEP 16-H2 A4.3 — bare category-id set of TERMINAL-failed composite
   *  category+budget deletes; drives the failed-vs-pending branch of the
   *  composite-delete projection in BOTH management views. */
  failedCategoryBudgetIds?: ReadonlySet<string>,
  /** STEP 16-H2-E1 — bare planned-id set of TERMINAL-failed planned ops;
   *  drives the failed-vs-pending branch of `plannedManagement`. */
  failedPlannedIds?: ReadonlySet<string>,
  /** STEP 16-H2-F1 — bare recurring-id set of TERMINAL-failed recurring ops
   *  (create / full update / active toggle / delete); drives the
   *  failed-vs-pending branch of `recurringManagement`. */
  failedRecurringIds?: ReadonlySet<string>,
): ComposedFinance {
  const cardManagement = composeCardManagement(serverData.cards, ops, failedCardIds);
  const categoryManagement = composeCategoryManagement(
    serverData.customCats,
    ops,
    failedCategoryIds,
    failedCategoryBudgetIds,
  );
  const budgetManagement = composeBudgetManagement(
    serverData.budgets,
    ops,
    failedBudgetIds,
    failedCategoryBudgetIds,
  );
  const plannedManagement = composePlannedManagement(serverData.planned, ops, failedPlannedIds);
  const recurringManagement = composeRecurringManagement(serverData.recurring, ops, failedRecurringIds);

  const txnOps = ops.filter((o) => o.entity === 'transaction');
  if (txnOps.length === 0) {
    return {
      data: serverData,
      pendingIds: [],
      hiddenIds: [],
      orphanedFailedUpdates: [],
      cardManagement,
      categoryManagement,
      budgetManagement,
      plannedManagement,
      recurringManagement,
    };
  }

  let txns: Transaction[] | null = null; // lazily copied on first change
  let meta: Record<string, RemoteTransactionMeta> | null = null;
  const pendingIds: string[] = [];
  const hiddenIds: string[] = [];
  const orphanedFailedUpdates: Transaction[] = [];
  const failed = (id: string) => !!failedTransactionIds?.has(id);

  const list = () => txns ?? serverData.transactions;
  const ensureTxns = () => {
    if (!txns) txns = serverData.transactions.slice();
    return txns;
  };
  const ensureMeta = () => {
    if (!meta) meta = { ...serverData.transactionMeta };
    return meta;
  };

  for (const op of txnOps) {
    const idx = list().findIndex((t) => t.id === op.entityId);

    if (op.op === 'create') {
      if (idx !== -1) continue; // server (or an earlier overlay) already has it
      ensureTxns().push(createDraftToDomain(op));
      ensureMeta()[op.entityId] = createSyntheticMeta(op);
      pendingIds.push(op.entityId);
      continue;
    }

    if (op.op === 'update') {
      if (idx === -1) {
        // STEP 16-H2-B2.1/B2.2: a TERMINAL-failed UPDATE whose authoritative
        // row is GONE (another device deleted it). The user's durable edit
        // must stay VISIBLE, but it is NOT a real transaction any more, so it
        // is emitted DISPLAY-ONLY into `orphanedFailedUpdates` — never pushed
        // into `data.transactions` / `pendingIds` / `transactionMeta`, so no
        // finance calculation (stats / budget / 합계 / recentTransactions)
        // can ever see its amount. A NOT-failed pending UPDATE whose row is
        // only transiently missing is left alone (no synthetic row at all).
        if (failed(op.entityId)) {
          orphanedFailedUpdates.push(createDraftToDomain(op));
        }
        continue;
      }
      ensureTxns()[idx] = applyUpdateDraft(list()[idx], op.payload);
      // transactionMeta is intentionally left as-is (real token preserved).
      pendingIds.push(op.entityId);
      continue;
    }

    // delete
    if (failed(op.entityId)) {
      if (idx !== -1) pendingIds.push(op.entityId); // keep the row, mark it
      continue;
    }
    if (idx === -1) continue;
    ensureTxns().splice(idx, 1);
    if (meta || op.entityId in serverData.transactionMeta) {
      const m = ensureMeta();
      delete m[op.entityId];
    }
    hiddenIds.push(op.entityId);
  }

  if (!txns && !meta) {
    return {
      data: serverData,
      pendingIds,
      hiddenIds,
      orphanedFailedUpdates,
      cardManagement,
      categoryManagement,
      budgetManagement,
      plannedManagement,
      recurringManagement,
    };
  }

  return {
    data: {
      ...serverData,
      transactions: txns ?? serverData.transactions,
      transactionMeta: meta ?? serverData.transactionMeta,
    },
    pendingIds,
    hiddenIds,
    orphanedFailedUpdates,
    cardManagement,
    categoryManagement,
    budgetManagement,
    plannedManagement,
    recurringManagement,
  };
}
