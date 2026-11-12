/**
 * 결제 알림 화면 — the words the user sees for a 후보's status and for a
 * captured notification the parser did not turn into a 후보. Display only:
 * reads the inbox item and its stored state, never an id or a timestamp, so
 * nothing internal (fingerprint, event / transaction / household id, epoch
 * ms, queue or server state) can reach the label.
 */
import type { PaymentCandidateStateEntry, PaymentInboxItem } from '@/lib/paymentNotification/candidateInbox';
import type { ParsedPaymentCandidate } from '@/lib/paymentNotification/parserTypes';

export type PaymentCandidateStatusLabel =
  | '확인 대기'
  | '입력 화면으로 보냄'
  | '처리 완료'
  | '가계부 저장 완료'
  | '환불 처리 완료'
  | '자동저장됨';

export function paymentCandidateStatusLabel(
  item: Pick<PaymentInboxItem, 'status' | 'sentToInput' | 'autoSaved' | 'refundTxnId'>,
  entry: PaymentCandidateStateEntry | undefined,
): PaymentCandidateStatusLabel {
  if (item.autoSaved) return '자동저장됨';
  if (item.refundTxnId) return '환불 처리 완료';
  if (item.status === 'handled') return entry?.manualTxnId ? '가계부 저장 완료' : '처리 완료';
  return item.sentToInput ? '입력 화면으로 보냄' : '확인 대기';
}

/** A captured notification that is not a 후보: `null` = it was read as one. */
export function capturedNotificationLabel(candidate: ParsedPaymentCandidate | null): string | null {
  if (candidate?.ignoredReason) return '거래 후보 아님 · 광고/혜택 알림';
  if (!candidate || candidate.direction === 'unknown' || candidate.amount == null) {
    return `해석 불가 / 확인 필요${!candidate ? ' · 지원하지 않는 알림' : ''}`;
  }
  return null;
}
