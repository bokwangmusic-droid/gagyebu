import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Screen } from '@/components/ui/Screen';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { getCat } from '@/data/categories';
import { monthlyTotals } from '@/lib/aggregate';
import { daysLeftInMonth, fmt } from '@/lib/format';
import { useFinanceRead } from '@/store/financeRead';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

export default function BudgetScreen() {
  const router = useRouter();
  const { status, error, transactions, budgets, customCats, refresh } = useFinanceRead();
  const { byCategory, expense, totalBudget, remaining } = useMemo(
    () => monthlyTotals(transactions, budgets),
    [transactions, budgets],
  );

  const entries = Object.entries(budgets).sort((a, b) => (b[1] || 0) - (a[1] || 0));

  if (status !== 'ready') {
    return (
      <Screen>
        <ScreenHeader title="예산 관리" onBack={router.canGoBack() ? () => router.back() : undefined} />
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="예산 관리"
        onBack={router.canGoBack() ? () => router.back() : undefined}
      />
      <FinanceReadOnlyBanner />

      {/* Hero */}
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          marginHorizontal: spacing.lg,
          marginBottom: spacing.lg,
          padding: spacing.xl,
          borderRadius: radii.card,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: 'rgba(255,255,255,0.9)' }}>
              {new Date().getMonth() + 1}월 전체 예산
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
              <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 28, letterSpacing: -1, color: colors.white, ...tabularNums }}>
                {fmt(totalBudget)}
              </Text>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, color: 'rgba(255,255,255,0.9)' }}>원</Text>
            </View>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>남은 일수</Text>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.white, marginTop: 2, ...tabularNums }}>
              {daysLeftInMonth()}일
            </Text>
          </View>
        </View>
        <ProgressBar
          percent={totalBudget > 0 ? (expense / totalBudget) * 100 : 0}
          fillColor={colors.white}
          trackColor="rgba(255,255,255,0.25)"
          style={{ marginTop: spacing.lg }}
        />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }}>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: 'rgba(255,255,255,0.95)', ...tabularNums }}>
            <Text style={{ fontFamily: fontFamily.bold }}>{fmt(expense)}원</Text> 사용
          </Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: 'rgba(255,255,255,0.95)', ...tabularNums }}>
            <Text style={{ fontFamily: fontFamily.bold }}>{fmt(remaining)}원</Text> {remaining >= 0 ? '남음' : '초과'}
          </Text>
        </View>
      </LinearGradient>

      {/* Section */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginHorizontal: spacing.xl,
          marginBottom: spacing.sm,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>카테고리별 예산</Text>
      </View>

      {entries.length === 0 ? (
        <EmptyState
          icon="nav-budget"
          title="예산이 아직 없어요"
          sub={'우리집 가계부에 설정된 예산이 없어요'}
        />
      ) : (
        entries.map(([catId, amount]) => {
          const cat = getCat(catId, 'expense', customCats);
          const spent = byCategory[catId] || 0;
          const pct = Math.round((spent / amount) * 100);
          const over = pct >= 100;
          const warn = pct >= 80;
          return (
            <View
              key={catId}
              style={{
                marginHorizontal: spacing.lg,
                marginBottom: 10,
                paddingVertical: 14,
                paddingHorizontal: 18,
                backgroundColor: colors.white,
                borderWidth: over ? 1.5 : 1,
                borderColor: over ? '#FBCFE8' : colors.border,
                borderRadius: radii.xxl,
              }}
            >
              <View style={{ flexDirection: 'row', gap: spacing.md, marginBottom: 10, alignItems: 'center' }}>
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: radii.md,
                    backgroundColor: over ? colors.expenseLight : cat.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name={cat.icon} size={18} color={over ? colors.expenseText : cat.color} strokeWidth={2.2} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.text }}>{cat.name}</Text>
                    {over && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.expenseLight, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                        <AppIcon name="warn" size={8} color={colors.expenseStrong} strokeWidth={3} />
                        <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: colors.expenseStrong }}>초과</Text>
                      </View>
                    )}
                    {!over && warn && (
                      <View style={{ backgroundColor: colors.warningLight, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                        <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: colors.warningText }}>80%</Text>
                      </View>
                    )}
                  </View>
                  <Text
                    style={{
                      fontFamily: over ? fontFamily.semibold : fontFamily.regular,
                      fontSize: 11,
                      color: over ? colors.expenseStrong : colors.textSub,
                      marginTop: 1,
                      ...tabularNums,
                    }}
                  >
                    {fmt(spent)} <Text style={{ color: over ? colors.expenseStrong : colors.textFaint }}>/ {fmt(amount)}원</Text>
                    {over ? <Text style={{ fontFamily: fontFamily.bold }}> (+{fmt(spent - amount)})</Text> : null}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: fontFamily.bold,
                    fontSize: 13,
                    color: over ? colors.expenseStrong : warn ? colors.warningText : colors.incomeText,
                    ...tabularNums,
                  }}
                >
                  {pct}%
                </Text>
              </View>
              <ProgressBar
                percent={Math.min(100, pct)}
                size="sm"
                trackColor={over ? colors.expenseLight : colors.track}
                fillColor={over ? colors.expenseSolid : warn ? colors.warning : cat.color}
              />
            </View>
          );
        })
      )}
    </Screen>
  );
}
