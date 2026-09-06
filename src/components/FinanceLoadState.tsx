/**
 * Loading/error placeholder for a useFinanceRead() screen — STEP 16-G1B.
 *
 * Every finance-viewing screen renders this INSTEAD of its real content
 * while `status !== 'ready'` (src/store/financeRead.ts) — never a silent
 * fallback to local data, never a false "0건" while still loading. Kept
 * intentionally plain (no screen-specific chrome) so it drops into
 * differently-wrapped screens (Screen/ModalScreen) the same way.
 */
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export function FinanceLoadState({
  status,
  error,
  onRetry,
}: {
  status: 'loading' | 'error';
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <View
      style={{
        marginHorizontal: spacing.lg,
        marginTop: spacing.md,
        padding: spacing.xl,
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.card,
      }}
    >
      {status === 'loading' ? (
        <>
          <ActivityIndicator color={colors.primary} />
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub }}>
            우리집 데이터를 불러오는 중이에요…
          </Text>
        </>
      ) : (
        <>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub, textAlign: 'center' }}>
            {error ?? '우리집 데이터를 불러오지 못했어요.'}
          </Text>
          {onRetry && (
            <Pressable onPress={onRetry} hitSlop={8}>
              <Text style={{ fontFamily: fontFamily.bold, fontSize: 13, color: colors.primaryStrong }}>
                다시 시도
              </Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

export default FinanceLoadState;
