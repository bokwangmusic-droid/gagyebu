/**
 * 결제 알림 자동입력 — STEP 2. Shape of a parsed payment notification.
 *
 * A candidate is a READING of one notification, shown on the dev / QA
 * screen only. It is deliberately not a transaction: `direction` says which
 * way money moved on the user's account, not whether it was spending or
 * income (an 출금 can be a transfer, a card bill or a cash withdrawal; an
 * 입금 can be the user's own money coming back). Nothing here creates or
 * saves a transaction or talks to the server, and nothing is logged.
 */

export type PaymentDirection = 'outflow' | 'inflow' | 'unknown';

export type PaymentCandidateConfidence = 'high' | 'medium' | 'low';

/** Why a notification is known NOT to be a money move (e.g. an ad). */
export type PaymentIgnoredReason = 'promotion';

export interface ParsedPaymentCandidate {
  sourcePackage: string;
  /** The captured notification's key — device-local, NOT unique per payment. */
  sourceKey: string;
  parserId: string;
  parserVersion: number;

  direction: PaymentDirection;
  /** Whole won, > 0. `null` = no trustworthy amount. Never the balance. */
  amount: number | null;
  currency: 'KRW' | null;

  /**
   * The user's own account on this notification, e.g. "입출금통장" — or,
   * when `instrument` is 'card', the card, e.g. "체크카드".
   */
  accountName: string | null;
  /** Its last 4 digits as printed, e.g. "8815". */
  accountLast4: string | null;
  /** 'card' = a card payment; accountName / accountLast4 then name the card. Absent = account move. */
  instrument?: 'card';
  /**
   * 'cancellation' = a card payment being cancelled ("카드 결제 취소 N원").
   * direction is then 'inflow' (the money comes back to the card's account)
   * but it is NOT income and NOT a new spend — it reverses an earlier
   * payment, which is NOT looked up or linked here. Absent = ordinary move.
   */
  kind?: 'cancellation';

  /** The other side of the move as printed (a person, a company, an account). */
  counterparty: string | null;
  /**
   * Text in parentheses after the counterparty. Often a memo / merchant,
   * but NOT guaranteed to be one — a candidate for the user to confirm.
   */
  merchantCandidate: string | null;

  /** Epoch ms — the notification's post time. */
  occurredAt: number;

  confidence: PaymentCandidateConfidence;
  /** Short Korean notes on how the reading was made. Never contains raw text. */
  reasons: string[];

  /**
   * Set when the parser recognised the notification as NOT a money move
   * (e.g. a promotion). Such a candidate is never a transaction candidate:
   * direction 'unknown', amount null, confidence 'low'.
   */
  ignoredReason?: PaymentIgnoredReason;

  /**
   * Set by findPaymentRelations(): candidates sharing a key are possibly the
   * two sides of the SAME money move. Display only — nothing merges on it.
   */
  relationKey?: string | null;
}

/** What a per-app parser receives: one captured notification. */
export interface PaymentNotificationInput {
  notificationKey: string;
  packageName: string;
  title: string;
  text: string;
  postedAt: number;
}

/** `null` = this parser has nothing to say (empty notification). */
export type PaymentNotificationParser = (input: PaymentNotificationInput) => ParsedPaymentCandidate | null;

/*
 * TODO(STEP 3+, save-time dedup — design only, NOT implemented):
 * findPaymentRelations() only LABELS possible pairs. Before anything is
 * saved the following still has to be decided and QA'd on real devices:
 *   - an outflow + inflow pair between the user's OWN accounts (both sides
 *     carry one of the user's accounts) → one internal transfer, not an
 *     expense + an income.
 *   - a pair where only one side is the user's account (e.g. paying someone
 *     who banks at KakaoBank too) must NOT be merged.
 *   - the same notification re-posted under a new key (same direction,
 *     amount, counterparty, within ~2 minutes) → one candidate.
 *   - every merge is shown to the user; nothing is dropped silently.
 */
