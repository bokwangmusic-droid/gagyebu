import { Text, View } from 'react-native';

import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';
import { AppIcon } from '@/components/AppIcon';
import { Screen } from './Screen';

/** Temporary "coming next" screen body used while porting is in progress. */
export function Placeholder({ title, icon = 'sparkle' }: { title: string; icon?: string }) {
  return (
    <Screen>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          paddingBottom: spacing.md,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 20, letterSpacing: -0.4, color: colors.text }}>
          {title}
        </Text>
      </View>
      <View style={{ alignItems: 'center', paddingTop: 100, paddingHorizontal: spacing.xxl }}>
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
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text, marginBottom: 6 }}>
          곧 만들 화면이에요
        </Text>
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 13,
            color: colors.textSub,
            textAlign: 'center',
            lineHeight: 20,
          }}
        >
          「{title}」 화면은 포팅 예정입니다.{'\n'}홈 화면부터 순서대로 옮기고 있어요.
        </Text>
      </View>
    </Screen>
  );
}

export default Placeholder;
