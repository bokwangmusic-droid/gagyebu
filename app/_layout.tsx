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
import { StoreProvider, useStore } from '@/store/store';
import { colors } from '@/theme/tokens';
import { fontMap } from '@/theme/typography';

void SplashScreen.preventAutoHideAsync();

/** Redirects to onboarding until it's been seen. */
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
  const [fontsLoaded, fontError] = useFonts(fontMap);

  useEffect(() => {
    if (hydrated && (fontsLoaded || fontError)) {
      void SplashScreen.hideAsync();
    }
  }, [hydrated, fontsLoaded, fontError]);

  if (!hydrated || (!fontsLoaded && !fontError)) return null;

  return (
    <>
      <Gate />
      <BootEffects />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade',
        }}
      >
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
        <StoreProvider>
          <ToastProvider>
            <StatusBar style="dark" />
            <RootNav />
          </ToastProvider>
        </StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
