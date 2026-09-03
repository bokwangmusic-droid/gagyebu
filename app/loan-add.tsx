import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { ChipSelect, Field, HeaderTextButton, SegmentedTabs, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { describeRepayType, formatYearMonth, payoffDate, scheduledPayment } from '@/lib/loan';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';
import type { LoanRepayType } from '@/store/types';

const TERM_PRESETS = ['12', '24', '36', '60', '120'];

export default function LoanAdd() {
  const router = useRouter();
  const toast = useToast();
  const { addLoan } = useStore();

  const [name, setName] = useState('');
  const [lender, setLender] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [term, setTerm] = useState('36');
  const [startDate, setStartDate] = useState(() => toDateKey(new Date()));
  const [paymentDay, setPaymentDay] = useState('25');
  const [repayType, setRepayType] = useState<LoanRepayType>('amortizing');

  const p = parseNum(principal);
  const r = parseFloat(rate) || 0;
  const n = parseNum(term);
  const day = Math.min(31, Math.max(1, parseNum(paymentDay) || 1));

  const monthly = p > 0 && n > 0 ? scheduledPayment(p, r, n, repayType) : 0;
  const canSave = name.trim().length > 0 && p > 0 && n > 0;

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
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <Field label="대출 이름">
          <TextField
            value={name}
            onChangeText={setName}
            placeholder="예: 전세자금대출, 자동차 할부"
            maxLength={30}
          />
        </Field>
        <Field label="대출 기관 (선택)">
          <TextField value={lender} onChangeText={setLender} placeholder="예: 국민은행" maxLength={20} />
        </Field>
        <Field label="원금">
          <TextField
            keyboardType="number-pad"
            value={principal ? fmt(Number(principal)) : ''}
            onChangeText={(t) => setPrincipal(String(parseNum(t)))}
            placeholder="0"
          />
        </Field>
        <Field label="연이자율 (%)" hint="고정금리 기준으로 계산해요">
          <TextField
            keyboardType="decimal-pad"
            value={rate}
            onChangeText={(t) => setRate(t.replace(/[^0-9.]/g, '').slice(0, 6))}
            placeholder="예: 4.5"
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
          <TextField
            keyboardType="number-pad"
            value={term}
            onChangeText={(t) => setTerm(t.replace(/[^0-9]/g, '').slice(0, 3))}
            placeholder="개월 수"
            style={{ marginBottom: spacing.sm }}
          />
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
          <TextField
            keyboardType="number-pad"
            value={paymentDay}
            onChangeText={(t) => setPaymentDay(t.replace(/[^0-9]/g, '').slice(0, 2))}
            placeholder="1~31"
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
