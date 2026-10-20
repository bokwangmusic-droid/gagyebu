/**
 * 결제 알림 자동입력 — STEP 3. Device-local persistence of the 후보함
 * state (src/lib/paymentNotification/candidateInbox.ts): fingerprint →
 * { sentAt, handledAt, registeredAt }. Only hashes and timestamps — never notification
 * text. Not part of the backup format, never sent to the server.
 *
 * STEP 4: /input also writes here (auto 처리 완료 after a save), so every
 * load / save runs one at a time — the 후보함 reloading on focus always sees
 * a write that was started before it.
 */
import {
  settleSourceCandidate,
  type CandidateStateIO,
  type CreatedTransactionRef,
  type CreateSaveOutcome,
} from '@/lib/paymentNotification/candidateAutoHandle';
import { paymentCandidateTransactionId } from '@/lib/paymentNotification/autoSave';
import {
  prunePaymentCandidateState,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import { loadItem, saveItem } from '@/lib/storage';

const KEY = 'paymentNotificationCandidates.v1';

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export function loadPaymentCandidateState(): Promise<PaymentCandidateState> {
  return serial(async () => prunePaymentCandidateState(await loadItem<unknown>(KEY, {}), Date.now()));
}

/**
 * Applies `change` to the STORED state (not the caller's copy), so a write
 * made meanwhile elsewhere — /input's auto 처리 완료 — is never overwritten
 * by an older snapshot. `fallback` is saved instead when nothing readable is
 * stored.
 */
export function updatePaymentCandidateState(
  change: (state: PaymentCandidateState) => PaymentCandidateState,
  fallback: PaymentCandidateState,
): Promise<PaymentCandidateState> {
  return serial(async () => {
    const raw = await loadItem<unknown>(KEY, null);
    const next = raw == null ? fallback : change(prunePaymentCandidateState(raw, Date.now()));
    await saveItem(KEY, prunePaymentCandidateState(next, Date.now()));
    return next;
  });
}

// `null` fallback: nothing stored / unreadable → the auto 처리 완료 is skipped.
const io: CandidateStateIO = {
  load: () => loadItem<unknown>(KEY, null),
  save: (state) => saveItem(KEY, prunePaymentCandidateState(state, Date.now())),
};

/**
 * Called by /input when a create ends: 처리 완료 for the candidate it came
 * from, only for a saved / queued create. Never rejects; `false` = the
 * candidate was left pending.
 */
export function settlePaymentCandidateAfterCreate(
  sourceCandidateId: string | null,
  outcome: CreateSaveOutcome,
  saved?: CreatedTransactionRef,
): Promise<boolean> {
  if (!sourceCandidateId) return Promise.resolve(false);
  return serial(() => settleSourceCandidate(io, sourceCandidateId, outcome, Date.now(), saved)).catch(() => false);
}

/**
 * STEP 6: the transaction id /input must use for a new transaction started
 * from this candidate — `txn-pn-<server event id>` when it is registered in
 * this household, `null` otherwise (keep the ordinary random id). Never
 * rejects.
 */
export function resolvePaymentCandidateTransactionId(
  sourceCandidateId: string,
  householdId: string,
): Promise<{ transactionId: string; eventId: string } | null> {
  return loadPaymentCandidateState()
    .then((state) => paymentCandidateTransactionId(state, sourceCandidateId, householdId))
    .catch(() => null);
}

/**
 * The transaction the user saved from this candidate in this household
 * (manualTxnId), `null` = none recorded. Never rejects.
 */
export function loadPaymentCandidateManualTransactionId(
  sourceCandidateId: string,
  householdId: string,
): Promise<string | null> {
  return loadPaymentCandidateState()
    .then((state) => {
      const entry = state[sourceCandidateId];
      return entry?.manualTxnId && entry.manualHouseholdId === householdId ? entry.manualTxnId : null;
    })
    .catch(() => null);
}
