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
import type { EnqueueOutcome } from '@/services/offlineQueue/coordinator';
import { addLoanPayment } from '@/services/remoteLoanWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import { usePendingWrites } from '@/store/pendingFinance';
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
  const { status, error, loans, pendingLoanOps, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: once the parent loan has resolved, FREEZE it for
  // this payment session. A later Realtime / foreground refresh that drops
  // the loan (the other member deleted it) must NOT unmount the form and
  // lose the typed amount — addLoanPayment()'s authoritative re-SELECT /
  // INSERT then fails and the user sees that outcome.
  const frozenLoanRef = useRef<Loan | null>(null);

  // STEP 16-H2-L2.1: only an ACTIVE (not-yet-terminal) offline op —
  // create/update/delete OR another queued repayment — blocks a SECOND
  // payment sheet from opening. A TERMINAL-failed op must NOT block: it is
  // retained forever with no discard UI reachable from this route, and the
  // coordinator's own `enqueueLoanPaymentCreate` clash guard already
  // excludes `lastError` records (mirrors the H2-G4 fix on the goal side).
  // Checked BEFORE the freeze below so a first entry is blocked only while
  // genuinely active; a form already frozen for this session stays open.
  const routePendingOp = pendingLoanOps.get(loanId);
  const routeHasActivePending = !!routePendingOp && !routePendingOp.failed;
  if (!frozenLoanRef.current && routeHasActivePending) {
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
            지금은 상환할 수 없어요
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
            전송 대기 중인 변경이 있어요. 반영된 뒤에 다시 시도할 수 있어요.
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

  const liveLoan = loans.find((l) => l.id === loanId) ?? null;
  if (!frozenLoanRef.current && liveLoan) frozenLoanRef.current = liveLoan;
  if (frozenLoanRef.current) {
    return <LoanPaymentForm key={loanId} loan={frozenLoanRef.current} />;
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title="상환하기" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  // Never resolved for this session — the loan genuinely isn't here.
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

function LoanPaymentForm({ loan }: { loan: Loan }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { status, refresh } = useFinanceRead();
  // STEP 16-H2-L2: durable offline fallback for a repayment create whose
  // direct write hit a TRANSPORT failure (offline). Never used for a
  // server/terminal verdict.
  const pending = usePendingWrites();

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

  /**
   * STEP 16-H2-L2: a durable-enqueue that itself failed — the change is NOT
   * queued, so the sheet stays open and the user is told why. Raw
   * coordinator reasons are never surfaced. Mirrors goal-movement / goal-add.
   */
  const enqueueFailMessage = (reason: Exclude<EnqueueOutcome, { ok: true }>['reason']): string => {
    switch (reason) {
      case 'not-hydrated':
        return '오프라인 저장 준비를 완료하지 못했어요. 잠시 후 다시 시도해주세요.';
      case 'persist':
        return '상환 기록을 기기에 저장하지 못했어요. 다시 시도해주세요.';
      case 'cap':
        return '전송 대기 중인 항목이 너무 많아요. 인터넷 연결 후 다시 시도해주세요.';
      case 'existing-pending':
        return '이미 전송 대기 중인 변경이 있어요.';
    }
  };

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

    // STEP 16-H2-L2: a TRANSPORT failure (offline) -> durable payment-create
    // queue. The SAME stable payment id (paymentIdRef, never regenerated)
    // goes into the PendingWrite, so a later flush replays the exact request
    // and its idempotency pre-check (STEP 16-H2-L1.1) stays safe — no
    // double-charge accident on a lost response. Optimistic `paid` display
    // comes from `composeLoanManagement`'s overlay (via `loanManagementRows`
    // wherever a screen reads it) — this screen never mutates `loan.paid`
    // itself.
    if (res.transport === true) {
      const enq = await pending.enqueueLoanPaymentCreate({
        scope: { userId: session.user.id, householdId: activeHousehold.id },
        entityId: paymentIdRef.current,
        loanId: loan.id,
        payload: { date, amount: magnitude },
      });
      submittingRef.current = false;
      setSubmitting(false);
      if (enq.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast.show('상환 기록을 추가했어요 · 인터넷에 연결되면 자동으로 반영할게요');
        router.back();
        return;
      }
      toast.show(enqueueFailMessage(enq.reason));
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
