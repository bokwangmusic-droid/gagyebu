import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { PasswordField } from '@/components/auth/PasswordField';
import { Field, TextField } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/store/auth';
import { colors, radii, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

export default function SignIn() {
  const router = useRouter();
  const toast = useToast();
  const { signIn, signInWithKakao } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false); // guards against a double-tap racing the async call
  const passwordRef = useRef<TextInput>(null);

  // Kakao-OAuth STEP 1 — separate busy state from the email form's
  // `submitting`, mirrors the same submittingRef-guard pattern as onSubmit
  // above. `signInWithKakao()` resolving `{ok:true}` only means the browser
  // page opened; a real session arrives later out of band (app/_layout.tsx),
  // so this never itself navigates anywhere on success.
  const [kakaoSubmitting, setKakaoSubmitting] = useState(false);
  const kakaoSubmittingRef = useRef(false);

  const onKakaoPress = async () => {
    if (kakaoSubmittingRef.current) return;
    kakaoSubmittingRef.current = true;
    setKakaoSubmitting(true);
    const result = await signInWithKakao();
    kakaoSubmittingRef.current = false;
    setKakaoSubmitting(false);
    if (!result.ok) {
      toast.show(result.message);
    }
  };

  const onSubmit = async () => {
    if (submittingRef.current) return; // duplicate-submit guard (unchanged)

    // UX fix: tell the user exactly what's missing instead of silently doing
    // nothing, for BOTH entry points (keyboard "완료" and the button below —
    // both call this same onSubmit). Checked before touching submittingRef/
    // setSubmitting so a validation toast never flips the button into
    // "로그인 중...".
    const hasEmail = email.trim().length > 0;
    const hasPassword = password.length > 0;
    if (!hasEmail && !hasPassword) {
      toast.show('이메일과 비밀번호를 입력해주세요');
      return;
    }
    if (!hasEmail) {
      toast.show('이메일을 입력해주세요');
      return;
    }
    if (!hasPassword) {
      toast.show('비밀번호를 입력해주세요');
      return;
    }

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
    <AuthShell compact title="로그인" subtitle="내 돈부터 우리집 돈까지, 더 쉽게 관리해요">
      <View style={{ marginBottom: spacing.lg }}>
        <Field label="이메일" style={{ marginBottom: 12 }}>
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
            onSubmitEditing={() => passwordRef.current?.focus()}
            blurOnSubmit={false}
            style={{ paddingVertical: 10 }}
          />
        </Field>
        <Field label="비밀번호" style={{ marginBottom: 12 }}>
          <PasswordField
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            placeholder="비밀번호"
            autoCapitalize="none"
            autoComplete="password"
            textContentType="password"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            style={{ paddingVertical: 10 }}
            // Android root cause: this field is `secureTextEntry`, and on
            // several OEM keyboards a masked/password EditText's "완료" key
            // is delivered as a raw KEYCODE_ENTER key event
            // (ReactEditTextInputConnectionWrapper -> onKeyPress "Enter")
            // instead of the performEditorAction() call onSubmitEditing
            // relies on (setOnEditorActionListener in
            // ReactTextInputManager.kt) — confirmed by reading RN's own
            // Android TextInput source; both dispatch paths exist natively,
            // but only IME actions reach onSubmitEditing. The screen's
            // "로그인" button never goes through either path, which is why
            // it always worked while the keyboard's "완료" silently did
            // nothing. Reuses the EXACT same onSubmit as the button and the
            // "next" chain above; its own submittingRef/empty-field guards
            // make this a no-op if onSubmitEditing also fires for the same
            // press. Android-only: iOS already fires onSubmitEditing
            // reliably, so this stays a pure no-op there.
            onKeyPress={
              Platform.OS === 'android'
                ? ({ nativeEvent }) => {
                    if (nativeEvent.key === 'Enter') onSubmit();
                  }
                : undefined
            }
          />
        </Field>
        <Pressable
          onPress={() => router.push('/forgot-password')}
          hitSlop={8}
          style={{ alignSelf: 'flex-end', marginTop: -8, marginBottom: 8 }}
        >
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSub }}>
            비밀번호를 잊으셨나요?
          </Text>
        </Pressable>
        <GradientButton
          label={submitting ? '로그인 중...' : '로그인'}
          onPress={onSubmit}
          // UX fix: no longer disabled just because a field is empty — a tap
          // now reaches onSubmit's own validation toast instead of doing
          // nothing. Still disabled while a signIn is actually in flight, so
          // this remains the duplicate-submit guard for the button itself
          // (submittingRef inside onSubmit guards the keyboard-"완료" path).
          disabled={submitting}
          height={48}
        />

        {/* Kakao-OAuth STEP 1 — 1차 기능 테스트 단계: 로고/이미지 asset 없이
            텍스트 버튼만. 카카오 브랜드 색(#FEE500 배경 / #191919 텍스트),
            기존 로그인 버튼과 동일한 높이(54)·라운드(radii.xl) 계열. */}
        <Pressable
          onPress={() => void onKakaoPress()}
          disabled={kakaoSubmitting}
          style={({ pressed }) => ({
            marginTop: 10,
            height: 48,
            borderRadius: radii.xl,
            backgroundColor: '#FEE500',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: kakaoSubmitting ? 0.6 : pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 16, color: '#191919' }}>
            {kakaoSubmitting ? '카카오 로그인 여는 중...' : '카카오로 로그인'}
          </Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => router.replace('/sign-up')}
        hitSlop={8}
        style={{ alignItems: 'center', paddingVertical: 8 }}
      >
        <Text style={{ fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSub }}>
          처음이신가요?{' '}
          <Text style={{ fontFamily: fontFamily.bold, color: colors.primaryStrong }}>회원가입</Text>
        </Text>
      </Pressable>
    </AuthShell>
  );
}
