/**
 * Email-confirmation deep-link landing screen — STEP 16-D1.
 *
 * Supabase's confirmation email redirects the browser here
 * (emailRedirectTo = Linking.createURL('auth-callback'), src/store/auth.tsx)
 * after verifying the signup token server-side. This screen deliberately
 * does NOT read or exchange any token/code from the incoming URL — the
 * Supabase client runs with `detectSessionInUrl: false` on purpose
 * (src/lib/supabase.ts, STEP 16-D), and this STEP's scope is only "land
 * safely back in the app", not "auto sign in". The user finishes by
 * signing in normally.
 */
import { useRouter } from 'expo-router';
import { Image, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GradientButton } from '@/components/ui/GradientButton';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function AuthCallback() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      <Image
        source={require('../assets/icon.png')}
        style={{ width: 88, height: 88, borderRadius: radii.xxl, marginBottom: spacing.xl }}
      />
      <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 22, color: colors.text }}>
        이메일 인증이 완료됐어요
      </Text>
      <Text
        style={{
          fontFamily: fontFamily.regular,
          fontSize: 14,
          color: colors.textSub,
          textAlign: 'center',
          lineHeight: 21,
          marginTop: 10,
        }}
      >
        이제 로그인해 주세요.
      </Text>
      <GradientButton
        label="로그인 화면으로"
        onPress={() => router.replace('/sign-in')}
        style={{ width: '100%', marginTop: spacing.xxl }}
      />
    </View>
  );
}
