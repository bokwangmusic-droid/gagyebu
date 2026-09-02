import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import {
  ChipSelect,
  Field,
  HeaderTextButton,
  SegmentedTabs,
  TextField,
} from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { EXPENSE_CATS, INCOME_CATS, type TxnType } from '@/data/categories';
import { fmt, parseNum } from '@/lib/format';
import { useStore } from '@/store/store';
import { spacing } from '@/theme/tokens';
import type { Frequency } from '@/store/types';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export default function RecurringAdd() {
  const router = useRouter();
  const toast = useToast();
  const { addRecurring } = useStore();

  const [type, setType] = useState<TxnType>('expense');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('subscribe');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [dayOfWeek, setDayOfWeek] = useState('1');

  const cats = useMemo(() => (type === 'income' ? INCOME_CATS : EXPENSE_CATS), [type]);
  useEffect(() => {
    if (!cats.some((c) => c.id === category)) setCategory(cats[0].id);
  }, [cats, category]);

  const canSave = name.trim().length > 0 && parseNum(amount) > 0;

  const save = () => {
    if (!canSave) return;
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
            placeholder="예: 넷플릭스, 월세, 8월 급여"
            maxLength={30}
          />
        </Field>
        <Field label="금액">
          <TextField
            keyboardType="number-pad"
            value={amount ? fmt(Number(amount)) : ''}
            onChangeText={(t) => setAmount(String(parseNum(t)))}
            placeholder="0"
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
