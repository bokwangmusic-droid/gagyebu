import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FinanceLoadState } from '@/components/FinanceLoadState';
import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { ChipSelect, Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { describeRepayType, formatYearMonth, payoffDate, scheduledPayment } from '@/lib/loan';
import { uid } from '@/lib/id';
import type { RemoteLoanMeta } from '@/lib/remoteFinanceMapping';
import type { NewLoanDraft } from '@/lib/remoteLoanWriteMapping';
import { isValidDateKey } from '@/lib/remotePlannedWriteMapping';
import { createLoan, softDeleteLoan, updateLoan } from '@/services/remoteLoanWrite';
import { useAuth } from '@/store/auth';
import { useFinanceRead } from '@/store/financeRead';
import { useHousehold } from '@/store/household';
import type { Loan, LoanRepayType } from '@/store/types';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

const TERM_PRESETS = ['12', '24', '36', '60', '120'];

type NumFieldKey = 'principal' | 'rate' | 'term' | 'day';

const REPAY_OPTIONS: { value: LoanRepayType; label: string }[] = [
  { value: 'amortizing', label: '원리금균등' },
  { value: 'equal_principal', label: '원금균등' },
  { value: 'bullet', label: '만기일시' },
];

/**
 * Custom-NumPad scroll assist — same pattern as app/recurring-add.tsx.
 * The NumPad is a ModalScreen `footer` sibling of the ScrollView: opening
 * it shrinks the viewport but fires no OS-keyboard event. We scroll the
 * MINIMUM: only when the tapped field's bottom + margin would fall below
 * the shrunk viewport, and then by exactly that overflow.
 * `NUMPAD_SCROLL_CLEARANCE` is a conditional bottom spacer so `scrollTo`
 * can actually reach the target for the lowest field (RN clamps to
 * contentSize - viewport); it collapses to 0 when the pad closes.
 */
const NUMPAD_SCROLL_CLEARANCE = 200;
const NUMPAD_FIELD_BOTTOM_MARGIN = 24;

/** Integer digit entry — same rules as planned-add / goal-add, param'd by max length. */
function applyIntDigit(cur: string, k: string, maxLen: number): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur === '' || cur === '0' || cur.length + 2 > maxLen ? cur : cur + '00';
  if (k === '0') return cur === '' || cur === '0' || cur.length >= maxLen ? cur : cur + '0';
  return cur.length >= maxLen ? cur : (cur === '0' ? '' : cur) + k;
}

/** Decimal digit entry for 이자율: one '.', 3 integer + 2 fractional digits. */
function applyRateDigit(cur: string, k: string): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '.') return cur.includes('.') ? cur : (cur === '' ? '0' : cur) + '.';
  if (!/^[0-9]$/.test(k)) return cur;
  const dot = cur.indexOf('.');
  if (dot === -1) return cur.length >= 3 ? cur : (cur === '0' ? '' : cur) + k;
  return cur.length - dot - 1 >= 2 ? cur : cur + k;
}

/**
 * Route entry for /loan-add — STEP 16-G2-D4.
 *
 *   /loan-add           -> new loan form (loanCreate)
 *   /loan-add?id=<lid>  -> edit form     (loanEdit)
 *
 * Either capability off -> ReadOnlyRouteNotice. Thin wrapper (goal-add
 * pattern) so LoanForm keeps an unconditional hook order.
 */
export default function LoanAddRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;

  if (idParam) {
    if (!REMOTE_FINANCE_WRITE.loanEdit) return <ReadOnlyRouteNotice title="대출 수정" />;
    return <LoanFormRoute editId={idParam} />;
  }
  if (!REMOTE_FINANCE_WRITE.loanCreate) return <ReadOnlyRouteNotice title="대출" />;
  return <LoanForm key="create" mode={{ kind: 'create' }} />;
}

type FormMode =
  | { kind: 'create' }
  | { kind: 'edit'; loan: Loan; meta: RemoteLoanMeta };

function LoanFormRoute({ editId }: { editId: string }) {
  const router = useRouter();
  const { status, error, loans, loanMeta, refresh } = useFinanceRead();

  // STEP 16-G3-B2 §17-21: freeze the first resolved loan + token for the
  // edit session so a later Realtime / foreground refresh that drops the
  // row can't unmount the open form and lose the draft — the save's
  // optimistic-concurrency check decides deleted / gone / conflict.
  const frozenRef = useRef<{ loan: Loan; meta: RemoteLoanMeta } | null>(null);
  const liveTarget = loans.find((l) => l.id === editId) ?? null;
  const liveMeta = loanMeta[editId] ?? null;
  if (!frozenRef.current && liveTarget && liveMeta) {
    frozenRef.current = { loan: liveTarget, meta: liveMeta };
  }
  if (frozenRef.current) {
    return (
      <LoanForm
        key={editId}
        mode={{ kind: 'edit', loan: frozenRef.current.loan, meta: frozenRef.current.meta }}
      />
    );
  }

  if (status !== 'ready') {
    return (
      <ModalScreen title="대출 수정" onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }
  if (!liveTarget) {
    return (
      <EditUnavailable
        body="이미 삭제됐거나 다른 우리집의 대출일 수 있어요."
        onRetry={() => void refresh()}
      />
    );
  }
  // liveTarget but no meta -> a safe concurrency-guarded edit is impossible.
  return <EditUnavailable body="잠시 후 다시 시도해 주세요." onRetry={() => void refresh()} />;
}

function EditUnavailable({ body, onRetry }: { body: string; onRetry: () => void }) {
  const router = useRouter();
  return (
    <ModalScreen title="대출 수정" onClose={() => router.back()} scroll={false}>
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
          {body}
        </Text>
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
            다시 불러오기
          </Text>
        </Pressable>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={{ fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSub }}>
            목록으로 돌아가기
          </Text>
        </Pressable>
      </View>
    </ModalScreen>
  );
}

function LoanForm({ mode }: { mode: FormMode }) {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  // Household finance READ values come ONLY from the remote read-only
  // source — never useStore(). No local addLoan/updateLoan is ever called.
  const { status, error, refresh } = useFinanceRead();

  const editing = mode.kind === 'edit' ? mode.loan : null;
  const isEdit = mode.kind === 'edit';
  const currentPaid = editing?.paid ?? 0;

  // Concurrency token captured ONCE at mount — a later background refresh
  // (e.g. after someone records a repayment) must never swap it out
  // (STEP 16-G2-D4 §6/§13).
  const expectedUpdatedAtRef = useRef(mode.kind === 'edit' ? mode.meta.updatedAt : null);
  const loanIdRef = useRef(uid('loan'));

  const [name, setName] = useState(editing?.name ?? '');
  const [lender, setLender] = useState(editing?.lender ?? '');
  const [principal, setPrincipal] = useState(editing ? String(editing.principal) : '');
  const [rate, setRate] = useState(editing ? String(editing.annualRate) : '');
  const [term, setTerm] = useState(editing ? String(editing.termMonths) : '36');
  const [startDate, setStartDate] = useState(editing?.startDate ?? (() => toDateKey(new Date()))());
  const [paymentDay, setPaymentDay] = useState(editing ? String(editing.paymentDay) : '25');
  const [repayType, setRepayType] = useState<LoanRepayType>(editing?.repayType ?? 'amortizing');

  const [activeField, setActiveField] = useState<NumFieldKey | null>(null);

  // ---- Scroll assist for the custom NumPad (see the module constants) ----
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const [viewportH, setViewportH] = useState(0);
  const fieldRectRef = useRef<Record<NumFieldKey, { y: number; h: number }>>({
    principal: { y: 0, h: 0 },
    rate: { y: 0, h: 0 },
    term: { y: 0, h: 0 },
    day: { y: 0, h: 0 },
  });
  const onFieldLayout =
    (key: NumFieldKey) =>
    (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      fieldRectRef.current[key] = { y, h: height };
    };

  useEffect(() => {
    if (!activeField || viewportH <= 0) return;
    const t = setTimeout(() => {
      const sv = scrollRef.current;
      if (!sv) return;
      const { y: fieldY, h: fieldH } = fieldRectRef.current[activeField];
      if (fieldH <= 0) return;
      const overflow = fieldY + fieldH + NUMPAD_FIELD_BOTTOM_MARGIN - (scrollYRef.current + viewportH);
      if (overflow > 1) {
        sv.scrollTo({ y: scrollYRef.current + overflow, animated: true });
      }
    }, 50);
    return () => clearTimeout(t);
  }, [activeField, viewportH]);

  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);

  const p = parseNum(principal);
  const r = parseFloat(rate) || 0;
  const n = parseNum(term);
  const day = Math.min(31, Math.max(1, parseNum(paymentDay) || 1));
  const monthly = p > 0 && n > 0 ? scheduledPayment(p, r, n, repayType) : 0;

  const principalTooLow = isEdit && p > 0 && p < currentPaid;
  const canSave = name.trim().length > 0 && p > 0 && n > 0 && !principalTooLow;
  const busy = submitting || deleting;

  const openField = (f: NumFieldKey) => {
    Keyboard.dismiss();
    setActiveField(f);
  };
  const onKey = (k: string) => {
    if (activeField === 'principal') setPrincipal((a) => applyIntDigit(a, k, 10));
    else if (activeField === 'rate') setRate((a) => applyRateDigit(a, k));
    else if (activeField === 'term') setTerm((a) => applyIntDigit(a, k, 3));
    else if (activeField === 'day') setPaymentDay((a) => applyIntDigit(a, k, 2));
  };

  /** Draft-state -> NewLoanDraft, or null when the form isn't valid. */
  const buildDraft = (): NewLoanDraft | null => {
    const nm = name.trim();
    if (nm.length === 0) return null;
    const pp = parseNum(principal);
    if (!Number.isInteger(pp) || pp <= 0) return null;
    const rr = parseFloat(rate) || 0;
    if (!Number.isFinite(rr) || rr < 0) return null;
    const nn = parseNum(term);
    if (!Number.isInteger(nn) || nn <= 0) return null;
    if (!isValidDateKey(startDate)) return null;
    if (isEdit && pp < currentPaid) return null;
    return {
      name: nm,
      lender: lender.trim(),
      principal: pp,
      annualRate: rr,
      termMonths: nn,
      startDate,
      paymentDay: day,
      repayType,
    };
  };

  const save = async () => {
    if (submittingRef.current || deletingRef.current || !canSave) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;

    const draft = buildDraft();
    if (!draft) {
      toast.show(principalTooLow ? '이미 상환한 원금보다 대출 원금을 낮출 수 없어요.' : '대출 정보를 확인해 주세요.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    if (mode.kind === 'create') {
      const res = await createLoan({
        id: loanIdRef.current,
        householdId: activeHousehold.id,
        expectedUserId: session.user.id,
        draft,
      });
      if (!res.ok) {
        submittingRef.current = false;
        setSubmitting(false);
        toast.show(res.message);
        return;
      }
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('대출을 추가했어요');
      router.back();
      return;
    }

    const token = expectedUpdatedAtRef.current;
    if (!token) {
      submittingRef.current = false;
      setSubmitting(false);
      toast.show('대출 정보를 다시 불러와 주세요.');
      return;
    }
    const res = await updateLoan({
      id: mode.loan.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
      draft,
    });
    if (!res.ok) {
      submittingRef.current = false;
      setSubmitting(false);
      if (
        res.reason === 'identity' ||
        res.reason === 'error' ||
        res.reason === 'invalid' ||
        res.reason === 'principal_low'
      ) {
        toast.show(res.message); // keep the form open with the user's input
        return;
      }
      // conflict / deleted / gone — reload authoritative data and leave the
      // stale form (intended protection when a repayment happened, §13).
      await refresh();
      toast.show(res.message);
      router.back();
      return;
    }
    await refresh();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast.show('대출을 수정했어요');
    router.back();
  };

  const confirmDelete = () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    Alert.alert(
      '대출을 삭제할까요?',
      '대출은 목록에서 사라지고 기존 상환 기록은 보존돼요. 실제 거래 내역에는 영향이 없어요.',
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: () => void doDelete() },
      ],
    );
  };

  const doDelete = async () => {
    if (mode.kind !== 'edit' || submittingRef.current || deletingRef.current) return;
    if (status !== 'ready' || !session?.user?.id || !activeHousehold) return;
    const token = expectedUpdatedAtRef.current;
    if (!token) {
      toast.show('대출 정보를 다시 불러와 주세요.');
      return;
    }

    deletingRef.current = true;
    setDeleting(true);

    const res = await softDeleteLoan({
      id: mode.loan.id,
      householdId: activeHousehold.id,
      expectedUserId: session.user.id,
      expectedUpdatedAt: token,
    });

    if (res.ok) {
      await refresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast.show('대출을 삭제했어요');
      router.back();
      return;
    }

    deletingRef.current = false;
    setDeleting(false);
    if (res.reason === 'identity' || res.reason === 'error') {
      toast.show(res.message);
      return;
    }
    await refresh();
    toast.show(res.message);
    router.back();
  };

  if (status !== 'ready') {
    return (
      <ModalScreen title={isEdit ? '대출 수정' : '대출 추가'} onClose={() => router.back()} scroll={false}>
        <FinanceLoadState status={status} error={error} onRetry={() => void refresh()} />
      </ModalScreen>
    );
  }

  return (
    <ModalScreen
      title={isEdit ? '대출 수정' : '대출 추가'}
      closeIcon="x"
      onClose={() => router.back()}
      scrollRef={scrollRef}
      onScrollViewLayout={(e) => setViewportH(e.nativeEvent.layout.height)}
      onScrollViewScroll={(e) => {
        scrollYRef.current = e.nativeEvent.contentOffset.y;
      }}
      right={
        <HeaderTextButton
          label={submitting ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={!canSave || busy}
        />
      }
      footer={
        activeField ? (
          <NumPad
            style={{ paddingBottom: insets.bottom + 16 }}
            decimal={activeField === 'rate'}
            onKey={onKey}
            onBackspace={() => onKey('back')}
            onDone={() => setActiveField(null)}
          />
        ) : undefined
      }
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        {isEdit && (
          <View style={{ alignItems: 'flex-end', marginBottom: spacing.xs }}>
            <Pressable
              onPress={confirmDelete}
              disabled={busy}
              hitSlop={10}
              style={{ padding: 4, opacity: busy ? 0.4 : 1 }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
                {deleting ? '삭제 중…' : '삭제'}
              </Text>
            </Pressable>
          </View>
        )}

        <Field label="대출 이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setActiveField(null)}
            placeholder="예: 전세자금대출, 자동차 할부"
            maxLength={30}
          />
        </Field>
        <Field label="대출 기관 (선택)">
          <TextField
            value={lender}
            onChangeText={setLender}
            onFocus={() => setActiveField(null)}
            placeholder="예: 국민은행"
            maxLength={20}
          />
        </Field>
        <View onLayout={onFieldLayout('principal')}>
          <Field label="원금" hint={isEdit ? `이미 상환한 원금 ${fmt(currentPaid)}원보다 낮출 수 없어요` : undefined}>
            <NumFieldRow
              value={principal ? fmt(Number(principal)) : ''}
              suffix="원"
              active={activeField === 'principal'}
              onPress={() => openField('principal')}
            />
            {principalTooLow && (
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 11, color: colors.expenseText, marginTop: 6 }}>
                이미 상환한 원금({fmt(currentPaid)}원)보다 작게 설정할 수 없어요.
              </Text>
            )}
          </Field>
        </View>
        <View onLayout={onFieldLayout('rate')}>
          <Field label="연이자율 (%)" hint="고정금리 기준으로 계산해요 · 예: 4.25">
            <NumFieldRow
              value={rate}
              suffix="%"
              active={activeField === 'rate'}
              onPress={() => openField('rate')}
            />
          </Field>
        </View>
        <Field label="상환 방식">
          <ChipSelect value={repayType} onChange={setRepayType} options={REPAY_OPTIONS} />
        </Field>
        <View onLayout={onFieldLayout('term')}>
          <Field label="상환 기간 (개월)">
            <NumFieldRow
              value={term}
              suffix="개월"
              active={activeField === 'term'}
              onPress={() => openField('term')}
            />
            <View style={{ height: spacing.sm }} />
            <ChipSelect
              value={term}
              onChange={setTerm}
              options={TERM_PRESETS.map((m) => ({ value: m, label: `${m}개월` }))}
            />
          </Field>
        </View>
        <Field label="첫 상환일">
          <DateStepper value={startDate} onChange={setStartDate} />
        </Field>
        <View onLayout={onFieldLayout('day')}>
          <Field label="매월 상환일">
            <NumFieldRow
              value={paymentDay}
              suffix="일"
              active={activeField === 'day'}
              onPress={() => openField('day')}
            />
          </Field>
        </View>

        {monthly > 0 && (
          <View
            style={{
              marginTop: spacing.xs,
              marginBottom: spacing.xl,
              padding: spacing.lg,
              backgroundColor: colors.primaryLight,
              borderRadius: radii.xxl,
            }}
          >
            <Text style={{ fontFamily: fontFamily.semibold, fontSize: 11, color: colors.primaryStrong }}>
              {repayType === 'equal_principal' ? '첫 달 예상 납입액' : '예상'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
              <Text
                style={{ fontFamily: fontFamily.extrabold, fontSize: 24, color: colors.primaryStrong, ...tabularNums }}
              >
                {fmt(monthly)}
              </Text>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.primaryStrong }}>
                {repayType === 'equal_principal' ? '원' : '원 / 월'}
              </Text>
            </View>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, marginTop: 6 }}>
              {describeRepayType(repayType)}
              {repayType === 'bullet' ? ' · 매달 이자만, 원금은 만기 상환' : ''}
              {repayType === 'equal_principal' ? ' · 매달 원금은 같고 이자가 줄어 납입액이 감소해요' : ''}
              {' · 만기 '}
              {formatYearMonth(payoffDate(startDate, n))}
            </Text>
          </View>
        )}

        {/* Reserve scroll room so a lower numeric field can be lifted clear
            of the custom NumPad; collapses to 0 once the pad is closed. */}
        <View style={{ height: activeField ? NUMPAD_SCROLL_CLEARANCE : 0 }} />
      </View>
    </ModalScreen>
  );
}

/** Tap target that shows a numeric value + unit and opens the shared NumPad. */
function NumFieldRow({
  value,
  suffix,
  active,
  onPress,
}: {
  value: string;
  suffix: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        paddingVertical: 12,
        paddingHorizontal: 14,
        backgroundColor: active ? colors.primaryLighter : colors.white,
        borderWidth: 1,
        borderColor: active ? colors.primaryLight : colors.border,
        borderRadius: radii.md,
      }}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: fontFamily.semibold,
          fontSize: 16,
          color: value ? colors.text : active ? colors.primaryStrong : colors.textMuted,
          ...tabularNums,
        }}
      >
        {value || '0'}
      </Text>
      <Text
        style={{
          fontFamily: fontFamily.medium,
          fontSize: 14,
          color: active ? colors.primaryStrong : colors.textSub,
          marginLeft: 6,
        }}
      >
        {suffix}
      </Text>
    </Pressable>
  );
}
