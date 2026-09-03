import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChipSelect, Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { getAllCats } from '@/data/categories';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

export default function PlannedAdd() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { addPlanned, customCats, catOrder } = useStore();

  const cats = getAllCats('expense', customCats, catOrder);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('gift');
  const [date, setDate] = useState(() => toDateKey(new Date(Date.now() + 7 * 86_400_000)));
  const [memo, setMemo] = useState('');
  // The amount uses the app's custom keypad (same as app/input.tsx), not the OS
  // number keyboard. Closed by default so the "무엇에" field is reachable first.
  const [padVisible, setPadVisible] = useState(false);

  const canSave = name.trim().length > 0 && parseNum(amount) > 0;

  // Digit-entry rules copied verbatim from the main expense keypad so the two
  // feel identical (10-digit cap, no leading zero, 00 shortcut).
  const onKey = (k: string) => {
    if (k === 'back') {
      setAmount((a) => a.slice(0, -1));
      return;
    }
    if (k === '00') {
      setAmount((a) => (a === '' || a === '0' || a.length >= 9 ? a : a + '00'));
      return;
    }
    if (k === '0') {
      setAmount((a) => (a === '' || a === '0' || a.length >= 10 ? a : a + '0'));
      return;
    }
    setAmount((a) => (a.length >= 10 ? a : (a === '0' ? '' : a) + k));
  };

  const openPad = () => {
    Keyboard.dismiss(); // tear down the OS keyboard from a text field first
    setPadVisible(true);
  };

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
        <Field label="무엇에 쓸 예정인가요?">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setPadVisible(false)}
            placeholder="예: 결혼식 축의금, 부모님 생신 선물"
            maxLength={30}
          />
        </Field>
        <Field label="예상 금액">
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
                color: amount
                  ? colors.text
                  : padVisible
                    ? colors.primaryStrong
                    : colors.textMuted,
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
            onFocus={() => setPadVisible(false)}
            placeholder="예: 고등학교 친구 결혼식"
            maxLength={40}
          />
        </Field>
      </View>
    </ModalScreen>
  );
}
