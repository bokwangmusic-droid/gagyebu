/**
 * "우리집 가계부 데이터 전체 초기화" — owner-only, irreversible wipe of the
 * ACTIVE household's finance data for every member.
 *
 * Deliberately a separate screen from 내정보's "이 기기 데이터 초기화": that
 * one only clears this device's local gagyebu.* store and never touches the
 * household; this one never touches the local store and only empties the
 * household on the server.
 *
 * This file is wiring only:
 *   - the RPC call + error copy   -> src/services/remoteHouseholdReset.ts
 *   - the step order / outcomes   -> src/lib/householdResetFlow.ts
 *   - queue freeze / purge / reset marker -> the offline-queue coordinator
 *     via usePendingWrites() (the same APIs the cross-device reset detection
 *     already uses; nothing is re-implemented here).
 *
 * The role check below only decides what this screen SHOWS. The RPC
 * verifies ownership itself and is the actual guard.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { Field, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import {
  RESET_CONFIRM_PHRASE,
  canSubmitHouseholdReset,
  createHouseholdResetRunner,
  type HouseholdResetOutcome,
} from '@/lib/householdResetFlow';
import { resetMarkerReached } from '@/lib/householdResetMarker';
import { fetchHouseholdResetMarker } from '@/services/remoteFinance';
import {
  HOUSEHOLD_RESET_MESSAGES,
  resetHouseholdFinanceData,
} from '@/services/remoteHouseholdReset';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import { useRemoteFinance } from '@/store/remoteFinance';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

const DELETED_ITEMS = '거래 · 반복 · 예정 지출 · 예산 · 목표 · 대출 · 카드 · 자산 · 커스텀 카테고리 · 메모';
const KEPT_ITEMS = '계정 · 우리집 · 구성원 연결';

/** How long to wait for the refreshed snapshot to land in React state. */
const REFRESH_SETTLE_MS = 3000;
const REFRESH_POLL_MS = 50;

export default function HouseholdReset() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold, refreshHouseholds } = useHousehold();
  const pending = usePendingWrites();
  const remote = useRemoteFinance();

  const userId = session?.user?.id ?? null;
  const householdId = activeHousehold?.id ?? null;
  const isOwner = activeHousehold?.role === 'owner';

  const [confirmText, setConfirmText] = useState('');
  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const runningRef = useRef(false);
  const runReset = useMemo(() => createHouseholdResetRunner(), []);
  // The run keeps going if the screen is dismissed under it (Android
  // hardware back): it must still finish and unfreeze the queue, but must
  // not then pop whatever screen the user is on by now.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The snapshot currently on screen, read at use-time by the refresh wait
  // below (the closure that started the reset would only ever see the old one).
  const snapshotRef = useRef({
    marker: remote.data?.dataResetAt ?? null,
    householdId: remote.loadedForHouseholdId,
  });
  snapshotRef.current = {
    marker: remote.data?.dataResetAt ?? null,
    householdId: remote.loadedForHouseholdId,
  };

  const canSubmit = canSubmitHouseholdReset({
    role: activeHousehold?.role,
    confirmText,
    running,
  });

  const describe = (outcome: HouseholdResetOutcome, serverMessage: string | null): string | null => {
    switch (outcome.kind) {
      case 'done':
      case 'busy':
        return null;
      case 'done-refresh-failed':
        return HOUSEHOLD_RESET_MESSAGES.refreshFailed;
      case 'offline':
        return HOUSEHOLD_RESET_MESSAGES.offline;
      case 'not-owner':
        return HOUSEHOLD_RESET_MESSAGES.notOwner;
      case 'unconfirmed':
        return HOUSEHOLD_RESET_MESSAGES.unconfirmed;
      case 'failed':
        return serverMessage ?? HOUSEHOLD_RESET_MESSAGES.failed;
    }
  };

  const submit = async () => {
    if (!userId || !householdId || !canSubmit || runningRef.current) return;

    runningRef.current = true;
    setRunning(true);
    setErrorMessage(null);
    let serverMessage: string | null = null;

    try {
      const outcome = await runReset({
        readMarker: () => fetchHouseholdResetMarker(householdId),
        // The account-deletion freeze is a plain queue freeze: no new
        // enqueue, and the flusher is idle before it resolves.
        pauseQueue: pending.pauseForAccountDeletion,
        resumeQueue: pending.resumeAfterAccountDeletionFailure,
        callReset: async () => {
          const res = await resetHouseholdFinanceData(householdId);
          if (res.ok) return { ok: true, resetAt: res.resetAt };
          serverMessage = res.message;
          return { ok: false, code: res.code, definitive: res.definitive };
        },
        clearPending: () => pending.clearPendingForHousehold(userId, householdId),
        syncMarker: (resetAt) => pending.syncResetMarker(userId, householdId, resetAt),
        refresh: async (resetAt) => {
          await remote.refreshRemoteFinance();
          const deadline = Date.now() + REFRESH_SETTLE_MS;
          for (;;) {
            const now = snapshotRef.current;
            if (now.householdId === householdId && resetMarkerReached(now.marker, resetAt)) return true;
            if (Date.now() >= deadline) return false;
            await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
          }
        },
      });

      if (outcome.kind === 'done') {
        toast.show(HOUSEHOLD_RESET_MESSAGES.done);
        if (mountedRef.current) router.back();
        return;
      }
      if (outcome.kind === 'done-refresh-failed') {
        // The data IS deleted — leave the screen, but say why the lists
        // behind it may still look populated.
        toast.show(HOUSEHOLD_RESET_MESSAGES.refreshFailed);
        if (mountedRef.current) router.back();
        return;
      }
      if (outcome.kind === 'not-owner') {
        // The role on this device was stale (e.g. ownership was transferred).
        void refreshHouseholds();
      }
      const message = describe(outcome, serverMessage);
      if (mountedRef.current) setErrorMessage(message);
      else if (message) toast.show(message);
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  return (
    <ModalScreen
      title="우리집 가계부 데이터 전체 초기화"
      onClose={() => {
        if (runningRef.current) return;
        router.back();
      }}
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md }}>
        <View
          style={{
            padding: spacing.lg,
            borderRadius: radii.xxl,
            backgroundColor: colors.expenseLight,
            borderWidth: 1,
            borderColor: colors.expense,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AppIcon name="warn" size={20} color={colors.expenseText} />
            <Text style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 16, color: colors.expenseText, ...noPad }}>
              되돌릴 수 없어요
            </Text>
          </View>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 20, color: colors.textSub }}>
            이 작업은 같은 우리집을 사용하는 모든 구성원의 가계부 데이터를 삭제하며 되돌릴 수 없습니다.
          </Text>
        </View>

        <View
          style={{
            padding: spacing.lg,
            borderRadius: radii.xxl,
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: colors.border,
            gap: 12,
          }}
        >
          <ScopeRow label="삭제" value={DELETED_ITEMS} danger />
          <ScopeRow label="유지" value={KEPT_ITEMS} />
          {activeHousehold && <ScopeRow label="대상" value={activeHousehold.name} />}
        </View>

        {isOwner ? (
          <Field label={`계속하려면 '${RESET_CONFIRM_PHRASE}'를 입력하세요`}>
            <TextField
              value={confirmText}
              onChangeText={(value) => {
                setConfirmText(value);
                if (errorMessage) setErrorMessage(null);
              }}
              placeholder={RESET_CONFIRM_PHRASE}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!running}
              returnKeyType="done"
            />
          </Field>
        ) : (
          <View
            style={{
              padding: 12,
              borderRadius: radii.md,
              backgroundColor: colors.bg,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 18, color: colors.textSub }}>
              {HOUSEHOLD_RESET_MESSAGES.notOwner}
            </Text>
          </View>
        )}

        <Pressable
          onPress={() => void submit()}
          disabled={!canSubmit}
          style={({ pressed }) => ({
            minHeight: 52,
            borderRadius: radii.xl,
            backgroundColor: colors.expenseStrong,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !canSubmit ? 0.4 : pressed ? 0.88 : 1,
          })}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.white }}>
            {running ? '삭제 중…' : '우리집 데이터 전체 삭제'}
          </Text>
        </Pressable>

        {running && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <ActivityIndicator size="small" color={colors.primaryStrong} />
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>
              삭제가 끝날 때까지 화면을 닫지 말아주세요
            </Text>
          </View>
        )}

        {errorMessage && (
          <View
            style={{
              padding: 12,
              borderRadius: radii.md,
              backgroundColor: colors.expenseLight,
              borderWidth: 1,
              borderColor: colors.expense,
            }}
          >
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 18, color: colors.expenseText }}>
              {errorMessage}
            </Text>
          </View>
        )}
      </View>
    </ModalScreen>
  );
}

function ScopeRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <Text
        style={{
          width: 34,
          fontFamily: fontFamily.bold,
          fontSize: 13,
          lineHeight: 20,
          color: danger ? colors.expenseText : colors.text,
        }}
      >
        {label}
      </Text>
      <Text style={{ flex: 1, fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 20, color: colors.textSub }}>
        {value}
      </Text>
    </View>
  );
}
