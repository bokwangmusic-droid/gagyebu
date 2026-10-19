/**
 * 결제 알림 자동입력 — STEP 6. "확실한 카드 결제 자동입력": a card payment
 * the parser read with full confidence is saved as an expense without the
 * user pressing anything — only when the setting is on (default OFF), and
 * only after the server dedup registered it (serverDedup.ts). Everything
 * else (입금 / 출금 / 카드 취소 / anything unclear) stays in the 후보함.
 * Pure, no I/O: the server calls are injected (src/services/paymentAutoSave.ts).
 *
 * One server event → at most one transaction, by construction: the
 * transaction id is DERIVED from the event id (`txn-pn-<event id>`), and
 * public.transactions.id is a primary key. A retry, a lost reply, a crash
 * between the steps, or two phones saving the same event at once can only
 * ever hit that one id (createTransaction's 23505 reconcile, or the link
 * check below) — never a second row. A soft-deleted auto transaction keeps
 * its id too, so it is never re-created. A MANUAL save from a registered
 * 후보함 candidate uses the same id (paymentCandidateTransactionId, /input),
 * so a manual save and an automatic one race on the same primary key: the
 * first insert wins and is kept untouched; the second finds the event's
 * transaction and adds nothing.
 *
 * Per candidate:
 *   1. the server event's link (get_payment_notification_event_link): already
 *      handled — by another phone's automatic save OR by a member's manual
 *      save from the 후보함 — → nothing to save, the candidate is done here too;
 *   2. createTransaction with the derived id (the existing create path; no
 *      offline queue — offline simply means "later");
 *   3. complete_payment_notification_event (source 'auto') links the event to
 *      it. The link also answers "does that transaction exist?" when the
 *      create came back as an error (another member's phone may have saved it
 *      first).
 *
 * LINKS (both kinds are retried from the local state until they land):
 *   - auto:   a saved automatic transaction whose link failed
 *             (autoSavedAt without autoSaveLinkedAt);
 *   - manual: a transaction the user saved in /input from a 후보함 candidate
 *             (manualTxnId, recorded by candidateAutoHandle.ts) — linked with
 *             source 'manual', so another phone's automatic save of the same
 *             event sees it as handled and saves nothing.
 * A link the server refuses is never retried; a conflict (the event is
 * linked to ANOTHER transaction — two phones raced) is flagged on the
 * candidate (linkConflictAt) so the user can check for a duplicate. Nothing
 * here ever deletes a transaction.
 */
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import type { PaymentCandidateState, PaymentCandidateStateEntry, PaymentInboxItem } from '@/lib/paymentNotification/candidateInbox';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';

/**
 * 기타 — a built-in expense category (src/data/categories.ts), always present
 * and the fallback the store already uses for a completed planned expense.
 * No category is guessed from the merchant.
 */
export const PAYMENT_AUTO_SAVE_CATEGORY = 'other';

/**
 * A manual save that was queued offline may not be on the server yet
 * (transaction_missing): its link is retried for this long, then given up.
 */
export const PAYMENT_MANUAL_LINK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PaymentAutoSaveBlocker =
  | 'not_card_payment'
  | 'package'
  | 'confidence'
  | 'amount'
  | 'merchant'
  | 'last4'
  | 'relation'
  | 'future';

export const PAYMENT_AUTO_SAVE_BLOCKER_LABEL: Record<PaymentAutoSaveBlocker, string> = {
  not_card_payment: '카드 결제가 아니에요',
  package: '지원하는 카드 앱 알림이 아니에요',
  confidence: '신뢰도가 높지 않아요',
  amount: '금액을 확인할 수 없어요',
  merchant: '가맹점을 확인할 수 없어요',
  last4: '카드 끝 4자리를 확인할 수 없어요',
  relation: '관련 알림이 있어 확인이 필요해요',
  future: '알림 시각을 확인할 수 없어요',
};

/** `null` = this candidate may be saved automatically. Any doubt → a reason. */
export function paymentAutoSaveBlocker(item: PaymentInboxItem, now: number): PaymentAutoSaveBlocker | null {
  const c = item.candidate;
  if (
    item.kind !== 'card_payment' ||
    c.instrument !== 'card' ||
    c.kind === 'cancellation' ||
    c.direction !== 'outflow' ||
    c.ignoredReason
  ) {
    return 'not_card_payment';
  }
  if (c.sourcePackage !== KAKAOBANK_PACKAGE) return 'package';
  if (c.confidence !== 'high') return 'confidence';
  if (c.amount == null || !Number.isSafeInteger(c.amount) || c.amount <= 0) return 'amount';
  if (!c.merchantCandidate || !c.merchantCandidate.trim()) return 'merchant';
  if (!c.accountLast4 || !/^\d{4}$/.test(c.accountLast4)) return 'last4';
  if (c.relationKey || item.transferWarning) return 'relation';
  if (!(c.occurredAt > 0) || c.occurredAt > now) return 'future';
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The one transaction id a server event can ever get — automatic AND manual
 * saves from a 후보함 candidate. `null` = not an event id.
 */
export function paymentAutoSaveTransactionId(eventId: string): string | null {
  return UUID_RE.test(eventId) ? `txn-pn-${eventId}` : null;
}

/**
 * The id /input uses for a new transaction started from this candidate:
 * the event's derived id when the candidate is registered in THIS household,
 * otherwise `null` (the ordinary random id — e.g. not registered yet).
 */
export function paymentCandidateTransactionId(
  state: PaymentCandidateState,
  fingerprint: string,
  householdId: string,
): { transactionId: string; eventId: string } | null {
  const entry = state[fingerprint];
  if (!entry || entry.registeredHouseholdId !== householdId || !entry.registeredEventId) return null;
  const transactionId = paymentAutoSaveTransactionId(entry.registeredEventId);
  return transactionId ? { transactionId, eventId: entry.registeredEventId } : null;
}

/**
 * 지출 · 기타 · memo = the merchant · at the notification's own time. No
 * payment method and no card: registered cards carry no last 4 digits, so
 * there is nothing to match on safely (the column is nullable).
 */
export function buildPaymentAutoSaveDraft(item: PaymentInboxItem): NewTransactionDraft {
  const c = item.candidate;
  return {
    type: 'expense',
    category: PAYMENT_AUTO_SAVE_CATEGORY,
    amount: c.amount ?? 0,
    memo: (c.merchantCandidate ?? '').trim(),
    date: new Date(c.occurredAt).toISOString(),
  };
}

// ── the injected server calls ──────────────────────────────────────
export type PaymentEventLinkResult =
  | { ok: true; status: 'pending' | 'handled'; transactionId: string | null }
  | { ok: false; transport: boolean };

export type PaymentEventCompleteStatus =
  | 'linked'
  | 'already_linked'
  | 'conflict'
  | 'transaction_missing'
  | 'transaction_mismatch'
  | 'transaction_in_use';

export type PaymentEventCompleteResult =
  | { ok: true; status: PaymentEventCompleteStatus }
  | { ok: false; transport: boolean };

export type PaymentLinkSource = 'auto' | 'manual';

export type PaymentAutoSaveCreateResult = { ok: true } | { ok: false; transport: boolean };

export interface PaymentAutoSaveIO {
  getLink: (eventId: string) => Promise<PaymentEventLinkResult>;
  create: (transactionId: string, draft: NewTransactionDraft) => Promise<PaymentAutoSaveCreateResult>;
  complete: (eventId: string, transactionId: string, source: PaymentLinkSource) => Promise<PaymentEventCompleteResult>;
}

export type PaymentAutoSaveOutcome =
  /** Saved and linked (or the link to our transaction confirmed). */
  | { kind: 'saved'; fingerprint: string; transactionId: string; linked: true }
  /**
   * Saved; the server link failed on the network — only the link is retried
   * later. With `refused` the server answered and said no: the transaction
   * stays, the candidate is handled, nothing is retried.
   */
  | {
      kind: 'saved';
      fingerprint: string;
      transactionId: string;
      linked: false;
      refused?: PaymentEventCompleteStatus;
    }
  /** The event was already handled (another phone / a manual save / an earlier run). */
  | { kind: 'already'; fingerprint: string }
  /** Network trouble before anything was saved — try again later. */
  | { kind: 'retry'; fingerprint: string }
  /** Gave up: the candidate stays for the user. */
  | { kind: 'failed'; fingerprint: string }
  /** A link-only job (see header). */
  | {
      kind: 'link';
      fingerprint: string;
      source: PaymentLinkSource;
      result: 'linked' | 'retry' | 'pending' | 'refused';
      status?: PaymentEventCompleteStatus;
    };

const isCompleted = (r: PaymentEventCompleteResult) =>
  r.ok && (r.status === 'linked' || r.status === 'already_linked');

export async function autoSavePaymentCandidate(
  item: PaymentInboxItem,
  eventId: string,
  io: PaymentAutoSaveIO,
): Promise<PaymentAutoSaveOutcome> {
  const fingerprint = item.fingerprint;
  const transactionId = paymentAutoSaveTransactionId(eventId);
  if (!transactionId) return { kind: 'failed', fingerprint };

  const link = await io.getLink(eventId);
  if (!link.ok) return link.transport ? { kind: 'retry', fingerprint } : { kind: 'failed', fingerprint };
  if (link.status === 'handled') return { kind: 'already', fingerprint };

  const created = await io.create(transactionId, buildPaymentAutoSaveDraft(item));
  if (!created.ok && created.transport) return { kind: 'retry', fingerprint };

  const linked = await io.complete(eventId, transactionId, 'auto');
  // The insert was refused but the event's transaction exists: someone else
  // (another phone, a manual save from the 후보함) saved it first — kept as
  // it is, nothing is added here.
  if (isCompleted(linked)) {
    return created.ok ? { kind: 'saved', fingerprint, transactionId, linked: true } : { kind: 'already', fingerprint };
  }
  if (created.ok) {
    // The transaction exists: never undone, never re-created. A link that
    // failed on the network is retried; a refused one is left as it is.
    return { kind: 'saved', fingerprint, transactionId, linked: false, ...(linked.ok ? { refused: linked.status } : {}) };
  }
  // The create was refused AND the link could not confirm the transaction.
  if (!linked.ok && linked.transport) return { kind: 'retry', fingerprint };
  return { kind: 'failed', fingerprint };
}

/** A link-only job. `pending` = a queued manual save not on the server yet. */
export async function linkPaymentCandidate(
  job: PaymentLinkJob,
  io: PaymentAutoSaveIO,
  now: number,
): Promise<PaymentAutoSaveOutcome> {
  const base = { kind: 'link', fingerprint: job.fingerprint, source: job.source } as const;
  const res = await io.complete(job.eventId, job.transactionId, job.source);
  if (isCompleted(res)) return { ...base, result: 'linked' };
  if (!res.ok) return res.transport ? { ...base, result: 'retry' } : { ...base, result: 'refused' };
  if (
    res.status === 'transaction_missing' &&
    job.source === 'manual' &&
    now - job.savedAt < PAYMENT_MANUAL_LINK_MAX_AGE_MS
  ) {
    return { ...base, result: 'pending', status: res.status };
  }
  return { ...base, result: 'refused', status: res.status };
}

export interface PaymentAutoSaveJob {
  item: PaymentInboxItem;
  eventId: string;
}

export interface PaymentLinkJob {
  fingerprint: string;
  eventId: string;
  transactionId: string;
  source: PaymentLinkSource;
  /** When the transaction was saved (epoch ms). */
  savedAt: number;
}

/**
 * New automatic saves for this household: only with the setting on, and
 * only for registered, pending, eligible, never-tried candidates that
 * ARRIVED AFTER it was turned on (`enabledSince`) — turning it on never saves
 * the past week's notifications, which the user may have entered by hand
 * already. A candidate the user opened in /input is left to the user.
 */
export function selectPaymentAutoSaveJobs(
  items: readonly PaymentInboxItem[],
  state: PaymentCandidateState,
  householdId: string,
  enabledSince: number | null,
  now: number,
): PaymentAutoSaveJob[] {
  const jobs: PaymentAutoSaveJob[] = [];
  for (const item of items) {
    const entry: PaymentCandidateStateEntry | undefined = state[item.fingerprint];
    if (!entry || entry.registeredHouseholdId !== householdId || !entry.registeredEventId) continue;
    if (entry.autoSaveFailedAt != null || entry.autoSavedAt != null || entry.manualTxnId) continue;
    if (enabledSince == null || item.candidate.occurredAt < enabledSince) continue;
    if (item.status !== 'pending' || entry.handledAt != null || entry.sentAt != null) continue;
    if (paymentAutoSaveBlocker(item, now) != null) continue;
    jobs.push({ item, eventId: entry.registeredEventId });
  }
  return jobs;
}

/**
 * Links still to be made for this household, setting on or off (the
 * transactions exist already). Read from the stored state alone: the
 * captured notification may be gone by then.
 */
export function selectPaymentLinkJobs(state: PaymentCandidateState, householdId: string): PaymentLinkJob[] {
  const jobs: PaymentLinkJob[] = [];
  for (const [fingerprint, entry] of Object.entries(state)) {
    if (entry.registeredHouseholdId !== householdId || !entry.registeredEventId) continue;
    if (entry.autoSavedAt != null && entry.autoSaveTxnId && entry.autoSaveLinkedAt == null && entry.autoSaveFailedAt == null) {
      jobs.push({
        fingerprint,
        eventId: entry.registeredEventId,
        transactionId: entry.autoSaveTxnId,
        source: 'auto',
        savedAt: entry.autoSavedAt,
      });
    } else if (
      entry.manualTxnId &&
      entry.manualSavedAt != null &&
      entry.manualHouseholdId === householdId &&
      entry.manualLinkedAt == null &&
      entry.manualLinkFailedAt == null
    ) {
      jobs.push({
        fingerprint,
        eventId: entry.registeredEventId,
        transactionId: entry.manualTxnId,
        source: 'manual',
        savedAt: entry.manualSavedAt,
      });
    }
  }
  return jobs;
}

/**
 * Runs the links first, then the new saves, one after another; stops at the
 * first network trouble (the rest would fail the same way).
 */
export async function runPaymentAutoSaveJobs(
  links: readonly PaymentLinkJob[],
  saves: readonly PaymentAutoSaveJob[],
  io: PaymentAutoSaveIO,
  now: number,
): Promise<PaymentAutoSaveOutcome[]> {
  const out: PaymentAutoSaveOutcome[] = [];
  for (const job of links) {
    const res = await linkPaymentCandidate(job, io, now);
    out.push(res);
    if (res.kind === 'link' && res.result === 'retry') return out;
  }
  for (const job of saves) {
    const res = await autoSavePaymentCandidate(job.item, job.eventId, io);
    out.push(res);
    if (res.kind === 'retry' || (res.kind === 'saved' && !res.linked && !res.refused)) break;
  }
  return out;
}

/** The outcomes, written into the local 후보함 state. */
export function applyPaymentAutoSaveOutcomes(
  state: PaymentCandidateState,
  outcomes: readonly PaymentAutoSaveOutcome[],
  now: number,
): PaymentCandidateState {
  let next = state;
  const put = (fingerprint: string, change: Partial<PaymentCandidateStateEntry>) => {
    next = { ...next, [fingerprint]: { ...next[fingerprint], ...change } };
  };
  for (const o of outcomes) {
    const entry = next[o.fingerprint] ?? {};
    if (o.kind === 'saved') {
      put(o.fingerprint, {
        handledAt: entry.handledAt ?? now,
        autoSaveTxnId: o.transactionId,
        autoSavedAt: entry.autoSavedAt ?? now,
        ...(o.linked ? { autoSaveLinkedAt: now } : {}),
        ...(!o.linked && o.refused ? { autoSaveFailedAt: now } : {}),
        ...(!o.linked && o.refused === 'conflict' ? { linkConflictAt: now } : {}),
      });
    } else if (o.kind === 'already') {
      put(o.fingerprint, { handledAt: entry.handledAt ?? now });
    } else if (o.kind === 'failed') {
      put(o.fingerprint, { autoSaveFailedAt: now });
    } else if (o.kind === 'link' && (o.result === 'linked' || o.result === 'refused')) {
      const done = o.result === 'linked';
      put(o.fingerprint, {
        ...(o.source === 'auto'
          ? done
            ? { autoSaveLinkedAt: now }
            : { autoSaveFailedAt: now }
          : done
            ? { manualLinkedAt: now }
            : { manualLinkFailedAt: now }),
        ...(o.status === 'conflict' ? { linkConflictAt: now } : {}),
      });
    }
  }
  return next;
}
