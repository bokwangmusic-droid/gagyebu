/**
 * Transaction -> account balance rules — pure, no store/UI/Supabase imports.
 *
 * The AUTHORITATIVE balance change happens in the database
 * (supabase/migrations/20261004001900_asset_balance_sync.sql,
 * `private.trg_apply_transaction_asset_balance`): every transactions
 * INSERT / UPDATE / DELETE moves `assets.balance` by
 * (NEW effect − OLD effect). The client never writes a balance delta and
 * never queues an asset write for it, so an offline replay of the same
 * transaction can't double-apply.
 *
 * This file is the TypeScript MIRROR of that rule, used for
 *   - `transactionBalanceEffect` / `applyTransactionChange`: tests and docs
 *     of the exact rule the trigger implements;
 *   - `pendingAssetBalanceDeltas`: a DISPLAY-ONLY overlay so a balance shown
 *     while a transaction write is still queued offline already reflects
 *     it. The overlay is computed RELATIVE TO THE SERVER ROW each time, so
 *     once the server has applied the write (row present / updated / gone)
 *     its contribution drops to 0 automatically — never counted twice. It is
 *     never written back anywhere.
 */
import { normalizePaymentLink } from '@/lib/paymentLink';
import type { Transaction } from '@/store/types';

/** A transaction as the balance rule sees it. */
export type BalanceTxn = Pick<
  Transaction,
  'type' | 'amount' | 'paymentMethod' | 'sourceAssetId' | 'destinationAssetId'
> & {
  /** Soft-deleted rows have no effect. */
  deleted?: boolean;
  /**
   * `transactions.asset_balance_applied`: false for every row that existed
   * before the balance-sync migration — those never move a balance.
   */
  applied: boolean;
};

export interface BalanceEffect {
  assetId: string;
  /** Signed: expense −amount, income +amount. */
  delta: number;
}

/**
 * The account effect of one row (the trigger's OLD/NEW effect). Same links
 * the app keeps (`normalizePaymentLink`): 지출 이체/체크 -> 출금 계좌 −,
 * 수입 계좌 입금 -> 입금 계좌 +. 신용카드 / 현금 / 기타 -> none.
 */
export function transactionBalanceEffect(t: BalanceTxn | null | undefined): BalanceEffect | null {
  if (!t || !t.applied || t.deleted) return null;
  const link = normalizePaymentLink(t.type, t);
  if (t.type === 'expense' && link.sourceAssetId) return { assetId: link.sourceAssetId, delta: -t.amount };
  if (t.type === 'income' && link.destinationAssetId) return { assetId: link.destinationAssetId, delta: t.amount };
  return null;
}

/**
 * Apply one row change (`before` = OLD or null for INSERT, `after` = NEW or
 * null for DELETE) to a balance map — exactly what the trigger does.
 * Returns a new map; the input is not mutated.
 */
export function applyTransactionChange(
  balances: ReadonlyMap<string, number>,
  before: BalanceTxn | null,
  after: BalanceTxn | null,
): Map<string, number> {
  const out = new Map(balances);
  const o = transactionBalanceEffect(before);
  const n = transactionBalanceEffect(after);
  if (o && n && o.assetId === n.assetId && o.delta === n.delta) return out; // no-op
  if (o) out.set(o.assetId, (out.get(o.assetId) ?? 0) - o.delta);
  if (n) out.set(n.assetId, (out.get(n.assetId) ?? 0) + n.delta);
  return out;
}

/** The pending transaction op shapes this overlay reads (from src/lib/offlineQueue.ts). */
export type PendingTransactionOpLike =
  | { op: 'create'; entityId: string; payload: Omit<BalanceTxn, 'applied' | 'deleted'> }
  | { op: 'update'; entityId: string; payload: Omit<BalanceTxn, 'applied' | 'deleted'> }
  | { op: 'delete'; entityId: string };

/**
 * DISPLAY-ONLY balance deltas for transaction writes still waiting in the
 * offline queue, relative to the current server snapshot:
 *   create -> its effect, unless the server already has that row
 *   update -> effect(draft) − effect(server row); 0 once the server row
 *             already matches, and 0 for a pre-migration (not applied) row
 *   delete -> −effect(server row) while the row is still on the server
 * Terminal-failed ops are excluded (the server will not apply them).
 */
export function pendingAssetBalanceDeltas(
  serverTxns: readonly Transaction[],
  appliedById: (id: string) => boolean,
  ops: readonly PendingTransactionOpLike[],
  failedIds: ReadonlySet<string>,
): Map<string, number> {
  const byId = new Map(serverTxns.map((t) => [t.id, t]));
  let balances = new Map<string, number>();
  for (const op of ops) {
    if (failedIds.has(op.entityId)) continue;
    const server = byId.get(op.entityId);
    const serverRow: BalanceTxn | null = server ? { ...server, applied: appliedById(server.id) } : null;
    if (op.op === 'create') {
      if (!server) balances = applyTransactionChange(balances, null, { ...op.payload, applied: true });
    } else if (op.op === 'update') {
      if (serverRow) balances = applyTransactionChange(balances, serverRow, { ...op.payload, applied: serverRow.applied });
    } else if (serverRow) {
      balances = applyTransactionChange(balances, serverRow, null);
    }
  }
  return balances;
}

/** Signed won label: −12,345 / 12,345 (fmt() itself drops the sign). */
export function signedBalance(n: number, fmt: (v: number) => string): string {
  return n < 0 ? `−${fmt(n)}` : fmt(n);
}
