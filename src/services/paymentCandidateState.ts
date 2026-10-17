/**
 * 결제 알림 자동입력 — STEP 3. Device-local persistence of the 후보함
 * state (src/lib/paymentNotification/candidateInbox.ts): fingerprint →
 * { sentAt, handledAt }. Only hashes and timestamps — never notification
 * text. Not part of the backup format, never sent to the server.
 */
import {
  prunePaymentCandidateState,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import { loadItem, saveItem } from '@/lib/storage';

const KEY = 'paymentNotificationCandidates.v1';

export async function loadPaymentCandidateState(): Promise<PaymentCandidateState> {
  return prunePaymentCandidateState(await loadItem<unknown>(KEY, {}), Date.now());
}

export async function savePaymentCandidateState(state: PaymentCandidateState): Promise<void> {
  await saveItem(KEY, prunePaymentCandidateState(state, Date.now()));
}
