import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { useToast } from '@/components/ui/Toast';
import { CAT_COLOR_PALETTE } from '@/data/categories';
import { parseNum } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

/** Clamp a day-of-month string to 1–31; '' when empty. */
function clampDay(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '').slice(0, 2);
  if (digits === '') return '';
  return String(Math.min(31, Math.max(1, parseNum(digits))));
}

export default function CardAdd() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ id?: string }>();
  const { cards, addCard, updateCard } = useStore();

  const editing = params.id ? cards.find((c) => c.id === params.id) ?? null : null;
  const isEdit = !!editing;

  const [name, setName] = useState(editing?.name ?? '');
  const [colorIdx, setColorIdx] = useState(() => {
    if (!editing?.color) return 0;
    const i = CAT_COLOR_PALETTE.findIndex(
      (p) => p.bg === editing.color!.bg && p.color === editing.color!.color,
    );
    return i < 0 ? 0 : i;
  });
  const [paymentDay, setPaymentDay] = useState(
    editing?.paymentDay ? String(editing.paymentDay) : '',
  );
  const [closingDay, setClosingDay] = useState(
    editing?.closingDay ? String(editing.closingDay) : '',
  );

  const canSave = name.trim().length > 0;

  const submitting = useRef(false); // no duplicate card on a double-tap

  const save = () => {
    if (submitting.current || !canSave) return;
    submitting.current = true;
    const payload = {
      name: name.trim(),
      color: { ...CAT_COLOR_PALETTE[colorIdx] },
      paymentDay: paymentDay ? parseNum(paymentDay) : undefined,
      closingDay: closingDay ? parseNum(closingDay) : undefined,
    };
    if (editing) updateCard(editing.id, payload);
    else addCard(payload);
    toast.show(isEdit ? '카드를 수정했어요' : '카드를 등록했어요');
    router.back();
  };

  return (
    <ModalScreen
      title={isEdit ? '카드 수정' : '카드 등록'}
      closeIcon="x"
      onClose={() => router.back()}
      right={<HeaderTextButton label="저장" onPress={save} disabled={!canSave} />}
    >
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xs }}>
        <Field label="카드 이름">
          <TextField
            value={name}
            onChangeText={setName}
            placeholder="예: 현대카드, 삼성카드"
            maxLength={20}
            autoFocus={!isEdit}
          />
        </Field>

        <Field label="색상 (선택)">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {CAT_COLOR_PALETTE.map((p, i) => {
              const active = i === colorIdx;
              return (
                <Pressable
                  key={p.color}
                  onPress={() => setColorIdx(i)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: radii.pill,
                    backgroundColor: p.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: active ? 2 : 1,
                    borderColor: active ? p.color : colors.border,
                  }}
                >
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: radii.pill,
                      backgroundColor: p.color,
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
        </Field>

        <Field label="결제일 (선택)" hint="매월 카드값이 빠져나가는 날 · 표시용">
          <TextField
            keyboardType="number-pad"
            value={paymentDay}
            onChangeText={(t) => setPaymentDay(clampDay(t))}
            placeholder="1~31"
          />
        </Field>

        <Field label="마감일 (선택)" hint="이번 STEP에서는 표시만 하고 계산에는 쓰지 않아요">
          <TextField
            keyboardType="number-pad"
            value={closingDay}
            onChangeText={(t) => setClosingDay(clampDay(t))}
            placeholder="1~31"
          />
        </Field>

        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 11,
            lineHeight: 17,
            color: colors.textMuted,
            marginTop: spacing.xs,
            marginBottom: spacing.xxl,
          }}
        >
          예상 카드값은 카드사 실제 청구일이 아니라 「사용월」 기준으로 계산해요.
          실제 청구서 금액과 다를 수 있어요.
        </Text>
      </View>
    </ModalScreen>
  );
}
