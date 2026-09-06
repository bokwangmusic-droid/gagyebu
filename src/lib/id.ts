/**
 * Client-generated entity id.
 *
 * Same scheme as src/store/store.tsx's private `uid()` — `<prefix>-<ms>-<rand>`
 * — kept here as a shared helper so the remote finance write path
 * (STEP 16-G2-A) can mint a `txn-...` id that matches the ids the local
 * store and the household-import RPC already use for `public.transactions.id`
 * (a client-generated TEXT primary key, see supabase/migrations/
 * 20260905000200_household_data.sql).
 */
export const uid = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
