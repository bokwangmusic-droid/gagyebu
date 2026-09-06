import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { SegmentedTabs } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { getCat } from '@/data/categories';
import { sumByType } from '@/lib/aggregate';
import { fmt, toDateKey } from '@/lib/format';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { hasSplits } from '@/lib/splits';
import { periodRange, prevPeriodRange } from '@/lib/period';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

type Filter = 'all' | 'expense' | 'income';
type Scope = 'all' | 'thisMonth' | 'lastMonth';

const WD = ['일', '월', '화', '수', '목', '금', '토'];

export default function AllTransactions() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string; scope?: string }>();
  const { status, error, transactions, customCats, cards, refresh } = useFinanceRead();

  const [filter, setFilter] = useState<Filter>((params.filter as Filter) || 'all');
  const [scope, setScope] = useState<Scope>((params.scope as Scope) || 'all');

  const bounds = useMemo(() => {
    if (scope === 'thisMonth') return periodRange('month');
    if (scope === 'lastMonth') return prevPeriodRange('month');
    return { start: null as Date | null, end: null as Date | null };
  }, [scope]);

  const filtered = useMemo(() => {
    let list = transactions.slice();
    if (filter !== 'all') list = list.filter((t) => t.type === filter);
    if (bounds.start) {
      list = list.filter((t) => {
        const d = new Date(t.date);
        return d >= bounds.start! && d < bounds.end!;
      });
    }
    return list.sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [transactions, filter, bounds]);

  const grouped = useMemo(() => {
    const groups: Record<string, { date: Date; items: typeof filtered; expense: number; income: number }> = {};
    for (const t of filtered) {
      const key = toDateKey(t.date);
      if (!groups[key]) groups[key] = { date: new Date(t.date), items: [], expense: 0, income: 0 };
      groups[key].items.push(t);
      if (t.type === 'expense') groups[key].expense += t.amount;
      else groups[key].income += t.amount;
    }
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const totalExpense = sumByType(filtered, 'expense');
  const totalIncome = sumByType(filtered, 'income');

  const groupLabel = (d: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const only = new Date(d);
    only.setHours(0, 0, 0, 0);
    const diff = Math.round((+today - +only) / 86_400_000);
    const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    const dow = WD[d.getDay()];
    if (diff === 0) return `오늘 · ${md} (${dow})`;
    if (diff === 1) return `어제 · ${md} (${dow})`;
    return `${md} (${dow})`;
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title="전체 내역" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen
      title="전체 내역"
      onClose={() => router.back()}
      right={<Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>{filtered.length}건</Text>}
    >
      <FinanceReadOnlyBanner />
      {/* Scope chips */}
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        {([
          ['all', '전체 기간'],
          ['thisMonth', '이번 달'],
          ['lastMonth', '지난달'],
        ] as [Scope, string][]).map(([id, label]) => {
          const active = scope === id;
          return (
            <Pressable
              key={id}
              onPress={() => setScope(id)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 14,
                borderRadius: radii.pill,
                backgroundColor: active ? colors.primary : colors.white,
                borderWidth: 1,
                borderColor: active ? colors.primary : colors.border,
              }}
            >
              <Text
                style={{
                  fontFamily: fontFamily.semibold,
                  fontSize: 12,
                  color: active ? colors.white : colors.textSub,
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Filter tabs */}
      <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
        <SegmentedTabs
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '전체' },
            { value: 'expense', label: '지출', tone: 'expense' },
            { value: 'income', label: '수입', tone: 'income' },
          ]}
        />
      </View>

      {filtered.length > 0 && (
        <View
          style={{
            marginHorizontal: spacing.lg,
            marginBottom: spacing.md,
            paddingVertical: 14,
            paddingHorizontal: 18,
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.xl,
            flexDirection: 'row',
            justifyContent: 'space-around',
          }}
        >
          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 10, color: colors.textSub }}>수입 합계</Text>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.incomeStrong, marginTop: 2, ...tabularNums }}>
              +{fmt(totalIncome)}
            </Text>
          </View>
          <View style={{ width: 1, backgroundColor: colors.track }} />
          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 10, color: colors.textSub }}>지출 합계</Text>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.expenseStrong, marginTop: 2, ...tabularNums }}>
              −{fmt(totalExpense)}
            </Text>
          </View>
        </View>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon="calendar" title="내역이 없어요" sub="아직 저장된 지출/수입이 없어요" />
      ) : (
        grouped.map(([key, group]) => (
          <View key={key} style={{ marginBottom: spacing.md }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginHorizontal: spacing.xl,
                marginBottom: 6,
              }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, letterSpacing: 0.2, color: colors.textSub }}>
                {groupLabel(group.date)}
              </Text>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, ...tabularNums }}>
                {group.expense > 0 && <Text style={{ color: colors.expenseStrong }}>−{fmt(group.expense)}</Text>}
                {group.expense > 0 && group.income > 0 && <Text style={{ color: colors.textFaint }}> · </Text>}
                {group.income > 0 && <Text style={{ color: colors.incomeStrong }}>+{fmt(group.income)}</Text>}
              </Text>
            </View>
            <View
              style={{
                marginHorizontal: spacing.lg,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.xxl,
                paddingHorizontal: spacing.lg,
              }}
            >
              {group.items.map((t, idx) => {
                const cat = getCat(t.category, t.type, customCats);
                const d = new Date(t.date);
                const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                const card =
                  t.paymentMethod === 'credit'
                    ? `${cards.find((c) => c.id === t.cardId)?.name ?? '카드 미지정'}${
                        t.installment ? ` ${t.installment.months}개월 할부` : ''
                      }`
                    : '';
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
                      borderTopWidth: idx === 0 ? 0 : 1,
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
                      <Text numberOfLines={1} style={{ fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16, color: colors.text, ...noPad }}>
                        {t.memo || cat.name}
                      </Text>
                      <Text numberOfLines={1} style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}>
                        {hm} · {cat.name}
                        {hasSplits(t) ? ` · 분할 ${t.splits!.length}` : ''}
                        {card ? ` · ${card}` : ''}
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
            </View>
          </View>
        ))
      )}
    </ModalScreen>
  );
}
