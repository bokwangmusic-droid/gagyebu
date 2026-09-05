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

import { supabase } from '@/lib/supabase';

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

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  /** True until the initial stored-session check resolves. */
  loading: boolean;

  /** The signed-in user's public.profiles row, once fetched. Never blocks navigation. */
  profile: AuthProfile | null;
  /** True if a session exists but its profiles row could not be found/read. */
  profileError: boolean;

  signUp(params: { name: string; email: string; password: string }): Promise<SignUpResult>;
  signIn(params: { email: string; password: string }): Promise<AuthActionResult>;
  signOut(): Promise<void>;
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
  const [profileError, setProfileError] = useState(false);
  const mountedRef = useRef(true);

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
  // surfaces as `profileError` instead of an infinite loading state.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setProfile(null);
      setProfileError(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name')
        .eq('id', uid)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setProfile(null);
        setProfileError(true);
        return;
      }
      setProfileError(false);
      setProfile({ id: data.id, displayName: data.display_name });
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

  const signOut = useCallback(async () => {
    // STEP 16-D scope: clears the Supabase session only. Existing
    // gagyebu.* AsyncStorage data is untouched — there is no household/
    // sync yet for it to belong to, so nothing to namespace or wipe (see
    // app/_layout.tsx header comment).
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      profile,
      profileError,
      signUp,
      signIn,
      signOut,
    }),
    [session, loading, profile, profileError, signUp, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
