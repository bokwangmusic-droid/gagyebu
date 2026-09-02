import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { Screen } from '@/components/ui/Screen';
import { HeaderIconButton, ScreenHeader } from '@/components/ui/ScreenHeader';
import { useToast } from '@/components/ui/Toast';
import { getCat } from '@/data/categories';
import { fmt, weekdayKo } from '@/lib/format';
import { useStore } from '@/store/store';
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
  const toast = useToast();
  const { planned, deletePlanned, markPlannedDone, notes, setNotes, customCats } = useStore();
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

  const right =
    tab === 'planned' ? (
      <HeaderIconButton icon="plus" primary onPress={() => router.push('/planned-add')} />
    ) : undefined;

  return (
    <Screen>
      <ScreenHeader title="예정 · 메모" right={right} />

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
              onPress={() => router.push('/planned-add')}
              title="예정된 지출이 없어요"
              sub={'결혼식 축의금, 생일선물, 병원비 등\n미리 예정된 지출을 등록해두면\n날짜에 맞춰 알려드려요'}
              cta="예정 지출 추가하기"
            />
          ) : (
            <>
              <Group label="지난 예정" color={colors.expenseStrong} rows={groups.overdue} onDelete={remove} onDone={done} customCats={customCats} />
              <Group label="오늘 · 임박" color={colors.warningText} rows={groups.today} onDelete={remove} onDone={done} customCats={customCats} />
              <Group label="이번 주 (7일 이내)" rows={groups.week} onDelete={remove} onDone={done} customCats={customCats} />
              <Group label="나중에" rows={groups.later} onDelete={remove} onDone={done} customCats={customCats} />
            </>
          )}
        </>
      ) : (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, lineHeight: 18, marginBottom: spacing.md, paddingHorizontal: 4 }}>
            가계 관련 아무거나 자유롭게. 예산 계획, 사고 싶은 것 리스트, 절약 목표 등.
          </Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            multiline
            placeholder={'예:\n- 이번 달 카페 지출 5만원 이하로 줄이기\n- 겨울 코트 예산 20만원까지'}
            placeholderTextColor={colors.textMuted}
            style={{
              minHeight: 320,
              padding: 16,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.xl,
              backgroundColor: colors.white,
              fontFamily: fontFamily.regular,
              fontSize: 14,
              lineHeight: 24,
              color: colors.text,
              textAlignVertical: 'top',
            }}
          />
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 6, ...tabularNums }}>
            자동 저장 · {notes.length}자
          </Text>
        </View>
      )}
    </Screen>
  );

  function remove(p: PlannedExpense) {
    Alert.alert(`${p.name} 예정을 삭제할까요?`, undefined, [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => {
          deletePlanned(p.id);
          toast.show('삭제했어요');
        },
      },
    ]);
  }
  function done(p: PlannedExpense) {
    markPlannedDone(p);
    toast.show('지출로 옮겼어요');
  }
}

interface Row {
  p: PlannedExpense;
  diff: number;
}

function Group({
  label,
  color,
  rows,
  onDelete,
  onDone,
  customCats,
}: {
  label: string;
  color?: string;
  rows: Row[];
  onDelete: (p: PlannedExpense) => void;
  onDone: (p: PlannedExpense) => void;
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
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
              <Pressable
                onPress={() => onDelete(p)}
                style={{ paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm }}
              >
                <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.textSub }}>삭제</Text>
              </Pressable>
              <Pressable
                onPress={() => onDone(p)}
                style={{ paddingVertical: 6, paddingHorizontal: 14, backgroundColor: colors.primary, borderRadius: radii.sm }}
              >
                <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.white }}>✓ 지출 완료</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </>
  );
}
