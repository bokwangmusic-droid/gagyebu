/**
 * Post-household landing screen — STEP 16-E, extended in STEP 16-G1B.
 *
 * Every signed-in user with exactly one (active) household lands here, and
 * ONLY here — see app/_layout.tsx's AuthGate. From here, "가계부 열기" opens
 * the existing finance UI ((tabs) + every list screen) in STEP 16-G1B's
 * READ-ONLY remote mode — every add/edit/delete affordance in that UI is
 * gone or blocked; see the completion report for the full audit. This
 * screen replaces STEP 16-D's app/auth-ready.tsx, which is removed now
 * that this one exists (see completion report).
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { BackHandler, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GradientButton } from '@/components/ui/GradientButton';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { useRemoteFinance } from '@/store/remoteFinance';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function HouseholdReady() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Android hardware back. AuthGate reaches this screen via
  // `router.replace('/household-ready')`, so on a fresh launch there is
  // nothing behind it in the stack — dispatching GO_BACK there produces
  // "The action 'GO_BACK' was not handled by any navigator". Only go back
  // when there is real history (e.g. this screen was pushed onto, then
  // returned to); otherwise move FORWARD into the finance home. Never back
  // into sign-in / sign-up / invite — the household is already connected.
  // Registered only while this screen is focused (useFocusEffect).
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)');
        }
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, [router]),
  );

  const { session, signOut } = useAuth();
  const { activeHousehold, members, membersLoading } = useHousehold();
  // STEP 16-G1B-FIX: read straight from useRemoteFinance() (the same
  // provider app/remote-data-preview.tsx's `isTrusted` uses) instead of
  // going through useFinanceRead()'s derived `status` — every condition
  // below is named explicitly so it's unambiguous which one is false if
  // this button is ever reported stuck again. No useStore()/local data
  // anywhere in this file.
  const {
    error: financeError,
    loadedForUserId,
    loadedForHouseholdId,
    refreshRemoteFinance,
  } = useRemoteFinance();

  const hasSession = !!session?.user?.id;
  const hasHousehold = !!activeHousehold;
  const loadedForCurrentUser = hasSession && loadedForUserId === session!.user.id;
  const loadedForCurrentHousehold = hasHousehold && loadedForHouseholdId === activeHousehold!.id;
  const hasFinanceError = !!financeError;
  const financeReady =
    hasSession &&
    hasHousehold &&
    loadedForCurrentUser &&
    loadedForCurrentHousehold &&
    !hasFinanceError;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        flexGrow: 1,
        paddingTop: insets.top + 40,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: spacing.xl,
        alignItems: 'center',
      }}
    >
      <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 22, color: colors.text }}>
        우리집 연결 완료 🎉
      </Text>
      <Text
        style={{
          fontFamily: fontFamily.bold,
          fontSize: 16,
          color: colors.primaryStrong,
          marginTop: 6,
        }}
      >
        {activeHousehold?.name ?? '우리집 가계부'}
      </Text>

      <View style={{ width: '100%', maxWidth: 430, marginTop: spacing.xxl }}>
        <Text
          style={{
            fontFamily: fontFamily.bold,
            fontSize: 12,
            color: colors.textSub,
            marginBottom: spacing.sm,
          }}
        >
          함께 쓰는 사람
        </Text>
        <View
          style={{
            backgroundColor: colors.white,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.card,
            overflow: 'hidden',
          }}
        >
          {!membersLoading && members.length === 0 ? (
            <Text
              style={{
                fontFamily: fontFamily.regular,
                fontSize: 13,
                color: colors.textMuted,
                padding: spacing.lg,
              }}
            >
              구성원 정보를 불러오는 중이에요.
            </Text>
          ) : (
            members.map((m, i) => (
              <View
                key={m.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 14,
                  paddingHorizontal: spacing.lg,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: colors.border,
                }}
              >
                <Text style={{ fontFamily: fontFamily.semibold, fontSize: 14, color: colors.text }}>
                  👤 {m.displayName}
                  {m.isMe ? ' (나)' : ''}
                </Text>
                <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>
                  {m.role === 'owner' ? '방장' : '함께 쓰는 중'}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* STEP 16-G1B §5, hardened in STEP 16-G1B-FIX: the safe entry point
          into the existing (read-only) finance UI. Always rendered
          (owner AND member) — only `disabled`/label change with
          `financeReady`. Requires session + activeHousehold + a
          COMPLETED, trusted remote fetch with no error; never enabled
          while still loading or after a failed fetch. */}
      <GradientButton
        label={
          financeReady
            ? '가계부 열기'
            : hasFinanceError
              ? '가계부 열기 (연결 실패)'
              : '가계부 불러오는 중…'
        }
        // `replace`, not `push`: this screen is the AuthGate landing target,
        // so pushing would leave it in the back stack and Android back on
        // the finance home would bounce here (household-home <-> household-
        // ready loop). Replacing swaps it out; back on the tabs root then
        // does the normal Android "exit / previous tab" thing.
        onPress={() => router.replace('/(tabs)')}
        disabled={!financeReady}
        style={{ width: '100%', maxWidth: 430, marginTop: spacing.xl }}
      />
      {hasFinanceError && (
        <Pressable onPress={() => void refreshRemoteFinance()} hitSlop={8} style={{ marginTop: spacing.sm }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 12, color: colors.primaryStrong }}>
            다시 시도
          </Text>
        </Pressable>
      )}

      {activeHousehold?.role === 'owner' && (
        <GradientButton
          label="배우자 초대하기"
          onPress={() => router.push('/household-invite')}
          style={{ width: '100%', maxWidth: 430, marginTop: spacing.md }}
        />
      )}

      {/* STEP 16-F1: owner-only, read-only preview of whether this
          device's existing local financial data could later be migrated
          into this household — never uploads anything. Not shown to
          members: see app/migration-preview.tsx header for why. */}
      {activeHousehold?.role === 'owner' && (
        <Pressable
          onPress={() => router.push('/migration-preview')}
          style={{
            width: '100%',
            maxWidth: 430,
            height: 48,
            borderRadius: radii.xl,
            borderWidth: 1.5,
            borderColor: colors.primaryLight,
            backgroundColor: colors.white,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: spacing.md,
          }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.primaryStrong }}>
            기존 데이터 연결 준비
          </Text>
        </Pressable>
      )}

      {/* STEP 16-G1A: read-only preview of this household's REMOTE
          financial data — reachable by owner AND member alike (same RLS
          predicate, same rows either way). Never writes anything, never
          opens the legacy (tabs) finance UI. See app/remote-data-preview.tsx. */}
      <Pressable
        onPress={() => router.push('/remote-data-preview')}
        style={{
          width: '100%',
          maxWidth: 430,
          height: 48,
          borderRadius: radii.xl,
          borderWidth: 1.5,
          borderColor: colors.primaryLight,
          backgroundColor: colors.white,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: spacing.md,
        }}
      >
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.primaryStrong }}>
          우리집 데이터 확인
        </Text>
      </Pressable>

      <Text
        style={{
          fontFamily: fontFamily.regular,
          fontSize: 12,
          color: colors.textMuted,
          textAlign: 'center',
          marginTop: spacing.xl,
        }}
      >
        거래 데이터 연결은 다음 단계에서 진행할게요.
      </Text>

      <Pressable onPress={() => void signOut()} hitSlop={8} style={{ marginTop: spacing.xxl }}>
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.expenseText }}>
          로그아웃
        </Text>
      </Pressable>
    </ScrollView>
  );
}
