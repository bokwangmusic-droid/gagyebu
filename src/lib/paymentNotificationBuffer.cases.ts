/**
 * Static verification for src/lib/paymentNotificationBuffer.ts — the rules
 * of the on-device captured-notification buffer (allowlist filter, 50-entry
 * cap, 7-day purge, repeated-key handling, payload normalization). Plain
 * data + runner, same convention as the other *.cases.ts files.
 *
 * These cases cover the TypeScript mirror. The Kotlin implementation the
 * listener service actually runs, and the service itself, are real-device QA.
 */
import {
  CAPTURED_MAX_AGE_MS,
  CAPTURED_MAX_ENTRIES,
  CAPTURED_MAX_TEXT_LENGTH,
  CAPTURED_MAX_TITLE_LENGTH,
  captureNotification,
  isPackageAllowed,
  normalizeAllowedPackages,
  normalizeCapturedNotification,
  purgeCapturedNotifications,
  sanitizeCapturedNotifications,
  upsertCapturedNotification,
  type CapturedNotification,
} from '@/lib/paymentNotificationBuffer';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const BANK = 'com.example.bank';
const CHAT = 'com.example.chat';

const entry = (over: Partial<CapturedNotification> = {}): CapturedNotification => ({
  notificationKey: '0|com.example.bank|1|null|10001',
  packageName: BANK,
  title: '승인',
  text: '12,000원 테스트가맹점',
  postedAt: NOW - MINUTE,
  ...over,
});

export async function runPaymentNotificationBufferCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---------- allowlist ---------- */
  check(
    'ALLOW 1 packages are trimmed, de-duplicated and non-strings / blanks dropped',
    normalizeAllowedPackages([' com.example.bank ', BANK, '', '   ', 3, null, CHAT]).join(',') === `${BANK},${CHAT}`,
  );
  check('ALLOW 2 an allowlisted package is admitted', isPackageAllowed(BANK, [BANK]));
  check('ALLOW 3 a package not on the list is refused', !isPackageAllowed(CHAT, [BANK]));
  check('ALLOW 4 an empty allowlist admits nothing', !isPackageAllowed(BANK, []));
  check(
    'ALLOW 5 the match is exact — no prefix, no case folding',
    !isPackageAllowed('com.example.bank.evil', [BANK]) &&
      !isPackageAllowed('com.example', [BANK]) &&
      !isPackageAllowed('COM.EXAMPLE.BANK', [BANK]) &&
      !isPackageAllowed('', ['']),
  );
  check(
    'ALLOW 6 capture stores an allowlisted notification',
    (() => {
      const out = captureNotification([], entry(), [BANK], NOW);
      return out.length === 1 && out[0].packageName === BANK;
    })(),
  );
  check(
    'ALLOW 7 capture stores nothing for a package off the list',
    captureNotification([], entry({ packageName: CHAT }), [BANK], NOW).length === 0,
  );
  check(
    'ALLOW 8 capture stores nothing while the allowlist is empty',
    captureNotification([], entry(), [], NOW).length === 0,
  );
  check(
    'ALLOW 9 a refused notification leaves the existing buffer untouched',
    (() => {
      const before = [entry()];
      const out = captureNotification(before, entry({ packageName: CHAT, notificationKey: 'k2' }), [BANK], NOW);
      return out.length === 1 && out[0].notificationKey === before[0].notificationKey;
    })(),
  );

  /* ---------- normalization ---------- */
  check(
    'NORM 1 fields are trimmed and CRLF becomes LF',
    (() => {
      const n = normalizeCapturedNotification(
        { notificationKey: ' k ', packageName: ` ${BANK} `, title: '  승인  ', text: ' a\r\nb ', postedAt: NOW },
        NOW,
      );
      return (
        n != null &&
        n.notificationKey === 'k' &&
        n.packageName === BANK &&
        n.title === '승인' &&
        n.text === 'a\nb' &&
        n.postedAt === NOW
      );
    })(),
  );
  check(
    'NORM 2 a missing key or package is dropped',
    normalizeCapturedNotification({ packageName: BANK, title: 't', text: 'x' }, NOW) === null &&
      normalizeCapturedNotification({ notificationKey: 'k', packageName: '  ', title: 't' }, NOW) === null,
  );
  check(
    'NORM 3 no title AND no text is dropped; either one alone is kept',
    normalizeCapturedNotification({ notificationKey: 'k', packageName: BANK, title: ' ', text: '' }, NOW) === null &&
      normalizeCapturedNotification({ notificationKey: 'k', packageName: BANK, title: 't' }, NOW)?.text === '' &&
      normalizeCapturedNotification({ notificationKey: 'k', packageName: BANK, text: 'x' }, NOW)?.title === '',
  );
  check(
    'NORM 4 over-long title / text are cut to their caps',
    (() => {
      const n = normalizeCapturedNotification(
        { notificationKey: 'k', packageName: BANK, title: 'T'.repeat(500), text: 'X'.repeat(5000) },
        NOW,
      );
      return n?.title.length === CAPTURED_MAX_TITLE_LENGTH && n?.text.length === CAPTURED_MAX_TEXT_LENGTH;
    })(),
  );
  check(
    'NORM 5 an unusable postedAt falls back to now',
    [undefined, 0, -5, Number.NaN, '123'].every(
      (postedAt) =>
        normalizeCapturedNotification({ notificationKey: 'k', packageName: BANK, title: 't', postedAt }, NOW)
          ?.postedAt === NOW,
    ),
  );
  check(
    'NORM 6 non-string title / text are treated as empty',
    normalizeCapturedNotification({ notificationKey: 'k', packageName: BANK, title: 42, text: 'x' }, NOW)?.title ===
      '',
  );
  check(
    'NORM 7 the native reply is sanitized: junk rows dropped, non-array -> empty',
    (() => {
      const out = sanitizeCapturedNotifications(
        [entry(), null, 'x', 7, { packageName: BANK }, entry({ notificationKey: 'k2', postedAt: NOW - 2 * MINUTE })],
        NOW,
      );
      return (
        out.length === 2 &&
        sanitizeCapturedNotifications(null, NOW).length === 0 &&
        sanitizeCapturedNotifications({ length: 1 }, NOW).length === 0
      );
    })(),
  );

  /* ---------- 50-entry cap ---------- */
  check(
    'CAP 1 the 51st entry pushes the OLDEST one out',
    (() => {
      let buf: CapturedNotification[] = [];
      for (let i = 0; i < CAPTURED_MAX_ENTRIES + 1; i += 1) {
        buf = upsertCapturedNotification(buf, entry({ notificationKey: `k${i}`, postedAt: NOW - (100 - i) * MINUTE }), NOW);
      }
      return (
        buf.length === CAPTURED_MAX_ENTRIES &&
        !buf.some((e) => e.notificationKey === 'k0') &&
        buf[0].notificationKey === `k${CAPTURED_MAX_ENTRIES}`
      );
    })(),
  );
  check(
    'CAP 2 purge alone caps an over-full list and returns newest first',
    (() => {
      const many = Array.from({ length: 120 }, (_, i) => entry({ notificationKey: `k${i}`, postedAt: NOW - i * MINUTE }));
      const out = purgeCapturedNotifications(many.slice().reverse(), NOW);
      return (
        out.length === CAPTURED_MAX_ENTRIES &&
        out[0].notificationKey === 'k0' &&
        out[CAPTURED_MAX_ENTRIES - 1].notificationKey === `k${CAPTURED_MAX_ENTRIES - 1}`
      );
    })(),
  );
  check(
    'CAP 3 exactly 50 entries are all kept',
    purgeCapturedNotifications(
      Array.from({ length: CAPTURED_MAX_ENTRIES }, (_, i) => entry({ notificationKey: `k${i}`, postedAt: NOW - i })),
      NOW,
    ).length === CAPTURED_MAX_ENTRIES,
  );

  /* ---------- 7-day purge ---------- */
  check(
    'AGE 1 an entry older than 7 days is removed',
    purgeCapturedNotifications([entry({ postedAt: NOW - CAPTURED_MAX_AGE_MS - 1 })], NOW).length === 0,
  );
  check(
    'AGE 2 an entry exactly 7 days old is still kept',
    purgeCapturedNotifications([entry({ postedAt: NOW - CAPTURED_MAX_AGE_MS })], NOW).length === 1,
  );
  check(
    'AGE 3 only the stale entries go; fresh ones stay',
    (() => {
      const out = purgeCapturedNotifications(
        [
          entry({ notificationKey: 'old', postedAt: NOW - CAPTURED_MAX_AGE_MS - MINUTE }),
          entry({ notificationKey: 'new', postedAt: NOW - MINUTE }),
        ],
        NOW,
      );
      return out.length === 1 && out[0].notificationKey === 'new';
    })(),
  );
  check(
    'AGE 4 a new capture also purges what has gone stale meanwhile',
    (() => {
      const out = captureNotification(
        [entry({ notificationKey: 'old', postedAt: NOW - CAPTURED_MAX_AGE_MS - MINUTE })],
        entry({ notificationKey: 'new', postedAt: NOW }),
        [BANK],
        NOW,
      );
      return out.length === 1 && out[0].notificationKey === 'new';
    })(),
  );
  check(
    'AGE 5 reading (sanitize) purges stale entries too',
    sanitizeCapturedNotifications([entry({ postedAt: NOW - CAPTURED_MAX_AGE_MS - 1 })], NOW).length === 0,
  );

  /* ---------- repeated notificationKey ---------- */
  check(
    'KEY 1 the same notification posted again is not added twice',
    (() => {
      let buf = upsertCapturedNotification([], entry({ postedAt: NOW - 5 * MINUTE }), NOW);
      for (let i = 0; i < 5; i += 1) buf = upsertCapturedNotification(buf, entry({ postedAt: NOW - i * MINUTE }), NOW);
      return buf.length === 1;
    })(),
  );
  check(
    'KEY 2 a repeat keeps the FIRST arrival time',
    (() => {
      const first = entry({ postedAt: NOW - 5 * MINUTE });
      const buf = upsertCapturedNotification(upsertCapturedNotification([], first, NOW), entry({ postedAt: NOW }), NOW);
      return buf.length === 1 && buf[0].postedAt === first.postedAt;
    })(),
  );
  check(
    'KEY 3 a repeat that differs only in whitespace is still the same notification',
    (() => {
      const buf = captureNotification(
        captureNotification([], entry(), [BANK], NOW),
        entry({ title: ' 승인 ', text: '12,000원 테스트가맹점\r\n', postedAt: NOW }),
        [BANK],
        NOW,
      );
      return buf.length === 1;
    })(),
  );
  check(
    'KEY 4 the same key with DIFFERENT content is kept as a second entry',
    (() => {
      const buf = upsertCapturedNotification(
        upsertCapturedNotification([], entry(), NOW),
        entry({ text: '8,500원 다른가맹점', postedAt: NOW }),
        NOW,
      );
      return buf.length === 2 && buf[0].text === '8,500원 다른가맹점';
    })(),
  );
  check(
    'KEY 5 identical content under a DIFFERENT key is a separate notification',
    upsertCapturedNotification(upsertCapturedNotification([], entry(), NOW), entry({ notificationKey: 'other' }), NOW)
      .length === 2,
  );
  check(
    'KEY 6 upsert does not mutate the list it was given',
    (() => {
      const before = [entry()];
      upsertCapturedNotification(before, entry({ notificationKey: 'k2' }), NOW);
      return before.length === 1;
    })(),
  );

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
