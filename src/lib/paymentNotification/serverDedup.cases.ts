/**
 * Static verification for the server dedup registration (serverDedup.ts) and
 * the RPC reply parsing. Same convention as the other *.cases.ts files: plain
 * data + a runner, never imported by the app.
 *
 * The server side is MODELLED here by `serverModel`, which follows the rule
 * of register_payment_notification_event (migration 20261019002200): per
 * (household, base fingerprint) one registration at a time (the advisory
 * lock), the nearest existing row within ±PAYMENT_EVENT_MATCH_TOLERANCE_MS of
 * occurred_at is the event, otherwise insert. The SQL itself is not executed
 * by this file.
 */
import { toDateKey } from '@/lib/format';
import {
  buildPaymentInbox,
  markCandidateRegistered,
  prunePaymentCandidateState,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import {
  buildPaymentEventRegistrations,
  parsePaymentEventRegisterReply,
  PAYMENT_EVENT_MATCH_TOLERANCE_MS,
  type PaymentEventRegistration,
} from '@/lib/paymentNotification/serverDedup';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUSE_1 = '11111111-1111-4111-8111-111111111111';
const HOUSE_2 = '22222222-2222-4222-8222-222222222222';

const kb = (title: string, text: string, postedAt = NOW, key = 'k'): CapturedNotification => ({
  notificationKey: key,
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});
const CARD_TITLE = '카드 결제 5,100원';
const CARD_TEXT = '체크카드(3308) | 청계상회 잔액 185,400원';
const CARD_TEXT_2 = '체크카드(3308) | 청계상회 잔액 180,300원';
const CANCEL_TITLE = '카드 결제 취소 5,100원';
const CANCEL_TEXT = '체크카드(3308) | 청계상회 잔액 190,500원';
const IN = kb('입금 398,400원', '홍*동 → 입출금통장(1111) 잔액 1,000,000원', NOW, 'i');
const OUT = kb('출금 398,400원', '개인사업자통장(2222) → 홍*동 잔액 2,000,000원', NOW, 'o');
const PROMO = kb('최대 5만원 결제 혜택 도착!', '결제 혜택은 이틀 동안 확인 가능해요. 알림 해지 : 로그인 > 혜택 > 알림 해지');
const UNSUPPORTED: CapturedNotification = { ...kb('알림', '내용'), packageName: 'com.example.bank' };

/** One phone: its captured list → the registrations it would send. */
const regsFor = (
  captured: CapturedNotification[],
  householdId = HOUSE_1,
  state: PaymentCandidateState = {},
  parse = parsePaymentNotification,
) =>
  buildPaymentEventRegistrations(
    buildPaymentInbox(captured, {}, toDateKey(new Date(NOW + 60 * MINUTE)), parse).items,
    householdId,
    state,
  );

interface ServerRow {
  id: string;
  householdId: string;
  dedupKey: string;
  eventType: string;
  occurredAt: number;
}

/** register_payment_notification_event, modelled (see header). */
function serverModel() {
  const rows: ServerRow[] = [];
  const locks = new Map<string, Promise<void>>();
  let fail = 0;
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  // The real key is sha256(preimage); equality is all that matters here.
  const register = async (householdId: string, reg: PaymentEventRegistration) => {
    if (fail > 0) {
      fail -= 1;
      throw new Error('network');
    }
    const lockKey = `${householdId}:${reg.preimage}`;
    const prev = locks.get(lockKey) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((r) => (release = r));
    locks.set(lockKey, prev.then(() => mine));
    await prev;
    try {
      await tick(); // a concurrent caller gets every chance to interleave
      const hit = rows
        .filter(
          (r) =>
            r.householdId === householdId &&
            r.dedupKey === reg.preimage &&
            Math.abs(r.occurredAt - reg.occurredAt) <= PAYMENT_EVENT_MATCH_TOLERANCE_MS,
        )
        .sort((a, b) => Math.abs(a.occurredAt - reg.occurredAt) - Math.abs(b.occurredAt - reg.occurredAt))[0];
      if (hit) return { eventId: hit.id, created: false };
      await tick();
      const row = {
        id: `ev${rows.length + 1}`,
        householdId,
        dedupKey: reg.preimage,
        eventType: reg.eventType,
        occurredAt: reg.occurredAt,
      };
      rows.push(row);
      return { eventId: row.id, created: true };
    } finally {
      release();
    }
  };
  const registerAll = (householdId: string, regs: PaymentEventRegistration[]) =>
    Promise.all(regs.map((r) => register(householdId, r)));
  return { rows, register, registerAll, failNext: (n: number) => (fail = n) };
}

export async function runServerDedupCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  // ── what is registered ────────────────────────────────────────
  check('REG 1 promotion → no registration (no server event)', regsFor([PROMO]).length === 0);
  check('REG 2 unsupported notification → no registration (no server event)', regsFor([UNSUPPORTED]).length === 0);
  {
    const r = regsFor([kb(CARD_TITLE, CARD_TEXT), kb(CANCEL_TITLE, CANCEL_TEXT, NOW + MINUTE, 'x'), IN, OUT]);
    const types = r.map((x) => x.eventType).sort().join(',');
    check('REG 3 event types: card_purchase / card_cancel / income / outflow', types === 'card_cancel,card_purchase,income,outflow', types);
  }
  {
    const [r] = regsFor([kb(CARD_TITLE, CARD_TEXT)]);
    check(
      'REG 4 payload = parse result only (amount, last4, type, time) + preimage',
      r.amount === 5100 && r.last4 === '3308' && r.occurredAt === NOW && r.sourcePackage === KAKAOBANK_PACKAGE,
      JSON.stringify({ ...r, preimage: undefined }),
    );
    check(
      'REG 5 base fingerprint = version + household + package + normalised title/body — nothing else',
      r.preimage === ['pn1', HOUSE_1, KAKAOBANK_PACKAGE, CARD_TITLE, CARD_TEXT].join('\u0000'),
    );
  }
  check(
    'REG 6 Android key / post time / whitespace do not change the base fingerprint',
    regsFor([kb(CARD_TITLE, CARD_TEXT, NOW, 'a')])[0].preimage ===
      regsFor([kb(` ${CARD_TITLE}`, CARD_TEXT.replace(' | ', '  |  '), NOW + 40 * SECOND, 'b')])[0].preimage,
  );
  check(
    'REG 7 already registered in THIS household → not sent again; another household → sent',
    (() => {
      const fp = regsFor([kb(CARD_TITLE, CARD_TEXT)])[0].fingerprint;
      const state = markCandidateRegistered({}, fp, HOUSE_1, NOW);
      return (
        regsFor([kb(CARD_TITLE, CARD_TEXT)], HOUSE_1, state).length === 0 &&
        regsFor([kb(CARD_TITLE, CARD_TEXT)], HOUSE_2, state).length === 1
      );
    })(),
  );
  check(
    'REG 8 registeredAt survives the stored-state round trip',
    (() => {
      const state = markCandidateRegistered({}, 'pc1_abc', HOUSE_1, NOW);
      const back = prunePaymentCandidateState(JSON.parse(JSON.stringify(state)), NOW + MINUTE);
      return back.pc1_abc?.registeredAt === NOW && back.pc1_abc.registeredHouseholdId === HOUSE_1;
    })(),
  );

  // ── multi-device scenarios (against the server model) ─────────
  {
    // A: different past histories. Phone A also has older identical-text
    // notifications (an earlier pay/cancel cycle) that phone B never saw.
    const s = serverModel();
    const newPay = (t: number, key: string) => kb(CARD_TITLE, CARD_TEXT, t, key);
    const historyA = [
      kb(CARD_TITLE, CARD_TEXT, NOW - 40 * MINUTE, 'h1'),
      kb(CANCEL_TITLE, CANCEL_TEXT, NOW - 30 * MINUTE, 'h2'),
    ];
    const regsA = regsFor([...historyA, newPay(NOW, 'a')]);
    const regsB = regsFor([newPay(NOW + 3 * SECOND, 'b')]);
    const newA = regsA.find((r) => r.occurredAt === NOW)!;
    await s.registerAll(HOUSE_1, regsA);
    const [rb] = await s.registerAll(HOUSE_1, regsB);
    const [ra] = await s.registerAll(HOUSE_1, [newA]);
    check(
      'A different device histories → the new payment is 1 server event (same key on both phones)',
      newA.preimage === regsB[0].preimage && rb.eventId === ra.eventId && !rb.created &&
        s.rows.filter((r) => Math.abs(r.occurredAt - NOW) <= PAYMENT_EVENT_MATCH_TOLERANCE_MS).length === 1 &&
        s.rows.length === 3,
      `${s.rows.length} rows`,
    );
  }
  {
    // B: same push, occurredAt a few seconds apart, both phones at once.
    const s = serverModel();
    const [ra, rb] = await Promise.all([
      s.register(HOUSE_1, regsFor([kb(CARD_TITLE, CARD_TEXT, NOW, 'a1')])[0]),
      s.register(HOUSE_1, regsFor([kb(CARD_TITLE, CARD_TEXT, NOW + 7 * SECOND, 'b9')])[0]),
    ]);
    check(
      'B two phones, occurredAt 7 s apart, concurrently → 1 server event',
      s.rows.length === 1 && ra.eventId === rb.eventId && ra.created !== rb.created,
      JSON.stringify([ra, rb]),
    );
    const s2 = serverModel();
    await s2.register(HOUSE_1, regsFor([kb(CARD_TITLE, CARD_TEXT, NOW, 'a')])[0]);
    const edge = await s2.register(HOUSE_1, regsFor([kb(CARD_TITLE, CARD_TEXT, NOW + PAYMENT_EVENT_MATCH_TOLERANCE_MS, 'b')])[0]);
    const past = await s2.register(
      HOUSE_1,
      regsFor([kb(CARD_TITLE, CARD_TEXT, NOW + 2 * PAYMENT_EVENT_MATCH_TOLERANCE_MS + SECOND, 'c')])[0],
    );
    check(
      'B2 tolerance edge: exactly 2 min apart → same event; beyond the tolerance → new event',
      !edge.created && past.created && s2.rows.length === 2,
    );
  }
  {
    // C: two real payments, same amount + shop, seconds apart (balance differs).
    const s = serverModel();
    const regs = regsFor([kb(CARD_TITLE, CARD_TEXT, NOW, 'a'), kb(CARD_TITLE, CARD_TEXT_2, NOW + 3 * SECOND, 'b')]);
    await s.registerAll(HOUSE_1, regs);
    // …and the second phone reports both too.
    await s.registerAll(
      HOUSE_1,
      regsFor([kb(CARD_TITLE, CARD_TEXT, NOW + 2 * SECOND, 'x'), kb(CARD_TITLE, CARD_TEXT_2, NOW + 5 * SECOND, 'y')]),
    );
    check('C same amount / shop, two real payments → 2 server events (from 2 phones)', regs.length === 2 && s.rows.length === 2);
  }
  {
    // D: pay → cancel → pay again (the 2nd payment's text is IDENTICAL).
    const s = serverModel();
    const phone = (offset: number, key: string) => [
      kb(CARD_TITLE, CARD_TEXT, NOW + offset, `${key}1`),
      kb(CANCEL_TITLE, CANCEL_TEXT, NOW + 2 * MINUTE + offset, `${key}2`),
      kb(CARD_TITLE, CARD_TEXT, NOW + 6 * MINUTE + offset, `${key}3`),
    ];
    // Phone B only got the last two (e.g. granted access in between).
    await Promise.all([s.registerAll(HOUSE_1, regsFor(phone(0, 'a'))), s.registerAll(HOUSE_1, regsFor(phone(4 * SECOND, 'b').slice(1)))]);
    const purchases = s.rows.filter((r) => r.eventType === 'card_purchase').length;
    const cancels = s.rows.filter((r) => r.eventType === 'card_cancel').length;
    check(
      'D pay → cancel → pay again (identical text) from 2 phones → 2 purchases + 1 cancel',
      s.rows.length === 3 && purchases === 2 && cancels === 1,
      `${purchases}/${cancels}`,
    );
    check(
      'D2 cancellation has its own type AND its own base fingerprint',
      (() => {
        const [p, c] = regsFor(phone(0, 'q').slice(0, 2)).sort((x, y) => x.occurredAt - y.occurredAt);
        return p.eventType === 'card_purchase' && c.eventType === 'card_cancel' && p.preimage !== c.preimage;
      })(),
    );
  }
  {
    // E: a parser update (version +1, even a different reading) keeps the key.
    const s = serverModel();
    const v4 = (n: CapturedNotification) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, parserVersion: c.parserVersion + 1, merchantCandidate: '청계상회(본점)' } : c;
    };
    const old = regsFor([kb(CARD_TITLE, CARD_TEXT)]);
    const updated = regsFor([kb(CARD_TITLE, CARD_TEXT, NOW + 5 * SECOND, 'b')], HOUSE_1, {}, v4);
    await s.register(HOUSE_1, old[0]);
    const res = await s.register(HOUSE_1, updated[0]);
    check(
      'E parserVersion bump on another phone → same key, existing event reused',
      old[0].preimage === updated[0].preimage && updated[0].parserVersion === old[0].parserVersion + 1 && !res.created && s.rows.length === 1,
    );
  }
  {
    // F: network failure, then retries (a lost reply after commit looks the
    // same to the client: the retry finds the row).
    const s = serverModel();
    const [reg] = regsFor([kb(CARD_TITLE, CARD_TEXT)]);
    s.failNext(1);
    let failedFirst = false;
    try {
      await s.register(HOUSE_1, reg);
    } catch {
      failedFirst = true;
    }
    const retry1 = await s.register(HOUSE_1, reg);
    const retry2 = await s.register(HOUSE_1, reg);
    check(
      'F network failure → retry → 1 event; a further retry reuses it',
      failedFirst && s.rows.length === 1 && retry1.created && !retry2.created && retry1.eventId === retry2.eventId,
    );
    const inbox = buildPaymentInbox([kb(CARD_TITLE, CARD_TEXT)], {}, toDateKey(new Date(NOW)));
    check('F2 a failed registration leaves the local candidate pending and listed', inbox.items[0]?.status === 'pending');
  }
  {
    // G: another household, same notification text.
    const s = serverModel();
    const r1 = regsFor([kb(CARD_TITLE, CARD_TEXT)], HOUSE_1);
    const r2 = regsFor([kb(CARD_TITLE, CARD_TEXT)], HOUSE_2);
    await Promise.all([s.register(HOUSE_1, r1[0]), s.register(HOUSE_2, r2[0])]);
    check('G other household, same payment → separate events, different keys', s.rows.length === 2 && r1[0].preimage !== r2[0].preimage);
  }
  {
    // Race: 5 phones × 3 retries of one event, all at once.
    const s = serverModel();
    const all: Promise<unknown>[] = [];
    for (let p = 0; p < 5; p++) {
      const [reg] = regsFor([kb(CARD_TITLE, CARD_TEXT, NOW + p * SECOND, `p${p}`)]);
      for (let t = 0; t < 3; t++) all.push(s.register(HOUSE_1, reg));
    }
    await Promise.all(all);
    check('RACE 15 concurrent registrations of one event → exactly 1 row', s.rows.length === 1);
  }

  // ── RPC reply ─────────────────────────────────────────────────
  {
    const ok = parsePaymentEventRegisterReply([{ event_id: 'e-1', created: false }]);
    const bad = [null, [], [{ event_id: '', created: true }], [{ event_id: 'e', created: 'yes' }], { id: 'e' }];
    check(
      'REPLY table row → ok; anything malformed → not registered (non-transport)',
      ok.ok &&
        ok.eventId === 'e-1' &&
        !ok.created &&
        bad.every((d) => {
          const r = parsePaymentEventRegisterReply(d);
          return !r.ok && !r.transport;
        }),
    );
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
