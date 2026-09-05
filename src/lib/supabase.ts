/**
 * Supabase client — STEP 16-D.
 *
 * Single module-level instance, following the official React Native /
 * Expo pattern: URL polyfill first, AsyncStorage as the session store,
 * auto refresh driven by AppState so a backgrounded app doesn't keep
 * refreshing (and a foregrounded one doesn't miss a refresh).
 *
 * Only the anon/publishable key ever lives here — never service_role.
 * RLS (supabase/migrations/*.sql) is what actually protects data; this key
 * is safe to ship in the app bundle.
 */
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Fail loudly and specifically at startup rather than letting supabase-js
// throw an obscure "Invalid URL" / fetch error the first time a screen
// calls it. Never log the values themselves — only which vars are missing.
if (!supabaseUrl || !supabasePublishableKey) {
  const missing = [
    !supabaseUrl && 'EXPO_PUBLIC_SUPABASE_URL',
    !supabasePublishableKey && 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  ]
    .filter(Boolean)
    .join(', ');
  throw new Error(
    `Supabase 환경변수가 설정되지 않았어요 (${missing}). 프로젝트 루트에 .env를 만들고 ` +
      '.env.example을 참고해 값을 채워주세요.',
  );
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Supabase's official RN guidance: drive token auto-refresh off AppState so
// it only runs while the app is in the foreground. Registered once at
// module scope — this file is a singleton (ES module caching), and the
// guard below additionally protects against the rare case of the module
// body re-running (e.g. a Fast Refresh edge case) registering a second
// listener.
const g = globalThis as { __gagyebuSupabaseAutoRefreshWired?: boolean };
if (!g.__gagyebuSupabaseAutoRefreshWired) {
  g.__gagyebuSupabaseAutoRefreshWired = true;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
