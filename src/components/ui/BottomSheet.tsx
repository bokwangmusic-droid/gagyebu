import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Optional standard header row (title + ✕). Omit to supply your own. */
  title?: string;
  children: ReactNode;
  /** Wrap the body in a ScrollView for tall content (icon/colour pickers). */
  scroll?: boolean;
}

/**
 * Bottom-anchored sheet with reliable keyboard avoidance on both platforms.
 *
 * We track the keyboard height with `Keyboard` events and pad the sheet by
 * that amount, so the sheet content always rises fully above the keyboard —
 * `KeyboardAvoidingView` inside a RN `<Modal>` on Android is unreliable
 * (its `behavior` is a no-op without an explicit value and mismeasures when
 * `statusBarTranslucent` is set).
 */
export function BottomSheet({ visible, onClose, title, children, scroll = false }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const [kb, setKb] = useState(0);

  useEffect(() => {
    if (!visible) {
      setKb(0);
      return;
    }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKb(e.endCoordinates?.height ?? 0));
    const h = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => {
      s.remove();
      h.remove();
    };
  }, [visible]);

  const bottomPad = kb > 0 ? kb + spacing.md : insets.bottom + spacing.xxl;

  const header = title ? (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.lg,
      }}
    >
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.text }}>{title}</Text>
      <Pressable onPress={onClose} hitSlop={10}>
        <AppIcon name="x" size={18} color={colors.textSub} />
      </Pressable>
    </View>
  ) : null;

  const pad = {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: bottomPad,
  };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlayStrong, justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: radii.sheet,
            borderTopRightRadius: radii.sheet,
            maxHeight: '92%',
          }}
        >
          {scroll ? (
            <ScrollView
              contentContainerStyle={pad}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
            >
              {header}
              {children}
            </ScrollView>
          ) : (
            <View style={pad}>
              {header}
              {children}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default BottomSheet;
