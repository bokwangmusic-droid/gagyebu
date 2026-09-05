import { useRef, useState } from 'react';
import { View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { Field, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { useHousehold } from '@/store/household';
import { spacing } from '@/theme/tokens';

export default function HouseholdCreate() {
  const toast = useToast();
  const { createHousehold } = useHousehold();

  const [name, setName] = useState('우리집 가계부');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const canSubmit = name.trim().length > 0 && !submitting;

  const onSubmit = async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    const result = await createHousehold(name);
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    // Success: HouseholdProvider's households now has 1 entry ->
    // app/_layout.tsx's AuthGate redirects to /household-ready on its own.
  };

  return (
    <AuthShell title="우리집 가계부 만들기" subtitle={'둘이 함께 쓸\n우리집 이름을 정해주세요.'}>
      <View style={{ marginBottom: spacing.lg }}>
        <Field label="우리집 이름">
          <TextField
            value={name}
            onChangeText={setName}
            placeholder="우리집 가계부"
            maxLength={20}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </Field>
        <GradientButton
          label={submitting ? '만드는 중...' : '만들기'}
          onPress={onSubmit}
          disabled={!canSubmit}
        />
      </View>
    </AuthShell>
  );
}
