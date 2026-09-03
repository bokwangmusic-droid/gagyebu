import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

/** Tab-screen header — big title left, optional right slot. Mirrors web `.header`. */
export function ScreenHeader({
  title,
  right,
  onBack,
  containerStyle,
}: {
  title: string;
  right?: ReactNode;
  onBack?: () => void;
  /** Optional override for the header wrapper (e.g. tighter vertical padding). */
  containerStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          paddingBottom: spacing.md,
        },
        containerStyle,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={12}>
            <AppIcon name="chev-left" size={24} color={colors.text} />
          </Pressable>
        )}
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 20, letterSpacing: -0.4, color: colors.text }}>
          {title}
        </Text>
      </View>
      {right ?? null}
    </View>
  );
}

/** Round outline icon button used in tab-screen headers (web `.icon-btn`). */
export function HeaderIconButton({
  icon,
  onPress,
  primary,
}: {
  icon: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: 36,
        height: 36,
        borderRadius: radii.pill,
        backgroundColor: primary ? colors.primary : colors.card,
        borderWidth: primary ? 0 : 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppIcon name={icon} size={18} color={primary ? colors.white : colors.textSub} />
    </Pressable>
  );
}
