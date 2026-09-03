/**
 * Pro-feature entitlements — STEP 10 SKELETON ONLY.
 *
 * Every feature is open for everyone. No paywall, no subscription check, no
 * "PRO" UI. A future step replaces `resolveEntitlements()` with real
 * subscription state (store receipt / RevenueCat / server) and every call site
 * — `useEntitlements().has(...)`, `<ProGate feature=...>` — keeps working
 * unchanged.
 */

import { useMemo } from 'react';

/**
 * Feature keys a future Pro plan could gate. `true` = currently unlocked.
 * STEP 10: all `true`.
 */
export const PRO_FEATURES = {
  advancedInsights: true,
  aiInsights: true,
  cloudBackup: true,
  cloudSync: true,
  multiUser: true,
} as const;

export type ProFeature = keyof typeof PRO_FEATURES;

export interface Entitlements {
  /** True while `feature` is available to this user. */
  has(feature: ProFeature): boolean;
}

/**
 * Plain resolver — the one place real subscription logic will land later.
 * Today: reads the static `PRO_FEATURES` map, so everything is allowed.
 */
export function resolveEntitlements(): Entitlements {
  return { has: (feature) => PRO_FEATURES[feature] === true };
}

/** React hook wrapper. Stable identity — cheap to consume anywhere. */
export function useEntitlements(): Entitlements {
  return useMemo(resolveEntitlements, []);
}
