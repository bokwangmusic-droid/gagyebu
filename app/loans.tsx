import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Field, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { EmptyState } from '@/components/ui/EmptyState';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { useToast } from '@/components/ui/Toast';
import { fmt, formatShortDate, parseNum, toDateKey } from '@/lib/format';
import { describeRepayType, formatYearMonth, splitPayment, viewLoan } from '@/lib/loan';
import { useStore } from '@/store/store';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';
import type { Loan } from '@/store/types';

/** 상환 금액 digit entry — identical to the main expense keypad (app/input.tsx). */
function applyAmountDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

export default function LoansList() {
  const router = useRouter();
  const toast = useToast();
  const { loans, deleteLoan, addLoanPayment, deleteLoanPayment } = useStore();

  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<Loan | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(() => toDateKey(new Date()));
  const [payMemo, setPayMemo] = useState('');
  // 상환 금액도 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)로 입력. 시트 안에
  // 렌더되므로 ModalScreen의 footer 대신 시트 본문 하단에 붙인다.
  const [payPadOpen, setPayPadOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const totalRemaining = loans.reduce(
    (s, ln) => s + Math.max(0, ln.principal - ln.paid),
    0,
  );

  const handleDelete = (id: string) => {
    if (confirmDel === id) {
      deleteLoan(id);
      setConfirmDel(null);
    } else {
      setConfirmDel(id);
    }
  };

  // A double-tap on "상환 기록" would append two payment records (and reduce
  // 원금 twice) before the sheet closes — latch until the sheet reopens.
  const submitting = useRef(false);

  const openPay = (ln: Loan) => {
    const v = viewLoan(ln);
    submitting.current = false;
    setPayFor(ln);
    setPayAmount(v.remaining > 0 ? String(Math.min(v.scheduled, v.remaining)) : '');
    setPayDate(toDateKey(new Date()));
    setPayMemo('');
    setPayPadOpen(true); // amount ready immediately (replaces the old autoFocus)
  };

  const closePay = () => {
    setPayFor(null);
    setPayPadOpen(false);
  };

  const onPayKey = (k: string) => setPayAmount((a) => applyAmountDigit(a, k));

  const doPay = () => {
    const n = parseNum(payAmount);
    if (submitting.current || n <= 0 || !payFor) return;
    submitting.current = true;
    addLoanPayment(payFor.id, { amount: n, date: payDate, memo: payMemo.trim() || undefined });
    toast.show('상환 내역을 기록했어요');
    closePay();
  };

  const paySplit = useMemo(() => {
    if (!payFor) return null;
    const remaining = Math.max(0, payFor.principal - payFor.paid);
    return splitPayment(remaining, payFor.annualRate, parseNum(payAmount));
  }, [payFor, payAmount]);

  const addBtn = (
    <Pressable
      onPress={() => router.push('/loan-add')}
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
          onPress={() => router.push('/loan-add')}
          title="등록된 대출이 없어요"
          sub={'원금·이자율·기간을 넣으면\n매달 상환액과 남은 원금을 계산해드려요'}
          cta="대출 추가하기"
        />
      ) : (
        loans.map((ln) => {
          const v = viewLoan(ln);
          const pct = Math.round(v.progress * 100);
          const isOpen = expanded === ln.id;
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
                <Chip label="월 상환" value={`${fmt(v.scheduled)}원`} />
                <Chip label="만기" value={formatYearMonth(v.payoff)} />
                <Chip label="매월" value={`${ln.paymentDay}일`} />
                {v.interestPaid > 0 && <Chip label="낸 이자" value={`${fmt(v.interestPaid)}원`} />}
              </View>

              <View style={{ flexDirection: 'row', gap: 6, marginTop: spacing.md, justifyContent: 'flex-end' }}>
                {ln.payments.length > 0 && (
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
                )}
                {!v.done && (
                  <Pressable
                    onPress={() => openPay(ln)}
                    style={{
                      paddingVertical: 10,
                      paddingHorizontal: 16,
                      borderRadius: radii.md,
                      backgroundColor: colors.primaryLight,
                    }}
                  >
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>+ 상환</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => handleDelete(ln.id)}
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: radii.md,
                    backgroundColor: confirmDel === ln.id ? colors.expenseSolid : colors.white,
                    borderWidth: 1,
                    borderColor: confirmDel === ln.id ? colors.expenseSolid : colors.border,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: fontFamily.semibold,
                      fontSize: 13,
                      color: confirmDel === ln.id ? colors.white : colors.expenseText,
                    }}
                  >
                    {confirmDel === ln.id ? '삭제할래요' : '삭제'}
                  </Text>
                </Pressable>
              </View>

              {isOpen && (
                <View style={{ marginTop: spacing.md, gap: 6 }}>
                  {ln.payments.map((p) => (
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
                      <Pressable onPress={() => deleteLoanPayment(ln.id, p.id)} hitSlop={8}>
                        <AppIcon name="x" size={13} color={colors.textFaint} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })
      )}

      {payFor && (
        <BottomSheet visible onClose={closePay} title={`「${payFor.name}」 상환`} scroll>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, marginBottom: spacing.md }}>
            남은 원금 {fmt(Math.max(0, payFor.principal - payFor.paid))}원 · 예정 월 상환액{' '}
            {fmt(viewLoan(payFor).scheduled)}원
          </Text>
          <Field label="상환 금액">
            <Pressable
              onPress={() => setPayPadOpen(true)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                width: '100%',
                paddingVertical: 12,
                paddingHorizontal: 14,
                backgroundColor: payPadOpen ? colors.primaryLighter : colors.white,
                borderWidth: 1,
                borderColor: payPadOpen ? colors.primaryLight : colors.border,
                borderRadius: radii.md,
              }}
            >
              <Text
                style={{
                  flex: 1,
                  fontFamily: fontFamily.semibold,
                  fontSize: 16,
                  color: payAmount ? colors.text : payPadOpen ? colors.primaryStrong : colors.textMuted,
                  ...tabularNums,
                }}
              >
                {payAmount ? fmt(Number(payAmount)) : '0'}
              </Text>
              <Text
                style={{
                  fontFamily: fontFamily.medium,
                  fontSize: 14,
                  color: payPadOpen ? colors.primaryStrong : colors.textSub,
                  marginLeft: 6,
                }}
              >
                원
              </Text>
            </Pressable>
          </Field>
          {paySplit && parseNum(payAmount) > 0 && (
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, marginTop: -spacing.sm, marginBottom: spacing.md, ...tabularNums }}>
              이자 {fmt(paySplit.interestPart)}원 · 원금 {fmt(paySplit.principalPart)}원으로 처리돼요
            </Text>
          )}
          <Field label="상환일">
            <DateStepper value={payDate} onChange={setPayDate} max={toDateKey(new Date())} />
          </Field>
          <Field label="메모 (선택)">
            <TextField
              value={payMemo}
              onChangeText={setPayMemo}
              onFocus={() => setPayPadOpen(false)}
              placeholder="예: 중도상환 수수료 포함"
              maxLength={40}
            />
          </Field>
          <GradientButton label="상환 기록" onPress={doPay} disabled={!parseNum(payAmount)} />
          {payPadOpen && (
            <NumPad
              style={{ marginTop: spacing.lg, marginHorizontal: -spacing.xl }}
              onKey={onPayKey}
              onBackspace={() => onPayKey('back')}
              onDone={() => setPayPadOpen(false)}
            />
          )}
        </BottomSheet>
      )}
    </ModalScreen>
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
