import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, formatShortDate } from '@/lib/format';
import { describeRepayType, formatYearMonth, viewLoan } from '@/lib/loan';
import { softDeleteLoan, softDeleteLoanPayment } from '@/services/remoteLoanWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { Loan, LoanPayment } from '@/store/types';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function LoansList() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, error, loans, loanMeta, loanPaymentMeta, refresh } = useFinanceRead();
  const [expanded, setExpanded] = useState<string | null>(null);

  // One row-level write at a time — the id is either a loan id (card dim)
  // or a payment id (that payment row dim).
  const busyRef = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canCreate = REMOTE_FINANCE_WRITE.loanCreate;
  const canEdit = REMOTE_FINANCE_WRITE.loanEdit;
  const canDelete = REMOTE_FINANCE_WRITE.loanDelete;
  const canPay = REMOTE_FINANCE_WRITE.loanAddPayment;
  const canDeletePay = REMOTE_FINANCE_WRITE.loanDeletePayment;

  const totalRemaining = loans.reduce((s, ln) => s + Math.max(0, ln.principal - ln.paid), 0);

  const openAdd = () => router.push('/loan-add');
  const openEdit = (id: string) => router.push({ pathname: '/loan-add', params: { id } });
  const openPay = (id: string) => router.push({ pathname: '/loan-payment', params: { id } });

  /* ---------------- loan soft delete ---------------- */

  const doDeleteLoan = async (id: string, token: string) => {
    if (busyRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    busyRef.current = true;
    setBusyId(id);

    const res = await softDeleteLoan({
      id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    await refresh();
    busyRef.current = false;
    setBusyId(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('대출을 삭제했어요');
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 변경됐거나 삭제된 대출이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDeleteLoan = (ln: Loan) => {
    if (!canDelete || busyRef.current) return;
    const token = loanMeta[ln.id]?.updatedAt ?? null;
    if (!token) {
      toast.show('대출 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    Alert.alert(
      '대출을 삭제할까요?',
      '대출은 목록에서 사라지고 기존 상환 기록은 보존돼요. 실제 거래 내역에는 영향이 없어요.',
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => void doDeleteLoan(ln.id, token) },
      ],
    );
  };

  /* ---------------- payment soft delete ---------------- */

  const doDeletePayment = async (paymentId: string, token: string) => {
    if (busyRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    busyRef.current = true;
    setBusyId(paymentId);

    const res = await softDeleteLoanPayment({
      paymentId,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    await refresh();
    busyRef.current = false;
    setBusyId(null);

    if (res.ok) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('상환 기록을 삭제했어요');
      return;
    }
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 이미 변경된 상환 기록이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDeletePayment = (p: LoanPayment) => {
    if (!canDeletePay || busyRef.current) return;
    const token = loanPaymentMeta[p.id]?.updatedAt ?? null;
    if (!token) {
      toast.show('상환 기록 정보를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    Alert.alert(
      '상환 기록을 삭제할까요?',
      '삭제하면 해당 원금 상환분이 남은 원금에 다시 반영돼요.',
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => void doDeletePayment(p.id, token) },
      ],
    );
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title="대출 관리" onClose={() => router.back()}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const addBtn = canCreate ? (
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
    <ModalScreen title="대출 관리" onClose={() => router.back()} right={addBtn}>
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
          갚아야 할 남은 원금
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
          <Text
            style={{ fontFamily: fontFamily.extrabold, fontSize: 30, letterSpacing: -1, color: colors.white, ...tabularNums }}
          >
            {fmt(totalRemaining)}
          </Text>
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 15, color: 'rgba(255,255,255,0.9)' }}>원</Text>
        </View>
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: 'rgba(255,255,255,0.9)', marginTop: 8 }}>
          대출 {loans.length}건
        </Text>
      </LinearGradient>

      {loans.length === 0 ? (
        <EmptyState
          icon={canCreate ? undefined : 'landmark'}
          onPress={canCreate ? openAdd : undefined}
          cta={canCreate ? '대출 추가하기' : undefined}
          title="등록된 대출이 없어요"
          sub={
            canCreate
              ? '원금·이자·상환일을 등록해두면\n남은 원금과 상환 진행을 한눈에 볼 수 있어요'
              : '우리집 가계부에 등록된 대출이 없어요'
          }
        />
      ) : (
        loans.map((ln) => {
          const v = viewLoan(ln);
          const pct = Math.round(v.progress * 100);
          const isOpen = expanded === ln.id;
          const cardBusy = busyId === ln.id;
          return (
            <View
              key={ln.id}
              style={{
                marginHorizontal: spacing.lg,
                marginBottom: spacing.md,
                padding: spacing.lg,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radii.xxl,
                opacity: cardBusy ? 0.5 : 1,
              }}
            >
              <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: radii.lg,
                    backgroundColor: colors.primaryLight,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <AppIcon name="landmark" size={20} color={colors.primaryStrong} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18, color: colors.text, ...noPad }}
                    >
                      {ln.name}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fontFamily.bold,
                        fontSize: 12,
                        color: v.done ? colors.incomeText : colors.primaryStrong,
                        ...tabularNums,
                      }}
                    >
                      {v.done ? '상환완료' : `${pct}%`}
                    </Text>
                  </View>
                  <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, lineHeight: 14, color: colors.textMuted, ...noPad }}>
                    {ln.lender ? `${ln.lender} · ` : ''}
                    {describeRepayType(ln.repayType)}
                    {ln.annualRate > 0 ? ` · 연 ${ln.annualRate}%` : ''}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: spacing.md }}>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>남은 원금</Text>
                <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 18, color: colors.text, ...tabularNums }}>
                  {fmt(v.remaining)}
                </Text>
                <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textFaint, ...tabularNums }}>
                  / {fmt(ln.principal)}원
                </Text>
              </View>

              <ProgressBar percent={pct} size="md" style={{ marginTop: spacing.sm }} />

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md }}>
                <Chip
                  label={ln.repayType === 'equal_principal' ? '첫 달 예상' : '월 상환'}
                  value={`${fmt(v.scheduled)}원`}
                />
                <Chip label="만기" value={formatYearMonth(v.payoff)} />
                <Chip label="매월" value={`${ln.paymentDay}일`} />
                {v.interestPaid > 0 && <Chip label="낸 이자" value={`${fmt(v.interestPaid)}원`} />}
              </View>

              {(canPay || canEdit || canDelete) && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    marginTop: spacing.md,
                    paddingTop: spacing.md,
                    borderTopWidth: 1,
                    borderTopColor: colors.track,
                  }}
                >
                  {canPay && (
                    <ActionPill label="상환하기" onPress={() => openPay(ln.id)} disabled={cardBusy || v.done} />
                  )}
                  {canEdit && <ActionPill label="수정" onPress={() => openEdit(ln.id)} disabled={cardBusy} />}
                  <View style={{ flex: 1 }} />
                  {canDelete && (
                    <Pressable
                      onPress={() => confirmDeleteLoan(ln)}
                      disabled={cardBusy}
                      hitSlop={8}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: radii.sm,
                        borderWidth: 1,
                        borderColor: colors.expenseLight,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <AppIcon name="trash" size={13} color={colors.expenseText} />
                    </Pressable>
                  )}
                </View>
              )}

              {ln.payments.length > 0 && (
                <View style={{ flexDirection: 'row', gap: 6, marginTop: spacing.md, justifyContent: 'flex-end' }}>
                  <Pressable
                    onPress={() => setExpanded(isOpen ? null : ln.id)}
                    style={{
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                      borderRadius: radii.md,
                      backgroundColor: colors.white,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSub }}>
                      내역 {ln.payments.length}건 {isOpen ? '▲' : '▼'}
                    </Text>
                  </Pressable>
                </View>
              )}

              {isOpen && (
                <View style={{ marginTop: spacing.md, gap: 6 }}>
                  {ln.payments.map((p) => {
                    const payBusy = busyId === p.id;
                    return (
                      <View
                        key={p.id}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          paddingVertical: 8,
                          paddingHorizontal: 10,
                          backgroundColor: colors.track,
                          borderRadius: radii.sm,
                          opacity: payBusy ? 0.5 : 1,
                        }}
                      >
                        <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.textSub, width: 42, ...tabularNums }}>
                          {formatShortDate(p.date)}
                        </Text>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.text, ...tabularNums }}>
                            {fmt(p.amount)}원
                          </Text>
                          <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textMuted, ...tabularNums }}>
                            원금 {fmt(p.principalPart)} · 이자 {fmt(p.interestPart)}
                            {p.memo ? ` · ${p.memo}` : ''}
                          </Text>
                        </View>
                        {canDeletePay && (
                          <Pressable
                            onPress={() => confirmDeletePayment(p)}
                            disabled={payBusy}
                            hitSlop={8}
                            style={{
                              width: 26,
                              height: 26,
                              borderRadius: radii.sm,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <AppIcon name="trash" size={12} color={colors.textFaint} />
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })
      )}
    </ModalScreen>
  );
}

function ActionPill({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: radii.pill,
        borderWidth: 1,
        borderColor: colors.primaryLight,
        backgroundColor: colors.white,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>{label}</Text>
    </Pressable>
  );
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
