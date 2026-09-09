/**
 * Offline Write Queue — server replay adapter. STEP 16-H2-A1 §8,
 * widened in STEP 16-H2-B1 (§13/§14).
 *
 * Maps ONE `PendingWrite` back onto the EXISTING write service
 * (`createTransaction` / `updateTransaction` / `softDeleteTransaction`). It
 * NEVER re-implements validation, the session guard, the INSERT/UPDATE, the
 * 23505 reconcile, or the `expectedUpdatedAt` optimistic-concurrency check —
 * it just calls the service with the FROZEN queue values and normalises the
 * result. `expectedUpdatedAt` is taken verbatim from the record; it is never
 * refreshed to a newer token here (STEP 16-H2-B1 §5/§13).
 */
import {
  createTransaction,
  softDeleteTransaction,
  updateTransaction,
  type CreateTransactionResult,
  type SoftDeleteResult,
  type UpdateTransactionResult,
  type WriteConflictReason,
} from '@/services/remoteFinanceWrite';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';
import type { PendingWrite } from '@/lib/offlineQueue';

export type RunOpOutcome =
  /** Server accepted it (incl. an idempotent 23505 / updated_at reconcile). */
  | { kind: 'success' }
  /** Network/transport failure — retry later, keep the item. */
  | { kind: 'transport'; message: string }
  /**
   * A server verdict the queue cannot fix. `reason` is the ORIGINAL service
   * reason (`conflict` / `deleted` / `gone` / `identity` / `error`) for
   * UPDATE/DELETE — NOT collapsed into the message — so the coordinator / UI
   * can phrase it (STEP 16-H2-B1 §11/§17). `undefined` for CREATE (its
   * result carries no `reason`).
   */
  | { kind: 'terminal'; reason?: WriteConflictReason; message: string };

export interface RunOpDeps {
  /**
   * The household's current live (non-deleted) card ids — for the
   * dangling-cardId guard in `createTransaction` / `updateTransaction`.
   * REQUIRED, no default (STEP 16-H2-A1.1 FIX 2). DELETE ignores it, but the
   * API keeps it required so a caller can't accidentally omit it for the
   * ops that DO need it. An empty `Set` is a deliberate "no known cards".
   */
  knownCardIds: ReadonlySet<string>;
  /** Injected in tests; default to the real services. */
  createTransaction?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    draft: NewTransactionDraft;
    knownCardIds: ReadonlySet<string>;
  }) => Promise<CreateTransactionResult>;
  updateTransaction?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
    draft: NewTransactionDraft;
    knownCardIds: ReadonlySet<string>;
    originalRawCardId?: string | null;
  }) => Promise<UpdateTransactionResult>;
  softDeleteTransaction?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
  }) => Promise<SoftDeleteResult>;
}

const isSetLike = (v: unknown): boolean =>
  v instanceof Set || (v != null && typeof (v as { has?: unknown }).has === 'function');

export async function runPendingWrite(
  op: PendingWrite,
  deps: RunOpDeps,
): Promise<RunOpOutcome> {
  if (op.entity !== 'transaction') {
    return { kind: 'terminal', message: `unsupported entity: ${op.entity}` };
  }

  // Runtime guard for JS callers that bypassed the (required) type — never
  // silently fall back to an empty Set (STEP 16-H2-A1.1 FIX 2).
  if (!deps || !isSetLike(deps.knownCardIds)) {
    return { kind: 'terminal', message: 'internal: runPendingWrite requires deps.knownCardIds' };
  }

  try {
    if (op.op === 'create') {
      const create = deps.createTransaction ?? createTransaction;
      const res = await create({
        id: op.entityId,
        householdId: op.scope.householdId,
        expectedUserId: op.scope.userId,
        draft: op.payload,
        knownCardIds: deps.knownCardIds,
      });
      if (res.ok) return { kind: 'success' };
      if (res.transport) return { kind: 'transport', message: res.message };
      return { kind: 'terminal', message: res.message };
    }

    if (op.op === 'update') {
      const update = deps.updateTransaction ?? updateTransaction;
      const res = await update({
        id: op.entityId,
        householdId: op.scope.householdId,
        expectedUserId: op.scope.userId,
        expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
        draft: op.payload,
        knownCardIds: deps.knownCardIds,
        originalRawCardId: op.originalRawCardId,
      });
      if (res.ok) return { kind: 'success' };
      if (res.transport) return { kind: 'transport', message: res.message };
      return { kind: 'terminal', reason: res.reason, message: res.message };
    }

    // delete
    const del = deps.softDeleteTransaction ?? softDeleteTransaction;
    const res = await del({
      id: op.entityId,
      householdId: op.scope.householdId,
      expectedUserId: op.scope.userId,
      expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
    });
    if (res.ok) return { kind: 'success' };
    if (res.transport) return { kind: 'transport', message: res.message };
    return { kind: 'terminal', reason: res.reason, message: res.message };
  } catch (e) {
    // The remote write services are result-based; unexpected throws are
    // retained/retried conservatively (as `transport`) to avoid dropping a
    // durable user write. Revisit alongside retry/backoff UX in H2-B2.
    return { kind: 'transport', message: `threw: ${String(e)}` };
  }
}
