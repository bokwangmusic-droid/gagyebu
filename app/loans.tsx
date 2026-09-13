import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { FinanceLoadState } from '@/components/FinanceLoadState';
import { useRemoteFinanceRefreshControl } from '@/components/useRemoteFinanceRefreshControl';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, formatShortDate } from '@/lib/format';
import { describeRepayType, formatYearMonth, viewLoan } from '@/lib/loan';
import { pendingLoanRowLabel } from '@/lib/pendingLoanLabel';
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { softDeleteLoan, softDeleteLoanPayment } from '@/services/remoteLoanWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
import type { Loan, LoanPayment } from '@/store/types';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

export default function LoansList() {
  const router = useRouter();
  const toast = useToast();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const {
    status,
    error,
    loanMeta,
    loanPaymentMeta,
    // STEP 16-H2-L2.2: the LIST — cards AND the "갚아야 할 남은 원금" total
    // alike — renders `loanManagementRows` (authoritative server loans + a
    // pending/failed CREATE synthetic row, a pending UPDATE draft overlay, a
    // pending repayment's optimistic `paid` overlay, minus a not-failed
    // pending DELETE). Both READ THE SAME composed array so an active
    // repayment's optimistic `paid` moves the total by exactly what it moves
    // the card by — never two different numbers. `data.loans` (raw
    // authoritative) is deliberately not read here any more.
    loanManagementRows,
    pendingLoanOps,
    refresh,
  } = useFinanceRead();
  // STEP 16-H2-L2: durable offline fallback for a loan DELETE / repayment
  // DELETE whose direct write hit a TRANSPORT failure (offline). Never used
  // for a server/terminal verdict.
  const pending = usePendingWrites();
  const financeRefresh = useRemoteFinanceRefreshControl();
  const [expanded, setExpanded] = useState<string | null>(null);

  // One row-level write at a time — the id is either a loan id (card dim)
  // or a payment id (that payment row dim).
  const busyRef = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * STEP 16-H2-L2: a durable-enqueue that itself failed — the change is NOT
   * queued, so the row stays as it was. Raw coordinator reasons are never
   * surfaced. Mirrors goals.tsx.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '삭제 요청을 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

  /**
   * STEP 16-H2-L2: permanently drop ONE terminal-failed loan op (create /
   * update / delete / repayment create/delete) by its durable `queueId`.
   * NOT a server mutation — never touches `data.loans` / the server row; it
   * only removes the local un-sent record so `composeLoanManagement` falls
   * back to showing the authoritative server value again (or, for a failed
   * CREATE with no server row at all, the synthetic row simply disappears).
   * Mirrors app/goals.tsx's `discardFailed` — same API, same confirm-Alert
   * shape, same toast wording.
   */
  const discardFailed = (queueId: string) => {
    Alert.alert('변경을 버릴까요?', '서버에 반영되지 않은 변경 내용이 삭제되고, 서버에 저장된 내용으로 돌아가요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '변경 버리기',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const r = await pending.discardPending(queueId);
            toast.show(r.ok ? '변경을 버렸어요' : '변경을 정리하지 못했어요. 다시 시도해주세요.');
          })();
        },
      },
    ]);
  };

  const canCreate = REMOTE_FINANCE_WRITE.loanCreate;
  const canEdit = REMOTE_FINANCE_WRITE.loanEdit;
  const canDelete = REMOTE_FINANCE_WRITE.loanDelete;
  const canPay = REMOTE_FINANCE_WRITE.loanAddPayment;
  const canDeletePay = REMOTE_FINANCE_WRITE.loanDeletePayment;

  // STEP 16-H2-L2.2: computed from `loanManagementRows` (the SAME composed
  // rows the cards below render), NOT raw `loans` — a pending repayment
  // create/delete's optimistic `paid` overlay must move this total by the
  // exact same amount it moves the card's own "남은 원금", so the two never
  // disagree while active. A TERMINAL-failed op's row already reverts to
  // the authoritative `paid` inside `composeLoanManagement` itself, so this
  // total reverts with it automatically — no extra handling needed here.
  const totalRemaining = loanManagementRows.reduce((s, ln) => s + Math.max(0, ln.principal - ln.paid), 0);

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

    if (res.ok) {
      await refresh();
      busyRef.current = false;
      setBusyId(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('대출을 삭제했어요');
      return;
    }

    // STEP 16-H2-L2: a TRANSPORT failure (offline) -> durable soft-DELETE
    // queue with the FROZEN token captured before the confirm Alert (never
    // re-read). `composeLoanManagement` hides the row from the list right
    // away (optimistic); `data.loans` stays server-authoritative until the
    // flush lands and a refresh confirms it.
    if (res.transport === true) {
      const enq = await pending.enqueueLoanDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: id,
        expectedUpdatedAt: token,
      });
      busyRef.current = false;
      setBusyId(null);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('대출을 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    await refresh();
    busyRef.current = false;
    setBusyId(null);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 변경됐거나 삭제된 대출이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDeleteLoan = (ln: Loan) => {
    // STEP 16-H2-L2.1: only an ACTIVE pending op blocks a new delete — a
    // TERMINAL-failed op must not permanently lock the row (mirrors the
    // coordinator's own `!r.lastError` clash guard).
    const op = pendingLoanOps.get(ln.id);
    if (!canDelete || busyRef.current || (!!op && !op.failed)) return;
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

  const doDeletePayment = async (loanId: string, paymentId: string, token: string) => {
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

    if (res.ok) {
      await refresh();
      busyRef.current = false;
      setBusyId(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('상환 기록을 삭제했어요');
      return;
    }

    // STEP 16-H2-L2: a TRANSPORT failure (offline) -> durable repayment
    // soft-DELETE queue. `expectedUpdatedAt` is the PAYMENT's own token
    // (captured before the confirm Alert, never re-read) — never the loan's.
    // `composeLoanManagement`'s overlay optimistically reverses `paid` by
    // this payment's own `principalPart` and removes it from the displayed
    // `payments` list; the same H2-L1 semantics as the direct-write path.
    if (res.transport === true) {
      const enq = await pending.enqueueLoanPaymentDelete({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: paymentId,
        loanId,
        expectedUpdatedAt: token,
      });
      busyRef.current = false;
      setBusyId(null);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('상환 기록을 삭제했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
      return;
    }

    await refresh();
    busyRef.current = false;
    setBusyId(null);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    toast.show('다른 곳에서 이미 변경된 상환 기록이에요. 최신 내용을 불러왔어요.');
  };

  const confirmDeletePayment = (loanId: string, p: LoanPayment) => {
    // STEP 16-H2-L2.1: only an ACTIVE pending op on the parent loan blocks a
    // new payment delete — a TERMINAL-failed op must not permanently lock it.
    const op = pendingLoanOps.get(loanId);
    if (!canDeletePay || busyRef.current || (!!op && !op.failed)) return;
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
        { text: '삭제', style: 'destructive', onPress: () => void doDeletePayment(loanId, p.id, token) },
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
    <ModalScreen title="대출 관리" onClose={() => router.back()} right={addBtn} refreshControl={financeRefresh}>
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
          대출 {loanManagementRows.length}건
        </Text>
      </LinearGradient>

      {loanManagementRows.length === 0 ? (
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
        loanManagementRows.map((ln) => {
          const v = viewLoan(ln);
          const pct = Math.round(v.progress * 100);
          const isOpen = expanded === ln.id;
          const cardBusy = busyId === ln.id;
          // STEP 16-H2-L2.1: a row backed by an ACTIVE (not-yet-terminal)
          // offline loan op (create/update/delete OR a queued repayment) is
          // read-only — no 상환하기/수정/삭제. A TERMINAL-failed op keeps its
          // failure label + "변경 버리기" but does NOT lock these actions —
          // it is retained forever and locking on it would make the row
          // permanently stuck (mirrors the coordinator's own `!r.lastError`
          // clash guard, H2-G4's fix generalized to loan). The displayed row
          // is ALWAYS `loanManagementRows`' resolved value (server-
          // authoritative when one exists, or the optimistic overlay) —
          // never a locally-invented one on top of that.
          const pendingOp = pendingLoanOps.get(ln.id);
          const hasActivePending = !!pendingOp && !pendingOp.failed;
          // STEP 16-H2-L2.2: the ONE exception — a TERMINAL-failed CREATE's
          // synthetic row has NO real loan behind it on the server at all
          // (`composeLoanManagement` only kept it visible so the user can
          // see/discard it). 상환하기/수정/삭제 would each just dead-end in
          // a "찾을 수 없어요" notice, so this row alone keeps its actions
          // hidden even though it's terminal-failed — never sends a
          // meaningless mutation against an id the server has never heard
          // of. A failed UPDATE/DELETE/repayment still targets a REAL loan
          // and stays unlocked per H2-L2.1.
          const isFailedCreateSynthetic = !!pendingOp?.failed && pendingOp.op === 'create';
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
                // STEP 16-H2-L2 (mirrors goal-management): a pending / failed
                // offline row reads as muted — subtle, not a red alert.
                opacity: cardBusy ? 0.5 : pendingOp ? 0.6 : 1,
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

              {pendingOp && (
                <View style={{ marginTop: spacing.sm }}>
                  <Text
                    style={{
                      fontFamily: fontFamily.medium,
                      fontSize: 11,
                      lineHeight: 14,
                      color: pendingOp.failed ? colors.textSub : colors.textMuted,
                    }}
                  >
                    {pendingLoanRowLabel(pendingOp)}
                  </Text>
                  {/* STEP 16-H2-L2: ONLY a TERMINAL-failed op offers this —
                      never a still-pending/awaiting-ack create/update/
                      delete/repayment. */}
                  {pendingOp.failed && pendingOp.queueId && (
                    <Pressable
                      onPress={() => discardFailed(pendingOp.queueId!)}
                      hitSlop={8}
                      style={{ alignSelf: 'flex-start', marginTop: 4 }}
                    >
                      <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>
                        변경 버리기
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}

              {(canPay || canEdit || canDelete) && !hasActivePending && !isFailedCreateSynthetic && (
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
                            onPress={() => confirmDeletePayment(ln.id, p)}
                            disabled={payBusy || hasActivePending}
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
