/**
 * 결제 알림 자동입력 — STEP 5. What the phone sends to
 * public.register_payment_notification_event
 * (supabase/migrations/20261019002200_payment_notification_events.sql) so
 * the server keeps ONE event per real money move, however many phones /
 * re-posts / retries report it. Registration only — no transaction is
 * created from it. Pure, no I/O; hashing is injected.
 *
 * base fingerprint (p_dedup_key) = SHA-256 hex of
 *   "pn1" \0 household id \0 source package \0 normalised title \0
 *   normalised body
 * Only what is INTRINSIC to the push, so every phone of the household
 * computes the same value for the same real event, whatever else it has
 * captured before:
 *   - the notification text carries the type and amount (title) and the
 *     card / account last 4 and, for KakaoBank, the balance after the move
 *     (body). The balance is what separates two real payments of the same
 *     amount at the same shop. The parsed fields are NOT hashed separately:
 *     they are derived from this same text, and hashing them would make the
 *     key depend on the parser — a parser update must not create a "new"
 *     event.
 *   - the household id salts the hash: the same text gives an unrelated key
 *     in another household.
 *   - NOT the Android notification key (device-local), NOT the post time
 *     (it is each phone's own arrival time), and NOTHING from this phone's
 *     history: no counters / ordinals.
 * Time is compared by the server: the same base fingerprint within
 * PAYMENT_EVENT_MATCH_TOLERANCE_MS of an existing event IS that event.
 *
 * The raw text never leaves the phone — only this hash and the parsed
 * amount / last 4 / type / time. Only inbox candidates are registered: a
 * promotion (ignored) or a notification no parser reads yet never is.
 */
import {
  REPOST_WINDOW_MS,
  type PaymentCandidateKind,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';

export const PAYMENT_EVENT_DEDUP_VERSION = 'pn1';
/**
 * Same as the server's match tolerance (migration header): ±2 minutes, the
 * window the inbox already treats an identical re-posted text as one
 * notification (REPOST_WINDOW_MS). Each phone stamps its own arrival time;
 * pushes of one event to two awake phones arrive seconds apart. Kept small
 * on purpose: an identical text further apart (pay → cancel → pay again,
 * same balance) is a separate real event and must not merge. A phone that
 * gets the push more than 2 minutes late (e.g. offline) registers a second
 * event — a visible duplicate, never a lost payment.
 */
export const PAYMENT_EVENT_MATCH_TOLERANCE_MS = REPOST_WINDOW_MS;

export type PaymentEventType = 'card_purchase' | 'card_cancel' | 'income' | 'outflow';

const EVENT_TYPE: Record<PaymentCandidateKind, PaymentEventType> = {
  card_payment: 'card_purchase',
  card_cancellation: 'card_cancel',
  inflow: 'income',
  outflow: 'outflow',
};

export function paymentEventType(kind: PaymentCandidateKind): PaymentEventType {
  return EVENT_TYPE[kind];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function paymentEventDedupPreimage(householdId: string, item: PaymentInboxItem): string {
  const n = item.notification;
  return `${PAYMENT_EVENT_DEDUP_VERSION}\u0000${householdId}\u0000${n.packageName}\u0000${norm(n.title)}\u0000${norm(n.text)}`;
}

/** Arguments of register_payment_notification_event, minus the hash. */
export interface PaymentEventRegistration {
  fingerprint: string;
  /** Hash this (SHA-256 hex) into p_dedup_key. Never sent as-is. */
  preimage: string;
  sourcePackage: string;
  parserId: string;
  parserVersion: number;
  eventType: PaymentEventType;
  amount: number;
  last4: string | null;
  /** Epoch ms — the notification's post time on this phone. */
  occurredAt: number;
}

/**
 * The inbox candidates not yet registered from this phone for this
 * household. A failed / skipped registration simply comes back on the next
 * build — the server call is idempotent, so a retry never adds a row.
 */
export function buildPaymentEventRegistrations(
  items: readonly PaymentInboxItem[],
  householdId: string,
  state: PaymentCandidateState,
): PaymentEventRegistration[] {
  const out: PaymentEventRegistration[] = [];
  for (const item of items) {
    const c = item.candidate;
    if (state[item.fingerprint]?.registeredHouseholdId === householdId) continue;
    if (c.amount == null || !Number.isSafeInteger(c.amount) || c.amount <= 0) continue;
    out.push({
      fingerprint: item.fingerprint,
      preimage: paymentEventDedupPreimage(householdId, item),
      sourcePackage: c.sourcePackage,
      parserId: c.parserId,
      parserVersion: c.parserVersion,
      eventType: paymentEventType(item.kind),
      amount: c.amount,
      last4: c.accountLast4 && /^\d{4}$/.test(c.accountLast4) ? c.accountLast4 : null,
      occurredAt: c.occurredAt,
    });
  }
  return out;
}

export type PaymentEventRegisterResult =
  | { ok: true; eventId: string; created: boolean }
  | { ok: false; transport: boolean };

/**
 * Validates the RPC's `returns table (event_id, created)` reply. Anything
 * else is a non-transport failure (not registered, not retried at once).
 */
export function parsePaymentEventRegisterReply(data: unknown): PaymentEventRegisterResult {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row.event_id !== 'string' || !row.event_id || typeof row.created !== 'boolean') {
    return { ok: false, transport: false };
  }
  return { ok: true, eventId: row.event_id, created: row.created };
}
