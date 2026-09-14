/**
 * Password-recovery landing + new-password screen — STEP AUTH-F1.
 *
 * Supabase's password-reset email redirects to `gagyebu://reset-password`
 * (`RESET_PASSWORD_REDIRECT_TO = Linking.createURL('reset-password')`,
 * src/store/auth.tsx). app/_layout.tsx's `PasswordRecoveryLinkGate` is the
 * sole entry point that reads that incoming link (this client runs with
 * `detectSessionInUrl: false`, src/lib/supabase.ts — deliberately, see
 * app/auth-callback.tsx's header — so nothing auto-parses it) and forwards
 * here via `router.replace(...)`, with the recovery tokens riding along as
 * ROUTE PARAMS — available on this screen's very first render, no URL
 * re-parsing needed in this file at all.
 *
 *   1. Read `access_token`/`refresh_token` from `useLocalSearchParams()`.
 *   2. If both are present, call `supabase.auth.setSession(...)`
 *      (AuthProvider's existing `onAuthStateChange` listener picks up the
 *      resulting session automatically — no new listener needed here).
 *   3. Show the new-password form; on save, `useAuth().updatePassword(...)`.
 *
 * A `RECOVERY_TIMEOUT_MS` safety net moves `'checking'` to `'invalid'` if no
 * usable params ever arrive (a direct visit, an expired/already-used link
 * whose fragment carries no tokens, or any other reason `establish` never
 * runs) — the worst case is "please request a new link", never an infinite
 * "확인하는 중..." hang.
 *
 * app/_layout.tsx's `AuthGate` is taught to treat this ONE route as exempt
 * from its normal session/household redirect — otherwise the recovery
 * session becoming truthy the instant `setSession` resolves would bounce
 * the user straight to home before they can type a new password. A user
 * with NO valid recovery context sees an explicit notice instead of an
 * active password form — the form is never enabled without a confirmed
 * recovery session.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { AuthShell } from '@/components/auth/AuthShell';
import { PasswordField } from '@/components/auth/PasswordField';
import { Field } from '@/components/ui/controls';
import { GradientButton } from '@/components/ui/GradientButton';
import { useToast } from '@/components/ui/Toast';
import { MIN_PASSWORD_LENGTH, isValidNewPasswordForm } from '@/lib/authValidation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/store/auth';
import { colors, spacing } from '@/theme/tokens';
import { fontFamily } from '@/theme/typography';

type ScreenState = 'checking' | 'ready' | 'invalid' | 'done';

/** Upper bound on how long 'checking' may show before giving up and asking
 *  the user to request a fresh link — see this file's own header. */
const RECOVERY_TIMEOUT_MS = 8000;

export default function ResetPassword() {
  const router = useRouter();
  const toast = useToast();
  const { updatePassword } = useAuth();
  // app/_layout.tsx's `PasswordRecoveryLinkGate` already parsed the incoming
  // recovery link (cold OR warm start) and forwarded the tokens as route
  // params, which Expo Router resolves SYNCHRONOUSLY before this screen's
  // first render — no URL parsing needed in this file.
  const params = useLocalSearchParams<{ access_token?: string; refresh_token?: string }>();

  const [state, setState] = useState<ScreenState>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const confirmRef = useRef<TextInput>(null);
  // A recovery token is single-use — establish the session from it AT MOST
  // once per mount, even if a URL arrives again later for some other reason.
  const establishedRef = useRef(false);

  useEffect(() => {
    const establish = async (accessToken: string, refreshToken: string) => {
      if (establishedRef.current) return;
      establishedRef.current = true;
      // Never logged: access_token / refresh_token stay in local variables
      // only, passed straight to setSession.
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      setState(error ? 'invalid' : 'ready');
    };

    if (typeof params.access_token === 'string' && typeof params.refresh_token === 'string') {
      void establish(params.access_token, params.refresh_token);
    }

    // Backstop: never let 'checking' persist indefinitely — covers a direct
    // visit with no params, an expired/already-used link (whose fragment
    // carries no tokens, so PasswordRecoveryLinkGate never had any to
    // forward), a hung setSession, or anything else not anticipated above.
    const timer = setTimeout(() => {
      if (!establishedRef.current) {
        establishedRef.current = true;
        setState('invalid');
      }
    }, RECOVERY_TIMEOUT_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = state === 'ready' && isValidNewPasswordForm(password, confirm) && !submitting;

  const onSubmit = async () => {
    if (submittingRef.current || !canSubmit) return;
    if (password !== confirm) {
      toast.show('비밀번호가 서로 달라요');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    const result = await updatePassword(password);
    submittingRef.current = false;
    setSubmitting(false);

    if (!result.ok) {
      toast.show(result.message);
      return;
    }
    setState('done');
  };

  if (state === 'checking') {
    return (
      <AuthShell title="" subtitle="비밀번호 재설정">
        <View style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <Text style={{ fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSub }}>
            확인하는 중...
          </Text>
        </View>
      </AuthShell>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthShell title="" subtitle="비밀번호 재설정">
        <View style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 17, color: colors.text, textAlign: 'center' }}>
            재설정 링크가 만료되었거나{'\n'}유효하지 않아요
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
            비밀번호 재설정 메일을 다시 요청해주세요.
          </Text>
          <GradientButton
            label="재설정 메일 다시 요청하기"
            onPress={() => router.replace('/forgot-password')}
            style={{ width: '100%', marginTop: spacing.xxl }}
          />
        </View>
      </AuthShell>
    );
  }

  if (state === 'done') {
    return (
      <AuthShell title="" subtitle="비밀번호 재설정">
        <View style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <Text style={{ fontFamily: fontFamily.bold, fontSize: 17, color: colors.text }}>
            비밀번호를 변경했어요
          </Text>
          <GradientButton
            label="계속하기"
            onPress={() => router.replace('/')}
            style={{ width: '100%', marginTop: spacing.xxl }}
          />
        </View>
      </AuthShell>
    );
  }

  // state === 'ready'
  return (
    <AuthShell title="새 비밀번호 설정" subtitle="비밀번호 재설정">
      <View style={{ marginBottom: spacing.lg }}>
        <Field label="새 비밀번호" hint={`${MIN_PASSWORD_LENGTH}자 이상으로 설정해주세요`}>
          <PasswordField
            value={password}
            onChangeText={setPassword}
            placeholder="새 비밀번호"
            autoCapitalize="none"
            autoComplete="password-new"
            textContentType="newPassword"
            returnKeyType="next"
            onSubmitEditing={() => confirmRef.current?.focus()}
          />
        </Field>
        <Field label="새 비밀번호 확인">
          <PasswordField
            ref={confirmRef}
            value={confirm}
            onChangeText={setConfirm}
            placeholder="새 비밀번호 확인"
            autoCapitalize="none"
            autoComplete="password-new"
            textContentType="newPassword"
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </Field>
        <GradientButton
          label={submitting ? '변경 중...' : '비밀번호 변경'}
          onPress={onSubmit}
          disabled={!canSubmit}
        />
      </View>
    </AuthShell>
  );
}
