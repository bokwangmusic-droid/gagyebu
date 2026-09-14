/**
 * Pure decision core for AuthGate's password-recovery routing guard —
 * STEP AUTH-F1, extracted after a real-device log confirmed a warm-start
 * race: `PasswordRecoveryLinkGate` recognizes a `/reset-password`-targeting
 * URL and calls `router.replace('/reset-password', ...)`, but React
 * Navigation's own state update is not synchronous with that call, so
 * `useSegments()` can still report the OLD route for one or more further
 * AuthGate renders. If `session`/`household` were already resolved (the
 * common case for a password-reset request — the user is usually already
 * signed in), AuthGate's effect would otherwise compute a competing
 * `/household-ready` redirect from that still-stale `segments` read.
 *
 * `AuthGate` (app/_layout.tsx) calls `decideRecoveryFlowAction` on every
 * effect run BEFORE computing its own normal session/household target,
 * passing it the CURRENT route segment, whether reset-password was the
 * live route as of the previous decision (`wasOnResetPassword`), and
 * whether a recovery URL has been recognized but not yet arrived at
 * (`recoveryFlowActive`, raised by `PasswordRecoveryLinkGate`'s
 * `onRecoveryRouteMatched` the INSTANT it recognizes a matching URL, for
 * both cold and warm starts alike — this module has no concept of
 * cold/warm at all, since by the time its inputs are computed that
 * distinction no longer matters).
 *
 * No timers, no navigation calls, no side effects here — every transition
 * is driven purely by comparing this render's `seg0` against the PREVIOUS
 * render's confirmed state, exactly the kind of state AuthGate already
 * tracks via refs for its own `lastTargetRef` guard.
 */

export type RecoveryFlowAction =
  /** `seg0 === 'reset-password'` — hold position; AuthGate's caller marks
   *  `wasOnResetPassword` true for the next decision and computes no
   *  target at all. */
  | 'stayOnResetPassword'
  /** We were on reset-password as of the last decision and are not
   *  anymore — the screen itself navigated away (done/invalid). The
   *  caller releases `recoveryFlowActive` and computes no target THIS
   *  pass, letting the state update it just dispatched trigger a fresh
   *  decision against the now-accurate `segments` on the next render. */
  | 'settleAndHold'
  /** A recovery URL was recognized (cold or warm start) and
   *  `router.replace('/reset-password', ...)` has been dispatched, but
   *  `segments` has not caught up to it yet on this render — compute NO
   *  target at all until `stayOnResetPassword` fires on a later pass. */
  | 'blockRedirect'
  /** No recovery flow is in progress — the caller proceeds with its own
   *  normal session/household target computation. */
  | 'proceedNormally';

export interface RecoveryFlowInput {
  /** `segments[0]` from `useSegments()`, or `undefined` for the root route. */
  seg0: string | undefined;
  /** Was `/reset-password` the confirmed route as of the PREVIOUS decision
   *  for this AuthGate instance? (`false` on first mount.) */
  wasOnResetPassword: boolean;
  /** True from the instant `PasswordRecoveryLinkGate` recognizes a
   *  `/reset-password`-targeting URL until AuthGate confirms the app has
   *  left that route again. */
  recoveryFlowActive: boolean;
}

export function decideRecoveryFlowAction(input: RecoveryFlowInput): RecoveryFlowAction {
  if (input.seg0 === 'reset-password') return 'stayOnResetPassword';
  if (input.wasOnResetPassword) return 'settleAndHold';
  if (input.recoveryFlowActive) return 'blockRedirect';
  return 'proceedNormally';
}
