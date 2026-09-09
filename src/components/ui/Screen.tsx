import type { ReactElement, ReactNode } from 'react';
import {
  ScrollView,
  View,
  type RefreshControlProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout } from '@/theme/tokens';

interface ScreenProps {
  children: ReactNode;
  /** Add bottom padding to clear the floating tab bar + FAB. */
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Optional pull-to-refresh for the scroll body (STEP 16-G3-B3 §6). Pass
   * the element from `useRemoteFinanceRefreshControl()`. Ignored when
   * `scroll` is false. Purely additive — omitting it changes nothing.
   */
  refreshControl?: ReactElement<RefreshControlProps>;
}

/**
 * Cream-ground page wrapper, centred and capped at the 430px "phone"
 * column like the web version. Handles the safe-area top inset and leaves
 * room at the bottom for the floating nav.
 */
export function Screen({ children, scroll = true, contentStyle, refreshControl }: ScreenProps) {
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
        // STEP 16-G3-B4 TODO#2: a ScrollView whose content is shorter than
        // the viewport does not start a pull-to-refresh gesture on Android
        // (seen on tablets, where the viewport is tall and e.g. the budget
        // list is short). Only when a RefreshControl is actually wired, grow
        // the content box to fill the viewport so the pull is always
        // available. No visual change — content stays top-aligned (no
        // justifyContent) and flexGrow can't shrink content that already
        // overflows; screens with no RefreshControl are left untouched.
        refreshControl ? { flexGrow: 1 } : null,
        contentStyle,
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
    >
      {inner}
    </ScrollView>
  );
}

export default Screen;
