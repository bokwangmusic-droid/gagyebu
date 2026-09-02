import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { toDateKey, weekdayKo } from '@/lib/format';
import { colors, radii } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';
import { CalendarSheet } from './CalendarSheet';

function shift(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return toDateKey(new Date(y, m - 1, d + days));
}

function label(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${m}/${d} (${weekdayKo(new Date(y, m - 1, d))})`;
}

/**
 * Date control: ‹ › nudge one day at a time, or tap the middle to open a
 * full month calendar. `min`/`max` are inclusive YYYY-MM-DD bounds.
 */
export function DateStepper({
  value,
  onChange,
  min,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const atMin = min != null && value <= min;
  const atMax = max != null && value >= max;

  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.md,
          paddingHorizontal: 4,
          paddingVertical: 4,
        }}
      >
        <Pressable
          onPress={() => !atMin && onChange(shift(value, -1))}
          hitSlop={6}
          disabled={atMin}
          style={{ padding: 10, opacity: atMin ? 0.3 : 1 }}
        >
          <AppIcon name="chev-left" size={18} color={colors.textSub} />
        </Pressable>

        <Pressable
          onPress={() => setOpen(true)}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 8,
          }}
        >
          <Text style={{ fontFamily: fontFamily.semibold, fontSize: 15, color: colors.text }}>
            {label(value)}
          </Text>
          <AppIcon name="chevron" size={13} color={colors.textMuted} />
        </Pressable>

        <Pressable
          onPress={() => !atMax && onChange(shift(value, 1))}
          hitSlop={6}
          disabled={atMax}
          style={{ padding: 10, opacity: atMax ? 0.3 : 1 }}
        >
          <AppIcon name="chev-right" size={18} color={colors.textSub} />
        </Pressable>
      </View>

      <CalendarSheet
        visible={open}
        value={value}
        onSelect={onChange}
        onClose={() => setOpen(false)}
        minDate={min}
        maxDate={max}
      />
    </>
  );
}

export default DateStepper;
