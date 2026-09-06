/**
 * STEP 16-G1B — central "is household finance currently read-only" switch.
 *
 * Always `true` for this STEP: no Supabase financial write path exists yet
 * (STEP 16-G2 is where that gets built). Every screen that could mutate
 * financial data checks this single constant before rendering its real
 * form — see src/components/ReadOnlyRouteNotice.tsx, and the guard at the
 * top of app/input.tsx, app/card-add.tsx, app/budget-add.tsx,
 * app/recurring-add.tsx, app/planned-add.tsx, app/goal-add.tsx,
 * app/loan-add.tsx, app/categories.tsx.
 *
 * Deliberately a plain boolean, not an env var or settings toggle — this
 * STEP doesn't need per-user/per-build configurability, only a single,
 * greppable source of truth.
 */
export const REMOTE_FINANCE_READ_ONLY = true as const;
