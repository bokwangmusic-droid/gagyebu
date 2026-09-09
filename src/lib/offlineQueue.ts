/**
 * Offline Write Queue — pure core. STEP 16-H2-A1, widened in H2-B1, again in
 * STEP 16-H2-C2-A1 (card), and again in STEP 16-H2-C2-B1 (custom category).
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
 * DELETE stays UI-blocked on the Budget queue). `entity` is now
 * `'transaction' | 'card' | 'category'`; `op` is a 3-way union per entity.
 * `schemaVersion` STAYS 1 — a stored transaction/card queue loads with no
 * migration; a category record simply has `entity:'category'`.
 *
 * IMPORTANT (H2-C2-A1 §8/§9/§15, H2-C2-B1 §12/§13): a pending/failed CARD or
 * CATEGORY is NEVER folded into `RemoteFinanceData.cards` / `.customCats` /
 * `.categoryMeta` / `.catOrder`. `composeFinance` returns card and category
 * display rows in SEPARATE `cardManagement` / `categoryManagement`
 * collections so the transaction/planned/recurring/budget pickers, stats
 * name resolution, backup and household-import snapshots only ever see
 * authoritative server data — no cross-entity chaining is structurally
 * possible.
 */
import type { Category, CustomCatMap } from '@/data/categories';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewCustomCategoryDraft } from '@/lib/remoteCategoryWriteMapping';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { RemoteFinanceData, RemoteTransactionMeta } from '@/lib/remoteFinanceMapping';
import type { WriteConflictReason } from '@/services/remoteFinanceWrite';
import type { CreditCard, Transaction } from '@/store/types';

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
export type PendingEntity = 'transaction' | 'card' | 'category';

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

export type PendingWrite =
  | PendingTransactionCreate
  | PendingTransactionUpdate
  | PendingTransactionDelete
  | PendingCardCreate
  | PendingCardUpdate
  | PendingCardDelete
  | PendingCategoryCreate
  | PendingCategoryUpdate
  | PendingCategoryDelete;

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

/** Returns the record narrowed to `PendingWrite`, or `null` if anything is off. */
export function validatePendingWrite(x: unknown): PendingWrite | null {
  if (x == null || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (r.schemaVersion !== QUEUE_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(r.queueId)) return null;
  if (r.entity !== 'transaction' && r.entity !== 'card' && r.entity !== 'category') return null;
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

/**
 * Is `b` the EXACT SAME request as `a` — safe to treat a re-enqueue as an
 * idempotent no-op? Same dedup identity (scope+entity+op+entityId) is assumed.
 *   - transaction CREATE: yes by identity alone (STEP 16-H2-A1 §12).
 *   - transaction UPDATE: also same frozen `expectedUpdatedAt`, same
 *     `originalRawCardId`, same draft.
 *   - card CREATE: identity AND same draft — a DIFFERING card CREATE for the
 *     same id is `existing-pending`, never a silent overwrite (§7/§10).
 *   - card UPDATE: same frozen `expectedUpdatedAt` AND same draft.
 *   - DELETE (either entity): same frozen `expectedUpdatedAt`.
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
   * authoritative server customCats, with a pending UPDATE overlaid, plus a
   * synthetic entry for a pending/failed CREATE, plus a synthetic entry for a
   * FAILED UPDATE whose server row is gone, minus a not-failed pending DELETE.
   * DELIBERATELY separate from `data.customCats` (§12/§13) so the
   * transaction/planned/recurring/budget category pickers, stats name
   * resolution, backup and household-import only ever see authoritative server
   * categories — no cross-entity chaining is possible. Same `{ expense, income }`
   * shape as `data.customCats`. Equals `data.customCats` when there are no
   * category ops.
   */
  rows: CustomCatMap;
  /** category id -> the pending op that produced or marks it. */
  opById: ReadonlyMap<string, 'create' | 'update' | 'delete'>;
  /** category ids currently in a TERMINAL failed state. */
  failedIds: ReadonlySet<string>;
  /** server category ids hidden from `rows` by a not-failed pending DELETE. */
  hiddenIds: string[];
}

function composeCategoryManagement(
  serverCats: CustomCatMap,
  ops: readonly PendingWrite[],
  failedCategoryIds?: ReadonlySet<string>,
): CategoryManagementView {
  const opById = new Map<string, 'create' | 'update' | 'delete'>();
  const failedIds = new Set<string>();
  const hiddenIds: string[] = [];
  const catOps = ops.filter(
    (o): o is PendingCategoryCreate | PendingCategoryUpdate | PendingCategoryDelete =>
      o.entity === 'category',
  );
  if (catOps.length === 0) {
    return { rows: serverCats, opById, failedIds, hiddenIds };
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
      if (failed(op.entityId)) failedIds.add(op.entityId);
      continue;
    }

    if (op.op === 'update') {
      if (hit) {
        hit.list[hit.idx] = applyCategoryUpdate(hit.list[hit.idx], op.payload);
        opById.set(op.entityId, 'update');
        if (failed(op.entityId)) failedIds.add(op.entityId);
        continue;
      }
      // server row gone: only a TERMINAL-failed UPDATE gets a display-only
      // synthetic row (a not-failed one just waits — like transactions/cards).
      if (failed(op.entityId)) {
        rows[op.payload.type].push(categoryDraftToDomain(op));
        opById.set(op.entityId, 'update');
        failedIds.add(op.entityId);
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

  return { rows, opById, failedIds, hiddenIds };
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
): ComposedFinance {
  const cardManagement = composeCardManagement(serverData.cards, ops, failedCardIds);
  const categoryManagement = composeCategoryManagement(
    serverData.customCats,
    ops,
    failedCategoryIds,
  );

  const txnOps = ops.filter((o) => o.entity === 'transaction');
  if (txnOps.length === 0) {
    return {
      data: serverData,
      pendingIds: [],
      hiddenIds: [],
      orphanedFailedUpdates: [],
      cardManagement,
      categoryManagement,
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
  };
}
