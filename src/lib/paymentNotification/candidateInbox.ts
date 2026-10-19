/**
 * 결제 알림 자동입력 — STEP 3. The "자동입력 후보" inbox, as pure logic.
 *
 * Turns the captured notifications on THIS device into candidates the user
 * reviews. Nothing here saves a transaction: the most it produces is an
 * InputPrefill for the ordinary /input form, where the user still presses
 * 저장하기 themselves. No I/O, nothing logged.
 *
 * Statuses
 *   - pending  확인 대기. May also carry `sentToInput` (the user opened the
 *              input form from it) — that is NOT proof a transaction was
 *              saved, so it stays pending.
 *   - handled  the user marked it 처리 완료 themselves, or /input did after
 *              the transaction started from it was saved (candidateAutoHandle.ts).
 *   - ignored  ONLY a notification the parser positively recognised as not a
 *              money move (ignoredReason 'promotion'). Never listed in the
 *              inbox — counted only.
 * A notification no parser can read yet (unsupported package / format) is
 * NOT ignored: it is 확인 필요 · 아직 지원하지 않는 알림 형식 (counted as
 * `unreadable`, raw text stays in the test list). Neither of the two is
 * ever written to the stored state — both are re-derived on every build, so
 * once a newer parser reads the same notification it simply shows up as a
 * pending candidate (its fingerprint does not depend on the parser).
 *
 * Dedup (device-local; cross-device dedup is a later step)
 *   - fingerprint = hash of sourcePackage + post time + whitespace-normalised
 *     title and body. The Android notification key is deliberately NOT part
 *     of it (device-local, reused by some apps), and neither are the parser
 *     id / version or the parsed fields: those are all derived from the same
 *     title + body, so they add nothing — and including them would turn an
 *     already-handled notification into a "new" candidate after a parser
 *     update. Only the hash is stored, never the text.
 *   - re-post fold: the same package + title + body again within
 *     REPOST_WINDOW_MS under another key/time is one candidate (the earliest
 *     is kept). A KakaoBank body carries the balance, so two real payments
 *     of the same amount still differ.
 */
import { toDateKey } from '@/lib/format';
import type { InputPrefill } from '@/lib/inputPrefill';
import type { ParsedPaymentCandidate } from '@/lib/paymentNotification/parserTypes';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import { withPaymentRelations } from '@/lib/paymentNotification/relation';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';

export type PaymentCandidateKind = 'card_payment' | 'card_cancellation' | 'inflow' | 'outflow';
export type PaymentInboxStatus = 'pending' | 'handled';

/** Per-fingerprint local state. Epoch ms. */
export interface PaymentCandidateStateEntry {
  sentAt?: number;
  handledAt?: number;
}
export type PaymentCandidateState = Record<string, PaymentCandidateStateEntry>;

export interface PaymentInboxItem {
  fingerprint: string;
  kind: PaymentCandidateKind;
  status: PaymentInboxStatus;
  /** The user opened /input from this candidate (not proof of a save). */
  sentToInput: boolean;
  candidate: ParsedPaymentCandidate;
  /** Possibly a move between the user's own accounts — never auto-merged. */
  transferWarning: boolean;
  /** `null` = no "가계부에 입력" for this candidate (e.g. a cancellation). */
  prefill: InputPrefill | null;
  /** Re-posts folded into this candidate. */
  duplicates: number;
}

export interface PaymentInbox {
  /** Newest first. pending and handled; the screen splits them. */
  items: PaymentInboxItem[];
  /** Promotions (ignoredReason) — hidden from the inbox. */
  ignoredCount: number;
  /** Not understood by any parser YET — 확인 필요, never stored as ignored. */
  unreadableCount: number;
}

export const REPOST_WINDOW_MS = 2 * 60 * 1000;
export const CANDIDATE_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CANDIDATE_STATE_MAX_ENTRIES = 300;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const ACCOUNT_SHAPED_RE = /\(\d{4}\)$/;

/** Stable, non-reversible id for one captured notification (see header). */
export function paymentCandidateFingerprint(n: CapturedNotification): string {
  return `pc1_${hash53(`${n.packageName}\u0000${n.postedAt}\u0000${norm(n.title)}\u0000${norm(n.text)}`)}`;
}

/** `null` = not an inbox candidate (ignored / unreadable). */
export function paymentCandidateKind(c: ParsedPaymentCandidate | null): PaymentCandidateKind | null {
  if (!c || c.ignoredReason || c.direction === 'unknown' || c.amount == null) return null;
  if (c.instrument === 'card') {
    if (c.kind === 'cancellation') return 'card_cancellation';
    return c.direction === 'outflow' ? 'card_payment' : null;
  }
  if (c.kind === 'cancellation') return null;
  return c.direction === 'outflow' ? 'outflow' : 'inflow';
}

/**
 * Starting values for /input. Card payment → 지출 + merchant. 입금 → 수입 +
 * counterparty. 출금 → 지출 + memo/counterparty, a suggestion only (it may
 * be a transfer or a card bill — the screen says so). A cancellation never
 * gets one. The card is never pre-selected: registered cards carry no last 4
 * digits, so there is nothing to match on safely.
 */
export function toInputPrefill(c: ParsedPaymentCandidate, todayKey: string): InputPrefill | null {
  const kind = paymentCandidateKind(c);
  if (kind == null || kind === 'card_cancellation' || c.amount == null) return null;
  const dateKey = toDateKey(new Date(c.occurredAt));
  const memo =
    kind === 'card_payment'
      ? c.merchantCandidate
      : kind === 'inflow'
        ? c.counterparty
        : c.merchantCandidate ?? c.counterparty;
  return {
    type: kind === 'inflow' ? 'income' : 'expense',
    amount: c.amount,
    memo: memo ?? '',
    dateKey: dateKey <= todayKey ? dateKey : null,
  };
}

/** `parse` is injectable for the cases file only (e.g. a future parser). */
export function buildPaymentInbox(
  captured: readonly CapturedNotification[],
  state: PaymentCandidateState,
  todayKey: string,
  parse: (n: CapturedNotification) => ParsedPaymentCandidate | null = parsePaymentNotification,
): PaymentInbox {
  // Oldest first so a re-post folds into the original.
  const ordered = [...captured].sort((a, b) => a.postedAt - b.postedAt);
  const kept: { n: CapturedNotification; fingerprint: string; duplicates: number }[] = [];
  const seen = new Set<string>();
  for (const n of ordered) {
    const fingerprint = paymentCandidateFingerprint(n);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const original = kept.find(
      (k) =>
        k.n.packageName === n.packageName &&
        norm(k.n.title) === norm(n.title) &&
        norm(k.n.text) === norm(n.text) &&
        n.postedAt - k.n.postedAt <= REPOST_WINDOW_MS,
    );
    if (original) {
      original.duplicates += 1;
      continue;
    }
    kept.push({ n, fingerprint, duplicates: 0 });
  }

  const parsed = withPaymentRelations(kept.map((k) => parse(k.n)));
  const items: PaymentInboxItem[] = [];
  let ignoredCount = 0;
  let unreadableCount = 0;
  kept.forEach((k, i) => {
    const candidate = parsed[i];
    if (candidate?.ignoredReason) {
      ignoredCount += 1;
      return;
    }
    const kind = paymentCandidateKind(candidate);
    if (!candidate || kind == null) {
      unreadableCount += 1;
      return;
    }
    const entry = state[k.fingerprint];
    items.push({
      fingerprint: k.fingerprint,
      kind,
      status: entry?.handledAt != null ? 'handled' : 'pending',
      sentToInput: entry?.sentAt != null,
      candidate,
      transferWarning:
        (kind === 'inflow' || kind === 'outflow') &&
        (!!candidate.relationKey || (!!candidate.counterparty && ACCOUNT_SHAPED_RE.test(candidate.counterparty))),
      prefill: toInputPrefill(candidate, todayKey),
      duplicates: k.duplicates,
    });
  });
  items.sort((a, b) => b.candidate.occurredAt - a.candidate.occurredAt);
  return { items, ignoredCount, unreadableCount };
}

export function markCandidateSent(state: PaymentCandidateState, fingerprint: string, now: number): PaymentCandidateState {
  return { ...state, [fingerprint]: { ...state[fingerprint], sentAt: now } };
}

export function markCandidateHandled(
  state: PaymentCandidateState,
  fingerprint: string,
  now: number,
): PaymentCandidateState {
  return { ...state, [fingerprint]: { ...state[fingerprint], handledAt: now } };
}

/** Back to 확인 대기 (keeps `sentAt`). */
export function markCandidatePending(state: PaymentCandidateState, fingerprint: string): PaymentCandidateState {
  const { handledAt: _drop, ...rest } = state[fingerprint] ?? {};
  return { ...state, [fingerprint]: rest };
}

/**
 * Validates stored state (anything malformed is dropped), forgets entries
 * untouched for 30 days — far past the 7-day capture buffer — and keeps at
 * most 300, most recently touched first.
 */
export function prunePaymentCandidateState(raw: unknown, now: number): PaymentCandidateState {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const rows: [string, PaymentCandidateStateEntry, number][] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith('pc1_') || value == null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const entry: PaymentCandidateStateEntry = {};
    if (valid(v.sentAt)) entry.sentAt = v.sentAt;
    if (valid(v.handledAt)) entry.handledAt = v.handledAt;
    const touched = Math.max(entry.sentAt ?? 0, entry.handledAt ?? 0);
    if (touched === 0 || now - touched > CANDIDATE_STATE_MAX_AGE_MS) continue;
    rows.push([key, entry, touched]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  return Object.fromEntries(rows.slice(0, CANDIDATE_STATE_MAX_ENTRIES).map(([k, e]) => [k, e]));
}

/** cyrb53 — a fast 53-bit string hash (not cryptographic; dedup only). */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
