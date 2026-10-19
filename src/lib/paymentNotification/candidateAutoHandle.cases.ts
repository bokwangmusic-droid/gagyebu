/**
 * Static verification for the 후보함 auto 처리 완료 (candidateAutoHandle.ts)
 * and the /input route seed (src/lib/inputPrefill.ts). Same convention as the
 * other *.cases.ts files: plain data + a runner, never imported by the app.
 *
 * Each flow goes 후보함 → route params → /input's parse → the create outcome
 * /input reports → stored state, over in-memory IO that round-trips through
 * JSON like AsyncStorage does. The /input wiring itself (which outcome is
 * reported where) is real-device QA.
 */
import { toDateKey } from '@/lib/format';
import { inputPrefillToParams, parseInputRouteSeed } from '@/lib/inputPrefill';
import {
  isCreateSaved,
  markStoredCandidateHandled,
  settleSourceCandidate,
  type CandidateStateIO,
  type CreateSaveOutcome,
} from '@/lib/paymentNotification/candidateAutoHandle';
import {
  buildPaymentInbox,
  markCandidateSent,
  type PaymentCandidateState,
  type PaymentInboxItem,
} from '@/lib/paymentNotification/candidateInbox';
import { KAKAOBANK_PACKAGE } from '@/lib/paymentNotification/kakaoBankParser';
import type { CapturedNotification } from '@/lib/paymentNotificationBuffer';

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = 1_800_000_000_000;
const TODAY = toDateKey(new Date(NOW));

const kb = (title: string, text: string, postedAt = NOW - 60_000): CapturedNotification => ({
  notificationKey: 'k',
  packageName: KAKAOBANK_PACKAGE,
  title,
  text,
  postedAt,
});
const CARD = kb('카드 결제 5,100원', '체크카드(3308) | 청계상회 잔액 185,400원');
const CARD_2 = kb('카드 결제 9,900원', '체크카드(3308) | 다이소 잔액 175,500원', NOW - 30_000);
const CANCEL = kb('카드 결제 취소 17,150원', '체크카드(3346) | 쿠팡(쿠페이) 잔액 51,598원', NOW - 10_000);

/** AsyncStorage-like store: JSON on every read / write, optional failures. */
function memoryIO(initial: unknown, fail: { load?: boolean; save?: boolean } = {}) {
  let raw: string | null = initial == null ? null : JSON.stringify(initial);
  let saves = 0;
  const io: CandidateStateIO = {
    load: async () => {
      if (fail.load) throw new Error('load failed');
      return raw == null ? null : (JSON.parse(raw) as unknown);
    },
    save: async (state) => {
      if (fail.save) throw new Error('save failed');
      saves += 1;
      raw = JSON.stringify(state);
    },
  };
  return {
    io,
    read: (): PaymentCandidateState => (raw == null ? {} : (JSON.parse(raw) as PaymentCandidateState)),
    saves: () => saves,
  };
}

const statusOf = (state: PaymentCandidateState, fingerprint: string) =>
  buildPaymentInbox([CARD, CARD_2, CANCEL], state, TODAY).items.find((i) => i.fingerprint === fingerprint)?.status;

/**
 * 후보함 taps 가계부에 입력 → sentAt stored + /input params. Returns what
 * /input parses from them, plus the store.
 */
function openFromInbox(item: PaymentInboxItem, state: PaymentCandidateState = {}) {
  const store = memoryIO(markCandidateSent(state, item.fingerprint, NOW - 1000));
  const params = inputPrefillToParams(item.prefill!, item.fingerprint);
  return { store, params, seed: parseInputRouteSeed(params, TODAY) };
}

export async function runCandidateAutoHandleCases(): Promise<{
  results: CaseResult[];
  passed: number;
  failed: number;
}> {
  const results: CaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  const items = buildPaymentInbox([CARD, CARD_2, CANCEL], {}, TODAY).items;
  const card = items.find((i) => i.candidate.merchantCandidate === '청계상회')!;
  const card2 = items.find((i) => i.candidate.merchantCandidate === '다이소')!;
  const cancel = items.find((i) => i.kind === 'card_cancellation')!;

  // ── route params ──────────────────────────────────────────────
  {
    const { params, seed } = openFromInbox(card);
    check(
      'ROUTE 1 후보 → /input carries the fingerprint next to the prefill',
      params.sourceCandidateId === card.fingerprint &&
        seed.sourceCandidateId === card.fingerprint &&
        seed.prefill?.amount === 5100 &&
        seed.prefill.type === 'expense',
      JSON.stringify(params),
    );
  }
  check(
    'ROUTE 2 plain manual /input (no params) → no source candidate',
    (() => {
      const seed = parseInputRouteSeed({}, TODAY);
      return seed.prefill === null && seed.sourceCandidateId === null;
    })(),
  );
  check(
    'ROUTE 3 edit mode (?id=…) ignores prefill AND source candidate',
    (() => {
      const seed = parseInputRouteSeed({ id: 'txn_1', ...inputPrefillToParams(card.prefill!, card.fingerprint) }, TODAY);
      return seed.prefill === null && seed.sourceCandidateId === null;
    })(),
  );
  check(
    'ROUTE 4 source candidate without a usable prefill is dropped',
    parseInputRouteSeed({ sourceCandidateId: card.fingerprint }, TODAY).sourceCandidateId === null &&
      parseInputRouteSeed({ prefillType: 'transfer', prefillAmount: '10', sourceCandidateId: card.fingerprint }, TODAY)
        .sourceCandidateId === null,
  );
  check(
    'ROUTE 5 malformed source candidate id → dropped, prefill kept',
    (() => {
      const bad = ['', 'pc1_', 'pc2_abc', 'pc1_ABC', 'pc1_a b', `pc1_${'a'.repeat(17)}`];
      return bad.every((id) => {
        const seed = parseInputRouteSeed({ prefillType: 'expense', prefillAmount: '10', sourceCandidateId: id }, TODAY);
        return seed.prefill?.amount === 10 && seed.sourceCandidateId === null;
      });
    })(),
  );
  check(
    'ROUTE 6 cancellation candidate has no prefill → no 입력 action at all',
    cancel.prefill === null,
  );

  // ── save outcomes ─────────────────────────────────────────────
  check(
    'SEMANTICS saved + queued count as saved; failed / queue-failed do not',
    isCreateSaved('saved') && isCreateSaved('queued') && !isCreateSaved('failed') && !isCreateSaved('queue-failed'),
  );
  {
    const { store, seed } = openFromInbox(card);
    const ok = await settleSourceCandidate(store.io, seed.sourceCandidateId, 'saved', NOW);
    check(
      'FLOW 1 후보 → input → online save ok → handled',
      ok && statusOf(store.read(), card.fingerprint) === 'handled' && store.read()[card.fingerprint].sentAt === NOW - 1000,
      JSON.stringify(store.read()),
    );
  }
  {
    const { store, seed } = openFromInbox(card);
    const ok = await settleSourceCandidate(store.io, seed.sourceCandidateId, 'queued', NOW);
    check(
      'FLOW 2 후보 → input → offline queue ok (form says 저장했어요) → handled',
      ok && statusOf(store.read(), card.fingerprint) === 'handled',
    );
  }
  for (const outcome of ['failed', 'queue-failed'] as CreateSaveOutcome[]) {
    const { store, seed } = openFromInbox(card);
    const before = JSON.stringify(store.read());
    const ok = await settleSourceCandidate(store.io, seed.sourceCandidateId, outcome, NOW);
    check(
      `FLOW 3 후보 → input → ${outcome} → pending, store untouched`,
      !ok && store.saves() === 0 && JSON.stringify(store.read()) === before && statusOf(store.read(), card.fingerprint) === 'pending',
    );
  }
  {
    // Validation failure / back / close: save() returns before any create,
    // so nothing is reported — the store keeps only the 보냄 mark.
    const { store } = openFromInbox(card);
    check(
      'FLOW 4 후보 → input → validation fail / 뒤로가기 → pending (sent only)',
      store.saves() === 0 &&
        statusOf(store.read(), card.fingerprint) === 'pending' &&
        store.read()[card.fingerprint].sentAt != null,
    );
  }
  {
    const store = memoryIO({ [card.fingerprint]: { sentAt: NOW - 1000 } });
    const before = JSON.stringify(store.read());
    const seed = parseInputRouteSeed({}, TODAY);
    const results2 = await Promise.all(
      (['saved', 'queued'] as CreateSaveOutcome[]).map((o) => settleSourceCandidate(store.io, seed.sourceCandidateId, o, NOW)),
    );
    check(
      'FLOW 5 plain manual save (online / queued) → candidate state unchanged',
      results2.every((r) => !r) && store.saves() === 0 && JSON.stringify(store.read()) === before,
    );
  }
  {
    const store = memoryIO({ [card.fingerprint]: { sentAt: NOW - 1000 } });
    const before = JSON.stringify(store.read());
    const seed = parseInputRouteSeed({ id: 'txn_1', ...inputPrefillToParams(card.prefill!, card.fingerprint) }, TODAY);
    const ok = await settleSourceCandidate(store.io, seed.sourceCandidateId, 'saved', NOW);
    check(
      'FLOW 6 edit-mode save → candidate state unchanged',
      !ok && store.saves() === 0 && JSON.stringify(store.read()) === before,
    );
  }
  {
    const { store, seed } = openFromInbox(card, markCandidateSent({}, card2.fingerprint, NOW - 5000));
    await settleSourceCandidate(store.io, seed.sourceCandidateId, 'saved', NOW);
    const s = store.read();
    check(
      'FLOW 7 only the source candidate is handled; other entries kept as-is',
      statusOf(s, card.fingerprint) === 'handled' &&
        statusOf(s, card2.fingerprint) === 'pending' &&
        s[card2.fingerprint].sentAt === NOW - 5000,
      JSON.stringify(s),
    );
  }

  // ── state update failures never throw ─────────────────────────
  for (const [label, fail] of [
    ['load throws', { load: true }],
    ['save throws', { save: true }],
  ] as const) {
    const { seed } = openFromInbox(card);
    const store = memoryIO({ [card.fingerprint]: { sentAt: NOW - 1000 } }, fail);
    let threw = false;
    let ok = true;
    try {
      ok = await settleSourceCandidate(store.io, seed.sourceCandidateId, 'saved', NOW);
    } catch {
      threw = true;
    }
    check(
      `FAIL ${label} → resolves false, no throw (the saved transaction is untouched), candidate stays pending`,
      !threw && !ok && statusOf(store.read(), card.fingerprint) === 'pending',
    );
  }
  {
    const empty = memoryIO(null);
    const ok = await markStoredCandidateHandled(empty.io, card.fingerprint, NOW);
    check('FAIL nothing stored / unreadable → no write (never overwrite with a near-empty map)', !ok && empty.saves() === 0);
  }
  {
    const store = memoryIO({ [card2.fingerprint]: { sentAt: NOW - 1000 } });
    const ok = await markStoredCandidateHandled(store.io, card.fingerprint, NOW);
    check(
      'GUARD unknown fingerprint (never sent from the 후보함) → no entry created',
      !ok && store.saves() === 0 && store.read()[card.fingerprint] === undefined,
    );
  }
  {
    const store = memoryIO({ [card.fingerprint]: { sentAt: NOW - 1000, handledAt: NOW - 500 } });
    const ok = await markStoredCandidateHandled(store.io, card.fingerprint, NOW);
    check(
      'IDEMPOTENT already handled (manual 처리 완료) → true, handledAt kept, no write',
      ok && store.saves() === 0 && store.read()[card.fingerprint].handledAt === NOW - 500,
    );
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed };
}
