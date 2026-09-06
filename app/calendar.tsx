import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { getCat } from '@/data/categories';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, toDateKey } from '@/lib/format';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { Transaction } from '@/store/types';

const WD = ['월', '화', '수', '목', '금', '토', '일'];
const WD_FULL = ['일', '월', '화', '수', '목', '금', '토'];

interface DayTotals {
  income: number;
  expense: number;
  txns: Transaction[];
}

export default function CalendarScreen() {
  const router = useRouter();
  const { status, error, transactions, customCats, refresh } = useFinanceRead();

  const now = new Date();
  const [view, setView] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [selectedKey, setSelectedKey] = useState(() => toDateKey(new Date()));
  const todayKey = toDateKey(new Date());

  const daily = useMemo(() => {
    const map: Record<string, DayTotals> = {};
    for (const t of transactions) {
      const key = toDateKey(t.date);
      if (!map[key]) map[key] = { income: 0, expense: 0, txns: [] };
      if (t.type === 'income') map[key].income += t.amount;
      else map[key].expense += t.amount;
      map[key].txns.push(t);
    }
    return map;
  }, [transactions]);

  const grid = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const last = new Date(view.year, view.month + 1, 0);
    const pad = (first.getDay() + 6) % 7;
    const cells: { date: Date; inMonth: boolean }[] = [];
    for (let i = pad; i > 0; i--) {
      const d = new Date(first);
      d.setDate(first.getDate() - i);
      cells.push({ date: d, inMonth: false });
    }
    for (let i = 1; i <= last.getDate(); i++) {
      cells.push({ date: new Date(view.year, view.month, i), inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const lastCell = cells[cells.length - 1].date;
      const d = new Date(lastCell);
      d.setDate(lastCell.getDate() + 1);
      cells.push({ date: d, inMonth: false });
    }
    return cells;
  }, [view]);

  const monthTotal = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const [k, v] of Object.entries(daily)) {
      const [y, m] = k.split('-').map(Number);
      if (y === view.year && m === view.month + 1) {
        income += v.income;
        expense += v.expense;
      }
    }
    return { income, expense };
  }, [daily, view]);

  const shift = (delta: number) =>
    setView((v) => {
      const m = v.month + delta;
      if (m < 0) return { year: v.year - 1, month: 11 };
      if (m > 11) return { year: v.year + 1, month: 0 };
      return { year: v.year, month: m };
    });

  const goToday = () => {
    const d = new Date();
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setSelectedKey(todayKey);
  };

  const selected = daily[selectedKey] ?? { income: 0, expense: 0, txns: [] };
  const selLabel = (() => {
    const [y, m, d] = selectedKey.split('-').map(Number);
    const wd = WD_FULL[new Date(y, m - 1, d).getDay()];
    return `${m}월 ${d}일 (${wd})${selectedKey === todayKey ? ' · 오늘' : ''}`;
  })();

  const todayBtn = (
    <Pressable
      onPress={goToday}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: radii.pill,
        backgroundColor: colors.primaryLight,
      }}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>오늘</Text>
    </Pressable>
  );

  if (status !== 'ready') {
    return (
      <ModalScreen title="달력" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen title="달력" onClose={() => router.back()} right={todayBtn}>
      <FinanceReadOnlyBanner />
      {/* Month nav */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          paddingHorizontal: spacing.xl,
          paddingBottom: spacing.md,
        }}
      >
        <NavCircle icon="chev-left" onPress={() => shift(-1)} />
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 17, letterSpacing: -0.4, color: colors.text }}>
          {view.year}년 {view.month + 1}월
        </Text>
        <NavCircle icon="chev-right" onPress={() => shift(1)} />
      </View>

      {/* Month summary */}
      <View
        style={{
          marginHorizontal: spacing.lg,
          marginBottom: spacing.md,
          paddingVertical: 12,
          paddingHorizontal: 18,
          backgroundColor: colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.xl,
          flexDirection: 'row',
          justifyContent: 'space-around',
          alignItems: 'center',
        }}
      >
        <SummaryCol label="수입" value={`+${fmt(monthTotal.income)}`} color={colors.incomeStrong} />
        <View style={{ width: 1, height: 26, backgroundColor: colors.track }} />
        <SummaryCol label="지출" value={`−${fmt(monthTotal.expense)}`} color={colors.expenseStrong} />
        <View style={{ width: 1, height: 26, backgroundColor: colors.track }} />
        <SummaryCol
          label="합계"
          value={`${monthTotal.income - monthTotal.expense >= 0 ? '+' : '−'}${fmt(
            Math.abs(monthTotal.income - monthTotal.expense),
          )}`}
          color={monthTotal.income - monthTotal.expense >= 0 ? colors.incomeStrong : colors.expenseStrong}
        />
      </View>

      {/* Weekday header */}
      <View style={{ flexDirection: 'row', marginHorizontal: spacing.lg, marginBottom: 4 }}>
        {WD.map((d, i) => (
          <Text
            key={d}
            style={{
              flex: 1,
              textAlign: 'center',
              fontFamily: fontFamily.bold,
              fontSize: 10,
              paddingVertical: 6,
              color: i === 5 ? colors.infoText : i === 6 ? colors.expenseStrong : colors.textMuted,
            }}
          >
            {d}
          </Text>
        ))}
      </View>

      {/* Grid */}
      <View
        style={{
          marginHorizontal: spacing.lg,
          flexDirection: 'row',
          flexWrap: 'wrap',
          backgroundColor: colors.border,
          borderRadius: radii.md,
          padding: 2,
        }}
      >
        {grid.map((cell, i) => {
          const key = toDateKey(cell.date);
          const isToday = key === todayKey;
          const isSel = key === selectedKey;
          const totals = daily[key];
          const dow = cell.date.getDay();
          return (
            <Pressable
              key={i}
              onPress={() => cell.inMonth && setSelectedKey(key)}
              disabled={!cell.inMonth}
              style={{
                width: `${100 / 7}%`,
                minHeight: 62,
                padding: 3,
                paddingTop: 5,
                alignItems: 'center',
                borderRadius: radii.sm,
                borderWidth: isToday || isSel ? 1.5 : 0,
                borderColor: colors.primary,
                backgroundColor: isSel ? colors.primaryLight : colors.white,
                opacity: cell.inMonth ? 1 : 0.3,
              }}
            >
              <Text
                style={{
                  fontFamily: isToday ? fontFamily.extrabold : fontFamily.medium,
                  fontSize: 12,
                  color: isToday
                    ? colors.primaryStrong
                    : dow === 0
                      ? colors.expenseStrong
                      : dow === 6
                        ? colors.infoText
                        : colors.text,
                }}
              >
                {cell.date.getDate()}
              </Text>
              {totals && cell.inMonth && (
                <View style={{ marginTop: 2, width: '100%', alignItems: 'center' }}>
                  {totals.income > 0 && (
                    <Text
                      numberOfLines={1}
                      style={{ fontSize: 8, fontFamily: fontFamily.bold, color: colors.incomeStrong }}
                    >
                      +{fmt(totals.income)}
                    </Text>
                  )}
                  {totals.expense > 0 && (
                    <Text
                      numberOfLines={1}
                      style={{ fontSize: 8, fontFamily: fontFamily.bold, color: colors.expenseStrong }}
                    >
                      −{fmt(totals.expense)}
                    </Text>
                  )}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Selected day */}
      <View style={{ marginHorizontal: spacing.lg, marginTop: spacing.lg }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginHorizontal: 4,
            marginBottom: spacing.sm,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>{selLabel}</Text>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, ...tabularNums }}>
            {selected.income > 0 && (
              <Text style={{ color: colors.incomeStrong }}>+{fmt(selected.income)} </Text>
            )}
            {selected.expense > 0 && <Text style={{ color: colors.expenseStrong }}>−{fmt(selected.expense)}</Text>}
          </Text>
        </View>
        {selected.txns.length === 0 ? (
          <View
            style={{
              paddingVertical: 24,
              paddingHorizontal: spacing.lg,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              borderStyle: 'dashed',
              borderRadius: radii.lg,
            }}
          >
            <Text style={{ textAlign: 'center', fontFamily: fontFamily.regular, fontSize: 12, color: colors.textMuted }}>
              이 날 저장된 내역이 없어요
            </Text>
          </View>
        ) : (
          <View
            style={{
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.xxl,
              paddingHorizontal: spacing.lg,
            }}
          >
            {selected.txns
              .slice()
              .sort((a, b) => +new Date(b.date) - +new Date(a.date))
              .map((t, idx) => {
                const cat = getCat(t.category, t.type, customCats);
                const d = new Date(t.date);
                const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
                      <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}>
                        {hm} · {cat.name}
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
        )}
      </View>
    </ModalScreen>
  );
}

function NavCircle({ icon, onPress }: { icon: 'chev-left' | 'chev-right'; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: 36,
        height: 36,
        borderRadius: radii.pill,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppIcon name={icon} size={16} color={colors.textSub} />
    </Pressable>
  );
}

function SummaryCol({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ fontFamily: fontFamily.medium, fontSize: 10, color: colors.textSub }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color, marginTop: 2, ...tabularNums }}>{value}</Text>
    </View>
  );
}
