/**
 * Static verification for the 결제 알림 화면's user-facing status words
 * (candidateStatusLabel.ts), over real inbox items (buildPaymentInbox) and
 * parser output. Same convention as the other *.cases.ts files.
 */
import { toDateKey } from '@/lib/format';
import {
  buildPaymentInbox,
  markCandidateHandled,
  markCandidatePending,
  markCandidateSent,
  paymentCandidateFingerprint,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import {
  capturedNotificationLabel,
  paymentCandidateStatusLabel,
} from '@/lib/paymentNotification/candidateStatusLabel';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const TODAY = toDateKey(new Date(NOW));
const HH = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const TXN = 'txn-pn-22222222-2222-4222-8222-222222222222';

const kb = (title: string, text: string): CapturedNotification => ({
  notificationKey: 'k',
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt: NOW,
});
const CARD = kb('카드 결제 5,100원', '체크카드(3308) | 청계상회 잔액 185,400원');
const CANCEL = kb('카드 결제 취소 17,150원', '체크카드(3346) | 쿠팡(쿠페이) 잔액 51,598원');
const PROMO = kb('최대 5만원 결제 혜택 도착!', '결제 혜택은 이틀 동안 확인 가능해요. 알림 해지 : 로그인 > 혜택 > 알림 해지');
const UNREADABLE = kb('안내', '이번 달 이용 내역을 확인해 보세요');

export function runCandidateStatusLabelCases(): { results: CaseResult[]; passed: number; failed: number } {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const fp = paymentCandidateFingerprint(CARD);
  const cfp = paymentCandidateFingerprint(CANCEL);
  const label = (n: CapturedNotification, state: PaymentCandidateState) => {
    const item = buildPaymentInbox([n], state, TODAY).items[0];
    return item ? paymentCandidateStatusLabel(item, state[item.fingerprint]) : '(no item)';
  };

  check('LABEL-1 pending → 확인 대기', label(CARD, {}) === '확인 대기', label(CARD, {}));
  {
    const s = markCandidateSent({}, fp, NOW);
    check('LABEL-2 sent to /input, still pending → 입력 화면으로 보냄', label(CARD, s) === '입력 화면으로 보냄', label(CARD, s));
  }
  {
    const s = markCandidateHandled({}, fp, NOW);
    check('LABEL-3 handled (button, no save) → 처리 완료', label(CARD, s) === '처리 완료', label(CARD, s));
  }
  // The /input save records manualTxnId + handledAt (candidateAutoHandle.ts).
  const savedState: PaymentCandidateState = {
    [fp]: {
      sentAt: NOW,
      handledAt: NOW,
      registeredEventId: EVENT,
      registeredHouseholdId: HH,
      manualTxnId: TXN,
      manualHouseholdId: HH,
      manualSavedAt: NOW,
      manualLinkedAt: NOW,
    },
  };
  check(
    'LABEL-4 manual saved + linked → 가계부 저장 완료',
    label(CARD, savedState) === '가계부 저장 완료',
    label(CARD, savedState),
  );
  {
    // 확인 대기로 되돌리기 keeps manualTxnId: no "saved" claim while pending.
    const s = markCandidatePending(savedState, fp);
    check('LABEL-4b reverted to pending (manualTxnId kept) → not 가계부 저장 완료', label(CARD, s) !== '가계부 저장 완료', label(CARD, s));
  }
  {
    const s: PaymentCandidateState = { [cfp]: { handledAt: NOW, refundTxnId: 'txn-1799999999999-abcd', refundedAt: NOW } };
    check('LABEL-5 refunded cancellation → 환불 처리 완료', label(CANCEL, s) === '환불 처리 완료', label(CANCEL, s));
  }
  {
    const s: PaymentCandidateState = { [fp]: { handledAt: NOW, autoSaveTxnId: TXN, autoSavedAt: NOW } };
    check('LABEL-6 past automatic save → 자동저장됨', label(CARD, s) === '자동저장됨', label(CARD, s));
  }
  {
    const promo = capturedNotificationLabel(parsePaymentNotification(PROMO));
    const unreadable = capturedNotificationLabel(parsePaymentNotification(UNREADABLE));
    const none = capturedNotificationLabel(null);
    const card = capturedNotificationLabel(parsePaymentNotification(CARD));
    check(
      'LABEL-7 promotion / unsupported wording kept; a readable one has none',
      promo === '거래 후보 아님 · 광고/혜택 알림' &&
        unreadable === '해석 불가 / 확인 필요' &&
        none === '해석 불가 / 확인 필요 · 지원하지 않는 알림' &&
        card === null,
      JSON.stringify({ promo, unreadable, none, card }),
    );
  }
  {
    // Every label over a state full of internal values carries none of them.
    const internals = [fp, cfp, HH, EVENT, TXN, 'txn-', 'pc1_', String(NOW), 'live', 'queue', 'server'];
    const all = [
      label(CARD, {}),
      label(CARD, markCandidateSent({}, fp, NOW)),
      label(CARD, savedState),
      label(CARD, markCandidatePending(savedState, fp)),
      label(CANCEL, { [cfp]: { handledAt: NOW, refundTxnId: TXN, refundedAt: NOW } }),
      label(CARD, { [fp]: { handledAt: NOW, autoSaveTxnId: TXN, autoSavedAt: NOW } }),
    ];
    const leaked = all.filter((l) => internals.some((s) => l.includes(s)) || /\d{6,}/.test(l));
    check('LABEL-8 no internal id / epoch / queue / server word in any label', leaked.length === 0, JSON.stringify(all));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
