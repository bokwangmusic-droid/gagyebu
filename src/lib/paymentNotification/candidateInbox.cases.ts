/**
 * Static verification for the 결제 알림 후보함 (candidateInbox.ts) and the
 * /input prefill params (src/lib/inputPrefill.ts). Plain data + runner, same
 * convention as the other *.cases.ts files. The screen itself is real-device QA.
 */
import { toDateKey } from '@/lib/format';
import { INPUT_PREFILL_MAX_MEMO_LENGTH, inputPrefillToParams, parseInputPrefillParams } from '@/lib/inputPrefill';
import {
  buildPaymentInbox,
  CANDIDATE_STATE_MAX_AGE_MS,
  markCandidateHandled,
  markCandidatePending,
  markCandidateSent,
  paymentCandidateFingerprint,
  prunePaymentCandidateState,
  REPOST_WINDOW_MS,
  toInputPrefill,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const TODAY = toDateKey(new Date(NOW));

const CARD_TITLE = '카드 결제 5,100원';
const CARD_TEXT = '체크카드(3308) | 청계상회 잔액 185,400원';
const CANCEL_TITLE = '카드 결제 취소 17,150원';
const CANCEL_TEXT = '체크카드(3346) | 쿠팡(쿠페이) 잔액 51,598원';
const IN_TITLE = '입금 398,400원';
const IN_TEXT = '홍*동 → 입출금통장(1111) 잔액 1,000,000원';
const OUT_TITLE = '출금 398,400원';
const OUT_TEXT = '개인사업자통장(2222) → 홍*동 잔액 2,000,000원';
const PROMO_TITLE = '최대 5만원 결제 혜택 도착!';
const PROMO_TEXT = '결제 혜택은 이틀 동안 확인 가능해요. 알림 해지 : 로그인 > 혜택 > 알림 해지';

const kb = (title: string, text: string, postedAt = NOW, key = 'k'): CapturedNotification => ({
  notificationKey: key,
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});

export function runCandidateInboxCases(): { results: CaseResult[]; passed: number; failed: number } {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const inbox = (list: CapturedNotification[], state: PaymentCandidateState = {}) =>
    buildPaymentInbox(list, state, TODAY);

  // ── dedup ─────────────────────────────────────────────────────
  check(
    'DEDUP 1 the same captured notification listed twice → one candidate',
    inbox([kb(CARD_TITLE, CARD_TEXT), kb(CARD_TITLE, CARD_TEXT)]).items.length === 1,
  );
  check(
    'DEDUP 2 re-parse / re-entry gives the same fingerprint',
    paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT)) === paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT)) &&
      inbox([kb(CARD_TITLE, CARD_TEXT)]).items[0].fingerprint === inbox([kb(CARD_TITLE, CARD_TEXT)]).items[0].fingerprint,
  );
  check(
    'DEDUP 3 a different Android key alone does not make a new candidate',
    inbox([kb(CARD_TITLE, CARD_TEXT, NOW, 'a'), kb(CARD_TITLE, CARD_TEXT, NOW, 'b')]).items.length === 1 &&
      paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT, NOW, 'a')) ===
        paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT, NOW, 'b')),
  );
  check(
    'DEDUP 4 whitespace-only differences are the same candidate',
    paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT)) ===
      paymentCandidateFingerprint(kb(` ${CARD_TITLE} `, CARD_TEXT.replace(' | ', '  |  '))),
  );
  check(
    'DEDUP 5 a re-post within 2 min under a new key folds into the earliest',
    (() => {
      const r = inbox([kb(CARD_TITLE, CARD_TEXT, NOW + 30 * SECOND, 'b'), kb(CARD_TITLE, CARD_TEXT, NOW, 'a')]);
      return (
        r.items.length === 1 &&
        r.items[0].duplicates === 1 &&
        r.items[0].candidate.occurredAt === NOW &&
        r.items[0].fingerprint === paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT, NOW, 'a'))
      );
    })(),
  );
  check(
    'DEDUP 6 the same text more than 2 min later is a separate candidate',
    inbox([kb(CARD_TITLE, CARD_TEXT), kb(CARD_TITLE, CARD_TEXT, NOW + REPOST_WINDOW_MS + 1, 'b')]).items.length === 2,
  );
  check(
    'DEDUP 7 two real payments of the same amount (different balance) stay two',
    inbox([kb(CARD_TITLE, CARD_TEXT), kb(CARD_TITLE, '체크카드(3308) | 청계상회 잔액 180,300원', NOW + SECOND, 'b')])
      .items.length === 2,
  );
  check(
    'DEDUP 8 the fingerprint does not contain the notification text',
    (() => {
      const fp = paymentCandidateFingerprint(kb(CARD_TITLE, CARD_TEXT));
      return /^pc1_[0-9a-z]+$/.test(fp) && !fp.includes('청계') && !fp.includes('3308');
    })(),
  );

  // ── card payment ──────────────────────────────────────────────
  const card = inbox([kb(CARD_TITLE, CARD_TEXT)]).items[0];
  check(
    'CARD 1 card payment → pending card_payment candidate',
    card?.kind === 'card_payment' && card.status === 'pending' && !card.sentToInput && !card.transferWarning,
  );
  check(
    'CARD 2 → expense prefill: amount 5,100, memo = merchantCandidate, date = occurredAt day',
    card?.prefill?.type === 'expense' &&
      card.prefill.amount === 5100 &&
      card.prefill.memo === '청계상회' &&
      card.prefill.dateKey === TODAY,
  );
  check(
    'CARD 3 card last 4 kept on the candidate, merchant kept, balance never the amount',
    card?.candidate.accountLast4 === '3308' &&
      card.candidate.merchantCandidate === '청계상회' &&
      card.candidate.amount === 5100,
  );
  check(
    'CARD 4 prefill never names a card (no safe last-4 match exists)',
    card?.prefill != null && Object.keys(card.prefill).sort().join(',') === 'amount,dateKey,memo,type',
  );
  check(
    'CARD 5 card payment + same-amount 입금 within 10 s → no relation, no transfer warning',
    (() => {
      const r = inbox([kb(CARD_TITLE, CARD_TEXT, NOW, 'c'), kb('입금 5,100원', IN_TEXT, NOW + 2 * SECOND, 'i')]);
      return r.items.length === 2 && r.items.every((i) => i.candidate.relationKey == null && !i.transferWarning);
    })(),
  );
  check(
    'CARD 6 occurredAt in the future (clock skew) → no date, form default',
    (() => {
      const c = parsePaymentNotification(kb(CARD_TITLE, CARD_TEXT, NOW + 2 * 24 * 3600 * SECOND));
      return c != null && toInputPrefill(c, TODAY)?.dateKey === null;
    })(),
  );

  // ── cancellation ──────────────────────────────────────────────
  const cancel = inbox([kb(CANCEL_TITLE, CANCEL_TEXT)]).items[0];
  check(
    'CANCEL 1 card cancellation is listed as a pending candidate',
    cancel?.kind === 'card_cancellation' &&
      cancel.status === 'pending' &&
      cancel.candidate.amount === 17150 &&
      cancel.candidate.accountLast4 === '3346' &&
      cancel.candidate.merchantCandidate === '쿠팡(쿠페이)',
  );
  check(
    'CANCEL 2 cancellation gets no prefill (no 일반 지출 / 수입 input)',
    cancel?.prefill === null &&
      (() => {
        const c = parsePaymentNotification(kb(CANCEL_TITLE, CANCEL_TEXT));
        return c != null && toInputPrefill(c, TODAY) === null;
      })(),
  );
  check(
    'CANCEL 3 cancellation + same-amount 출금 / 입금 → not related, no transfer warning',
    (() => {
      const r = inbox([
        kb(CANCEL_TITLE, CANCEL_TEXT, NOW, 'x'),
        kb('출금 17,150원', OUT_TEXT, NOW + SECOND, 'o'),
      ]);
      return r.items.every((i) => i.candidate.relationKey == null && !i.transferWarning);
    })(),
  );

  // ── promotions / unreadable ───────────────────────────────────
  check(
    'PROMO 1 promotion → not a candidate, counted as ignored',
    (() => {
      const r = inbox([kb(PROMO_TITLE, PROMO_TEXT), kb(CARD_TITLE, CARD_TEXT, NOW + SECOND, 'c')]);
      return r.items.length === 1 && r.items[0].kind === 'card_payment' && r.ignoredCount === 1 && r.unreadableCount === 0;
    })(),
  );
  check(
    'PROMO 2 unreadable / unsupported → not a candidate, counted',
    (() => {
      const r = inbox([kb('안내', '내용'), { ...kb(CARD_TITLE, CARD_TEXT), packageName: 'com.example.bank' }]);
      return r.items.length === 0 && r.unreadableCount === 2 && r.ignoredCount === 0;
    })(),
  );

  // ── promotion (ignored) vs unsupported (확인 필요) ────────────
  const UNSUPPORTED = kb('해외 결제 12.00 USD', '체크카드(3308) | AMAZON 잔액 185,400원', NOW, 'u');
  check(
    'UNSUP 1 promotion → ignored only, never counted as unsupported',
    (() => {
      const r = inbox([kb(PROMO_TITLE, PROMO_TEXT)]);
      return r.ignoredCount === 1 && r.unreadableCount === 0 && r.items.length === 0;
    })(),
  );
  check(
    'UNSUP 2 unsupported 금융 알림 → unreadable (확인 필요), not ignored',
    (() => {
      const r = inbox([UNSUPPORTED]);
      return r.unreadableCount === 1 && r.ignoredCount === 0 && r.items.length === 0;
    })(),
  );
  check(
    'UNSUP 3 building the inbox writes no state (nothing stored as ignored)',
    (() => {
      const state: PaymentCandidateState = {};
      inbox([UNSUPPORTED, kb(PROMO_TITLE, PROMO_TEXT)], state);
      return Object.keys(state).length === 0;
    })(),
  );
  check(
    'UNSUP 4 stored state cannot carry an ignored flag (prune drops unknown fields)',
    (() => {
      const fpU = paymentCandidateFingerprint(UNSUPPORTED);
      const out = prunePaymentCandidateState({ [fpU]: { ignoredAt: NOW, status: 'ignored' } }, NOW);
      return Object.keys(out).length === 0;
    })(),
  );
  check(
    'UNSUP 5 the same notification read by a newer parser → pending candidate, same fingerprint',
    (() => {
      const before = inbox([UNSUPPORTED]);
      const futureParser = (n: CapturedNotification) => {
        const base = parsePaymentNotification(kb(CARD_TITLE, n.text, n.postedAt, n.notificationKey));
        return n.title.startsWith('해외 결제') && base
          ? { ...base, parserVersion: base.parserVersion + 1, amount: 16000 }
          : parsePaymentNotification(n);
      };
      const after = buildPaymentInbox([UNSUPPORTED], {}, TODAY, futureParser);
      const item = after.items[0];
      return (
        before.unreadableCount === 1 &&
        after.unreadableCount === 0 &&
        item?.status === 'pending' &&
        item.kind === 'card_payment' &&
        item.fingerprint === paymentCandidateFingerprint(UNSUPPORTED) &&
        item.prefill?.amount === 16000
      );
    })(),
  );
  check(
    'UNSUP 6 default parser argument = registry (same result as before)',
    JSON.stringify(buildPaymentInbox([kb(CARD_TITLE, CARD_TEXT)], {}, TODAY)) ===
      JSON.stringify(buildPaymentInbox([kb(CARD_TITLE, CARD_TEXT)], {}, TODAY, parsePaymentNotification)),
  );

  // ── 입금 / 출금 ───────────────────────────────────────────────
  const inflow = inbox([kb(IN_TITLE, IN_TEXT)]).items[0];
  check(
    'IN 1 입금 → inflow candidate, income prefill, memo = counterparty',
    inflow?.kind === 'inflow' &&
      inflow.prefill?.type === 'income' &&
      inflow.prefill.amount === 398400 &&
      inflow.prefill.memo === '홍*동' &&
      !inflow.transferWarning,
  );
  const outflow = inbox([kb(OUT_TITLE, OUT_TEXT)]).items[0];
  check(
    'OUT 1 출금 alone → outflow candidate (expense suggestion only), no transfer warning',
    outflow?.kind === 'outflow' && outflow.prefill?.type === 'expense' && !outflow.transferWarning,
  );
  check(
    'REL 1 related 출금 + 입금 → both stay separate candidates, both carry the transfer warning',
    (() => {
      const r = inbox([kb(OUT_TITLE, OUT_TEXT, NOW, 'o'), kb(IN_TITLE, IN_TEXT, NOW + 3 * SECOND, 'i')]);
      return (
        r.items.length === 2 &&
        r.items.every((i) => i.transferWarning && i.candidate.relationKey != null) &&
        r.items[0].candidate.relationKey === r.items[1].candidate.relationKey
      );
    })(),
  );
  check(
    'REL 2 counterparty shaped like an account → transfer warning',
    inbox([kb(OUT_TITLE, '입출금통장(1111) → 세이프박스(3333)')]).items[0]?.transferWarning === true,
  );
  check(
    'REL 3 a deduped re-post does not pair with its own original',
    (() => {
      const r = inbox([kb(OUT_TITLE, OUT_TEXT, NOW, 'a'), kb(OUT_TITLE, OUT_TEXT, NOW + SECOND, 'b')]);
      return r.items.length === 1 && !r.items[0].transferWarning;
    })(),
  );

  // ── status ────────────────────────────────────────────────────
  const fp = card.fingerprint;
  check(
    'STATE 1 sent → still pending, flagged sentToInput (not handled)',
    (() => {
      const item = inbox([kb(CARD_TITLE, CARD_TEXT)], markCandidateSent({}, fp, NOW)).items[0];
      return item.status === 'pending' && item.sentToInput;
    })(),
  );
  check(
    'STATE 2 handled → status handled; back to pending keeps sentAt',
    (() => {
      const handled = markCandidateHandled(markCandidateSent({}, fp, NOW), fp, NOW + 1);
      const a = inbox([kb(CARD_TITLE, CARD_TEXT)], handled).items[0];
      const back = markCandidatePending(handled, fp);
      const b = inbox([kb(CARD_TITLE, CARD_TEXT)], back).items[0];
      return a.status === 'handled' && b.status === 'pending' && b.sentToInput && back[fp].handledAt === undefined;
    })(),
  );
  check(
    'STATE 3 handled state survives a re-parse (same fingerprint) — no new pending candidate',
    (() => {
      const state = markCandidateHandled({}, fp, NOW);
      const r = inbox([kb(CARD_TITLE, CARD_TEXT, NOW, 'other-key'), kb(CARD_TITLE, CARD_TEXT)], state);
      return r.items.length === 1 && r.items[0].status === 'handled';
    })(),
  );
  check(
    'STATE 4 mark helpers do not mutate their input',
    (() => {
      const s: PaymentCandidateState = {};
      markCandidateSent(s, fp, NOW);
      markCandidateHandled(s, fp, NOW);
      return Object.keys(s).length === 0;
    })(),
  );
  check(
    'STATE 5 prune drops malformed / foreign / >30-day entries, keeps valid ones',
    (() => {
      const out = prunePaymentCandidateState(
        {
          [fp]: { sentAt: NOW },
          pc1_old: { handledAt: NOW - CANDIDATE_STATE_MAX_AGE_MS - 1 },
          pc1_bad: { sentAt: 'x' },
          other: { sentAt: NOW },
        },
        NOW,
      );
      return Object.keys(out).join(',') === fp && out[fp].sentAt === NOW;
    })(),
  );
  check(
    'STATE 6 prune of a non-object → {}',
    Object.keys(prunePaymentCandidateState(null, NOW)).length === 0 &&
      Object.keys(prunePaymentCandidateState([1, 2], NOW)).length === 0,
  );

  // ── /input prefill params ─────────────────────────────────────
  check(
    'PREFILL 1 card prefill round-trips through route params',
    (() => {
      const p = card.prefill!;
      const back = parseInputPrefillParams(inputPrefillToParams(p), TODAY);
      return back?.type === 'expense' && back.amount === 5100 && back.memo === '청계상회' && back.dateKey === TODAY;
    })(),
  );
  check(
    'PREFILL 2 missing / bad type or amount → no prefill',
    parseInputPrefillParams({}, TODAY) === null &&
      parseInputPrefillParams({ prefillType: 'transfer', prefillAmount: '100' }, TODAY) === null &&
      parseInputPrefillParams({ prefillType: 'expense', prefillAmount: '0' }, TODAY) === null &&
      parseInputPrefillParams({ prefillType: 'expense', prefillAmount: '1,000' }, TODAY) === null &&
      parseInputPrefillParams({ prefillType: 'expense', prefillAmount: '99999999999' }, TODAY) === null,
  );
  check(
    'PREFILL 3 future / malformed date dropped, rest kept',
    parseInputPrefillParams({ prefillType: 'income', prefillAmount: '10', prefillDate: '2999-01-01' }, TODAY)?.dateKey ===
      null &&
      parseInputPrefillParams({ prefillType: 'income', prefillAmount: '10', prefillDate: '2026-02-30' }, TODAY)
        ?.dateKey === null &&
      parseInputPrefillParams({ prefillType: 'income', prefillAmount: '10', prefillDate: 'x' }, TODAY)?.amount === 10,
  );
  check(
    'PREFILL 4 over-long memo dropped; array params take the first value',
    parseInputPrefillParams(
      { prefillType: 'expense', prefillAmount: '10', prefillMemo: 'a'.repeat(INPUT_PREFILL_MAX_MEMO_LENGTH + 1) },
      TODAY,
    )?.memo === '' &&
      parseInputPrefillParams({ prefillType: ['expense', 'income'], prefillAmount: ['10'] }, TODAY)?.type === 'expense',
  );

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
