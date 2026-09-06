/**
 * Temporary post-household landing screen — STEP 16-E.
 *
 * Every signed-in user with exactly one (active) household lands here, and
 * ONLY here — see app/_layout.tsx's AuthGate. The existing local-first app
 * (onboarding + (tabs) + every modal screen, all still backed by
 * StoreProvider/AsyncStorage, completely untouched) stays deliberately
 * unreachable: local->household data migration hasn't been designed yet,
 * so there is still no safe way to open the financial screens. This
 * screen replaces STEP 16-D's app/auth-ready.tsx, which is removed now
 * that this one exists (see completion report).
 */
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GradientButton } from '@/components/ui/GradientButton';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function HouseholdReady() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const { activeHousehold, members, membersLoading } = useHousehold();

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

      {activeHousehold?.role === 'owner' && (
        <GradientButton
          label="배우자 초대하기"
          onPress={() => router.push('/household-invite')}
          style={{ width: '100%', maxWidth: 430, marginTop: spacing.xl }}
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
