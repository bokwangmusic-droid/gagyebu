import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { Field, HeaderTextButton } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { uid } from '@/lib/id';
import { splitPayment } from '@/lib/loan';
import { addLoanPayment } from '@/services/remoteLoanWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { Loan } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

/**
 * Route entry for /loan-payment — STEP 16-G2-D4.
 *
 *   /loan-payment?id=<loanId>   -> "상환하기"
 *
 * The user types ONLY a total amount + a date. principal/interest split is
 * NEVER user input — the service recomputes it from an authoritative
 * re-SELECT of the loan just before INSERT (this screen's preview is
 * "예상" only). This screen NEVER writes `loans.paid`.
 */
export default function LoanPaymentRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (!REMOTE_FINANCE_WRITE.loanAddPayment || !idParam) {
    return <ReadOnlyRouteNotice title="대출" />;
  }
  return <LoanPaymentFormRoute loanId={idParam} />;
}

function LoanPaymentFormRoute({ loanId }: { loanId: string }) {
  const router = useRouter();
  const { status, error, loans, refresh } = useFinanceRead();

  if (status !== 'ready') {
    return (
      <ModalScreen title="상환하기" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  const loan = loans.find((l) => l.id === loanId) ?? null;
  if (!loan) {
    return (
      <ModalScreen title="상환하기" onClose={() => router.back()} scroll={false}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing.xl,
            gap: spacing.md,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, textAlign: 'center' }}>
            대출을 찾을 수 없어요
          </Text>
          <Text
            style={{
              fontFamily: fontFamily.regular,
              fontSize: 13,
              color: colors.textSub,
              textAlign: 'center',
              lineHeight: 19,
            }}
          >
            이미 삭제됐거나 다른 우리집의 대출일 수 있어요.
          </Text>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
              목록으로 돌아가기
            </Text>
          </Pressable>
        </View>
      </ModalScreen>
    );
  }

  return <LoanPaymentForm key={loanId} loan={loan} />;
}

function LoanPaymentForm({ loan }: { loan: Loan }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, refresh } = useFinanceRead();

  // Client-generated payment id, minted ONCE per sheet mount and reused on
  // EVERY save retry (STEP 16-G2-D4 §8-1). A fresh id on retry would move
  // loans.paid twice.
  const paymentIdRef = useRef(uid('lp'));

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => toDateKey(new Date()));
  const [padVisible, setPadVisible] = useState(true);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  // Domain snapshot — DISPLAY / preview only. The authoritative split is
  // recomputed inside addLoanPayment() from a fresh re-SELECT.
  const remaining = Math.max(0, loan.principal - loan.paid);
  const paidOff = remaining <= 0;
  const magnitude = parseNum(amount);
  const canSave = Number.isInteger(magnitude) && magnitude > 0 && !paidOff && !submitting;

  const preview =
    magnitude > 0 && !paidOff ? splitPayment(remaining, loan.annualRate, magnitude) : null;

  const onKey = (k: string) => setAmount((a) => applyDigit(a, k));

  const save = async () => {
    if (submittingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    submittingRef.current = true;
    setSubmitting(true);

    const res = await addLoanPayment({
      paymentId: paymentIdRef.current, // unchanged on retry
      householdId: activeHousehold.id,
      loanId: loan.id,
      expectedUserId: session.user.id,
      draft: { date, amount: magnitude },
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('상환 기록을 추가했어요');
      router.back();
      return;
    }

    submittingRef.current = false;
    setSubmitting(false);
    if (res.reason === 'gone' || res.reason === 'deleted' || res.reason === 'conflict') {
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    if (res.reason === 'stale' || res.reason === 'paid_off') {
      // Balance moved under us — reload so the user re-checks, keep the sheet.
      await refresh();
      toast.show(res.message);
      return;
    }
    // invalid / identity / error — keep the sheet with the amount.
    toast.show(res.message);
  };

  return (
    <ModalScreen
      title="상환하기"
      closeIcon="x"
      onClose={() => router.back()}
      right={
        <HeaderTextButton
          label={submitting ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={!canSave}
        />
      }
      footer={
        padVisible ? (
          <NumPad
            style={{ paddingBottom: insets.bottom + 16 }}
            onKey={onKey}
            onBackspace={() => onKey('back')}
            onDone={() => setPadVisible(false)}
          />
        ) : undefined
      }
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <View
          style={{
            padding: spacing.lg,
            marginBottom: spacing.lg,
            backgroundColor: colors.track,
            borderRadius: radii.md,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>{loan.name}</Text>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub, marginTop: 4, ...tabularNums }}>
            남은 원금 {fmt(remaining)}원
          </Text>
        </View>

        <Field label="상환 금액">
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setPadVisible(true);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              width: '100%',
              paddingVertical: 12,
              paddingHorizontal: 14,
              backgroundColor: padVisible ? colors.primaryLighter : colors.white,
              borderWidth: 1,
              borderColor: padVisible ? colors.primaryLight : colors.border,
              borderRadius: radii.md,
            }}
          >
            <Text
              style={{
                flex: 1,
                fontFamily: fontFamily.semibold,
                fontSize: 16,
                color: amount ? colors.text : padVisible ? colors.primaryStrong : colors.textMuted,
                ...tabularNums,
              }}
            >
              {amount ? fmt(Number(amount)) : '0'}
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.medium,
                fontSize: 14,
                color: padVisible ? colors.primaryStrong : colors.textSub,
                marginLeft: 6,
              }}
            >
              원
            </Text>
          </Pressable>
        </Field>

        <Field label="상환일">
          <DateStepper value={date} onChange={setDate} />
        </Field>

        {paidOff && (
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.incomeText, marginTop: -6 }}>
            이미 모두 상환한 대출이에요.
          </Text>
        )}
        {preview && (
          <View style={{ marginTop: spacing.xs, gap: 2 }}>
            <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.primaryStrong, ...tabularNums }}>
              예상 원금 상환 {fmt(preview.principalPart)}원 · 예상 이자 {fmt(preview.interestPart)}원
            </Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub }}>
              실제 값은 저장 시점의 최신 잔액 기준으로 다시 계산돼요.
            </Text>
          </View>
        )}
      </View>
    </ModalScreen>
  );
}
