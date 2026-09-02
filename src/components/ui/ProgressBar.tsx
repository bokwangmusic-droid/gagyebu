import { LinearGradient } from 'expo-linear-gradient';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, gradients, radii } from '@/theme/tokens';

interface ProgressBarProps {
  /** 0–100. Clamped. */
  percent: number;
  size?: 'sm' | 'md' | 'lg';
  /** Overrides the default lavender gradient fill with a solid colour. */
  fillColor?: string;
  trackColor?: string;
  style?: StyleProp<ViewStyle>;
}

const HEIGHTS = { sm: 6, md: 8, lg: 10 } as const;

export function ProgressBar({
  percent,
  size = 'lg',
  fillColor,
  trackColor = colors.track,
  style,
}: ProgressBarProps) {
  const h = HEIGHTS[size];
  const w = `${Math.max(0, Math.min(100, percent))}%` as const;
  return (
    <View
      style={[
        {
          height: h,
          borderRadius: radii.pill,
          backgroundColor: trackColor,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {fillColor ? (
        <View
          style={{ height: '100%', width: w, borderRadius: radii.pill, backgroundColor: fillColor }}
        />
      ) : (
        <LinearGradient
          colors={gradients.primaryProgress}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ height: '100%', width: w, borderRadius: radii.pill }}
        />
      )}
    </View>
  );
}

export default ProgressBar;
