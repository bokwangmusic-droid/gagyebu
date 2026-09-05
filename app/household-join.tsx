import { useRef, useState } from 'react';
import { View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { Field, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { useHousehold } from '@/store/household';
import { spacing } from '@/theme/tokens';

export default function HouseholdJoin() {
  const toast = useToast();
  const { joinWithCode } = useHousehold();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const canSubmit = code.trim().length > 0 && !submitting;

  const onSubmit = async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    const result = await joinWithCode(code);
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    // Success: HouseholdProvider's households refreshed ->
    // app/_layout.tsx's AuthGate redirects to /household-ready on its own.
  };

  return (
    <AuthShell title="배우자의 가계부 참여하기" subtitle={'전달받은 초대코드를\n입력해 주세요.'}>
      <View style={{ marginBottom: spacing.lg }}>
        <Field label="초대코드" hint="공백이나 - 는 그대로 입력해도 괜찮아요">
          <TextField
            value={code}
            onChangeText={setCode}
            placeholder="A1B2-C3D4-E5F6-1234-5678"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </Field>
        <GradientButton
          label={submitting ? '참여하는 중...' : '우리집 참여하기'}
          onPress={onSubmit}
          disabled={!canSubmit}
        />
      </View>
    </AuthShell>
  );
}
