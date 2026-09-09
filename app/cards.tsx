import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import {
  cardBillingForMonth,
  installmentPlan,
  resolveCardKey,
  UNASSIGNED_CARD_ID,
} from '@/lib/card';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt } from '@/lib/format';
import { useFinanceRead } from '@/store/financeRead';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { CreditCard, Transaction } from '@/store/types';

interface CardRow {
  id: string;
  name: string;
  color?: { bg: string; color: string };
  paymentDay?: number;
  /** 사용월 기준 이번 달 예상 청구액. */
  monthCharge: number;
  /** 진행 중(잔여 회차가 남은) 할부 건수. */
  activeInstallments: number;
  /** 남은 할부 원금 합계. */
  remainingInstallment: number;
}

function buildRows(
  txns: Transaction[],
  cards: CreditCard[],
  now: Date,
): { rows: CardRow[]; unassigned: CardRow | null; total: number } {
  const billing = cardBillingForMonth(txns, cards, now);

  const acc: Record<string, { count: number; remaining: number }> = {};
  for (const t of txns) {
    if (t.type !== 'expense' || t.paymentMethod !== 'credit' || !t.installment) continue;
    const key = resolveCardKey(t, cards);
    const plan = installmentPlan(t, now);
    if (plan.remainingCount <= 0) continue;
    const bucket = (acc[key] ??= { count: 0, remaining: 0 });
    bucket.count += 1;
    bucket.remaining += plan.remainingAmount;
  }

  const rows: CardRow[] = cards.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    paymentDay: c.paymentDay,
    monthCharge: billing.byCard[c.id] ?? 0,
    activeInstallments: acc[c.id]?.count ?? 0,
    remainingInstallment: acc[c.id]?.remaining ?? 0,
  }));

  const unassignedActive = acc[UNASSIGNED_CARD_ID];
  const unassigned: CardRow | null =
    billing.unassigned > 0 || unassignedActive
      ? {
          id: UNASSIGNED_CARD_ID,
          name: '카드 미지정',
          monthCharge: billing.unassigned,
          activeInstallments: unassignedActive?.count ?? 0,
          remainingInstallment: unassignedActive?.remaining ?? 0,
        }
      : null;

  return { rows, unassigned, total: billing.total };
}

export default function CardsList() {
  const router = useRouter();
  const { status, error, cards, transactions, refresh } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();

  const { rows, unassigned, total } = useMemo(
    () => buildRows(transactions, cards, new Date()),
    [transactions, cards],
  );

  if (status !== 'ready') {
    return (
      <ModalScreen title="카드 관리" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const openAdd = () => router.push('/card-add');
  const openEdit = (id: string) =>
    router.push({ pathname: '/card-add', params: { id } });

  const addBtn = REMOTE_FINANCE_WRITE.cardCreate ? (
    <Pressable
      onPress={openAdd}
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
  ) : undefined;

  return (
    <ModalScreen title="카드 관리" onClose={() => router.back()} right={addBtn} refreshControl={financeRefresh}>
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.sm,
          marginBottom: 18,
          padding: spacing.xl,
          borderRadius: radii.card,
        }}
      >
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: 'rgba(255,255,255,0.9)' }}>
          사용월 기준 이번 달 예상 카드값
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
          <Text
            style={{ fontFamily: fontFamily.extrabold, fontSize: 30, letterSpacing: -1, color: colors.white, ...tabularNums }}
          >
            {fmt(total)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 15, color: 'rgba(255,255,255,0.9)' }}>원</Text>
        </View>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: 'rgba(255,255,255,0.85)', marginTop: 8, lineHeight: 15 }}>
          카드 {cards.length}장 · 카드사 실제 청구일과 다를 수 있어요
        </Text>
      </LinearGradient>

      {cards.length === 0 && !unassigned ? (
        <EmptyState
          icon={REMOTE_FINANCE_WRITE.cardCreate ? undefined : 'card'}
          onPress={REMOTE_FINANCE_WRITE.cardCreate ? openAdd : undefined}
          cta={REMOTE_FINANCE_WRITE.cardCreate ? '카드 등록하기' : undefined}
          title="등록된 카드가 없어요"
          sub={
            REMOTE_FINANCE_WRITE.cardCreate
              ? '카드를 등록하고 지출을 「신용」으로 기록하면\n사용월 기준 예상 카드값을 계산해드려요'
              : '우리집 가계부에 등록된 카드가 없어요'
          }
        />
      ) : (
        <>
          {rows.map((row) => (
            <CardItem
              key={row.id}
              row={row}
              onPress={REMOTE_FINANCE_WRITE.cardEdit ? () => openEdit(row.id) : undefined}
            />
          ))}
          {/* "카드 미지정" is not a real card — never an edit target. */}
          {unassigned && <CardItem key="unassigned" row={unassigned} />}
        </>
      )}
    </ModalScreen>
  );
}

function CardItem({ row, onPress }: { row: CardRow; onPress?: () => void }) {
  const isUnassigned = row.id === UNASSIGNED_CARD_ID;
  const accent = row.color?.color ?? colors.primaryStrong;
  const accentBg = row.color?.bg ?? colors.primaryLight;

  const body = (
    <>
      <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: radii.lg,
            backgroundColor: isUnassigned ? colors.track : accentBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name="card" size={20} color={isUnassigned ? colors.textMuted : accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18, color: colors.text, ...noPad }}
          >
            {row.name}
          </Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
            {isUnassigned
              ? '삭제됐거나 지정되지 않은 카드'
              : row.paymentDay
                ? `매월 ${row.paymentDay}일 결제 예정`
                : '결제일 미설정'}
          </Text>
        </View>
        {onPress && !isUnassigned && (
          <AppIcon name="chevron" size={16} color={colors.textMuted} />
        )}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: spacing.md }}>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
          사용월 기준 예상
        </Text>
        <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 18, color: colors.text, ...tabularNums }}>
          {fmt(row.monthCharge)}
        </Text>
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textFaint }}>원</Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm }}>
        <Chip
          label="진행 중 할부"
          value={row.activeInstallments > 0 ? `${row.activeInstallments}건` : '없음'}
        />
        {row.remainingInstallment > 0 && (
          <Chip label="남은 할부" value={`${fmt(row.remainingInstallment)}원`} />
        )}
      </View>
    </>
  );

  const containerStyle = {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.xxl,
  } as const;

  if (onPress && !isUnassigned) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [containerStyle, pressed && { opacity: 0.85 }]}>
        {body}
      </Pressable>
    );
  }
  return <View style={containerStyle}>{body}</View>;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 5,
        paddingHorizontal: 9,
        backgroundColor: colors.track,
        borderRadius: radii.sm,
      }}
    >
      <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textMuted }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 11, color: colors.text, ...tabularNums }}>{value}</Text>
    </View>
  );
}
