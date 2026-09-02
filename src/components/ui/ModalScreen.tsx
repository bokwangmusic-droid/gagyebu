import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { colors, layout, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

interface ModalScreenProps {
  title: string;
  onClose: () => void;
  /** 'x' for sheet-style adds, 'chev-left' for drill-downs. */
  closeIcon?: 'x' | 'chev-left';
  /** Right-aligned header slot (e.g. a "저장" text button or icon). */
  right?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
}

/**
 * Full-screen container for a modal-presented route: cream ground, a
 * header with a close affordance + title, and a scroll body capped at the
 * 430px column. Mirrors the web `.header` + `.modal-full`.
 */
export function ModalScreen({
  title,
  onClose,
  closeIcon = 'chev-left',
  right,
  children,
  scroll = true,
}: ModalScreenProps) {
  const insets = useSafeAreaInsets();
  const [kb, setKb] = useState(0);

  // Shrink the scroll viewport to the keyboard top so a focused field lower
  // on the form (e.g. the memo box) scrolls fully into view rather than
  // hiding behind the keyboard — RN's built-in focus-scroll then lands it.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKb(e.endCoordinates?.height ?? 0));
    const h = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => {
      s.remove();
      h.remove();
    };
  }, []);

  const body = (
    <View style={{ width: '100%', maxWidth: layout.maxContentWidth, alignSelf: 'center', flex: scroll ? undefined : 1 }}>
      {children}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 4 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          maxWidth: layout.maxContentWidth,
          alignSelf: 'center',
          width: '100%',
        }}
      >
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}
        >
          <AppIcon name={closeIcon} size={22} color={colors.text} />
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 20, letterSpacing: -0.4, color: colors.text }}>
            {title}
          </Text>
        </Pressable>
        {right ?? <View style={{ width: 24 }} />}
      </View>

      {scroll ? (
        <ScrollView
          style={{ flex: 1, marginBottom: kb }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 + (kb > 0 ? 24 : 0) }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

export default ModalScreen;
