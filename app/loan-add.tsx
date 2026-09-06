import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { ChipSelect, Field, HeaderTextButton, SegmentedTabs, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { REMOTE_FINANCE_READ_ONLY } from '@/lib/financeMode';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { describeRepayType, formatYearMonth, payoffDate, scheduledPayment } from '@/lib/loan';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';
import type { LoanRepayType } from '@/store/types';

const TERM_PRESETS = ['12', '24', '36', '60', '120'];

type NumFieldKey = 'principal' | 'rate' | 'term' | 'day';

/**
 * Integer digit entry — same rules as the money keypad in planned-add /
 * goal-add, parameterised by a max length. `applyIntDigit(cur, k, 10)` is
 * byte-for-byte identical to those screens' `applyDigit` (10-digit cap, no
 * leading zero, "00" shortcut, backspace).
 */
function applyIntDigit(cur: string, k: string, maxLen: number): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur === '' || cur === '0' || cur.length + 2 > maxLen ? cur : cur + '00';
  if (k === '0') return cur === '' || cur === '0' || cur.length >= maxLen ? cur : cur + '0';
  return cur.length >= maxLen ? cur : (cur === '0' ? '' : cur) + k;
}

/**
 * Decimal digit entry for the 이자율 field: at most one '.', up to 3 integer
 * digits and 2 fractional digits, never a bare leading '.' or a double '..'.
 * `parseFloat(rate) || 0` on the result keeps the stored `annualRate` format
 * exactly as before (e.g. "3." -> 3, "4.25" -> 4.25, "" -> 0).
 */
function applyRateDigit(cur: string, k: string): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '.') return cur.includes('.') ? cur : (cur === '' ? '0' : cur) + '.';
  if (!/^[0-9]$/.test(k)) return cur; // ignore '00' etc. in decimal mode
  const dot = cur.indexOf('.');
  if (dot === -1) return cur.length >= 3 ? cur : (cur === '0' ? '' : cur) + k;
  return cur.length - dot - 1 >= 2 ? cur : cur + k;
}

export default function LoanAdd() {
  // STEP 16-G1B: see app/input.tsx's identical guard comment.
  if (REMOTE_FINANCE_READ_ONLY) return <ReadOnlyRouteNotice title="대출" />;

  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { addLoan } = useStore();

  const [name, setName] = useState('');
  const [lender, setLender] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [term, setTerm] = useState('36');
  const [startDate, setStartDate] = useState(() => toDateKey(new Date()));
  const [paymentDay, setPaymentDay] = useState('25');
  const [repayType, setRepayType] = useState<LoanRepayType>('amortizing');

  // Which numeric field the shared NumPad is editing (null = pad hidden).
  const [activeField, setActiveField] = useState<NumFieldKey | null>(null);

  const p = parseNum(principal);
  const r = parseFloat(rate) || 0;
  const n = parseNum(term);
  const day = Math.min(31, Math.max(1, parseNum(paymentDay) || 1));

  const monthly = p > 0 && n > 0 ? scheduledPayment(p, r, n, repayType) : 0;
  const canSave = name.trim().length > 0 && p > 0 && n > 0;

  /** Move the pad to a numeric field, tearing down the OS keyboard first. */
  const openField = (f: NumFieldKey) => {
    Keyboard.dismiss();
    setActiveField(f);
  };

  /** One handler for the single pad — routes each key to the active field. */
  const onKey = (k: string) => {
    if (activeField === 'principal') setPrincipal((a) => applyIntDigit(a, k, 10));
    else if (activeField === 'rate') setRate((a) => applyRateDigit(a, k));
    else if (activeField === 'term') setTerm((a) => applyIntDigit(a, k, 3));
    else if (activeField === 'day') setPaymentDay((a) => applyIntDigit(a, k, 2));
  };

  const submitting = useRef(false); // no duplicate loan on a double-tap

  const save = () => {
    if (submitting.current || !canSave) return;
    submitting.current = true;
    addLoan({
      name: name.trim(),
      lender: lender.trim(),
      principal: p,
      annualRate: r,
      termMonths: n,
      startDate,
      paymentDay: day,
      repayType,
    });
    toast.show('대출을 추가했어요');
    router.back();
  };

  return (
    <ModalScreen
      title="대출 추가"
      closeIcon="x"
      onClose={() => router.back()}
      right={<HeaderTextButton label="저장" onPress={save} disabled={!canSave} />}
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
        <Field label="원금">
          <NumFieldRow
            value={principal ? fmt(Number(principal)) : ''}
            suffix="원"
            active={activeField === 'principal'}
            onPress={() => openField('principal')}
          />
        </Field>
        <Field label="연이자율 (%)" hint="고정금리 기준으로 계산해요 · 예: 4.25">
          <NumFieldRow
            value={rate}
            suffix="%"
            active={activeField === 'rate'}
            onPress={() => openField('rate')}
          />
        </Field>
        <Field label="상환 방식">
          <SegmentedTabs
            value={repayType}
            onChange={setRepayType}
            options={[
              { value: 'amortizing', label: '원리금균등' },
              { value: 'bullet', label: '만기일시' },
            ]}
          />
        </Field>
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
        <Field label="첫 상환일">
          <DateStepper value={startDate} onChange={setStartDate} />
        </Field>
        <Field label="매월 상환일">
          <NumFieldRow
            value={paymentDay}
            suffix="일"
            active={activeField === 'day'}
            onPress={() => openField('day')}
          />
        </Field>

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
              예상
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 }}>
              <Text
                style={{ fontFamily: fontFamily.extrabold, fontSize: 24, color: colors.primaryStrong, ...tabularNums }}
              >
                {fmt(monthly)}
              </Text>
              <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.primaryStrong }}>
                원 / 월
              </Text>
            </View>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 11, color: colors.textSub, marginTop: 6 }}>
              {describeRepayType(repayType)}
              {repayType === 'bullet' ? ' · 매달 이자만, 원금은 만기 상환' : ''}
              {' · 만기 '}
              {formatYearMonth(payoffDate(startDate, n))}
            </Text>
          </View>
        )}
      </View>
    </ModalScreen>
  );
}

/**
 * Tap target that shows a numeric value + unit and opens the shared NumPad.
 * Same visual language as the amount fields in planned-add / goal-add
 * (lavender wash + hairline when active).
 */
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
