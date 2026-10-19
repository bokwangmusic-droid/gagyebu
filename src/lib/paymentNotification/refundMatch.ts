/**
 * 결제 알림 후보함 — 카드 결제 취소 → 원결제 찾기 → 전액 취소 처리.
 *
 * A cancellation candidate ("카드 결제 취소 N원") never changes the ledger by
 * itself. The user asks for its original payment; this file lists the
 * expenses that could be it, the user picks ONE and confirms, and only then
 * that expense is deleted through the ordinary transaction delete (soft
 * delete online, the durable offline delete queue otherwise — the very
 * paths /input's 삭제 uses). Deleting the expense takes it out of the month's
 * spending, a 신용카드's billed amount and (via the DB balance trigger) a
 * 체크카드 account's balance, exactly like a manual delete.
 *
 * Matching (findRefundMatches) — a list for the user, never a decision:
 *   1. 'inbox': a card payment candidate on THIS phone, before the
 *      cancellation, same amount, same merchant (normalised), same card last
 *      4 when both have one, whose transaction id is known exactly — saved
 *      from the 후보함 (manualTxnId), automatically (autoSaveTxnId) or with
 *      its server event's derived id (txn-pn-<event id>).
 *   2. 'ledger': any visible expense of exactly the same amount dated on or
 *      before the cancellation's day, at most REFUND_MATCH_WINDOW_DAYS days
 *      earlier. A memo equal to the merchant only ranks it higher. A
 *      transaction carries no card last 4, so the card never decides it.
 * Every match is shown — two purchases of the same amount at the same shop
 * are both listed, and one match is never chosen for the user.
 *
 * Excluded: income; anything not deletable right now (no server version,
 * or an offline change still pending — the delete needs its server token);
 * a transaction another cancellation was already recorded against.
 *
 * Full cancellations only: the cancellation's amount must equal the chosen
 * expense's amount exactly. A partial cancellation is never computed or
 * applied — the user edits the original by hand.
 *
 * Pure apart from the injected IO. Nothing here creates a transaction.
 */
import { toDateKey } from '@/lib/format';
import { paymentAutoSaveTransactionId } from '@/lib/paymentNotification/autoSave';
import {
  markCandidateRefunded,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import type { Transaction } from '@/store/types';

/** How far back an original payment is looked for (days, by date). */
export const REFUND_MATCH_WINDOW_DAYS = 30;

export type RefundMatchBasis = 'inbox' | 'ledger';

export interface RefundMatch {
  transaction: Transaction;
  /** 'inbox' = the 후보함 knows this exact transaction for the original payment. */
  basis: RefundMatchBasis;
  /** For ordering only — never used to choose. */
  score: number;
  /** Short Korean notes for the list. */
  reasons: string[];
}

export interface RefundMatchInput {
  cancel: PaymentInboxItem;
  /** The whole 후보함 (its card payment candidates are the 'inbox' evidence). */
  items: readonly PaymentInboxItem[];
  state: PaymentCandidateState;
  householdId: string;
  /** The household's visible (not deleted) transactions. */
  transactions: readonly Transaction[];
  /** Transactions that can be deleted now (server version known, nothing pending). */
  deletableIds: ReadonlySet<string>;
}

const normMerchant = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Transactions some cancellation on this phone was already recorded against. */
export function refundUsedTransactionIds(state: PaymentCandidateState): Set<string> {
  const used = new Set<string>();
  for (const entry of Object.values(state)) if (entry.refundTxnId) used.add(entry.refundTxnId);
  return used;
}

/** Local date keys [from, to] an original payment of this cancellation may have. */
function windowKeys(cancelAt: number): { from: string; to: string } {
  return { from: toDateKey(new Date(cancelAt - REFUND_MATCH_WINDOW_DAYS * DAY_MS)), to: toDateKey(new Date(cancelAt)) };
}

function inWindow(t: Transaction, cancelAt: number): boolean {
  const key = toDateKey(t.date);
  const w = windowKeys(cancelAt);
  return key >= w.from && key <= w.to;
}

/** The exact transaction id a card payment candidate is known by, if any. */
function knownTransactionId(item: PaymentInboxItem, state: PaymentCandidateState, householdId: string): string | null {
  const entry = state[item.fingerprint];
  if (!entry) return null;
  if (entry.manualTxnId && entry.manualHouseholdId === householdId) return entry.manualTxnId;
  if (entry.registeredHouseholdId !== householdId) return null;
  if (entry.autoSaveTxnId) return entry.autoSaveTxnId;
  return entry.registeredEventId ? paymentAutoSaveTransactionId(entry.registeredEventId) : null;
}

/** The expense can be offered for this cancellation at all (any basis). */
function offerable(t: Transaction, amount: number, cancelAt: number, input: RefundMatchInput, used: Set<string>): boolean {
  return (
    t.type === 'expense' &&
    t.amount === amount &&
    inWindow(t, cancelAt) &&
    input.deletableIds.has(t.id) &&
    !used.has(t.id)
  );
}

/** The 원결제 candidates for one cancellation, strongest first. `[]` = none (or already processed). */
export function findRefundMatches(input: RefundMatchInput): RefundMatch[] {
  const { cancel, state } = input;
  const c = cancel.candidate;
  const amount = c.amount;
  if (cancel.kind !== 'card_cancellation' || amount == null || amount <= 0) return [];
  if (state[cancel.fingerprint]?.refundTxnId) return [];
  const used = refundUsedTransactionIds(state);
  const cancelAt = c.occurredAt;
  const merchant = normMerchant(c.merchantCandidate);
  const byId = new Map(input.transactions.map((t) => [t.id, t] as const));
  const matches: RefundMatch[] = [];
  const taken = new Set<string>();

  for (const p of input.items) {
    const pc = p.candidate;
    if (p.kind !== 'card_payment' || pc.amount !== amount) continue;
    if (pc.occurredAt >= cancelAt || cancelAt - pc.occurredAt > REFUND_MATCH_WINDOW_DAYS * DAY_MS) continue;
    if (!merchant || normMerchant(pc.merchantCandidate) !== merchant) continue;
    if (c.accountLast4 && pc.accountLast4 && c.accountLast4 !== pc.accountLast4) continue;
    const id = knownTransactionId(p, state, input.householdId);
    const t = id ? byId.get(id) : undefined;
    if (!t || taken.has(t.id) || !offerable(t, amount, cancelAt, input, used)) continue;
    taken.add(t.id);
    matches.push({
      transaction: t,
      basis: 'inbox',
      score: 100,
      reasons: [
        '후보함에서 입력한 결제',
        '금액 일치',
        '가맹점 일치',
        ...(c.accountLast4 && pc.accountLast4 ? ['카드 끝 4자리 일치'] : []),
      ],
    });
  }

  for (const t of input.transactions) {
    if (taken.has(t.id) || !offerable(t, amount, cancelAt, input, used)) continue;
    const memo = t.memo.trim();
    const days = Math.max(0, Math.round((new Date(toDateKey(new Date(cancelAt))).getTime() - new Date(toDateKey(t.date)).getTime()) / DAY_MS));
    const reasons = ['금액 일치'];
    let score = 0;
    if (merchant && memo === (c.merchantCandidate ?? '').trim()) {
      score += 30;
      reasons.push('메모가 가맹점과 같아요');
    } else if (merchant && normMerchant(memo) === merchant) {
      score += 20;
      reasons.push('메모가 가맹점과 같아요');
    }
    reasons.push(days === 0 ? '같은 날 거래' : `${days}일 전 거래`);
    score += Math.max(0, REFUND_MATCH_WINDOW_DAYS - days) / REFUND_MATCH_WINDOW_DAYS;
    matches.push({ transaction: t, basis: 'ledger', score, reasons });
  }

  return matches.sort(
    (a, b) =>
      b.score - a.score ||
      new Date(b.transaction.date).getTime() - new Date(a.transaction.date).getTime() ||
      (a.transaction.id < b.transaction.id ? -1 : 1),
  );
}

/**
 * Same-merchant expenses of a DIFFERENT amount (a partial cancellation
 * perhaps) — shown only so the user can open one and edit it by hand.
 * Never deleted or changed from here.
 */
export function findPartialRefundCandidates(input: RefundMatchInput): Transaction[] {
  const c = input.cancel.candidate;
  const merchant = normMerchant(c.merchantCandidate);
  if (input.cancel.kind !== 'card_cancellation' || c.amount == null || !merchant) return [];
  if (input.state[input.cancel.fingerprint]?.refundTxnId) return [];
  return input.transactions
    .filter(
      (t) =>
        t.type === 'expense' &&
        t.amount !== c.amount &&
        inWindow(t, c.occurredAt) &&
        normMerchant(t.memo) === merchant,
    )
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export type RefundBlocker =
  /** Not a card payment cancellation. */
  | 'not-cancellation'
  /** This cancellation was already processed. */
  | 'already-refunded'
  /** The amounts differ — a partial cancellation is never applied. */
  | 'partial'
  /** Not an expense. */
  | 'not-expense'
  /** Another cancellation was already recorded against this transaction. */
  | 'used'
  /** Not deletable right now (no server version / an offline change pending). */
  | 'unavailable';

export const REFUND_BLOCKER_MESSAGE: Record<RefundBlocker, string> = {
  'not-cancellation': '카드 결제 취소 알림이 아니에요.',
  'already-refunded': '이미 환불 처리한 취소 알림이에요.',
  partial: '부분 취소는 아직 자동 처리할 수 없어요. 원래 거래를 직접 수정해 주세요.',
  'not-expense': '지출 거래만 취소 처리할 수 있어요.',
  used: '다른 취소 알림으로 이미 처리한 거래예요.',
  unavailable: '이 거래는 지금 처리할 수 없어요. 잠시 후 다시 시도해 주세요.',
};

/** Why `transaction` cannot be processed as this cancellation's original, or `null`. */
export function cardCancelRefundBlocker(
  cancel: PaymentInboxItem,
  transaction: Transaction,
  state: PaymentCandidateState,
  deletableIds: ReadonlySet<string>,
): RefundBlocker | null {
  if (cancel.kind !== 'card_cancellation' || cancel.candidate.amount == null) return 'not-cancellation';
  if (state[cancel.fingerprint]?.refundTxnId) return 'already-refunded';
  if (transaction.type !== 'expense') return 'not-expense';
  if (transaction.amount !== cancel.candidate.amount) return 'partial';
  if (refundUsedTransactionIds(state).has(transaction.id)) return 'used';
  if (!deletableIds.has(transaction.id)) return 'unavailable';
  return null;
}

export type RefundDeleteResult =
  | { ok: true }
  | { ok: false; transport: boolean; reason?: string; message?: string };

export type RefundEnqueueResult = { ok: true } | { ok: false; reason: string };

export interface RefundIO {
  /** The ordinary soft delete (softDeleteTransaction) with the row's server token. */
  softDelete: (transactionId: string) => Promise<RefundDeleteResult>;
  /** The ordinary durable offline delete (enqueueTransactionDelete), same token. */
  enqueueDelete: (transactionId: string) => Promise<RefundEnqueueResult>;
  loadState: () => Promise<PaymentCandidateState>;
  /** Read-modify-write of the stored 후보함 state. */
  updateState: (change: (state: PaymentCandidateState) => PaymentCandidateState) => Promise<PaymentCandidateState>;
  now: () => number;
}

export type RefundOutcome =
  /** Deleted (or queued for delete); the cancellation is 처리 완료 with the transaction recorded. */
  | { kind: 'refunded'; queued: boolean; recorded: boolean }
  /** Nothing was deleted: the checks refused it. */
  | { kind: 'blocked'; blocker: RefundBlocker }
  /** The delete was refused (conflict / gone / identity / error); nothing recorded. */
  | { kind: 'failed'; reason?: string; message?: string }
  /** Offline and the delete could not be queued; nothing recorded. */
  | { kind: 'queue-failed'; reason: string };

/**
 * Runs the user's confirmed choice. Re-checks everything against the STORED
 * state first (another cancellation may have taken the transaction
 * meanwhile), then deletes it the ordinary way; only a delete that succeeded
 * or was durably queued marks the cancellation. Never throws.
 */
export async function refundCardCancellation(
  cancel: PaymentInboxItem,
  transaction: Transaction,
  deletableIds: ReadonlySet<string>,
  io: RefundIO,
): Promise<RefundOutcome> {
  let state: PaymentCandidateState;
  try {
    state = await io.loadState();
  } catch {
    return { kind: 'blocked', blocker: 'unavailable' };
  }
  const blocker = cardCancelRefundBlocker(cancel, transaction, state, deletableIds);
  if (blocker) return { kind: 'blocked', blocker };

  let queued = false;
  try {
    const res = await io.softDelete(transaction.id);
    if (!res.ok) {
      if (!res.transport) return { kind: 'failed', reason: res.reason, message: res.message };
      const enq = await io.enqueueDelete(transaction.id);
      if (!enq.ok) return { kind: 'queue-failed', reason: enq.reason };
      queued = true;
    }
  } catch {
    return { kind: 'failed' };
  }

  // The transaction is gone (or will be): never undone. A failed record only
  // leaves the cancellation pending — it then finds no match any more.
  try {
    await io.updateState((s) => markCandidateRefunded(s, cancel.fingerprint, transaction.id, io.now()));
    return { kind: 'refunded', queued, recorded: true };
  } catch {
    return { kind: 'refunded', queued, recorded: false };
  }
}
