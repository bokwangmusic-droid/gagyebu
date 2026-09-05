/**
 * First stop for a signed-in user with zero households — STEP 16-E.
 * Financial screens stay unreachable regardless of what happens here (see
 * app/_layout.tsx's LEGACY_APP_REACHABLE) — this only decides which
 * household to connect to.
 */
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { GradientButton } from '@/components/ui/GradientButton';
import { useAuth } from '@/store/auth';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function HouseholdSetup() {
  const router = useRouter();
  const { signOut } = useAuth();

  return (
    <AuthShell title="" subtitle="어떻게 시작할까요?">
      <View style={{ gap: spacing.md }}>
        <GradientButton
          label="🏠  우리집 가계부 만들기"
          onPress={() => router.push('/household-create')}
        />
        <Pressable
          onPress={() => router.push('/household-join')}
          style={{
            height: 54,
            borderRadius: radii.xl,
            borderWidth: 1.5,
            borderColor: colors.primaryLight,
            backgroundColor: colors.white,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: colors.primaryStrong }}>
            💌  배우자의 가계부 참여하기
          </Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => void signOut()}
        hitSlop={8}
        style={{ alignItems: 'center', paddingVertical: spacing.xl }}
      >
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textMuted }}>
          다른 계정으로 로그인하고 싶다면 · 로그아웃
        </Text>
      </Pressable>
    </AuthShell>
  );
}
