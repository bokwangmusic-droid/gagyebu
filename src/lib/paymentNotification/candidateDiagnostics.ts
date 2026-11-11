/**
 * 결제 알림 후보함 — READ-ONLY diagnostics for real-device QA: a candidate's
 * stored 후보함 state and, for its recorded manual save (manualTxnId), the
 * same "is it alive?" answer /input's existing-payment check gets
 * (existingPayment.ts) — and where that answer came from:
 *   queue   this device's offline-queue op decided it (queuedTransactionLiveness:
 *           a create, pending or terminal-failed, is `live`; a pending delete
 *           is `deleted`) — the server was not asked;
 *   server  no deciding queue op: the transactions row (this household,
 *           deleted_at) decided it (paymentTransactionLiveness).
 * Nothing here writes: no state change, no queue change, no transaction.
 * Pure apart from the injected IO; never throws.
 */
import type { PaymentCandidateStateEntry } from '@/lib/paymentNotification/candidateInbox';
import {
  queuedTransactionLiveness,
  type PaymentTransactionLiveness,
} from '@/lib/paymentNotification/existingPayment';

/** This device's queued op for a transaction id, as the queue holds it. */
export interface QueuedTransactionDiagnostic {
  op: 'create' | 'update' | 'delete';
  /** Terminal failure, held for a manual retry ("전송 실패"); false = still waiting to send. */
  failed: boolean;
  attemptCount: number | null;
  enqueuedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorReason: string | null;
}

export interface ManualTxnDiagnostic {
  transactionId: string;
  /** manualHouseholdId === the active household — only then does /input use it. */
  sameHousehold: boolean;
  queued: QueuedTransactionDiagnostic | null;
  liveness: PaymentTransactionLiveness;
  source: 'queue' | 'server';
}

export interface CandidateDiagnostic {
  fingerprint: string;
  registeredEventId: string | null;
  registeredHouseholdId: string | null;
  manualTxnId: string | null;
  manualHouseholdId: string | null;
  manualSavedAt: number | null;
  manualLinkedAt: number | null;
  manualLinkFailedAt: number | null;
  handledAt: number | null;
  sentAt: number | null;
  autoSaveTxnId: string | null;
  /** `null` = no manualTxnId recorded. */
  manual: ManualTxnDiagnostic | null;
}

export interface CandidateDiagnosticIO {
  queued: (transactionId: string) => QueuedTransactionDiagnostic | null;
  serverLiveness: (transactionId: string) => Promise<PaymentTransactionLiveness>;
}

export async function diagnosePaymentCandidate(
  fingerprint: string,
  entry: PaymentCandidateStateEntry | undefined,
  householdId: string,
  io: CandidateDiagnosticIO,
): Promise<CandidateDiagnostic> {
  const e = entry ?? {};
  const base: CandidateDiagnostic = {
    fingerprint,
    registeredEventId: e.registeredEventId ?? null,
    registeredHouseholdId: e.registeredHouseholdId ?? null,
    manualTxnId: e.manualTxnId ?? null,
    manualHouseholdId: e.manualHouseholdId ?? null,
    manualSavedAt: e.manualSavedAt ?? null,
    manualLinkedAt: e.manualLinkedAt ?? null,
    manualLinkFailedAt: e.manualLinkFailedAt ?? null,
    handledAt: e.handledAt ?? null,
    sentAt: e.sentAt ?? null,
    autoSaveTxnId: e.autoSaveTxnId ?? null,
    manual: null,
  };
  if (!e.manualTxnId) return base;

  let queued: QueuedTransactionDiagnostic | null = null;
  try {
    queued = io.queued(e.manualTxnId);
  } catch {
    queued = null;
  }
  const fromQueue = queuedTransactionLiveness(queued ? { op: queued.op, failed: queued.failed } : null);
  let liveness: PaymentTransactionLiveness;
  if (fromQueue) {
    liveness = fromQueue;
  } else {
    try {
      liveness = await io.serverLiveness(e.manualTxnId);
    } catch {
      liveness = 'unknown';
    }
  }
  return {
    ...base,
    manual: {
      transactionId: e.manualTxnId,
      sameHousehold: e.manualHouseholdId === householdId,
      queued,
      liveness,
      source: fromQueue ? 'queue' : 'server',
    },
  };
}
