import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { ChipSelect, Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { getAllCats } from '@/data/categories';
import { fmt, parseNum } from '@/lib/format';
import { useStore } from '@/store/store';
import { spacing } from '@/theme/tokens';

export default function BudgetAdd() {
  const router = useRouter();
  const toast = useToast();
  const { budgets, setBudget, customCats, catOrder } = useStore();

  const cats = getAllCats('expense', customCats, catOrder);
  const [category, setCategory] = useState('food');
  const [amount, setAmount] = useState(() =>
    budgets['food'] ? String(budgets['food']) : '',
  );

  useEffect(() => {
    setAmount(budgets[category] ? String(budgets[category]) : '');
  }, [category, budgets]);

  const canSave = parseNum(amount) > 0;

  const save = () => {
    if (!canSave) return;
    setBudget(category, parseNum(amount));
    toast.show('예산을 저장했어요');
    router.back();
  };

  return (
    <ModalScreen
      title="예산 설정"
      closeIcon="x"
      onClose={() => router.back()}
      right={<HeaderTextButton label="저장" onPress={save} disabled={!canSave} />}
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <Field label="카테고리">
          <ChipSelect
            value={category}
            onChange={setCategory}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>

        <Field label="월 예산" hint="한 달 동안 이 카테고리에 얼마까지 쓸지 정해두세요">
          <TextField
            keyboardType="number-pad"
            value={amount ? fmt(Number(amount)) : ''}
            onChangeText={(t) => setAmount(String(parseNum(t)))}
            placeholder="0"
          />
        </Field>
      </View>
    </ModalScreen>
  );
}
