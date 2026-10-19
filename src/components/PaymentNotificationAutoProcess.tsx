/**
 * 결제 알림 자동입력 — STEP 6. Runs the payment notification pass
 * (src/services/paymentNotificationProcessor.ts) without the user opening
 * the 결제 알림 screen: once shortly after start-up (signed in, household
 * loaded) and every time the app comes back to the foreground. Registration,
 * link retries and — only with "확실한 카드 결제 자동입력" on — the automatic
 * save of eligible card payments. Renders nothing.
 *
 * Fire-and-forget: the pass never rejects and runs off the render path, so
 * neither start-up nor a resume waits for it or can fail because of it.
 * Nothing runs while the app is in the background (no native / WorkManager
 * work here — the listener only buffers notifications meanwhile).
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useToast } from '@/components/ui/Toast';
import { fmt } from '@/lib/format';
import {
  onPaymentNotificationsAutoSaved,
  processPaymentNotifications,
} from '@/services/paymentNotificationProcessor';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { useRemoteFinance } from '@/store/remoteFinance';

/** After first paint, so the pass never competes with start-up. */
const START_DELAY_MS = 1500;

export function PaymentNotificationAutoProcess() {
  const { session } = useAuth();
  const { activeHousehold, loading, loadedForUserId } = useHousehold();
  const { refreshRemoteFinance } = useRemoteFinance();
  const toast = useToast();
  const userId = session?.user?.id ?? null;
  const householdId = userId && !loading && loadedForUserId === userId ? (activeHousehold?.id ?? null) : null;

  // One short line per pass that saved something; the ledger is refreshed.
  useEffect(
    () =>
      onPaymentNotificationsAutoSaved((saved) => {
        void refreshRemoteFinance().catch(() => {});
        const first = saved[0];
        toast.show(
          saved.length === 1 && first.merchant
            ? `${first.merchant} ${fmt(first.amount)}원 자동 입력`
            : `카드 결제 ${saved.length}건 자동 입력`,
        );
      }),
    [refreshRemoteFinance, toast],
  );

  useEffect(() => {
    if (!userId || !householdId) return;
    const ctx = { householdId, userId };
    const run = () => {
      void processPaymentNotifications(ctx);
    };
    const timer = setTimeout(run, START_DELAY_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [userId, householdId]);

  return null;
}
