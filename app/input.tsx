import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { CalendarSheet } from '@/components/ui/CalendarSheet';
import { getAllCats, getCat, type TxnType } from '@/data/categories';
import { fmt, parseNum, toDateKey, weekdayKo } from '@/lib/format';
import { parseCardMessage, type ParsedCardMessage } from '@/lib/parseCardMessage';
import { useStore } from '@/store/store';
import { colors, gradients, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

/* ------------------------------------------------------------------ *
 * 지출·수입 입력 — custom keypad, category picker, card-SMS auto-fill.
 * Ported from the web InputModal.
 * ------------------------------------------------------------------ */

const KEY_HEIGHT = 52;
const KEY_GAP = 6;

/** YYYY-MM-DD shifted by n days. */
function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return toDateKey(new Date(y, m - 1, d + days));
}

/** "오늘 · 9/1" / "어제 · 8/31" / "8/29 (금)" */
function dateLabel(key: string): string {
  const today = toDateKey(new Date());
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const md = `${m}/${d}`;
  if (key === today) return `오늘 · ${md}`;
  if (key === shiftDateKey(today, -1)) return `어제 · ${md}`;
  if (key === shiftDateKey(today, -2)) return `그저께 · ${md}`;
  return `${md} (${weekdayKo(dt)})`;
}

export default function InputModal() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const {
    transactions,
    addTransaction,
    updateTransaction,
    deleteTransaction,
    customCats,
    catOrder,
  } = useStore();

  const editing = params.id ? transactions.find((t) => t.id === params.id) ?? null : null;
  const isEdit = !!editing;
  const saveLabel = isEdit ? '수정하기' : '저장하기';

  const [type, setType] = useState<TxnType>(editing?.type ?? 'expense');
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  const [category, setCategory] = useState(editing?.category ?? 'food');
  const [memo, setMemo] = useState(editing?.memo ?? '');
  const [selectedDate, setSelectedDate] = useState(() => toDateKey(editing?.date ?? new Date()));
  const [padVisible, setPadVisible] = useState(true);

  const [showDate, setShowDate] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pastePreview, setPastePreview] = useState<ParsedCardMessage | null>(null);

  const cats = useMemo(
    () => getAllCats(type, customCats, catOrder),
    [type, customCats, catOrder],
  );

  // Keep the selected category valid when the type flips.
  useEffect(() => {
    if (!cats.some((c) => c.id === category)) setCategory(cats[0]?.id ?? 'food');
  }, [cats, category]);

  // Live preview while the user pastes a card message.
  useEffect(() => {
    if (!pasteText.trim()) {
      setPastePreview(null);
      return;
    }
    setPastePreview(parseCardMessage(pasteText));
  }, [pasteText]);

  const displayAmount = amount ? fmt(Number(amount)) : '0';
  const canSave = parseNum(amount) > 0;
  const today = toDateKey(new Date());

  const tap = () => {
    void Haptics.selectionAsync().catch(() => {});
  };

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

  const save = () => {
    if (!canSave) return;
    let dateISO: string;
    if (editing && toDateKey(editing.date) === selectedDate) {
      dateISO = editing.date; // date unchanged — keep original time of day
    } else {
      const now = new Date();
      const [y, m, d] = selectedDate.split('-').map(Number);
      dateISO = new Date(
        y,
        m - 1,
        d,
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
      ).toISOString();
    }
    const payload = {
      type,
      category,
      amount: parseNum(amount),
      memo: memo.trim(),
      date: dateISO,
    };
    if (editing) updateTransaction(editing.id, payload);
    else addTransaction(payload);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {},
    );
    router.back();
  };

  const remove = () => {
    if (!editing) return;
    Alert.alert('이 내역을 삭제할까요?', undefined, [
      { text: '취소', style: 'cancel' },
      {
        text: '삭제',
        style: 'destructive',
        onPress: () => {
          deleteTransaction(editing.id);
          router.back();
        },
      },
    ]);
  };

  const openPaste = async () => {
    setShowPaste(true);
    setPasteText('');
    setPastePreview(null);
    try {
      const t = await Clipboard.getStringAsync();
      if (t && t.trim()) setPasteText(t);
    } catch {
      /* clipboard unavailable — user pastes manually */
    }
  };

  const applyPaste = () => {
    if (!pastePreview || pastePreview.amount === 0) {
      Alert.alert('금액을 못 찾았어요', '붙여넣은 내용을 다시 확인해 주세요.');
      return;
    }
    setAmount(String(pastePreview.amount));
    if (pastePreview.merchant) setMemo(pastePreview.merchant);
    setType(pastePreview.type);
    if (pastePreview.category) {
      const c = pastePreview.category;
      setTimeout(() => setCategory(c), 0);
    }
    setShowPaste(false);
    setPasteText('');
    setPastePreview(null);
  };

  const amountColor =
    amount === ''
      ? colors.textMuted
      : type === 'expense'
        ? colors.expenseText
        : colors.incomeStrong;

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      {/* Header: close · date pill */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconBtn}>
          <AppIcon name="x" size={22} color={colors.text} />
        </Pressable>

        <Pressable onPress={() => setShowDate(true)} style={styles.datePill}>
          <AppIcon name="calendar" size={14} color={colors.primaryStrong} />
          <Text style={styles.datePillText}>{dateLabel(selectedDate)}</Text>
          <AppIcon name="chevron" size={12} color={colors.textMuted} />
        </Pressable>

        {isEdit ? (
          <Pressable onPress={remove} hitSlop={10} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>삭제</Text>
          </Pressable>
        ) : (
          <View style={{ width: 30 }} />
        )}
      </View>

      {/* Type tabs */}
      <View style={styles.typeTabs}>
        {(['expense', 'income'] as const).map((t) => {
          const active = type === t;
          return (
            <Pressable
              key={t}
              onPress={() => {
                tap();
                setType(t);
              }}
              style={[styles.typeTab, active && styles.typeTabActive]}
            >
              <Text
                style={{
                  fontFamily: active ? fontFamily.bold : fontFamily.semibold,
                  fontSize: 13,
                  color: active
                    ? t === 'expense'
                      ? colors.expenseText
                      : colors.incomeStrong
                    : colors.textSub,
                }}
              >
                {t === 'expense' ? '지출' : '수입'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Card-SMS auto-fill pill */}
      <View style={{ alignItems: 'center', marginTop: 10 }}>
        <Pressable onPress={openPaste} style={styles.pastePill}>
          <AppIcon name="clipboard" size={13} color={colors.primaryStrong} />
          <Text style={styles.pastePillText}>카드 문자에서 자동 입력</Text>
        </Pressable>
      </View>

      {/* Flexible middle: amount · memo · categories */}
      <View style={styles.middle}>
        <Pressable
          style={styles.amountRow}
          onPress={() => setPadVisible(true)}
        >
          <Text style={[styles.amount, { color: amountColor }]}>
            {amount === ''
              ? '0'
              : `${type === 'expense' ? '− ' : '+ '}${displayAmount}`}
          </Text>
          <Text style={styles.unit}>원</Text>
        </Pressable>

        <View style={styles.memoRow}>
          <AppIcon name="edit" size={16} color={colors.textMuted} />
          <TextInput
            value={memo}
            onChangeText={setMemo}
            onFocus={() => setPadVisible(false)}
            placeholder="메모 (선택)"
            placeholderTextColor={colors.textMuted}
            maxLength={40}
            style={styles.memoInput}
          />
        </View>

        <Text style={styles.catLabel}>카테고리</Text>
        <ScrollView
          horizontal
          style={styles.catScroll}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.catPicker}
        >
          {cats.map((c) => {
            const active = category === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => {
                  tap();
                  setCategory(c.id);
                }}
                style={[styles.catPick, active && styles.catPickActive]}
              >
                <View
                  style={[
                    styles.catPickIcon,
                    { backgroundColor: active ? colors.primary : c.bg },
                  ]}
                >
                  <AppIcon
                    name={c.icon}
                    size={16}
                    color={active ? colors.white : c.color}
                    strokeWidth={2.2}
                  />
                </View>
                <Text
                  style={{
                    fontFamily: active ? fontFamily.bold : fontFamily.medium,
                    fontSize: 10,
                    color: active ? colors.primaryStrong : colors.text,
                  }}
                >
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Keypad / collapsed bar */}
      {padVisible ? (
        <View style={[styles.numPad, { paddingBottom: insets.bottom + 16 }]}>
          <View style={{ flexDirection: 'row', gap: KEY_GAP }}>
            {/* digit block */}
            <View style={{ flex: 3, gap: KEY_GAP }}>
              {[
                ['1', '2', '3'],
                ['4', '5', '6'],
                ['7', '8', '9'],
              ].map((row) => (
                <View key={row[0]} style={{ flexDirection: 'row', gap: KEY_GAP }}>
                  {row.map((n) => (
                    <NumKey key={n} label={n} onPress={() => onKey(n)} />
                  ))}
                </View>
              ))}
              <View style={{ flexDirection: 'row', gap: KEY_GAP }}>
                <NumKey label="00" ghost onPress={() => onKey('00')} />
                <NumKey label="0" onPress={() => onKey('0')} />
                <View style={{ flex: 1 }} />
              </View>
            </View>

            {/* backspace + 완료 */}
            <View style={{ flex: 1, gap: KEY_GAP }}>
              <Pressable
                onPress={() => onKey('back')}
                style={({ pressed }) => [
                  styles.key,
                  { height: KEY_HEIGHT },
                  pressed && styles.keyPressed,
                ]}
              >
                <AppIcon name="backspace" size={22} color={colors.textSub} />
              </Pressable>
              <Pressable
                onPress={() => setPadVisible(false)}
                style={{ flex: 1, borderRadius: radii.lg, overflow: 'hidden' }}
              >
                <LinearGradient
                  colors={gradients.primary}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.doneKey}
                >
                  <AppIcon name="down" size={18} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.doneKeyText}>완료</Text>
                </LinearGradient>
              </Pressable>
            </View>
          </View>

          <Pressable
            onPress={save}
            disabled={!canSave}
            style={({ pressed }) => [
              styles.saveBtn,
              { opacity: !canSave ? 0.4 : pressed ? 0.92 : 1, marginTop: 10 },
            ]}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.saveBtnFill}
            >
              <Text style={styles.saveBtnText}>{saveLabel}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.collapsedBar,
            { paddingBottom: insets.bottom + 12 },
          ]}
        >
          <Pressable onPress={() => setPadVisible(true)} style={styles.reopenBtn}>
            <AppIcon name="chev-up" size={20} color={colors.textSub} />
          </Pressable>
          <Pressable
            onPress={save}
            disabled={!canSave}
            style={({ pressed }) => [
              styles.saveBtn,
              { flex: 1, opacity: !canSave ? 0.4 : pressed ? 0.92 : 1 },
            ]}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.saveBtnFill}
            >
              <Text style={styles.saveBtnText}>{saveLabel}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      )}

      {/* Date sheet */}
      <CalendarSheet
        visible={showDate}
        value={selectedDate}
        maxDate={today}
        onSelect={setSelectedDate}
        onClose={() => setShowDate(false)}
      />

      {/* Paste sheet */}
      {showPaste && (
        <Pressable style={styles.backdrop} onPress={() => setShowPaste(false)}>
          <KeyboardAvoidingView behavior="padding" style={{ width: '100%' }}>
            <Pressable
              style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}
              onPress={(e) => e.stopPropagation()}
            >
              <View style={styles.sheetHead}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AppIcon name="clipboard" size={16} color={colors.primaryStrong} />
                  <Text style={styles.sheetTitle}>카드 문자 붙여넣기</Text>
                </View>
                <Pressable onPress={() => setShowPaste(false)} hitSlop={10}>
                  <AppIcon name="x" size={18} color={colors.textSub} />
                </Pressable>
              </View>

              <View style={styles.hintBox}>
                <Text style={styles.hintText}>
                  아래 칸을 눌러 복사해 둔 카드 승인 문자를 붙여넣어 주세요.
                </Text>
              </View>

              <TextInput
                value={pasteText}
                onChangeText={setPasteText}
                multiline
                autoFocus
                placeholder="여기에 카드 문자를 붙여넣기…"
                placeholderTextColor={colors.textMuted}
                style={styles.pasteInput}
              />

              <Pressable
                onPress={async () => {
                  try {
                    const t = await Clipboard.getStringAsync();
                    if (t && t.trim()) {
                      setPasteText(t);
                      return;
                    }
                    throw new Error('empty');
                  } catch {
                    Alert.alert(
                      '자동 붙여넣기를 못 했어요',
                      '위 칸을 길게 눌러 "붙여넣기"를 선택해 주세요.',
                    );
                  }
                }}
                style={styles.pasteTryBtn}
              >
                <AppIcon name="clipboard" size={13} color={colors.primaryStrong} />
                <Text style={styles.pasteTryText}>클립보드에서 가져오기</Text>
              </Pressable>

              {pastePreview && pastePreview.amount > 0 && (
                <View style={styles.previewCard}>
                  <Text style={styles.previewEyebrow}>이렇게 채울게요</Text>
                  <PreviewRow
                    k="유형"
                    v={pastePreview.type === 'income' ? '수입' : '지출'}
                    color={
                      pastePreview.type === 'income'
                        ? colors.incomeStrong
                        : colors.expenseText
                    }
                  />
                  <PreviewRow k="금액" v={`${fmt(pastePreview.amount)}원`} />
                  {!!pastePreview.merchant && (
                    <PreviewRow k="메모" v={pastePreview.merchant} />
                  )}
                  {!!pastePreview.category && (
                    <PreviewRow
                      k="카테고리"
                      v={getCat(pastePreview.category, pastePreview.type, customCats).name}
                    />
                  )}
                </View>
              )}
              {pastePreview &&
                pastePreview.amount === 0 &&
                pasteText.trim().length > 5 && (
                  <View style={styles.previewWarn}>
                    <Text style={styles.previewWarnText}>
                      금액을 못 찾았어요. "12,500원"처럼 원 단위 금액이 들어간 문자를
                      붙여넣어 주세요.
                    </Text>
                  </View>
                )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                <Pressable
                  onPress={() => setShowPaste(false)}
                  style={[styles.sheetSecondary, { flex: 1 }]}
                >
                  <Text style={styles.sheetSecondaryText}>취소</Text>
                </Pressable>
                <Pressable
                  onPress={applyPaste}
                  disabled={!pastePreview || pastePreview.amount === 0}
                  style={[
                    styles.sheetCta,
                    { flex: 2 },
                    (!pastePreview || pastePreview.amount === 0) && { opacity: 0.4 },
                  ]}
                >
                  <LinearGradient
                    colors={gradients.primary}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.sheetCtaFill}
                  >
                    <Text style={styles.saveBtnText}>이대로 채우기</Text>
                  </LinearGradient>
                </Pressable>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      )}
    </View>
  );
}

function NumKey({
  label,
  ghost,
  onPress,
}: {
  label: string;
  ghost?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        { flex: 1, height: KEY_HEIGHT },
        ghost && styles.keyGhost,
        pressed && !ghost && styles.keyPressed,
        pressed && ghost && { opacity: 0.5 },
      ]}
    >
      <Text
        style={{
          fontFamily: fontFamily.semibold,
          fontSize: ghost ? 20 : 22,
          color: ghost ? colors.textSub : colors.text,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function PreviewRow({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewKey}>{k}</Text>
      <Text style={[styles.previewVal, color ? { color } : null]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  iconBtn: { padding: 4 },
  datePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  datePillText: {
    fontFamily: fontFamily.semibold,
    fontSize: 13,
    color: colors.text,
  },

  typeTabs: {
    flexDirection: 'row',
    gap: 4,
    marginHorizontal: spacing.xl,
    marginTop: spacing.sm,
    padding: 4,
    backgroundColor: colors.border,
    borderRadius: radii.md,
  },
  typeTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 9,
  },
  typeTabActive: {
    backgroundColor: colors.white,
  },

  pastePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.primaryLight,
    borderRadius: radii.pill,
  },
  pastePillText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: colors.primaryStrong,
  },

  middle: { flex: 1, justifyContent: 'flex-start', paddingTop: spacing.xs },

  amountRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'baseline',
    paddingHorizontal: spacing.xxl,
    paddingTop: 22,
    paddingBottom: spacing.sm,
  },
  amount: {
    fontFamily: fontFamily.extrabold,
    fontSize: 44,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  unit: {
    fontFamily: fontFamily.semibold,
    fontSize: 20,
    color: colors.textSub,
    marginLeft: 8,
  },

  memoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  memoInput: {
    flex: 1,
    padding: 0,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: colors.text,
  },

  catLabel: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    color: colors.textSub,
  },
  // `flexGrow:0` keeps the horizontal strip at its content height inside the
  // flex:1 `middle`; without it the row (and the active pill's fill) stretch.
  catScroll: { flexGrow: 0, flexShrink: 0 },
  catPicker: {
    paddingHorizontal: spacing.lg,
    gap: 4,
    alignItems: 'center',
  },
  catPick: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    minWidth: 58,
    borderRadius: radii.md,
  },
  catPickActive: { backgroundColor: colors.primaryLight },
  catPickIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },

  numPad: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.border,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
  },
  key: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyGhost: { backgroundColor: 'transparent' },
  keyPressed: { backgroundColor: colors.track },
  doneKey: {
    flex: 1,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  doneKeyText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: colors.white,
  },

  saveBtn: { borderRadius: radii.xl, overflow: 'hidden' },
  saveBtnFill: {
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    color: colors.white,
  },

  collapsedBar: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.border,
  },
  reopenBtn: {
    width: 48,
    height: 48,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlayStrong,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.xl,
    paddingTop: 18,
  },
  sheetHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sheetTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: colors.text,
  },
  fieldLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    letterSpacing: 0.2,
    color: colors.textSub,
    marginBottom: 8,
  },
  quickDate: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  quickDateActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  stepBtn: { padding: 8 },
  stepValue: {
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    color: colors.text,
  },
  sheetCta: { borderRadius: radii.lg, overflow: 'hidden', marginTop: 16 },
  sheetCtaFill: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetSecondary: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    marginTop: 16,
  },
  sheetSecondaryText: {
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    color: colors.textSub,
  },

  hintBox: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: radii.md,
    marginBottom: 12,
  },
  hintText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    color: colors.warningText,
    lineHeight: 18,
  },
  pasteInput: {
    minHeight: 130,
    padding: 14,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    backgroundColor: colors.white,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
    textAlignVertical: 'top',
  },
  pasteTryBtn: {
    marginTop: 8,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  pasteTryText: {
    fontFamily: fontFamily.semibold,
    fontSize: 12,
    color: colors.primaryStrong,
  },
  previewCard: {
    marginTop: 12,
    padding: 14,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    borderRadius: radii.lg,
  },
  previewEyebrow: {
    fontFamily: fontFamily.bold,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.primaryStrong,
    marginBottom: 8,
  },
  previewRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  previewKey: {
    width: 64,
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: colors.textSub,
  },
  previewVal: {
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: 13,
    color: colors.text,
  },
  previewWarn: {
    marginTop: 10,
    padding: 10,
    backgroundColor: colors.expenseLight,
    borderRadius: radii.sm,
  },
  previewWarnText: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    color: colors.expenseStrong,
    lineHeight: 17,
  },
});
