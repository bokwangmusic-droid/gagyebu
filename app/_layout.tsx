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
import { StoreProvider, useStore } from '@/store/store';
import { colors } from '@/theme/tokens';
import { fontMap } from '@/theme/typography';

void SplashScreen.preventAutoHideAsync();

/**
 * STEP 16-D: the existing local-first app (onboarding + (tabs) + every
 * modal screen below) is intentionally unreachable while true — no
 * household/local-migration policy exists yet for an authenticated user's
 * data to safely land in (see AuthReady, app/auth-ready.tsx). Nothing below
 * this flag is deleted or modified; a future STEP flips this (or replaces
 * it with a real "household connected" check) once that policy is decided.
 */
const LEGACY_APP_REACHABLE = false;

// auth-callback (STEP 16-D1) is where Supabase's confirmation email
// redirects the browser — it must be reachable with no session yet.
const AUTH_SCREENS = ['sign-in', 'sign-up', 'auth-callback'];

/**
 * Auth gate — runs before, and takes priority over, the onboarding Gate
 * below. No session -> sign-in/sign-up/auth-callback only. A session exists
 * -> the temporary auth-ready screen only (STEP 16-D never lets an
 * authenticated user reach onboarding/(tabs); see LEGACY_APP_REACHABLE
 * above).
 */
function AuthGate() {
  const { loading, session } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const seg0 = segments[0] as string | undefined;

    if (!session) {
      if (!AUTH_SCREENS.includes(seg0 ?? '')) router.replace('/sign-in');
      return;
    }

    if (seg0 !== 'auth-ready') router.replace('/auth-ready');
  }, [loading, session, segments, router]);

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
  const [fontsLoaded, fontError] = useFonts(fontMap);

  useEffect(() => {
    if (hydrated && !authLoading && (fontsLoaded || fontError)) {
      void SplashScreen.hideAsync();
    }
  }, [hydrated, authLoading, fontsLoaded, fontError]);

  if (!hydrated || authLoading || (!fontsLoaded && !fontError)) return null;

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
        <Stack.Screen name="auth-ready" />
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
          <StoreProvider>
            <ToastProvider>
              <StatusBar style="dark" />
              <RootNav />
            </ToastProvider>
          </StoreProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
