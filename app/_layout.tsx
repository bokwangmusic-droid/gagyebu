import * as Linking from 'expo-linking';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider, useToast } from '@/components/ui/Toast';
import { maybeAutoBackup } from '@/lib/backup';
import { isResetPasswordUrl, parseRecoveryFragment } from '@/lib/authValidation';
import { decideRecoveryFlowAction } from '@/lib/recoveryFlowGuard';
import { computeMissedOccurrences } from '@/lib/recurring';
import { AuthProvider, useAuth } from '@/store/auth';
import { HouseholdProvider, useHousehold } from '@/store/household';
import { PendingWritesProvider } from '@/store/pendingFinance';
import { RemoteFinanceProvider } from '@/store/remoteFinance';
import { StoreProvider, useStore } from '@/store/store';
import { colors } from '@/theme/tokens';
import { fontMap } from '@/theme/typography';

void SplashScreen.preventAutoHideAsync();

/**
 * STEP 16-D/16-E, narrowed by STEP 16-G1B: gates ONLY `Gate` (onboarding
 * redirect) and `BootEffects` (recurring auto-transaction generation,
 * planned-due alerts, local auto-backup) below — never route reachability.
 * Route reachability for (tabs)/finance screens is governed entirely by
 * `HOUSEHOLD_READY_SCREENS` (below), independent of this flag. This flag
 * stays false: BootEffects' recurring-auto-generation mutates local
 * financial data via `addTransaction`, which STEP 16-G1B's read-only mode
 * must not allow to run against a household's remote data being displayed
 * — and since it operates on `useStore()`'s LOCAL data regardless, running
 * it while remote finance is on screen would only be confusing even if it
 * were otherwise harmless. `onboarding` itself was never part of the
 * household flow and stays unreachable too. See the completion report
 * §10 for the full reasoning.
 */
const LEGACY_APP_REACHABLE = false;

// auth-callback (STEP 16-D1) is where Supabase's confirmation email
// redirects the browser — it must be reachable with no session yet.
// forgot-password (STEP AUTH-F1) is the reset-request screen, reached only
// from sign-in while signed out. reset-password is DELIBERATELY NOT listed
// here — see AuthGate's own exemption below, since a recovery link can
// establish a session while the user is already on that route.
const SIGNED_OUT_SCREENS = ['sign-in', 'sign-up', 'auth-callback', 'forgot-password'];
// STEP 16-E: reachable while signed in but not (yet, or no longer) member
// of exactly one resolved household.
const HOUSEHOLD_SETUP_SCREENS = ['household-setup', 'household-create', 'household-join'];
// STEP 16-F1: read-only local->household migration preview, reachable from
// household-ready — see app/migration-preview.tsx.
// STEP 16-G1A: read-only remote household finance preview — see
// app/remote-data-preview.tsx. Owner AND member reachable (unlike
// migration-preview, which is owner-only local-data territory).
//
// STEP 16-G1B reopens the existing finance UI in READ-ONLY mode. This is
// the actual reachability gate for it — NOT LEGACY_APP_REACHABLE, which
// stays false and keeps meaning exactly what it always has (Gate/
// BootEffects off). Two groups, both listed here so AuthGate stops
// bouncing away from them, but with very different in-screen behaviour:
//   - READ screens: '(tabs)' (home/stats/budget/planned/profile — all one
//     route group, so one entry covers all five), all-transactions,
//     calendar, cards, goals, loans, recurring. Each was rewired to read
//     via src/store/financeRead.ts's useFinanceRead() instead of
//     useStore(), with every inline add/edit/delete/toggle control
//     removed from the screen itself (see the completion report's audit
//     table) — reachable AND fully functional for viewing.
//   - WRITE screens: input, card-add, budget-add, recurring-add,
//     planned-add, goal-add, loan-add, categories. Reachable (so tapping
//     into one doesn't bounce jarringly) but each renders
//     <ReadOnlyRouteNotice/> instead of its real form — see the guard at
//     the top of each of those files (src/lib/financeMode.ts's
//     REMOTE_FINANCE_READ_ONLY).
// 'backup' (STEP 8) stays reachable too — it only ever reads/writes this
// device's LOCAL gagyebu.* backup snapshots, never remote household data,
// so it isn't part of either group above.
const HOUSEHOLD_READY_SCREENS = [
  'household-ready',
  'household-invite',
  'migration-preview',
  'remote-data-preview',
  '(tabs)',
  'all-transactions',
  'calendar',
  'category-spending',
  'cards',
  'goals',
  'loans',
  'recurring',
  'input',
  'card-add',
  'budget-add',
  'recurring-add',
  'planned-add',
  'goal-add',
  'goal-movement',
  'loan-add',
  'loan-payment',
  'categories',
  'backup',
];

/**
 * Auth + household gate — runs before, and takes priority over, the
 * onboarding Gate below. Priority order:
 *   1. no session            -> sign-in / sign-up / auth-callback only
 *   2. household list loading -> stay put (nothing to redirect to yet)
 *   3. zero households        -> household-setup / -create / -join only
 *   4. 2+ households, none picked -> household-select only
 *   5. otherwise (exactly one resolved household) -> household-ready /
 *      household-invite only
 * STEP 16-E never lets a signed-in user reach onboarding/(tabs) regardless
 * of household state — see LEGACY_APP_REACHABLE above.
 *
 * `recoveryLinkChecking` (STEP AUTH-F1, hardened after a real-device bug):
 * true for the brief window before `PasswordRecoveryLinkGate` has finished
 * asking `Linking.getInitialURL()` whether THIS launch is a password-
 * recovery deep link. While true, this gate computes NO target at all — not
 * even the normal signed-in one. This closes a real cold-start race: on a
 * device with an existing session/household already resolved (the common
 * case — the very user requesting a password reset is usually already
 * logged in), this effect's first run would otherwise fire
 * `router.replace('/household-ready')` immediately on mount, before
 * `PasswordRecoveryLinkGate`'s async URL check ever gets a chance to route
 * to `/reset-password`. `PasswordRecoveryLinkGate` flips this false
 * immediately after its own initial check settles (whether or not it
 * matched), via a stable callback — see its own doc. The delay this adds to
 * every OTHER (non-recovery) launch is the time a native `getInitialURL()`
 * bridge call takes to resolve — real, but negligible, and no different in
 * kind from the hydration/font/household-fetch waits this gate already sits
 * behind. This covers COLD START only.
 *
 * `recoveryFlowActive` (STEP AUTH-F1, added after a real-device log
 * confirmed a SECOND, separate race — see below) covers BOTH cold and warm
 * starts: true from the instant `PasswordRecoveryLinkGate` recognizes ANY
 * incoming URL as targeting `/reset-password` (valid recovery tokens or an
 * expired/used link — either way it's about to call `router.replace(
 * '/reset-password', ...)`), until this gate has confirmed the app has
 * genuinely LEFT that route again. While true, every branch below —
 * including the `seg0 === 'reset-password'` exemption's own target
 * computation — is skipped entirely; no redirect target is computed at
 * all, regardless of what `session`/`household` currently say.
 *
 * Real-device root cause this closes: a WARM-start recovery link (app
 * already running, e.g. sitting on `/sign-in` with a still-valid persisted
 * session) triggers `PasswordRecoveryLinkGate`'s `'url'` listener, which
 * calls `router.replace('/reset-password', ...)` — but React Navigation's
 * own state update is not synchronous with that call, so `useSegments()`
 * can still report the OLD route for one or more further renders. If
 * ANYTHING else causes this effect to re-run in that window (confirmed via
 * on-device logs: `session`/`household` were already resolved, so no
 * "waiting for household fetch" gate was holding it back), the OLD
 * `seg0 === 'reset-password'` exemption alone was not enough — it only
 * protects once `segments` has ALREADY caught up, and does nothing to stop
 * a redirect computed from a still-stale `segments` value in between.
 * `recoveryFlowActive` closes this by blocking on RECOGNITION of the
 * matched URL rather than on arrival at the route, so there is no window
 * at all where a stale `segments` read can produce a competing redirect.
 *
 * Lifecycle (owned jointly with `PasswordRecoveryLinkGate` and `RootNav`,
 * see each one's own doc): idle (false) -> `PasswordRecoveryLinkGate`
 * recognizes a `/reset-password`-targeting URL -> routing (true,
 * `wasOnResetPasswordRef.current` still false) -> `segments` catches up to
 * `reset-password` -> active (true, `wasOnResetPasswordRef.current` now
 * true; behaviorally identical to "routing" for this gate's purposes, the
 * pre-existing exemption below also independently protects this state) ->
 * the screen itself later navigates away (`/` on success, `/forgot-password`
 * on an expired/used link) -> `segments` no longer reads `reset-password`
 * while `wasOnResetPasswordRef.current` is true -> idle again (`
 * onRecoveryFlowSettled()` fires exactly once, this effect's own next pass
 * computes a normal target with the fresh, now-accurate `segments`). No
 * timer anywhere in this — every transition is driven by an actual,
 * observed state change (a recognized URL, or `segments` itself), never by
 * how long something is guessed to take.
 *
 * `recoveryFlowLockRef` (STEP AUTH-F1, added after the state-only guard
 * above was STILL observed losing this exact race on a real device) is the
 * AUTHORITATIVE, synchronous value this effect actually branches on —
 * `recoveryFlowActive` (the prop/state) exists ONLY to make this effect
 * RE-RUN when `PasswordRecoveryLinkGate` recognizes a URL (a plain ref
 * mutation triggers no re-render on its own), never as the value read for
 * the decision itself. `PasswordRecoveryLinkGate` sets
 * `recoveryFlowLockRef.current = true` as a PLAIN, IMMEDIATE property
 * write — before calling `router.replace(...)` at all — so by the time
 * ANYTHING downstream of that call (React Navigation's own state
 * propagation, a re-render of this component for any reason whatsoever)
 * can possibly run, the ref is already `true`. This is not true of
 * `recoveryFlowActive` alone: it is ordinary React state, and while
 * `setRecoveryFlowActive(true)` and `router.replace(...)` are called
 * synchronously back-to-back in the same callback, React and React
 * Navigation are two INDEPENDENT state-update sources with no guarantee
 * they land in the same render/commit — a real device was observed
 * computing a `/household-ready` redirect from a `segments` value that HAD
 * already moved past `sign-in`, while this component's own render still
 * carried a stale `recoveryFlowActive === false`. A plain object mutation
 * has no such gap: single-threaded JS guarantees `.current` is visible to
 * every subsequent synchronous read, regardless of anything React,
 * React Navigation, or the JS engine's own scheduler does in between.
 * Cleared the same way, synchronously, the instant `settleAndHold` fires
 * below — `onRecoveryFlowSettled()` only flips the mirrored STATE (kept in
 * sync purely so a future re-render/effect-dependency check reads `false`
 * too), the ref write is what actually and immediately unblocks.
 */
function AuthGate({
  recoveryLinkChecking,
  recoveryFlowActive,
  recoveryFlowLockRef,
  onRecoveryFlowSettled,
}: {
  recoveryLinkChecking: boolean;
  recoveryFlowActive: boolean;
  recoveryFlowLockRef: { current: boolean };
  onRecoveryFlowSettled: () => void;
}) {
  const { loading: authLoading, session } = useAuth();
  const {
    loading: householdLoading,
    households,
    activeHousehold,
    loadedForUserId,
  } = useHousehold();
  const segments = useSegments();
  const router = useRouter();

  // ---- guard 1: household data isn't trustworthy the instant a session
  // appears (fixes the warning on login, not just the earlier sign-out
  // one) ----
  //
  // `households`/`activeHousehold` can briefly still hold the previous
  // (signed-out, or previous-user) values for a render or two after
  // `session` changes — HouseholdProvider's own effect is what starts the
  // real fetch and eventually updates them, and that doesn't happen in
  // the same instant this component sees the new session. Checking only
  // `householdLoading` isn't enough: it can also still read its old value
  // for that same window. `loadedForUserId` (src/store/household.tsx) is
  // an explicit, provider-owned marker set ONLY once a fetch for a
  // specific user id has genuinely completed, so comparing it against the
  // current session's user id — a plain derived value, no ref/state
  // mutation here — is a precise, render-pure way to know the data is
  // actually theirs before using it for a redirect decision.
  const householdDataReady =
    !householdLoading && loadedForUserId === (session?.user?.id ?? null);

  // ---- guard 2: never dispatch the same redirect twice (the original
  // sign-out fix, generalised) ----
  //
  // Even with guard 1, HouseholdProvider's own state can still settle
  // across more than one render pass, and `useSegments()` only reflects a
  // `router.replace()` once React Navigation finishes that transition —
  // which can still be pending when a later pass re-runs this effect.
  // `lastTargetRef` remembers the last path THIS effect itself dispatched;
  // a later pass computing the SAME target is a no-op instead of a second
  // `router.replace()` call (which is what produced the 'REPLACE' action
  // warning). It's cleared as soon as `segments` genuinely confirms we've
  // arrived somewhere the current target allows, so a later, different
  // target still dispatches normally.
  const lastTargetRef = useRef<string | null>(null);
  // See AuthGate's own doc ("Lifecycle") — true once `segments` has
  // confirmed arrival at `/reset-password` at least once since the last
  // time this was false; the signal this effect uses to detect "we just
  // LEFT that route" and release `recoveryFlowActive` accordingly.
  const wasOnResetPasswordRef = useRef(false);

  useEffect(() => {
    if (authLoading) return;
    // See this component's own doc — holds EVERY redirect decision (not
    // just the reset-password exemption below) until we know whether this
    // launch is a recovery deep link.
    if (recoveryLinkChecking) return;
    const seg0 = segments[0] as string | undefined;

    // STEP AUTH-F1: delegates to the pure decision core (src/lib/
    // recoveryFlowGuard.ts — see its own doc for the full real-device race
    // this closes and each action's meaning). The password-recovery deep
    // link is exempt from every rule below, regardless of session/
    // household state — without it, the very next tick could compute a
    // normal signed-in target (household-setup/-ready) and
    // `router.replace()` away before the user ever sees the new-password
    // form. The screen itself decides what to render for every other state
    // (no session yet, an expired/invalid link, mid-flow, done).
    const recoveryAction = decideRecoveryFlowAction({
      seg0,
      wasOnResetPassword: wasOnResetPasswordRef.current,
      // Read the SYNCHRONOUS ref, not the `recoveryFlowActive` prop — see
      // this component's own doc for why the prop alone was insufficient.
      recoveryFlowActive: recoveryFlowLockRef.current,
    });
    if (recoveryAction === 'stayOnResetPassword') {
      wasOnResetPasswordRef.current = true;
      lastTargetRef.current = null;
      return;
    }
    if (recoveryAction === 'settleAndHold') {
      wasOnResetPasswordRef.current = false;
      // Synchronous unlock FIRST — immediately visible to any other code
      // that reads this ref, exactly mirroring how the lock was acquired.
      recoveryFlowLockRef.current = false;
      onRecoveryFlowSettled(); // mirrors the state so a future dependency check also reads false
      return;
    }
    if (recoveryAction === 'blockRedirect') return;
    // recoveryAction === 'proceedNormally' falls through to the normal
    // target computation below.

    // ---- single desired-target computation ----
    // Exactly one of these three shapes per render: nothing to do yet
    // (`target === null`), or a route + the screens that already satisfy
    // it. This is the ONLY place a target is decided — every case below
    // funnels through the same dispatch-once logic at the bottom.
    let target: string | null;
    let allowed: readonly string[];
    if (!session) {
      target = '/sign-in';
      allowed = SIGNED_OUT_SCREENS;
    } else if (!householdDataReady) {
      // Household state not confirmed for this user yet — hold position
      // rather than guess. Covers the ordinary "still loading" case too.
      target = null;
      allowed = [];
    } else if (households.length === 0) {
      target = '/household-setup';
      allowed = HOUSEHOLD_SETUP_SCREENS;
    } else if (households.length > 1 && !activeHousehold) {
      target = '/household-select';
      allowed = ['household-select'];
    } else {
      target = '/household-ready';
      allowed = HOUSEHOLD_READY_SCREENS;
    }

    if (target === null) return;

    if (allowed.includes(seg0 ?? '')) {
      // Genuinely arrived — clear the pending marker so a future, distinct
      // target (e.g. a later sign-out, or joining a second household) is
      // free to dispatch again.
      lastTargetRef.current = null;
      return;
    }
    if (lastTargetRef.current === target) return; // already dispatched; segments just hasn't caught up
    lastTargetRef.current = target;
    router.replace(target as Parameters<typeof router.replace>[0]);
  }, [
    authLoading,
    recoveryLinkChecking,
    recoveryFlowActive,
    onRecoveryFlowSettled,
    session,
    householdDataReady,
    households,
    activeHousehold,
    segments,
    router,
  ]);

  return null;
}

/**
 * Explicit password-recovery deep-link router — production/dev-build path
 * for the `gagyebu://reset-password` link Supabase's recovery email points
 * at (`RESET_PASSWORD_REDIRECT_TO`, src/store/auth.tsx). Rather than relying
 * on Expo Router's own URL-to-route matching, this takes over that ONE
 * responsibility explicitly, for both:
 *   - cold start: `Linking.getInitialURL()` (awaited — genuinely waits for
 *     the native module to hand over the launch Intent's data rather than
 *     racing a hook's synchronous initial read).
 *   - warm/backgrounded: `Linking.addEventListener('url', ...)`, which
 *     fires on Android's `onNewIntent` delivery to the already-running
 *     activity.
 * `isResetPasswordUrl` matches BOTH a valid recovery link and an
 * expired/already-used one (`#error=...`, no usable tokens) — either way
 * the destination is `/reset-password`; a valid link's extracted tokens ride
 * along as ROUTE PARAMS (`access_token`/`refresh_token`), available to
 * app/reset-password.tsx SYNCHRONOUSLY on its very first render — an
 * invalid one carries no params, and that screen's own state machine shows
 * its "링크가 만료되었거나 유효하지 않아요" notice exactly as before.
 *
 * `handledRef` guards against acting on the SAME incoming URL twice (e.g.
 * both `getInitialURL()` and a coincident 'url' event firing for one cold
 * launch) — this component does not touch auth-callback's own reachability
 * or navigation at all; a link with a different path is simply ignored.
 *
 * NOTE (AUTH-F1 diagnosis, confirmed on-device): Expo Go does NOT deliver
 * this URL at all — tapping the recovery link while running under Expo Go
 * hands the app only the bare Metro project URL (`exp://<host>:<port>`),
 * with no path/query/fragment. That is a limitation of Expo Go itself, not
 * of this gate or of Expo Router — a development build or a standalone/
 * production build (both of which register the `gagyebu` scheme from
 * app.json directly) receives the full link normally. This flow is only
 * testable outside Expo Go.
 *
 * `onInitialCheckSettled` (STEP AUTH-F1, hardened after a real-device cold-
 * start race) fires exactly once, right after the very first
 * `getInitialURL()` check SETTLES — resolved (recovery link or not) OR
 * rejected (a `try/finally` guarantees this; see below) — and, on the
 * resolved path, AFTER `handle(url)` has already run.
 *
 * `onRecoveryRouteMatched` (STEP AUTH-F1, added after a real-device log
 * confirmed a SEPARATE warm-start race — see AuthGate's own doc for the
 * full lifecycle) fires from INSIDE `handle(url)`, the INSTANT a URL is
 * recognized as targeting `/reset-password` — for BOTH cold and warm
 * starts, and BEFORE `router.replace('/reset-password', ...)` is called.
 * `RootNav`'s implementation of this callback writes a SYNCHRONOUS ref
 * (`recoveryFlowLockRef.current = true`) before touching React state at
 * all — see `AuthGate`'s own doc for why the ref, not the mirrored state
 * alone, is what actually and definitively closes this race.
 */
function PasswordRecoveryLinkGate({
  onInitialCheckSettled,
  onRecoveryRouteMatched,
}: {
  onInitialCheckSettled: () => void;
  onRecoveryRouteMatched: () => void;
}) {
  const router = useRouter();
  const handledRef = useRef(false);

  useEffect(() => {
    const handle = (url: string | null) => {
      if (handledRef.current) return;
      if (!url || !isResetPasswordUrl(url)) return;
      handledRef.current = true;
      // Recognized BEFORE dispatching the navigation itself — see this
      // component's own doc and AuthGate's "Lifecycle" note.
      onRecoveryRouteMatched();

      const parsed = parseRecoveryFragment(url);
      if (parsed) {
        router.replace({
          pathname: '/reset-password',
          params: { access_token: parsed.accessToken, refresh_token: parsed.refreshToken },
        });
      } else {
        router.replace('/reset-password');
      }
    };

    // try/finally so a getInitialURL() rejection still settles the check —
    // AuthGate must never be blocked forever by a failed native call (see
    // onInitialCheckSettled's own doc: settlement, not success, is what it
    // signals). No timeout: a native bridge call either resolves or
    // rejects, it does not hang.
    void (async () => {
      try {
        const url = await Linking.getInitialURL();
        handle(url);
      } catch {
        // Unknown launch URL — recovery routing simply doesn't happen for
        // this launch; onInitialCheckSettled() below still lets AuthGate's
        // normal session/household redirect proceed.
      } finally {
        onInitialCheckSettled();
      }
    })();
    const subscription = Linking.addEventListener('url', (event) => handle(event.url));
    return () => subscription.remove();
  }, [router, onInitialCheckSettled, onRecoveryRouteMatched]);

  return null;
}

/** Redirects to onboarding until it's been seen. Unreachable while
 *  LEGACY_APP_REACHABLE is false (STEP 16-D) — kept as-is for the STEP that
 *  re-enables it. */
function Gate() {
  const { hydrated, seenOnboarding } = useStore();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!hydrated) return;
    const onOnboarding = segments[0] === 'onboarding';
    if (!seenOnboarding && !onOnboarding) {
      router.replace('/onboarding');
    } else if (seenOnboarding && onOnboarding) {
      router.replace('/');
    }
  }, [hydrated, seenOnboarding, segments, router]);

  return null;
}

/** Runs once after hydration: apply missed recurring rules, alert on due planned. */
function BootEffects() {
  const {
    hydrated,
    seenOnboarding,
    recurring,
    planned,
    addTransaction,
    updateRecurring,
  } = useStore();
  const toast = useToast();
  const ran = useRef(false);

  useEffect(() => {
    if (!hydrated || !seenOnboarding || ran.current) return;
    ran.current = true;

    // Apply recurring occurrences missed since last run.
    const now = new Date();
    let added = 0;
    for (const r of recurring) {
      if (!r.active) continue;
      const occs = computeMissedOccurrences(r, now);
      if (occs.length === 0) continue;
      added += occs.length;
      for (const d of occs) {
        addTransaction({
          type: r.type,
          category: r.category,
          amount: r.amount,
          memo: `${r.name} (자동)`,
          date: d.toISOString(),
          fromRecurring: r.id,
        });
      }
      updateRecurring(r.id, { lastRun: now.toISOString() });
    }
    if (added > 0) {
      setTimeout(() => toast.show(`${added}건의 반복 내역이 자동 반영됐어요`), 600);
    }

    // Alert for planned expenses due today or overdue.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const due = planned.filter(
      (p) => new Date(`${p.date}T00:00:00`).getTime() <= midnight.getTime(),
    );
    if (due.length > 0) {
      const rest = due.length > 1 ? ` 외 ${due.length - 1}건` : '';
      setTimeout(() => toast.show(`📅 「${due[0].name}」 예정일이에요${rest}`), 900);
    }

    // Daily local snapshot. Deferred well past first paint and fully
    // self-contained (every failure is swallowed inside maybeAutoBackup), so
    // it can neither slow down nor break app start. `ran` already guards it to
    // once per session; the daily key inside guards it to once per calendar day.
    setTimeout(() => void maybeAutoBackup(), 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, seenOnboarding]);

  return null;
}

const MODAL = {
  presentation: 'modal',
  animation: 'slide_from_bottom',
} as const;

function RootNav() {
  const { hydrated } = useStore();
  const { loading: authLoading } = useAuth();
  const { loading: householdLoading } = useHousehold();
  const [fontsLoaded, fontError] = useFonts(fontMap);
  // STEP AUTH-F1 cold-start race fix — see AuthGate's own doc. Starts true
  // on every launch; PasswordRecoveryLinkGate flips it false via the stable
  // callback below the instant its initial `getInitialURL()` check settles.
  const [recoveryLinkChecking, setRecoveryLinkChecking] = useState(true);
  const handleRecoveryLinkChecked = useCallback(() => setRecoveryLinkChecking(false), []);
  // STEP AUTH-F1 warm-start race fix — see AuthGate's own doc ("Lifecycle" +
  // the `recoveryFlowLockRef` note). `recoveryFlowLockRef` is the
  // AUTHORITATIVE, synchronous value AuthGate actually branches on — a
  // plain ref mutation, visible to any subsequent synchronous read
  // regardless of React/React Navigation's own update scheduling. The
  // paired `recoveryFlowActive` STATE exists only so AuthGate's effect
  // re-runs at all when this fires (a ref write alone triggers no
  // re-render); it is never the value the gating decision itself reads.
  const recoveryFlowLockRef = useRef(false);
  const [recoveryFlowActive, setRecoveryFlowActive] = useState(false);
  const handleRecoveryRouteMatched = useCallback(() => {
    recoveryFlowLockRef.current = true; // synchronous — see AuthGate's own doc
    setRecoveryFlowActive(true); // wakes AuthGate's effect up to read it
  }, []);
  const handleRecoveryFlowSettled = useCallback(() => setRecoveryFlowActive(false), []);

  useEffect(() => {
    if (hydrated && !authLoading && !householdLoading && (fontsLoaded || fontError)) {
      void SplashScreen.hideAsync();
    }
  }, [hydrated, authLoading, householdLoading, fontsLoaded, fontError]);

  // STEP AUTH-F1 root-cause fix — a real-device investigation traced the
  // persistent recovery-flow instability to THIS gate: `reset-password.tsx`
  // calling `supabase.auth.setSession(...)` makes `HouseholdProvider` refire
  // its `[user]`-keyed fetch (a recovery session is, to that provider,
  // indistinguishable from a normal sign-in — see src/store/household.tsx),
  // which sets `householdLoading` back to `true`. Since this whole function
  // returns `null` while that's true, EVERY child — `<AuthGate/>`,
  // `<PasswordRecoveryLinkGate/>`, and the entire `<Stack>` including
  // `reset-password.tsx` itself — was unmounted and later remounted fresh,
  // wiping `wasOnResetPasswordRef`/`handledRef`/the screen's own state and
  // forcing `PasswordRecoveryLinkGate` to re-process the same launch URL
  // from scratch. No amount of AuthGate-level guarding (recoveryLinkChecking/
  // recoveryFlowActive/recoveryFlowLockRef) could fix this: those all live
  // INSIDE the very subtree this line was destroying.
  //
  // `recoveryFlowLockRef.current` (read directly here, not the mirrored
  // `recoveryFlowActive` state — same reasoning as AuthGate's own synchronous
  // read: by the time `setSession()` ever runs, `PasswordRecoveryLinkGate`
  // has ALREADY set this ref, so it is reliably true for the entire window
  // this fix cares about) exempts ONLY an in-progress recovery flow from the
  // household-loading blank-out. Every other case — normal app start, a
  // normal sign-in's own first household fetch, sign-out, switching
  // households — keeps the EXACT original behavior, since `hydrated`/
  // `authLoading`/`fontsLoaded`/`fontError` are untouched and
  // `recoveryFlowLockRef.current` is `false` for all of them.
  if (
    !hydrated ||
    authLoading ||
    (householdLoading && !recoveryFlowLockRef.current) ||
    (!fontsLoaded && !fontError)
  ) {
    return null;
  }

  return (
    <>
      <AuthGate
        recoveryLinkChecking={recoveryLinkChecking}
        recoveryFlowActive={recoveryFlowActive}
        recoveryFlowLockRef={recoveryFlowLockRef}
        onRecoveryFlowSettled={handleRecoveryFlowSettled}
      />
      <PasswordRecoveryLinkGate
        onInitialCheckSettled={handleRecoveryLinkChecked}
        onRecoveryRouteMatched={handleRecoveryRouteMatched}
      />
      {LEGACY_APP_REACHABLE && (
        <>
          <Gate />
          <BootEffects />
        </>
      )}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="auth-callback" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="reset-password" />
        <Stack.Screen name="household-setup" />
        <Stack.Screen name="household-create" />
        <Stack.Screen name="household-join" />
        <Stack.Screen name="household-select" />
        <Stack.Screen name="household-ready" />
        <Stack.Screen name="household-invite" />
        <Stack.Screen name="migration-preview" />
        <Stack.Screen name="remote-data-preview" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="input" options={MODAL} />
        <Stack.Screen name="all-transactions" options={MODAL} />
        <Stack.Screen name="calendar" options={MODAL} />
        <Stack.Screen name="category-spending" options={MODAL} />
        <Stack.Screen name="recurring" options={MODAL} />
        <Stack.Screen name="recurring-add" options={MODAL} />
        <Stack.Screen name="goals" options={MODAL} />
        <Stack.Screen name="goal-add" options={MODAL} />
        <Stack.Screen name="goal-movement" options={MODAL} />
        <Stack.Screen name="loans" options={MODAL} />
        <Stack.Screen name="loan-add" options={MODAL} />
        <Stack.Screen name="loan-payment" options={MODAL} />
        <Stack.Screen name="cards" options={MODAL} />
        <Stack.Screen name="card-add" options={MODAL} />
        <Stack.Screen name="categories" options={MODAL} />
        <Stack.Screen name="budget-add" options={MODAL} />
        <Stack.Screen name="planned-add" options={MODAL} />
        <Stack.Screen name="backup" options={MODAL} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <HouseholdProvider>
            {/* STEP 16-G1A: read-only remote finance state — sibling to
                StoreProvider, not nested inside it, so it can never be
                touched by StoreProvider's persist-to-AsyncStorage effect.
                See src/store/remoteFinance.tsx's header. */}
            <RemoteFinanceProvider>
              {/* STEP 16-H2-A2: durable UNSENT finance writes (transaction
                  CREATE only for now). Reads scope from Auth/Household and
                  the trusted snapshot + refresh from RemoteFinanceProvider;
                  never owns or copies the authoritative snapshot itself. */}
              <PendingWritesProvider>
                <StoreProvider>
                  <ToastProvider>
                    <StatusBar style="dark" />
                    <RootNav />
                  </ToastProvider>
                </StoreProvider>
              </PendingWritesProvider>
            </RemoteFinanceProvider>
          </HouseholdProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
