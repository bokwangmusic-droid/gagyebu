/**
 * Invite-code screen — STEP 16-E §10.
 *
 * Calls create_household_invite (supabase/migrations/
 * 20260905000600_household_rpcs.sql) once on mount, and again on "새 코드
 * 만들기" — the RPC itself revokes any still-active invite for this
 * household before issuing the new one, so this never leaves two usable
 * codes behind. The plaintext code lives only in this screen's component
 * state: never logged, never written to AsyncStorage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Share, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { useHousehold } from '@/store/household';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily, tabularNums } from '@/theme/typography';

/** Groups any length into 4-char chunks — handles the 20-char code
 *  (5 groups) generically rather than hardcoding a 12-char/3-group split. */
function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export default function HouseholdInvite() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { createInvite } = useHousehold();

  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(false);

  const generate = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const result = await createInvite();
    loadingRef.current = false;
    setLoading(false);
    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    setCode(result.code);
    // expiresAt is shown as a fixed "7일" copy below rather than a live
    // countdown — good enough for this STEP, avoids extra timer state.
  }, [createInvite, toast]);

  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onShare = async () => {
    if (!code) return;
    try {
      await Share.share({
        message: `돈돈 가계부에서 우리집에 참여해 주세요.\n초대코드: ${formatCode(code)}`,
      });
    } catch {
      // User cancelled or the share sheet failed to open — nothing to report.
    }
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
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.textSub }}>
        배우자 초대코드
      </Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : code ? (
        <>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            style={{
              width: '100%',
              fontFamily: fontFamily.extrabold,
              fontSize: 20,
              letterSpacing: 1,
              color: colors.primaryStrong,
              marginTop: 10,
              textAlign: 'center',
              ...tabularNums,
            }}
          >
            {formatCode(code)}
          </Text>
          <Text
            style={{
              fontFamily: fontFamily.regular,
              fontSize: 13,
              color: colors.textSub,
              textAlign: 'center',
              lineHeight: 20,
              marginTop: spacing.md,
            }}
          >
            7일 동안 사용할 수 있어요.{'\n'}한 번 사용하면 다시 사용할 수 없어요.
          </Text>

          <GradientButton
            label="공유하기"
            onPress={onShare}
            style={{ width: '100%', maxWidth: 430, marginTop: spacing.xxl }}
          />
          <Pressable onPress={generate} hitSlop={8} style={{ marginTop: spacing.lg }}>
            <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.textSub }}>
              새 코드 만들기
            </Text>
          </Pressable>
        </>
      ) : null}

      <Pressable onPress={() => router.back()} hitSlop={8} style={{ marginTop: spacing.xxl }}>
        <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.textMuted }}>
          닫기
        </Text>
      </Pressable>
    </View>
  );
}
