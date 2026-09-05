/**
 * Shown only when a signed-in user belongs to more than one household
 * (STEP 16-E §7) — a rare edge case (e.g. redeemed two different invite
 * codes), but never resolved by silently guessing one: the user always
 * picks explicitly.
 */
import { Pressable, Text, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { useHousehold } from '@/store/household';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function HouseholdSelect() {
  const { households, selectHousehold } = useHousehold();

  return (
    <AuthShell title="가계부 선택" subtitle={'함께 쓸 우리집을\n선택해 주세요.'}>
      <View style={{ gap: spacing.sm }}>
        {households.map((h) => (
          <Pressable
            key={h.id}
            onPress={() => selectHousehold(h.id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: 14,
              paddingHorizontal: spacing.lg,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radii.lg,
            }}
          >
            <Text style={{ fontFamily: fontFamily.semibold, fontSize: 15, color: colors.text }}>
              {h.name}
            </Text>
            <Text style={{ fontFamily: fontFamily.medium, fontSize: 12, color: colors.textSub }}>
              {h.role === 'owner' ? '방장' : '멤버'}
            </Text>
          </Pressable>
        ))}
      </View>
    </AuthShell>
  );
}
