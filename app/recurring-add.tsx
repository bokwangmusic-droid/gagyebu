import { useLocalSearchParams, useRouter } from 'expo-router';
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

/**
 * Day-of-month entry for the 매월 며칠 field: 1–2 digits, no leading zero.
 * The 1–31 clamp still happens only at save (`save()` below is unchanged), so
 * this only affects what you can type, not what gets stored.
 */
function applyDayDigit(cur: string, k: string): string {
  if (k === 'back') return cur.slice(0, -1);
  if (k === '00') return cur; // single day value — ignore the "00" key
  return cur.length >= 2 ? cur : (cur === '0' ? '' : cur) + k;
}

export default function RecurringAdd() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { addRecurring } = useStore();

  // 반복 목록에서 넘어온 현재 탭 타입을 신규 추가의 기본값으로만 사용.
  // (param이 없으면 기존 기본값 expense 유지. 사용자는 화면 안에서 자유롭게 전환 가능.)
  const params = useLocalSearchParams<{ type?: string }>();
  const [type, setType] = useState<TxnType>(params.type === 'income' ? 'income' : 'expense');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('subscribe');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  // 금액·매월 며칠은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)를 공유해서 입력.
  // (loan-add.tsx의 activeField 방식과 동일 — 하나의 NumPad를 전환하며 사용)
  const [activeField, setActiveField] = useState<'amount' | 'day' | null>(null);

  const cats = useMemo(() => (type === 'income' ? INCOME_CATS : EXPENSE_CATS), [type]);
  useEffect(() => {
    if (!cats.some((c) => c.id === category)) setCategory(cats[0].id);
  }, [cats, category]);

  const onKey = (k: string) => {
    if (activeField === 'amount') setAmount((a) => applyDigit(a, k));
    else if (activeField === 'day') setDayOfMonth((d) => applyDayDigit(d, k));
  };
  const openField = (f: 'amount' | 'day') => {
    Keyboard.dismiss();
    setActiveField(f);
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
        activeField ? (
          <NumPad
            style={{ paddingBottom: insets.bottom + 16 }}
            onKey={onKey}
            onBackspace={() => onKey('back')}
            onDone={() => setActiveField(null)}
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
            onFocus={() => setActiveField(null)}
            placeholder="예: 넷플릭스, 월세, 8월 급여"
            maxLength={30}
          />
        </Field>
        <Field label="금액">
          <NumFieldRow
            value={amount ? fmt(Number(amount)) : ''}
            suffix="원"
            active={activeField === 'amount'}
            onPress={() => openField('amount')}
          />
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
            onChange={(f) => {
              // '매주'로 바꾸면 '매월 며칠' 필드가 사라지므로 그 필드에 붙어
              // 있던 키패드도 닫는다.
              if (f === 'weekly' && activeField === 'day') setActiveField(null);
              setFrequency(f);
            }}
            options={[
              { value: 'monthly', label: '매월' },
              { value: 'weekly', label: '매주' },
            ]}
          />
        </Field>
        {frequency === 'monthly' ? (
          <Field label="매월 며칠" hint="1~31 사이로 정해요">
            <NumFieldRow
              value={dayOfMonth}
              suffix="일"
              active={activeField === 'day'}
              onPress={() => openField('day')}
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

/**
 * Numeric tap-target that opens the shared NumPad — same visual language as
 * loan-add.tsx / planned-add.tsx (lavender wash + hairline when active).
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
