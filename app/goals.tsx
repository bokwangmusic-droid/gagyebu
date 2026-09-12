import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, formatShortDate } from '@/lib/format';
import { goalStats, type GoalPace } from '@/lib/goal';
import { pendingGoalRowLabel } from '@/lib/pendingGoalLabel';
import { softDeleteGoal } from '@/services/remoteGoalWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { Goal } from '@/store/types';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

const PACE_LABEL: Record<GoalPace, string> = {
  ahead: '목표보다 빠른 페이스예요',
  onTrack: '계획대로 진행 중이에요',
  behind: '목표 달성을 위해 조금 더 모아야 해요',
};
const PACE_COLOR: Record<GoalPace, string> = {
  ahead: colors.incomeStrong,
  onTrack: colors.textSub,
  behind: colors.warningText,
};

export default function GoalsList() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const {
    status,
    error,
    goals,
    goalMeta,
    // STEP 16-H2-G3: the LIST renders `goalManagementRows` (authoritative
    // server goals + a pending/failed CREATE synthetic row overlaid).
    // DELIBERATELY separate from `goals` — the "총 모은 금액" total below
    // stays on the AUTHORITATIVE `goals` (planned-tab precedent: money never
    // counts a pending synthetic row, which always has `saved: 0` anyway).
    goalManagementRows,
    pendingGoalOps,
    refresh,
  } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();

  const pendingRef = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const canCreate = REMOTE_FINANCE_WRITE.goalCreate;
  const canEdit = REMOTE_FINANCE_WRITE.goalEdit;
  const canDelete = REMOTE_FINANCE_WRITE.goalDelete;
  const canMove = REMOTE_FINANCE_WRITE.goalAddMovement;

  const now = new Date();
  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);

  const openAdd = () => router.push('/goal-add');
  const openEdit = (id: string) => router.push({ pathname: '/goal-add', params: { id } });
  const openMovement = (id: string, mode: 'deposit' | 'withdraw') =>
    router.push({ pathname: '/goal-movement', params: { id, mode } });

  const doDelete = async (id: string, token: string) => {
    if (pendingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    pendingRef.current = true;
    setPendingId(id);

    const res = await softDeleteGoal({
      id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    await refresh();
    pendingRef.current = false;
    setPendingId(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('저축 목표를 삭제했어요');
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 변경됐거나 삭제된 저축 목표예요. 최신 내용을 불러왔어요.');
  };

  const confirmDelete = (g: Goal) => {
    if (!canDelete || pendingRef.current) return;
    // Capture the concurrency token BEFORE the Alert — a background refresh
    // (e.g. after a deposit elsewhere) can't swap it under us.
    const token = goalMeta[g.id]?.updatedAt ?? null;
    if (!token) {
      toast.show('저축 목표 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    Alert.alert(
      '저축 목표를 삭제할까요?',
      '목표는 목록에서 사라지고 기존 저축 기록은 보존돼요. 실제 거래 내역에는 영향이 없어요.',
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => void doDelete(g.id, token) },
      ],
    );
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title="저축 목표" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const addBtn = canCreate ? (
    <Pressable
      onPress={openAdd}
      style={{
        width: 36,
        height: 36,
        borderRadius: radii.pill,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppIcon name="plus" size={18} color={colors.white} strokeWidth={2.5} />
    </Pressable>
  ) : undefined;

  return (
    <ModalScreen title="저축 목표" onClose={() => router.back()} right={addBtn} refreshControl={financeRefresh}>
      <LinearGradient
        colors={gradients.goalPink}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.sm,
          marginBottom: 18,
          padding: spacing.xl,
          borderRadius: radii.card,
          overflow: 'hidden',
        }}
      >
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: '#831843' }}>총 모은 금액</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
          <Text
            style={{
              fontFamily: fontFamily.extrabold,
              fontSize: 30,
              letterSpacing: -1,
              color: '#831843',
              ...tabularNums,
            }}
          >
            {fmt(totalSaved)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 15, color: '#9F1239' }}>원</Text>
        </View>
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: '#9F1239', marginTop: 8 }}>
          {goalManagementRows.length}개 목표 진행 중
        </Text>
      </LinearGradient>

      {goalManagementRows.length === 0 ? (
        <EmptyState
          icon={canCreate ? undefined : 'target'}
          onPress={canCreate ? openAdd : undefined}
          cta={canCreate ? '저축 목표 추가하기' : undefined}
          title="목표가 없어요"
          sub={
            canCreate
              ? '모으고 싶은 금액과 목표일을 정해두면\n진행 상황을 한눈에 볼 수 있어요'
              : '우리집 가계부에 등록된 목표가 없어요'
          }
        />
      ) : (
        goalManagementRows.map((g) => {
          const st = goalStats(g, now);
          const dl = st.deadline;
          const rowPending = pendingId === g.id;
          // STEP 16-H2-G3: a row backed by an un-sent offline goal op (right
          // now, only a pending/failed CREATE synthetic row — update/delete
          // are not offline-connected from any screen yet) is read-only: no
          // tap-to-edit, no deposit/withdraw/delete. The displayed row is
          // ALWAYS `goalManagementRows`' resolved value (server-authoritative
          // when one exists) — never a locally-invented one.
          const pendingOp = pendingGoalOps.get(g.id);

          const body = (
            <>
              <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: radii.lg,
                    backgroundColor: colors.primaryLight,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name={g.icon || 'target'} size={22} color={colors.primaryStrong} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18, color: colors.text, ...noPad }}
                    >
                      {g.name}
                    </Text>
                    <Text
                      style={{
                        marginLeft: 8,
                        fontFamily: fontFamily.bold,
                        fontSize: 12,
                        color: st.achieved ? colors.incomeText : colors.primaryStrong,
                        ...tabularNums,
                      }}
                    >
                      {st.achieved ? '달성' : `${st.progressPct}%`}
                    </Text>
                  </View>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
                    {fmt(g.saved)} <Text style={{ color: colors.textFaint }}>/ {fmt(g.target)}원</Text>
                    {g.deadline ? ` · 목표일 ${formatShortDate(g.deadline)}` : ''}
                  </Text>
                </View>
              </View>
              <ProgressBar percent={st.progressPct} size="md" style={{ marginTop: spacing.md }} />

              {st.achieved ? (
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.incomeText, marginTop: spacing.sm }}>
                  목표 달성 🎉
                </Text>
              ) : dl?.past ? (
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, marginTop: spacing.sm }}>
                  목표일이 지났어요 · 현재 {st.progressPct}% 달성
                </Text>
              ) : dl && dl.requiredMonthlySaving != null ? (
                <View style={{ marginTop: spacing.sm, gap: 2 }}>
                  <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.primaryStrong, ...tabularNums }}>
                    목표일까지 매월 약 {fmt(dl.requiredMonthlySaving)}원
                  </Text>
                  {dl.pace ? (
                    <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: PACE_COLOR[dl.pace] }}>
                      {PACE_LABEL[dl.pace]}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </>
          );

          return (
            <View
              key={g.id}
              style={{
                marginHorizontal: spacing.lg,
                marginBottom: spacing.md,
                padding: spacing.lg,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.xxl,
                // STEP 16-H2-G3 §11/§20 (mirrors card-management): a pending /
                // failed offline row reads as muted — subtle, not a red
                // alert. Reuses the SAME app opacity value cards.tsx uses.
                opacity: rowPending ? 0.5 : pendingOp ? 0.6 : 1,
              }}
            >
              {/* The card body (tap -> edit) and the deposit / withdraw /
                  delete controls are SIBLINGS, not nested — a tap lands on
                  exactly one, so an action never also opens the edit screen. */}
              {canEdit && !pendingOp ? (
                <Pressable
                  onPress={() => openEdit(g.id)}
                  disabled={rowPending}
                  style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                >
                  {body}
                </Pressable>
              ) : (
                body
              )}

              {pendingOp && (
                <Text
                  style={{
                    fontFamily: fontFamily.medium,
                    fontSize: 11,
                    lineHeight: 14,
                    color: pendingOp.failed ? colors.textSub : colors.textMuted,
                    marginTop: spacing.sm,
                  }}
                >
                  {pendingGoalRowLabel(pendingOp)}
                </Text>
              )}

              {(canMove || canDelete) && !pendingOp && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    marginTop: spacing.md,
                    paddingTop: spacing.md,
                    borderTopWidth: 1,
                    borderTopColor: colors.track,
                  }}
                >
                  {canMove && (
                    <>
                      <ActionPill
                        label="저축하기"
                        onPress={() => openMovement(g.id, 'deposit')}
                        disabled={rowPending}
                      />
                      <ActionPill
                        label="인출하기"
                        onPress={() => openMovement(g.id, 'withdraw')}
                        disabled={rowPending || g.saved <= 0}
                      />
                    </>
                  )}
                  <View style={{ flex: 1 }} />
                  {canDelete && (
                    <Pressable
                      onPress={() => confirmDelete(g)}
                      disabled={rowPending}
                      hitSlop={8}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: radii.sm,
                        borderWidth: 1,
                        borderColor: colors.expenseLight,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <AppIcon name="trash" size={13} color={colors.expenseText} />
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}
    </ModalScreen>
  );
}

function ActionPill({
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
      style={{
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: radii.pill,
        borderWidth: 1,
        borderColor: colors.primaryLight,
        backgroundColor: colors.white,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>{label}</Text>
    </Pressable>
  );
}
