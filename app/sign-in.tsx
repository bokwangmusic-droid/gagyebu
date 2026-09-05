import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { Field, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/store/auth';
import { colors, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function SignIn() {
  const router = useRouter();
  const toast = useToast();
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false); // guards against a double-tap racing the async call

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const onSubmit = async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    const result = await signIn({ email, password });
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    // Success: AuthProvider's session updates -> app/_layout.tsx's AuthGate
    // reacts and navigates on its own. No router call needed here.
  };

  return (
    <AuthShell title="로그인" subtitle={'둘이 함께 쓰면\n돈 관리가 더 쉬워져요.'}>
      <View style={{ marginBottom: spacing.lg }}>
        <Field label="이메일">
          <TextField
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="next"
          />
        </Field>
        <Field label="비밀번호">
          <TextField
            value={password}
            onChangeText={setPassword}
            placeholder="비밀번호"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password"
            textContentType="password"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </Field>
        <GradientButton
          label={submitting ? '로그인 중...' : '로그인'}
          onPress={onSubmit}
          disabled={!canSubmit}
        />
      </View>

      <Pressable
        onPress={() => router.replace('/sign-up')}
        hitSlop={8}
        style={{ alignItems: 'center', paddingVertical: spacing.md }}
      >
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub }}>
          처음이신가요?{' '}
          <Text style={{ fontFamily: fontFamily.bold, color: colors.primaryStrong }}>회원가입</Text>
        </Text>
      </Pressable>
    </AuthShell>
  );
}
