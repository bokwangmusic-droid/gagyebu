/**
 * Offline Write Queue — pure core. STEP 16-H2-A1.
 *
 * NO Supabase, NO AsyncStorage, NO React. Just the record shape, the
 * validator, the FIFO / idempotent enqueue, the scope filter, and the
 * transaction-CREATE read overlay. Storage side-effects live in
 * src/services/offlineQueue/persistence.ts; server replay in
 * .../runOp.ts; sequencing in .../flusher.ts.
 *
 * Scope of H2-A1: transaction CREATE only. The record `entity`/`op` are
 * literal (`'transaction'` / `'create'`) rather than a wide union — later
 * entity rollouts widen them. Nothing here is wired to the UI.
 */
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { RemoteFinanceData, RemoteTransactionMeta } from '@/lib/remoteFinanceMapping';
import type { Transaction } from '@/store/types';

export const QUEUE_SCHEMA_VERSION = 1 as const;
export const MAX_PENDING_WRITES = 200;

export interface PendingWriteScope {
  userId: string;
  householdId: string;
}

/**
 * ONE queued write. `payload` is exactly what `createTransaction()` will be
 * re-handed (a `NewTransactionDraft` — purely user-editable fields, no
 * id/household/identity/timestamp). Server-derived values are never stored:
 * `created_by` is set by a DB trigger, `household_id` lives only in `scope`,
 * and the client-stable transaction id lives only in `entityId`.
 */
export interface PendingWrite {
  /** Queue-internal identity — distinct from `entityId` (see the dedup rule). */
  queueId: string;
  schemaVersion: typeof QUEUE_SCHEMA_VERSION;
  scope: PendingWriteScope;
  entity: 'transaction';
  op: 'create';
  /** The client-stable `txn-…` id handed to `createTransaction({ id })`. */
  entityId: string;
  payload: NewTransactionDraft;
  enqueuedAt: string;
  attemptCount: number;
  lastAttemptAt?: string;
  lastError?: string;
}

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

/** Returns the record narrowed to `PendingWrite`, or `null` if anything is off. */
export function validatePendingWrite(x: unknown): PendingWrite | null {
  if (x == null || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (r.schemaVersion !== QUEUE_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(r.queueId)) return null;
  if (r.entity !== 'transaction' || r.op !== 'create') return null;
  if (!isNonEmptyString(r.entityId)) return null;
  const scope = r.scope as Record<string, unknown> | undefined;
  if (scope == null || !isNonEmptyString(scope.userId) || !isNonEmptyString(scope.householdId)) return null;
  if (!isValidDraft(r.payload)) return null;
  if (!isNonEmptyString(r.enqueuedAt)) return null;
  if (typeof r.attemptCount !== 'number' || !Number.isInteger(r.attemptCount) || r.attemptCount < 0) return null;
  if (r.lastAttemptAt !== undefined && typeof r.lastAttemptAt !== 'string') return null;
  if (r.lastError !== undefined && typeof r.lastError !== 'string') return null;

  return {
    queueId: r.queueId,
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: scope.userId, householdId: scope.householdId },
    entity: 'transaction',
    op: 'create',
    entityId: r.entityId,
    payload: r.payload,
    enqueuedAt: r.enqueuedAt,
    attemptCount: r.attemptCount,
    ...(r.lastAttemptAt !== undefined ? { lastAttemptAt: r.lastAttemptAt as string } : {}),
    ...(r.lastError !== undefined ? { lastError: r.lastError as string } : {}),
  };
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

export function makePendingTransactionCreate(args: {
  scope: PendingWriteScope;
  entityId: string;
  payload: NewTransactionDraft;
  queueId?: string;
  now?: () => string;
}): PendingWrite {
  return {
    queueId: args.queueId ?? defaultQueueId(),
    schemaVersion: QUEUE_SCHEMA_VERSION,
    scope: { userId: args.scope.userId, householdId: args.scope.householdId },
    entity: 'transaction',
    op: 'create',
    entityId: args.entityId,
    payload: args.payload,
    enqueuedAt: (args.now ?? (() => new Date().toISOString()))(),
    attemptCount: 0,
  };
}

/** `${userId}|${householdId}|${entity}|${op}|${entityId}` — the dedup identity. */
function dedupKey(w: Pick<PendingWrite, 'scope' | 'entity' | 'op' | 'entityId'>): string {
  return `${w.scope.userId}|${w.scope.householdId}|${w.entity}|${w.op}|${w.entityId}`;
}

export type EnqueueResult =
  | { ok: true; queue: PendingWrite[]; record: PendingWrite; deduped: boolean }
  | { ok: false; reason: 'cap'; queue: PendingWrite[] };

/**
 * Append `record` to `queue` (FIFO). Pure — returns a new array.
 *
 *  - Idempotent: if an entry with the same dedup identity (or the same
 *    `queueId`) already exists, the queue is unchanged and the EXISTING
 *    record is returned with `deduped: true`. A retry of the same create
 *    never produces a second entry (STEP 16-H2-A1 §12).
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
    return { ok: true, queue: queue.slice(), record: existing, deduped: true };
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
 * Read overlay — transaction CREATE only
 * ------------------------------------------------------------------ */

function pendingTransactionToDomain(op: PendingWrite): Transaction {
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

function pendingTransactionMeta(op: PendingWrite): RemoteTransactionMeta {
  return {
    updatedAt: op.enqueuedAt,
    createdBy: op.scope.userId,
    rawCardId: op.payload.cardId ?? null,
  };
}

export interface ComposedFinance {
  /** `serverData` with pending overlays applied. A NEW object when anything
   *  changed; the SAME reference when nothing applied. `serverData` and its
   *  arrays/maps are never mutated. */
  data: RemoteFinanceData;
  /** entity ids that exist only because of a pending create — for a future
   *  "전송 대기" marker. Not wired to any UI in this step. */
  pendingIds: string[];
}

/**
 * Overlay pending transaction CREATEs onto an authoritative snapshot.
 *
 *  - A pending create whose `entityId` is ALREADY in `serverData.transactions`
 *    is skipped (the server row won — flush landed; no duplicate).
 *  - Otherwise a synthetic domain row + a synthetic meta are appended, in
 *    enqueue order.
 *  - Non-transaction / non-create ops are ignored (later rollouts handle them).
 *  - `recentTransactions` (src/lib/aggregate.ts) stays compatible: a pending
 *    row carries its real `txn-<ms>-…` id and real `date`, so it sorts
 *    deterministically alongside server rows.
 */
export function composeFinance(
  serverData: RemoteFinanceData,
  ops: readonly PendingWrite[],
): ComposedFinance {
  const creates = ops.filter((o) => o.entity === 'transaction' && o.op === 'create');
  if (creates.length === 0) return { data: serverData, pendingIds: [] };

  const serverIds = new Set(serverData.transactions.map((t) => t.id));
  const added = new Set<string>();
  const extraTxns: Transaction[] = [];
  const extraMeta: Record<string, RemoteTransactionMeta> = {};
  const pendingIds: string[] = [];

  for (const op of creates) {
    if (serverIds.has(op.entityId) || added.has(op.entityId)) continue;
    added.add(op.entityId);
    extraTxns.push(pendingTransactionToDomain(op));
    extraMeta[op.entityId] = pendingTransactionMeta(op);
    pendingIds.push(op.entityId);
  }

  if (extraTxns.length === 0) return { data: serverData, pendingIds: [] };

  return {
    data: {
      ...serverData,
      transactions: [...serverData.transactions, ...extraTxns],
      transactionMeta: { ...serverData.transactionMeta, ...extraMeta },
    },
    pendingIds,
  };
}
