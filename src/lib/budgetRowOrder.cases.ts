/**
 * Static verification for the Budget row DISPLAY order fix —
 * "BUDGET MANAGEMENT ROW ORDER FIX". Pure; no React, no Supabase, no
 * offline-queue import. `sortBudgetEntriesByCategoryOrder` must order by the
 * authoritative category order alone — never by amount, never by
 * offline-queue enqueue order.
 */
import { DEFAULT_CAT_ORDER, DEFAULT_CUSTOM_CATS, type CatOrderMap, type CustomCatMap } from '@/data/categories';
import { sortBudgetEntriesByCategoryOrder } from '@/lib/budgetRowOrder';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

// EXPENSE_CATS default order: food, transit, shopping, cafe, leisure,
// housing, health, subscribe, gift, other.
const idsOf = (entries: [string, number][]) => entries.map((e) => e[0]);

export async function runBudgetRowOrderCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  // 1 — mixed authoritative + pending CREATE rows: category order wins over
  // amount. Amounts here are DELIBERATELY reverse-correlated with category
  // order so an amount-based sort would produce a different result.
  {
    const entries: [string, number][] = [
      ['shopping', 999999], // pending CREATE, huge attempted amount
      ['food', 100],
      ['transit', 500],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '1 mixed authoritative + pending CREATE -> category order, not amount order',
      idsOf(sorted).join(',') === 'food,transit,shopping',
      idsOf(sorted).join(','),
    );
  }

  // 2 — same set, but the INPUT array order (simulating offline-queue
  // enqueue order) is scrambled differently again -> identical output.
  {
    const entries: [string, number][] = [
      ['transit', 1],
      ['shopping', 2],
      ['food', 3],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '2 input/enqueue order scrambled differently -> SAME category-order output as case 1',
      idsOf(sorted).join(',') === 'food,transit,shopping',
      idsOf(sorted).join(','),
    );
  }

  // 3 — pending UPDATE (an existing authoritative category with an
  // overlaid draft amount) keeps its ORIGINAL category position among siblings.
  {
    const entries: [string, number][] = [
      ['food', 100000],
      ['transit', 50000], // "pending UPDATE" — the amount changed, the id didn't
      ['shopping', 30000],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '3 pending UPDATE row stays at its category slot (transit stays between food and shopping)',
      idsOf(sorted).join(',') === 'food,transit,shopping',
      idsOf(sorted).join(','),
    );
  }

  // 4 — failed UPDATE (authoritative row shown, conflict marker only) — same
  // guarantee: the row's POSITION is a pure function of its category id, so
  // a terminal failure never moves it.
  {
    const entries: [string, number][] = [
      ['leisure', 1], // failed UPDATE, attempted amount irrelevant to position
      ['food', 999999],
      ['cafe', 2],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '4 failed UPDATE row position unaffected by its (attempted) amount',
      idsOf(sorted).join(',') === 'food,cafe,leisure',
      idsOf(sorted).join(','),
    );
  }

  // 5 — pending DELETE hidden: composeBudgetManagement already OMITS the row
  // from budgetManagementRows for a not-failed DELETE, so it simply never
  // appears in `entries` here. The REMAINING rows keep their relative order.
  {
    const entries: [string, number][] = [
      ['shopping', 1],
      ['food', 2],
      // 'transit' hidden by a pending DELETE — not present at all
      ['cafe', 3],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '5 pending DELETE hides a row; the rest keep their category order (no gap-shift bug)',
      idsOf(sorted).join(',') === 'food,shopping,cafe',
      idsOf(sorted).join(','),
    );
  }

  // 6 — failed DELETE restores the authoritative row -> it reappears at its
  // ORIGINAL category slot, not appended at the end.
  {
    const withoutTransit: [string, number][] = [
      ['food', 1],
      ['shopping', 2],
    ];
    const restoredWithTransit: [string, number][] = [
      ['shopping', 2],
      ['food', 1],
      ['transit', 5], // failed DELETE -> restored
    ];
    const before = sortBudgetEntriesByCategoryOrder(withoutTransit, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    const after = sortBudgetEntriesByCategoryOrder(restoredWithTransit, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '6 failed DELETE restores the row to its ORIGINAL category slot (between food and shopping), not the end',
      idsOf(before).join(',') === 'food,shopping' && idsOf(after).join(',') === 'food,transit,shopping',
      `before=${idsOf(before).join(',')} after=${idsOf(after).join(',')}`,
    );
  }

  // 7 — a category id that truly doesn't exist in the current authoritative
  // order (orphan/unknown synthetic row) falls to a STABLE spot at the very
  // end — after every real category, including the last one ("other").
  {
    const entries: [string, number][] = [
      ['zzz-unknown-orphan', 1],
      ['other', 2],
      ['food', 3],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER);
    check(
      '7 orphan/unknown category id -> deterministic bottom fallback, after every real category',
      idsOf(sorted).join(',') === 'food,other,zzz-unknown-orphan',
      idsOf(sorted).join(','),
    );
  }
  // 7b — TWO orphan ids never reshuffle relative to each other across calls
  // (never ordered by enqueue/queue timing) — alphabetical tiebreak is stable.
  {
    const entries: [string, number][] = [
      ['orphan-b', 1],
      ['orphan-a', 2],
    ];
    const run1 = idsOf(sortBudgetEntriesByCategoryOrder(entries, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER));
    const run2 = idsOf(sortBudgetEntriesByCategoryOrder(entries.slice().reverse(), DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER));
    check(
      '7b multiple orphans -> deterministic alphabetical tiebreak, independent of input order',
      run1.join(',') === 'orphan-a,orphan-b' && run2.join(',') === 'orphan-a,orphan-b',
      `run1=${run1.join(',')} run2=${run2.join(',')}`,
    );
  }

  // 8 — reconnect/ack: the SAME category id sorts to the SAME position
  // whether its row is still "pending" (arbitrary attempted amount) or has
  // become a normal authoritative row (real synced amount) — position is a
  // pure function of category id only, never of pending/failed/amount state.
  {
    const stillPending: [string, number][] = [
      ['food', 100000],
      ['shopping', 1], // pending CREATE, attempted amount
      ['cafe', 200000],
    ];
    const afterAck: [string, number][] = [
      ['food', 100000],
      ['shopping', 999999], // now a normal authoritative row, real synced amount
      ['cafe', 200000],
    ];
    const before = idsOf(sortBudgetEntriesByCategoryOrder(stillPending, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER));
    const after = idsOf(sortBudgetEntriesByCategoryOrder(afterAck, DEFAULT_CUSTOM_CATS, DEFAULT_CAT_ORDER));
    check(
      '8 pending -> authoritative transition after ack does NOT move the row',
      before.join(',') === after.join(','),
      `before=${before.join(',')} after=${after.join(',')}`,
    );
  }

  // 9 — custom category participates in the order via `customCats`, and a
  // user-defined `catOrder` (mirrors app/categories.tsx's reorder feature —
  // this fix reuses it read-only, never writes it) changes the resulting
  // display order, exactly like every other category-order-driven screen.
  {
    const customCats: CustomCatMap = {
      expense: [{ id: 'c-1', name: '반려동물', bg: '#fff', color: '#000', icon: 'gift', custom: true }],
      income: [],
    };
    const catOrder: CatOrderMap = {
      ...DEFAULT_CAT_ORDER,
      expense: ['shopping', 'food', 'c-1', 'transit'],
    };
    const entries: [string, number][] = [
      ['transit', 1],
      ['c-1', 2],
      ['food', 3],
      ['shopping', 4],
    ];
    const sorted = sortBudgetEntriesByCategoryOrder(entries, customCats, catOrder);
    check(
      '9 custom category + user-reordered catOrder -> Budget follows it exactly',
      idsOf(sorted).join(',') === 'shopping,food,c-1,transit',
      idsOf(sorted).join(','),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
