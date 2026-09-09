/**
 * Offline Write Queue — server replay adapter. STEP 16-H2-A1 §8.
 *
 * Maps ONE `PendingWrite` back onto the EXISTING write service. It does NOT
 * re-implement validation, the session guard, the INSERT, or 23505
 * reconciliation — it calls `createTransaction()` and normalises the result
 * into the three outcomes the flusher reasons about.
 *
 * H2-A1 handles `transaction`/`create` only. Anything else is a terminal
 * "unsupported" — a later rollout adds cases.
 */
import { createTransaction, type CreateTransactionResult } from '@/services/remoteFinanceWrite';
import type { PendingWrite } from '@/lib/offlineQueue';

export type RunOpOutcome =
  /** Server accepted it (incl. an idempotent 23505 reconcile). */
  | { kind: 'success' }
  /** Network/transport failure — retry later, keep the item. */
  | { kind: 'transport'; message: string }
  /** A server verdict the queue cannot fix (identity / invalid / 23505 mismatch). */
  | { kind: 'terminal'; message: string };

export interface RunOpDeps {
  /**
   * The household's current live (non-deleted) card ids — for
   * `createTransaction`'s dangling-cardId guard.
   *
   * STEP 16-H2-A1.1 FIX 2: REQUIRED, no default. A pending transaction may
   * legitimately carry a `cardId`; if a caller forgot to pass this, an empty
   * default would make EVERY `cardId` look unknown and be silently written
   * as `null` — a quiet meaning change on a durable user write. The type now
   * forbids omission; `runPendingWrite` also guards at runtime for JS
   * callers that bypass the types.
   *
   * Passing an empty `Set` is a deliberate "this household has no known
   * cards (yet)" statement and is fine — `createTransaction`'s existing
   * unknown-card policy then applies, unchanged.
   */
  knownCardIds: ReadonlySet<string>;
  /** Injected in tests. Defaults to the real service. */
  createTransaction?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    draft: PendingWrite['payload'];
    knownCardIds: ReadonlySet<string>;
  }) => Promise<CreateTransactionResult>;
}

export async function runPendingWrite(
  op: PendingWrite,
  deps: RunOpDeps,
): Promise<RunOpOutcome> {
  if (op.entity !== 'transaction' || op.op !== 'create') {
    return { kind: 'terminal', message: `unsupported op: ${op.entity}/${op.op}` };
  }

  // Runtime guard for JS callers that bypassed the (now required) type.
  // Never silently fall back to an empty Set (STEP 16-H2-A1.1 FIX 2).
  const known = deps && (deps.knownCardIds as unknown);
  const isSetLike =
    known instanceof Set ||
    (known != null && typeof (known as { has?: unknown }).has === 'function');
  if (!isSetLike) {
    return { kind: 'terminal', message: 'internal: runPendingWrite requires deps.knownCardIds' };
  }

  const create = deps.createTransaction ?? createTransaction;
  let res: CreateTransactionResult;
  try {
    res = await create({
      id: op.entityId,
      householdId: op.scope.householdId,
      expectedUserId: op.scope.userId,
      draft: op.payload,
      knownCardIds: deps.knownCardIds,
    });
  } catch (e) {
    // The remote write services are result-based; unexpected throws are
    // retained/retried conservatively (as `transport`) to avoid dropping a
    // durable user write. Revisit alongside retry/backoff UX in H2-A2.
    return { kind: 'transport', message: `threw: ${String(e)}` };
  }

  if (res.ok) return { kind: 'success' };
  if (res.transport) return { kind: 'transport', message: res.message };
  return { kind: 'terminal', message: res.message };
}
