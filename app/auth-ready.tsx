/**
 * Temporary post-login landing screen — STEP 16-D.
 *
 * Every authenticated user lands here, and ONLY here — see app/_layout.tsx's
 * AuthGate. The existing local-first app (onboarding + (tabs) + every modal
 * screen, all still backed by StoreProvider/AsyncStorage untouched) is
 * deliberately unreachable from this screen: STEP 16-D wires Auth only, not
 * household creation/joining or local-data migration, so there is no safe
 * household yet for that data to belong to. The next STEP replaces this
 * screen's role once that policy exists.
 */
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/store/auth';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function AuthReady() {
  const { profile, profileError, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = useState(false);

  const onSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
    // No further state update needed here even if this component stays
    // mounted for a tick — AuthGate replaces the route to /sign-in as soon
    // as the session clears.
  };

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
        로그인 완료
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
        {profile ? `${profile.displayName}님, ` : ''}이제 우리집 가계부를{'\n'}연결할 차례예요.
      </Text>

      {profileError ? (
        <Text
          style={{
            fontFamily: fontFamily.medium,
            fontSize: 12,
            color: colors.expenseText,
            textAlign: 'center',
            marginTop: spacing.lg,
          }}
        >
          계정 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.
        </Text>
      ) : null}

      <Pressable
        onPress={onSignOut}
        disabled={signingOut}
        style={{
          marginTop: spacing.xxl,
          paddingVertical: 11,
          paddingHorizontal: 24,
          borderRadius: radii.pill,
          backgroundColor: colors.white,
          borderWidth: 1.5,
          borderColor: colors.border,
          opacity: signingOut ? 0.6 : 1,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
          {signingOut ? '로그아웃 중...' : '로그아웃'}
        </Text>
      </Pressable>
    </View>
  );
}
