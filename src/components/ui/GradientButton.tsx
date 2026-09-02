import { LinearGradient } from 'expo-linear-gradient';
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, gradients, radii, shadows } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

interface GradientButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Primary CTA — lavender 135° gradient, full width, 54px tall. */
export function GradientButton({
  label,
  onPress,
  disabled,
  style,
}: GradientButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        { borderRadius: radii.xl, opacity: disabled ? 0.4 : pressed ? 0.9 : 1 },
        !disabled && shadows.md,
        style,
      ]}
    >
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          height: 54,
          borderRadius: radii.xl,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontFamily: fontFamily.bold,
            fontSize: 16,
            color: colors.white,
          }}
        >
          {label}
        </Text>
      </LinearGradient>
    </Pressable>
  );
}

export default GradientButton;

/** Small filled circular icon button used in headers. */
export function IconCircleButton({
  onPress,
  children,
  primary,
  style,
}: {
  onPress: () => void;
  children: React.ReactNode;
  primary?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 36,
          height: 36,
          borderRadius: radii.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: primary ? colors.primary : colors.card,
          borderWidth: primary ? 0 : 1,
          borderColor: colors.border,
          transform: [{ scale: pressed ? 0.95 : 1 }],
        },
        primary && shadows.md,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}
