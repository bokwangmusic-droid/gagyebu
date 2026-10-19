/**
 * Static verification for the server dedup registration (serverDedup.ts) and
 * the RPC reply parsing. Same convention as the other *.cases.ts files: plain
 * data + a runner, never imported by the app.
 *
 * The server side is MODELLED here by `serverModel`, which follows the rule
 * of register_payment_notification_event (migration 20261019002200): per
 * (household, base fingerprint) one registration at a time (the advisory
 * lock); A. a claim this device already made → its event; B. else the
 * nearest event with the same key within ±PAYMENT_EVENT_MATCH_TOLERANCE_MS,
 * not claimed by this device, with no opposite card event in between, and
 * no second one within PAYMENT_EVENT_AMBIGUITY_MARGIN_MS of that distance;
 * C. else a new event. The SQL itself is not executed by this file.
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
  isPaymentInstallId,
  parsePaymentEventRegisterReply,
  PAYMENT_EVENT_AMBIGUITY_MARGIN_MS,
  PAYMENT_EVENT_MATCH_TOLERANCE_MS,
  paymentDeviceHashPreimage,
  paymentLocalClaimPreimage,
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
const PHONE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHONE_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';

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
const pay = (at: number, text = CARD_TEXT) => kb(CARD_TITLE, text, at, `p${at}`);
const cancel = (at: number) => kb(CANCEL_TITLE, CANCEL_TEXT, at, `c${at}`);

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

interface EventRow {
  id: string;
  householdId: string;
  dedupKey: string;
  sourcePackage: string;
  eventType: string;
  amount: number;
  last4: string | null;
  occurredAt: number;
}
interface ClaimRow {
  eventId: string;
  householdId: string;
  deviceHash: string;
  localClaimHash: string;
}

const OPPOSITE: Record<string, string | undefined> = { card_purchase: 'card_cancel', card_cancel: 'card_purchase' };

/** register_payment_notification_event, modelled (see header). */
function serverModel() {
  const events: EventRow[] = [];
  const claims: ClaimRow[] = [];
  const locks = new Map<string, Promise<void>>();
  let failBefore = 0;
  let failAfter = 0;
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  // The real hashes are sha256(preimage); equality is all that matters here.
  const register = async (householdId: string, installId: string, reg: PaymentEventRegistration) => {
    if (failBefore > 0) {
      failBefore -= 1;
      throw new Error('network');
    }
    const deviceHash = paymentDeviceHashPreimage(householdId, installId);
    const localClaimHash = paymentLocalClaimPreimage(householdId, installId, reg.fingerprint);
    const lockKey = `${householdId}:${reg.preimage}`;
    const prev = locks.get(lockKey) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((r) => (release = r));
    locks.set(lockKey, prev.then(() => mine));
    await prev;
    let out: { eventId: string; created: boolean };
    try {
      await tick(); // a concurrent caller gets every chance to interleave
      const own = claims.find(
        (c) => c.householdId === householdId && c.deviceHash === deviceHash && c.localClaimHash === localClaimHash,
      );
      if (own) {
        out = { eventId: own.eventId, created: false };
      } else {
        const opposite = OPPOSITE[reg.eventType];
        const near = events
          .filter(
            (e) =>
              e.householdId === householdId &&
              e.dedupKey === reg.preimage &&
              e.eventType === reg.eventType &&
              e.amount === reg.amount &&
              e.last4 === reg.last4 &&
              Math.abs(e.occurredAt - reg.occurredAt) <= PAYMENT_EVENT_MATCH_TOLERANCE_MS &&
              !claims.some((c) => c.eventId === e.id && c.deviceHash === deviceHash) &&
              !events.some(
                (x) =>
                  x.householdId === householdId &&
                  x.eventType === opposite &&
                  x.sourcePackage === reg.sourcePackage &&
                  x.amount === reg.amount &&
                  x.last4 === reg.last4 &&
                  x.occurredAt > Math.min(e.occurredAt, reg.occurredAt) &&
                  x.occurredAt < Math.max(e.occurredAt, reg.occurredAt),
              ),
          )
          .map((e) => ({ e, d: Math.abs(e.occurredAt - reg.occurredAt) }))
          .sort((a, b) => a.d - b.d);
        await tick();
        const [best, second] = near;
        let eventId: string;
        let created: boolean;
        if (best && (!second || second.d - best.d >= PAYMENT_EVENT_AMBIGUITY_MARGIN_MS)) {
          eventId = best.e.id;
          created = false;
        } else {
          eventId = `ev${events.length + 1}`;
          created = true;
          events.push({
            id: eventId,
            householdId,
            dedupKey: reg.preimage,
            sourcePackage: reg.sourcePackage,
            eventType: reg.eventType,
            amount: reg.amount,
            last4: reg.last4,
            occurredAt: reg.occurredAt,
          });
        }
        claims.push({ eventId, householdId, deviceHash, localClaimHash });
        out = { eventId, created };
      }
    } finally {
      release();
    }
    if (failAfter > 0) {
      failAfter -= 1;
      throw new Error('reply lost'); // committed, but the phone never hears
    }
    return out;
  };
  /** One phone sends its registrations one after another (registerPaymentEvents). */
  const phone = async (householdId: string, installId: string, regs: PaymentEventRegistration[]) => {
    const out = [];
    for (const r of regs) out.push(await register(householdId, installId, r));
    return out;
  };
  const count = (type: string) => events.filter((e) => e.eventType === type).length;
  return {
    events,
    claims,
    register,
    phone,
    count,
    failNext: (n: number) => (failBefore = n),
    loseNextReply: (n: number) => (failAfter = n),
  };
}

export async function runServerDedupCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  // ── what is registered / what is hashed ───────────────────────
  check('I 1 promotion → no registration (no server event)', regsFor([PROMO]).length === 0);
  check('I 2 unsupported notification → no registration (no server event)', regsFor([UNSUPPORTED]).length === 0);
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
      'REG 5 base fingerprint = exactly the whitelisted parsed fields',
      r.preimage ===
        ['pn1', HOUSE_1, KAKAOBANK_PACKAGE, 'card_purchase', 'card', '5100', '3308', '체크카드', '청계상회', ''].join('\u0000'),
      JSON.stringify(r.preimage),
    );
  }
  {
    // The example from the review: "체크카드(3346) | 쿠팡(쿠페이) 잔액 51,598원".
    const [r] = regsFor([kb('카드 결제 17,150원', '체크카드(3346) | 쿠팡(쿠페이) 잔액 51,598원')]);
    const parts = r.preimage.split('\u0000');
    check(
      'BAL 1 card example: card_purchase + 17150 + 3346 + 쿠팡(쿠페이) used; balance 51,598 absent',
      parts.includes('card_purchase') &&
        parts.includes('17150') &&
        parts.includes('3346') &&
        parts.includes('쿠팡(쿠페이)') &&
        !/51,?598|잔액/.test(r.preimage),
      JSON.stringify(parts),
    );
  }
  {
    const regs = regsFor([IN, OUT]);
    check(
      'BAL 2 입금 / 출금: counterparty + account used; no balance (1,000,000 / 2,000,000) and no 잔액',
      regs.length === 2 &&
        regs.every((r) => !/잔액|1,?000,?000|2,?000,?000/.test(r.preimage)) &&
        regs.every((r) => r.preimage.split('\u0000').includes('홍*동')),
      JSON.stringify(regs.map((r) => r.preimage.split('\u0000'))),
    );
  }
  check(
    'BAL 3 DEFINED: same transaction fields, only the balance differs → SAME fingerprint (the claim rule decides)',
    regsFor([kb(CARD_TITLE, CARD_TEXT)])[0].preimage === regsFor([kb(CARD_TITLE, CARD_TEXT_2)])[0].preimage,
  );
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

  // ── device / claim identity ───────────────────────────────────
  check(
    'ID 1 install id = random v4 UUID (lower case) only',
    isPaymentInstallId(PHONE_A) &&
      !isPaymentInstallId(PHONE_A.toUpperCase()) &&
      !isPaymentInstallId('11111111-1111-1111-1111-111111111111') &&
      !isPaymentInstallId('') &&
      !isPaymentInstallId(null),
  );
  {
    const [r1] = regsFor([pay(NOW)]);
    const [r1again] = regsFor([pay(NOW)]); // a later build of the same capture
    const [r2] = regsFor([pay(NOW + 30 * SECOND, CARD_TEXT_2)]);
    const claim = (h: string, id: string, r: PaymentEventRegistration) => paymentLocalClaimPreimage(h, id, r.fingerprint);
    check(
      'ID 2 local claim: same install + same candidate → same; other candidate / install / household → different',
      claim(HOUSE_1, PHONE_A, r1) === claim(HOUSE_1, PHONE_A, r1again) &&
        claim(HOUSE_1, PHONE_A, r1) !== claim(HOUSE_1, PHONE_A, r2) &&
        claim(HOUSE_1, PHONE_A, r1) !== claim(HOUSE_1, PHONE_B, r1) &&
        claim(HOUSE_1, PHONE_A, r1) !== claim(HOUSE_2, PHONE_A, r1),
    );
    check(
      'ID 3 device hash depends on the install + household only (no account, key or hardware id)',
      paymentDeviceHashPreimage(HOUSE_1, PHONE_A) === ['pnd1', HOUSE_1, PHONE_A].join('\u0000') &&
        paymentDeviceHashPreimage(HOUSE_1, PHONE_A) !== paymentDeviceHashPreimage(HOUSE_2, PHONE_A) &&
        paymentDeviceHashPreimage(HOUSE_1, PHONE_A) !== paymentDeviceHashPreimage(HOUSE_1, PHONE_B),
    );
  }

  // ── A. same device, same claim ────────────────────────────────
  {
    const s = serverModel();
    const [reg] = regsFor([pay(NOW)]);
    const first = await s.register(HOUSE_1, PHONE_A, reg);
    const again = await s.register(HOUSE_1, PHONE_A, reg);
    const burst = await Promise.all([1, 2, 3].map(() => s.register(HOUSE_1, PHONE_A, reg)));
    check(
      'A same device re-registers the same candidate (sequential + 3 concurrent) → 1 event, 1 claim',
      s.events.length === 1 &&
        s.claims.length === 1 &&
        first.created &&
        !again.created &&
        [again, ...burst].every((r) => r.eventId === first.eventId && !r.created),
    );
  }

  // ── B. same device, two real payments ─────────────────────────
  {
    const s = serverModel();
    const twice = [pay(NOW), pay(NOW + 30 * SECOND, CARD_TEXT_2)];
    const [r1, r2] = await s.phone(HOUSE_1, PHONE_A, regsFor(twice));
    check(
      'B same device, same card / amount / shop, 30 s apart → 2 events',
      s.events.length === 2 && r1.created && r2.created && r1.eventId !== r2.eventId,
    );
    const s5 = serverModel();
    await s5.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW), pay(NOW + 5 * SECOND, CARD_TEXT_2)]));
    check('B2 same device, the same payment twice 5 s apart → 2 events', s5.events.length === 2);
    const s2 = serverModel();
    await Promise.all([
      s2.phone(HOUSE_1, PHONE_A, regsFor(twice)),
      s2.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 2 * SECOND), pay(NOW + 32 * SECOND, CARD_TEXT_2)])),
    ]);
    check(
      'B3 both phones see both payments (30 s apart) → 2 events, 4 claims',
      s2.events.length === 2 && s2.claims.length === 4,
      `${s2.events.length} events`,
    );
  }

  // ── C. pay → cancel → pay again ───────────────────────────────
  {
    const seq = [pay(NOW), cancel(NOW + 20 * SECOND), pay(NOW + 40 * SECOND)];
    const local = buildPaymentInbox(seq, {}, toDateKey(new Date(NOW + MINUTE)));
    const s = serverModel();
    await s.phone(HOUSE_1, PHONE_A, regsFor(seq));
    check(
      'C same device: pay → cancel → pay again (same text again, 40 s) → 2 purchases + 1 cancel',
      local.items.length === 3 && s.count('card_purchase') === 2 && s.count('card_cancel') === 1,
      `${local.items.length} local, ${s.count('card_purchase')}/${s.count('card_cancel')}`,
    );
    const s2 = serverModel();
    await s2.phone(HOUSE_1, PHONE_A, regsFor(seq));
    await s2.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 3 * SECOND), cancel(NOW + 23 * SECOND), pay(NOW + 43 * SECOND)]));
    check(
      'C2 both phones see all three → still 2 purchases + 1 cancel',
      s2.count('card_purchase') === 2 && s2.count('card_cancel') === 1 && s2.claims.length === 6,
    );
    // Phone A saw the first payment and the cancel; phone B only the re-payment 20 s later.
    const s3 = serverModel();
    await s3.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW), cancel(NOW + 10 * SECOND)]));
    const [rb] = await s3.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 20 * SECOND)]));
    check(
      "C3 a cancel in between: another phone's re-payment never joins the first purchase",
      rb.created && s3.count('card_purchase') === 2,
    );
  }

  // ── D. two phones, one push ───────────────────────────────────
  {
    const s = serverModel();
    const [[ra], [rb]] = await Promise.all([
      s.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW)])),
      s.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 4 * SECOND)])),
    ]);
    check(
      'D phones A / B get the same push 4 s apart (concurrently) → 1 event, 2 claims',
      s.events.length === 1 && s.claims.length === 2 && ra.eventId === rb.eventId && ra.created !== rb.created,
      JSON.stringify([ra, rb]),
    );
    const s2 = serverModel();
    await s2.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 4 * SECOND)]));
    await s2.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW)]));
    check('D2 the later phone registers first → still 1 event', s2.events.length === 1);
    const s3 = serverModel();
    await s3.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW)]));
    const edge = await s3.register(HOUSE_1, PHONE_B, regsFor([pay(NOW + PAYMENT_EVENT_MATCH_TOLERANCE_MS)])[0]);
    check('D3 tolerance edge: exactly 30 s → joins', !edge.created && s3.events.length === 1);
  }
  {
    const s = serverModel();
    const phones = [
      PHONE_A,
      PHONE_B,
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-a555-555555555555',
    ];
    const all: Promise<unknown>[] = [];
    phones.forEach((id, p) => {
      const [reg] = regsFor([pay(NOW + p * SECOND)]);
      for (let t = 0; t < 3; t++) all.push(s.register(HOUSE_1, id, reg));
    });
    await Promise.all(all);
    check('RACE 5 phones × 3 concurrent retries of one push → 1 event, 5 claims', s.events.length === 1 && s.claims.length === 5);
  }

  // ── E. different device histories ─────────────────────────────
  {
    const s = serverModel();
    await s.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW - 40 * MINUTE, CARD_TEXT_2), pay(NOW - 45 * SECOND, CARD_TEXT_2), pay(NOW)]));
    const [rb] = await s.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 3 * SECOND)]));
    const target = s.events.find((e) => e.occurredAt === NOW);
    check(
      "E phone A also saw older same payments (40 min / 45 s before) → B's report joins the new one only",
      s.events.length === 3 && !rb.created && rb.eventId === target?.id,
    );
    const s2 = serverModel();
    await s2.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW - 45 * SECOND, CARD_TEXT_2)]));
    await s2.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 3 * SECOND)]));
    await s2.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW - 45 * SECOND, CARD_TEXT_2), pay(NOW)]));
    check('E2 B registers before A has sent the new one → still 2 events', s2.events.length === 2);
  }

  // ── F. retry / lost reply ─────────────────────────────────────
  {
    const s = serverModel();
    const [reg] = regsFor([pay(NOW)]);
    s.failNext(1);
    const failed = await s.register(HOUSE_1, PHONE_A, reg).then(
      () => false,
      () => true,
    );
    const retry1 = await s.register(HOUSE_1, PHONE_A, reg);
    check('F network failure → retry → 1 event', failed && retry1.created && s.events.length === 1);
    s.loseNextReply(1);
    const [reg2] = regsFor([pay(NOW + 5 * MINUTE)]);
    const lost = await s.register(HOUSE_1, PHONE_A, reg2).then(
      () => false,
      () => true,
    );
    const retry2 = await s.register(HOUSE_1, PHONE_A, reg2);
    check(
      'F2 committed but the reply is lost → retry gets the SAME event (created = false)',
      lost && !retry2.created && s.events.length === 2 && s.claims.length === 2,
    );
    const inbox = buildPaymentInbox([kb(CARD_TITLE, CARD_TEXT)], {}, toDateKey(new Date(NOW)));
    check('F3 a failed registration leaves the local candidate pending and listed', inbox.items[0]?.status === 'pending');
  }

  // ── G. parser version ─────────────────────────────────────────
  {
    const bump = (n: CapturedNotification) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, parserVersion: c.parserVersion + 1 } : c;
    };
    const reread = (n: CapturedNotification) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, merchantCandidate: '청계상회(본점)' } : c;
    };
    const s = serverModel();
    const old = regsFor([pay(NOW)]);
    const first = await s.register(HOUSE_1, PHONE_A, old[0]);
    const sameBump = await s.register(HOUSE_1, PHONE_A, regsFor([pay(NOW)], HOUSE_1, {}, bump)[0]);
    const otherBump = await s.register(HOUSE_1, PHONE_B, regsFor([pay(NOW + 5 * SECOND)], HOUSE_1, {}, bump)[0]);
    check(
      'G parserVersion bump: same phone → same claim, same event; other phone → joins it',
      regsFor([pay(NOW)], HOUSE_1, {}, bump)[0].preimage === old[0].preimage &&
        sameBump.eventId === first.eventId &&
        otherBump.eventId === first.eventId &&
        s.events.length === 1,
    );
    const rereadReg = regsFor([pay(NOW)], HOUSE_1, {}, reread)[0];
    const again = await s.register(HOUSE_1, PHONE_A, rereadReg);
    check(
      "G2 a parser that READS a field differently: new key, but the same phone's same candidate keeps its event",
      rereadReg.preimage !== old[0].preimage && again.eventId === first.eventId && !again.created && s.events.length === 1,
    );
  }

  // ── H. household ──────────────────────────────────────────────
  {
    const s = serverModel();
    const r1 = regsFor([pay(NOW)], HOUSE_1);
    const r2 = regsFor([pay(NOW)], HOUSE_2);
    await Promise.all([s.register(HOUSE_1, PHONE_A, r1[0]), s.register(HOUSE_2, PHONE_B, r2[0])]);
    check('H other household, same payment → separate events, different keys', s.events.length === 2 && r1[0].preimage !== r2[0].preimage);
  }

  // ── J. ambiguous → new event ──────────────────────────────────
  {
    const s = serverModel();
    await s.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW)]));
    const [late] = await s.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 45 * SECOND)]));
    check('J 1 another phone 45 s later (inside the old 2 min) → new event', late.created && s.events.length === 2);
    const s2 = serverModel();
    await s2.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW), pay(NOW + 6 * SECOND, CARD_TEXT_2)]));
    const [mid] = await s2.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 3 * SECOND)]));
    check(
      `J 2 two same-key events at nearly the same distance (< ${PAYMENT_EVENT_AMBIGUITY_MARGIN_MS / SECOND} s apart) → new event`,
      mid.created && s2.events.length === 3,
    );
    const s3 = serverModel();
    await s3.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW), pay(NOW + 5 * SECOND, CARD_TEXT_2)]));
    await s3.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 2 * SECOND), pay(NOW + 7 * SECOND, CARD_TEXT_2)]));
    check(
      'J 3 two payments 5 s apart seen by both phones → never fewer than 2 events (duplicates allowed)',
      s3.events.length >= 2,
      `${s3.events.length} events`,
    );
  }
  {
    // 입금 vs 출금 of the same amount with the same counterparty.
    const s = serverModel();
    const inT = kb('입금 10,000원', '홍*동 → 입출금통장(1111) 잔액 110,000원', NOW, 'i');
    const outT = kb('출금 10,000원', '입출금통장(1111) → 홍*동 잔액 100,000원', NOW + 5 * SECOND, 'o');
    const regs = regsFor([inT, outT]);
    await s.phone(HOUSE_1, PHONE_A, regs);
    check(
      'IO income and outflow (same amount / account / counterparty) → 2 separate events',
      regs.length === 2 && regs[0].preimage !== regs[1].preimage && s.events.length === 2,
    );
  }
  {
    // KNOWN LIMIT (documented): each phone saw only ONE of two real payments.
    const s = serverModel();
    await s.phone(HOUSE_1, PHONE_A, regsFor([pay(NOW)]));
    await s.phone(HOUSE_1, PHONE_B, regsFor([pay(NOW + 20 * SECOND, CARD_TEXT_2)]));
    check('LIMIT phone A saw only payment 1, phone B only payment 2 (20 s later) → 1 event', s.events.length === 1);
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
