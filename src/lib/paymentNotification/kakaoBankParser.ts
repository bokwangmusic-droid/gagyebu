/**
 * 결제 알림 자동입력 — STEP 2. KakaoBank (com.kakaobank.channel) notification
 * parser. Pure, no I/O.
 *
 * Modelled on real captures (masked):
 *   title  "출금 48,000원"
 *   text   "입출금통장(0000) → 홍*동(○○짐 ○○점 PT) 잔액 200,000원"
 *   title  "입금 48,000원"
 *   text   "홍*동 → 개인사업자통장(0000) 잔액 1,900,000원"
 *
 * Rules:
 *   - direction + amount come from the TITLE only: "출금 N원" → outflow,
 *     "입금 N원" → inflow. Any other title → unknown / null / low. The body
 *     is never searched for an amount, so the 잔액 can't be mistaken for it.
 *   - the trailing "잔액 N원" is cut off the body before anything else.
 *   - the body must be exactly "<left> → <right>". The arrow is the money's
 *     path: outflow = <my account> → <counterparty>, inflow = <counterparty>
 *     → <my account>.
 *   - my account = "<name>(<4 digits>)".
 *   - counterparty = "<name>" or "<name>(<memo>)". The memo is only a
 *     merchantCandidate — it is not assumed to be a merchant. A counterparty
 *     that is itself "<name>(<4 digits>)" is reported as an account-shaped
 *     counterparty (possibly the user's own account).
 *   - high = title and body both fully understood; medium = title only;
 *     low = title not understood.
 *
 * Card payments (real capture, masked):
 *   title  "카드 결제 5,400원"
 *   text   "체크카드(0000) | ○○25 ○○점 잔액 190,500원"
 *   - the title must be exactly "카드 결제 N원" → outflow; amount from the
 *     title only (the body's 잔액 is cut off first, as above).
 *   - body = "<card>(<4 digits>) | <merchant>". The card goes into
 *     accountName / accountLast4 with instrument 'card'; the merchant is a
 *     merchantCandidate only (counterparty stays null).
 *   - any other wording is NOT matched (unknown / low).
 *
 * Card payment cancellations (real capture, masked):
 *   title  "카드 결제 취소 17,150원"
 *   text   "체크카드(0000) | 쿠팡(쿠페이) 잔액 51,598원"
 *   - the title must be exactly "카드 결제 취소 N원" → inflow with kind
 *     'cancellation' (money back, never income / a new spend); amount from
 *     the title only. The body uses the card payment rules above.
 *   - the original payment is NOT looked up or linked.
 *
 * Promotions: a notification whose title is NOT a transaction title, whose
 * body carries no "잔액 N원", AND which contains an ad opt-out marker
 * ("알림 해지", "수신 거부", "(광고)", "[광고]") gets ignoredReason
 * 'promotion'. A word like "혜택" alone is never enough, and a transaction
 * title is never ignored.
 */
import type {
  ParsedPaymentCandidate,
  PaymentCandidateConfidence,
  PaymentDirection,
  PaymentNotificationInput,
} from '@/lib/paymentNotification/parserTypes';

export const KAKAOBANK_PACKAGE = 'com.kakaobank.channel';
export const KAKAOBANK_PARSER_ID = 'kakaobank';
export const KAKAOBANK_PARSER_VERSION = 3;

const MAX_AMOUNT = 1_000_000_000;
const MAX_NAME_LENGTH = 40;

const TITLE_RE = /^(출금|입금)\s*([\d,]+)\s*원$/;
const CARD_TITLE_RE = /^카드 ?결제\s*([\d,]+)\s*원$/;
const CARD_CANCEL_TITLE_RE = /^카드 ?결제 ?취소\s*([\d,]+)\s*원$/;
const CARD_SEPARATOR = '|';
const BALANCE_ANYWHERE_RE = /잔액\s*:?\s*[\d,]+\s*원/;
const PROMOTION_MARKER_RE = /알림\s*해지|수신\s*거부|\(광고\)|\[광고\]/;
const AMOUNT_FORMAT_RE = /^(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)$/;
const TRAILING_BALANCE_RE = /\s*잔액\s*:?\s*[\d,]+\s*원\s*$/;
const ARROW = '→';
const ACCOUNT_RE = /^(.+?)\s*\((\d{4})\)$/;
const NAME_WITH_MEMO_RE = /^([^()]+?)\s*\(([^()]*)\)$/;

/** Exported for the cases file. `null` = not a well-formed, plausible won amount. */
export function parseWon(token: string): number | null {
  const t = token.trim();
  if (!AMOUNT_FORMAT_RE.test(t)) return null;
  const value = Number(t.replace(/,/g, ''));
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT) return null;
  return value;
}

export function parseKakaoBankNotification(input: PaymentNotificationInput): ParsedPaymentCandidate | null {
  const title = normalizeSpace(input.title ?? '');
  const text = normalizeSpace(input.text ?? '');
  if (!title && !text) return null;

  const reasons: string[] = [];
  const candidate: ParsedPaymentCandidate = {
    sourcePackage: input.packageName,
    sourceKey: input.notificationKey,
    parserId: KAKAOBANK_PARSER_ID,
    parserVersion: KAKAOBANK_PARSER_VERSION,
    direction: 'unknown',
    amount: null,
    currency: null,
    accountName: null,
    accountLast4: null,
    counterparty: null,
    merchantCandidate: null,
    occurredAt: input.postedAt,
    confidence: 'low',
    reasons,
  };

  const cardMatch = CARD_TITLE_RE.exec(title);
  if (cardMatch) return parseCardPayment(cardMatch[1], text, false, candidate, reasons);
  const cancelMatch = CARD_CANCEL_TITLE_RE.exec(title);
  if (cancelMatch) return parseCardPayment(cancelMatch[1], text, true, candidate, reasons);

  const titleMatch = TITLE_RE.exec(title);
  if (!titleMatch) {
    if (isPromotion(title, text)) {
      candidate.ignoredReason = 'promotion';
      reasons.push('광고/혜택 알림 — 거래 후보 아님');
      return candidate;
    }
    reasons.push('제목이 "출금/입금/카드 결제 N원" 형식이 아님');
    return candidate;
  }
  const direction: PaymentDirection = titleMatch[1] === '출금' ? 'outflow' : 'inflow';
  candidate.direction = direction;
  candidate.amount = parseWon(titleMatch[2]);
  if (candidate.amount == null) {
    reasons.push('제목의 금액이 올바르지 않음');
    return candidate;
  }
  candidate.currency = 'KRW';
  reasons.push(direction === 'outflow' ? '제목: 출금 (소비 여부는 미확정)' : '제목: 입금 (수입 여부는 미확정)');

  const bodyOk = parseBody(text, direction, candidate, reasons);
  candidate.confidence = confidenceOf(bodyOk);
  return candidate;
}

/** Fills account / counterparty fields. Returns whether the body was fully understood. */
function parseBody(
  text: string,
  direction: Exclude<PaymentDirection, 'unknown'>,
  out: ParsedPaymentCandidate,
  reasons: string[],
): boolean {
  if (!text) {
    reasons.push('본문 없음');
    return false;
  }
  const body = text.replace(TRAILING_BALANCE_RE, '');
  if (body !== text) reasons.push('잔액은 금액에서 제외');

  const sides = body.split(ARROW);
  if (sides.length !== 2) {
    reasons.push(sides.length < 2 ? '본문에 → 없음' : '본문에 → 가 여러 개');
    return false;
  }
  const [left, right] = sides.map((s) => s.trim());
  const [accountSide, otherSide] = direction === 'outflow' ? [left, right] : [right, left];

  let ok = true;
  const account = ACCOUNT_RE.exec(accountSide);
  if (account && account[1].length <= MAX_NAME_LENGTH) {
    out.accountName = account[1].trim();
    out.accountLast4 = account[2];
  } else {
    reasons.push('내 계좌 형식을 확인하지 못함');
    ok = false;
  }

  if (!otherSide || otherSide.length > MAX_NAME_LENGTH * 2) {
    reasons.push('상대 정보 없음');
    return false;
  }
  const otherAccount = ACCOUNT_RE.exec(otherSide);
  if (otherAccount) {
    out.counterparty = otherSide;
    reasons.push('상대도 계좌 형식 — 본인 계좌 간 이동일 수 있음');
    return ok;
  }
  const withMemo = NAME_WITH_MEMO_RE.exec(otherSide);
  if (withMemo) {
    out.counterparty = withMemo[1].trim() || null;
    out.merchantCandidate = withMemo[2].trim() || null;
    if (out.merchantCandidate) reasons.push('괄호 안 문구는 가맹점 "후보"로만 표시');
  } else if (/[()]/.test(otherSide)) {
    reasons.push('상대 정보의 괄호 형식이 예상과 다름');
    return false;
  } else {
    out.counterparty = otherSide;
  }
  if (!out.counterparty || out.counterparty.length > MAX_NAME_LENGTH) {
    out.counterparty = null;
    reasons.push('상대 이름을 확인하지 못함');
    return false;
  }
  return ok;
}

/**
 * "카드 결제 N원": outflow. "카드 결제 취소 N원": inflow with kind
 * 'cancellation'. Amount from the title token only.
 */
function parseCardPayment(
  amountToken: string,
  text: string,
  cancellation: boolean,
  out: ParsedPaymentCandidate,
  reasons: string[],
): ParsedPaymentCandidate {
  out.direction = cancellation ? 'inflow' : 'outflow';
  out.instrument = 'card';
  if (cancellation) out.kind = 'cancellation';
  out.amount = parseWon(amountToken);
  if (out.amount == null) {
    reasons.push('제목의 금액이 올바르지 않음');
    return out;
  }
  out.currency = 'KRW';
  reasons.push(cancellation ? '제목: 카드 결제 취소 (원거래 연결은 미확인)' : '제목: 카드 결제');
  out.confidence = confidenceOf(parseCardBody(text, out, reasons));
  return out;
}

/** Fills card / merchant fields. Returns whether the body was fully understood. */
function parseCardBody(text: string, out: ParsedPaymentCandidate, reasons: string[]): boolean {
  if (!text) {
    reasons.push('본문 없음');
    return false;
  }
  const body = text.replace(TRAILING_BALANCE_RE, '');
  if (body !== text) reasons.push('잔액은 금액에서 제외');

  const sides = body.split(CARD_SEPARATOR);
  if (sides.length !== 2) {
    reasons.push(sides.length < 2 ? '본문에 | 없음' : '본문에 | 가 여러 개');
    return false;
  }
  const [cardSide, merchantSide] = sides.map((s) => s.trim());

  let ok = true;
  const card = ACCOUNT_RE.exec(cardSide);
  if (card && card[1].length <= MAX_NAME_LENGTH) {
    out.accountName = card[1].trim();
    out.accountLast4 = card[2];
  } else {
    reasons.push('카드 형식을 확인하지 못함');
    ok = false;
  }

  if (
    !merchantSide ||
    merchantSide.length > MAX_NAME_LENGTH ||
    merchantSide.includes(ARROW) ||
    merchantSide.includes('잔액')
  ) {
    reasons.push('가맹점을 확인하지 못함');
    return false;
  }
  out.merchantCandidate = merchantSide;
  reasons.push('가맹점은 "후보"로만 표시');
  return ok;
}

/** Conservative: needs an ad opt-out marker, and never fires on a body with a 잔액. */
function isPromotion(title: string, text: string): boolean {
  if (BALANCE_ANYWHERE_RE.test(text)) return false;
  return PROMOTION_MARKER_RE.test(title) || PROMOTION_MARKER_RE.test(text);
}

function confidenceOf(bodyOk: boolean): PaymentCandidateConfidence {
  return bodyOk ? 'high' : 'medium';
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
