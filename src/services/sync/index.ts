/**
 * Data-sync service — STEP 10 SKELETON ONLY.
 *
 * Interface + a local no-op implementation. There is no `fetch`, no server
 * URL, no auth, no Firebase/Supabase, and no background task anywhere here.
 * `getSyncProvider()` always returns `localOnlyProvider`, whose `isEnabled()`
 * is `false`, so nothing in the app ever calls `push`/`pull`.
 *
 * The contract mirrors STEP 8's backup shape (`BackupData` = the 11 user-data
 * slices) so a future step can layer a real transport on top without changing
 * the local storage flow.
 */

import type { BackupData } from '@/lib/backup';

/** A dataset ready to sync — the STEP 8 slices plus a caller-supplied stamp. */
export interface SyncSnapshot {
  updatedAt: string; // ISO
  data: BackupData;
}

export type SyncResult =
  | { ok: true; applied: boolean }
  | { ok: false; reason: string };

/**
 * Future Google / Apple / server sync implements this. STEP 10 ships only the
 * local no-op below.
 */
export interface SyncProvider {
  readonly id: string;
  /** When false, callers must not invoke `push`/`pull`. */
  isEnabled(): boolean;
  push(snapshot: SyncSnapshot): Promise<SyncResult>;
  pull(): Promise<SyncSnapshot | null>;
}

/**
 * Does nothing. Never touches the network or storage. `push`/`pull` still
 * resolve (never throw) with a harmless "disabled" outcome if something calls
 * them despite `isEnabled()` being false.
 */
export const localOnlyProvider: SyncProvider = {
  id: 'local-only',
  isEnabled: () => false,
  push: (_snapshot: SyncSnapshot): Promise<SyncResult> =>
    Promise.resolve({ ok: false, reason: 'sync-disabled' }),
  pull: (): Promise<SyncSnapshot | null> => Promise.resolve(null),
};

/** The active sync provider. STEP 10 always returns the local no-op. */
export function getSyncProvider(): SyncProvider {
  return localOnlyProvider;
}
