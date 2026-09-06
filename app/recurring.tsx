import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { FinanceReadOnlyBanner } from '@/components/FinanceReadOnlyBanner';
import { Card } from '@/components/ui/Card';
import { SegmentedTabs } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { getCat, type TxnType } from '@/data/categories';
import { fmt } from '@/lib/format';
import { describeSchedule } from '@/lib/recurring';
import { useFinanceRead } from '@/store/financeRead';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function RecurringList() {
  const router = useRouter();
  const { status, error, recurring, customCats, refresh } = useFinanceRead();
  const [tab, setTab] = useState<TxnType>('expense');

  const filtered = useMemo(() => recurring.filter((r) => r.type === tab), [recurring, tab]);
  const monthlyTotal = filtered.filter((r) => r.active).reduce((s, r) => s + r.amount, 0);
  const activeCount = recurring.filter((r) => r.active).length;
  const pausedCount = recurring.length - activeCount;

  if (status !== 'ready') {
    return (
      <ModalScreen title="반복 지출·수입" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen title="반복 지출·수입" onClose={() => router.back()}>
      <FinanceReadOnlyBanner />
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
          icon="refresh"
          title="반복 항목이 없어요"
          sub={'우리집 가계부에 등록된 반복 항목이 없어요'}
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
                    {!r.active ? ' · 정지됨' : ''}
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
              </View>
            );
          })}
        </View>
      )}
    </ModalScreen>
  );
}
