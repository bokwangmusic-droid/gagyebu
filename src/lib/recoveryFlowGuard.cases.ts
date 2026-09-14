/**
 * Static verification for STEP AUTH-F1's recovery-flow guard decision core
 * (src/lib/recoveryFlowGuard.ts). No React, no Supabase — plain input/
 * output checks covering the exact transitions the warm-start real-device
 * race required: normal launch, recovery routing in progress (cold OR
 * warm — this module treats them identically), arrival at reset-password,
 * and departure from it.
 *
 * The `recoveryFlowActive` field these cases pass in represents whatever
 * value AuthGate's caller reads as "is the guard currently up" — in
 * production that's `recoveryFlowLockRef.current` (a synchronous ref, NOT
 * the mirrored React state; see app/_layout.tsx's AuthGate doc for why the
 * state-only version of this guard was still observed losing the exact
 * race these B-section cases model). This module is agnostic to WHICH one
 * feeds it — its job is only to prove the decision is correct once that
 * value is known, whatever its source.
 */
import { decideRecoveryFlowAction } from '@/lib/recoveryFlowGuard';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runRecoveryFlowGuardCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ==================== A. normal (non-recovery) launch ==================== */

  check(
    'A1 normal launch, sitting on sign-in, no recovery in progress -> proceedNormally',
    decideRecoveryFlowAction({ seg0: 'sign-in', wasOnResetPassword: false, recoveryFlowActive: false }) ===
      'proceedNormally',
    '',
  );
  check(
    'A2 normal launch, already on household-ready -> proceedNormally (AuthGate\'s own exemption logic handles "already arrived")',
    decideRecoveryFlowAction({
      seg0: 'household-ready',
      wasOnResetPassword: false,
      recoveryFlowActive: false,
    }) === 'proceedNormally',
    '',
  );
  check(
    'A3 root route (seg0 undefined), no recovery in progress -> proceedNormally',
    decideRecoveryFlowAction({ seg0: undefined, wasOnResetPassword: false, recoveryFlowActive: false }) ===
      'proceedNormally',
    '',
  );

  /* ==================== B. recovery URL recognized, not yet arrived
   * (the exact real-device race: router.replace('/reset-password', ...)
   * dispatched, but `segments` still reads the OLD route) — this module
   * makes no distinction between cold and warm start here, since
   * `recoveryFlowActive` is raised identically by PasswordRecoveryLinkGate
   * for both. ==================== */

  check(
    'B1 recovery URL just recognized (synchronous lock already true) while segments STILL stale-read sign-in (cold OR warm start alike) -> blockRedirect, even though the mirrored React state may not have re-rendered yet',
    decideRecoveryFlowAction({ seg0: 'sign-in', wasOnResetPassword: false, recoveryFlowActive: true }) ===
      'blockRedirect',
    '',
  );
  check(
    'B2 recovery URL just recognized (synchronous lock already true) while segments STILL stale-read household-ready (the exact real-device symptom: a signed-in user with a resolved household taps a warm-start recovery link) -> blockRedirect, never household-ready',
    decideRecoveryFlowAction({
      seg0: 'household-ready',
      wasOnResetPassword: false,
      recoveryFlowActive: true,
    }) === 'blockRedirect',
    '',
  );
  check(
    'B3 recovery URL recognized at the root route (seg0 undefined) -> still blockRedirect',
    decideRecoveryFlowAction({ seg0: undefined, wasOnResetPassword: false, recoveryFlowActive: true }) ===
      'blockRedirect',
    '',
  );

  /* ==================== C. arrival at /reset-password ==================== */

  check(
    'C1 segments now show reset-password, guard was active -> stayOnResetPassword',
    decideRecoveryFlowAction({
      seg0: 'reset-password',
      wasOnResetPassword: false,
      recoveryFlowActive: true,
    }) === 'stayOnResetPassword',
    '',
  );
  check(
    'C2 already confirmed on reset-password from a previous pass -> stayOnResetPassword (idempotent, keeps holding)',
    decideRecoveryFlowAction({
      seg0: 'reset-password',
      wasOnResetPassword: true,
      recoveryFlowActive: true,
    }) === 'stayOnResetPassword',
    '',
  );
  check(
    'C3 reset-password reached directly (e.g. a stale re-render) even with recoveryFlowActive already false -> still stayOnResetPassword, never bounced away',
    decideRecoveryFlowAction({
      seg0: 'reset-password',
      wasOnResetPassword: false,
      recoveryFlowActive: false,
    }) === 'stayOnResetPassword',
    '',
  );

  /* ==================== D. departure from /reset-password (guard release)
   * — the screen itself navigates away via router.replace('/') on success
   * or router.replace('/forgot-password') on an expired/used link.
   * ==================== */

  check(
    'D1 just left reset-password (segments now sign-in), guard was active -> settleAndHold (releases the guard, computes no target this pass)',
    decideRecoveryFlowAction({ seg0: 'sign-in', wasOnResetPassword: true, recoveryFlowActive: true }) ===
      'settleAndHold',
    '',
  );
  check(
    'D2 just left reset-password toward the root route (seg0 undefined) -> settleAndHold',
    decideRecoveryFlowAction({ seg0: undefined, wasOnResetPassword: true, recoveryFlowActive: true }) ===
      'settleAndHold',
    '',
  );
  check(
    'D3 left reset-password toward forgot-password (the "invalid link" -> "request a new one" path) -> settleAndHold',
    decideRecoveryFlowAction({
      seg0: 'forgot-password',
      wasOnResetPassword: true,
      recoveryFlowActive: true,
    }) === 'settleAndHold',
    '',
  );
  check(
    'D4 recovery flow fully ended: BOTH the synchronous lock and the mirrored state have been cleared (caller\'s wasOnResetPassword/recoveryFlowActive both false) -> proceedNormally, normal AuthGate flow resumes with no lingering guard',
    decideRecoveryFlowAction({ seg0: 'sign-in', wasOnResetPassword: false, recoveryFlowActive: false }) ===
      'proceedNormally',
    '',
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
