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
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: radii.pill,
        // BATCH 4-C: no longer the primary-lavender accent — writes are open
        // now (src/lib/financeMode.ts), so this is just a quiet context
        // label, not a state worth visually competing with the home
        // screen's real numbers above it.
        backgroundColor: colors.track,
      }}
    >
      <AppIcon name="cloud" size={11} color={colors.textMuted} />
      <Text style={{ fontFamily: fontFamily.semibold, fontSize: 10, color: colors.textMuted }}>
        우리집 가계부
      </Text>
    </View>
  );
}

export default FinanceReadOnlyBanner;
