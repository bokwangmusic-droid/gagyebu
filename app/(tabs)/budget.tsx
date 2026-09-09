import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Screen } from '@/components/ui/Screen';
import { HeaderIconButton, ScreenHeader } from '@/components/ui/ScreenHeader';
import { useToast } from '@/components/ui/Toast';
import { getCat } from '@/data/categories';
import { monthlyTotals } from '@/lib/aggregate';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { daysLeftInMonth, fmt } from '@/lib/format';
import { softDeleteBudget } from '@/services/remoteBudgetWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

export default function BudgetScreen() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, error, transactions, budgets, budgetMeta, customCats, refresh } = useFinanceRead();
  const financeRefresh = useRemoteFinanceRefreshControl();
  const { byCategory, expense, totalBudget, remaining } = useMemo(
    () => monthlyTotals(transactions, budgets),
    [transactions, budgets],
  );

  const entries = Object.entries(budgets).sort((a, b) => (b[1] || 0) - (a[1] || 0));

  const deletingRef = useRef(false);
  const [deletingCat, setDeletingCat] = useState<string | null>(null);

  const canAdd = REMOTE_FINANCE_WRITE.budgetCreate || REMOTE_FINANCE_WRITE.budgetEdit;

  const doDelete = async (catId: string, token: string) => {
    if (deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    deletingRef.current = true;
    setDeletingCat(catId);

    const res = await softDeleteBudget({
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      category: catId,
      expectedUpdatedAt: token,
    });

    await refresh();
    deletingRef.current = false;
    setDeletingCat(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('예산을 삭제했어요');
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 이미 변경됐거나 삭제된 예산이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDelete = (catId: string, catName: string) => {
    if (deletingRef.current) return;
    // STEP 16-G2-C3-B §31/§32: capture the concurrency token at the moment
    // the delete is initiated — NOT after the Alert is confirmed — so a
    // (hypothetical) background refresh can't swap it under us. No token =>
    // no safe concurrency-guarded delete, so refuse rather than blind-delete.
    const token = budgetMeta[catId]?.updatedAt ?? null;
    if (!token) {
      toast.show('예산 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    Alert.alert(`${catName} 예산을 삭제할까요?`, '지출 내역은 그대로 남아요.', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => void doDelete(catId, token) },
    ]);
  };

  if (status !== 'ready') {
    return (
      <Screen>
        <ScreenHeader title="예산 관리" onBack={router.canGoBack() ? () => router.back() : undefined} />
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </Screen>
    );
  }

  return (
    <Screen refreshControl={financeRefresh}>
      <ScreenHeader
        title="예산 관리"
        onBack={router.canGoBack() ? () => router.back() : undefined}
        right={
          canAdd ? (
            <HeaderIconButton icon="plus" primary onPress={() => router.push('/budget-add')} />
          ) : undefined
        }
      />

      {/* Hero */}
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          marginHorizontal: spacing.lg,
          marginBottom: spacing.lg,
          padding: spacing.xl,
          borderRadius: radii.card,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: 'rgba(255,255,255,0.9)' }}>
              {new Date().getMonth() + 1}월 전체 예산
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
              <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 28, letterSpacing: -1, color: colors.white, ...tabularNums }}>
                {fmt(totalBudget)}
              </Text>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, color: 'rgba(255,255,255,0.9)' }}>원</Text>
            </View>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>남은 일수</Text>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.white, marginTop: 2, ...tabularNums }}>
              {daysLeftInMonth()}일
            </Text>
          </View>
        </View>
        <ProgressBar
          percent={totalBudget > 0 ? (expense / totalBudget) * 100 : 0}
          fillColor={colors.white}
          trackColor="rgba(255,255,255,0.25)"
          style={{ marginTop: spacing.lg }}
        />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }}>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: 'rgba(255,255,255,0.95)', ...tabularNums }}>
            <Text style={{ fontFamily: fontFamily.bold }}>{fmt(expense)}원</Text> 사용
          </Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: 'rgba(255,255,255,0.95)', ...tabularNums }}>
            <Text style={{ fontFamily: fontFamily.bold }}>{fmt(remaining)}원</Text> {remaining >= 0 ? '남음' : '초과'}
          </Text>
        </View>
      </LinearGradient>

      {/* Section */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginHorizontal: spacing.xl,
          marginBottom: spacing.sm,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text }}>카테고리별 예산</Text>
        {canAdd && (
          <Pressable onPress={() => router.push('/budget-add')} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <AppIcon name="plus" size={12} color={colors.primaryStrong} strokeWidth={2.5} />
            <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.primaryStrong }}>추가</Text>
          </Pressable>
        )}
      </View>

      {entries.length === 0 ? (
        <EmptyState
          icon={REMOTE_FINANCE_WRITE.budgetCreate ? undefined : 'nav-budget'}
          onPress={REMOTE_FINANCE_WRITE.budgetCreate ? () => router.push('/budget-add') : undefined}
          cta={REMOTE_FINANCE_WRITE.budgetCreate ? '예산 설정하기' : undefined}
          title="예산이 아직 없어요"
          sub={
            REMOTE_FINANCE_WRITE.budgetCreate
              ? '카테고리별로 한 달 예산을 정하면\n과소비를 미리 막을 수 있어요'
              : '우리집 가계부에 설정된 예산이 없어요'
          }
        />
      ) : (
        entries.map(([catId, amount]) => {
          const cat = getCat(catId, 'expense', customCats);
          const spent = byCategory[catId] || 0;
          const pct = Math.round((spent / amount) * 100);
          const over = pct >= 100;
          const warn = pct >= 80;
          const canDeleteThis = REMOTE_FINANCE_WRITE.budgetDelete && !!budgetMeta[catId];
          return (
            <BudgetRowShell
              key={catId}
              over={over}
              dimmed={deletingCat === catId}
              onPress={
                REMOTE_FINANCE_WRITE.budgetEdit
                  ? () => router.push({ pathname: '/budget-add', params: { category: catId } })
                  : undefined
              }
            >
              <View style={{ flexDirection: 'row', gap: spacing.md, marginBottom: 10, alignItems: 'center' }}>
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: radii.md,
                    backgroundColor: over ? colors.expenseLight : cat.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name={cat.icon} size={18} color={over ? colors.expenseText : cat.color} strokeWidth={2.2} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.text }}>{cat.name}</Text>
                    {over && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.expenseLight, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                        <AppIcon name="warn" size={8} color={colors.expenseStrong} strokeWidth={3} />
                        <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: colors.expenseStrong }}>초과</Text>
                      </View>
                    )}
                    {!over && warn && (
                      <View style={{ backgroundColor: colors.warningLight, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                        <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: colors.warningText }}>80%</Text>
                      </View>
                    )}
                  </View>
                  <Text
                    style={{
                      fontFamily: over ? fontFamily.semibold : fontFamily.regular,
                      fontSize: 11,
                      color: over ? colors.expenseStrong : colors.textSub,
                      marginTop: 1,
                      ...tabularNums,
                    }}
                  >
                    {fmt(spent)} <Text style={{ color: over ? colors.expenseStrong : colors.textFaint }}>/ {fmt(amount)}원</Text>
                    {over ? <Text style={{ fontFamily: fontFamily.bold }}> (+{fmt(spent - amount)})</Text> : null}
                  </Text>
                </View>
                <Text
                  style={{
                    fontFamily: fontFamily.bold,
                    fontSize: 13,
                    color: over ? colors.expenseStrong : warn ? colors.warningText : colors.incomeText,
                    ...tabularNums,
                  }}
                >
                  {pct}%
                </Text>
                {canDeleteThis && (
                  <Pressable
                    // Nested Pressable: RN's responder system hands the
                    // touch to this inner target, so the row-shell Pressable
                    // does NOT navigate when the trash icon is tapped.
                    onPress={() => confirmDelete(catId, cat.name)}
                    disabled={deletingRef.current}
                    hitSlop={8}
                  >
                    <AppIcon name="trash" size={14} color={colors.textFaint} />
                  </Pressable>
                )}
              </View>
              <ProgressBar
                percent={Math.min(100, pct)}
                size="sm"
                trackColor={over ? colors.expenseLight : colors.track}
                fillColor={over ? colors.expenseSolid : warn ? colors.warning : cat.color}
              />
            </BudgetRowShell>
          );
        })
      )}
    </Screen>
  );
}

/**
 * Category-budget card container. A plain <View> normally; a <Pressable>
 * (tap -> /budget-add?category=…) when budget editing is enabled. Keeps the
 * row's visual style identical either way; only adds a pressed-dim.
 */
function BudgetRowShell({
  over,
  dimmed,
  onPress,
  children,
}: {
  over: boolean;
  dimmed: boolean;
  onPress?: () => void;
  children: ReactNode;
}) {
  const base = {
    marginHorizontal: spacing.lg,
    marginBottom: 10,
    paddingVertical: 14,
    paddingHorizontal: 18,
    backgroundColor: colors.white,
    borderWidth: over ? 1.5 : 1,
    borderColor: over ? '#FBCFE8' : colors.border,
    borderRadius: radii.xxl,
  } as const;

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [base, { opacity: dimmed ? 0.5 : pressed ? 0.85 : 1 }]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, { opacity: dimmed ? 0.5 : 1 }]}>{children}</View>;
}
