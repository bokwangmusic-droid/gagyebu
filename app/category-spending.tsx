import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { getCat } from '@/data/categories';
import { monthlyTotals } from '@/lib/aggregate';
import { categorySpendingRows } from '@/lib/categorySpending';
import { fmt, formatMonthLabel } from '@/lib/format';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/**
 * "카테고리별 지출 상세" — the dedicated destination for Home's
 * "카테고리별 지출 · 자세히 >". Same current-calendar-month expense figures
 * Home shows (via `monthlyTotals`), the full category list (not just the top
 * 3), each with its amount AND its share of the month total, largest first.
 */
export default function CategorySpendingScreen() {
  const router = useRouter();
  const { status, error, transactions, budgets, customCats, refresh } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();

  // SAME computation Home's "카테고리별 지출" card uses — no re-aggregation.
  const { expense, byCategory } = useMemo(
    () => monthlyTotals(transactions, budgets),
    [transactions, budgets],
  );
  const rows = useMemo(() => categorySpendingRows(byCategory, expense), [byCategory, expense]);
  const maxAmount = rows[0]?.amount ?? 1;

  return (
    <ModalScreen
      title="카테고리별 지출"
      onClose={() => router.back()}
      closeIcon="chev-left"
      right={
        <Text style={{ fontFamily: fontFamily.semibold, fontSize: 14, color: colors.text }}>
          {formatMonthLabel()}
        </Text>
      }
      refreshControl={financeRefresh}
    >
      <FinanceReadOnlyBanner />

      {status !== 'ready' ? (
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="clipboard"
          title="아직 지출 내역이 없어요"
          sub={'이번 달에 기록된 지출이 없어요'}
        />
      ) : (
        <Card style={{ paddingVertical: spacing.lg, marginBottom: spacing.md }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: spacing.md,
            }}
          >
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>
              이번 달 총 지출
            </Text>
            <Text
              style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...tabularNums }}
            >
              {fmt(expense)}원
            </Text>
          </View>

          <View style={{ gap: spacing.md }}>
            {rows.map(({ id, amount, sharePct }) => {
              const cat = getCat(id, 'expense', customCats);
              const barPct = Math.min(100, Math.round((amount / maxAmount) * 100));
              return (
                <View key={id}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 6,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 }}>
                      <View
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: radii.sm,
                          backgroundColor: cat.bg,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <AppIcon name={cat.icon} size={12} color={cat.color} strokeWidth={2.2} />
                      </View>
                      <Text
                        numberOfLines={1}
                        style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.text }}
                      >
                        {cat.name}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                      <Text
                        style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.text, ...tabularNums }}
                      >
                        {fmt(amount)}원
                      </Text>
                      <Text
                        style={{
                          fontFamily: fontFamily.semibold,
                          fontSize: 11,
                          color: colors.primaryStrong,
                          minWidth: 30,
                          textAlign: 'right',
                          ...tabularNums,
                        }}
                      >
                        {sharePct}%
                      </Text>
                    </View>
                  </View>
                  <ProgressBar percent={barPct} size="sm" fillColor={cat.color} />
                </View>
              );
            })}
          </View>
        </Card>
      )}
    </ModalScreen>
  );
}
