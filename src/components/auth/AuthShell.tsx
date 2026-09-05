/**
 * Shared chrome for the sign-in / sign-up screens — STEP 16-D.
 *
 * Reuses the existing cream background + lavender accent + Noto Sans KR
 * type ramp (src/theme) instead of introducing a new palette. The app's
 * actual in-app accent colour is lavender (see src/theme/tokens.ts), not
 * the yellow/orange of the app icon artwork — GradientButton etc. below
 * follow the former so this screen matches every other screen in the app.
 * The only "brand" touch is the existing icon.png artwork itself, reused
 * small (no new art created).
 */
import type { ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** Rendered below the form, e.g. a "회원가입" switch link. */
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 32,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ width: '100%', maxWidth: 430, alignSelf: 'center', flexGrow: 1 }}>
          <View style={{ alignItems: 'center', marginBottom: spacing.xxl }}>
            <Image
              source={require('../../../assets/icon.png')}
              style={{ width: 84, height: 84, borderRadius: radii.xxl }}
            />
            <Text
              style={{
                fontFamily: fontFamily.extrabold,
                fontSize: 24,
                letterSpacing: -0.6,
                color: colors.text,
                marginTop: spacing.lg,
              }}
            >
              돈돈 가계부
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.regular,
                fontSize: 14,
                color: colors.textSub,
                textAlign: 'center',
                lineHeight: 21,
                marginTop: 8,
              }}
            >
              {subtitle}
            </Text>
          </View>

          {title ? (
            <Text
              style={{
                fontFamily: fontFamily.bold,
                fontSize: 16,
                color: colors.text,
                marginBottom: spacing.md,
              }}
            >
              {title}
            </Text>
          ) : null}

          {children}

          {footer}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export default AuthShell;
