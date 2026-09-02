import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { DateStepper } from '@/components/ui/DateStepper';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { fmt, parseNum, toDateKey } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

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
  const { addGoal } = useStore();

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [useDeadline, setUseDeadline] = useState(false);
  const [deadline, setDeadline] = useState(() =>
    toDateKey(new Date(Date.now() + 90 * 86_400_000)),
  );
  const [icon, setIcon] = useState('target');

  const canSave = name.trim().length > 0 && parseNum(target) > 0;

  const save = () => {
    if (!canSave) return;
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
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <Field label="이름">
          <TextField value={name} onChangeText={setName} placeholder="예: 제주도 여행" maxLength={20} />
        </Field>
        <Field label="목표 금액">
          <TextField
            keyboardType="number-pad"
            value={target ? fmt(Number(target)) : ''}
            onChangeText={(t) => setTarget(String(parseNum(t)))}
            placeholder="0"
          />
        </Field>
        <Field label="목표 날짜 (선택)">
          <Pressable
            onPress={() => setUseDeadline((v) => !v)}
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
                  onPress={() => setIcon(ic.id)}
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
