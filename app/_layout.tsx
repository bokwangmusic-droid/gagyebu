import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider, useToast } from '@/components/ui/Toast';
import { maybeAutoBackup } from '@/lib/backup';
import { computeMissedOccurrences } from '@/lib/recurring';
import { AuthProvider, useAuth } from '@/store/auth';
import { HouseholdProvider, useHousehold } from '@/store/household';
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
const SIGNED_OUT_SCREENS = ['sign-in', 'sign-up', 'auth-callback'];
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
  'loan-add',
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
 */
function AuthGate() {
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

  useEffect(() => {
    if (authLoading) return;
    const seg0 = segments[0] as string | undefined;

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
  }, [authLoading, session, householdDataReady, households, activeHousehold, segments, router]);

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

  useEffect(() => {
    if (hydrated && !authLoading && !householdLoading && (fontsLoaded || fontError)) {
      void SplashScreen.hideAsync();
    }
  }, [hydrated, authLoading, householdLoading, fontsLoaded, fontError]);

  if (!hydrated || authLoading || householdLoading || (!fontsLoaded && !fontError)) return null;

  return (
    <>
      <AuthGate />
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
        <Stack.Screen name="recurring" options={MODAL} />
        <Stack.Screen name="recurring-add" options={MODAL} />
        <Stack.Screen name="goals" options={MODAL} />
        <Stack.Screen name="goal-add" options={MODAL} />
        <Stack.Screen name="loans" options={MODAL} />
        <Stack.Screen name="loan-add" options={MODAL} />
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
              <StoreProvider>
                <ToastProvider>
                  <StatusBar style="dark" />
                  <RootNav />
                </ToastProvider>
              </StoreProvider>
            </RemoteFinanceProvider>
          </HouseholdProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
