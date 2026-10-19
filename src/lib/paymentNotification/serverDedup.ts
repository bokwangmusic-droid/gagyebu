/**
 * 결제 알림 자동입력 — STEP 5. What the phone sends to
 * public.register_payment_notification_event
 * (supabase/migrations/20261019002200_payment_notification_events.sql) so
 * the server keeps ONE event per real money move, however many phones /
 * re-posts / retries report it. Registration only — no transaction is
 * created from it. Pure, no I/O; hashing is injected.
 *
 * base fingerprint (p_dedup_key) = SHA-256 hex of, \0-separated:
 *   "pn1", household id, source package, event type, instrument
 *   ('card' | 'account'), amount, last 4, account / card name, merchant
 *   candidate, counterparty
 * — a WHITELIST of the transaction fields the parser already extracted,
 * normalised (NFC, single spaces). Never the raw title / body:
 *   - NO balance. The parser cuts the trailing "잔액 N원" off the body
 *     before reading any field, so no field can carry it — and only these
 *     fields are hashed. Two notifications that differ only in the balance
 *     have the SAME fingerprint; the claim rule below decides.
 *   - NOT the Android notification key (device-local), NOT the post time
 *     (each phone's own arrival time — the server compares it), NOT the
 *     parser id / version, NOTHING from this phone's history.
 *   - the household id salts the hash: the same payment gives an unrelated
 *     key in another household.
 * Every phone that reads the same push the same way computes the same
 * value. A parser update that only bumps the version keeps it; one that
 * READS a field differently changes it (two phones on different app
 * versions could then register one payment twice).
 *
 * The base fingerprint alone never decides that two reports are one event
 * (two real payments of the same amount / card / merchant have the same
 * one). Each report is also a CLAIM by this app install:
 *   device hash      = SHA-256("pnd1", household id, install id)
 *   local claim hash = SHA-256("pnc1", household id, install id, local
 *                      candidate fingerprint)
 * The install id is a random UUID made once per app install
 * (src/services/paymentDeviceIdentity.ts) — not the Android notification
 * key, not the account, not a hardware id — and never leaves the phone.
 * The server's rule (migration 20261019002200):
 *   A. this device already claimed this local candidate → that event
 *      (a retry / a lost reply / a later screen visit);
 *   B. otherwise the nearest event with the same base fingerprint within
 *      ±PAYMENT_EVENT_MATCH_TOLERANCE_MS that THIS device has not claimed
 *      yet and with no purchase / cancel of the same amount and card in
 *      between — but only when no second such event is within
 *      PAYMENT_EVENT_AMBIGUITY_MARGIN_MS of that distance;
 *   C. anything else → a new event.
 * A phone sees each push once and folds its own re-posts locally, so two
 * of its candidates are two real moves: they never share an event. When a
 * merge is not clear, two events are kept: a duplicate can be dismissed,
 * a payment merged away is lost without a trace.
 *
 * The raw text never leaves the phone — only these hashes and the parsed
 * amount / last 4 / type / time. Only inbox candidates are registered: a
 * promotion (ignored) or a notification no parser reads yet never is.
 */
import {
  type PaymentCandidateKind,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';

export const PAYMENT_EVENT_DEDUP_VERSION = 'pn1';
/**
 * Cross-device merge window (= the RPC's). Each phone stamps its own
 * arrival time; one push reaches two awake phones seconds apart. Smaller
 * than the 2 min re-post window on purpose: the wider it is, the longer a
 * payment that only one phone saw can be taken for another phone's report
 * of a different one. A phone that gets the push later (Doze, offline)
 * registers a second event — a visible duplicate, never a lost payment.
 * Not backed by measured two-phone data yet.
 */
export const PAYMENT_EVENT_MATCH_TOLERANCE_MS = 30 * 1000;
/** Two candidate events whose distances differ by less than this = ambiguous → new event. */
export const PAYMENT_EVENT_AMBIGUITY_MARGIN_MS = 10 * 1000;

const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A random v4 UUID, lower case — the only accepted install id. */
export function isPaymentInstallId(v: unknown): v is string {
  return typeof v === 'string' && INSTALL_ID_RE.test(v);
}

export function paymentDeviceHashPreimage(householdId: string, installId: string): string {
  return ['pnd1', householdId, installId].join('\u0000');
}

/** Stable for one local candidate on one install; differs for any other candidate. */
export function paymentLocalClaimPreimage(householdId: string, installId: string, fingerprint: string): string {
  return ['pnc1', householdId, installId, fingerprint].join('\u0000');
}

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

const norm = (v: string | null | undefined) => (v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

export function paymentEventDedupPreimage(householdId: string, item: PaymentInboxItem): string {
  const c = item.candidate;
  return [
    PAYMENT_EVENT_DEDUP_VERSION,
    householdId,
    c.sourcePackage,
    paymentEventType(item.kind),
    c.instrument === 'card' ? 'card' : 'account',
    String(c.amount ?? ''),
    norm(c.accountLast4),
    norm(c.accountName),
    norm(c.merchantCandidate),
    norm(c.counterparty),
  ].join('\u0000');
}

/** Arguments of register_payment_notification_event, minus the hash. */
export interface PaymentEventRegistration {
  /** The local candidate fingerprint — input of the local claim hash. */
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
 * build — the same local claim always returns the same event, so a retry
 * never adds a row.
 */
export function buildPaymentEventRegistrations(
  items: readonly PaymentInboxItem[],
  householdId: string,
  state: PaymentCandidateState,
): PaymentEventRegistration[] {
  const out: PaymentEventRegistration[] = [];
  for (const item of items) {
    const c = item.candidate;
    // Registered before the event id was kept (STEP 6 needs it): asked
    // again — the same local claim returns the same event.
    const entry = state[item.fingerprint];
    if (entry?.registeredHouseholdId === householdId && entry.registeredEventId) continue;
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
