import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReadOnlyRouteNotice } from '@/components/ReadOnlyRouteNotice';
import { Field, HeaderTextButton, TextField } from '@/components/ui/controls';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { CAT_COLOR_PALETTE } from '@/data/categories';
import { REMOTE_FINANCE_READ_ONLY } from '@/lib/financeMode';
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

/** NumPad key → day string. `clampDay` stays the single 1–31 validator, so
 *  stored values are exactly what the old text field produced. */
function applyDayKey(cur: string, k: string): string {
  if (k === 'back') return clampDay(cur.slice(0, -1));
  if (k === '00') return cur; // a day is 1–2 digits — ignore the "00" key
  return clampDay(cur + k);
}

export default function CardAdd() {
  // STEP 16-G1B: see app/input.tsx's identical guard comment.
  if (REMOTE_FINANCE_READ_ONLY) return <ReadOnlyRouteNotice title="카드" />;

  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ id?: string }>();
  const insets = useSafeAreaInsets();
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
  // 결제일·마감일은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)를 공유해서 입력.
  // (loan-add.tsx의 activeField 방식과 동일)
  const [activeField, setActiveField] = useState<'paymentDay' | 'closingDay' | null>(null);

  const openField = (f: 'paymentDay' | 'closingDay') => {
    Keyboard.dismiss();
    setActiveField(f);
  };
  const onKey = (k: string) => {
    if (activeField === 'paymentDay') setPaymentDay((d) => applyDayKey(d, k));
    else if (activeField === 'closingDay') setClosingDay((d) => applyDayKey(d, k));
  };

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
        <Field label="카드 이름">
          <TextField
            value={name}
            onChangeText={setName}
            onFocus={() => setActiveField(null)}
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
          <NumFieldRow
            value={paymentDay}
            suffix="일"
            placeholder="1~31"
            active={activeField === 'paymentDay'}
            onPress={() => openField('paymentDay')}
          />
        </Field>

        <Field label="마감일 (선택)" hint="이번 STEP에서는 표시만 하고 계산에는 쓰지 않아요">
          <NumFieldRow
            value={closingDay}
            suffix="일"
            placeholder="1~31"
            active={activeField === 'closingDay'}
            onPress={() => openField('closingDay')}
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

/**
 * Numeric tap-target that opens the shared NumPad. Both card day fields are
 * optional, so it shows a muted placeholder (not "0") when empty.
 */
function NumFieldRow({
  value,
  suffix,
  placeholder,
  active,
  onPress,
}: {
  value: string;
  suffix: string;
  placeholder: string;
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
          color: value ? colors.text : colors.textMuted,
        }}
      >
        {value || placeholder}
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
