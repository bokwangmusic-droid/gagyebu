/**
 * 결제 알림 자동입력 — STEP 4. Marks the 후보함 candidate a NEW transaction
 * was started from as 처리 완료 — only once that transaction's save
 * succeeded.
 *
 * /input learns which candidate it came from through the `sourceCandidateId`
 * route param (src/lib/inputPrefill.ts) and reports how its create ended:
 *   - saved         createTransaction ok                       → handled
 *   - queued        offline queue accepted the same create     → handled
 *                   (the form already tells the user 저장했어요 and leaves;
 *                   the durable queue replays it with the same id)
 *   - failed        terminal create failure, form stays        → pending
 *   - queue-failed  durable enqueue failed, form stays         → pending
 * Validation failures never get this far (save() returns before writing),
 * and leaving the form without saving reports nothing.
 *
 * Marking handled is best effort and never throws: a failure here leaves the
 * candidate pending (the user can still tap 처리 완료) and never touches the
 * saved transaction. Pure apart from the injected IO.
 */
import {
  markCandidateHandled,
  prunePaymentCandidateState,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';

export type CreateSaveOutcome = 'saved' | 'queued' | 'failed' | 'queue-failed';

export interface CandidateStateIO {
  /** The stored state as-is; `null` = nothing stored / unreadable. */
  load: () => Promise<unknown>;
  save: (state: PaymentCandidateState) => Promise<void>;
}

const FINGERPRINT_RE = /^pc1_[0-9a-z]{1,16}$/;

export function isPaymentCandidateFingerprint(v: unknown): v is string {
  return typeof v === 'string' && FINGERPRINT_RE.test(v);
}

/** Whether this create outcome counts as "the transaction was saved". */
export function isCreateSaved(outcome: CreateSaveOutcome): boolean {
  return outcome === 'saved' || outcome === 'queued';
}

/**
 * Read-modify-write of the stored 후보함 state. Only an entry the inbox
 * already recorded (it opened /input from it) is marked, so a stray or
 * hand-made param can never create state, and an unreadable store is never
 * overwritten with an almost-empty map.
 */
export async function markStoredCandidateHandled(
  io: CandidateStateIO,
  fingerprint: string,
  now: number,
): Promise<boolean> {
  try {
    if (!isPaymentCandidateFingerprint(fingerprint)) return false;
    const raw = await io.load();
    if (raw == null) return false;
    const state = prunePaymentCandidateState(raw, now);
    const entry = state[fingerprint];
    if (!entry) return false;
    if (entry.handledAt != null) return true;
    await io.save(markCandidateHandled(state, fingerprint, now));
    return true;
  } catch {
    return false;
  }
}

/** What /input calls after a create ends. Never throws. */
export async function settleSourceCandidate(
  io: CandidateStateIO,
  sourceCandidateId: string | null,
  outcome: CreateSaveOutcome,
  now: number,
): Promise<boolean> {
  if (!sourceCandidateId || !isCreateSaved(outcome)) return false;
  return markStoredCandidateHandled(io, sourceCandidateId, now);
}
