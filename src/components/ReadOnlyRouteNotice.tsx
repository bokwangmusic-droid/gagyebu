/**
 * Shared "this screen isn't connected yet" notice — STEP 16-G1B.
 *
 * Rendered instead of a mutation screen's real form whenever
 * REMOTE_FINANCE_READ_ONLY is true (src/lib/financeMode.ts). Never calls
 * any store mutation, never touches Supabase — it's a dead end with a way
 * back, nothing else. Reused by every write-only route (input/card-add/
 * budget-add/recurring-add/planned-add/goal-add/loan-add/categories)
 * instead of writing the same notice eight times.
 */
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { ModalScreen } from '@/components/ui/ModalScreen';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export function ReadOnlyRouteNotice({ title = '조회 전용' }: { title?: string }) {
  const router = useRouter();

  return (
    <ModalScreen title={title} onClose={() => router.back()} scroll={false}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.xl,
          gap: spacing.md,
        }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: radii.pill,
            backgroundColor: colors.primaryLight,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name="cloud" size={28} color={colors.primaryStrong} />
        </View>
        <Text style={{ fontFamily: fontFamily.bold, fontSize: 16, color: colors.text, textAlign: 'center' }}>
          다음 업데이트에서 연결돼요
        </Text>
        <Text
          style={{
            fontFamily: fontFamily.regular,
            fontSize: 13,
            color: colors.textSub,
            textAlign: 'center',
            lineHeight: 19,
          }}
        >
          동기화 연결 중 · 지금은 우리집 가계부 데이터를{'\n'}조회만 할 수 있어요.
        </Text>
      </View>
    </ModalScreen>
  );
}

export default ReadOnlyRouteNotice;
