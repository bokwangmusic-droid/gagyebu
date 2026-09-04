import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { ChipSelect, Field, HeaderTextButton } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { NumPad } from '@/components/ui/NumPad';
import { useToast } from '@/components/ui/Toast';
import { getAllCats, getCat } from '@/data/categories';
import { fmt, parseNum } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, noPad, tabularNums } from '@/theme/typography';

/** Digit-entry rules — identical to the main expense keypad (app/input.tsx). */
function applyDigit(amount: string, k: string): string {
  if (k === 'back') return amount.slice(0, -1);
  if (k === '00') return amount === '' || amount === '0' || amount.length >= 9 ? amount : amount + '00';
  if (k === '0') return amount === '' || amount === '0' || amount.length >= 10 ? amount : amount + '0';
  return amount.length >= 10 ? amount : (amount === '0' ? '' : amount) + k;
}

export default function BudgetAdd() {
  const router = useRouter();
  const toast = useToast();
  const { budgets, setBudget, customCats, catOrder } = useStore();

  const cats = getAllCats('expense', customCats, catOrder);

  /** Pending edits — the "cart". Committed to the store only on final save. */
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [category, setCategory] = useState(cats[0]?.id ?? 'food');
  const [amount, setAmount] = useState('');
  // 금액은 OS 숫자 키보드 대신 앱 전용 키패드(NumPad)로 입력.
  const [padVisible, setPadVisible] = useState(false);
  const insets = useSafeAreaInsets();

  const curCat = getCat(category, 'expense', customCats);

  /** Fold a category's typed amount into the cart (0 removes it). */
  const stash = (catId: string, raw: string) => {
    const n = parseNum(raw);
    setDraft((d) => {
      if (n > 0) return { ...d, [catId]: n };
      const { [catId]: _drop, ...rest } = d;
      return rest;
    });
  };

  const pick = (next: string) => {
    stash(category, amount); // keep the current one before switching away
    setCategory(next);
    setAmount(draft[next] ? String(draft[next]) : '');
  };

  const openPad = () => {
    Keyboard.dismiss();
    setPadVisible(true);
  };

  const onKey = (k: string) => setAmount((a) => applyDigit(a, k));

  // Keep the cart row for the active category in sync with the field as you
  // type — same effect the old text field's `onChangeText` had, but driven off
  // the state so it can't miss a fast keypress.
  useEffect(() => {
    stash(category, amount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  /** Tap a cart row → jump the editor to that category and open the keypad. */
  const editItem = (catId: string) => {
    if (catId !== category) {
      stash(category, amount);
      setCategory(catId);
      setAmount(draft[catId] ? String(draft[catId]) : '');
    }
    openPad();
  };

  const removeFromCart = (catId: string) => {
    setDraft((d) => {
      const { [catId]: _drop, ...rest } = d;
      return rest;
    });
    if (catId === category) setAmount('');
  };

  // merge the not-yet-stashed field so the current row always shows in the cart
  const pending: Record<string, number> = {
    ...draft,
    ...(parseNum(amount) > 0 ? { [category]: parseNum(amount) } : {}),
  };
  const entries = Object.entries(pending);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const canSave = entries.length > 0;

  // No duplicate save / double router.back() on a fast double-tap.
  const submitting = useRef(false);

  const save = () => {
    if (submitting.current || !canSave) return;
    submitting.current = true;
    entries.forEach(([catId, v]) => setBudget(catId, v));
    toast.show(`예산 ${entries.length}개를 저장했어요`);
    router.back();
  };

  return (
    <ModalScreen
      title="예산 설정"
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
        <Field label="카테고리" hint="여러 개를 담고 마지막에 한 번만 저장하면 돼요">
          <ChipSelect
            value={category}
            onChange={pick}
            options={cats.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>

        <Field
          label={`월 예산 · ${curCat.name}`}
          hint={
            budgets[category] && !draft[category]
              ? `지금 저장된 값 ${fmt(budgets[category])}원`
              : '한 달 동안 이 카테고리에 얼마까지 쓸지 정해두세요'
          }
        >
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
              {amount ? fmt(Number(amount)) : budgets[category] ? fmt(budgets[category]) : '0'}
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

        {entries.length > 0 && (
          <View style={{ marginTop: spacing.xs }}>
            <Text
              style={{
                fontFamily: fontFamily.bold,
                fontSize: 11,
                letterSpacing: 0.2,
                color: colors.textSub,
                marginBottom: 8,
                ...noPad,
              }}
            >
              담은 예산 {entries.length}개
            </Text>

            <View style={{ gap: 8 }}>
              {entries.map(([catId, v]) => {
                const c = getCat(catId, 'expense', customCats);
                const isCurrent = catId === category;
                return (
                  <Pressable
                    key={catId}
                    onPress={() => editItem(catId)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      backgroundColor: isCurrent ? colors.primaryLight : colors.white,
                      borderWidth: 1,
                      borderColor: isCurrent ? colors.primary : colors.border,
                      borderRadius: radii.md,
                    }}
                  >
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        backgroundColor: c.bg,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <AppIcon name={c.icon} size={15} color={c.color} />
                    </View>
                    <Text
                      style={{ flex: 1, fontFamily: fontFamily.semibold, fontSize: 13, color: colors.text, ...noPad }}
                    >
                      {c.name}
                    </Text>
                    <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.text, ...tabularNums }}>
                      {fmt(v)}원
                    </Text>
                    <AppIcon name="chev-right" size={15} color={colors.textFaint} />
                    <Pressable
                      onPress={() => removeFromCart(catId)}
                      hitSlop={8}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: radii.sm,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <AppIcon name="x" size={14} color={colors.textFaint} />
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 12,
                marginBottom: spacing.md,
              }}
            >
              <Text style={{ fontFamily: fontFamily.semibold, fontSize: 12, color: colors.textSub }}>합계</Text>
              <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 16, color: colors.text, ...tabularNums }}>
                {fmt(total)}원
              </Text>
            </View>

            <GradientButton label={`예산 ${entries.length}개 저장`} onPress={save} disabled={!canSave} />
          </View>
        )}
      </View>
    </ModalScreen>
  );
}
