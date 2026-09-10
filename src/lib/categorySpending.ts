/**
 * "카테고리별 지출 상세" list rows — pure, no store/UI imports.
 *
 * The Home screen already computes `byCategory` (expense per category id)
 * and `expense` (month total) via `monthlyTotals` (src/lib/aggregate.ts).
 * This turns that SAME map into the ordered rows the dedicated detail
 * screen renders, so a per-category amount and the total always match Home
 * exactly — no re-aggregation, no new formula.
 *
 * `sharePct` is the rounded share of `total`; when `total` is 0 it is 0,
 * never `NaN` (empty-period guard).
 */
export interface CategorySpendingRow {
  id: string;
  amount: number;
  /** rounded % of `total`; 0 when `total <= 0`. */
  sharePct: number;
}

export function categorySpendingRows(
  byCategory: Record<string, number>,
  total: number,
): CategorySpendingRow[] {
  return Object.entries(byCategory)
    .filter(([, amount]) => amount > 0) // never list a 0-spend (or negative) category
    .sort((a, b) => b[1] - a[1]) // largest spend first (same order Home uses)
    .map(([id, amount]) => ({
      id,
      amount,
      sharePct: total > 0 ? Math.round((amount / total) * 100) : 0,
    }));
}
