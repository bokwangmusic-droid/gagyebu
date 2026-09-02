import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs, Toggle } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { getCat, type TxnType } from '@/data/categories';
import { fmt } from '@/lib/format';
import { describeSchedule } from '@/lib/recurring';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function RecurringList() {
  const router = useRouter();
  const { recurring, toggleRecurring, deleteRecurring, customCats } = useStore();
  const [tab, setTab] = useState<TxnType>('expense');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const filtered = useMemo(() => recurring.filter((r) => r.type === tab), [recurring, tab]);
  const monthlyTotal = filtered.filter((r) => r.active).reduce((s, r) => s + r.amount, 0);
  const activeCount = recurring.filter((r) => r.active).length;
  const pausedCount = recurring.length - activeCount;

  const handleDelete = (id: string) => {
    if (confirmDel === id) {
      deleteRecurring(id);
      setConfirmDel(null);
    } else {
      setConfirmDel(id);
    }
  };

  const addBtn = (
    <Pressable
      onPress={() => router.push('/recurring-add')}
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
  );

  return (
    <ModalScreen title="반복 지출·수입" onClose={() => router.back()} right={addBtn}>
      <Card style={{ marginTop: spacing.xs }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.textSub }}>
              이번 달 자동 반영 예정
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.extrabold,
                fontSize: 22,
                letterSpacing: -0.4,
                color: colors.text,
                marginTop: 4,
                ...tabularNums,
              }}
            >
              {tab === 'expense' ? '−' : '+'}
              {fmt(monthlyTotal)}
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, color: colors.textSub }}> 원</Text>
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 2 }}>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
              활성 <Text style={{ fontFamily: fontFamily.bold, color: colors.text }}>{activeCount}개</Text>
            </Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
              정지 <Text style={{ fontFamily: fontFamily.bold, color: colors.text }}>{pausedCount}개</Text>
            </Text>
          </View>
        </View>
      </Card>

      <View style={{ paddingHorizontal: spacing.lg }}>
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'expense', label: `지출 (${recurring.filter((r) => r.type === 'expense').length})`, tone: 'expense' },
            { value: 'income', label: `수입 (${recurring.filter((r) => r.type === 'income').length})`, tone: 'income' },
          ]}
        />
      </View>

      {filtered.length === 0 ? (
        <EmptyState
          onPress={() => router.push('/recurring-add')}
          title="반복 항목이 없어요"
          sub={'넷플릭스, 월세, 급여처럼\n매달·매주 반복되는 항목을 등록하세요'}
          cta="반복 항목 추가하기"
        />
      ) : (
        <View style={{ marginTop: spacing.md }}>
          <Text
            style={{
              fontFamily: fontFamily.bold,
              fontSize: 11,
              letterSpacing: 0.2,
              color: colors.textSub,
              marginHorizontal: spacing.xl,
              marginBottom: spacing.sm,
            }}
          >
            {tab === 'expense' ? '나가는 돈' : '들어오는 돈'}
          </Text>
          {filtered.map((r) => {
            const cat = getCat(r.category, r.type, customCats);
            return (
              <View
                key={r.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  marginHorizontal: spacing.lg,
                  marginBottom: spacing.sm,
                  paddingVertical: 12,
                  paddingHorizontal: spacing.lg,
                  backgroundColor: colors.white,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: radii.xl,
                  opacity: r.active ? 1 : 0.55,
                }}
              >
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
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: fontFamily.semibold, fontSize: 13, lineHeight: 16, color: colors.text, ...noPad }}
                  >
                    {r.name}
                  </Text>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 12, color: colors.textMuted, ...noPad }}>
                    {describeSchedule(r)}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: fontFamily.bold,
                    fontSize: 13,
                    color: r.type === 'income' ? colors.incomeStrong : colors.text,
                    ...tabularNums,
                  }}
                >
                  {r.type === 'income' ? '+' : '−'}
                  {fmt(r.amount)}
                </Text>
                <Toggle value={r.active} onChange={() => toggleRecurring(r.id)} />
                <Pressable
                  onPress={() => handleDelete(r.id)}
                  style={{
                    height: 30,
                    paddingHorizontal: confirmDel === r.id ? 10 : 0,
                    width: confirmDel === r.id ? undefined : 30,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radii.sm,
                    borderWidth: 1,
                    borderColor: confirmDel === r.id ? colors.expenseSolid : colors.expenseLight,
                    backgroundColor: confirmDel === r.id ? colors.expenseSolid : colors.white,
                  }}
                >
                  {confirmDel === r.id ? (
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.white }}>삭제할래요</Text>
                  ) : (
                    <AppIcon name="trash" size={14} color={colors.expenseText} />
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </ModalScreen>
  );
}
