import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { REMOTE_FINANCE_WRITE } from '@/lib/financeMode';
import { colors, gradients, layout, radii, shadows } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';
import { useFinanceRead } from '@/store/financeRead';
import { AppIcon } from './AppIcon';

/**
 * Four destinations with a docked "+" in the middle that opens the input
 * modal. The add button is part of the bar (raised, not a free-floating
 * FAB) so it never sits on top of a tab's icon or label.
 */
const TABS: { name: string; label: string; icon: string }[] = [
  { name: 'index', label: '홈', icon: 'nav-home' },
  { name: 'stats', label: '통계', icon: 'nav-chart' },
  { name: 'planned', label: '예정', icon: 'nav-calendar' },
  { name: 'profile', label: '내정보', icon: 'nav-user' },
];

const ADD_SIZE = 56;
/** The bar's own horizontal padding. Shared so the centred "+" overlay can
 *  cancel it exactly (see the FAB wrapper below) instead of guessing. */
const BAR_PAD_X = 12;

export function BottomTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // STEP 16-G1B: this badge counts upcoming planned expenses for display —
  // switched to the remote read-only source like every other finance
  // figure in the app. Not gated on `status`: while loading/erroring,
  // `planned` is simply the safe empty-array default, so the badge just
  // shows nothing rather than a stale local count.
  const { planned } = useFinanceRead();

  const upcomingCount = (() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const in7 = now.getTime() + 7 * 86_400_000;
    return planned.filter((p) => new Date(`${p.date}T00:00:00`).getTime() <= in7).length;
  })();

  const activeRoute = state.routes[state.index]?.name;
  const padBottom = Math.max(insets.bottom, 12);

  const openInput = () => {
    if (Platform.OS !== 'web') void Haptics.selectionAsync();
    router.push('/input');
  };

  const renderItem = (tab: (typeof TABS)[number]) => {
    const focused = activeRoute === tab.name;
    const badge = tab.name === 'planned' ? upcomingCount : 0;
    return (
      <Pressable
        key={tab.name}
        onPress={() => navigation.navigate(tab.name)}
        style={{ flex: 1, alignItems: 'center', gap: 3, paddingVertical: 4 }}
      >
        <View>
          <AppIcon
            name={tab.icon}
            size={22}
            color={focused ? colors.primaryHover : colors.textMuted}
            strokeWidth={focused ? 2.2 : 2}
          />
          {badge > 0 && (
            <View
              style={{
                position: 'absolute',
                top: -3,
                right: -9,
                minWidth: 15,
                height: 15,
                paddingHorizontal: 3,
                borderRadius: radii.pill,
                backgroundColor: colors.expenseSolid,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 9, color: colors.white }}>
                {badge > 9 ? '9+' : badge}
              </Text>
            </View>
          )}
        </View>
        <Text
          style={{
            fontFamily: focused ? fontFamily.semibold : fontFamily.regular,
            fontSize: 10,
            color: focused ? colors.primaryHover : colors.textMuted,
          }}
        >
          {tab.label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          alignSelf: 'center',
          width: '100%',
          maxWidth: layout.maxContentWidth,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.card,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: 8,
          paddingHorizontal: BAR_PAD_X,
          paddingBottom: padBottom,
        },
        shadows.md,
      ]}
    >
      {renderItem(TABS[0])}
      {renderItem(TABS[1])}
      <View style={{ width: 68 }} />
      {renderItem(TABS[2])}
      {renderItem(TABS[3])}

      {/* Docked add button — STEP 16-G1B hid it entirely in read-only mode
          (this is the app's single most prominent "add transaction"
          affordance, on every tab at all times). STEP 16-G2-A brings it
          back, but ONLY for new-transaction-create: it opens /input, which
          is the one financial write now allowed. No other mutation CTA is
          restored.

          STEP 16-G2-A2 UI FIX: the FAB used `left: '50%'` + a negative
          `marginLeft`, which Yoga resolves against the bar's *content* box
          while applying the inset from its *padding* box — so the bar's
          `paddingHorizontal` (BAR_PAD_X) pushed the button that many px
          left of the true centre. Instead it now lives in a full-width
          overlay: `left/right` cancel BAR_PAD_X exactly so the overlay
          spans the bar edge-to-edge, and `alignItems: 'center'` puts the
          FAB's centre at precisely 50% of the bar width — independent of
          the tab items' flex/label widths. `box-none` keeps the overlay
          from stealing taps meant for the tabs underneath. */}
      {REMOTE_FINANCE_WRITE.transactionCreate && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: -BAR_PAD_X,
            right: -BAR_PAD_X,
            bottom: padBottom + 14,
            alignItems: 'center',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="지출·수입 추가"
            onPress={openInput}
            style={({ pressed }) => [
              {
                width: ADD_SIZE,
                height: ADD_SIZE,
                borderRadius: radii.pill,
                alignItems: 'center',
                justifyContent: 'center',
                transform: [{ scale: pressed ? 0.94 : 1 }],
              },
              shadows.fab,
            ]}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                width: ADD_SIZE,
                height: ADD_SIZE,
                borderRadius: radii.pill,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 4,
                borderColor: colors.card,
              }}
            >
              <AppIcon name="plus" size={26} color={colors.white} strokeWidth={2.5} />
            </LinearGradient>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export default BottomTabBar;
