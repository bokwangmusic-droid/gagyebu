/**
 * 결제 알림 자동입력 — STEP 2. Flags candidates that are possibly the two
 * notifications of ONE money move (e.g. a KakaoBank transfer between the
 * user's own accounts posts "출금 N원" and "입금 N원" at the same moment).
 *
 * Detection only: it returns labels, never removes, merges or saves
 * anything. Pairing rule:
 *   - same sourcePackage
 *   - same non-null amount
 *   - one outflow, one inflow
 *   - |occurredAt difference| <= windowMs (default 10 s, inclusive)
 *   - neither side is a card payment (instrument 'card') — a card payment
 *     is not one side of an account-to-account move
 *   - neither side is a cancellation (kind 'cancellation')
 * Each candidate joins at most one pair; an outflow pairs with the
 * time-closest unpaired inflow.
 */
import type { ParsedPaymentCandidate } from '@/lib/paymentNotification/parserTypes';

export const PAYMENT_RELATION_WINDOW_MS = 10_000;

/**
 * Aligned with `candidates`: the relation key for each entry, or `null`.
 * `null` entries in the input (unparsed notifications) stay `null`.
 */
export function findPaymentRelations(
  candidates: readonly (ParsedPaymentCandidate | null)[],
  windowMs: number = PAYMENT_RELATION_WINDOW_MS,
): (string | null)[] {
  const keys: (string | null)[] = candidates.map(() => null);
  const pairable = (c: ParsedPaymentCandidate | null): c is ParsedPaymentCandidate =>
    c != null && c.amount != null && c.direction !== 'unknown' && c.instrument !== 'card' && c.kind !== 'cancellation';

  // Earliest outflow first so the result does not depend on list order.
  const outflows = candidates
    .map((c, i) => ({ c, i }))
    .filter((x): x is { c: ParsedPaymentCandidate; i: number } => pairable(x.c) && x.c.direction === 'outflow')
    .sort((a, b) => a.c.occurredAt - b.c.occurredAt || a.i - b.i);

  for (const out of outflows) {
    let best = -1;
    let bestGap = Infinity;
    candidates.forEach((c, i) => {
      if (keys[i] != null || !pairable(c) || c.direction !== 'inflow') return;
      if (c.sourcePackage !== out.c.sourcePackage || c.amount !== out.c.amount) return;
      const gap = Math.abs(c.occurredAt - out.c.occurredAt);
      if (gap <= windowMs && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best >= 0) {
      const inflow = candidates[best] as ParsedPaymentCandidate;
      const key = `${out.c.sourcePackage}|${out.c.amount}|${out.c.occurredAt}|${inflow.occurredAt}`;
      keys[out.i] = key;
      keys[best] = key;
    }
  }
  return keys;
}

/** Convenience: copies of the candidates with `relationKey` filled in. */
export function withPaymentRelations(
  candidates: readonly (ParsedPaymentCandidate | null)[],
  windowMs: number = PAYMENT_RELATION_WINDOW_MS,
): (ParsedPaymentCandidate | null)[] {
  const keys = findPaymentRelations(candidates, windowMs);
  return candidates.map((c, i) => (c ? { ...c, relationKey: keys[i] } : null));
}
