/**
 * Static verification for src/lib/paymentNotification/ (STEP 2 KakaoBank
 * parser + registry + relation detection). Plain data + runner, same
 * convention as the other *.cases.ts files; nothing imports it in the app.
 *
 * Fixtures follow the layout of real KakaoBank captures but every name,
 * memo, account number and amount is MASKED / synthetic.
 *
 * Run ad-hoc:
 *   transpile src/lib/paymentNotification/*.ts (commonjs, "@/*" → src/*),
 *   then `node` a script that calls runPaymentNotificationParserCases().
 */
import {
  KAKAOBANK_PACKAGE,
  KAKAOBANK_PARSER_ID,
  KAKAOBANK_PARSER_VERSION,
  parseWon,
} from '@/lib/paymentNotification/kakaoBankParser';
import type { ParsedPaymentCandidate, PaymentNotificationInput } from '@/lib/paymentNotification/parserTypes';
import { isParserSupportedPackage, parsePaymentNotification } from '@/lib/paymentNotification/registry';
import { findPaymentRelations, withPaymentRelations } from '@/lib/paymentNotification/relation';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const SECOND = 1000;

// Masked versions of the two real captures (one move of 48,000원).
const OUT_TITLE = '출금 48,000원';
const OUT_TEXT = '입출금통장(1111) → 홍*동(테스트짐 ○○점 PT) 잔액 202,000원';
const IN_TITLE = '입금 48,000원';
const IN_TEXT = '홍*동 → 개인사업자통장(2222) 잔액 1,919,404원';

const kb = (title: string, text: string, postedAt = NOW, key = 'k'): PaymentNotificationInput => ({
  notificationKey: key,
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});

const show = (c: ParsedPaymentCandidate | null) =>
  c
    ? `${c.direction} ${c.amount} acct=${c.accountName}/${c.accountLast4} cp=${c.counterparty} memo=${c.merchantCandidate} ${c.confidence} [${c.reasons.join('; ')}]`
    : 'null';

type Want = Partial<
  Pick<
    ParsedPaymentCandidate,
    | 'direction'
    | 'amount'
    | 'currency'
    | 'accountName'
    | 'accountLast4'
    | 'counterparty'
    | 'merchantCandidate'
    | 'confidence'
  >
>;

export function runPaymentNotificationParserCases(): { results: CaseResult[]; passed: number; failed: number } {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const expect = (name: string, input: PaymentNotificationInput, want: Want | null) => {
    const got = parsePaymentNotification(input);
    const pass =
      want === null
        ? got === null
        : got !== null && (Object.keys(want) as (keyof Want)[]).every((k) => got[k] === want[k]);
    check(name, pass, `got ${show(got)}`);
  };

  // ── real-capture layout ───────────────────────────────────────
  expect('KB 1 출금 example → outflow, my account left, counterparty right', kb(OUT_TITLE, OUT_TEXT), {
    direction: 'outflow',
    amount: 48000,
    currency: 'KRW',
    accountName: '입출금통장',
    accountLast4: '1111',
    counterparty: '홍*동',
    merchantCandidate: '테스트짐 ○○점 PT',
    confidence: 'high',
  });
  expect('KB 2 입금 example → inflow, counterparty left, my account right', kb(IN_TITLE, IN_TEXT), {
    direction: 'inflow',
    amount: 48000,
    currency: 'KRW',
    accountName: '개인사업자통장',
    accountLast4: '2222',
    counterparty: '홍*동',
    merchantCandidate: null,
    confidence: 'high',
  });
  check(
    'KB 3 parser id / version / sourceKey / occurredAt are set',
    (() => {
      const c = parsePaymentNotification(kb(OUT_TITLE, OUT_TEXT, NOW - 5 * SECOND, 'key-1'));
      return (
        c?.parserId === KAKAOBANK_PARSER_ID &&
        c.parserVersion === KAKAOBANK_PARSER_VERSION &&
        c.sourceKey === 'key-1' &&
        c.sourcePackage === KAKAOBANK_PACKAGE &&
        c.occurredAt === NOW - 5 * SECOND &&
        c.relationKey === undefined
      );
    })(),
  );

  // ── balance never becomes the amount ──────────────────────────
  expect('BAL 1 잔액 in body is not the amount', kb('출금 5,000원', '입출금통장(1111) → 홍*동 잔액 999,999원'), {
    amount: 5000,
    counterparty: '홍*동',
  });
  expect('BAL 2 body with only a balance, title without amount → no amount', kb('출금', '잔액 202,000원'), {
    direction: 'unknown',
    amount: null,
    confidence: 'low',
  });
  check(
    'BAL 3 reasons say the balance was excluded',
    parsePaymentNotification(kb(OUT_TITLE, OUT_TEXT))?.reasons.includes('잔액은 금액에서 제외') === true,
  );

  // ── amount formats ────────────────────────────────────────────
  expect('AMT 1 no comma', kb('출금 48000원', '입출금통장(1111) → 홍*동'), { amount: 48000, confidence: 'high' });
  check('AMT 2 parseWon 1,234,567', parseWon('1,234,567') === 1234567);
  check('AMT 3 parseWon rejects 0', parseWon('0') === null);
  check('AMT 4 parseWon rejects a malformed comma group', parseWon('1,23') === null && parseWon('12,0000') === null);
  check('AMT 5 parseWon rejects a leading zero', parseWon('012') === null);
  check('AMT 6 parseWon rejects > 10억', parseWon('1,100,000,000') === null);
  expect('AMT 7 malformed title amount → direction kept, amount null, low', kb('출금 4,80원', '입출금통장(1111) → 홍*동'), {
    direction: 'outflow',
    amount: null,
    currency: null,
    confidence: 'low',
  });

  // ── whitespace variants ───────────────────────────────────────
  expect('WS 1 no space in title, extra spaces in body', kb('출금48,000원', '  입출금통장 (1111)   →   홍*동  잔액 1원 '), {
    direction: 'outflow',
    amount: 48000,
    accountName: '입출금통장',
    accountLast4: '1111',
    counterparty: '홍*동',
    confidence: 'high',
  });
  expect('WS 2 space before 원 and newline in body', kb(' 입금  48,000 원 ', '홍*동\n→ 개인사업자통장(2222)'), {
    direction: 'inflow',
    amount: 48000,
    accountName: '개인사업자통장',
    counterparty: '홍*동',
    confidence: 'high',
  });

  // ── wrong titles ──────────────────────────────────────────────
  expect('TITLE 1 a marketing title → unknown / low', kb('이번 달 혜택 안내', '입출금통장(1111) → 홍*동'), {
    direction: 'unknown',
    amount: null,
    accountName: null,
    counterparty: null,
    confidence: 'low',
  });
  expect('TITLE 2 출금 inside a longer sentence is not accepted', kb('출금 48,000원이 예정되어 있어요', OUT_TEXT), {
    direction: 'unknown',
    amount: null,
    confidence: 'low',
  });
  expect('TITLE 3 결제 title is not guessed (only 출금/입금 supported)', kb('결제 12,000원', '테스트카페'), {
    direction: 'unknown',
    confidence: 'low',
  });

  // ── partial bodies ────────────────────────────────────────────
  expect('BODY 1 empty body → direction + amount, medium', kb(OUT_TITLE, ''), {
    direction: 'outflow',
    amount: 48000,
    accountName: null,
    counterparty: null,
    confidence: 'medium',
  });
  expect('BODY 2 no arrow → no account / counterparty, medium', kb(OUT_TITLE, '입출금통장(1111) 잔액 1,000원'), {
    accountName: null,
    counterparty: null,
    confidence: 'medium',
  });
  expect('BODY 3 counterparty missing after the arrow', kb(OUT_TITLE, '입출금통장(1111) → 잔액 1,000원'), {
    accountName: '입출금통장',
    accountLast4: '1111',
    counterparty: null,
    confidence: 'medium',
  });
  expect('BODY 4 my account without last 4 digits → account null, counterparty kept', kb(OUT_TITLE, '입출금통장 → 홍*동'), {
    accountName: null,
    accountLast4: null,
    counterparty: '홍*동',
    confidence: 'medium',
  });
  expect('BODY 5 two arrows → not guessed', kb(OUT_TITLE, '입출금통장(1111) → 홍*동 → 김*수'), {
    accountName: null,
    counterparty: null,
    confidence: 'medium',
  });
  expect('BODY 6 counterparty that is itself an account → kept whole, no memo', kb(OUT_TITLE, '입출금통장(1111) → 세이프박스(3333)'), {
    accountName: '입출금통장',
    counterparty: '세이프박스(3333)',
    merchantCandidate: null,
    confidence: 'high',
  });
  expect('BODY 7 nested / odd parentheses are not guessed', kb(OUT_TITLE, '입출금통장(1111) → 홍*동(메모(1)'), {
    counterparty: null,
    merchantCandidate: null,
    confidence: 'medium',
  });

  // ── empty / registry ──────────────────────────────────────────
  expect('EMPTY 1 empty title and body → null', kb('', ''), null);
  expect('PKG 1 unsupported package → null (fallback)', { ...kb(OUT_TITLE, OUT_TEXT), packageName: 'com.example.bank' }, null);
  expect('PKG 2 match is case-sensitive', { ...kb(OUT_TITLE, OUT_TEXT), packageName: 'com.kakaobank.Channel' }, null);
  check(
    'PKG 3 kakaobank is supported, prototype keys are not',
    isParserSupportedPackage(KAKAOBANK_PACKAGE) && !isParserSupportedPackage('toString'),
  );

  // ── relation detection ────────────────────────────────────────
  const outC = parsePaymentNotification(kb(OUT_TITLE, OUT_TEXT, NOW, 'a'));
  const inC = (t: number, key = 'b') => parsePaymentNotification(kb(IN_TITLE, IN_TEXT, t, key));
  check(
    'REL 1 same amount, opposite directions, same time → related',
    (() => {
      const keys = findPaymentRelations([outC, inC(NOW)]);
      return keys[0] != null && keys[0] === keys[1];
    })(),
  );
  check(
    'REL 2 exactly 10 s apart (either order) → related',
    (() => {
      const a = findPaymentRelations([inC(NOW + 10 * SECOND), outC]);
      const b = findPaymentRelations([outC, inC(NOW - 10 * SECOND)]);
      return a[0] != null && a[0] === a[1] && b[0] != null && b[0] === b[1];
    })(),
  );
  check(
    'REL 3 10.001 s apart → not related',
    findPaymentRelations([outC, inC(NOW + 10 * SECOND + 1)]).every((k) => k === null),
  );
  check(
    'REL 4 an hour apart → not related',
    findPaymentRelations([outC, inC(NOW + 3600 * SECOND)]).every((k) => k === null),
  );
  check(
    'REL 5 two outflows of the same amount → not related',
    findPaymentRelations([outC, parsePaymentNotification(kb(OUT_TITLE, OUT_TEXT, NOW + SECOND, 'c'))]).every(
      (k) => k === null,
    ),
  );
  check(
    'REL 6 two inflows of the same amount → not related',
    findPaymentRelations([inC(NOW), inC(NOW + SECOND, 'c')]).every((k) => k === null),
  );
  check(
    'REL 7 different amounts → not related',
    findPaymentRelations([outC, parsePaymentNotification(kb('입금 48,001원', IN_TEXT))]).every((k) => k === null),
  );
  check(
    'REL 8 different package → not related',
    findPaymentRelations([outC, { ...(inC(NOW) as ParsedPaymentCandidate), sourcePackage: 'com.example.bank' }]).every(
      (k) => k === null,
    ),
  );
  check(
    'REL 9 unparsed (null) and unknown entries are ignored and stay null',
    (() => {
      const unknown = parsePaymentNotification(kb('안내', 'x')); // direction unknown
      const keys = findPaymentRelations([null, outC, unknown, inC(NOW)]);
      return keys[0] === null && keys[2] === null && keys[1] != null && keys[1] === keys[3];
    })(),
  );
  check(
    'REL 10 one outflow + two inflows → pairs with the closest only',
    (() => {
      const keys = findPaymentRelations([outC, inC(NOW + 8 * SECOND, 'far'), inC(NOW + 2 * SECOND, 'near')]);
      return keys[0] != null && keys[2] === keys[0] && keys[1] === null;
    })(),
  );
  check(
    'REL 11 two pairs of the same amount get two different keys',
    (() => {
      const out2 = parsePaymentNotification(kb(OUT_TITLE, OUT_TEXT, NOW + 60 * SECOND, 'a2'));
      const keys = findPaymentRelations([outC, inC(NOW), out2, inC(NOW + 60 * SECOND, 'b2')]);
      return keys[0] === keys[1] && keys[2] === keys[3] && keys[0] != null && keys[2] != null && keys[0] !== keys[2];
    })(),
  );
  check(
    'REL 12 withPaymentRelations copies, does not mutate, and keeps nulls',
    (() => {
      const out = withPaymentRelations([outC, null, inC(NOW)]);
      return (
        out.length === 3 &&
        out[1] === null &&
        out[0]?.relationKey != null &&
        out[0].relationKey === out[2]?.relationKey &&
        outC?.relationKey === undefined
      );
    })(),
  );

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
