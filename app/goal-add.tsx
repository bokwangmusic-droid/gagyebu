import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

const ICONS: { id: string; label: string }[] = [
  { id: 'target', label: '기본' },
  { id: 'plane', label: '여행' },
  { id: 'shield', label: '비상금' },
  { id: 'laptop', label: '전자' },
  { id: 'heart', label: '선물' },
  { id: 'home', label: '집' },
];

export default function GoalAdd() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { addGoal } = useStore();

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [useDeadline, setUseDeadline] = useState(false);
  const [deadline, setDeadline] = useState(() =>
    toDateKey(new Date(Date.now() + 90 * 86_400_000)),
  );
  const [icon, setIcon] = useState('target');
  // 목표 금액은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)로 입력.
  const [padVisible, setPadVisible] = useState(false);

  const onKey = (k: string) => setTarget((a) => applyDigit(a, k));
  const openPad = () => {
    Keyboard.dismiss();
    setPadVisible(true);
  };

  const canSave = name.trim().length > 0 && parseNum(target) > 0;

  const submitting = useRef(false); // no duplicate goal on a double-tap

  const save = () => {
    if (submitting.current || !canSave) return;
    submitting.current = true;
    addGoal({
      name: name.trim(),
      target: parseNum(target),
      deadline: useDeadline ? deadline : null,
      icon,
    });
    toast.show('목표를 추가했어요');
    router.back();
  };

  return (
    <ModalScreen
      title="목표 추가"
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
        <Field label="이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setPadVisible(false)}
            placeholder="예: 제주도 여행"
            maxLength={20}
          />
        </Field>
        <Field label="목표 금액">
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
                color: target ? colors.text : padVisible ? colors.primaryStrong : colors.textMuted,
                ...tabularNums,
              }}
            >
              {target ? fmt(Number(target)) : '0'}
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
        <Field label="목표 날짜 (선택)">
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setUseDeadline((v) => !v);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingVertical: 10,
              paddingHorizontal: 14,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.md,
              marginBottom: useDeadline ? spacing.sm : 0,
            }}
          >
            <AppIcon
              name={useDeadline ? 'target' : 'plus'}
              size={16}
              color={useDeadline ? colors.primaryStrong : colors.textSub}
            />
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSub }}>
              {useDeadline ? '목표일 설정됨 · 탭하여 해제' : '목표일 추가하기'}
            </Text>
          </Pressable>
          {useDeadline && (
            <DateStepper value={deadline} onChange={setDeadline} min={toDateKey(new Date())} />
          )}
        </Field>
        <Field label="아이콘">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {ICONS.map((ic) => {
              const active = icon === ic.id;
              return (
                <Pressable
                  key={ic.id}
                  onPress={() => {
                    Keyboard.dismiss();
                    setIcon(ic.id);
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: radii.pill,
                    backgroundColor: active ? colors.primaryLight : colors.white,
                    borderWidth: 1,
                    borderColor: active ? colors.primary : colors.border,
                  }}
                >
                  <AppIcon name={ic.id} size={14} color={active ? colors.primaryStrong : colors.textSub} />
                  <Text
                    style={{
                      fontFamily: active ? fontFamily.semibold : fontFamily.regular,
                      fontSize: 12,
                      color: active ? colors.primaryStrong : colors.text,
                    }}
                  >
                    {ic.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>
      </View>
    </ModalScreen>
  );
}
