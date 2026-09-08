/**
 * Household finance Realtime — STEP 16-G3-B2.
 *
 * TRANSPORT + LIFECYCLE ONLY. This module knows nothing about React, the
 * read model, the mapping layer, or the UI. Every `postgres_changes` event
 * on the household's finance tables is collapsed (debounced) into a single
 * `onInvalidate()` call, which the provider forwards to the STEP 16-G3-B1
 * refresh scheduler. Realtime here is an invalidation SIGNAL, never a source
 * of truth: `payload.new` / `payload.old` are never read, and no state is
 * ever patched from a payload.
 *
 *  - ONE `RealtimeChannel` per `${userId}:${householdId}` scope (never one
 *    per table).
 *  - INSERT + UPDATE listeners only. Every delete in this app is a soft
 *    delete (an UPDATE of `deleted_at`), so DELETE events are neither
 *    subscribed nor parsed.
 *  - Every listener carries `filter: household_id=eq.<householdId>` — the
 *    subscription itself is household-scoped, not "filtered in the handler".
 *  - Uses the existing authenticated `supabase` client. NO service_role.
 *
 * The authoritative catch-up on the first `SUBSCRIBED` (and on a reconnect's
 * `SUBSCRIBED`) closes the race window between "initial snapshot finished"
 * and "subscription actually live" (STEP 16-G3-B2 §15).
 */
import type {
  RealtimeChannel,
  REALTIME_SUBSCRIBE_STATES,
} from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export type RealtimeSubscribeStatus = `${REALTIME_SUBSCRIBE_STATES}`;

/** Trailing debounce for a Realtime event burst (STEP 16-G3-B2 §8). */
export const REALTIME_INVALIDATION_DEBOUNCE_MS = 400;

/**
 * The `public.*` tables the RemoteFinance snapshot
 * (src/services/remoteFinance.ts) is built from and therefore must react to.
 * `household_members` / `households` / `profiles` are a separate concern
 * (see STEP 16-G3-B2 §4) and are intentionally NOT here.
 */
export const FINANCE_REALTIME_TABLES = [
  'transactions',
  'cards',
  'budgets',
  'custom_categories',
  'planned_expenses',
  'recurring_rules',
  'goals',
  'goal_movements',
  'loans',
  'loan_payments',
  'household_settings',
] as const;

export type FinanceRealtimeTable = (typeof FINANCE_REALTIME_TABLES)[number];

/** PostgREST-style row filter that scopes a listener to one household. */
export function householdFilter(householdId: string): string {
  return `household_id=eq.${householdId}`;
}

/* ------------------------------------------------------------------ *
 * Invalidation debouncer — pure, no Supabase. Coalesces an event burst
 * into a single trailing `onFlush`. `dispose()` cancels a pending flush;
 * it never fires one (STEP 16-G3-B2 §26 case 4).
 * ------------------------------------------------------------------ */

export interface InvalidationDebouncer {
  /** Note an event — (re)arms the trailing timer. */
  schedule: () => void;
  /** Cancel any pending flush and stop accepting new ones. */
  dispose: () => void;
}

export function createInvalidationDebouncer(opts: {
  delayMs: number;
  onFlush: () => void;
}): InvalidationDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  return {
    schedule: () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) opts.onFlush();
      }, opts.delayMs);
    },
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Subscription
 * ------------------------------------------------------------------ */

export interface HouseholdFinanceSubscription {
  /** `${userId}:${householdId}` this subscription belongs to. */
  scopeKey: string;
  /** Remove the channel and cancel any pending debounced flush. Idempotent. */
  unsubscribe: () => void;
}

// Monotonic — makes each channel name unique so a StrictMode / Fast-Refresh
// re-subscribe never collides with a channel still being torn down.
let instanceSeq = 0;

export function subscribeHouseholdFinance(args: {
  userId: string;
  householdId: string;
  /** Called (debounced) whenever ANY finance row in this household changed. */
  onInvalidate: () => void;
  /** Optional — status hook for tests / dev tooling. Never drives UI. */
  onStatus?: (status: RealtimeSubscribeStatus, err?: Error) => void;
}): HouseholdFinanceSubscription {
  const scopeKey = `${args.userId}:${args.householdId}`;
  let disposed = false;

  const debouncer = createInvalidationDebouncer({
    delayMs: REALTIME_INVALIDATION_DEBOUNCE_MS,
    onFlush: () => {
      if (disposed) return;
      args.onInvalidate();
    },
  });

  const filter = householdFilter(args.householdId);
  const channel: RealtimeChannel = supabase.channel(
    `household-finance:${scopeKey}:${++instanceSeq}`,
  );

  const onRowChanged = () => {
    if (disposed) return;
    // event.new / event.old are deliberately ignored — signal only.
    debouncer.schedule();
  };

  for (const table of FINANCE_REALTIME_TABLES) {
    for (const event of ['INSERT', 'UPDATE'] as const) {
      channel.on(
        'postgres_changes',
        { event, schema: 'public', table, filter },
        onRowChanged,
      );
    }
  }

  channel.subscribe((status, err) => {
    if (disposed) return;
    args.onStatus?.(status, err);
    if (status === 'SUBSCRIBED') {
      // §15: close the initial-snapshot <-> subscription gap. Also fires
      // after a reconnect (CHANNEL_ERROR / TIMED_OUT -> SUBSCRIBED). Routed
      // through the debouncer so it merges with any queued events and the
      // provider's B1 scheduler still owns fetch concurrency.
      debouncer.schedule();
    }
    if (__DEV__ && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) {
      // eslint-disable-next-line no-console
      console.warn(`[finance-realtime] ${status}`, err?.message ?? '');
    }
  });

  return {
    scopeKey,
    unsubscribe: () => {
      if (disposed) return;
      disposed = true;
      debouncer.dispose();
      void supabase.removeChannel(channel);
    },
  };
}
