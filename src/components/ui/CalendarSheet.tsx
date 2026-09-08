import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { isKrRedDay, krEvent } from '@/data/holidays';
import { toDateKey, WEEKDAYS_KO } from '@/lib/format';
import { buildMonthWeeks } from '@/lib/monthGrid';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

/** 요일 헤더 색: 일(0) 빨강 · 토(6) 파랑 · 평일 muted. */
function weekdayHeaderColor(i: number): string {
  return i === 0 ? colors.expenseStrong : i === 6 ? colors.infoText : colors.textMuted;
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

  const weeks = useMemo(() => buildMonthWeeks(view.year, view.month), [view]);

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

          {/* Weekday header — same 7 × flex:1 sizing as the grid rows */}
          <View style={{ flexDirection: 'row', marginBottom: 2 }}>
            {WEEKDAYS_KO.map((d, i) => (
              <View key={d} style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }}>
                <Text
                  style={{ fontFamily: fontFamily.bold, fontSize: 10, color: weekdayHeaderColor(i) }}
                >
                  {d}
                </Text>
              </View>
            ))}
          </View>

          {/* Grid — one row per week, each with exactly 7 flex:1 cells so a
              row can never wrap to 6 columns. */}
          {weeks.map((week, wi) => (
            <View key={wi} style={{ flexDirection: 'row' }}>
              {week.map((day) => {
                const disabled =
                  (minDate != null && day.key < minDate) || (maxDate != null && day.key > maxDate);
                const isSel = day.key === value;
                const showToday = !isSel && day.inMonth && day.key === todayKey;
                const ev = day.inMonth ? krEvent(day.key) : undefined;
                // 일요일 또는 대한민국 '빨간 날'(공휴일·대체·임시·명절·선거) -> 빨강.
                // 토요일 -> 파랑 (단 빨간 날이면 빨강이 우선).
                const red = day.inMonth && (day.dow === 0 || (ev != null && isKrRedDay(day.key)));
                const blue = day.inMonth && day.dow === 6 && !red;
                const numColor = isSel
                  ? colors.white
                  : !day.inMonth
                    ? colors.textMuted
                    : red
                      ? colors.expenseStrong
                      : blue
                        ? colors.infoText
                        : colors.text;
                return (
                  <Pressable
                    key={day.key}
                    onPress={() => !disabled && day.inMonth && pick(day.key)}
                    disabled={disabled || !day.inMonth}
                    style={{ flex: 1, height: 48, alignItems: 'center', paddingTop: 3 }}
                  >
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: radii.pill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: isSel
                          ? colors.primary
                          : showToday
                            ? colors.primaryLighter
                            : 'transparent',
                        borderWidth: showToday ? 1.5 : 0,
                        borderColor: colors.primary,
                        opacity: !day.inMonth ? 0.32 : disabled ? 0.24 : 1,
                      }}
                    >
                      <Text
                        style={{
                          fontFamily: isSel || showToday ? fontFamily.bold : fontFamily.medium,
                          fontSize: 13,
                          color: numColor,
                        }}
                      >
                        {day.date.getDate()}
                      </Text>
                    </View>
                    {/* Event label — always rendered (empty when none) so every
                        cell keeps the same height and the 7-column grid stays aligned. */}
                    <Text
                      numberOfLines={1}
                      style={{
                        marginTop: 1,
                        fontSize: 8,
                        lineHeight: 10,
                        fontFamily: fontFamily.medium,
                        color: red ? colors.expenseStrong : colors.textFaint,
                        opacity: disabled && day.inMonth ? 0.5 : 1,
                      }}
                    >
                      {ev ? ev.shortLabel : ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}

          {/* Legend — 색 의미를 숫자만 보고 이해하기 어렵지 않도록 */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 4,
              marginTop: spacing.sm,
            }}
          >
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 10, color: colors.infoText }}>토요일</Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textFaint }}>파랑 ·</Text>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 10, color: colors.expenseStrong }}>일요일·공휴일</Text>
            <Text style={{ fontFamily: fontFamily.regular, fontSize: 10, color: colors.textFaint }}>빨강</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default CalendarSheet;
