import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { PasswordField } from '@/components/auth/PasswordField';
import { Field, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/store/auth';
import { colors, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function SignUp() {
  const router = useRouter();
  const toast = useToast();
  const { signUp } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const submittingRef = useRef(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const canSubmit =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 6 &&
    confirm.length > 0 &&
    !submitting;

  const onSubmit = async () => {
    if (submittingRef.current || !canSubmit) return;
    if (password !== confirm) {
      toast.show('비밀번호가 서로 달라요');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    const result = await signUp({ name, email, password });
    submittingRef.current = false;
    setSubmitting(false);

    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    if (result.needsEmailConfirmation) {
      setAwaitingVerification(true);
      return;
    }
    // Session returned immediately (email confirmation off for this
    // project) -> AuthProvider's session updates and app/_layout.tsx's
    // AuthGate navigates on its own.
  };

  if (awaitingVerification) {
    return (
      <AuthShell title="" subtitle="회원가입">
        <View style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 17, color: colors.text }}>
            인증 메일을 보냈어요
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
            메일 인증을 완료한 뒤{'\n'}로그인해 주세요.
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
    <AuthShell title="회원가입" subtitle="내 돈부터 우리집 돈까지, 더 쉽게 관리해요">
      <View style={{ marginBottom: spacing.lg }}>
        <Field label="이름">
          <TextField
            value={name}
            onChangeText={setName}
            placeholder="이름"
            maxLength={20}
            returnKeyType="next"
            onSubmitEditing={() => emailRef.current?.focus()}
            blurOnSubmit={false}
          />
        </Field>
        <Field label="이메일">
          <TextField
            ref={emailRef}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            blurOnSubmit={false}
          />
        </Field>
        <Field label="비밀번호" hint="6자 이상으로 설정해주세요">
          <PasswordField
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            placeholder="비밀번호"
            autoCapitalize="none"
            autoComplete="password-new"
            textContentType="newPassword"
            returnKeyType="next"
            onSubmitEditing={() => confirmRef.current?.focus()}
            blurOnSubmit={false}
          />
        </Field>
        <Field label="비밀번호 확인">
          <PasswordField
            ref={confirmRef}
            value={confirm}
            onChangeText={setConfirm}
            placeholder="비밀번호 확인"
            autoCapitalize="none"
            autoComplete="password-new"
            textContentType="newPassword"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </Field>
        <GradientButton
          label={submitting ? '가입 중...' : '돈돈 시작하기'}
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
          이미 계정이 있나요?{' '}
          <Text style={{ fontFamily: fontFamily.bold, color: colors.primaryStrong }}>로그인</Text>
        </Text>
      </Pressable>
    </AuthShell>
  );
}
