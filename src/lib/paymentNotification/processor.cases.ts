/**
 * Static verification for the shared payment notification pass
 * (processor.ts): start-up / foreground triggers, single flight, the
 * setting, the link-before-save order, and failure containment. Same
 * convention as the other *.cases.ts files: plain data + a runner, never
 * imported by the app.
 *
 * The IO is faked. A `server` (shared by every phone): a registration that
 * maps one base fingerprint to one server event, public.transactions with
 * its primary key + createTransaction's 23505 reconcile, and the two event
 * RPCs of migration 20261019002300 with their rules. A `phone` (one each):
 * its captured list, its stored 후보함 state (serialised read-modify-writes,
 * as paymentCandidateState.ts does) and its setting.
 */
import { toDateKey } from '@/lib/format';
import {
  paymentAutoSavedMessage,
  type PaymentAutoSaveIO,
  type PaymentEventCompleteStatus,
} from '@/lib/paymentNotification/autoSave';
import {
  buildPaymentInbox,
  markCandidateHandled,
  markCandidateManualSaved,
  markCandidateSent,
  paymentCandidateFingerprint,
  splitPaymentInbox,
  type PaymentCandidateState,
} from '@/lib/paymentNotification/candidateInbox';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import {
  createPaymentNotificationProcessor,
  type PaymentAutoSavedItem,
  type PaymentProcessingIO,
} from '@/lib/paymentNotification/processor';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';
import type { NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUSE = '11111111-1111-4111-8111-111111111111';
const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RANDOM_ID = 'txn-1800000000000-rand01';

const kb = (title: string, text: string, postedAt: number, key: string): CapturedNotification => ({
  notificationKey: key,
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});
const CARD = kb('카드 결제 5,100원', '체크카드(3308) | 청계상회 잔액 185,400원', NOW - MINUTE, 'a');
const CARD_ON_B = { ...CARD, postedAt: CARD.postedAt + 3 * SECOND, notificationKey: 'b' };
const CARD_2 = kb('카드 결제 12,000원', '체크카드(3308) | 김밥천국 잔액 173,400원', NOW - 30 * SECOND, 'a2');
const IN = kb('입금 398,400원', '홍*동 → 입출금통장(1111) 잔액 1,000,000원', NOW - MINUTE, 'i');
const MANUAL_DRAFT: NewTransactionDraft = {
  type: 'expense',
  category: 'food',
  amount: 5100,
  memo: '청계상회',
  date: new Date(NOW - MINUTE).toISOString(),
};

interface EventRow {
  id: string;
  status: 'pending' | 'handled';
  linked: string | null;
}
interface Server {
  events: Map<string, EventRow>;
  txns: Map<string, { createdBy: string; draft: NewTransactionDraft }>;
  registerFails: boolean;
  /** complete: n calls fail on the network BEFORE reaching the server. */
  completeTransportFails: number;
  /** complete: n calls are committed but their reply is lost. */
  completeRepliesLost: number;
}
interface Phone {
  userId: string;
  captured: CapturedNotification[];
  stored: PaymentCandidateState;
  since: number | null;
  passes: number;
  throwOn: 'captured' | 'register' | null;
}

const server = (over: Partial<Server> = {}): Server => ({
  events: new Map(),
  txns: new Map(),
  registerFails: false,
  completeTransportFails: 0,
  completeRepliesLost: 0,
  ...over,
});
const phone = (over: Partial<Phone> = {}): Phone => ({
  userId: USER_A,
  captured: [CARD],
  stored: {},
  since: NOW - 10 * MINUTE,
  passes: 0,
  throwOn: null,
  ...over,
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** One phone's processor (one app runtime) against the shared server. */
function processorFor(srv: Server, ph: Phone) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const eventById = (id: string) => [...srv.events.values()].find((x) => x.id === id);
  const autoSave: PaymentAutoSaveIO = {
    getLink: async (eventId) => {
      await tick();
      const e = eventById(eventId);
      return e ? { ok: true, status: e.status, transactionId: e.linked } : { ok: false, transport: false };
    },
    create: async (transactionId, draft) => {
      await tick();
      const existing = srv.txns.get(transactionId);
      if (existing) {
        // createTransaction's 23505 reconcile.
        const same = existing.createdBy === ph.userId && JSON.stringify(existing.draft) === JSON.stringify(draft);
        return same ? { ok: true, createdNow: false } : { ok: false, transport: false };
      }
      srv.txns.set(transactionId, { createdBy: ph.userId, draft });
      return { ok: true, createdNow: true };
    },
    // complete_payment_notification_event (migration 20261019002300).
    complete: async (eventId, transactionId, source) => {
      await tick();
      if (srv.completeTransportFails > 0) {
        srv.completeTransportFails -= 1;
        return { ok: false, transport: true };
      }
      const derived = `txn-pn-${eventId}`;
      if ((transactionId.startsWith('txn-pn-') && transactionId !== derived) || (source === 'auto' && transactionId !== derived)) {
        return { ok: false, transport: false };
      }
      const e = eventById(eventId);
      if (!e) return { ok: false, transport: false };
      let status: PaymentEventCompleteStatus;
      if (e.status === 'handled') status = e.linked === transactionId ? 'already_linked' : 'conflict';
      else {
        const t = srv.txns.get(transactionId);
        if (!t) status = 'transaction_missing';
        else if (t.draft.type !== 'expense' || (transactionId !== derived && t.createdBy !== ph.userId)) {
          status = 'transaction_mismatch';
        } else {
          e.status = 'handled';
          e.linked = transactionId;
          status = 'linked';
        }
      }
      if (srv.completeRepliesLost > 0) {
        srv.completeRepliesLost -= 1;
        return { ok: false, transport: true };
      }
      return { ok: true, status };
    },
  };
  const io: PaymentProcessingIO = {
    supported: () => true,
    getCaptured: async () => {
      ph.passes += 1;
      if (ph.throwOn === 'captured') throw new Error('native module gone');
      await tick();
      return ph.captured;
    },
    loadState: () => serial(async () => JSON.parse(JSON.stringify(ph.stored)) as PaymentCandidateState),
    updateState: (change) =>
      serial(async () => {
        await tick();
        ph.stored = change(JSON.parse(JSON.stringify(ph.stored)));
        return ph.stored;
      }),
    register: async (_householdId, regs) => {
      await tick();
      if (ph.throwOn === 'register') throw new Error('boom');
      if (srv.registerFails) return [];
      return regs.map((r) => {
        let e = srv.events.get(r.preimage);
        if (!e) {
          e = { id: `00000000-0000-4000-8000-${String(srv.events.size + 1).padStart(12, '0')}`, status: 'pending', linked: null };
          srv.events.set(r.preimage, e);
        }
        return { fingerprint: r.fingerprint, eventId: e.id };
      });
    },
    loadAutoSaveSince: async () => ph.since,
    autoSave: () => autoSave,
    now: () => NOW,
  };
  return createPaymentNotificationProcessor(io);
}

const ctxOf = (ph: Phone) => ({ householdId: HOUSE, userId: ph.userId });
/** The server event phone A's manual transaction belongs to (CARD's). */
const manualEvent = (srv: Server) => [...srv.events.values()].find((e) => e.linked === RANDOM_ID);

/**
 * Phone A saved CARD by hand in /input BEFORE it was registered: an ordinary
 * id, recorded on the candidate (as candidateAutoHandle.ts does). `onServer`
 * = the create reached the server (false = still in the offline queue).
 */
function manualBeforeRegistration(srv: Server, onServer: boolean): Phone {
  const fp = paymentCandidateFingerprint(CARD);
  let stored = markCandidateSent({}, fp, NOW - 50 * SECOND);
  stored = markCandidateHandled(stored, fp, NOW - 40 * SECOND);
  stored = markCandidateManualSaved(stored, fp, RANDOM_ID, HOUSE, NOW - 40 * SECOND);
  if (onServer) srv.txns.set(RANDOM_ID, { createdBy: USER_A, draft: MANUAL_DRAFT });
  return phone({ stored });
}

export async function runProcessorCases(): Promise<{ results: CaseResult[]; passed: number; failed: number }> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  // ── triggers / setting / single flight ────────────────────────
  {
    const srv = server();
    const ph = phone();
    const p = processorFor(srv, ph);
    const announced: PaymentAutoSavedItem[][] = [];
    p.onSaved((s) => announced.push(s));
    const res = await p.run(ctxOf(ph));
    check(
      'H 자동입력 ON + new eligible card payment + app foreground → 1 automatic transaction, announced once',
      srv.txns.size === 1 &&
        res.saved.length === 1 &&
        res.saved[0].merchant === '청계상회' &&
        res.saved[0].amount === 5100 &&
        announced.length === 1 &&
        res.changed,
      JSON.stringify(res),
    );
  }
  {
    const srv = server();
    const ph = phone();
    const p = processorFor(srv, ph);
    const announced: PaymentAutoSavedItem[][] = [];
    p.onSaved((s) => announced.push(s));
    await p.run(ctxOf(ph));
    await p.run(ctxOf(ph));
    await p.run(ctxOf(ph));
    check('I three foreground passes one after another → 1 transaction, announced once', srv.txns.size === 1 && announced.length === 1);
    const srv2 = server();
    const ph2 = phone();
    const p2 = processorFor(srv2, ph2);
    const results3 = await Promise.all([p2.run(ctxOf(ph2)), p2.run(ctxOf(ph2)), p2.run(ctxOf(ph2))]);
    check(
      'I2 three foreground events at once → joined: at most 2 passes, 1 transaction',
      srv2.txns.size === 1 && ph2.passes <= 2 && results3.every((r) => r === results3[0]),
      `${ph2.passes} passes`,
    );
  }
  {
    const srv = server();
    const ph = phone({ since: null });
    const res = await processorFor(srv, ph).run(ctxOf(ph));
    const entry = Object.values(ph.stored)[0];
    check(
      'J 자동입력 OFF + foreground → 0 transactions (registration still runs)',
      srv.txns.size === 0 && res.saved.length === 0 && !!entry?.registeredEventId,
    );
  }
  {
    const srv = server();
    const ph = phone({ since: CARD.postedAt + 1 });
    await processorFor(srv, ph).run(ctxOf(ph));
    check('K notification older than enabledSince → 0 transactions', srv.txns.size === 0);
    const srv2 = server();
    const ph2 = phone({ captured: [IN] });
    await processorFor(srv2, ph2).run(ctxOf(ph2));
    check('K2 입금 with 자동입력 ON → 0 transactions', srv2.txns.size === 0);
    const srv3 = server({ registerFails: true });
    const ph3 = phone();
    await processorFor(srv3, ph3).run(ctxOf(ph3));
    check('K3 server dedup registration fails → 0 transactions', srv3.txns.size === 0);
  }
  {
    const srv = server();
    const ph = phone();
    const shared = processorFor(srv, ph);
    await Promise.all([shared.run(ctxOf(ph)), shared.run(ctxOf(ph))]);
    check('L screen + app-wide trigger on the same processor at once → 1 transaction', srv.txns.size === 1);
    const srv2 = server();
    const ph2 = phone();
    await Promise.all([processorFor(srv2, ph2).run(ctxOf(ph2)), processorFor(srv2, ph2).run(ctxOf(ph2))]);
    check('L2 two independent processors at once → still 1 transaction (derived id)', srv2.txns.size === 1, `${srv2.txns.size}`);
  }
  {
    const srv = server();
    const ph = phone({ throwOn: 'captured' });
    const p = processorFor(srv, ph);
    let threw = false;
    const res = await p.run(ctxOf(ph)).catch(() => {
      threw = true;
      return null;
    });
    const srv2 = server();
    const ph2 = phone({ throwOn: 'register' });
    const res2 = await processorFor(srv2, ph2)
      .run(ctxOf(ph2))
      .catch(() => null);
    const srv3 = server();
    const ph3 = phone();
    const p3 = processorFor(srv3, ph3);
    p3.onSaved(() => {
      throw new Error('listener');
    });
    const res3 = await p3.run(ctxOf(ph3)).catch(() => null);
    check(
      'M an error inside the pass (native read / registration / a listener) → resolves, never throws',
      !threw && res != null && !res.changed && res2 != null && res3 != null && srv3.txns.size === 1 && srv2.txns.size === 0,
    );
    ph.throwOn = null;
    const after = await p.run(ctxOf(ph));
    check('M2 the next pass after a failed one works normally', after.saved.length === 1 && srv.txns.size === 1);
  }

  // ── a manual save made BEFORE registration (ordinary id) ──────
  {
    const srv = server();
    const a = manualBeforeRegistration(srv, true);
    await processorFor(srv, a).run(ctxOf(a));
    const ev = [...srv.events.values()][0];
    const b = phone({ userId: USER_B, captured: [CARD_ON_B] });
    const resB = await processorFor(srv, b).run(ctxOf(b));
    check(
      'P-A manual save before registration → A registers, links its transaction FIRST → B auto-save adds nothing → 1 transaction',
      ev?.status === 'handled' &&
        ev.linked === RANDOM_ID &&
        resB.saved.length === 0 &&
        srv.txns.size === 1 &&
        srv.txns.has(RANDOM_ID) &&
        a.stored[paymentCandidateFingerprint(CARD)].manualLinkedAt === NOW,
      JSON.stringify([ev, resB]),
    );
  }
  {
    const srv = server({ completeRepliesLost: 1 });
    const a = manualBeforeRegistration(srv, true);
    a.captured = [CARD, CARD_2]; // and a second, ordinary eligible payment
    const resA = await processorFor(srv, a).run(ctxOf(a));
    const b = phone({ userId: USER_B, captured: [CARD_ON_B] });
    const resB = await processorFor(srv, b).run(ctxOf(b));
    const fp = paymentCandidateFingerprint(CARD);
    const linkedLater = a.stored[fp].manualLinkedAt;
    const resA2 = await processorFor(srv, a).run(ctxOf(a));
    check(
      'P-B the link reply is lost → no automatic save in that pass at all; next pass: already_linked; B adds nothing → 1 transaction for it',
      resA.saved.length === 0 &&
        linkedLater == null &&
        resB.saved.length === 0 &&
        a.stored[fp].manualLinkedAt === NOW &&
        resA2.saved.length === 1 && // CARD_2, only now
        resA2.saved[0].merchant === '김밥천국' &&
        srv.txns.size === 2 && // A's manual one + CARD_2's automatic one
        !!manualEvent(srv) &&
        !srv.txns.has(`txn-pn-${manualEvent(srv)?.id}`),
      JSON.stringify([resA, resB, resA2, [...srv.txns.keys()]]),
    );
  }
  {
    const srv = server({ completeTransportFails: 1 });
    const a = manualBeforeRegistration(srv, true);
    a.captured = [CARD, CARD_2];
    const resA = await processorFor(srv, a).run(ctxOf(a));
    const txnsAfterFirst = srv.txns.size;
    const resA2 = await processorFor(srv, a).run(ctxOf(a));
    const ev = manualEvent(srv);
    check(
      'P-C the link fails on the network (not committed) → this phone saves nothing that pass; next pass links, then saves only the other payment',
      resA.saved.length === 0 &&
        txnsAfterFirst === 1 &&
        !!ev &&
        resA2.saved.length === 1 &&
        resA2.saved[0].merchant === '김밥천국' &&
        srv.txns.size === 2 &&
        !srv.txns.has(`txn-pn-${ev?.id}`),
      JSON.stringify([resA, resA2, [...srv.txns.keys()]]),
    );
  }
  {
    // Same moment: A's pass (register + link) against B's automatic save.
    const outcomes: string[] = [];
    for (const order of ['A-first', 'B-first'] as const) {
      const srv = server();
      const a = manualBeforeRegistration(srv, true);
      const b = phone({ userId: USER_B, captured: [CARD_ON_B] });
      const pa = processorFor(srv, a);
      const pb = processorFor(srv, b);
      await Promise.all(order === 'A-first' ? [pa.run(ctxOf(a)), pb.run(ctxOf(b))] : [pb.run(ctxOf(b)), pa.run(ctxOf(a))]);
      // The phone that lost the race flags it: A (its link found B's) or B (its link found A's).
      const conflict = [a, b].some((ph) => Object.values(ph.stored).some((e) => e.linkConflictAt != null));
      outcomes.push(`${order}:${srv.txns.size}${conflict ? ':flagged' : ''}`);
      check(
        `P-D LIMIT A's link vs B's auto-save at the same moment (${order}) → 1 transaction, or 2 with a candidate flagged — never silent`,
        srv.txns.size === 1 || (srv.txns.size === 2 && conflict),
        outcomes.join(' '),
      );
    }
  }
  {
    const srv = server();
    const a = manualBeforeRegistration(srv, false); // still in A's offline queue
    const resA = await processorFor(srv, a).run(ctxOf(a));
    const fp = paymentCandidateFingerprint(CARD);
    srv.txns.set(RANDOM_ID, { createdBy: USER_A, draft: MANUAL_DRAFT }); // the queue flushes
    await processorFor(srv, a).run(ctxOf(a));
    check(
      'P-E manual save in this phone\'s offline queue → this phone never auto-saves it; links once flushed → 1 transaction',
      resA.saved.length === 0 &&
        a.stored[fp].manualLinkedAt === NOW &&
        srv.txns.size === 1 &&
        [...srv.events.values()][0].linked === RANDOM_ID,
      JSON.stringify([resA, [...srv.txns.keys()]]),
    );
    const srv2 = server();
    const a2 = manualBeforeRegistration(srv2, false);
    const b2 = phone({ userId: USER_B, captured: [CARD_ON_B] });
    await processorFor(srv2, b2).run(ctxOf(b2)); // B online first: nothing on the server tells it about A's queue
    srv2.txns.set(RANDOM_ID, { createdBy: USER_A, draft: MANUAL_DRAFT });
    await processorFor(srv2, a2).run(ctxOf(a2));
    const flagged = a2.stored[paymentCandidateFingerprint(CARD)].linkConflictAt != null;
    check(
      'P-E2 LIMIT A\'s save only in its offline queue, B online auto-saves → 2 transactions; A\'s candidate flagged as a possible duplicate',
      srv2.txns.size === 2 && flagged,
      `${srv2.txns.size} txns, flagged=${flagged}`,
    );
  }
  {
    const srv = server();
    const ph = phone();
    const res = await processorFor(srv, ph).run(ctxOf(ph));
    check('P-F a candidate without any manual record → automatic save as before', res.saved.length === 1 && srv.txns.size === 1);
  }

  // ── /input: register one candidate right before its save ──────
  {
    const srv = server();
    const ph = phone({ captured: [CARD, CARD_2], since: null });
    const p = processorFor(srv, ph);
    const ok = await p.registerCandidate(ctxOf(ph), paymentCandidateFingerprint(CARD));
    const again = await p.registerCandidate(ctxOf(ph), paymentCandidateFingerprint(CARD));
    check(
      'REG-NOW /input registers exactly that candidate (idempotent), nothing else',
      ok &&
        again &&
        srv.events.size === 1 &&
        !!ph.stored[paymentCandidateFingerprint(CARD)]?.registeredEventId &&
        ph.stored[paymentCandidateFingerprint(CARD_2)] == null &&
        srv.txns.size === 0,
    );
    const srv2 = server({ registerFails: true });
    const ph2 = phone();
    const off = await processorFor(srv2, ph2).registerCandidate(ctxOf(ph2), paymentCandidateFingerprint(CARD));
    const ph3 = phone({ throwOn: 'captured' });
    const thrown = await processorFor(server(), ph3).registerCandidate(ctxOf(ph3), paymentCandidateFingerprint(CARD));
    check('REG-NOW2 offline / failing / throwing → false (the save keeps the ordinary id), never throws', !off && !thrown);
  }

  // ── STEP 6 UX: what the user is told / shown ──────────────────
  check(
    'UX-1 success line names the merchant and amount and says it was recorded automatically',
    paymentAutoSavedMessage([{ merchant: '쿠팡(쿠페이)', amount: 17060 }]) ===
      '쿠팡(쿠페이) 17,060원이 자동으로 기록됐어요' &&
      paymentAutoSavedMessage([
        { merchant: '쿠팡(쿠페이)', amount: 17060 },
        { merchant: '청계상회', amount: 5100 },
      ]) === '카드 결제 2건이 자동으로 기록됐어요',
  );
  {
    // T1 / T2: a new automatic save is announced once; re-runs add nothing.
    const srv = server();
    const ph = phone();
    const p = processorFor(srv, ph);
    const announced: PaymentAutoSavedItem[][] = [];
    p.onSaved((s) => announced.push(s));
    const first = await p.run(ctxOf(ph));
    await p.run(ctxOf(ph));
    await p.run(ctxOf(ph));
    await Promise.all([p.run(ctxOf(ph)), p.run(ctxOf(ph))]);
    check(
      'T1 new automatic save → createdNow → announced exactly once',
      first.saved.length === 1 && announced.length === 1 && announced[0].length === 1 && srv.txns.size === 1,
    );
    check('T2 the same processor re-run (incl. at once) → no further announcement, no new transaction', announced.length === 1 && srv.txns.size === 1);
  }
  {
    // T3 / T4: local 후보함 state lost AND the app restarted (a NEW processor:
    // its in-memory "announced" set is empty) — the transaction exists.
    const restart = async (linkLanded: boolean) => {
      const srv = server();
      const ph = phone();
      await processorFor(srv, ph).run(ctxOf(ph)); // the original save
      ph.stored = {}; // the device lost its candidate state
      if (!linkLanded) {
        for (const e of srv.events.values()) {
          e.status = 'pending';
          e.linked = null;
        }
      }
      const fresh = processorFor(srv, ph); // app killed and started again
      const announced: PaymentAutoSavedItem[][] = [];
      fresh.onSaved((s) => announced.push(s));
      const res = await fresh.run(ctxOf(ph));
      const items = splitPaymentInbox(buildPaymentInbox(ph.captured, ph.stored, toDateKey(new Date(NOW))).items);
      return { srv, res, announced, items };
    };
    const landed = await restart(true);
    check(
      'T3 state lost + app restart, the server event already linked → no new transaction, no announcement, candidate handled',
      landed.srv.txns.size === 1 &&
        landed.res.saved.length === 0 &&
        landed.announced.length === 0 &&
        landed.items.pending.length === 0,
      JSON.stringify(landed.res),
    );
    const notLanded = await restart(false);
    check(
      'T4 state lost + app restart, link not landed → the existing transaction is re-confirmed (23505 reconcile): no new one, 자동저장 restored, NO announcement',
      notLanded.srv.txns.size === 1 &&
        notLanded.res.saved.length === 0 &&
        notLanded.announced.length === 0 &&
        notLanded.items.autoSaved.length === 1 &&
        [...notLanded.srv.events.values()][0].status === 'handled',
      JSON.stringify({ res: notLanded.res, autoSaved: notLanded.items.autoSaved.length }),
    );
  }
  {
    const srv = server();
    const ph = phone();
    const p = processorFor(srv, ph);
    await p.run(ctxOf(ph));
    const fp = paymentCandidateFingerprint(CARD);
    ph.since = null; // the user turns it OFF
    ph.captured = [CARD, CARD_2]; // and a new card payment arrives
    const off = await p.run(ctxOf(ph));
    const items = splitPaymentInbox(buildPaymentInbox(ph.captured, ph.stored, toDateKey(new Date(NOW))).items);
    check(
      'UX-3 OFF after a save: the saved one stays saved (never undone), the new payment stays pending, nothing new saved',
      off.saved.length === 0 &&
        srv.txns.size === 1 &&
        ph.stored[fp].autoSavedAt != null &&
        items.autoSaved.length === 1 &&
        items.autoSaved[0].fingerprint === fp &&
        items.pending.length === 1 &&
        items.pending[0].candidate.merchantCandidate === '김밥천국',
      JSON.stringify(off),
    );
  }
  {
    // Captured BEFORE the toggle was turned on, then turned on.
    const srv = server();
    const ph = phone({ since: null });
    const p = processorFor(srv, ph);
    await p.run(ctxOf(ph));
    ph.since = NOW; // turned on now — after CARD arrived
    const on = await p.run(ctxOf(ph));
    const items = splitPaymentInbox(buildPaymentInbox(ph.captured, ph.stored, toDateKey(new Date(NOW))).items);
    check(
      'UX-4 a payment captured before the toggle went ON is never saved automatically (stays pending)',
      on.saved.length === 0 && srv.txns.size === 0 && items.pending.length === 1 && items.autoSaved.length === 0,
    );
  }
  {
    const srv = server();
    const ph = phone();
    const p = processorFor(srv, ph);
    for (let i = 0; i < 5; i++) await p.run(ctxOf(ph)); // re-entries / foregrounds / screen visits
    await Promise.all([p.run(ctxOf(ph)), processorFor(srv, ph).run(ctxOf(ph))]);
    const items = splitPaymentInbox(buildPaymentInbox(ph.captured, ph.stored, toDateKey(new Date(NOW))).items);
    check(
      'UX-5 the same notification through 7 passes (incl. two at once) → 1 transaction, shown once under 자동저장 내역',
      srv.txns.size === 1 &&
        items.autoSaved.length === 1 &&
        items.autoSaved[0].autoSaved &&
        items.autoSaved[0].autoSavedAt === NOW &&
        items.autoSaved[0].candidate.accountLast4 === '3308' &&
        items.autoSaved[0].candidate.merchantCandidate === '청계상회' &&
        items.handled.length === 0 &&
        items.pending.length === 0,
    );
  }
  {
    // A refused create with no transaction behind it → the automatic save gives up.
    const srv = server();
    const ph = phone();
    const p = processorFor(srv, ph);
    srv.txns.set('txn-pn-00000000-0000-4000-8000-000000000001', {
      createdBy: USER_B,
      draft: { ...MANUAL_DRAFT, type: 'income' }, // the derived id is taken by something that does not fit
    });
    await p.run(ctxOf(ph));
    const items = splitPaymentInbox(buildPaymentInbox(ph.captured, ph.stored, toDateKey(new Date(NOW))).items);
    check(
      'UX-6 automatic save failed → the candidate stays pending (자동저장 실패 · 직접 확인), nothing lost',
      items.pending.length === 1 &&
        items.pending[0].autoSaveFailed &&
        !items.pending[0].autoSaved &&
        !!items.pending[0].prefill &&
        items.autoSaved.length === 0,
      JSON.stringify(ph.stored),
    );
  }
  {
    const srv = server();
    const promo = kb('최대 5만원 결제 혜택 도착!', '결제 혜택은 이틀 동안 확인 가능해요. 알림 해지 : 로그인 > 혜택 > 알림 해지', NOW - MINUTE, 'p');
    const out = kb('출금 398,400원', '입출금통장(1111) → 홍*동 잔액 601,600원', NOW - MINUTE, 'o');
    const cancel = kb('카드 결제 취소 5,100원', '체크카드(3308) | 청계상회 잔액 190,500원', NOW - MINUTE, 'c');
    const ph = phone({ captured: [promo, IN, out, cancel] });
    const res = await processorFor(srv, ph).run(ctxOf(ph));
    const items = splitPaymentInbox(buildPaymentInbox(ph.captured, ph.stored, toDateKey(new Date(NOW))).items);
    check(
      'UX-7 광고 / 입금 / 출금 / 카드 취소 with 자동입력 ON → nothing saved; the three money moves stay pending',
      res.saved.length === 0 && srv.txns.size === 0 && items.pending.length === 3 && items.autoSaved.length === 0,
    );
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
