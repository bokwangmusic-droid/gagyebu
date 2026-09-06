/**
 * "우리집 데이터 확인" — STEP 16-G1A.
 *
 * Read-only preview of this household's REMOTE financial data (Supabase),
 * fetched via src/services/remoteFinance.ts, mapped to local domain types
 * via src/lib/remoteFinanceMapping.ts, and held only in
 * src/store/remoteFinance.tsx's in-memory RemoteFinanceProvider — never
 * written to AsyncStorage, never merged into StoreProvider's state, never
 * used to open the legacy (tabs) finance UI. Reachable by BOTH owner and
 * member (app/household-ready.tsx) since every finance-table SELECT policy
 * (supabase/migrations/20260905000400_rls.sql) uses the exact same
 * `private.is_household_member(household_id)` predicate for both roles —
 * unlike app/migration-preview.tsx, which stays owner-only because ITS
 * data source (this device's local AsyncStorage) has no reliable
 * per-household/per-user ownership signal at all.
 *
 * No financial write button exists anywhere on this screen, on purpose —
 * STEP 16-G1A is fetch + map + display only.
 */
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/AppIcon';
import { useToast } from '@/components/ui/Toast';
import { fmt } from '@/lib/format';
import {
  remoteFinanceCounts,
  totalRemoteFinanceCount,
  type RemoteFinanceCounts,
} from '@/lib/remoteFinanceMapping';
import { useAuth } from '@/store/auth';
import { useHousehold } from '@/store/household';
import { useRemoteFinance } from '@/store/remoteFinance';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

const COUNT_ROWS: { key: keyof RemoteFinanceCounts; label: string }[] = [
  { key: 'transactions', label: '거래' },
  { key: 'cards', label: '카드' },
  { key: 'budgets', label: '예산' },
  { key: 'recurring', label: '반복 내역' },
  { key: 'planned', label: '예정 지출' },
  { key: 'goals', label: '저축 목표' },
  { key: 'loans', label: '대출' },
  { key: 'customCategories', label: '커스텀 카테고리' },
];

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        width: '100%',
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.card,
        overflow: 'hidden',
        marginTop: spacing.md,
      }}
    >
      {children}
    </View>
  );
}

function CountRow({ label, value, isLast }: { label: string; value: number; isLast: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text style={{ fontFamily: fontFamily.medium, fontSize: 14, color: colors.text }}>{label}</Text>
      <Text style={{ fontFamily: fontFamily.bold, fontSize: 14, color: colors.text }}>
        {value > 0 ? `${fmt(value)}건` : '없음'}
      </Text>
    </View>
  );
}

function CheckRow({ label, isLast }: { label: string; isLast: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <AppIcon name="target" size={16} color={colors.incomeStrong} />
      <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.text, flex: 1 }}>{label}</Text>
    </View>
  );
}

export default function RemoteDataPreview() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { activeHousehold } = useHousehold();
  const { data, loading, error, loadedForHouseholdId, loadedForUserId, refreshRemoteFinance } =
    useRemoteFinance();

  // STEP 16-G1A-HARDEN: minimum trust condition, checked again right here
  // at render time — never assume the provider's `data` is for the
  // CURRENT session/household just because it's non-null. Requires BOTH
  // the current user id AND the current household id to match what the
  // completed fetch was actually for — this is the second, independent
  // line of defense on top of RemoteFinanceProvider's own requestKeyRef
  // guard (src/store/remoteFinance.tsx), specifically closing the
  // one-frame window where, during an A -> B account switch, a still-
  // matching `loadedForHouseholdId` from A could otherwise be read as
  // trustworthy before the provider's effect has cleared it.
  const isTrusted =
    !!session?.user?.id &&
    !!activeHousehold &&
    !!data &&
    loadedForUserId === session.user.id &&
    loadedForHouseholdId === activeHousehold.id;
  const counts = isTrusted && data ? remoteFinanceCounts(data) : null;
  const total = counts ? totalRemoteFinanceCount(counts) : 0;

  const handleReload = () => {
    void refreshRemoteFinance();
    toast.show('다시 불러오는 중이에요');
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: spacing.xl,
        alignItems: 'center',
      }}
    >
      <View style={{ width: '100%', maxWidth: 430 }}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={{ marginBottom: spacing.lg }}>
          <AppIcon name="chev-left" size={22} color={colors.text} />
        </Pressable>

        <Text style={{ fontFamily: fontFamily.extrabold, fontSize: 20, color: colors.text }}>
          우리집 데이터 확인
        </Text>

        {!activeHousehold ? (
          <Card>
            <View style={{ padding: spacing.lg }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, lineHeight: 20 }}>
                연결된 우리집 가계부가 없어요.
              </Text>
            </View>
          </Card>
        ) : error && !isTrusted ? (
          <Card>
            <View style={{ padding: spacing.lg }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, lineHeight: 20 }}>
                {error}
              </Text>
            </View>
          </Card>
        ) : loading && !isTrusted ? (
          <Card>
            <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.md }}>
              <ActivityIndicator color={colors.primary} />
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub }}>
                우리집 데이터를 불러오는 중이에요…
              </Text>
            </View>
          </Card>
        ) : isTrusted && total === 0 ? (
          <Card>
            <View style={{ padding: spacing.lg }}>
              <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, lineHeight: 20 }}>
                우리집 가계부 데이터가 아직 없어요.
              </Text>
            </View>
          </Card>
        ) : isTrusted ? (
          <Card>
            {COUNT_ROWS.map((row, i) => (
              <CountRow
                key={row.key}
                label={row.label}
                value={counts![row.key]}
                isLast={i === COUNT_ROWS.length - 1}
              />
            ))}
          </Card>
        ) : (
          <Card>
            <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.md }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          </Card>
        )}

        {activeHousehold && (
          <>
            <Text
              style={{
                fontFamily: fontFamily.bold,
                fontSize: 12,
                color: colors.textSub,
                marginTop: spacing.xl,
                marginBottom: -4,
              }}
            >
              읽기 상태
            </Text>
            <Card>
              <CheckRow label="Supabase 연결됨" isLast={false} />
              <CheckRow
                label={isTrusted ? '현재 household 데이터 읽기 완료' : '현재 household 데이터 읽는 중'}
                isLast={false}
              />
              <CheckRow label="로컬 저장소에는 기록하지 않음" isLast />
            </Card>
          </>
        )}

        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 12,
            color: colors.textMuted,
            textAlign: 'center',
            marginTop: spacing.lg,
            lineHeight: 18,
          }}
        >
          지금은 미리 보기만 할 수 있어요.{'\n'}
          가계부 화면 자체는 다음 업데이트에서 열릴 예정이에요.
        </Text>

        <Pressable
          onPress={handleReload}
          hitSlop={8}
          style={{ alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.xl }}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
            다시 불러오기
          </Text>
        </Pressable>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={{ alignItems: 'center', paddingVertical: spacing.sm }}
        >
          <Text style={{ fontFamily: fontFamily.medium, fontSize: 13, color: colors.textMuted }}>
            돌아가기
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
