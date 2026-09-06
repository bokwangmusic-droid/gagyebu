/**
 * Small "this is remote, read-only data" banner — STEP 16-G1B §19.
 *
 * Deliberately tiny and non-alarming (a pill, not a warning box) — every
 * screen using src/store/financeRead.ts's useFinanceRead() shows this once
 * near its top so the missing add/edit/delete affordances have an obvious
 * explanation, without turning the existing design into a big warning UI.
 */
import { Text, View } from 'react-native';

import { AppIcon } from '@/components/AppIcon';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export function FinanceReadOnlyBanner() {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        marginHorizontal: spacing.lg,
        marginBottom: spacing.sm,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: radii.pill,
        backgroundColor: colors.primaryLighter,
      }}
    >
      <AppIcon name="cloud" size={11} color={colors.primaryStrong} />
      <Text style={{ fontFamily: fontFamily.semibold, fontSize: 10, color: colors.primaryStrong }}>
        우리집 가계부 · 조회 전용
      </Text>
    </View>
  );
}

export default FinanceReadOnlyBanner;
