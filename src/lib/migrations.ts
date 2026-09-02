/**
 * Persisted-data schema versioning.
 *
 * The store hydrates each slice from AsyncStorage separately (keys
 * `gagyebu.*`). A single extra key, `gagyebu.schemaVersion`, records which
 * shape that data is in. On startup the store reads it, runs any pending
 * migrations, and stamps the current version — existing data is never
 * dropped or reset.
 *
 * Adding a future migration:
 *   1. bump SCHEMA_VERSION
 *   2. add an entry to MIGRATIONS keyed by the version it produces
 *   3. the entry receives the fully-hydrated state and returns the new shape
 */

import type { AppState } from '@/store/types';

/** Current persisted-data shape. Bump when the shape changes. */
export const SCHEMA_VERSION = 1;

type Migration = (state: AppState) => AppState;

/**
 * Keyed by the version each migration PRODUCES. `migrate()` runs every entry
 * from `stored + 1` up to `SCHEMA_VERSION`, in ascending order.
 *
 * v1 — baseline. The Transaction extension fields (`paymentMethod`, `splits`,
 * `memberId`, `tags`) are all optional, so pre-existing rows are already
 * valid and need no transform. This entry only anchors the versioning
 * scheme; real data-shape changes get a v2+ entry here later.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (state) => state,
};

export interface MigrateOutcome {
  state: AppState;
  /** Version the data was stored as (0 = never stamped / fresh install). */
  from: number;
  /** Version the data is in after `migrate()`. */
  to: number;
  /** Versions whose migrations actually ran. */
  applied: number[];
}

export function migrate(state: AppState, storedVersion: number): MigrateOutcome {
  const from = Number.isFinite(storedVersion) && storedVersion > 0 ? storedVersion : 0;
  let next = state;
  const applied: number[] = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    next = step(next);
    applied.push(v);
  }
  return { state: next, from, to: SCHEMA_VERSION, applied };
}
