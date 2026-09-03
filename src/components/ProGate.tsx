import { Fragment, type ReactNode } from 'react';

import { useEntitlements, type ProFeature } from '@/lib/entitlements';

/**
 * Gate around a Pro-only subtree — STEP 10 SKELETON.
 *
 * Renders `children` whenever `feature` is entitled, else `fallback`. Every
 * feature is entitled today (see `src/lib/entitlements.ts`), so this is a
 * pass-through: `children` always render, no `fallback` ever shows. `fallback`
 * exists in the signature now so a future paywall step needs no call-site
 * changes.
 */
export function ProGate({
  feature,
  children,
  fallback = null,
}: {
  feature: ProFeature;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { has } = useEntitlements();
  return <Fragment>{has(feature) ? children : fallback}</Fragment>;
}

export default ProGate;
