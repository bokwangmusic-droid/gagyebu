import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { Card } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Screen } from '@/components/ui/Screen';
import { HeaderIconButton, ScreenHeader } from '@/components/ui/ScreenHeader';
import { getCat } from '@/data/categories';
import { monthlyTotals, recentTransactions } from '@/lib/aggregate';
import { cardBillingForMonth } from '@/lib/card';
import { fmt, formatMonthLabel, formatRelativeDateTime, toDateKey } from '@/lib/format';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { buildInsights, type Insight } from '@/lib/insights';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

/** Insight tone → { icon tile bg, icon/foreground } from design tokens. */
function insightTone(tone: Insight['tone']): { bg: string; fg: string } {
  switch (tone) {
    case 'alert':
      return { bg: colors.expenseLight, fg: colors.expenseText };
    case 'warn':
      return { bg: colors.warningLight, fg: colors.warningText };
    case 'positive':
      return { bg: colors.incomeLight, fg: colors.incomeStrong };
    default:
      return { bg: colors.primaryLighter, fg: colors.primaryStrong };
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const { status, error, transactions, planned, customCats, cards, budgets, refresh } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();
  const { income, expense, byCategory, totalBudget, remaining } = useMemo(
    () => monthlyTotals(transactions, budgets),
    [transactions, budgets],
  );

  // Recompute only when data changes or the calendar day rolls over.
  const todayKey = toDateKey(new Date());
  const insights = useMemo(
    () => buildInsights({ transactions, budgets, customCats, now: new Date() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, budgets, customCats, todayKey],
  );

  const cardBill = useMemo(
    () => cardBillingForMonth(transactions, cards),
    [transactions, cards],
  );
  const cardBillRows = useMemo(() => {
    const rows: [string, number][] = [
      ...cards.map((c) => [c.name, cardBill.byCard[c.id] ?? 0] as [string, number]),
      ...(cardBill.unassigned > 0
        ? [['카드 미지정', cardBill.unassigned] as [string, number]]
        : []),
    ];
    return rows.filter(([, v]) => v > 0);
  }, [cards, cardBill]);

  const percent = totalBudget > 0 ? Math.min(100, Math.round((expense / totalBudget) * 100)) : 0;
  // Deterministic "most recently entered 5" — NOT the first 5 of the array.
  // The remote snapshot arrives with no ORDER BY, so a bare slice(0, 5) could
  // drop a just-created transaction that 전체 내역 (which re-sorts) still shows.
  const recent = useMemo(() => recentTransactions(transactions, 5), [transactions]);

  const topCats = useMemo(
    () =>
      Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
    [byCategory],
  );
  const maxCat = topCats[0]?.[1] ?? 1;

  const upcoming = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return planned
      .map((p) => ({
        ...p,
        diff: Math.round((+new Date(`${p.date}T00:00:00`) - +now) / 86_400_000),
      }))
      .filter((p) => p.diff <= 7)
      .sort((a, b) => a.diff - b.diff);
  }, [planned]);

  const goToTxns = (filter: 'income' | 'expense') =>
    router.push({ pathname: '/all-transactions', params: { filter, scope: 'thisMonth' } });

  if (status !== 'ready') {
    return (
      <Screen>
        <ScreenHeader title={formatMonthLabel()} containerStyle={{ paddingTop: spacing.sm + 2, paddingBottom: spacing.sm }} />
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen refreshControl={financeRefresh}>
      <ScreenHeader
        title={formatMonthLabel()}
        containerStyle={{ paddingTop: spacing.sm + 2, paddingBottom: spacing.sm }}
        right={
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <HeaderIconButton icon="calendar" onPress={() => router.push('/calendar')} />
            <HeaderIconButton icon="refresh" onPress={() => router.push('/recurring')} />
            <HeaderIconButton icon="target" onPress={() => router.push('/goals')} />
          </View>
        }
      />
      <FinanceReadOnlyBanner />

      {/* Upcoming planned banner */}
      {upcoming.length > 0 &&
        (() => {
          const first = upcoming[0];
          const rest = upcoming.length - 1;
          const label =
            first.diff < 0
              ? `${Math.abs(first.diff)}일 지남`
              : first.diff === 0
                ? '오늘'
                : first.diff === 1
                  ? '내일'
                  : `${first.diff}일 후`;
          const urgent = first.diff <= 1;
          return (
            <Pressable
              onPress={() => router.push('/(tabs)/planned')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                marginHorizontal: spacing.lg,
                marginBottom: spacing.md,
                paddingVertical: 12,
                paddingHorizontal: spacing.lg,
                borderRadius: radii.lg,
                backgroundColor: urgent ? colors.warningLight : colors.primaryLighter,
                borderWidth: 1,
                borderColor: urgent ? '#FDE68A' : colors.primaryLight,
              }}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  backgroundColor: urgent ? colors.warning : colors.primary,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AppIcon name="bell" size={16} color={colors.white} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, color: urgent ? colors.warningText : colors.primaryStrong }}>
                  {label} 예정 지출
                </Text>
                <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.text, marginTop: 1 }}>
                  「{first.name}」 <Text style={tabularNums}>{fmt(first.amount)}원</Text>
                  {rest > 0 ? <Text style={{ fontFamily: fontFamily.regular, color: colors.textSub }}> · 외 {rest}건</Text> : null}
                </Text>
              </View>
              <AppIcon name="chev-right" size={16} color={colors.textFaint} />
            </Pressable>
          );
        })()}

      {/* Balance card */}
      <Pressable onPress={() => (totalBudget > 0 ? router.push('/(tabs)/budget') : router.push('/all-transactions'))}>
        <Card style={{ paddingVertical: 13, marginBottom: spacing.md }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>
              이번 달 {totalBudget > 0 ? '남은 예산' : '지출 합계'}
            </Text>
            <AppIcon name="chev-right" size={16} color={colors.textFaint} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 2 }}>
            <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 34, lineHeight: 38, letterSpacing: -1, color: colors.text, ...noPad, ...tabularNums }}>
              {fmt(totalBudget > 0 ? remaining : expense)}
            </Text>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 16, color: colors.textSub, ...noPad }}>원</Text>
          </View>

          {totalBudget > 0 ? (
            <>
              <ProgressBar
                percent={percent}
                style={{ marginTop: 10 }}
                fillColor={percent >= 100 ? colors.expenseSolid : percent >= 80 ? colors.warning : undefined}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, ...tabularNums }}>
                  {fmt(expense)}원 사용 <Text style={{ color: colors.textFaint }}>/ {fmt(totalBudget)}원</Text>
                </Text>
                <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.primaryStrong }}>{percent}%</Text>
              </View>
            </>
          ) : (
            // STEP 16-G1B HOME FIX: the old "예산 설정하기" pill navigated to
            // /(tabs)/budget as a "go set one up" CTA — misleading in
            // read-only mode (no write entry exists there any more either).
            // Plain, non-interactive text now; the outer Card Pressable
            // above still navigates to /all-transactions (pure read nav,
            // untouched).
            <View style={{ marginTop: 6 }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub }}>
                설정된 예산이 없어요 · 탭해서 이번 달 전체 내역 보기 →
              </Text>
            </View>
          )}
        </Card>
      </Pressable>

      {/* Income / Expense pair */}
      <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: spacing.lg, marginBottom: spacing.md }}>
        <StatTile label="수입" value={income} tone="income" onPress={() => goToTxns('income')} />
        <StatTile label="지출" value={expense} tone="expense" onPress={() => goToTxns('expense')} />
      </View>

      {/* 이번 달 인사이트 — rule-based, max 3, hidden when nothing to say */}
      {insights.length > 0 && (
        <Card style={{ paddingVertical: spacing.lg, marginBottom: spacing.md }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, marginBottom: spacing.sm }}>
            이번 달 인사이트
          </Text>
          <View style={{ gap: 10 }}>
            {insights.map((ins) => {
              const t = insightTone(ins.tone);
              return (
                <Pressable
                  key={`${ins.kind}:${ins.category ?? ''}`}
                  onPress={() => router.push(ins.route)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 10,
                      backgroundColor: t.bg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <AppIcon name={ins.icon} size={15} color={t.fg} strokeWidth={2.4} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={1}
                      style={{ fontFamily: fontFamily.bold, fontSize: 12, lineHeight: 16, color: colors.text, ...noPad }}
                    >
                      {ins.title}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textSub, marginTop: 1, ...noPad }}
                    >
                      {ins.body}
                    </Text>
                  </View>
                  <AppIcon name="chev-right" size={14} color={colors.textFaint} />
                </Pressable>
              );
            })}
          </View>
        </Card>
      )}

      {/* 사용월 기준 예상 카드값 — only when there's something to show */}
      {cardBillRows.length > 0 && (
        <Pressable onPress={() => router.push('/cards')}>
          <Card style={{ paddingVertical: spacing.lg, marginBottom: spacing.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>사용월 기준 예상 카드값</Text>
                <AppIcon name="chev-right" size={14} color={colors.textFaint} />
              </View>
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...tabularNums }}>
                {fmt(cardBill.total)}원
              </Text>
            </View>
            <View style={{ gap: 8 }}>
              {cardBillRows.map(([name, amt]) => (
                <View key={name} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub }}>{name}</Text>
                  <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.text, ...tabularNums }}>
                    {fmt(amt)}원
                  </Text>
                </View>
              ))}
            </View>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textMuted, marginTop: 10 }}>
              카드사 실제 청구일과 다를 수 있어요
            </Text>
          </Card>
        </Pressable>
      )}

      {/* Category breakdown */}
      {topCats.length > 0 && (
        <Pressable onPress={() => router.push('/(tabs)/stats')}>
          <Card style={{ paddingVertical: spacing.lg, marginBottom: spacing.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>카테고리별 지출</Text>
                <AppIcon name="chev-right" size={14} color={colors.textFaint} />
              </View>
              <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.primaryStrong }}>자세히 →</Text>
            </View>
            <View style={{ gap: spacing.md }}>
              {topCats.map(([catId, amount]) => {
                const cat = getCat(catId, 'expense', customCats);
                const pct = Math.min(100, Math.round((amount / maxCat) * 100));
                return (
                  <View key={catId}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
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
                        <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.text }}>{cat.name}</Text>
                      </View>
                      <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.text, ...tabularNums }}>
                        {fmt(amount)}원
                      </Text>
                    </View>
                    <ProgressBar percent={pct} size="sm" fillColor={cat.color} />
                  </View>
                );
              })}
            </View>
          </Card>
        </Pressable>
      )}

      {/* Recent */}
      <Pressable
        onPress={() => router.push('/all-transactions')}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginHorizontal: spacing.xl,
          marginBottom: spacing.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>최근 내역</Text>
          <AppIcon name="chev-right" size={14} color={colors.textFaint} />
        </View>
        <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.primaryStrong }}>전체보기 →</Text>
      </Pressable>

      {recent.length === 0 ? (
        <View style={{ alignItems: 'center', paddingHorizontal: spacing.xxl, paddingTop: spacing.md, paddingBottom: spacing.xxl }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: radii.sheet,
              backgroundColor: colors.track,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            }}
          >
            <AppIcon name="clipboard" size={24} color={colors.textMuted} strokeWidth={2.5} />
          </View>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, marginBottom: 4 }}>아직 거래가 없어요</Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, textAlign: 'center' }}>
            우리집 가계부에 기록된 거래가 없어요
          </Text>
        </View>
      ) : (
        <Card variant="sm" style={{ paddingVertical: 4, paddingHorizontal: spacing.lg }}>
          {/* STEP 16-G2-B: row opens the edit form; a plain (non-pressable)
              row when transaction editing is off. */}
          {recent.map((t, i) => {
            const cat = getCat(t.category, t.type, customCats);
            return (
              <Pressable
                key={t.id}
                onPress={() => router.push({ pathname: '/input', params: { id: t.id } })}
                disabled={!REMOTE_FINANCE_WRITE.transactionEdit}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingVertical: 10,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: colors.track,
                }}
              >
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 11,
                    backgroundColor: cat.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name={cat.icon} size={16} color={cat.color} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16, color: colors.text, ...noPad }}
                  >
                    {t.memo || cat.name}
                  </Text>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}>
                    {formatRelativeDateTime(t.date)} · {cat.name}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: fontFamily.bold,
                    fontSize: 13,
                    color: t.type === 'income' ? colors.incomeStrong : colors.text,
                    ...tabularNums,
                  }}
                >
                  {t.type === 'income' ? '+' : '−'}
                  {fmt(t.amount)}원
                </Text>
              </Pressable>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}

function StatTile({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: number;
  tone: 'income' | 'expense';
  onPress: () => void;
}) {
  const isIncome = tone === 'income';
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        paddingVertical: spacing.md - 1,
        paddingHorizontal: spacing.lg,
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.xxl,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: radii.xs,
              backgroundColor: isIncome ? colors.incomeLight : colors.expenseLight,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppIcon
              name={isIncome ? 'up' : 'down'}
              size={10}
              color={isIncome ? colors.incomeText : colors.expenseText}
              strokeWidth={3}
            />
          </View>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textSub }}>{label}</Text>
        </View>
        <AppIcon name="chev-right" size={14} color={colors.textFaint} />
      </View>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 18, color: colors.text, marginTop: 4, letterSpacing: -0.4, ...tabularNums }}>
        {fmt(value)}
      </Text>
    </Pressable>
  );
}
