/**
 * Pull-to-refresh for the primary remote-finance screens — STEP 16-G3-B3 §6.
 *
 * Returns a `<RefreshControl>` wired to the SAME authoritative path every
 * other refresh trigger uses: `useFinanceRead().refresh` ->
 * `refreshRemoteFinance` -> the STEP 16-G3-B1 scheduler (single-flight per
 * scope + trailing coalesce). It starts NO fetch of its own and never flips
 * `financeRead.status` to `loading` — the last-good snapshot stays on screen
 * while the spinner shows, and a failed pull keeps that snapshot (B1 error
 * semantics, STEP 16-G3-B3 §11/§12).
 *
 * `refreshing` is LOCAL to the calling screen (a tiny `useState`) purely to
 * drive the spinner and drop a second concurrent pull; the B1 scheduler is
 * the real concurrency guard, so a pull that overlaps a realtime
 * invalidation / foreground refresh / write refresh still can't fan out
 * into parallel network requests (STEP 16-G3-B3 §10).
 *
 * Returns `undefined` unless the screen is showing a trusted remote
 * snapshot (`status === 'ready'`) — so it is inert for the loading / error
 * states and a no-op anywhere remote finance isn't active. Hooks are always
 * called before that branch, so it is still safe to call unconditionally at
 * the top of a component, and the result drops straight into the
 * `refreshControl` prop of `<Screen>` / `<ModalScreen>`.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';

import { useFinanceRead } from '@/store/financeRead';
import { usePendingWrites } from '@/store/pendingFinance';
import { colors } from '@/theme/tokens';

export function useRemoteFinanceRefreshControl(): ReactElement<RefreshControlProps> | undefined {
  const { status, refresh } = useFinanceRead();
  const { requestFlush } = usePendingWrites();
  const [refreshing, setRefreshing] = useState(false);
  const busyRef = useRef(false);

  const onRefresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefreshing(true);
    // STEP 16-H2-A2: a pull is also the "다시 시도" gesture for pending /
    // failed offline creates. Fire-and-forget so the gesture isn't held by
    // the flush (single-flight, own backoff); then do the authoritative read.
    requestFlush({ includeFailed: true });
    try {
      await refresh();
    } finally {
      busyRef.current = false;
      setRefreshing(false);
    }
  }, [refresh, requestFlush]);

  if (status !== 'ready') return undefined;

  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.primary}
      colors={[colors.primary]}
    />
  );
}
