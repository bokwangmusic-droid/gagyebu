import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Circle, G, Text as SvgText } from 'react-native-svg';

import { AppIcon } from '@/components/AppIcon';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { Screen } from '@/components/ui/Screen';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { getCat } from '@/data/categories';
import { fmt } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { Transaction } from '@/store/types';

type Period = 'week' | 'month' | 'year';
const DONUT_COLORS = ['#A78BFA', '#FDBA74', '#6EE7B7', '#93C5FD', '#F0A4B4', '#CBD5E1'];
const R = 46;
const CIRC = 2 * Math.PI * R;

interface Bar {
  label: string;
  total: number;
  txns: Transaction[];
  isCurrent: boolean;
  detailTitle: string;
}

export default function StatsScreen() {
  const router = useRouter();
  const { transactions, customCats } = useStore();
  const [period, setPeriod] = useState<Period>('week');
  const [selectedBar, setSelectedBar] = useState<Bar | null>(null);

  const info = useMemo(() => {
    const now = new Date();
    if (period === 'week') {
      const since = (now.getDay() + 6) % 7;
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - since);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      const prevStart = new Date(start);
      prevStart.setDate(start.getDate() - 7);
      const endShow = new Date(end);
      endShow.setDate(end.getDate() - 1);
      return {
        start,
        end,
        prevStart,
        prevEnd: new Date(start),
        label: '이번 주',
        prevLabel: '지난주',
        header: `${start.getMonth() + 1}.${start.getDate()} ~ ${endShow.getMonth() + 1}.${endShow.getDate()}`,
      };
    }
    if (period === 'month') {
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
        prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        prevEnd: new Date(now.getFullYear(), now.getMonth(), 1),
        label: '이번 달',
        prevLabel: '지난달',
        header: `${now.getFullYear()}년 ${now.getMonth() + 1}월`,
      };
    }
    return {
      start: new Date(now.getFullYear(), 0, 1),
      end: new Date(now.getFullYear() + 1, 0, 1),
      prevStart: new Date(now.getFullYear() - 1, 0, 1),
      prevEnd: new Date(now.getFullYear(), 0, 1),
      label: '올해',
      prevLabel: '작년',
      header: `${now.getFullYear()}년`,
    };
  }, [period]);

  const periodTxns = useMemo(
    () => transactions.filter((t) => new Date(t.date) >= info.start && new Date(t.date) < info.end),
    [transactions, info],
  );
  const periodExpense = periodTxns.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  const catData = useMemo(() => {
    const byCat: Record<string, number> = {};
    for (const t of periodTxns) {
      if (t.type !== 'expense') continue;
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    }
    const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    return { entries, total: entries.reduce((s, [, v]) => s + v, 0) };
  }, [periodTxns]);

  const prevExpense = useMemo(
    () =>
      transactions
        .filter((t) => {
          if (t.type !== 'expense') return false;
          const d = new Date(t.date);
          return d >= info.prevStart && d < info.prevEnd;
        })
        .reduce((s, t) => s + t.amount, 0),
    [transactions, info],
  );
  const diff = periodExpense - prevExpense;
  const diffPct = prevExpense > 0 ? Math.round((diff / prevExpense) * 100) : null;

  const bars = useMemo<{ list: Bar[]; max: number }>(() => {
    const now = new Date();
    const list: Bar[] = [];
    const inRange = (d: Date, a: Date, b: Date) => d >= a && d < b;
    if (period === 'week') {
      const names = ['월', '화', '수', '목', '금', '토', '일'];
      for (let i = 0; i < 7; i++) {
        const ds = new Date(info.start);
        ds.setDate(ds.getDate() + i);
        const de = new Date(ds);
        de.setDate(ds.getDate() + 1);
        const txns = periodTxns.filter((t) => t.type === 'expense' && inRange(new Date(t.date), ds, de));
        list.push({
          label: names[i],
          total: txns.reduce((s, t) => s + t.amount, 0),
          txns,
          isCurrent: now >= ds && now < de,
          detailTitle: `${ds.getMonth() + 1}월 ${ds.getDate()}일 · ${names[i]}요일`,
        });
      }
    } else if (period === 'month') {
      let weekStart = new Date(info.start);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      let idx = 1;
      while (weekStart < info.end) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 7);
        const txns = transactions.filter((t) => t.type === 'expense' && inRange(new Date(t.date), weekStart, weekEnd));
        list.push({
          label: `${idx}주`,
          total: txns.reduce((s, t) => s + t.amount, 0),
          txns,
          isCurrent: now >= weekStart && now < weekEnd,
          detailTitle: `${info.start.getMonth() + 1}월 ${idx}주차`,
        });
        weekStart = new Date(weekEnd);
        idx++;
      }
    } else {
      const year = info.start.getFullYear();
      for (let m = 0; m < 12; m++) {
        const ms = new Date(year, m, 1);
        const me = new Date(year, m + 1, 1);
        const txns = transactions.filter((t) => t.type === 'expense' && inRange(new Date(t.date), ms, me));
        list.push({
          label: `${m + 1}월`,
          total: txns.reduce((s, t) => s + t.amount, 0),
          txns,
          isCurrent: now.getFullYear() === year && now.getMonth() === m,
          detailTitle: `${year}년 ${m + 1}월`,
        });
      }
    }
    return { list, max: Math.max(...list.map((b) => b.total), 1) };
  }, [period, periodTxns, info, transactions]);

  const chartTitle =
    period === 'week' ? '이번 주 지출 추이 (요일별)' : period === 'month' ? '이번 달 지출 추이 (주별)' : '올해 지출 추이 (월별)';
  const chartHint =
    period === 'week' ? '요일을 눌러 그날 내역을 볼 수 있어요' : period === 'month' ? '주차를 눌러 그 주 내역을 볼 수 있어요' : '월을 눌러 그 달 내역을 볼 수 있어요';

  let offset = 0;

  return (
    <Screen>
      <ScreenHeader
        title="통계"
        right={<Text style={{ fontFamily: fontFamily.semibold, fontSize: 14, color: colors.text }}>{info.header}</Text>}
      />

      <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.lg }}>
        <SegmentedTabs
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'week', label: '주간' },
            { value: 'month', label: '월간' },
            { value: 'year', label: '연간' },
          ]}
        />
      </View>

      {catData.total > 0 ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
            <Svg viewBox="0 0 120 120" width={120} height={120}>
              <Circle cx={60} cy={60} r={R} fill="none" stroke={colors.track} strokeWidth={16} />
              <G rotation={-90} origin="60, 60">
                {catData.entries.slice(0, 6).map(([catId, amount], i) => {
                  const dash = (amount / catData.total) * CIRC;
                  const el = (
                    <Circle
                      key={catId}
                      cx={60}
                      cy={60}
                      r={R}
                      fill="none"
                      stroke={DONUT_COLORS[i]}
                      strokeWidth={16}
                      strokeDasharray={`${dash} ${CIRC}`}
                      strokeDashoffset={-offset}
                    />
                  );
                  offset += dash;
                  return el;
                })}
              </G>
              <SvgText x={60} y={56} textAnchor="middle" fontSize={10} fill={colors.textSub} fontWeight="500">
                {info.label}
              </SvgText>
              <SvgText x={60} y={73} textAnchor="middle" fontSize={14} fill={colors.text} fontWeight="800">
                {fmt(catData.total)}
              </SvgText>
            </Svg>
            <View style={{ flex: 1, gap: 8 }}>
              {catData.entries.slice(0, 4).map(([catId, amount], i) => {
                const cat = getCat(catId, 'expense', customCats);
                const pct = Math.round((amount / catData.total) * 100);
                return (
                  <View key={catId} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: DONUT_COLORS[i] }} />
                      <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.text }}>{cat.name}</Text>
                    </View>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.text, ...tabularNums }}>{pct}%</Text>
                  </View>
                );
              })}
            </View>
          </View>
        </Card>
      ) : (
        <EmptyState
          onPress={() => router.push('/input')}
          title="보여드릴 통계가 없어요"
          sub={'지출을 몇 개 기록하면\n여기에 통계가 나타나요'}
          cta="바로 기록하기"
        />
      )}

      {prevExpense > 0 && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            marginHorizontal: spacing.lg,
            marginBottom: spacing.lg,
            paddingVertical: spacing.lg,
            paddingHorizontal: spacing.xl,
            borderRadius: radii.card,
            backgroundColor: diff < 0 ? colors.incomeLight : colors.expenseLight,
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: radii.lg,
              backgroundColor: colors.white,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppIcon
              name={diff < 0 ? 'up' : 'down'}
              size={22}
              color={diff < 0 ? colors.incomeText : colors.expenseText}
              strokeWidth={2.4}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: diff < 0 ? colors.incomeStrong : colors.expenseStrong }}>
              {info.prevLabel} 대비
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.bold,
                fontSize: 15,
                marginTop: 2,
                color: diff < 0 ? colors.incomeStrong : colors.expenseStrong,
                ...tabularNums,
              }}
            >
              {fmt(Math.abs(diff))}원 {diff < 0 ? '덜 썼어요' : '더 썼어요'}
            </Text>
          </View>
          <Text
            style={{
              fontFamily: fontFamily.extrabold,
              fontSize: 20,
              letterSpacing: -0.4,
              color: diff < 0 ? colors.incomeText : colors.expenseText,
              ...tabularNums,
            }}
          >
            {diff < 0 ? '−' : '+'}
            {Math.abs(diffPct ?? 0)}%
          </Text>
        </View>
      )}

      {periodExpense > 0 && (
        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.lg }}>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>{chartTitle}</Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, ...tabularNums }}>
              합계 <Text style={{ fontFamily: fontFamily.semibold, color: colors.text }}>{fmt(periodExpense)}원</Text>
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: period === 'year' ? 4 : 10, height: 108 }}>
            {bars.list.map((b, i) => {
              const h = Math.max(4, Math.round((b.total / bars.max) * 90));
              return (
                <Pressable
                  key={i}
                  onPress={() => setSelectedBar(b)}
                  style={{ flex: 1, alignItems: 'center', gap: 6 }}
                >
                  <View style={{ width: '100%', height: 90, justifyContent: 'flex-end' }}>
                    <View
                      style={{
                        width: '100%',
                        height: h,
                        borderTopLeftRadius: 6,
                        borderTopRightRadius: 6,
                        backgroundColor: b.isCurrent ? colors.primary : colors.primaryLighter,
                      }}
                    />
                  </View>
                  <Text
                    style={{
                      fontFamily: b.isCurrent ? fontFamily.bold : fontFamily.regular,
                      fontSize: period === 'year' ? 9 : 10,
                      color: b.isCurrent ? colors.primaryStrong : colors.textMuted,
                    }}
                  >
                    {b.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textMuted, textAlign: 'center', marginTop: 8 }}>
            {chartHint}
          </Text>
        </Card>
      )}

      {selectedBar && (
        <Modal
          transparent
          visible
          animationType="slide"
          statusBarTranslucent
          onRequestClose={() => setSelectedBar(null)}
        >
          <View style={{ flex: 1, backgroundColor: colors.overlayStrong, justifyContent: 'flex-end' }}>
            <Pressable style={{ flex: 1 }} onPress={() => setSelectedBar(null)} />
            <View
              style={{
                backgroundColor: colors.bg,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                maxHeight: '76%',
                paddingBottom: 24,
              }}
            >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: spacing.lg,
              }}
            >
              <View>
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 18, color: colors.text }}>
                  {selectedBar.detailTitle}
                  {selectedBar.isCurrent ? ' · 현재' : ''}
                </Text>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, marginTop: 2, ...tabularNums }}>
                  지출 <Text style={{ fontFamily: fontFamily.bold, color: colors.text }}>{fmt(selectedBar.total)}원</Text> · {selectedBar.txns.length}건
                </Text>
              </View>
              <Pressable onPress={() => setSelectedBar(null)} hitSlop={10}>
                <AppIcon name="x" size={22} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingBottom: 12 }}>
              {selectedBar.txns.length === 0 ? (
                <EmptyState icon="calendar" title="기록된 지출이 없어요" sub="이 기간에 저장된 지출이 없어요" />
              ) : (
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
                  {selectedBar.txns
                    .slice()
                    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
                    .map((t, idx) => {
                      const cat = getCat(t.category, t.type, customCats);
                      const d = new Date(t.date);
                      const md = `${d.getMonth() + 1}/${d.getDate()}`;
                      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                      return (
                        <Pressable
                          key={t.id}
                          onPress={() => {
                            setSelectedBar(null);
                            router.push({ pathname: '/input', params: { id: t.id } });
                          }}
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
                              {md} {hm} · {cat.name}
                            </Text>
                          </View>
                          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text, ...tabularNums }}>
                            −{fmt(t.amount)}원
                          </Text>
                        </Pressable>
                      );
                    })}
                </View>
              )}
            </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </Screen>
  );
}
