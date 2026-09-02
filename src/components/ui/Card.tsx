import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/theme/tokens';

interface CardProps {
  children: ReactNode;
  /** `tight` = list container padding, `sm` = smaller radius/padding. */
  variant?: 'default' | 'sm' | 'tight';
  style?: StyleProp<ViewStyle>;
}

/** White rounded panel with a hairline border. Mirrors `.card` on the web. */
export function Card({ children, variant = 'default', style }: CardProps) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: variant === 'sm' ? radii.xxl : radii.card,
          paddingVertical:
            variant === 'tight' ? spacing.lg : variant === 'sm' ? spacing.lg : spacing.xl,
          paddingHorizontal: variant === 'tight' ? spacing.lg + 2 : spacing.xl,
          marginHorizontal: spacing.lg,
          marginBottom: spacing.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export default Card;
