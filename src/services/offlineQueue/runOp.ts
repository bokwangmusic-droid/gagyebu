/**
 * Offline Write Queue — server replay adapter. STEP 16-H2-A1 §8,
 * widened in STEP 16-H2-B1 (§13/§14), STEP 16-H2-C2-A1/B1 (card/category),
 * and STEP 16-H2-C2-BUDGET A1 (budget).
 *
 * Maps ONE `PendingWrite` back onto the EXISTING write service
 * (`createTransaction` / `updateTransaction` / `softDeleteTransaction`, or
 * the card/category/budget equivalents). It NEVER re-implements validation,
 * the session guard, the INSERT/UPDATE, the 23505 reconcile, or the
 * `expectedUpdatedAt` optimistic-concurrency check — it just calls the
 * service with the FROZEN queue values and normalises the result.
 * `expectedUpdatedAt` is taken verbatim from the record; it is never
 * refreshed to a newer token here (STEP 16-H2-B1 §5/§13).
 *
 * Budget is the one entity where the service layer is a SINGLE function
 * (`saveBudget`) for both CREATE and UPDATE — this adapter still keeps the
 * queue-level `op: 'create' | 'update'` distinction (so `PendingOpKind` and
 * every generic op-kind switch elsewhere needs no changes) and only decides
 * `expectedUpdatedAt: null` vs the frozen token when calling `saveBudget`.
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
import {
  createCard,
  softDeleteCard,
  updateCard,
  type CreateCardResult,
  type SoftDeleteCardResult,
  type UpdateCardResult,
} from '@/services/remoteCardWrite';
import {
  createCustomCategory,
  softDeleteCustomCategory,
  updateCustomCategory,
  type CreateCategoryResult,
  type SoftDeleteCategoryResult,
  type UpdateCategoryResult,
} from '@/services/remoteCategoryWrite';
import {
  saveBudget,
  softDeleteBudget,
  type SaveBudgetResult,
  type SoftDeleteBudgetResult,
} from '@/services/remoteBudgetWrite';
import {
  softDeleteCustomCategoryWithBudget,
  type SoftDeleteCustomCategoryWithBudgetResult,
} from '@/services/remoteCategoryBudgetWrite';
import type { NewCardDraft } from '@/lib/remoteCardWriteMapping';
import type { NewCustomCategoryDraft } from '@/lib/remoteCategoryWriteMapping';
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
  /** STEP 16-H2-C2-A1 — injected in tests; default to the real card services. */
  createCard?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    draft: NewCardDraft;
  }) => Promise<CreateCardResult>;
  updateCard?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
    draft: NewCardDraft;
  }) => Promise<UpdateCardResult>;
  softDeleteCard?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
  }) => Promise<SoftDeleteCardResult>;
  /** STEP 16-H2-C2-B1 — injected in tests; default to the real category services. */
  createCategory?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    draft: NewCustomCategoryDraft;
  }) => Promise<CreateCategoryResult>;
  updateCategory?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
    draft: NewCustomCategoryDraft;
  }) => Promise<UpdateCategoryResult>;
  softDeleteCategory?: (args: {
    id: string;
    householdId: string;
    expectedUserId: string;
    expectedUpdatedAt: string;
  }) => Promise<SoftDeleteCategoryResult>;
  /**
   * STEP 16-H2-C2-BUDGET A1 — injected in tests; default to the real
   * `saveBudget`/`softDeleteBudget`. Budget has ONE service function for
   * BOTH create and update (`saveBudget`, branching on nullable
   * `expectedUpdatedAt`) — there is no separate `createBudget`/`updateBudget`
   * pair to inject, unlike card/category.
   */
  saveBudget?: (args: {
    householdId: string;
    expectedUserId: string;
    category: string;
    amount: number;
    expectedUpdatedAt: string | null;
  }) => Promise<SaveBudgetResult>;
  softDeleteBudget?: (args: {
    householdId: string;
    expectedUserId: string;
    category: string;
    expectedUpdatedAt: string;
  }) => Promise<SoftDeleteBudgetResult>;
  /**
   * STEP 16-H2 A4.2 — injected in tests; defaults to the real
   * `softDeleteCustomCategoryWithBudget`. The composite atomic delete has ONE
   * service function (the RPC), so there is no create/update pair to inject.
   */
  softDeleteCustomCategoryWithBudget?: (args: {
    householdId: string;
    categoryId: string;
    expectedUserId: string;
    expectedCategoryUpdatedAt: string;
    expectedBudgetUpdatedAt: string | null;
  }) => Promise<SoftDeleteCustomCategoryWithBudgetResult>;
}

const isSetLike = (v: unknown): boolean =>
  v instanceof Set || (v != null && typeof (v as { has?: unknown }).has === 'function');

export async function runPendingWrite(
  op: PendingWrite,
  deps: RunOpDeps,
): Promise<RunOpOutcome> {
  if (
    op.entity !== 'transaction' &&
    op.entity !== 'card' &&
    op.entity !== 'category' &&
    op.entity !== 'budget' &&
    op.entity !== 'categoryBudget'
  ) {
    return { kind: 'terminal', message: `unsupported entity: ${(op as { entity: string }).entity}` };
  }

  try {
    // ---- COMPOSITE CATEGORY + BUDGET DELETE (STEP 16-H2 A4.2) ----
    if (op.entity === 'categoryBudget') {
      // `op.op` is always 'delete' (type + validator). ONE atomic RPC call —
      // NEVER decomposed into `softDeleteCustomCategory()` +
      // `softDeleteBudget()`. Both FROZEN tokens are forwarded verbatim and
      // are never refreshed on a replay.
      const del = deps.softDeleteCustomCategoryWithBudget ?? softDeleteCustomCategoryWithBudget;
      const res = await del({
        householdId: op.scope.householdId,
        categoryId: op.entityId,
        expectedUserId: op.scope.userId,
        expectedCategoryUpdatedAt: op.expectedCategoryUpdatedAt,
        expectedBudgetUpdatedAt: op.expectedBudgetUpdatedAt,
      });
      if (res.ok) return { kind: 'success' }; // both/neither tombstoned (idempotent replay = ok)
      if (res.transport) return { kind: 'transport', message: res.message };
      // identity | conflict | gone | error — all already in WriteConflictReason.
      return { kind: 'terminal', reason: res.reason, message: res.message };
    }

    // ---- BUDGET (STEP 16-H2-C2-BUDGET A1) ----
    if (op.entity === 'budget') {
      if (op.op === 'delete') {
        const del = deps.softDeleteBudget ?? softDeleteBudget;
        const res = await del({
          householdId: op.scope.householdId,
          expectedUserId: op.scope.userId,
          category: op.entityId,
          expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
        });
        if (res.ok) return { kind: 'success' }; // already-deleted is ok:true (idempotent)
        if (res.transport) return { kind: 'transport', message: res.message };
        return { kind: 'terminal', reason: res.reason, message: res.message };
      }

      // CREATE and UPDATE both go through the ONE `saveBudget()` — the
      // service itself branches on `expectedUpdatedAt` (null => INSERT +
      // 23505 reconcile, string => guarded UPDATE). There is no separate
      // createBudget/updateBudget to call.
      const save = deps.saveBudget ?? saveBudget;
      const res = await save({
        householdId: op.scope.householdId,
        expectedUserId: op.scope.userId,
        category: op.entityId,
        amount: op.payload.amount,
        expectedUpdatedAt: op.op === 'update' ? op.expectedUpdatedAt : null,
      });
      if (res.ok) return { kind: 'success' };
      if (res.transport) return { kind: 'transport', message: res.message };
      // STEP 16-H2-C2-BUDGET A1 §4 — normalize `BudgetWriteReason` (which
      // adds `invalid` + `exists` on top of the shared `WriteConflictReason`)
      // WITHOUT collapsing `exists` to reason-less:
      //   - `exists` is a REAL concurrency conflict — the natural-key slot
      //     is already occupied by a different row (another device's
      //     create/revive, or the same category with a different amount).
      //     Normalize to `conflict` so it is retained terminal-failed and
      //     NEVER auto-retried into a blind overwrite. `message` is preserved
      //     as-is.
      //   - `invalid` cannot be fixed by retrying (structural draft
      //     failure) -> reason-less generic terminal, same treatment as
      //     category's `invalid`.
      const reason: WriteConflictReason | undefined =
        res.reason === 'exists' ? 'conflict' : res.reason === 'invalid' ? undefined : res.reason;
      return { kind: 'terminal', ...(reason ? { reason } : {}), message: res.message };
    }

    // ---- CATEGORY (STEP 16-H2-C2-B1 §21–§23) ----
    if (op.entity === 'category') {
      if (op.op === 'create') {
        const create = deps.createCategory ?? createCustomCategory;
        const res = await create({
          id: op.entityId,
          householdId: op.scope.householdId,
          expectedUserId: op.scope.userId,
          draft: op.payload,
        });
        if (res.ok) return { kind: 'success' };
        if (res.transport) return { kind: 'transport', message: res.message };
        // CategoryWriteReason adds 'invalid' (structural) — not a conflict the
        // queue/UI can phrase, so it is flattened to a reason-less terminal.
        return {
          kind: 'terminal',
          ...(res.reason !== 'invalid' ? { reason: res.reason } : {}),
          message: res.message,
        };
      }
      if (op.op === 'update') {
        const update = deps.updateCategory ?? updateCustomCategory;
        const res = await update({
          id: op.entityId,
          householdId: op.scope.householdId,
          expectedUserId: op.scope.userId,
          expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
          draft: op.payload,
        });
        if (res.ok) return { kind: 'success' };
        if (res.transport) return { kind: 'transport', message: res.message };
        return {
          kind: 'terminal',
          ...(res.reason !== 'invalid' ? { reason: res.reason } : {}),
          message: res.message,
        };
      }
      // category delete
      const del = deps.softDeleteCategory ?? softDeleteCustomCategory;
      const res = await del({
        id: op.entityId,
        householdId: op.scope.householdId,
        expectedUserId: op.scope.userId,
        expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
      });
      if (res.ok) return { kind: 'success' }; // already-deleted is ok:true (idempotent)
      if (res.transport) return { kind: 'transport', message: res.message };
      return { kind: 'terminal', reason: res.reason, message: res.message };
    }

    // ---- CARD (STEP 16-H2-C2-A1 §16–§18) ----
    if (op.entity === 'card') {
      if (op.op === 'create') {
        const create = deps.createCard ?? createCard;
        const res = await create({
          id: op.entityId,
          householdId: op.scope.householdId,
          expectedUserId: op.scope.userId,
          draft: op.payload,
        });
        if (res.ok) return { kind: 'success' };
        if (res.transport) return { kind: 'transport', message: res.message };
        return { kind: 'terminal', message: res.message }; // CreateCardResult carries no reason
      }
      if (op.op === 'update') {
        const update = deps.updateCard ?? updateCard;
        const res = await update({
          id: op.entityId,
          householdId: op.scope.householdId,
          expectedUserId: op.scope.userId,
          expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
          draft: op.payload,
        });
        if (res.ok) return { kind: 'success' };
        if (res.transport) return { kind: 'transport', message: res.message };
        return { kind: 'terminal', reason: res.reason, message: res.message };
      }
      // card delete
      const del = deps.softDeleteCard ?? softDeleteCard;
      const res = await del({
        id: op.entityId,
        householdId: op.scope.householdId,
        expectedUserId: op.scope.userId,
        expectedUpdatedAt: op.expectedUpdatedAt, // FROZEN — never refreshed
      });
      if (res.ok) return { kind: 'success' }; // already-deleted is ok:true (idempotent)
      if (res.transport) return { kind: 'transport', message: res.message };
      return { kind: 'terminal', reason: res.reason, message: res.message };
    }

    // ---- TRANSACTION ----
    // Runtime guard for JS callers that bypassed the (required) type — never
    // silently fall back to an empty Set (STEP 16-H2-A1.1 FIX 2). Only the
    // transaction path needs `knownCardIds` (the dangling-cardId guard).
    if (!deps || !isSetLike(deps.knownCardIds)) {
      return { kind: 'terminal', message: 'internal: runPendingWrite requires deps.knownCardIds' };
    }

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
