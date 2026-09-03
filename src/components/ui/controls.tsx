import { forwardRef, type ReactNode } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

/* ------------------------------------------------------------------ *
 * Segmented tabs — the web `.type-tabs`.
 * ------------------------------------------------------------------ */
export function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
  style,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; tone?: 'expense' | 'income' }[];
  style?: object;
}) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          gap: 4,
          padding: 4,
          backgroundColor: colors.border,
          borderRadius: radii.md,
        },
        style,
      ]}
    >
      {options.map((o) => {
        const active = value === o.value;
        const activeColor =
          o.tone === 'expense'
            ? colors.expenseText
            : o.tone === 'income'
              ? colors.incomeStrong
              : colors.text;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              paddingVertical: 8,
              alignItems: 'center',
              borderRadius: 9,
              backgroundColor: active ? colors.white : 'transparent',
            }}
          >
            <Text
              style={{
                fontFamily: active ? fontFamily.bold : fontFamily.semibold,
                fontSize: 13,
                color: active ? activeColor : colors.textSub,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Toggle switch — the web `.toggle`.
 * ------------------------------------------------------------------ */
export function Toggle({
  value,
  onChange,
  disabled,
  activeColor = colors.primary,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Track colour when ON. Defaults to the lavender primary. */
  activeColor?: string;
}) {
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      style={{
        width: 40,
        height: 22,
        borderRadius: radii.pill,
        backgroundColor: value ? activeColor : colors.borderStrong,
        padding: 2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: radii.pill,
          backgroundColor: colors.white,
          transform: [{ translateX: value ? 18 : 0 }],
        }}
      />
    </Pressable>
  );
}

/* ------------------------------------------------------------------ *
 * Wrapping chip selector — the web `.chip-select`.
 * ------------------------------------------------------------------ */
export function ChipSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: radii.pill,
              backgroundColor: active ? colors.primaryLight : colors.white,
              borderWidth: 1,
              borderColor: active ? colors.primary : colors.border,
            }}
          >
            <Text
              style={{
                fontFamily: active ? fontFamily.semibold : fontFamily.regular,
                fontSize: 12,
                color: active ? colors.primaryStrong : colors.text,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Form field label + slot — the web `.form-field` / `.form-label`.
 * ------------------------------------------------------------------ */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 11,
          letterSpacing: 0.2,
          color: colors.textSub,
          marginBottom: 6,
        }}
      >
        {label}
      </Text>
      {children}
      {hint ? (
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 11,
            color: colors.textMuted,
            marginTop: 6,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Text input — the web `.form-input`.
 * ------------------------------------------------------------------ */
export const TextField = forwardRef<TextInput, TextInputProps>(function TextField(props, ref) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.textMuted}
      {...props}
      style={[
        {
          width: '100%',
          paddingVertical: 12,
          paddingHorizontal: 14,
          backgroundColor: colors.white,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.md,
          fontFamily: fontFamily.regular,
          fontSize: 15,
          color: colors.text,
        },
        props.style,
      ]}
    />
  );
});

/* ------------------------------------------------------------------ *
 * Header text button — the web `.btn-ghost` "저장".
 * ------------------------------------------------------------------ */
export function HeaderTextButton({
  label,
  onPress,
  disabled,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'danger';
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={10} style={{ paddingVertical: 6, paddingHorizontal: 8 }}>
      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 14,
          color: disabled
            ? colors.textMuted
            : tone === 'danger'
              ? colors.expenseText
              : colors.primaryStrong,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
