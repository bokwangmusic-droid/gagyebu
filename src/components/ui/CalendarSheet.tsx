import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { toDateKey } from '@/lib/format';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

const WD = ['월', '화', '수', '목', '금', '토', '일'];

function buildGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const pad = (first.getDay() + 6) % 7; // Monday-first
  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = pad; i > 0; i--) {
    const d = new Date(first);
    d.setDate(first.getDate() - i);
    cells.push({ date: d, inMonth: false });
  }
  for (let i = 1; i <= last.getDate(); i++) {
    cells.push({ date: new Date(year, month, i), inMonth: true });
  }
  while (cells.length % 7 !== 0) {
    const lastCell = cells[cells.length - 1].date;
    const d = new Date(lastCell);
    d.setDate(lastCell.getDate() + 1);
    cells.push({ date: d, inMonth: false });
  }
  return cells;
}

interface Props {
  visible: boolean;
  value: string; // YYYY-MM-DD
  onSelect: (key: string) => void;
  onClose: () => void;
  minDate?: string;
  maxDate?: string;
  title?: string;
}

/** Themed month-grid date picker in a bottom sheet. Tap a day to pick. */
export function CalendarSheet({
  visible,
  value,
  onSelect,
  onClose,
  minDate,
  maxDate,
  title = '날짜 선택',
}: Props) {
  const insets = useSafeAreaInsets();
  const todayKey = toDateKey(new Date());

  const [view, setView] = useState(() => {
    const [y, m] = value.split('-').map(Number);
    return { year: y, month: m - 1 };
  });

  // Jump to the selected month each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    const [y, m] = value.split('-').map(Number);
    setView({ year: y, month: m - 1 });
  }, [visible, value]);

  const grid = useMemo(() => buildGrid(view.year, view.month), [view]);

  const shiftMonth = (delta: number) =>
    setView((v) => {
      const m = v.month + delta;
      if (m < 0) return { year: v.year - 1, month: 11 };
      if (m > 11) return { year: v.year + 1, month: 0 };
      return { year: v.year, month: m };
    });

  const pick = (key: string) => {
    onSelect(key);
    onClose();
  };

  const quick = [
    { label: '오늘', key: todayKey },
    { label: '내일', key: toDateKey(new Date(Date.now() + 86_400_000)) },
    { label: '다음 주', key: toDateKey(new Date(Date.now() + 7 * 86_400_000)) },
  ].filter((q) => (!minDate || q.key >= minDate) && (!maxDate || q.key <= maxDate));

  return (
    <Modal transparent visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlayStrong, justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingHorizontal: spacing.xl,
            paddingTop: 18,
            paddingBottom: insets.bottom + 20,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: spacing.md,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <AppIcon name="calendar" size={16} color={colors.primaryStrong} />
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text }}>{title}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <AppIcon name="x" size={18} color={colors.textSub} />
            </Pressable>
          </View>

          {quick.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: spacing.md }}>
              {quick.map((q) => {
                const active = value === q.key;
                return (
                  <Pressable
                    key={q.label}
                    onPress={() => pick(q.key)}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      alignItems: 'center',
                      borderRadius: radii.md,
                      backgroundColor: active ? colors.primary : colors.white,
                      borderWidth: 1,
                      borderColor: active ? colors.primary : colors.border,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: fontFamily.semibold,
                        fontSize: 12,
                        color: active ? colors.white : colors.text,
                      }}
                    >
                      {q.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Month nav */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 24,
              marginBottom: spacing.sm,
            }}
          >
            <Pressable
              onPress={() => shiftMonth(-1)}
              hitSlop={10}
              style={{
                width: 34,
                height: 34,
                borderRadius: radii.pill,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppIcon name="chev-left" size={16} color={colors.textSub} />
            </Pressable>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 16, letterSpacing: -0.4, color: colors.text }}>
              {view.year}년 {view.month + 1}월
            </Text>
            <Pressable
              onPress={() => shiftMonth(1)}
              hitSlop={10}
              style={{
                width: 34,
                height: 34,
                borderRadius: radii.pill,
                backgroundColor: colors.white,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppIcon name="chev-right" size={16} color={colors.textSub} />
            </Pressable>
          </View>

          {/* Weekday header */}
          <View style={{ flexDirection: 'row', marginBottom: 2 }}>
            {WD.map((d, i) => (
              <Text
                key={d}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  fontFamily: fontFamily.bold,
                  fontSize: 10,
                  paddingVertical: 6,
                  color: i === 5 ? colors.infoText : i === 6 ? colors.expenseStrong : colors.textMuted,
                }}
              >
                {d}
              </Text>
            ))}
          </View>

          {/* Grid */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {grid.map((cell, i) => {
              const key = toDateKey(cell.date);
              const disabled =
                (minDate != null && key < minDate) || (maxDate != null && key > maxDate);
              const isSel = key === value;
              const isToday = key === todayKey;
              const dow = cell.date.getDay();
              return (
                <Pressable
                  key={i}
                  onPress={() => !disabled && cell.inMonth && pick(key)}
                  disabled={disabled || !cell.inMonth}
                  style={{
                    width: `${100 / 7}%`,
                    height: 42,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: radii.pill,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: isSel ? colors.primary : 'transparent',
                      borderWidth: !isSel && isToday ? 1.5 : 0,
                      borderColor: colors.primary,
                      opacity: disabled || !cell.inMonth ? 0.28 : 1,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: isSel || isToday ? fontFamily.bold : fontFamily.medium,
                        fontSize: 13,
                        color: isSel
                          ? colors.white
                          : !cell.inMonth
                            ? colors.textMuted
                            : dow === 0
                              ? colors.expenseStrong
                              : dow === 6
                                ? colors.infoText
                                : colors.text,
                      }}
                    >
                      {cell.date.getDate()}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default CalendarSheet;
