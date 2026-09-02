import { Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { colors, radii, shadows, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

interface EmptyStateProps {
  title: string;
  sub: string;
  /** Shows the 72px gradient "+" button and, if `cta` given, a pill button. */
  onPress?: () => void;
  cta?: string;
  /** Use a plain icon tile instead of the big "+" button. */
  icon?: string;
}

/** Mirrors the web `.empty` block (empty-fab + title + sub + empty-cta). */
export function EmptyState({ title, sub, onPress, cta, icon }: EmptyStateProps) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: spacing.xxl, paddingTop: 40, paddingBottom: 40 }}>
      {icon ? (
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 20,
            backgroundColor: colors.primaryLighter,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: spacing.lg,
          }}
        >
          <AppIcon name={icon} size={28} color={colors.primary} />
        </View>
      ) : (
        <Pressable
          onPress={onPress}
          disabled={!onPress}
          style={[
            {
              width: 72,
              height: 72,
              borderRadius: radii.sheet,
              backgroundColor: colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
            },
            shadows.fab,
          ]}
        >
          <AppIcon name="plus" size={30} color={colors.white} strokeWidth={2.5} />
        </Pressable>
      )}
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, marginBottom: 6 }}>
        {title}
      </Text>
      <Text
        style={{
          fontFamily: fontFamily.regular,
          fontSize: 13,
          color: colors.textSub,
          textAlign: 'center',
          lineHeight: 21,
        }}
      >
        {sub}
      </Text>
      {cta && onPress ? (
        <Pressable
          onPress={onPress}
          style={{
            marginTop: 18,
            paddingVertical: 11,
            paddingHorizontal: 22,
            borderRadius: radii.pill,
            backgroundColor: colors.white,
            borderWidth: 1.5,
            borderColor: colors.primaryLight,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>{cta}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default EmptyState;
