/**
 * Password-reset request screen — STEP AUTH-F1.
 *
 * Reached from app/sign-in.tsx's "비밀번호를 잊으셨나요?" link. Collects an
 * email, sends it through `useAuth().resetPasswordForEmail` (which redirects
 * Supabase's recovery link to `RESET_PASSWORD_REDIRECT_TO` —
 * src/store/auth.tsx), and shows a generic "메일을 보냈어요" confirmation
 * regardless of whether the email is actually registered (anti-
 * enumeration — see that method's own doc). Mirrors app/sign-up.tsx's
 * `awaitingVerification` inline-success-panel pattern exactly.
 */
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { Field, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { isValidEmail } from '@/lib/authValidation';
import { useAuth } from '@/store/auth';
import { colors, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function ForgotPassword() {
  const router = useRouter();
  const toast = useToast();
  const { resetPasswordForEmail } = useAuth();

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const submittingRef = useRef(false); // guards against a double-tap racing the async call

  const canSubmit = isValidEmail(email) && !submitting;

  const onSubmit = async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    const result = await resetPasswordForEmail(email);
    submittingRef.current = false;
    setSubmitting(false);

    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <AuthShell title="" subtitle="비밀번호 재설정">
        <View style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 17, color: colors.text, textAlign: 'center' }}>
            비밀번호 재설정 메일을 보냈어요
          </Text>
          <Text
            style={{
              fontFamily: fontFamily.regular,
              fontSize: 14,
              color: colors.textSub,
              textAlign: 'center',
              lineHeight: 21,
              marginTop: 10,
            }}
          >
            메일의 링크를 눌러{'\n'}새 비밀번호를 설정해주세요.
          </Text>
          <GradientButton
            label="로그인 화면으로"
            onPress={() => router.replace('/sign-in')}
            style={{ width: '100%', marginTop: spacing.xxl }}
          />
        </View>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="비밀번호 재설정" subtitle="가입한 이메일로 재설정 링크를 보내드려요">
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
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </Field>
        <GradientButton
          label={submitting ? '전송 중...' : '재설정 메일 보내기'}
          onPress={onSubmit}
          disabled={!canSubmit}
        />
      </View>

      <Pressable
        onPress={() => router.replace('/sign-in')}
        hitSlop={8}
        style={{ alignItems: 'center', paddingVertical: spacing.md }}
      >
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub }}>
          <Text style={{ fontFamily: fontFamily.bold, color: colors.primaryStrong }}>로그인</Text> 화면으로 돌아가기
        </Text>
      </Pressable>
    </AuthShell>
  );
}
