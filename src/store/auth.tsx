/**
 * Auth state — STEP 16-D.
 *
 * Mirrors src/store/store.tsx's shape (Context + a small provider, no
 * external state library) but is intentionally its own tree: this STEP only
 * wires Supabase Auth + a session gate in front of the existing app. It does
 * not touch StoreProvider, does not create/join a household, and does not
 * sync any gagyebu.* data — see app/_layout.tsx for how the two providers
 * are composed and gated.
 */
import type { Session, User } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { clearPersistedSupabaseAuth, supabase } from '@/lib/supabase';

/**
 * STEP 16-D1: where Supabase's confirmation email sends the browser after
 * verifying the signup token, instead of its default Site URL (localhost).
 * `Linking.createURL` builds this from app.json's `scheme` ("gagyebu") —
 * `gagyebu://auth-callback` in a dev-client/standalone build, or an
 * `exp://host/--/auth-callback` URL when running in Expo Go — so nothing is
 * hardcoded per environment. Must also be added to Supabase Dashboard →
 * Authentication → URL Configuration → Redirect URLs, or Supabase will
 * reject it and fall back to the Site URL again (see completion report).
 */
const EMAIL_REDIRECT_TO = Linking.createURL('auth-callback');

/**
 * STEP AUTH-F1: where Supabase's password-reset email sends the browser
 * after verifying the recovery token — mirrors `EMAIL_REDIRECT_TO` exactly
 * (same `Linking.createURL` mechanism, same scheme, just a different
 * in-app route). Supabase's default (implicit-flow) redirect appends the
 * new session as a URL FRAGMENT (`#access_token=...&refresh_token=...&
 * type=recovery`, or `#error=...` on an expired/used link) — this client
 * runs with `detectSessionInUrl: false` (src/lib/supabase.ts), so nothing
 * auto-parses that fragment; app/reset-password.tsx reads it itself via
 * `expo-linking` and calls `supabase.auth.setSession(...)` explicitly. Must
 * also be added to Supabase Dashboard → Authentication → URL Configuration
 * → Redirect URLs (see the completion report) or Supabase will reject it
 * and fall back to the Site URL, exactly like `EMAIL_REDIRECT_TO`.
 */
const RESET_PASSWORD_REDIRECT_TO = Linking.createURL('reset-password');

/** The row STEP 16-C's handle_new_user() trigger creates in public.profiles. */
export interface AuthProfile {
  id: string;
  displayName: string;
}

export type AuthActionResult =
  | { ok: true }
  | { ok: false; message: string };

export type SignUpResult =
  | { ok: true; needsEmailConfirmation: boolean }
  | { ok: false; message: string };

/**
 * `canceled: true` = the user dismissed Apple's own sheet — not an error, so
 * the caller must stay silent (no toast) instead of showing `message`.
 */
export type AppleSignInResult =
  | { ok: true }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; message: string };

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  /** True until the initial stored-session check resolves. */
  loading: boolean;

  /** The signed-in user's public.profiles row, once fetched. Never blocks navigation. */
  profile: AuthProfile | null;
  /** True while the current session's profiles row is being (re-)fetched. */
  profileLoading: boolean;
  /** True if a session exists but its profiles row could not be found/read. */
  profileError: boolean;

  signUp(params: { name: string; email: string; password: string }): Promise<SignUpResult>;
  signIn(params: { email: string; password: string }): Promise<AuthActionResult>;
  /**
   * Kakao-OAuth STEP 1 — starts the Supabase `signInWithOAuth({ provider:
   * 'kakao' })` flow with `skipBrowserRedirect: true` (so this app opens the
   * browser itself via `Linking.openURL`, rather than relying on a
   * `window.location` redirect that doesn't exist in React Native) and the
   * SAME `EMAIL_REDIRECT_TO` the existing email-confirmation flow already
   * uses — one fewer Supabase Redirect URL to register, not a new one.
   * Resolving `{ok:true}` means only "the Kakao browser page was opened" —
   * it does NOT mean signed in yet. The actual session is established later,
   * out of band, when the OAuth redirect lands back on `auth-callback` and
   * app/_layout.tsx's `PasswordRecoveryLinkGate` (shared `Linking` listener)
   * calls `supabase.auth.setSession(...)` with the fragment's tokens; this
   * provider's existing `onAuthStateChange` subscription then picks that up
   * exactly like every other sign-in path, with no separate wiring needed
   * here.
   */
  signInWithKakao(): Promise<AuthActionResult>;
  /**
   * iOS-only native Sign in with Apple. Unlike `signInWithKakao` there is no
   * browser round-trip: Apple's sheet returns an identity token in-process,
   * which `supabase.auth.signInWithIdToken({ provider: 'apple' })` exchanges
   * for a session — so `{ok:true}` here DOES mean signed in, and the existing
   * `onAuthStateChange` subscription + app/_layout.tsx's AuthGate take over
   * from there (no navigation from the caller). Sign-up and sign-in are the
   * same call: Supabase creates the auth.users row on first use.
   */
  signInWithApple(): Promise<AppleSignInResult>;
  signOut(): Promise<void>;
  /**
   * AUTH-F2-B — local-only session cleanup AFTER the delete-account Edge
   * Function has already returned confirmed success. Never call this as a
   * pre-delete step. It must converge even when GoTrue can no longer find
   * the just-deleted user or the network disappears after the success
   * response, so it combines the public local-scope signOut path with a
   * direct clear of this client's persisted auth key.
   */
  clearLocalSessionAfterAccountDeletion(): Promise<AuthActionResult>;
  /**
   * STEP AUTH-F1 — send a password-reset email via Supabase Auth
   * (`resetPasswordForEmail`), redirecting the recovery link to
   * `RESET_PASSWORD_REDIRECT_TO`. Anti-enumeration: Supabase itself never
   * reveals whether the email is registered (this call succeeds either
   * way), and `describeAuthError`'s fallback is already a generic,
   * non-revealing message for any other failure — so the caller can
   * always show its OWN generic "메일을 보냈어요" copy on `{ok:true}` without
   * a separate "not found" branch to avoid here.
   */
  resetPasswordForEmail(email: string): Promise<AuthActionResult>;
  /**
   * STEP AUTH-F1 — change the CURRENTLY authenticated session's password
   * (`supabase.auth.updateUser({ password })`). Requires an active session
   * — for the password-recovery flow, app/reset-password.tsx establishes
   * one itself (via `supabase.auth.setSession(...)` from the parsed
   * recovery-link fragment) before this is ever callable. No re-auth
   * challenge beyond "there is a live session" — same trust level
   * `updateDisplayName` already relies on.
   */
  updatePassword(newPassword: string): Promise<AuthActionResult>;
  /**
   * Update the CURRENT account's `public.profiles.display_name` (self-only,
   * RLS-enforced). Re-checks the live session first and refuses if it no
   * longer matches the context's user (stale-account guard). On success the
   * authoritative returned row replaces `profile` — no optimistic UI, no
   * local-settings write.
   */
  updateDisplayName(name: string): Promise<AuthActionResult>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Supabase/GoTrue error messages -> friendly Korean copy. Falls back to a
 * generic message rather than surfacing the raw error to the user or a log.
 */
function describeAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const m = raw.toLowerCase();

  if (m.includes('invalid login credentials')) return '이메일 또는 비밀번호가 올바르지 않아요';
  if (m.includes('email not confirmed')) return '이메일 인증을 아직 완료하지 않았어요. 메일함을 확인해주세요';
  if (m.includes('already registered')) return '이미 가입된 이메일이에요';
  // STEP AUTH-F1: `updateUser({ password })` returns THIS specific message
  // when the new password matches the current one — checked BEFORE the
  // generic "at least"/"should be" length-policy branch below, since
  // Supabase's own wording for this case also happens to contain "should be".
  if (m.includes('password') && m.includes('different from the old password'))
    return '새 비밀번호가 이전 비밀번호와 같아요. 다른 비밀번호를 입력해주세요';
  if (m.includes('password') && (m.includes('at least') || m.includes('should be')))
    return '비밀번호는 6자 이상으로 설정해주세요';
  if (m.includes('rate limit') || m.includes('too many'))
    return '요청이 많아 잠시 제한됐어요. 잠깐 후 다시 시도해주세요';
  if (m.includes('network') || m.includes('fetch')) return '네트워크 연결을 확인해주세요';
  return '문제가 발생했어요. 잠시 후 다시 시도해주세요';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(false);
  const mountedRef = useRef(true);
  // Bumped whenever signInWithApple writes the profile row itself, so a
  // profile fetch that started BEFORE that write (the session effect below
  // races it on a fresh sign-in) can't land afterwards and put the old name
  // back.
  const profileWriteSeqRef = useRef(0);

  // ---- restore + subscribe ----
  useEffect(() => {
    mountedRef.current = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mountedRef.current) return;
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mountedRef.current) return;
      // SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / INITIAL_SESSION all just
      // become "here is the current session" — no per-event branching or
      // extra requests needed here.
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      mountedRef.current = false;
      subscription.unsubscribe();
    };
  }, []);

  // ---- confirm the trigger-created profile row exists (§10) ----
  // Read-only, self-only (`.eq('id', ...)` — RLS also enforces this), and
  // never blocks navigation (household-ready and others): a missing row
  // surfaces as `profileError` instead of an infinite loading state. Re-runs
  // on every account switch, so `profile` is ALWAYS the live session's own
  // row and can never carry another account's name across a sign-out.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setProfile(null);
      setProfileError(false);
      setProfileLoading(false);
      return;
    }
    let cancelled = false;
    const writeSeqAtStart = profileWriteSeqRef.current;
    setProfileLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name')
        .eq('id', uid)
        .maybeSingle();
      if (cancelled) return;
      // A newer authoritative row was already adopted while this was in flight.
      if (profileWriteSeqRef.current !== writeSeqAtStart) return;
      if (error || !data) {
        setProfile(null);
        setProfileError(true);
        setProfileLoading(false);
        return;
      }
      setProfileError(false);
      setProfile({ id: data.id, displayName: data.display_name });
      setProfileLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const signUp: AuthContextValue['signUp'] = useCallback(async ({ name, email, password }) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { display_name: name.trim() },
        emailRedirectTo: EMAIL_REDIRECT_TO,
      },
    });
    if (error) return { ok: false, message: describeAuthError(error) };

    // Supabase's anti-enumeration behaviour: signing up with an email that
    // is already registered returns 200 with no `error`, but a `user` whose
    // `identities` array is empty instead of a duplicate-email error.
    if (data.user && data.user.identities?.length === 0) {
      return { ok: false, message: '이미 가입된 이메일이에요' };
    }

    return { ok: true, needsEmailConfirmation: !data.session };
  }, []);

  const signIn: AuthContextValue['signIn'] = useCallback(async ({ email, password }) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) return { ok: false, message: describeAuthError(error) };
    return { ok: true };
  }, []);

  /**
   * Kakao-OAuth STEP 1 — see the interface doc above for the full flow.
   * Client ID/Secret are never referenced here — Supabase Dashboard already
   * holds them (Authentication -> Providers -> Kakao), exactly like every
   * other provider Supabase manages server-side.
   */
  const signInWithKakao: AuthContextValue['signInWithKakao'] = useCallback(async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        redirectTo: EMAIL_REDIRECT_TO,
        skipBrowserRedirect: true,
      },
    });
    if (error) return { ok: false, message: describeAuthError(error) };
    if (!data.url) {
      return { ok: false, message: '카카오 로그인을 시작하지 못했어요. 잠시 후 다시 시도해주세요' };
    }
    try {
      await Linking.openURL(data.url);
    } catch {
      return { ok: false, message: '카카오 로그인 페이지를 열지 못했어요. 잠시 후 다시 시도해주세요' };
    }
    return { ok: true };
  }, []);

  /**
   * Sign in with Apple — see the interface doc above for the flow.
   *
   * Both native modules are imported lazily, inside the iOS-only branch:
   * `expo-crypto` resolves its native module eagerly at import time, so a
   * top-level import here would run on Android at app start too — including
   * on an already-shipped binary that predates these modules and receives
   * this JS as an OTA update.
   *
   * Nonce: Apple embeds whatever nonce it is given into the identity token
   * verbatim, and Supabase verifies `sha256(nonce it receives) === token's
   * nonce claim`. So Apple gets the SHA-256 hex digest and Supabase gets the
   * raw value — the raw nonce never leaves this function except to Supabase.
   */
  const signInWithApple: AuthContextValue['signInWithApple'] = useCallback(async () => {
    const unavailable: AppleSignInResult = {
      ok: false,
      canceled: false,
      message: '이 기기에서는 Apple 로그인을 사용할 수 없어요',
    };
    if (Platform.OS !== 'ios') return unavailable;

    try {
      const AppleAuthentication = await import('expo-apple-authentication');
      const Crypto = await import('expo-crypto');
      if (!(await AppleAuthentication.isAvailableAsync())) return unavailable;

      const rawNonce = Crypto.randomUUID();
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      );

      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
      if (!credential.identityToken) {
        return {
          ok: false,
          canceled: false,
          message: 'Apple 로그인 정보를 받지 못했어요. 잠시 후 다시 시도해주세요',
        };
      }

      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });
      if (error) return { ok: false, canceled: false, message: describeAuthError(error) };

      // Apple hands over the name ONLY on the very first authorization (and
      // only if the user shares it) — every later sign-in has it null, so
      // this is the one chance to record it. The session is already live at
      // this point; nothing below may turn a successful sign-in into a
      // failure.
      let appleName = '';
      if (credential.fullName) {
        try {
          appleName = AppleAuthentication.formatFullName(credential.fullName).trim();
        } catch {
          appleName = [credential.fullName.familyName, credential.fullName.givenName]
            .filter(Boolean)
            .join('')
            .trim();
        }
      }
      const user = data.user;
      if (appleName && user) {
        // Only replace a name the handle_new_user() trigger auto-filled
        // (email local-part, or '나'). Apple re-sends fullName if the user
        // revokes and re-authorizes the app, and that must not clobber a name
        // they have since chosen themselves in the profile tab. Same
        // self-only RLS path as updateDisplayName; the extra `.in(...)` makes
        // check-and-write a single atomic statement.
        const autoFilledNames = ['나'];
        const emailLocalPart = user.email?.split('@')[0];
        if (emailLocalPart) autoFilledNames.push(emailLocalPart);
        try {
          const { data: row } = await supabase
            .from('profiles')
            .update({ display_name: appleName })
            .eq('id', user.id)
            .in('display_name', autoFilledNames)
            .select('id, display_name')
            .maybeSingle();
          if (row && mountedRef.current) {
            profileWriteSeqRef.current += 1;
            setProfile({ id: row.id, displayName: row.display_name });
            setProfileError(false);
            setProfileLoading(false);
          }
        } catch {
          // Best-effort: the name stays editable from the profile tab.
        }
      }

      return { ok: true };
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'ERR_REQUEST_CANCELED') {
        return { ok: false, canceled: true };
      }
      return {
        ok: false,
        canceled: false,
        message: 'Apple 로그인에 실패했어요. 잠시 후 다시 시도해주세요',
      };
    }
  }, []);

  const signOut = useCallback(async () => {
    // STEP 16-D scope: clears the Supabase session only. Existing
    // gagyebu.* AsyncStorage data is untouched — there is no household/
    // sync yet for it to belong to, so nothing to namespace or wipe (see
    // app/_layout.tsx header comment).
    await supabase.auth.signOut();
    // Drop the account-scoped profile immediately (the session effect also
    // clears it once SIGNED_OUT lands, but this removes any window where a
    // stale name could be read). Device-local gagyebu.* settings are NOT
    // touched — only this account's identity.
    if (mountedRef.current) {
      setProfile(null);
      setProfileError(false);
      setProfileLoading(false);
    }
  }, []);

  const clearLocalSessionAfterAccountDeletion: AuthContextValue['clearLocalSessionAfterAccountDeletion'] =
    useCallback(async () => {
      let sdkCleared = false;
      try {
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        sdkCleared = !error;
      } catch {
        // The server account is already gone at this point. Fall through to
        // the storage-level cleanup below instead of letting a logout network
        // failure strand an invalid persisted session on this device.
      }

      const storageCleared = await clearPersistedSupabaseAuth();

      // When the first SDK signOut could not reach a verdict but direct
      // storage cleanup succeeded, one more local-scope call lets auth-js
      // converge its own in-memory/session bookkeeping against an empty
      // store. It is best-effort; React auth state is cleared below either
      // way because the server deletion is already authoritative.
      if (!sdkCleared && storageCleared) {
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {
          // no-op: persisted auth is already gone
        }
      }

      if (mountedRef.current) {
        setSession(null);
        setProfile(null);
        setProfileError(false);
        setProfileLoading(false);
        setLoading(false);
      }

      return sdkCleared || storageCleared
        ? { ok: true }
        : {
            ok: false,
            message: '계정은 삭제됐지만 이 기기의 로그인 정보 정리를 확인하지 못했어요',
          };
    }, []);

  const resetPasswordForEmail: AuthContextValue['resetPasswordForEmail'] = useCallback(async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: RESET_PASSWORD_REDIRECT_TO,
    });
    if (error) return { ok: false, message: describeAuthError(error) };
    return { ok: true };
  }, []);

  const updatePassword: AuthContextValue['updatePassword'] = useCallback(async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, message: describeAuthError(error) };
    return { ok: true };
  }, []);

  /**
   * STEP 16-PROFILE-FIX §4-§7: the ONLY writer of the account name. Writes
   * `public.profiles.display_name` for the LIVE session's own user (RLS
   * `id = auth.uid()` + an explicit `.eq('id', …)`), then adopts the
   * authoritative returned row. No `auth.admin`, no RPC, no service_role,
   * no household_members write, no local-settings write.
   */
  const updateDisplayName = useCallback(
    async (name: string): Promise<AuthActionResult> => {
      const normalized = name.trim();
      if (!normalized) return { ok: false, message: '이름을 입력해주세요' };

      // Re-confirm the live session right before writing.
      const { data: sessionData } = await supabase.auth.getSession();
      const liveUserId = sessionData.session?.user?.id ?? null;
      if (!liveUserId) {
        return { ok: false, message: '세션이 만료됐어요. 다시 로그인해주세요' };
      }
      // Stale-account guard: the context we believe we're editing for must
      // still be the live session's user.
      if (session?.user?.id && session.user.id !== liveUserId) {
        return { ok: false, message: '로그인 정보가 변경됐어요. 다시 시도해주세요' };
      }

      const { data, error } = await supabase
        .from('profiles')
        .update({ display_name: normalized })
        .eq('id', liveUserId)
        .select('id, display_name')
        .single();

      if (error || !data) {
        return {
          ok: false,
          message: describeAuthError(error ?? new Error('profile update failed')),
        };
      }

      if (mountedRef.current) {
        setProfile({ id: data.id, displayName: data.display_name });
        setProfileError(false);
      }
      return { ok: true };
    },
    [session?.user?.id],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      profile,
      profileLoading,
      profileError,
      signUp,
      signIn,
      signInWithKakao,
      signInWithApple,
      signOut,
      clearLocalSessionAfterAccountDeletion,
      resetPasswordForEmail,
      updatePassword,
      updateDisplayName,
    }),
    [
      session,
      loading,
      profile,
      profileLoading,
      profileError,
      signUp,
      signIn,
      signInWithKakao,
      signInWithApple,
      signOut,
      clearLocalSessionAfterAccountDeletion,
      resetPasswordForEmail,
      updatePassword,
      updateDisplayName,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
