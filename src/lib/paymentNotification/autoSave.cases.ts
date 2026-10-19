/**
 * Static verification for "확실한 카드 결제 자동입력" (autoSave.ts). Same
 * convention as the other *.cases.ts files: plain data + a runner, never
 * imported by the app.
 *
 * The server is MODELLED by `fakeServer`: public.transactions with its
 * primary key and createTransaction's 23505 reconcile (same household, same
 * created_by, same fields → success; anything else → a non-transport
 * failure), and the two RPCs of migration 20261019002300 with their rules
 * (complete: handled → already_linked / conflict; no transaction →
 * transaction_missing; not an expense of the event's amount →
 * transaction_mismatch; else link). The SQL itself is not executed here.
 */
import { toDateKey } from '@/lib/format';
import { inputPrefillToParams, parseInputRouteSeed } from '@/lib/inputPrefill';
import { settleSourceCandidate } from '@/lib/paymentNotification/candidateAutoHandle';
import {
  applyPaymentAutoSaveOutcomes,
  buildPaymentAutoSaveDraft,
  linkPaymentCandidate,
  paymentCandidateTransactionId,
  PAYMENT_AUTO_SAVE_CATEGORY,
  paymentAutoSaveBlocker,
  paymentAutoSaveTransactionId,
  PAYMENT_MANUAL_LINK_MAX_AGE_MS,
  runPaymentAutoSaveJobs,
  selectPaymentAutoSaveJobs,
  selectPaymentLinkJobs,
  type PaymentAutoSaveIO,
  type PaymentEventCompleteStatus,
} from '@/lib/paymentNotification/autoSave';
import {
  buildPaymentInbox,
  markCandidateHandled,
  markCandidateManualSaved,
  markCandidateRegistered,
  markCandidateSent,
  prunePaymentCandidateState,
  toInputPrefill,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import { parsePaymentNotification } from '@/lib/paymentNotification/registry';
import { buildPaymentEventRegistrations } from '@/lib/paymentNotification/serverDedup';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';
import { buildTransactionInsert, type NewTransactionDraft } from '@/lib/remoteFinanceWriteMapping';

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
const EVENT_1 = 'e1e1e1e1-1111-4111-8111-111111111111';
const ON_SINCE = NOW - 10 * MINUTE;

const kb = (title: string, text: string, postedAt = NOW - MINUTE, key = 'k'): CapturedNotification => ({
  notificationKey: key,
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});
const CARD = kb('카드 결제 5,100원', '체크카드(3308) | 청계상회 잔액 185,400원');
const CANCEL = kb('카드 결제 취소 5,100원', '체크카드(3308) | 청계상회 잔액 190,500원', NOW - 30 * SECOND, 'c');
const IN = kb('입금 398,400원', '홍*동 → 입출금통장(1111) 잔액 1,000,000원', NOW - MINUTE, 'i');
const OUT = kb('출금 398,400원', '입출금통장(1111) → 홍*동 잔액 601,600원', NOW - 2 * MINUTE, 'o');
const PROMO = kb('최대 5만원 결제 혜택 도착!', '결제 혜택은 이틀 동안 확인 가능해요. 알림 해지 : 로그인 > 혜택 > 알림 해지');
const UNSUPPORTED: CapturedNotification = { ...kb('알림', '내용'), packageName: 'com.example.bank' };

const inboxOf = (captured: CapturedNotification[], state: PaymentCandidateState = {}, parse = parsePaymentNotification) =>
  buildPaymentInbox(captured, state, toDateKey(new Date(NOW)), parse).items;

/** Registered (STEP 5) as `eventId` — what the screen stores after register. */
const registered = (items: PaymentInboxItem[], ids: string[] = [EVENT_1]): PaymentCandidateState =>
  items.reduce<PaymentCandidateState>(
    (acc, item, i) => (ids[i] ? markCandidateRegistered(acc, item.fingerprint, HOUSE, NOW, ids[i]) : acc),
    {},
  );

interface TxnRow {
  id: string;
  householdId: string;
  createdBy: string;
  draft: NewTransactionDraft;
  deleted: boolean;
}
interface EventRow {
  id: string;
  householdId: string;
  eventType: string;
  amount: number;
  status: 'pending' | 'handled';
  linked: string | null;
}

function fakeServer(events: EventRow[]) {
  const txns = new Map<string, TxnRow>();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  let createCalls = 0;
  let failCreate: 'transport' | 'refused' | null = null;
  let loseCompleteReply = 0;
  let failLink = 0;
  const completeCalls: string[] = [];
  let beforeComplete: ((e: EventRow) => void) | null = null;
  const io = (userId: string): PaymentAutoSaveIO => ({
    getLink: async (eventId) => {
      await tick();
      if (failLink > 0) {
        failLink -= 1;
        return { ok: false, transport: true };
      }
      const e = events.find((x) => x.id === eventId && x.householdId === HOUSE);
      if (!e) return { ok: false, transport: false };
      return { ok: true, status: e.status, transactionId: e.linked };
    },
    create: async (transactionId, draft) => {
      createCalls += 1;
      await tick();
      if (failCreate) {
        const kind = failCreate;
        failCreate = null;
        return { ok: false, transport: kind === 'transport' };
      }
      await tick(); // a concurrent caller gets every chance to interleave…
      // …but the primary key check + insert is atomic, as in Postgres.
      const existing = txns.get(transactionId);
      if (existing) {
        // createTransaction's 23505 reconcile.
        const same =
          existing.householdId === HOUSE &&
          existing.createdBy === userId &&
          JSON.stringify(existing.draft) === JSON.stringify(draft);
        return same ? { ok: true } : { ok: false, transport: false };
      }
      txns.set(transactionId, { id: transactionId, householdId: HOUSE, createdBy: userId, draft, deleted: false });
      return { ok: true };
    },
    // complete_payment_notification_event (migration 20261019002300).
    complete: async (eventId, transactionId, source) => {
      await tick();
      completeCalls.push(source);
      const derived = `txn-pn-${eventId}`;
      const invalid =
        (transactionId.startsWith('txn-pn-') && transactionId !== derived) ||
        (source === 'auto' && transactionId !== derived);
      if (invalid) return { ok: false, transport: false }; // INVALID_ARGUMENT
      const e = events.find((x) => x.id === eventId && x.householdId === HOUSE);
      if (!e) return { ok: false, transport: false }; // NOT_FOUND
      beforeComplete?.(e);
      const expected =
        e.eventType === 'card_purchase'
          ? 'expense'
          : source === 'manual' && e.eventType === 'outflow'
            ? 'expense'
            : source === 'manual' && e.eventType === 'income'
              ? 'income'
              : null;
      if (!expected) return { ok: false, transport: false }; // NOT_ELIGIBLE
      let status: PaymentEventCompleteStatus;
      if (e.status === 'handled') status = e.linked === transactionId ? 'already_linked' : 'conflict';
      else {
        const t = txns.get(transactionId);
        if (!t || t.householdId !== HOUSE) status = 'transaction_missing';
        else if (t.draft.type !== expected || (transactionId !== derived && t.createdBy !== userId)) {
          status = 'transaction_mismatch';
        } else if (events.some((x) => x.linked === transactionId && x.id !== e.id)) status = 'transaction_in_use';
        else {
          e.status = 'handled';
          e.linked = transactionId;
          status = 'linked';
        }
      }
      if (loseCompleteReply > 0) {
        loseCompleteReply -= 1;
        return { ok: false, transport: true }; // committed, the reply never arrives
      }
      return { ok: true, status };
    },
  });
  /** /input's ordinary create (its own txn-<ms>-<rand> id). */
  const manualSave = (userId: string, transactionId: string, draft: NewTransactionDraft, householdId = HOUSE) => {
    txns.set(transactionId, { id: transactionId, householdId, createdBy: userId, draft, deleted: false });
  };
  return {
    txns,
    events,
    io,
    manualSave,
    completeCalls,
    onBeforeComplete: (f: (e: EventRow) => void) => (beforeComplete = f),
    createCalls: () => createCalls,
    failNextCreate: (k: 'transport' | 'refused') => (failCreate = k),
    loseNextCompleteReply: (n: number) => (loseCompleteReply = n),
    failNextLink: (n: number) => (failLink = n),
  };
}

const event = (id = EVENT_1, over: Partial<EventRow> = {}): EventRow => ({
  id,
  householdId: HOUSE,
  eventType: 'card_purchase',
  amount: 5100,
  status: 'pending',
  linked: null,
  ...over,
});

/** One phone's visit: select → run → apply. */
async function visit(
  server: ReturnType<typeof fakeServer>,
  userId: string,
  captured: CapturedNotification[],
  state: PaymentCandidateState,
  since: number | null = ON_SINCE,
  now = NOW,
) {
  const items = inboxOf(captured, state);
  const links = selectPaymentLinkJobs(state, HOUSE);
  const jobs = selectPaymentAutoSaveJobs(items, state, HOUSE, since, NOW);
  const outcomes = await runPaymentAutoSaveJobs(links, jobs, server.io(userId), now);
  return { links, jobs, outcomes, state: applyPaymentAutoSaveOutcomes(state, outcomes, now) };
}

export async function runAutoSaveCases(): Promise<{ results: CaseResult[]; passed: number; failed: number }> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  const [card] = inboxOf([CARD]);

  // ── eligibility ───────────────────────────────────────────────
  check(
    'ELIG 1 KakaoBank card payment, high confidence, merchant + last 4 → eligible',
    card.kind === 'card_payment' && card.candidate.confidence === 'high' && paymentAutoSaveBlocker(card, NOW) === null,
    JSON.stringify({ kind: card.kind, conf: card.candidate.confidence }),
  );
  check(
    'F confidence medium / low → not eligible, 0 jobs',
    (['medium', 'low'] as const).every((confidence) => {
      const [item] = inboxOf([CARD], {}, (n) => {
        const c = parsePaymentNotification(n);
        return c ? { ...c, confidence } : c;
      });
      return (
        paymentAutoSaveBlocker(item, NOW) === 'confidence' &&
        selectPaymentAutoSaveJobs([item], registered([item]), HOUSE, ON_SINCE, NOW).length === 0
      );
    }),
  );
  {
    const [noMerchant] = inboxOf([CARD], {}, (n) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, merchantCandidate: null } : c;
    });
    const [blankMerchant] = inboxOf([CARD], {}, (n) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, merchantCandidate: '  ' } : c;
    });
    const [noLast4] = inboxOf([CARD], {}, (n) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, accountLast4: null } : c;
    });
    const [otherPkg] = inboxOf([CARD], {}, (n) => {
      const c = parsePaymentNotification(n);
      return c ? { ...c, sourcePackage: 'com.example.card' } : c;
    });
    // relationKey is set by withPaymentRelations inside the inbox build.
    const related: PaymentInboxItem = { ...card, candidate: { ...card.candidate, relationKey: 'r1' } };
    const transfer: PaymentInboxItem = { ...card, transferWarning: true };
    check(
      'G merchant missing / blank → not eligible, 0 jobs',
      paymentAutoSaveBlocker(noMerchant, NOW) === 'merchant' &&
        paymentAutoSaveBlocker(blankMerchant, NOW) === 'merchant' &&
        selectPaymentAutoSaveJobs([noMerchant], registered([noMerchant]), HOUSE, ON_SINCE, NOW).length === 0,
    );
    check(
      'ELIG 2 no last 4 / another package / a relation → not eligible',
      paymentAutoSaveBlocker(noLast4, NOW) === 'last4' &&
        paymentAutoSaveBlocker(otherPkg, NOW) === 'package' &&
        paymentAutoSaveBlocker(related, NOW) === 'relation' &&
        paymentAutoSaveBlocker(transfer, NOW) === 'relation',
      JSON.stringify([noLast4, otherPkg, related].map((i) => paymentAutoSaveBlocker(i, NOW))),
    );
    check(
      'ELIG 3 a post time in the future → not eligible',
      paymentAutoSaveBlocker(inboxOf([{ ...CARD, postedAt: NOW + MINUTE }])[0], NOW) === 'future',
    );
  }
  {
    const items = inboxOf([CANCEL]);
    check(
      'H card_cancel → not eligible, 0 jobs',
      items.length === 1 &&
        items[0].kind === 'card_cancellation' &&
        paymentAutoSaveBlocker(items[0], NOW) === 'not_card_payment' &&
        selectPaymentAutoSaveJobs(items, registered(items), HOUSE, ON_SINCE, NOW).length === 0,
    );
  }
  {
    const items = inboxOf([IN, OUT]);
    check(
      'I 입금 / 출금 → not eligible, 0 jobs',
      items.length === 2 &&
        items.every((i) => paymentAutoSaveBlocker(i, NOW) === 'not_card_payment') &&
        selectPaymentAutoSaveJobs(items, registered(items, [EVENT_1, 'e2e2e2e2-2222-4222-8222-222222222222']), HOUSE, ON_SINCE, NOW)
          .length === 0,
    );
  }
  {
    const items = inboxOf([PROMO, UNSUPPORTED]);
    check(
      'J promotion / unsupported → not in the inbox, never registered, 0 jobs',
      items.length === 0 && buildPaymentEventRegistrations(items, HOUSE, {}).length === 0,
    );
  }

  // ── setting / state gates ─────────────────────────────────────
  {
    const state = registered([card]);
    check('E setting OFF → 0 jobs, candidate stays pending', selectPaymentAutoSaveJobs([card], state, HOUSE, null, NOW).length === 0 && card.status === 'pending');
    check(
      'E2 turned on AFTER the notification arrived → not saved (no back-fill)',
      selectPaymentAutoSaveJobs([card], state, HOUSE, card.candidate.occurredAt + 1, NOW).length === 0 &&
        selectPaymentAutoSaveJobs([card], state, HOUSE, card.candidate.occurredAt, NOW).length === 1,
    );
    check(
      'D server dedup registration missing (failed / other household / no event id) → 0 jobs',
      selectPaymentAutoSaveJobs([card], {}, HOUSE, ON_SINCE, NOW).length === 0 &&
        selectPaymentAutoSaveJobs([card], state, '22222222-2222-4222-8222-222222222222', ON_SINCE, NOW).length === 0 &&
        selectPaymentAutoSaveJobs([card], markCandidateRegistered({}, card.fingerprint, HOUSE, NOW), HOUSE, ON_SINCE, NOW).length === 0,
    );
    check(
      'L the user opened it in /input, or saved / handled it → never auto-saved',
      selectPaymentAutoSaveJobs([card], markCandidateSent(state, card.fingerprint, NOW), HOUSE, ON_SINCE, NOW).length === 0 &&
        selectPaymentAutoSaveJobs(
          inboxOf([CARD], markCandidateHandled(state, card.fingerprint, NOW)),
          markCandidateHandled(state, card.fingerprint, NOW),
          HOUSE,
          ON_SINCE,
          NOW,
        ).length === 0,
    );
    check(
      'REG registration without an event id (pre-STEP 6) is sent again; with one, not',
      buildPaymentEventRegistrations([card], HOUSE, markCandidateRegistered({}, card.fingerprint, HOUSE, NOW)).length === 1 &&
        buildPaymentEventRegistrations([card], HOUSE, state).length === 0,
    );
  }

  // ── the transaction ───────────────────────────────────────────
  {
    const draft = buildPaymentAutoSaveDraft(card);
    const row = buildTransactionInsert(draft, {
      id: paymentAutoSaveTransactionId(EVENT_1)!,
      householdId: HOUSE,
      knownCardIds: new Set(),
    });
    check(
      'TXN 1 draft = 지출 · 기타 · merchant · the notification time; no method, no card, no split',
      row.type === 'expense' &&
        row.category === PAYMENT_AUTO_SAVE_CATEGORY &&
        row.category === 'other' &&
        row.amount === 5100 &&
        row.memo === '청계상회' &&
        row.date === new Date(card.candidate.occurredAt).toISOString() &&
        row.payment_method === null &&
        row.card_id === null &&
        row.source_asset_id === null &&
        row.splits === null &&
        row.installment_months === null,
      JSON.stringify(row),
    );
    check(
      'TXN 2 transaction id derived from the event id only; invalid id → none',
      paymentAutoSaveTransactionId(EVENT_1) === `txn-pn-${EVENT_1}` &&
        paymentAutoSaveTransactionId('not-an-id') === null &&
        paymentAutoSaveTransactionId(EVENT_1.toUpperCase()) === null,
    );
    check(
      'K manual input prefill for the same candidate is unchanged',
      JSON.stringify(toInputPrefill(card.candidate, toDateKey(new Date(NOW)))) ===
        JSON.stringify({ type: 'expense', amount: 5100, memo: '청계상회', dateKey: toDateKey(new Date(card.candidate.occurredAt)) }),
    );
  }

  // ── duplicates ────────────────────────────────────────────────
  {
    const server = fakeServer([event()]);
    const v1 = await visit(server, USER_A, [CARD], registered([card]));
    const v2 = await visit(server, USER_A, [CARD], v1.state);
    const lost = await visit(server, USER_A, [CARD], registered([card])); // local state lost
    check(
      'A same event retried (next visit, and with the local state lost) → 1 transaction',
      v1.outcomes[0]?.kind === 'saved' &&
        v2.jobs.length === 0 &&
        lost.outcomes[0]?.kind === 'already' &&
        server.txns.size === 1 &&
        server.events[0].linked === `txn-pn-${EVENT_1}`,
      JSON.stringify([v1.outcomes, lost.outcomes]),
    );
    const item = inboxOf([CARD], v1.state)[0];
    check('A2 saved → handled + 자동 입력됨, gone from pending', item.status === 'handled' && item.autoSaved);
  }
  {
    const server = fakeServer([event()]);
    server.loseNextCompleteReply(1);
    const v1 = await visit(server, USER_A, [CARD], registered([card]));
    const stored = prunePaymentCandidateState(JSON.parse(JSON.stringify(v1.state)), NOW);
    const v2 = await visit(server, USER_A, [CARD], stored);
    check(
      'B saved, link reply lost → handled locally, only the link retried → 1 transaction',
      v1.outcomes[0]?.kind === 'saved' &&
        v1.outcomes[0].kind === 'saved' &&
        !v1.outcomes[0].linked &&
        inboxOf([CARD], v1.state)[0].status === 'handled' &&
        v2.jobs.length === 0 &&
        v2.links.length === 1 &&
        v2.links[0].transactionId === `txn-pn-${EVENT_1}` &&
        v2.links[0].source === 'auto' &&
        v2.outcomes[0]?.kind === 'link' &&
        server.txns.size === 1 &&
        server.createCalls() === 1 &&
        v2.state[card.fingerprint].autoSaveLinkedAt === NOW,
      JSON.stringify([v1.outcomes, v2.outcomes]),
    );
    const server2 = fakeServer([event()]);
    server2.loseNextCompleteReply(1);
    await visit(server2, USER_A, [CARD], registered([card]));
    const again = await visit(server2, USER_A, [CARD], registered([card])); // local state lost too
    check(
      'B2 saved, link reply lost AND local state lost → retry still 1 transaction',
      server2.txns.size === 1 && again.outcomes[0]?.kind === 'already',
      JSON.stringify(again.outcomes),
    );
    const server3 = fakeServer([event()]);
    server3.loseNextCompleteReply(1);
    const s3 = await visit(server3, USER_A, [CARD], registered([card]));
    server3.events[0].status = 'pending'; // the link did NOT land this time
    server3.events[0].linked = null;
    server3.failNextLink(0);
    const s3b = await visit(server3, USER_A, [CARD], s3.state);
    check(
      'B3 link never landed → the retry links the existing transaction, no second create',
      server3.txns.size === 1 && server3.createCalls() === 1 && s3b.outcomes[0]?.kind === 'link' && (server3.events[0].status as string) === 'handled',
    );
  }
  {
    for (const [label, other] of [
      ['same user', USER_A],
      ['another member', USER_B],
    ] as const) {
      const server = fakeServer([event()]);
      const [a, b] = await Promise.all([
        visit(server, USER_A, [CARD], registered([card])),
        visit(server, other, [{ ...CARD, postedAt: CARD.postedAt + 3 * SECOND, notificationKey: 'b' }], registered(inboxOf([{ ...CARD, postedAt: CARD.postedAt + 3 * SECOND, notificationKey: 'b' }]))),
      ]);
      const kinds = [a.outcomes[0]?.kind, b.outcomes[0]?.kind].sort().join(',');
      check(
        `C two phones (${label}) auto-save the same event at once → 1 transaction, linked once`,
        server.txns.size === 1 &&
          server.events[0].status === 'handled' &&
          (kinds === 'already,saved' || kinds === 'saved,saved'),
        `${server.txns.size} txns, ${kinds}`,
      );
    }
  }

  // ── failures ──────────────────────────────────────────────────
  {
    const server = fakeServer([event()]);
    server.failNextCreate('transport');
    const v = await visit(server, USER_A, [CARD], registered([card]));
    check(
      'OFF 1 offline at create → retry later: nothing saved, candidate pending, not marked failed',
      v.outcomes[0]?.kind === 'retry' &&
        server.txns.size === 0 &&
        inboxOf([CARD], v.state)[0].status === 'pending' &&
        v.state[card.fingerprint].autoSaveFailedAt == null,
    );
    const later = await visit(server, USER_A, [CARD], v.state);
    check('OFF 2 back online → saved once', later.outcomes[0]?.kind === 'saved' && server.txns.size === 1);
    const server2 = fakeServer([event()]);
    server2.failNextLink(1);
    const v2 = await visit(server2, USER_A, [CARD], registered([card]));
    check('OFF 3 offline before the link check → nothing created', v2.outcomes[0]?.kind === 'retry' && server2.createCalls() === 0);
  }
  {
    const server = fakeServer([event()]);
    server.failNextCreate('refused');
    const v = await visit(server, USER_A, [CARD], registered([card]));
    const again = await visit(server, USER_A, [CARD], v.state);
    check(
      'FAIL 1 create refused and no transaction exists → failed: stays pending for the user, never retried',
      v.outcomes[0]?.kind === 'failed' &&
        server.txns.size === 0 &&
        inboxOf([CARD], v.state)[0].status === 'pending' &&
        inboxOf([CARD], v.state)[0].autoSaveFailed &&
        again.jobs.length === 0,
    );
  }
  {
    const server = fakeServer([event(EVENT_1, { status: 'handled', linked: 'txn-manual-1' })]);
    const v = await visit(server, USER_A, [CARD], registered([card]));
    check(
      'LINK 1 event already handled elsewhere → no create, candidate handled here',
      v.outcomes[0]?.kind === 'already' && server.createCalls() === 0 && inboxOf([CARD], v.state)[0].status === 'handled',
    );
  }
  {
    // Linked meanwhile to an ordinary (pre-registration) manual transaction.
    const server = fakeServer([event()]);
    server.onBeforeComplete((e) => {
      if (e.status === 'pending') {
        e.status = 'handled';
        e.linked = 'txn-1800000000000-legacy';
      }
    });
    const v = await visit(server, USER_A, [CARD], registered([card]));
    const again = await visit(server, USER_A, [CARD], v.state);
    const item = inboxOf([CARD], v.state)[0];
    check(
      'LINK 2 created, then the link is refused (conflict) → the transaction stays, candidate handled + flagged, never retried',
      v.outcomes[0]?.kind === 'saved' &&
        server.txns.size === 1 &&
        item.linkConflict &&
        item.status === 'handled' &&
        item.autoSaved &&
        item.autoSaveFailed &&
        again.jobs.length === 0,
      JSON.stringify(v.outcomes),
    );
  }
  {
    const s = prunePaymentCandidateState(
      JSON.parse(
        JSON.stringify(
          applyPaymentAutoSaveOutcomes(
            registered([card]),
            [{ kind: 'saved', fingerprint: card.fingerprint, transactionId: `txn-pn-${EVENT_1}`, linked: false }],
            NOW,
          ),
        ),
      ),
      NOW + MINUTE,
    );
    check(
      'STATE auto-save fields + event id survive the stored-state round trip',
      s[card.fingerprint]?.registeredEventId === EVENT_1 &&
        s[card.fingerprint].autoSaveTxnId === `txn-pn-${EVENT_1}` &&
        s[card.fingerprint].autoSavedAt === NOW &&
        s[card.fingerprint].autoSaveLinkedAt == null &&
        s[card.fingerprint].handledAt === NOW,
    );
  }

  // ── manual saves from the 후보함 are linked too ───────────────
  const MANUAL_ID = 'txn-1800000000000-abc123';
  const memoryIO = (initial: PaymentCandidateState) => {
    let stored: unknown = JSON.parse(JSON.stringify(initial));
    return {
      io: {
        load: async () => stored,
        save: async (s: PaymentCandidateState) => {
          stored = JSON.parse(JSON.stringify(s));
        },
      },
      read: () => prunePaymentCandidateState(stored, NOW),
    };
  };
  /** Phone A: candidate → /input → saved (as /input reports it). */
  const manualSaveOnA = async (
    server: ReturnType<typeof fakeServer>,
    item: PaymentInboxItem,
    eventId: string,
    draft: NewTransactionDraft,
    outcome: 'saved' | 'queued' | 'failed' | 'queue-failed' = 'saved',
    txnHousehold = HOUSE,
  ) => {
    const m = memoryIO(markCandidateSent(registered([item], [eventId]), item.fingerprint, NOW));
    if (outcome === 'saved') server.manualSave(USER_A, MANUAL_ID, draft, txnHousehold);
    await settleSourceCandidate(m.io, item.fingerprint, outcome, NOW, { transactionId: MANUAL_ID, householdId: txnHousehold });
    return m.read();
  };
  const cardDraft: NewTransactionDraft = { type: 'expense', category: 'food', amount: 5100, memo: '청계상회', date: new Date(NOW).toISOString() };
  const otherPhone = { ...CARD, postedAt: CARD.postedAt + 3 * SECOND, notificationKey: 'b' };
  {
    const server = fakeServer([event()]);
    const stateA = await manualSaveOnA(server, card, EVENT_1, cardDraft);
    const a = await visit(server, USER_A, [CARD], stateA);
    const b = await visit(server, USER_B, [otherPhone], registered(inboxOf([otherPhone])));
    check(
      'M-A phone A saves the candidate by hand → linked (manual); phone B auto-save → nothing new → 1 transaction',
      a.links[0]?.source === 'manual' &&
        a.outcomes[0]?.kind === 'link' &&
        a.state[card.fingerprint].manualLinkedAt === NOW &&
        server.events[0].linked === MANUAL_ID &&
        b.outcomes[0]?.kind === 'already' &&
        server.txns.size === 1 &&
        !server.txns.has(`txn-pn-${EVENT_1}`) &&
        server.completeCalls[0] === 'manual',
      JSON.stringify([a.outcomes, b.outcomes]),
    );
  }
  {
    // LIMIT (documented): B saved automatically BEFORE A's manual link landed.
    const server = fakeServer([event()]);
    const b = await visit(server, USER_B, [otherPhone], registered(inboxOf([otherPhone])));
    const stateA = await manualSaveOnA(server, card, EVENT_1, cardDraft);
    const a = await visit(server, USER_A, [CARD], stateA);
    check(
      'M-A2 LIMIT (candidate saved BEFORE its registration → ordinary id): B auto-saved first → 2 transactions, A flagged',
      b.outcomes[0]?.kind === 'saved' &&
        server.txns.size === 2 &&
        a.outcomes[0]?.kind === 'link' &&
        a.outcomes[0].kind === 'link' &&
        a.outcomes[0].status === 'conflict' &&
        inboxOf([CARD], a.state)[0].linkConflict &&
        a.state[card.fingerprint].manualLinkFailedAt === NOW,
      JSON.stringify(a.outcomes),
    );
  }
  {
    const server = fakeServer([event()]);
    const stateA = await manualSaveOnA(server, card, EVENT_1, cardDraft);
    server.loseNextCompleteReply(1);
    const first = await visit(server, USER_A, [CARD], stateA);
    const second = await visit(server, USER_A, [CARD], first.state);
    const third = await visit(server, USER_A, [CARD], second.state);
    check(
      'M-B manual save ok, link reply lost → retried → already_linked; still 1 transaction, nothing created',
      first.outcomes[0]?.kind === 'link' &&
        first.state[card.fingerprint].manualLinkedAt == null &&
        second.state[card.fingerprint].manualLinkedAt === NOW &&
        third.links.length === 0 &&
        server.txns.size === 1 &&
        server.createCalls() === 0,
      JSON.stringify([first.outcomes, second.outcomes]),
    );
  }
  {
    const m = memoryIO(registered([card]));
    const recorded = await settleSourceCandidate(m.io, null, 'saved', NOW, { transactionId: MANUAL_ID, householdId: HOUSE });
    check(
      'M-C ordinary manual input (no source candidate) → nothing recorded, no link',
      !recorded && selectPaymentLinkJobs(m.read(), HOUSE).length === 0 && m.read()[card.fingerprint].manualTxnId == null,
    );
    const params = { ...inputPrefillToParams({ type: 'expense', amount: 5100, memo: '청계상회', dateKey: '2027-01-15' }, card.fingerprint), id: 'txn-edit-1' };
    check('M-D edit mode (?id=…) → no source candidate → no link', parseInputRouteSeed(params, '2027-01-20').sourceCandidateId === null);
  }
  {
    for (const outcome of ['failed', 'queue-failed'] as const) {
      const server = fakeServer([event()]);
      const stateA = await manualSaveOnA(server, card, EVENT_1, cardDraft, outcome);
      const a = await visit(server, USER_A, [CARD], stateA);
      check(
        `M-E candidate save ${outcome} → nothing recorded, event stays pending`,
        stateA[card.fingerprint].manualTxnId == null &&
          stateA[card.fingerprint].handledAt == null &&
          a.links.length === 0 &&
          server.events[0].status === 'pending',
      );
    }
    const server = fakeServer([event()]);
    const queued = await manualSaveOnA(server, card, EVENT_1, cardDraft, 'queued');
    const before = await visit(server, USER_A, [CARD], queued);
    server.manualSave(USER_A, MANUAL_ID, cardDraft); // the offline queue flushes
    const after = await visit(server, USER_A, [CARD], before.state);
    const never = fakeServer([event()]); // the queued create never reaches the server
    const stale = await visit(never, USER_A, [CARD], queued, ON_SINCE, NOW + PAYMENT_MANUAL_LINK_MAX_AGE_MS + 1);
    const o = stale.outcomes[0];
    check(
      'M-E2 queued manual save: link waits (transaction_missing) until the queue flushed, then links; gives up after 7 days',
      before.outcomes[0]?.kind === 'link' &&
        before.outcomes[0].kind === 'link' &&
        before.outcomes[0].result === 'pending' &&
        before.state[card.fingerprint].manualLinkFailedAt == null &&
        after.state[card.fingerprint].manualLinkedAt === NOW &&
        o?.kind === 'link' &&
        o.result === 'refused' &&
        stale.state[card.fingerprint].manualLinkFailedAt != null,
      JSON.stringify(stale.outcomes),
    );
  }
  {
    const server = fakeServer([event()]);
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const stateA = await manualSaveOnA(server, card, EVENT_1, cardDraft, 'saved', OTHER);
    const a = await visit(server, USER_A, [CARD], stateA);
    // Even if the link were attempted: the transaction is not in this household.
    const forced = await linkPaymentCandidate(
      { fingerprint: card.fingerprint, eventId: EVENT_1, transactionId: MANUAL_ID, source: 'manual', savedAt: NOW - 8 * 24 * 60 * MINUTE },
      server.io(USER_A),
      NOW,
    );
    check(
      'M-F a transaction of ANOTHER household → never linked (no job here; the server says transaction_missing)',
      a.links.length === 0 &&
        forced.kind === 'link' &&
        forced.status === 'transaction_missing' &&
        forced.result === 'refused' &&
        server.events[0].status === 'pending',
    );
  }
  {
    const EVENT_2 = 'e2e2e2e2-2222-4222-8222-222222222222';
    const server = fakeServer([event(), event(EVENT_2, { status: 'handled', linked: MANUAL_ID })]);
    const stateA = await manualSaveOnA(server, card, EVENT_1, cardDraft);
    const a = await visit(server, USER_A, [CARD], stateA);
    check(
      'M-G a transaction already linked to ANOTHER event → transaction_in_use, not linked, not retried',
      a.outcomes[0]?.kind === 'link' &&
        a.outcomes[0].kind === 'link' &&
        a.outcomes[0].status === 'transaction_in_use' &&
        server.events[0].status === 'pending' &&
        a.state[card.fingerprint].manualLinkFailedAt === NOW &&
        selectPaymentLinkJobs(a.state, HOUSE).length === 0,
    );
    const auto = await linkPaymentCandidate(
      { fingerprint: card.fingerprint, eventId: EVENT_1, transactionId: MANUAL_ID, source: 'auto', savedAt: NOW },
      server.io(USER_A),
      NOW,
    );
    check('M-G2 an automatic link to a non-derived id → refused (INVALID_ARGUMENT)', auto.kind === 'link' && auto.result === 'refused');
  }
  {
    // Supported manual mappings: outflow ↔ expense, income ↔ income; nothing for a cancellation.
    const IN_EVENT = 'e3e3e3e3-3333-4333-8333-333333333333';
    const OUT_EVENT = 'e4e4e4e4-4444-4444-8444-444444444444';
    const CANCEL_EVENT = 'e5e5e5e5-5555-4555-8555-555555555555';
    const mk = (eventType: string, id: string, amount = 398400) => event(id, { eventType, amount });
    const [inItem] = inboxOf([IN]);
    const [outItem] = inboxOf([OUT]);
    const [cancelItem] = inboxOf([CANCEL]);
    const link = async (eventRow: EventRow, item: PaymentInboxItem, draft: NewTransactionDraft, creator = USER_A) => {
      const server = fakeServer([eventRow]);
      server.manualSave(creator, MANUAL_ID, draft);
      const state = markCandidateManualSaved(registered([item], [eventRow.id]), item.fingerprint, MANUAL_ID, HOUSE, NOW);
      const v = await visit(server, USER_A, [IN, OUT, CANCEL], state);
      const o = v.outcomes[0];
      return o?.kind === 'link' ? `${o.result}${o.status ? `:${o.status}` : ''}` : String(o?.kind);
    };
    const income: NewTransactionDraft = { type: 'income', category: 'side', amount: 398400, memo: '홍*동', date: new Date(NOW).toISOString() };
    const expense: NewTransactionDraft = { ...income, type: 'expense', category: 'other' };
    const results2 = {
      inAsIncome: await link(mk('income', IN_EVENT), inItem, income),
      inAsExpense: await link(mk('income', IN_EVENT), inItem, expense),
      outAsExpense: await link(mk('outflow', OUT_EVENT), outItem, expense),
      outAsIncome: await link(mk('outflow', OUT_EVENT), outItem, income),
      editedAmount: await link(mk('income', IN_EVENT), inItem, { ...income, amount: 400000 }),
      otherCreator: await link(mk('income', IN_EVENT), inItem, income, USER_B),
      cancel: await link(mk('card_cancel', CANCEL_EVENT, 5100), cancelItem, expense),
    };
    check(
      'MAP manual: income↔income and outflow↔expense link (edited amount allowed); type flip / other creator / cancellation refused',
      results2.inAsIncome === 'linked' &&
        results2.outAsExpense === 'linked' &&
        results2.editedAmount === 'linked' &&
        results2.inAsExpense === 'refused:transaction_mismatch' &&
        results2.outAsIncome === 'refused:transaction_mismatch' &&
        results2.otherCreator === 'refused:transaction_mismatch' &&
        results2.cancel === 'refused',
      JSON.stringify(results2),
    );
  }
  check(
    'M-STATE manual fields survive the stored-state round trip; a second record never overwrites the first',
    (() => {
      const once = markCandidateManualSaved(registered([card]), card.fingerprint, MANUAL_ID, HOUSE, NOW);
      const twice = markCandidateManualSaved(once, card.fingerprint, 'txn-other', HOUSE, NOW + 1);
      const back = prunePaymentCandidateState(JSON.parse(JSON.stringify(twice)), NOW + MINUTE)[card.fingerprint];
      return back.manualTxnId === MANUAL_ID && back.manualHouseholdId === HOUSE && back.manualSavedAt === NOW;
    })(),
  );
  check(
    'M-AUTO a candidate saved by hand is never auto-saved',
    selectPaymentAutoSaveJobs(
      [card],
      markCandidateManualSaved(registered([card]), card.fingerprint, MANUAL_ID, HOUSE, NOW),
      HOUSE,
      ON_SINCE,
      NOW,
    ).length === 0,
  );

  // ── manual vs automatic: ONE id per event ─────────────────────
  /**
   * /input's create from a candidate, modelled step by step as app/input.tsx
   * does it: the derived id when registered (else a random one); event
   * already handled → nothing; createTransaction (23505 reconcile in the
   * fake); refused → is the event's transaction there? → nothing; offline →
   * the offline queue keeps the SAME id + draft (`queue`); saved / queued →
   * settle (records the id for the link).
   */
  const manualFlow = async (
    server: ReturnType<typeof fakeServer>,
    userId: string,
    item: PaymentInboxItem,
    state: PaymentCandidateState,
    draft: NewTransactionDraft,
    opts: { offline?: boolean } = {},
  ) => {
    const io = server.io(userId);
    const derived = paymentCandidateTransactionId(state, item.fingerprint, HOUSE);
    const transactionId = derived?.transactionId ?? `txn-1800000000000-${userId.slice(0, 4)}`;
    const m = memoryIO(markCandidateSent(state, item.fingerprint, NOW));
    const settle = (outcome: 'saved' | 'queued') =>
      settleSourceCandidate(m.io, item.fingerprint, outcome, NOW, { transactionId, householdId: HOUSE });
    if (derived) {
      const link = await io.getLink(derived.eventId);
      if (link.ok && link.status === 'handled') {
        await settle('saved');
        return { result: 'already' as const, transactionId, state: m.read() };
      }
    }
    if (opts.offline) {
      await settle('queued');
      return { result: 'queued' as const, transactionId, state: m.read(), flush: () => io.create(transactionId, draft) };
    }
    const created = await io.create(transactionId, draft);
    if (created.ok) {
      await settle('saved');
      return { result: 'saved' as const, transactionId, state: m.read() };
    }
    if (derived) {
      const c = await io.complete(derived.eventId, transactionId, 'manual');
      if (c.ok && (c.status === 'linked' || c.status === 'already_linked')) {
        await settle('saved');
        return { result: 'already' as const, transactionId, state: m.read() };
      }
    }
    return { result: 'failed' as const, transactionId, state: m.read() };
  };
  const reg = (item: PaymentInboxItem, id = EVENT_1) => markCandidateRegistered({}, item.fingerprint, HOUSE, NOW, id);
  const [cardB] = inboxOf([otherPhone]);
  const edited: NewTransactionDraft = { type: 'expense', category: 'food', amount: 5500, memo: '청계상회 점심', date: new Date(NOW).toISOString() };
  {
    const server = fakeServer([event()]);
    const a = await manualFlow(server, USER_A, card, reg(card), edited);
    const aLink = await visit(server, USER_A, [CARD], a.state);
    const b = await visit(server, USER_B, [otherPhone], reg(cardB));
    check(
      'R-A phone A saves by hand first (derived id) → phone B auto-save → 1 transaction (A\'s)',
      a.result === 'saved' &&
        a.transactionId === `txn-pn-${EVENT_1}` &&
        aLink.outcomes[0]?.kind === 'link' &&
        b.outcomes[0]?.kind === 'already' &&
        server.txns.size === 1 &&
        server.txns.get(`txn-pn-${EVENT_1}`)?.draft.amount === 5500,
      JSON.stringify([a.result, b.outcomes]),
    );
    const bNoLink = fakeServer([event()]);
    await manualFlow(bNoLink, USER_A, card, reg(card), edited); // saved, NOT linked yet
    const b2 = await visit(bNoLink, USER_B, [otherPhone], reg(cardB));
    check(
      'R-A2 A saved by hand but its link has not landed → B\'s insert is refused, B links A\'s transaction, adds nothing',
      bNoLink.txns.size === 1 &&
        b2.outcomes[0]?.kind === 'already' &&
        bNoLink.events[0].linked === `txn-pn-${EVENT_1}` &&
        bNoLink.txns.get(`txn-pn-${EVENT_1}`)?.createdBy === USER_A,
      JSON.stringify(b2.outcomes),
    );
  }
  {
    const server = fakeServer([event()]);
    const b = await visit(server, USER_B, [otherPhone], reg(cardB));
    const a = await manualFlow(server, USER_A, card, reg(card), edited);
    const bUnlinked = fakeServer([event()]);
    bUnlinked.loseNextCompleteReply(0);
    await bUnlinked.io(USER_B).create(`txn-pn-${EVENT_1}`, buildPaymentAutoSaveDraft(cardB)); // B saved, link not landed
    const a2 = await manualFlow(bUnlinked, USER_A, card, reg(card), edited);
    check(
      'R-B phone B auto-saves first → phone A\'s manual save adds nothing (1 transaction, B\'s kept unchanged)',
      b.outcomes[0]?.kind === 'saved' &&
        a.result === 'already' &&
        server.txns.size === 1 &&
        server.txns.get(`txn-pn-${EVENT_1}`)?.draft.amount === 5100 &&
        a2.result === 'already' &&
        bUnlinked.txns.size === 1 &&
        bUnlinked.txns.get(`txn-pn-${EVENT_1}`)?.createdBy === USER_B &&
        bUnlinked.events[0].linked === `txn-pn-${EVENT_1}`,
      JSON.stringify([a.result, a2.result]),
    );
    check(
      'R-B2 A\'s candidate is handled locally (the link to the existing transaction is idempotent)',
      a.state[card.fingerprint].handledAt != null && a.state[card.fingerprint].manualTxnId === `txn-pn-${EVENT_1}`,
    );
  }
  {
    for (const order of ['manual-first', 'auto-first'] as const) {
      const server = fakeServer([event()]);
      const manual = () => manualFlow(server, USER_A, card, reg(card), edited).then((r) => r.result as string);
      const auto = () => visit(server, USER_B, [otherPhone], reg(cardB)).then((r) => r.outcomes[0]?.kind ?? 'none');
      const [r1, r2] = await Promise.all(order === 'manual-first' ? [manual(), auto()] : [auto(), manual()]);
      check(
        `R-C/D manual (edited amount / memo / category) and automatic save at the same time (${order}) → 1 transaction, the first insert kept`,
        server.txns.size === 1 && server.txns.has(`txn-pn-${EVENT_1}`) && server.events[0].status === 'handled',
        JSON.stringify([r1, r2]),
      );
    }
    const server = fakeServer([event()]);
    const first = await manualFlow(server, USER_A, card, reg(card), edited);
    const kept = JSON.stringify(server.txns.get(`txn-pn-${EVENT_1}`));
    await visit(server, USER_B, [otherPhone], reg(cardB));
    check(
      'R-D2 the first saved transaction is never overwritten by the second request',
      first.result === 'saved' && JSON.stringify(server.txns.get(`txn-pn-${EVENT_1}`)) === kept,
    );
  }
  {
    const server = fakeServer([event()]);
    const [a, b] = await Promise.all([
      manualFlow(server, USER_A, card, reg(card), edited),
      manualFlow(server, USER_B, cardB, reg(cardB), { ...edited, amount: 5100, category: 'other' }),
    ]);
    check(
      'R-E both phones save by hand → 1 transaction; the second sees "already"',
      server.txns.size === 1 && [a.result, b.result].sort().join(',') === 'already,saved',
      JSON.stringify([a.result, b.result]),
    );
  }
  {
    const server = fakeServer([event()]);
    const a = await manualFlow(server, USER_A, card, reg(card), edited, { offline: true });
    const b = await visit(server, USER_B, [otherPhone], reg(cardB)); // online automatic save meanwhile
    const flushed = a.result === 'queued' && a.flush ? await a.flush() : null;
    const aLink = await visit(server, USER_A, [CARD], a.state);
    check(
      'R-F offline manual save (queued with the derived id) + another phone\'s online auto-save → 1 transaction',
      a.transactionId === `txn-pn-${EVENT_1}` &&
        b.outcomes[0]?.kind === 'saved' &&
        flushed != null &&
        !flushed.ok && // the queue\'s replay hits the primary key: nothing is added
        server.txns.size === 1 &&
        aLink.outcomes[0]?.kind === 'link' &&
        aLink.outcomes[0].kind === 'link' &&
        aLink.outcomes[0].result === 'linked',
      JSON.stringify([a.result, b.outcomes, flushed, aLink.outcomes]),
    );
  }
  {
    check(
      'R-G an ordinary manual input / an unregistered candidate keeps the random id (no derived id)',
      paymentCandidateTransactionId({}, card.fingerprint, HOUSE) === null &&
        paymentCandidateTransactionId(markCandidateRegistered({}, card.fingerprint, HOUSE, NOW), card.fingerprint, HOUSE) === null &&
        paymentCandidateTransactionId(reg(card), card.fingerprint, '22222222-2222-4222-8222-222222222222') === null,
    );
    const params = { ...inputPrefillToParams({ type: 'expense', amount: 5100, memo: '청계상회', dateKey: '2027-01-15' }, card.fingerprint), id: 'txn-edit-1' };
    check('R-H edit mode → no source candidate → never a derived id', parseInputRouteSeed(params, '2027-01-20').sourceCandidateId === null);
  }
  {
    const IN_EVENT = 'e3e3e3e3-3333-4333-8333-333333333333';
    const [inItem] = inboxOf([IN]);
    const inB = { ...IN, postedAt: IN.postedAt + 2000, notificationKey: 'i2' };
    const [inItemB] = inboxOf([inB]);
    const income: NewTransactionDraft = { type: 'income', category: 'side', amount: 398400, memo: '홍*동', date: new Date(NOW).toISOString() };
    const server = fakeServer([event(IN_EVENT, { eventType: 'income', amount: 398400 })]);
    const a = await manualFlow(server, USER_A, inItem, reg(inItem, IN_EVENT), income);
    const b = await manualFlow(server, USER_B, inItemB, reg(inItemB, IN_EVENT), { ...income, category: 'other-in' });
    await visit(server, USER_A, [IN], a.state);
    check(
      'R-I 입금 candidate saved by hand on two phones → derived id → 1 transaction, linked',
      a.transactionId === `txn-pn-${IN_EVENT}` &&
        a.result === 'saved' &&
        b.result === 'already' &&
        server.txns.size === 1 &&
        server.events[0].linked === `txn-pn-${IN_EVENT}`,
      JSON.stringify([a.result, b.result]),
    );
  }
  {
    const [cancelItem] = inboxOf([CANCEL]);
    check(
      'R-J card_cancel → no /input action (no prefill), never auto-saved → no transaction',
      cancelItem.kind === 'card_cancellation' &&
        cancelItem.prefill === null &&
        selectPaymentAutoSaveJobs([cancelItem], reg(cancelItem), HOUSE, ON_SINCE, NOW).length === 0,
    );
    const server = fakeServer([event()]);
    const wrong = await server.io(USER_A).complete(EVENT_1, 'txn-pn-e2e2e2e2-2222-4222-8222-222222222222', 'manual');
    check('R-K another event\'s derived id can never be linked (INVALID_ARGUMENT)', !wrong.ok && !wrong.transport);
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
