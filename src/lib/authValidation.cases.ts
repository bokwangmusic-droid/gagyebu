/**
 * Static verification for STEP AUTH-F1's pure Auth form validators
 * (src/lib/authValidation.ts). No Supabase, no React — plain input/output
 * checks only.
 */
import {
  MIN_PASSWORD_LENGTH,
  isResetPasswordUrl,
  isValidEmail,
  isValidNewPassword,
  isValidNewPasswordForm,
  parseRecoveryFragment,
} from '@/lib/authValidation';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runAuthValidationCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ==================== A. email validation ==================== */

  check('A1 valid email', isValidEmail('you@example.com') === true, '');
  check('A2 valid email with subdomain/plus tag', isValidEmail('a.b+tag@sub.example.co.kr') === true, '');
  check('A3 blank email invalid', isValidEmail('') === false, '');
  check('A4 whitespace-only email invalid', isValidEmail('   ') === false, '');
  check('A5 missing @ invalid', isValidEmail('example.com') === false, '');
  check('A6 missing domain dot invalid', isValidEmail('a@localhost') === false, '');
  check('A7 space inside invalid', isValidEmail('a b@example.com') === false, '');
  check('A8 leading/trailing whitespace trimmed before check', isValidEmail('  you@example.com  ') === true, '');
  check('A9 missing local part invalid', isValidEmail('@example.com') === false, '');

  /* ==================== C. password minimum rule ==================== */

  check(
    'C1 MIN_PASSWORD_LENGTH matches the app-wide policy (6, mirrors sign-up.tsx)',
    MIN_PASSWORD_LENGTH === 6,
    String(MIN_PASSWORD_LENGTH),
  );
  check('C2 below minimum invalid', isValidNewPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)) === false, '');
  check('C3 exactly at minimum valid', isValidNewPassword('a'.repeat(MIN_PASSWORD_LENGTH)) === true, '');
  check('C4 above minimum valid', isValidNewPassword('a'.repeat(MIN_PASSWORD_LENGTH + 10)) === true, '');
  check('C5 empty password invalid', isValidNewPassword('') === false, '');

  /* ==================== B. password mismatch (form-level) ==================== */

  check(
    'B1 matching, sufficiently long passwords -> valid form',
    isValidNewPasswordForm('secret1', 'secret1') === true,
    '',
  );
  check(
    'B2 mismatched passwords -> invalid form (never silently accepted)',
    isValidNewPasswordForm('secret1', 'secret2') === false,
    '',
  );
  check(
    'B3 matching but too-short passwords -> invalid form',
    isValidNewPasswordForm('abc', 'abc') === false,
    '',
  );
  check('B4 empty confirm -> invalid form', isValidNewPasswordForm('secret1', '') === false, '');
  check('B5 empty password -> invalid form', isValidNewPasswordForm('', 'secret1') === false, '');
  check('B6 both empty -> invalid form', isValidNewPasswordForm('', '') === false, '');

  /* ==================== D/E. parseRecoveryFragment (STEP AUTH-F1.1) ==================== */

  const RECOVERY_URL =
    'gagyebu://reset-password#access_token=abc123&refresh_token=def456&expires_in=3600&token_type=bearer&type=recovery';

  // D1 — no recovery session (null url) — the pre-URL-arrival / genuinely-no-url state
  check('D1 null url -> null (no recovery context)', parseRecoveryFragment(null) === null, '');
  check('D1b undefined url -> null', parseRecoveryFragment(undefined) === null, '');
  check('D1c empty-string url -> null', parseRecoveryFragment('') === null, '');

  // E1 — a genuine, well-formed recovery fragment parses correctly
  {
    const parsed = parseRecoveryFragment(RECOVERY_URL);
    check(
      'E1 valid recovery fragment -> both tokens extracted correctly',
      parsed?.accessToken === 'abc123' && parsed?.refreshToken === 'def456',
      JSON.stringify(parsed),
    );
  }

  // E2 — no fragment at all (a bare deep link, e.g. direct navigation)
  check('E2 url with no "#" fragment -> null', parseRecoveryFragment('gagyebu://reset-password') === null, '');

  // E3 — an expired/already-used link's error fragment (no `type=recovery` at all)
  check(
    'E3 error fragment (expired/used link) -> null, never mistaken for a valid recovery',
    parseRecoveryFragment(
      'gagyebu://reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    ) === null,
    '',
  );

  // E4 — wrong `type` (e.g. a signup/magiclink fragment landing on this route somehow)
  check(
    'E4 type != recovery -> null',
    parseRecoveryFragment('gagyebu://reset-password#access_token=abc&refresh_token=def&type=signup') === null,
    '',
  );

  // E5 — missing access_token
  check(
    'E5 missing access_token -> null',
    parseRecoveryFragment('gagyebu://reset-password#refresh_token=def456&type=recovery') === null,
    '',
  );

  // E6 — missing refresh_token
  check(
    'E6 missing refresh_token -> null',
    parseRecoveryFragment('gagyebu://reset-password#access_token=abc123&type=recovery') === null,
    '',
  );

  // E7 — malformed fragment (not a valid query-string shape) -> null, never throws
  check(
    'E7 malformed fragment -> null, does not throw',
    parseRecoveryFragment('gagyebu://reset-password#this-is-not-a-query-string') === null,
    '',
  );

  // E8 — idempotency: calling the PURE parser repeatedly with the SAME url
  // always returns the same (structurally equal) result — the "run once"
  // guarantee for the recovery session itself is the CALLER's job
  // (app/reset-password.tsx's `establishedRef`, a React-level concern out
  // of scope for a pure test), but the parser itself has no hidden state
  // that could make a second call disagree with the first.
  {
    const first = parseRecoveryFragment(RECOVERY_URL);
    const second = parseRecoveryFragment(RECOVERY_URL);
    check(
      'E8 repeated calls with the same url are idempotent (no hidden state)',
      JSON.stringify(first) === JSON.stringify(second),
      JSON.stringify({ first, second }),
    );
  }

  // E9 — a null-then-valid sequence (simulating getInitialURL() resolving to
  // nothing before a later 'url' event delivers the real link) — each call
  // is judged independently and correctly, which is what lets the caller's
  // event-driven retry (AUTH-F1.1's fix) work at all.
  {
    const beforeArrival = parseRecoveryFragment(null);
    const afterArrival = parseRecoveryFragment(RECOVERY_URL);
    check(
      'E9 null-then-valid sequence: first call null, second call resolves correctly',
      beforeArrival === null && afterArrival?.accessToken === 'abc123',
      JSON.stringify({ beforeArrival, afterArrival }),
    );
  }

  /* ==================== F. isResetPasswordUrl (STEP AUTH-F1.2) ==================== */

  check(
    'F1 two-slash custom scheme (Linking.createURL default) with recovery fragment -> matches',
    isResetPasswordUrl(
      'gagyebu://reset-password#access_token=abc&refresh_token=def&type=recovery',
    ) === true,
    '',
  );
  check('F2 bare two-slash URL, no fragment -> still matches (path alone is enough)', isResetPasswordUrl('gagyebu://reset-password') === true, '');
  check(
    'F3 expired/used link (error fragment, no type=recovery) -> STILL matches (must route there to show the notice)',
    isResetPasswordUrl(
      'gagyebu://reset-password#error=access_denied&error_code=otp_expired&error_description=expired',
    ) === true,
    '',
  );
  check(
    'F4 triple-slash form (host empty, path is the segment) -> matches',
    isResetPasswordUrl('gagyebu:///reset-password#type=recovery') === true,
    '',
  );
  check(
    'F5 Expo Go exp://host:port project URL (no path at all, confirmed on-device) -> does NOT match, by design',
    isResetPasswordUrl('exp://192.168.1.5:8081') === false,
    '',
  );
  check('F6 a query string with no fragment -> matches', isResetPasswordUrl('gagyebu://reset-password?foo=bar') === true, '');
  check(
    'F7 a DIFFERENT route (auth-callback) -> does NOT match, never hijacked',
    isResetPasswordUrl('gagyebu://auth-callback') === false,
    '',
  );
  check(
    'F8 a route that merely STARTS WITH the same text -> does NOT match (exact first segment only)',
    isResetPasswordUrl('gagyebu://reset-password-something-else') === false,
    '',
  );
  check('F9 null/undefined/empty -> false', isResetPasswordUrl(null) === false && isResetPasswordUrl(undefined) === false && isResetPasswordUrl('') === false, '');

  /* ==================== G. real-device 3rd-QA-failure investigation
   * (STEP AUTH-F1, post-race-fix) — the exact 5 URL shapes the user asked
   * to verify directly, matching a real WHATWG `URL` parser's own
   * protocol/host/pathname split (confirmed separately via a Node script:
   * the two-slash form puts "reset-password" in `host` with an EMPTY
   * `pathname`; the three-slash form puts it in `pathname` with an EMPTY
   * `host`). isResetPasswordUrl() never uses the `URL` constructor at all —
   * it manually strips the scheme prefix and path-splits what's left, so it
   * is host/pathname-agnostic by construction and should already match
   * both shapes. These cases prove that empirically rather than by
   * inspection alone. ==================== */

  check(
    'G1 gagyebu://reset-password (two-slash, bare, real URL parser reads this as host="reset-password") -> matches',
    isResetPasswordUrl('gagyebu://reset-password') === true,
    '',
  );
  check(
    'G2 gagyebu://reset-password#type=recovery (two-slash, type only, no tokens) -> matches',
    isResetPasswordUrl('gagyebu://reset-password#type=recovery') === true,
    '',
  );
  {
    const url = 'gagyebu://reset-password#access_token=x&refresh_token=y&type=recovery';
    const parsed = parseRecoveryFragment(url);
    check(
      'G3 gagyebu://reset-password#access_token=x&refresh_token=y&type=recovery -> isResetPasswordUrl matches AND parseRecoveryFragment extracts both placeholder tokens',
      isResetPasswordUrl(url) === true && parsed?.accessToken === 'x' && parsed?.refreshToken === 'y',
      JSON.stringify(parsed),
    );
  }
  check(
    'G4 gagyebu:///reset-password (three-slash, bare, real URL parser reads this as pathname="/reset-password") -> matches',
    isResetPasswordUrl('gagyebu:///reset-password') === true,
    '',
  );
  check(
    'G5 gagyebu:///reset-password#type=recovery (three-slash, type only) -> matches',
    isResetPasswordUrl('gagyebu:///reset-password#type=recovery') === true,
    '',
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
