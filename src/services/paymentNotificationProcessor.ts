/**
 * 결제 알림 자동입력 — STEP 6. The app-wide instance of the payment
 * notification pass (src/lib/paymentNotification/processor.ts), wired to the
 * real native buffer, the stored 후보함 state, the server dedup and the
 * automatic save. One instance per JS runtime, so every trigger (app start /
 * foreground, the 결제 알림 screen, /input) shares its single flight.
 */
import { createPaymentNotificationProcessor } from '@/lib/paymentNotification/processor';
import { loadPaymentAutoSaveSince, paymentAutoSaveIO } from '@/services/paymentAutoSave';
import { loadPaymentCandidateState, updatePaymentCandidateState } from '@/services/paymentCandidateState';
import { registerPaymentEvents } from '@/services/paymentEventRegistration';
import { getCapturedNotifications, isPaymentNotificationSupported } from '@/services/paymentNotificationListener';

const processor = createPaymentNotificationProcessor({
  supported: isPaymentNotificationSupported,
  getCaptured: getCapturedNotifications,
  loadState: loadPaymentCandidateState,
  // Nothing readable stored → start from the change applied to an empty map.
  updateState: (change) => updatePaymentCandidateState(change, change({})),
  register: registerPaymentEvents,
  loadAutoSaveSince: loadPaymentAutoSaveSince,
  autoSave: paymentAutoSaveIO,
  now: () => Date.now(),
});

/** Never rejects. */
export const processPaymentNotifications = processor.run;
export const onPaymentNotificationsAutoSaved = processor.onSaved;

/** /input waits at most this long for a candidate's registration. */
const REGISTER_NOW_TIMEOUT_MS = 5000;

/**
 * /input, before saving from a candidate that is not registered yet:
 * registers it now so the save can use the event's derived id. Resolves
 * `false` (save with the ordinary id) when it is offline, fails or takes
 * longer than REGISTER_NOW_TIMEOUT_MS. Never rejects.
 */
export function registerPaymentCandidateNow(
  ctx: { householdId: string; userId: string },
  sourceCandidateId: string,
): Promise<boolean> {
  return Promise.race([
    processor.registerCandidate(ctx, sourceCandidateId),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REGISTER_NOW_TIMEOUT_MS)),
  ]).catch(() => false);
}
