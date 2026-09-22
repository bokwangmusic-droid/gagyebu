/**
 * Pure Auth form validators — STEP AUTH-F1.
 *
 * No Supabase, no React. `MIN_PASSWORD_LENGTH` mirrors the threshold
 * app/sign-up.tsx and src/store/auth.tsx's `describeAuthError` already use
 * (`password.length >= 6` / "비밀번호는 6자 이상으로 설정해주세요") — kept as
 * one named constant here for the NEW password-recovery screens, without
 * touching sign-up.tsx's own (already-shipped, unrelated) inline check.
 */

/** Same threshold already enforced by signUp (see module doc). */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Deliberately permissive — "looks like an email" (has a local part, an
 * `@`, and a dot somewhere after it), not a full RFC 5322 parser. Blank/
 * whitespace-only input is always invalid.
 */
export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length === 0) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/** Meets the app's minimum password length policy. */
export function isValidNewPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

/**
 * A new-password form is submittable when: both fields are non-empty, the
 * password meets the minimum length, and the two fields match exactly.
 * Pure decision point shared by app/reset-password.tsx's `canSubmit` and its
 * own pure tests — the screen still re-checks `password === confirm` at
 * submit time before calling Supabase (defense in depth, mirrors
 * app/sign-up.tsx's existing pattern).
 */
export function isValidNewPasswordForm(password: string, confirm: string): boolean {
  return password.length > 0 && confirm.length > 0 && isValidNewPassword(password) && password === confirm;
}

/**
 * Kakao-OAuth STEP 1 — shared primitive behind `parseRecoveryFragment` AND
 * `parseOAuthFragment` below. Pure string/`URLSearchParams` extraction only,
 * no `type` opinion — each caller applies its own `type` requirement (or
 * lack of one) on top. Extracted verbatim from the pre-existing
 * `parseRecoveryFragment` body; `parseRecoveryFragment`'s own behaviour,
 * signature and return shape are UNCHANGED by this extraction.
 */
function parseTokenFragment(
  url: string | null | undefined,
): { accessToken: string; refreshToken: string; type: string | null } | null {
  if (!url) return null;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, type: params.get('type') };
}

/**
 * STEP AUTH-F1 — parses the `#access_token=...&refresh_token=...&
 * type=recovery` fragment Supabase's implicit-flow password-recovery
 * redirect appends to `RESET_PASSWORD_REDIRECT_TO` (src/store/auth.tsx).
 * Returns `null` for anything else — no fragment at all, an `#error=...`
 * fragment from an expired/already-used link, a non-recovery `type`, or a
 * fragment missing either token — app/reset-password.tsx treats every
 * `null` the same way: no usable recovery context (yet, or ever).
 *
 * Pure and side-effect-free on purpose: it does not decide WHEN to give up
 * waiting for a URL to arrive (a `null` in ≠ "there will never be a valid
 * one" — see the caller's own timeout/event-driven retry logic, added in
 * AUTH-F1.1 after a real-device cold-start race where the OS hadn't yet
 * delivered the launch Intent's URL to the JS bridge on the very first
 * check).
 */
export function parseRecoveryFragment(
  url: string | null | undefined,
): { accessToken: string; refreshToken: string } | null {
  const parsed = parseTokenFragment(url);
  if (!parsed || parsed.type !== 'recovery') return null;
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
}

/**
 * Kakao-OAuth STEP 1 — parses the `#access_token=...&refresh_token=...`
 * fragment Supabase's implicit-flow OAuth redirect appends to
 * `EMAIL_REDIRECT_TO` (src/store/auth.tsx, shared with the existing
 * email-confirmation redirect — same `auth-callback` destination). Mirrors
 * `parseRecoveryFragment` exactly, except it explicitly EXCLUDES
 * `type === 'recovery'` — a password-recovery link must never be picked up
 * here even if it were (incorrectly) opened against the auth-callback path,
 * so the two flows can share one `Linking` listener (app/_layout.tsx)
 * without either ever mis-handling the other's URL.
 */
export function parseOAuthFragment(
  url: string | null | undefined,
): { accessToken: string; refreshToken: string } | null {
  const parsed = parseTokenFragment(url);
  if (!parsed || parsed.type === 'recovery') return null;
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
}

/**
 * Kakao-OAuth STEP 1 — shared primitive behind `isResetPasswordUrl` AND
 * `isAuthCallbackUrl` below. A custom-scheme URL built with TWO slashes
 * (`Linking.createURL`'s default) puts the first path segment where a
 * browser's `URL` parser would read it as the "host" rather than a path
 * segment; Expo Router's OWN linking config is built to treat it as the
 * first path segment regardless, so this mirrors that same two-slash
 * convention with plain string ops (no `URL` parsing, so it never depends
 * on which global `URL` polyfill is active). Extracted verbatim from the
 * pre-existing `isResetPasswordUrl` body; that function's own behaviour is
 * UNCHANGED by this extraction.
 */
function firstPathSegment(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const withoutFragmentAndQuery = url.split('#')[0].split('?')[0];
  const afterScheme = withoutFragmentAndQuery.split('://')[1] ?? '';
  return afterScheme.split('/').filter((s) => s.length > 0)[0];
}

/**
 * STEP AUTH-F1.2 — does this incoming URL target the `/reset-password`
 * route, regardless of whether it carries a VALID recovery fragment or not?
 *
 * Deliberately checked SEPARATELY from `parseRecoveryFragment` — an
 * expired/already-used link (`#error=...`, no `type=recovery`) must still
 * route to `/reset-password` so the screen's own "만료되었거나 유효하지
 * 않아요" notice can show, instead of silently doing nothing.
 *
 * Scoped to the `gagyebu://reset-password` (production/dev-build) shape
 * only — Expo Go's own `exp://host:port` project URL was confirmed
 * on-device (AUTH-F1 diagnosis) to never carry the `reset-password` path at
 * all, so there is nothing here for this function to recognize in that
 * environment, and no Expo-Go-specific parsing is carried for it.
 */
export function isResetPasswordUrl(url: string | null | undefined): boolean {
  return firstPathSegment(url) === 'reset-password';
}

/**
 * Kakao-OAuth STEP 1 — does this incoming URL target the `/auth-callback`
 * route? Same two-slash scoping as `isResetPasswordUrl`, checked against
 * `auth-callback` instead of `reset-password` — the two are mutually
 * exclusive by construction (a URL's first path segment can only be one
 * or the other), so app/_layout.tsx's single `Linking` listener can branch
 * on this safely without either flow ever swallowing the other's URL.
 */
export function isAuthCallbackUrl(url: string | null | undefined): boolean {
  return firstPathSegment(url) === 'auth-callback';
}
