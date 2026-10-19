/**
 * Static verification for 카드 결제 취소 → 원결제 찾기 → 전액 취소 처리
 * (refundMatch.ts) and its 후보함 state (candidateInbox.ts). Same convention
 * as the other *.cases.ts files: plain data + a runner, never imported by
 * the app.
 *
 * The inbox is built from real KakaoBank notification shapes; the ledger is
 * plain Transaction objects; the delete / queue / state IO is faked (the
 * state round-trips through JSON like AsyncStorage does). The screen wiring
 * (Alert confirm, toasts) is real-device QA.
 */
import { PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED } from '@/lib/paymentNotification/autoSave';
import {
  buildPaymentInbox,
  markCandidateRefunded,
  paymentCandidateFingerprint,
  prunePaymentCandidateState,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import {
  REFUND_MATCH_WINDOW_DAYS,
  findPartialRefundCandidates,
  findRefundMatches,
  refundCardCancellation,
  type RefundDeleteResult,
  type RefundEnqueueResult,
  type RefundIO,
  type RefundMatchInput,
} from '@/lib/paymentNotification/refundMatch';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';
import { toDateKey } from '@/lib/format';
import type { Transaction } from '@/store/types';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

// Local noon, so day arithmetic never crosses a date line by accident.
const NOW = new Date(2027, 0, 15, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const HOUSE = '11111111-1111-4111-8111-111111111111';
const EVENT = '00000000-0000-4000-8000-000000000007';
const TODAY = toDateKey(new Date(NOW));

const kb = (title: string, text: string, postedAt: number, key: string): CapturedNotification => ({
  notificationKey: key,
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});
const PURCHASE = kb('카드 결제 28,400원', '체크카드(3346) | 쿠팡(쿠페이) 잔액 100,000원', NOW - 2 * DAY, 'p');
const PURCHASE_OTHER_CARD = kb('카드 결제 28,400원', '체크카드(9999) | 쿠팡(쿠페이) 잔액 90,000원', NOW - 3 * DAY, 'p9');
const CANCEL = kb('카드 결제 취소 28,400원', '체크카드(3346) | 쿠팡(쿠페이) 잔액 128,400원', NOW - HOUR, 'c');
const CANCEL_2 = kb('카드 결제 취소 28,400원', '체크카드(3346) | 쿠팡(쿠페이) 잔액 156,800원', NOW - HOUR / 2, 'c2');

const txn = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  type: 'expense',
  category: 'shopping',
  amount: 28400,
  memo: '쿠팡(쿠페이)',
  date: new Date(NOW - 2 * DAY).toISOString(),
  ...over,
});

const fpOf = (n: CapturedNotification) => paymentCandidateFingerprint(n);

function inboxOf(captured: CapturedNotification[], state: PaymentCandidateState) {
  const items = buildPaymentInbox(captured, state, TODAY).items;
  const find = (n: CapturedNotification) => items.find((i) => i.fingerprint === fpOf(n))!;
  return { items, find };
}

function matchInput(over: {
  captured?: CapturedNotification[];
  cancel?: CapturedNotification;
  state?: PaymentCandidateState;
  transactions: Transaction[];
  deletable?: string[];
}): RefundMatchInput {
  const state = over.state ?? {};
  const { items, find } = inboxOf(over.captured ?? [PURCHASE, CANCEL], state);
  return {
    cancel: find(over.cancel ?? CANCEL),
    items,
    state,
    householdId: HOUSE,
    transactions: over.transactions,
    deletableIds: new Set(over.deletable ?? over.transactions.map((t) => t.id)),
  };
}

const manualSaved = (n: CapturedNotification, transactionId: string): PaymentCandidateState => ({
  [fpOf(n)]: {
    sentAt: NOW - 2 * DAY,
    handledAt: NOW - 2 * DAY,
    manualTxnId: transactionId,
    manualHouseholdId: HOUSE,
    manualSavedAt: NOW - 2 * DAY,
  },
});

/** Fake IO: the ordinary delete / queue, and the stored 후보함 state. */
function fakeIO(
  initial: PaymentCandidateState,
  opts: { del?: RefundDeleteResult; enq?: RefundEnqueueResult; updateThrows?: boolean } = {},
) {
  let raw = JSON.stringify(initial);
  const calls = { deletes: [] as string[], enqueues: [] as string[], writes: 0 };
  const io: RefundIO = {
    softDelete: async (id) => {
      calls.deletes.push(id);
      return opts.del ?? { ok: true };
    },
    enqueueDelete: async (id) => {
      calls.enqueues.push(id);
      return opts.enq ?? { ok: true };
    },
    loadState: async () => prunePaymentCandidateState(JSON.parse(raw), NOW),
    updateState: async (change) => {
      if (opts.updateThrows) throw new Error('storage');
      const next = change(prunePaymentCandidateState(JSON.parse(raw), NOW));
      calls.writes += 1;
      raw = JSON.stringify(next);
      return next;
    },
    now: () => NOW,
  };
  return { io, calls, read: (): PaymentCandidateState => JSON.parse(raw) as PaymentCandidateState };
}

export async function runRefundMatchCases(): Promise<{ results: CaseResult[]; passed: number; failed: number }> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const ids = (ms: { transaction: Transaction }[]) => ms.map((m) => m.transaction.id);

  // ── 원결제 후보 찾기 ─────────────────────────────────────────
  {
    const input = matchInput({
      state: manualSaved(PURCHASE, 'txn-a'),
      transactions: [txn('txn-a', { memo: '쿠팡 생필품' }), txn('txn-b')],
    });
    const m = findRefundMatches(input);
    check(
      'MATCH-1 the 후보함 card payment (amount / merchant / last 4) saved as txn-a → txn-a first, as the 후보함 match; others still listed',
      m.length === 2 &&
        m[0].transaction.id === 'txn-a' &&
        m[0].basis === 'inbox' &&
        m[0].reasons.includes('카드 끝 4자리 일치') &&
        m[1].transaction.id === 'txn-b' &&
        m[1].basis === 'ledger',
      JSON.stringify(m.map((x) => [x.transaction.id, x.basis, x.score])),
    );
  }
  {
    const input = matchInput({
      captured: [PURCHASE_OTHER_CARD, CANCEL],
      state: manualSaved(PURCHASE_OTHER_CARD, 'txn-a'),
      transactions: [txn('txn-a')],
    });
    const m = findRefundMatches(input);
    check(
      'MATCH-1b the 후보함 payment was on ANOTHER card (last 4 differ) → not a 후보함 match (only a ledger guess)',
      m.length === 1 && m[0].basis === 'ledger',
      JSON.stringify(m.map((x) => x.basis)),
    );
  }
  {
    const state: PaymentCandidateState = {
      [fpOf(PURCHASE)]: { registeredAt: NOW - 2 * DAY, registeredHouseholdId: HOUSE, registeredEventId: EVENT },
    };
    const derived = `txn-pn-${EVENT}`;
    const m = findRefundMatches(matchInput({ state, transactions: [txn(derived, { memo: '' })] }));
    check(
      'MATCH-1c the payment saved with its server event id (another phone / an earlier auto-save) → found as the 후보함 match',
      m.length === 1 && m[0].transaction.id === derived && m[0].basis === 'inbox',
    );
  }
  {
    const m = findRefundMatches(matchInput({ captured: [CANCEL], transactions: [txn('txn-b')] }));
    check(
      'MATCH-2 ledger: expense, same amount, memo = merchant, earlier day → listed (ledger basis)',
      m.length === 1 && m[0].transaction.id === 'txn-b' && m[0].basis === 'ledger' && m[0].reasons.includes('메모가 가맹점과 같아요'),
    );
  }
  {
    const m = findRefundMatches(
      matchInput({
        captured: [CANCEL],
        transactions: [txn('txn-1'), txn('txn-2', { date: new Date(NOW - 5 * DAY).toISOString() })],
      }),
    );
    check(
      'MATCH-3 two purchases of the same amount at the same shop → BOTH listed (nearest first), none chosen',
      m.length === 2 && m[0].transaction.id === 'txn-1' && m[1].transaction.id === 'txn-2',
      JSON.stringify(ids(m)),
    );
  }
  {
    const m = findRefundMatches(
      matchInput({ captured: [CANCEL], transactions: [txn('later', { date: new Date(NOW + DAY).toISOString() })] }),
    );
    check('MATCH-4 a transaction dated after the cancellation day → excluded', m.length === 0);
  }
  {
    const m = findRefundMatches(
      matchInput({
        captured: [CANCEL],
        transactions: [
          txn('d31', { date: new Date(NOW - (REFUND_MATCH_WINDOW_DAYS + 1) * DAY).toISOString() }),
          txn('d30', { date: new Date(NOW - REFUND_MATCH_WINDOW_DAYS * DAY).toISOString() }),
        ],
      }),
    );
    check('MATCH-5 older than 30 days → excluded (30 days still in)', ids(m).join() === 'd30', JSON.stringify(ids(m)));
  }
  {
    const m = findRefundMatches(
      matchInput({ captured: [CANCEL], transactions: [txn('in', { type: 'income', category: 'other-in' })] }),
    );
    check('MATCH-6 an income of the same amount → excluded', m.length === 0);
  }
  {
    // txn-a was deleted (not in the visible ledger any more); txn-p has a pending offline change.
    const m = findRefundMatches(
      matchInput({ state: manualSaved(PURCHASE, 'txn-a'), transactions: [txn('txn-p')], deletable: [] }),
    );
    check('MATCH-7 a deleted transaction (and one with a pending offline change) → excluded', m.length === 0);
  }
  {
    const state: PaymentCandidateState = {
      [fpOf(CANCEL_2)]: { handledAt: NOW - HOUR, refundTxnId: 'txn-b', refundedAt: NOW - HOUR },
    };
    const m = findRefundMatches(
      matchInput({ captured: [CANCEL, CANCEL_2], state, transactions: [txn('txn-b'), txn('txn-c')] }),
    );
    check(
      'MATCH-8 a transaction another cancellation was already processed against → excluded',
      ids(m).join() === 'txn-c',
      JSON.stringify(ids(m)),
    );
  }
  {
    const input = matchInput({ captured: [CANCEL], transactions: [txn('big', { amount: 50000 })] });
    check(
      'MATCH-9 same shop, different amount → no match; offered only as "edit it by hand" (partial)',
      findRefundMatches(input).length === 0 && findPartialRefundCandidates(input).map((t) => t.id).join() === 'big',
    );
  }
  {
    const state: PaymentCandidateState = {
      [fpOf(CANCEL)]: { handledAt: NOW - HOUR, refundTxnId: 'txn-x', refundedAt: NOW - HOUR },
    };
    const input = matchInput({ captured: [CANCEL], state, transactions: [txn('txn-b')] });
    check(
      'MATCH-10 an already processed cancellation → no match list at all',
      findRefundMatches(input).length === 0 && findPartialRefundCandidates(input).length === 0,
    );
  }
  {
    const input = matchInput({ captured: [PURCHASE, CANCEL], transactions: [txn('txn-b')] });
    const purchaseAsCancel = { ...input, cancel: input.items.find((i) => i.kind === 'card_payment')! };
    check('MATCH-11 a card PAYMENT (not a cancellation) never gets matches', findRefundMatches(purchaseAsCancel).length === 0);
  }

  // ── 전액 취소 처리 ───────────────────────────────────────────
  const cancelItem = (state: PaymentCandidateState = {}, n: CapturedNotification = CANCEL): PaymentInboxItem =>
    inboxOf([PURCHASE, CANCEL, CANCEL_2], state).find(n);
  const statusOf = (state: PaymentCandidateState, n: CapturedNotification = CANCEL) =>
    inboxOf([PURCHASE, CANCEL, CANCEL_2], state).find(n);
  {
    const f = fakeIO({});
    const out = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    const after = statusOf(f.read());
    check(
      'REFUND-1 chosen + same amount + delete ok → the ordinary delete of txn-b, cancellation handled, refundTxnId recorded',
      out.kind === 'refunded' &&
        !out.queued &&
        out.recorded &&
        f.calls.deletes.join() === 'txn-b' &&
        f.calls.enqueues.length === 0 &&
        after.status === 'handled' &&
        after.refundTxnId === 'txn-b' &&
        f.read()[fpOf(CANCEL)].refundedAt === NOW,
      JSON.stringify({ out, state: f.read() }),
    );
  }
  {
    const f = fakeIO({}, { del: { ok: false, transport: true, reason: 'error' } });
    const out = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    check(
      'REFUND-2 offline → the durable delete queue accepted it → handled (as the app treats a queued delete)',
      out.kind === 'refunded' && out.queued && f.calls.enqueues.join() === 'txn-b' && statusOf(f.read()).status === 'handled',
    );
  }
  {
    const f = fakeIO({}, { del: { ok: false, transport: false, reason: 'conflict', message: 'x' } });
    const out = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    check(
      'REFUND-3 delete refused (conflict) → nothing recorded, cancellation pending, no queue',
      out.kind === 'failed' && out.reason === 'conflict' && f.calls.writes === 0 && f.calls.enqueues.length === 0 && statusOf(f.read()).status === 'pending',
    );
  }
  {
    const f = fakeIO({}, { del: { ok: false, transport: true }, enq: { ok: false, reason: 'cap' } });
    const out = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    check(
      'REFUND-4 offline and the queue refused → nothing recorded, cancellation pending',
      out.kind === 'queue-failed' && out.reason === 'cap' && f.calls.writes === 0 && statusOf(f.read()).status === 'pending',
    );
  }
  {
    const f = fakeIO({});
    const out = await refundCardCancellation(cancelItem(), txn('big', { amount: 50000 }), new Set(['big']), f.io);
    check(
      'REFUND-5 partial cancellation (amounts differ) → blocked, NO delete call, cancellation pending',
      out.kind === 'blocked' &&
        out.blocker === 'partial' &&
        f.calls.deletes.length === 0 &&
        f.calls.enqueues.length === 0 &&
        statusOf(f.read()).status === 'pending',
    );
  }
  {
    const f = fakeIO({});
    const first = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    const stored = JSON.stringify(f.read());
    // The same cancellation once more (a stale screen / a double tap) — even with another transaction.
    const again = await refundCardCancellation(cancelItem(), txn('txn-c'), new Set(['txn-c']), f.io);
    const sameState = markCandidateRefunded(f.read(), fpOf(CANCEL), 'txn-c', NOW + 1);
    check(
      'REFUND-6 the same cancellation again → blocked (already processed): one delete in total, state unchanged',
      first.kind === 'refunded' &&
        again.kind === 'blocked' &&
        again.blocker === 'already-refunded' &&
        f.calls.deletes.join() === 'txn-b' &&
        JSON.stringify(f.read()) === stored &&
        sameState[fpOf(CANCEL)].refundTxnId === 'txn-b',
    );
  }
  {
    const f = fakeIO({});
    await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    // Another cancellation of the same amount: the list no longer offers txn-b…
    const state = f.read();
    const listed = findRefundMatches(
      matchInput({ captured: [PURCHASE, CANCEL, CANCEL_2], cancel: CANCEL_2, state, transactions: [txn('txn-b'), txn('txn-c')] }),
    );
    // …and a stale screen that still shows it is refused before any delete.
    const out = await refundCardCancellation(cancelItem(state, CANCEL_2), txn('txn-b'), new Set(['txn-b']), f.io);
    check(
      'REFUND-7 another cancellation cannot reuse the processed transaction (not listed; refused if chosen anyway)',
      ids(listed).join() === 'txn-c' && out.kind === 'blocked' && out.blocker === 'used' && f.calls.deletes.length === 1,
      JSON.stringify({ listed: ids(listed), out }),
    );
  }
  {
    const f = fakeIO({});
    const out = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(), f.io);
    const inc = await refundCardCancellation(
      cancelItem(),
      txn('in', { type: 'income', category: 'other-in' }),
      new Set(['in']),
      f.io,
    );
    check(
      'REFUND-8 not deletable now (pending change / no server version) or an income → blocked, no delete',
      out.kind === 'blocked' && out.blocker === 'unavailable' && inc.kind === 'blocked' && inc.blocker === 'not-expense' && f.calls.deletes.length === 0,
    );
  }
  {
    const f = fakeIO({}, { updateThrows: true });
    const out = await refundCardCancellation(cancelItem(), txn('txn-b'), new Set(['txn-b']), f.io);
    check(
      'REFUND-9 delete ok but the state write failed → reported (refunded, not recorded), never throws',
      out.kind === 'refunded' && !out.recorded && f.calls.deletes.length === 1,
    );
  }
  {
    const purchaseItem = inboxOf([PURCHASE, CANCEL], {}).find(PURCHASE);
    const f = fakeIO({});
    const out = await refundCardCancellation(purchaseItem, txn('txn-b'), new Set(['txn-b']), f.io);
    check('REFUND-10 a card payment item is never processed as a cancellation', out.kind === 'blocked' && f.calls.deletes.length === 0);
  }

  // ── 후보함 state ─────────────────────────────────────────────
  {
    const state = markCandidateRefunded({}, fpOf(CANCEL), 'txn-b', NOW);
    const stored = prunePaymentCandidateState(JSON.parse(JSON.stringify(state)), NOW);
    const reparsed = buildPaymentInbox([CANCEL, CANCEL, PURCHASE], stored, TODAY).items.filter((i) => i.fingerprint === fpOf(CANCEL));
    check(
      'STATE-1 refund record survives storage (prune) and a re-parse: one handled entry, refundTxnId kept',
      reparsed.length === 1 && reparsed[0].status === 'handled' && reparsed[0].refundTxnId === 'txn-b',
    );
    const bad = prunePaymentCandidateState(
      { [fpOf(CANCEL)]: { handledAt: NOW, refundTxnId: 7, refundedAt: NOW }, [fpOf(CANCEL_2)]: { handledAt: NOW, refundTxnId: 'x' } },
      NOW,
    );
    check(
      'STATE-2 malformed refund fields are dropped (the rest of the entry kept)',
      bad[fpOf(CANCEL)]?.refundTxnId === undefined &&
        bad[fpOf(CANCEL)]?.handledAt === NOW &&
        bad[fpOf(CANCEL_2)]?.refundTxnId === undefined,
    );
  }

  // ── nothing automatic ────────────────────────────────────────
  check(
    'GATE the automatic save stays switched off; the refund IO has no create at all',
    PAYMENT_NOTIFICATION_AUTO_SAVE_ENABLED === false && !('create' in fakeIO({}).io),
  );

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
