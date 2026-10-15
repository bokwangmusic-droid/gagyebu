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
 */
import type {
  ParsedPaymentCandidate,
  PaymentCandidateConfidence,
  PaymentDirection,
  PaymentNotificationInput,
} from '@/lib/paymentNotification/parserTypes';

export const KAKAOBANK_PACKAGE = 'com.kakaobank.channel';
export const KAKAOBANK_PARSER_ID = 'kakaobank';
export const KAKAOBANK_PARSER_VERSION = 1;

const MAX_AMOUNT = 1_000_000_000;
const MAX_NAME_LENGTH = 40;

const TITLE_RE = /^(출금|입금)\s*([\d,]+)\s*원$/;
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

  const titleMatch = TITLE_RE.exec(title);
  if (!titleMatch) {
    reasons.push('제목이 "출금/입금 N원" 형식이 아님');
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

function confidenceOf(bodyOk: boolean): PaymentCandidateConfidence {
  return bodyOk ? 'high' : 'medium';
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
