/**
 * Budget row DISPLAY order — STEP 16-H2-C2-BUDGET UI fix ("row order").
 *
 * `app/(tabs)/budget.tsx` previously sorted `Object.entries(budgets)` by
 * AMOUNT descending. That was already unrelated to category identity, and
 * once pending/failed offline rows (whose amount can be an attempted value,
 * not a real budget) started rendering alongside authoritative ones, the
 * list looked shuffled with no discernible order.
 *
 * This module sorts budget rows by the SAME authoritative category display
 * order every other screen already uses (`getAllCats` + `catOrder` —
 * src/data/categories.ts, the exact source `app/categories.tsx` and
 * `app/budget-add.tsx`'s picker already rely on) — never by amount, never
 * by offline-queue enqueue order. Pure, no React/Supabase/AsyncStorage.
 */
import { getAllCats, type CustomCatMap, type CatOrderMap } from '@/data/categories';

/**
 * `entries` in, the SAME entries out, re-ordered by `categoryId`'s rank in
 * the authoritative expense category order (built-ins + custom, honouring
 * `catOrder` — budgets are an expense-only concept, matching
 * `budget-add.tsx`'s own `getAllCats('expense', …)` picker). A category id
 * NOT found there (a genuinely orphaned/unknown synthetic row) falls back to
 * a stable position at the very end, tie-broken alphabetically by id so
 * that fallback bucket never reshuffles between renders — it is NEVER
 * ordered by which offline op enqueued it, or when.
 */
export function sortBudgetEntriesByCategoryOrder(
  entries: readonly [string, number][],
  customCats: CustomCatMap,
  catOrder: CatOrderMap,
): [string, number][] {
  const order = getAllCats('expense', customCats, catOrder);
  const rank = new Map(order.map((c, i) => [c.id, i]));
  const rankOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  return entries.slice().sort((a, b) => {
    const diff = rankOf(a[0]) - rankOf(b[0]);
    if (diff !== 0) return diff;
    return a[0].localeCompare(b[0]); // deterministic tiebreak — orphan bucket only
  });
}
