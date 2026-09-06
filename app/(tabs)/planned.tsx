import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { Screen } from '@/components/ui/Screen';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { getCat } from '@/data/categories';
import { fmt, weekdayKo } from '@/lib/format';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { PlannedExpense } from '@/store/types';

const DAY_MS = 86_400_000;
const TAG_STYLE = {
  expense: { bg: colors.expenseLight, fg: colors.expenseStrong },
  warning: { bg: colors.warningLight, fg: colors.warningText },
  violet: { bg: colors.primaryLight, fg: colors.primaryStrong },
} as const;

export default function PlannedScreen() {
  const router = useRouter();
  const { status, error, planned, notes, customCats, refresh } = useFinanceRead();
  const [tab, setTab] = useState<'planned' | 'notes'>('planned');

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const groups = useMemo(() => {
    const sorted = [...planned].sort((a, b) => +new Date(a.date) - +new Date(b.date));
    const g: { overdue: Row[]; today: Row[]; week: Row[]; later: Row[] } = {
      overdue: [],
      today: [],
      week: [],
      later: [],
    };
    for (const p of sorted) {
      const diff = Math.round((+new Date(`${p.date}T00:00:00`) - +now) / DAY_MS);
      const row = { p, diff };
      if (diff < 0) g.overdue.push(row);
      else if (diff === 0) g.today.push(row);
      else if (diff <= 7) g.week.push(row);
      else g.later.push(row);
    }
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planned]);

  const totalUpcoming = planned.reduce((s, p) => s + (p.amount || 0), 0);

  if (status !== 'ready') {
    return (
      <Screen>
        <ScreenHeader title="예정 · 메모" />
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="예정 · 메모" />
      <FinanceReadOnlyBanner />

      <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.lg }}>
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'planned', label: `예정 지출${planned.length > 0 ? ` (${planned.length})` : ''}` },
            { value: 'notes', label: '메모' },
          ]}
        />
      </View>

      {tab === 'planned' ? (
        <>
          {planned.length > 0 && (
            <Card>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>앞으로 나갈 예정</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
                <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 34, letterSpacing: -1, color: colors.text, ...tabularNums }}>
                  {fmt(totalUpcoming)}
                </Text>
                <Text style={{ fontFamily: fontFamily.medium, fontSize: 16, color: colors.textSub }}>원</Text>
              </View>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, marginTop: 6 }}>
                총 {planned.length}건 · 결제일 오면 앱이 알려드려요
              </Text>
            </Card>
          )}

          {planned.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="예정된 지출이 없어요"
              sub={'우리집 가계부에 예정된 지출이 없어요'}
            />
          ) : (
            <>
              <Group label="지난 예정" color={colors.expenseStrong} rows={groups.overdue} customCats={customCats} />
              <Group label="오늘 · 임박" color={colors.warningText} rows={groups.today} customCats={customCats} />
              <Group label="이번 주 (7일 이내)" rows={groups.week} customCats={customCats} />
              <Group label="나중에" rows={groups.later} customCats={customCats} />
            </>
          )}
        </>
      ) : (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, lineHeight: 18, marginBottom: spacing.md, paddingHorizontal: 4 }}>
            우리집 메모예요. 지금은 조회만 할 수 있어요.
          </Text>
          <TextInput
            value={notes}
            editable={false}
            multiline
            placeholder="아직 메모가 없어요"
            placeholderTextColor={colors.textMuted}
            style={{
              minHeight: 320,
              padding: 16,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.xl,
              backgroundColor: colors.track,
              fontFamily: fontFamily.regular,
              fontSize: 14,
              lineHeight: 24,
              color: colors.text,
              textAlignVertical: 'top',
            }}
          />
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 6, ...tabularNums }}>
            {notes.length}자
          </Text>
        </View>
      )}
    </Screen>
  );
}

interface Row {
  p: PlannedExpense;
  diff: number;
}

function Group({
  label,
  color,
  rows,
  customCats,
}: {
  label: string;
  color?: string;
  rows: Row[];
  customCats: Parameters<typeof getCat>[2];
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 11,
          letterSpacing: 0.2,
          color: color ?? colors.textSub,
          marginHorizontal: spacing.xl,
          marginBottom: spacing.sm,
        }}
      >
        {label}
      </Text>
      {rows.map(({ p, diff }) => {
        const cat = getCat(p.category, 'expense', customCats);
        const d = new Date(`${p.date}T00:00:00`);
        const dayLabel = `${d.getMonth() + 1}/${d.getDate()}(${weekdayKo(d)})`;
        const status =
          diff < 0
            ? { text: `${Math.abs(diff)}일 지남`, tag: 'expense' as const }
            : diff === 0
              ? { text: '오늘', tag: 'warning' as const }
              : diff <= 3
                ? { text: `D-${diff}`, tag: 'warning' as const }
                : { text: `D-${diff}`, tag: 'violet' as const };
        const ts = TAG_STYLE[status.tag];
        return (
          <View
            key={p.id}
            style={{
              marginHorizontal: spacing.lg,
              marginBottom: spacing.sm,
              paddingVertical: 14,
              paddingHorizontal: spacing.lg,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.xl,
            }}
          >
            <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: radii.md,
                  backgroundColor: cat.bg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AppIcon name={cat.icon} size={20} color={cat.color} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  <Text style={{ fontFamily: fontFamily.semibold, fontSize: 14, lineHeight: 17, color: colors.text, ...noPad }}>
                    {p.name}
                  </Text>
                  <View style={{ backgroundColor: ts.bg, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: ts.fg }}>{status.text}</Text>
                  </View>
                </View>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
                  {dayLabel} · {cat.name}
                  {p.memo ? ` · ${p.memo}` : ''}
                </Text>
              </View>
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text, ...tabularNums }}>
                −{fmt(p.amount)}
              </Text>
            </View>
          </View>
        );
      })}
    </>
  );
}
