import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ChipSelect,
  Field,
  HeaderTextButton,
  SegmentedTabs,
  TextField,
} from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { EXPENSE_CATS, INCOME_CATS, type TxnType } from '@/data/categories';
import { fmt, parseNum } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';
import type { Frequency } from '@/store/types';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

export default function RecurringAdd() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { addRecurring } = useStore();

  const [type, setType] = useState<TxnType>('expense');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('subscribe');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  // 금액은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)로 입력.
  const [padVisible, setPadVisible] = useState(false);

  const cats = useMemo(() => (type === 'income' ? INCOME_CATS : EXPENSE_CATS), [type]);
  useEffect(() => {
    if (!cats.some((c) => c.id === category)) setCategory(cats[0].id);
  }, [cats, category]);

  const onKey = (k: string) => setAmount((a) => applyDigit(a, k));
  const openPad = () => {
    Keyboard.dismiss();
    setPadVisible(true);
  };

  const canSave = name.trim().length > 0 && parseNum(amount) > 0;

  // A double-tap here would create a duplicate rule (→ duplicate auto txns
  // every period), so latch after the first valid submit.
  const submitting = useRef(false);

  const save = () => {
    if (submitting.current || !canSave) return;
    submitting.current = true;
    addRecurring({
      type,
      name: name.trim(),
      amount: parseNum(amount),
      category,
      frequency,
      dayOfMonth:
        frequency === 'monthly'
          ? Math.min(31, Math.max(1, parseInt(dayOfMonth, 10) || 1))
          : undefined,
      dayOfWeek: frequency === 'weekly' ? parseInt(dayOfWeek, 10) : undefined,
    });
    toast.show('추가했어요');
    router.back();
  };

  return (
    <ModalScreen
      title="반복 항목 추가"
      closeIcon="x"
      onClose={() => router.back()}
      right={<HeaderTextButton label="저장" onPress={save} disabled={!canSave} />}
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
        <SegmentedTabs
          value={type}
          onChange={setType}
          options={[
            { value: 'expense', label: '지출', tone: 'expense' },
            { value: 'income', label: '수입', tone: 'income' },
          ]}
          style={{ marginBottom: spacing.lg }}
        />

        <Field label="이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setPadVisible(false)}
            placeholder="예: 넷플릭스, 월세, 8월 급여"
            maxLength={30}
          />
        </Field>
        <Field label="금액">
          <Pressable
            onPress={openPad}
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
        <Field label="카테고리">
          <ChipSelect
            value={category}
            onChange={setCategory}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="주기">
          <ChipSelect
            value={frequency}
            onChange={setFrequency}
            options={[
              { value: 'monthly', label: '매월' },
              { value: 'weekly', label: '매주' },
            ]}
          />
        </Field>
        {frequency === 'monthly' ? (
          <Field label="매월 며칠">
            <TextField
              keyboardType="number-pad"
              value={dayOfMonth}
              onChangeText={(t) => setDayOfMonth(t.replace(/[^0-9]/g, '').slice(0, 2))}
              onFocus={() => setPadVisible(false)}
              placeholder="1~31"
            />
          </Field>
        ) : (
          <Field label="매주 요일">
            <ChipSelect
              value={dayOfWeek}
              onChange={setDayOfWeek}
              options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            />
          </Field>
        )}
      </View>
    </ModalScreen>
  );
}
