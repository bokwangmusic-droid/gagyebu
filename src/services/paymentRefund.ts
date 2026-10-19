/**
 * 카드 결제 취소 → 전액 취소 처리 (src/lib/paymentNotification/refundMatch.ts):
 * the real IO. The delete is the ordinary one — softDeleteTransaction
 * online, the durable offline delete queue on a transport failure — with
 * the row's server token (expectedUpdatedAt), exactly as /input's 삭제
 * does. The 후보함 state goes through its serialised read-modify-write.
 */
import type { RefundIO } from '@/lib/paymentNotification/refundMatch';
import { loadPaymentCandidateState, updatePaymentCandidateState } from '@/services/paymentCandidateState';
import { softDeleteTransaction } from '@/services/remoteFinanceWrite';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';

export function paymentRefundIO(args: {
  householdId: string;
  userId: string;
  /** The transaction's server token (transactionMeta[id].updatedAt), `null` = unknown. */
  expectedUpdatedAt: (transactionId: string) => string | null;
  /** usePendingWrites().enqueueTransactionDelete */
  enqueueTransactionDelete: (a: {
    scope: { userId: string; householdId: string };
    entityId: string;
    expectedUpdatedAt: string;
  }) => Promise<EnqueueOutcome>;
}): RefundIO {
  const scope = { userId: args.userId, householdId: args.householdId };
  return {
    softDelete: async (transactionId) => {
      const token = args.expectedUpdatedAt(transactionId);
      if (!token) return { ok: false, transport: false, reason: 'unavailable' };
      const res = await softDeleteTransaction({
        id: transactionId,
        householdId: args.householdId,
        expectedUserId: args.userId,
        expectedUpdatedAt: token,
      });
      return res.ok ? { ok: true } : { ok: false, transport: res.transport === true, reason: res.reason, message: res.message };
    },
    enqueueDelete: async (transactionId) => {
      const token = args.expectedUpdatedAt(transactionId);
      if (!token) return { ok: false, reason: 'unavailable' };
      const enq = await args.enqueueTransactionDelete({ scope, entityId: transactionId, expectedUpdatedAt: token });
      return enq.ok ? { ok: true } : { ok: false, reason: enq.reason };
    },
    loadState: loadPaymentCandidateState,
    // Nothing readable stored → start from the change applied to an empty map.
    updateState: (change) => updatePaymentCandidateState(change, change({})),
    now: () => Date.now(),
  };
}
