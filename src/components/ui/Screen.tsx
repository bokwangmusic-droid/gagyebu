import type { ReactNode } from 'react';
import { ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout } from '@/theme/tokens';

interface ScreenProps {
  children: ReactNode;
  /** Add bottom padding to clear the floating tab bar + FAB. */
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * Cream-ground page wrapper, centred and capped at the 430px "phone"
 * column like the web version. Handles the safe-area top inset and leaves
 * room at the bottom for the floating nav.
 */
export function Screen({ children, scroll = true, contentStyle }: ScreenProps) {
  const insets = useSafeAreaInsets();

  const inner = (
    <View
      style={{
        width: '100%',
        maxWidth: layout.maxContentWidth,
        alignSelf: 'center',
        flex: scroll ? undefined : 1,
      }}
    >
      {children}
    </View>
  );

  if (!scroll) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
        {inner}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 132 },
        contentStyle,
      ]}
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  );
}

export default Screen;
