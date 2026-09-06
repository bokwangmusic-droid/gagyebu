import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { fmt, formatShortDate } from '@/lib/format';
import { goalStats, type GoalPace } from '@/lib/goal';
import { useFinanceRead } from '@/store/financeRead';
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
  const { status, error, goals, refresh } = useFinanceRead();

  const now = new Date();
  const totalSaved = goals.reduce((s, g) => s + g.saved, 0);

  if (status !== 'ready') {
    return (
      <ModalScreen title="저축 목표" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen title="저축 목표" onClose={() => router.back()}>
      <FinanceReadOnlyBanner />
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
          {goals.length}개 목표 진행 중
        </Text>
      </LinearGradient>

      {goals.length === 0 ? (
        <EmptyState
          icon="target"
          title="목표가 없어요"
          sub={'우리집 가계부에 등록된 목표가 없어요'}
        />
      ) : (
        goals.map((g) => {
          const st = goalStats(g, now);
          const dl = st.deadline;
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
              }}
            >
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

              {/* deadline-driven guidance: 월 필요 저축액 → 현재 페이스,
                  or an 'achieved' / 'past deadline' fallback. Hidden entirely
                  when the goal has no deadline. */}
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
            </View>
          );
        })
      )}
    </ModalScreen>
  );
}
