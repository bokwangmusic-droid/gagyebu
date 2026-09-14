import { FunctionsFetchError, FunctionsRelayError } from '@supabase/supabase-js';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { PasswordField } from '@/components/auth/PasswordField';
import { ModalScreen } from '@/components/ui/ModalScreen';
import {
  canProceedWithAccountDeletion,
  planAccountDeletion,
  type HouseholdRole,
} from '@/lib/accountDeletionPlan';
import { clearLocalBackups } from '@/lib/backup';
import { supabase } from '@/lib/supabase';
import { isTransportError } from '@/lib/transportError';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import { useRemoteFinance } from '@/store/remoteFinance';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad } from '@/theme/typography';

type Step = 'warning' | 'reauth' | 'transfer' | 'final';

type MemberRow = {
  id: string;
  household_id: string;
  user_id: string;
  role: HouseholdRole;
  display_name: string;
};

type OwnMembershipRow = {
  household_id: string;
  role: HouseholdRole;
  households: { id: string; name: string } | { id: string; name: string }[] | null;
};

type DeletionMember = {
  id: string;
  userId: string;
  displayName: string;
  role: HouseholdRole;
};

type DeletionHousehold = {
  id: string;
  name: string;
  role: HouseholdRole;
  members: DeletionMember[];
};

type OnlineCheck =
  | { ok: true }
  | { ok: false; kind: 'offline' | 'auth'; message: string };

const INTERNET_REQUIRED = '계정 삭제는 인터넷 연결이 필요합니다.';
const SESSION_REQUIRED = '세션이 만료됐어요. 다시 로그인해주세요.';

function relationHousehold(
  raw: OwnMembershipRow['households'],
): { id: string; name: string } | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return String(error ?? '');
}

function looksLikeTransport(error: unknown): boolean {
  // `supabase.functions.invoke('delete-account', ...)` never reaching a
  // verdict surfaces as `FunctionsFetchError` — its `.message` is ALWAYS the
  // fixed string "Failed to send a request to the Edge Function" (see
  // @supabase/functions-js), regardless of the real underlying cause, so
  // neither `isTransportError` nor the substring check below can ever match
  // it on message text alone. `FunctionsRelayError` (Supabase's own relay
  // failing to reach the function) is grouped the same way, matching the
  // SDK's own documented `instanceof` discrimination pattern.
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return true;
  if (isTransportError(error)) return true;
  const m = errorText(error).toLowerCase();
  return (
    m.includes('network') ||
    m.includes('fetch') ||
    m.includes('offline') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('connection')
  );
}

function functionStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('context' in error)) return null;
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== 'object' || !('status' in context)) return null;
  const status = (context as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

async function confirmOnlineUser(expectedUserId: string): Promise<OnlineCheck> {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    return looksLikeTransport(error)
      ? { ok: false, kind: 'offline', message: INTERNET_REQUIRED }
      : { ok: false, kind: 'auth', message: SESSION_REQUIRED };
  }
  if (!data.user || data.user.id !== expectedUserId) {
    return { ok: false, kind: 'auth', message: SESSION_REQUIRED };
  }
  return { ok: true };
}

async function fetchDeletionHouseholds(userId: string): Promise<
  | { ok: true; households: DeletionHousehold[] }
  | { ok: false; message: string }
> {
  const { data: ownData, error: ownError } = await supabase
    .from('household_members')
    .select('household_id, role, households(id, name)')
    .eq('user_id', userId);

  if (ownError) {
    return {
      ok: false,
      message: looksLikeTransport(ownError)
        ? INTERNET_REQUIRED
        : '우리집 정보를 확인하지 못했어요. 잠시 후 다시 시도해주세요.',
    };
  }

  const ownRows = (ownData ?? []) as OwnMembershipRow[];
  if (ownRows.length === 0) return { ok: true, households: [] };

  const householdIds = [...new Set(ownRows.map((row) => row.household_id))];
  const { data: memberData, error: memberError } = await supabase
    .from('household_members')
    .select('id, household_id, user_id, role, display_name')
    .in('household_id', householdIds)
    .order('joined_at', { ascending: true });

  if (memberError) {
    return {
      ok: false,
      message: looksLikeTransport(memberError)
        ? INTERNET_REQUIRED
        : '구성원 정보를 확인하지 못했어요. 잠시 후 다시 시도해주세요.',
    };
  }

  const members = (memberData ?? []) as MemberRow[];
  const byHousehold = new Map<string, DeletionMember[]>();
  for (const row of members) {
    const list = byHousehold.get(row.household_id) ?? [];
    list.push({
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name?.trim() || '구성원',
      role: row.role,
    });
    byHousehold.set(row.household_id, list);
  }

  const households: DeletionHousehold[] = [];
  for (const row of ownRows) {
    const relation = relationHousehold(row.households);
    const householdMembers = byHousehold.get(row.household_id) ?? [];
    if (!householdMembers.some((member) => member.userId === userId)) {
      return {
        ok: false,
        message: '구성원 정보를 정확히 확인하지 못했어요. 잠시 후 다시 시도해주세요.',
      };
    }
    households.push({
      id: row.household_id,
      name: relation?.name?.trim() || '우리집 가계부',
      role: row.role,
      members: householdMembers,
    });
  }

  return { ok: true, households };
}

export default function AccountDeleteScreen() {
  const router = useRouter();
  const { user, signIn, clearLocalSessionAfterAccountDeletion } = useAuth();
  const { refreshHouseholds } = useHousehold();
  const pending = usePendingWrites();
  const { clearRemoteFinance } = useRemoteFinance();
  const { resetAll } = useStore();

  const [step, setStep] = useState<Step>('warning');
  const [password, setPassword] = useState('');
  const [households, setHouseholds] = useState<DeletionHousehold[] | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string>>({});
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [transferringHouseholdId, setTransferringHouseholdId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reauthRef = useRef(false);
  const transferRef = useRef<string | null>(null);
  const deletingRef = useRef(false);

  const plan = useMemo(() => {
    if (!households) return null;
    return planAccountDeletion(
      households.map((household) => ({
        householdId: household.id,
        role: household.role,
        memberCount: household.members.length,
      })),
    );
  }, [households]);

  const blockingIds = useMemo(
    () => new Set(plan?.blockingHouseholdIds ?? []),
    [plan?.blockingHouseholdIds],
  );
  const blockingHouseholds = useMemo(
    () => (households ?? []).filter((household) => blockingIds.has(household.id)),
    [households, blockingIds],
  );
  const canDelete = !!plan && canProceedWithAccountDeletion(plan);

  const refreshDeletionState = async (): Promise<DeletionHousehold[] | null> => {
    if (!user) {
      setErrorMessage(SESSION_REQUIRED);
      return null;
    }
    setBusyMessage('우리집 상태를 확인하는 중…');
    const result = await fetchDeletionHouseholds(user.id);
    setBusyMessage(null);
    if (result.ok === false) {
      setErrorMessage(result.message);
      return null;
    }
    setHouseholds(result.households);
    setSelectedTargets((previous) => {
      const next: Record<string, string> = {};
      for (const household of result.households) {
        const candidateIds = new Set(
          household.members.filter((member) => member.userId !== user.id).map((member) => member.userId),
        );
        const selected = previous[household.id];
        if (selected && candidateIds.has(selected)) next[household.id] = selected;
      }
      return next;
    });
    setErrorMessage(null);
    return result.households;
  };

  const proceedAfterStateRefresh = (nextHouseholds: DeletionHousehold[]) => {
    const nextPlan = planAccountDeletion(
      nextHouseholds.map((household) => ({
        householdId: household.id,
        role: household.role,
        memberCount: household.members.length,
      })),
    );
    setStep(nextPlan.blockingHouseholdIds.length > 0 ? 'transfer' : 'final');
  };

  const reauthenticate = async () => {
    if (!user?.id || !user.email || reauthRef.current || reauthenticating) return;
    if (!password) {
      setErrorMessage('현재 비밀번호를 입력해주세요.');
      return;
    }

    reauthRef.current = true;
    setReauthenticating(true);
    setErrorMessage(null);
    try {
      const online = await confirmOnlineUser(user.id);
      if (online.ok === false) {
        setErrorMessage(online.message);
        return;
      }

      const result = await signIn({ email: user.email, password });
      if (!result.ok) {
        setErrorMessage(result.message);
        return;
      }

      setPassword('');
      const nextHouseholds = await refreshDeletionState();
      if (nextHouseholds) proceedAfterStateRefresh(nextHouseholds);
    } finally {
      reauthRef.current = false;
      setReauthenticating(false);
    }
  };

  const transferOwnership = async (household: DeletionHousehold) => {
    if (!user?.id || transferRef.current || transferringHouseholdId) return;
    const targetUserId = selectedTargets[household.id];
    if (!targetUserId) {
      setErrorMessage('새 소유자를 선택해주세요.');
      return;
    }
    if (!household.members.some((member) => member.userId === targetUserId && member.userId !== user.id)) {
      setErrorMessage('선택한 구성원을 다시 확인해주세요.');
      return;
    }

    transferRef.current = household.id;
    setTransferringHouseholdId(household.id);
    setErrorMessage(null);
    try {
      const online = await confirmOnlineUser(user.id);
      if (online.ok === false) {
        setErrorMessage(online.message);
        return;
      }

      const { error } = await supabase.rpc('transfer_household_ownership', {
        p_household_id: household.id,
        p_target_user_id: targetUserId,
      });

      if (error) {
        if (looksLikeTransport(error)) {
          setErrorMessage(INTERNET_REQUIRED);
          return;
        }

        if (errorText(error).includes('NOT_OWNER')) {
          const refreshed = await refreshDeletionState();
          const after = refreshed?.find((item) => item.id === household.id);
          const converged =
            !!after &&
            after.role !== 'owner' &&
            after.members.some((member) => member.role === 'owner' && member.userId !== user.id);
          if (refreshed && converged) {
            await refreshHouseholds();
            proceedAfterStateRefresh(refreshed);
            return;
          }
        }

        setErrorMessage('소유자 이전에 실패했어요. 우리집 상태를 다시 확인한 뒤 시도해주세요.');
        return;
      }

      const refreshed = await refreshDeletionState();
      await refreshHouseholds();
      if (refreshed) proceedAfterStateRefresh(refreshed);
    } finally {
      transferRef.current = null;
      setTransferringHouseholdId(null);
    }
  };

  const performLocalCleanup = async (deletedUserId: string) => {
    clearRemoteFinance();
    resetAll();

    let queueCleared = await pending.clearPendingForAccount(deletedUserId);
    if (!queueCleared.ok) queueCleared = await pending.clearPendingForAccount(deletedUserId);

    const backupsCleared = await clearLocalBackups();
    const authCleared = await clearLocalSessionAfterAccountDeletion();

    if (!queueCleared.ok || !backupsCleared || !authCleared.ok) {
      Alert.alert(
        '계정은 삭제됐어요',
        '서버 계정 삭제는 완료됐지만 이 기기의 일부 로컬 데이터 정리를 확인하지 못했어요. 앱을 다시 실행하기 전에 저장공간을 확인해주세요.',
      );
    }

    router.replace('/sign-in');
  };

  const deleteAccount = async () => {
    if (!user?.id || deletingRef.current || deleting || !canDelete) return;

    deletingRef.current = true;
    setDeleting(true);
    setErrorMessage(null);
    let serverDeleted = false;
    let paused = false;

    try {
      const online = await confirmOnlineUser(user.id);
      if (online.ok === false) {
        setErrorMessage(online.message);
        return;
      }

      setBusyMessage('미전송 변경사항을 안전하게 멈추는 중…');
      await pending.pauseForAccountDeletion();
      paused = true;
      setBusyMessage('계정을 삭제하는 중…');

      const { data, error } = await supabase.functions.invoke('delete-account', { body: {} });
      setBusyMessage(null);

      if (error) {
        const status = functionStatus(error);
        if (status === 409) {
          pending.resumeAfterAccountDeletionFailure();
          paused = false;
          const refreshed = await refreshDeletionState();
          if (refreshed) setStep('transfer');
          setErrorMessage('소유자 이전이 필요한 우리집이 있어요. 상태를 다시 확인해주세요.');
          return;
        }
        if (status === 401) {
          setErrorMessage(SESSION_REQUIRED);
          return;
        }
        if (status != null && status >= 500) {
          setErrorMessage('계정 삭제를 완료하지 못했어요. 잠시 후 다시 시도해주세요.');
          return;
        }
        setErrorMessage(
          looksLikeTransport(error)
            ? INTERNET_REQUIRED
            : '계정 삭제 결과를 확인하지 못했어요. 다시 시도해주세요.',
        );
        return;
      }

      if (!data || data.ok !== true) {
        setErrorMessage('계정 삭제 결과를 확인하지 못했어요. 다시 시도해주세요.');
        return;
      }

      serverDeleted = true;
      await performLocalCleanup(user.id);
    } finally {
      setBusyMessage(null);
      if (!serverDeleted && paused) pending.resumeAfterAccountDeletionFailure();
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (!canDelete || deletingRef.current || deleting) return;
    Alert.alert(
      '계정을 영구 삭제할까요?',
      '이 작업은 되돌릴 수 없습니다. 혼자 사용하는 우리집 가계부 데이터와 이 기기의 미전송 변경사항·앱 내부 백업이 함께 삭제됩니다.',
      [
        { text: '취소', style: 'cancel' },
        { text: '계정 영구 삭제', style: 'destructive', onPress: () => void deleteAccount() },
      ],
    );
  };

  return (
    <ModalScreen
      title="계정 삭제"
      onClose={() => {
        if (reauthRef.current || transferRef.current || deletingRef.current) return;
        router.back();
      }}
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md }}>
        {step === 'warning' && (
          <>
            <DangerHero
              title="삭제 후에는 복구할 수 없어요"
              body="계정과 연결된 데이터를 삭제하기 전에 아래 내용을 꼭 확인해주세요."
            />
            <InfoList
              items={[
                '혼자 사용하는 우리집 가계부의 거래·예산·카드·목표·대출 등은 함께 영구 삭제돼요.',
                '공유 우리집의 다른 구성원 데이터는 유지돼요.',
                '내가 소유자인 공유 우리집은 먼저 다른 구성원에게 소유자를 이전해야 해요.',
                '계정 삭제는 인터넷 연결이 필요해요.',
                '미전송 오프라인 변경사항과 앱 내부 로컬 백업은 서버 삭제 성공 후 이 기기에서 정리돼요.',
                '직접 파일로 저장하거나 공유한 외부 백업 파일은 앱에서 자동으로 삭제할 수 없어요.',
              ]}
            />
            <PrimaryButton label="계속" onPress={() => setStep('reauth')} />
          </>
        )}

        {step === 'reauth' && (
          <>
            <SectionTitle title="현재 비밀번호 확인" body="본인 확인을 위해 현재 비밀번호를 다시 입력해주세요." />
            <PasswordField
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                if (errorMessage) setErrorMessage(null);
              }}
              placeholder="현재 비밀번호"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => void reauthenticate()}
            />
            <PrimaryButton
              label={reauthenticating ? '확인 중…' : '비밀번호 확인'}
              disabled={reauthenticating || password.length === 0}
              onPress={() => void reauthenticate()}
            />
          </>
        )}

        {step === 'transfer' && (
          <>
            <SectionTitle
              title="공유 우리집의 소유자를 이전해주세요"
              body="아래 우리집은 다른 구성원이 함께 있어 계정을 바로 삭제할 수 없어요. 각 우리집마다 새 소유자를 선택해주세요."
            />
            {blockingHouseholds.map((household) => (
              <View
                key={household.id}
                style={{
                  padding: spacing.lg,
                  borderRadius: radii.xxl,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.white,
                  gap: spacing.md,
                }}
              >
                <View style={{ gap: 2 }}>
                  <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text }}>
                    {household.name}
                  </Text>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub }}>
                    새 소유자를 선택하세요
                  </Text>
                </View>
                {household.members
                  .filter((member) => member.userId !== user?.id)
                  .map((member) => {
                    const selected = selectedTargets[household.id] === member.userId;
                    return (
                      <Pressable
                        key={member.id}
                        onPress={() =>
                          setSelectedTargets((current) => ({
                            ...current,
                            [household.id]: member.userId,
                          }))
                        }
                        disabled={!!transferringHouseholdId}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          paddingVertical: 10,
                          paddingHorizontal: 12,
                          borderRadius: radii.md,
                          backgroundColor: selected ? colors.primaryLighter : colors.bg,
                          borderWidth: 1,
                          borderColor: selected ? colors.primary : colors.border,
                        }}
                      >
                        <View
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: radii.pill,
                            borderWidth: 2,
                            borderColor: selected ? colors.primaryStrong : colors.textMuted,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {selected && (
                            <View
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: radii.pill,
                                backgroundColor: colors.primaryStrong,
                              }}
                            />
                          )}
                        </View>
                        <Text style={{ flex: 1, fontFamily: fontFamily.medium, fontSize: 14, color: colors.text }}>
                          {member.displayName}
                        </Text>
                      </Pressable>
                    );
                  })}
                <PrimaryButton
                  label={
                    transferringHouseholdId === household.id ? '이전 중…' : '선택한 구성원에게 소유자 이전'
                  }
                  disabled={!!transferringHouseholdId || !selectedTargets[household.id]}
                  onPress={() => void transferOwnership(household)}
                />
              </View>
            ))}
          </>
        )}

        {step === 'final' && (
          <>
            <DangerHero
              title="삭제 준비가 끝났어요"
              body="마지막으로 계정 영구 삭제를 확인해주세요. 서버 삭제가 성공하기 전에는 이 기기의 데이터와 로그인 세션을 지우지 않습니다."
            />
            <View
              style={{
                padding: spacing.lg,
                borderRadius: radii.xxl,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                gap: 8,
              }}
            >
              <SummaryRow label="혼자 사용하는 우리집" value={`${plan?.soleMemberHouseholdIds.length ?? 0}개 삭제`} />
              <SummaryRow label="공유 우리집" value={`${plan?.safeMemberHouseholdIds.length ?? 0}개 유지`} />
              <SummaryRow label="소유자 이전 필요" value={`${plan?.blockingHouseholdIds.length ?? 0}개`} />
            </View>
            <DangerButton
              label={deleting ? '삭제 중…' : '계정 영구 삭제'}
              disabled={deleting || !canDelete}
              onPress={confirmDelete}
            />
          </>
        )}

        {busyMessage && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <ActivityIndicator size="small" color={colors.primaryStrong} />
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>
              {busyMessage}
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

function DangerHero({ title, body }: { title: string; body: string }) {
  return (
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
          {title}
        </Text>
      </View>
      <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 20, color: colors.textSub }}>
        {body}
      </Text>
    </View>
  );
}

function InfoList({ items }: { items: string[] }) {
  return (
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
      {items.map((item) => (
        <View key={item} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>•</Text>
          <Text style={{ flex: 1, fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 20, color: colors.textSub }}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SectionTitle({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 18, color: colors.text }}>{title}</Text>
      <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 20, color: colors.textSub }}>
        {body}
      </Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 50,
        borderRadius: radii.xl,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.88 : 1,
      })}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.white }}>{label}</Text>
    </Pressable>
  );
}

function DangerButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: radii.xl,
        backgroundColor: colors.expenseStrong,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.88 : 1,
      })}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.white }}>{label}</Text>
    </Pressable>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ flex: 1, fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>{value}</Text>
    </View>
  );
}
