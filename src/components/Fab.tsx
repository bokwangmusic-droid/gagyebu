import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, gradients, layout, radii, shadows } from '@/theme/tokens';
import { AppIcon } from './AppIcon';

/** Centre "+" button that opens the transaction input modal. */
export function Fab() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const open = () => {
    if (Platform.OS !== 'web') void Haptics.selectionAsync();
    router.push('/input');
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="지출·수입 추가"
      onPress={open}
      style={({ pressed }) => [
        {
          position: 'absolute',
          alignSelf: 'center',
          bottom: Math.max(insets.bottom, 12) + 24,
          width: layout.fabSize,
          height: layout.fabSize,
          borderRadius: radii.pill,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ scale: pressed ? 0.95 : 1 }],
        },
        shadows.fab,
      ]}
    >
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          width: layout.fabSize,
          height: layout.fabSize,
          borderRadius: radii.pill,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <AppIcon name="plus" size={26} color={colors.white} strokeWidth={2.5} />
      </LinearGradient>
    </Pressable>
  );
}

export default Fab;
