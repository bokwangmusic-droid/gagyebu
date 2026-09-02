import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ChipSelect, Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { getAllCats } from '@/data/categories';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { useStore } from '@/store/store';
import { spacing } from '@/theme/tokens';

export default function PlannedAdd() {
  const router = useRouter();
  const toast = useToast();
  const { addPlanned, customCats, catOrder } = useStore();

  const cats = getAllCats('expense', customCats, catOrder);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('gift');
  const [date, setDate] = useState(() => toDateKey(new Date(Date.now() + 7 * 86_400_000)));
  const [memo, setMemo] = useState('');

  const canSave = name.trim().length > 0 && parseNum(amount) > 0;

  const save = () => {
    if (!canSave) return;
    addPlanned({
      name: name.trim(),
      amount: parseNum(amount),
      category,
      date,
      memo: memo.trim(),
      type: 'expense',
    });
    toast.show('예정 지출을 추가했어요');
    router.back();
  };

  return (
    <ModalScreen
      title="예정 지출 추가"
      closeIcon="x"
      onClose={() => router.back()}
      right={<HeaderTextButton label="저장" onPress={save} disabled={!canSave} />}
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <Field label="무엇에 쓸 예정인가요?">
          <TextField
            value={name}
            onChangeText={setName}
            placeholder="예: 결혼식 축의금, 부모님 생신 선물"
            maxLength={30}
          />
        </Field>
        <Field label="예상 금액">
          <TextField
            keyboardType="number-pad"
            value={amount ? fmt(Number(amount)) : ''}
            onChangeText={(t) => setAmount(String(parseNum(t)))}
            placeholder="0"
          />
        </Field>
        <Field label="예정 날짜" hint="이 날짜가 되면 홈에서 알려드려요">
          <DateStepper value={date} onChange={setDate} />
        </Field>
        <Field label="카테고리">
          <ChipSelect
            value={category}
            onChange={setCategory}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="메모 (선택)">
          <TextField
            value={memo}
            onChangeText={setMemo}
            placeholder="예: 고등학교 친구 결혼식"
            maxLength={40}
          />
        </Field>
      </View>
    </ModalScreen>
  );
}
