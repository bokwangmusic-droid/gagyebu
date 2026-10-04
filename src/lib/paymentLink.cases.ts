/**
 * Dev verification for 결제수단 연결 BATCH — 신용/체크카드 구분 + 이체 출금 계좌.
 *
 * Same convention as the other *.cases.ts files: no test framework is set
 * up, so these are plain data + a runner. Nothing imports this file in the
 * app, so it is not bundled; `npx tsc --noEmit` still type-checks it.
 *
 * Covers the pure layers only (no Supabase call):
 *   - card.ts         : 체크카드 never counts toward the 예상 카드값 / 할부
 *   - card write map  : card_type on INSERT / UPDATE
 *   - txn write map   : card_id kept for 체크, source_asset_id only for 이체,
 *                       both cleared when the payment method changes
 *   - read mapping    : legacy rows (no card_type / no source_asset_id)
 *   - 체크카드 ↔ 계좌  : linked_asset_id on the card, copied into
 *                       source_asset_id when a 체크 purchase is saved
 *   - offline queue   : the UPDATE-confirmation checks see the new fields
 *   - asset balance   : nothing in the transaction path touches an asset
 */
import { describeAccount } from '@/lib/asset';
import { cardBillingForMonth, cardTypeOf, debitSourceAssetId } from '@/lib/card';
import { calculateTotalAssets } from '@/lib/netWorth';
import { serverCardConfirmsUpdate, serverRowConfirmsUpdate } from '@/lib/offlineQueue';
import { buildCardInsert, buildCardUpdate } from '@/lib/remoteCardWriteMapping';
import { mapRemoteFinanceToReadModel } from '@/lib/remoteFinanceMapping';
import {
  buildTransactionInsert,
  buildTransactionUpdate,
  type NewTransactionDraft,
} from '@/lib/remoteFinanceWriteMapping';
import {
  accountEntryLabel,
  accountTransactions,
  describePaymentLink,
  recurringTransactionLink,
} from '@/lib/paymentLink';
import {
  buildRecurringInsert,
  buildRecurringUpdate,
  isValidRecurringDraft,
  type NewRecurringDraft,
} from '@/lib/remoteRecurringWriteMapping';
import type { RemoteFinanceRaw, RemoteRecurringRule, RemoteTransaction } from '@/services/remoteFinance';
import type { Asset, CreditCard, PaymentMethod, Transaction } from '@/store/types';

export interface PaymentLinkCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const NOW = new Date(2026, 9, 15); // 2026-10-15
const ISO = new Date(2026, 9, 3, 12, 0, 0).toISOString();

const CREDIT: CreditCard = { id: 'card-credit', name: '현대카드', cardType: 'credit', createdAt: ISO };
const DEBIT: CreditCard = { id: 'card-debit', name: 'KB 노리 체크카드', cardType: 'debit', createdAt: ISO };
const LEGACY_CARD: CreditCard = { id: 'card-legacy', name: '삼성카드', createdAt: ISO }; // no cardType

const BANK: Asset = {
  id: 'asset-bank',
  name: '생활비통장',
  type: 'bank',
  institution: 'kb',
  balance: 2_000_000,
  createdAt: ISO,
};
const KNOWN_CARDS = new Set([CREDIT.id, DEBIT.id, LEGACY_CARD.id]);

function txn(over: Partial<Transaction>): Transaction {
  return { id: 't', type: 'expense', category: 'food', amount: 10_000, memo: '', date: ISO, ...over };
}

function draft(over: Partial<NewTransactionDraft>): NewTransactionDraft {
  return { type: 'expense', category: 'food', amount: 10_000, memo: '', date: ISO, ...over };
}

function rawTxn(over: Partial<RemoteTransaction>): RemoteTransaction {
  return {
    id: 'rt',
    type: 'expense',
    category: 'food',
    amount: 10_000,
    memo: '',
    date: ISO,
    from_recurring: null,
    from_planned: null,
    payment_method: null,
    card_id: null,
    source_asset_id: null,
    destination_asset_id: null,
    asset_balance_applied: false,
    installment_months: null,
    splits: null,
    tags: null,
    member_id: null,
    created_by: 'u1',
    updated_at: '2026-10-03T00:00:00.000000+00:00',
    ...over,
  };
}

function rawRuleDraft(): NewRecurringDraft {
  return {
    type: 'expense',
    name: 'r',
    amount: 1,
    category: 'subscribe',
    frequency: 'monthly',
    dayOfMonth: 1,
    dayOfWeek: null,
  };
}

function rawRule(over: Partial<RemoteRecurringRule>): RemoteRecurringRule {
  return {
    id: 'r',
    type: 'expense',
    name: 'r',
    amount: 10_000,
    category: 'subscribe',
    frequency: 'monthly',
    day_of_month: 10,
    day_of_week: null,
    active: true,
    last_run: null,
    payment_method: null,
    card_id: null,
    source_asset_id: null,
    destination_asset_id: null,
    created_at: ISO,
    created_by: 'u1',
    updated_at: 'x',
    ...over,
  };
}

export function runPaymentLinkCases(): {
  results: PaymentLinkCaseResult[];
  passed: number;
  failed: number;
} {
  const results: PaymentLinkCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

  /* ---- card type ---- */
  check('cardTypeOf · legacy card (no type) -> credit', cardTypeOf(LEGACY_CARD) === 'credit');
  check('cardTypeOf · debit', cardTypeOf(DEBIT) === 'debit');

  /* ---- A/B. billing: 신용 counted (incl. 할부), 체크 never ---- */
  {
    const txns = [
      txn({ id: 'c1', paymentMethod: 'credit', cardId: CREDIT.id, amount: 30_000 }),
      txn({ id: 'c2', paymentMethod: 'credit', cardId: CREDIT.id, amount: 90_000, installment: { months: 3 } }),
      txn({ id: 'd1', paymentMethod: 'debit', cardId: DEBIT.id, amount: 50_000 }),
      txn({ id: 'tr', paymentMethod: 'transfer', sourceAssetId: BANK.id, amount: 100_000 }),
    ];
    const b = cardBillingForMonth(txns, [CREDIT, DEBIT], NOW);
    check(
      '신용 일시불 + 할부 1회차만 예상 카드값, 체크·이체 제외',
      b.total === 60_000 && b.byCard[CREDIT.id] === 60_000 && b.byCard[DEBIT.id] === undefined && b.unassigned === 0,
      JSON.stringify(b),
    );
  }

  /* ---- card write mapping ---- */
  {
    const ctx = { id: 'card-1', householdId: 'hh' };
    check('card INSERT · no type -> credit (DB default meaning)', buildCardInsert({ name: 'a' }, ctx).card_type === 'credit');
    check('card INSERT · debit', buildCardInsert({ name: 'a', cardType: 'debit' }, ctx).card_type === 'debit');
    check('card UPDATE · debit sent', buildCardUpdate({ name: 'a', cardType: 'debit' }).card_type === 'debit');
    check(
      'card UPDATE · draft without type omits card_type (stored type kept)',
      !('card_type' in buildCardUpdate({ name: 'a' })),
    );
  }

  /* ---- transaction write mapping ---- */
  {
    const ins = (d: NewTransactionDraft) =>
      buildTransactionInsert(d, { id: 'txn-1', householdId: 'hh', knownCardIds: KNOWN_CARDS });
    const upd = (d: NewTransactionDraft, originalRawCardId: string | null = null) =>
      buildTransactionUpdate(d, { knownCardIds: KNOWN_CARDS, originalRawCardId });

    const a = ins(draft({ paymentMethod: 'credit', cardId: CREDIT.id, installment: { months: 3 } }));
    check('INSERT 신용 · card + 할부 kept, no account', a.card_id === CREDIT.id && a.installment_months === 3 && a.source_asset_id === null);

    const b = ins(draft({ paymentMethod: 'debit', cardId: DEBIT.id }));
    check('INSERT 체크 · card kept, no 할부, no account', b.card_id === DEBIT.id && b.installment_months === null && b.source_asset_id === null);

    const c = ins(draft({ paymentMethod: 'transfer', sourceAssetId: BANK.id }));
    check('INSERT 이체 · 출금 계좌 kept, no card', c.source_asset_id === BANK.id && c.card_id === null && c.payment_method === 'transfer');

    const d = ins(draft({ paymentMethod: 'cash', sourceAssetId: BANK.id }));
    check('INSERT 현금 · stray sourceAssetId never written', d.source_asset_id === null);

    const e = upd(draft({ paymentMethod: 'debit', cardId: DEBIT.id }));
    check('UPDATE 체크 · card kept (rule A no longer clears 체크)', e.card_id === DEBIT.id);

    const f = upd(draft({ paymentMethod: 'cash' }), CREDIT.id);
    check('E. UPDATE 신용 -> 현금 · card_id cleared', 'card_id' in f && f.card_id === null && f.source_asset_id === null);

    const g = upd(draft({ paymentMethod: 'cash' }));
    check('E. UPDATE 이체 -> 현금 · source_asset_id cleared', g.source_asset_id === null);

    const h = upd(draft({ paymentMethod: 'transfer', sourceAssetId: 'asset-soft-deleted' }));
    check('UPDATE 이체 · a soft-deleted 계좌 carried through unchanged', h.source_asset_id === 'asset-soft-deleted');

    const i = upd(draft({ paymentMethod: 'debit' }), 'card-soft-deleted');
    check('UPDATE 체크 · dangling soft-deleted card link preserved (card_id omitted)', !('card_id' in i));

    const j = upd(draft({ paymentMethod: 'transfer', cardId: CREDIT.id, sourceAssetId: BANK.id }), CREDIT.id);
    check('E. UPDATE 신용 -> 이체 · card cleared, account set', j.card_id === null && j.source_asset_id === BANK.id);
  }

  /* ---- D. read mapping: legacy rows ---- */
  {
    const raw: RemoteFinanceRaw = {
      customCategories: [],
      cards: [
        {
          id: LEGACY_CARD.id,
          name: '삼성카드',
          card_type: 'credit', // what the migration default gives an existing card
          linked_asset_id: null,
          color_bg: null,
          color_fg: null,
          payment_day: null,
          closing_day: null,
          created_at: ISO,
          created_by: 'u1',
          updated_at: 'x',
        },
        {
          id: DEBIT.id,
          name: DEBIT.name,
          card_type: 'debit',
          linked_asset_id: 'asset-bank',
          color_bg: null,
          color_fg: null,
          payment_day: null,
          closing_day: null,
          created_at: ISO,
          created_by: 'u1',
          updated_at: 'x',
        },
      ],
      recurringRules: [],
      plannedExpenses: [],
      goals: [],
      loans: [],
      loanPayments: [],
      assets: [],
      transactions: [
        rawTxn({ id: 'legacy-plain' }),
        rawTxn({ id: 'legacy-credit', payment_method: 'credit', card_id: LEGACY_CARD.id }),
        rawTxn({ id: 'legacy-transfer', payment_method: 'transfer' }),
        rawTxn({ id: 'new-transfer', payment_method: 'transfer', source_asset_id: 'asset-gone' }),
        rawTxn({ id: 'new-debit', payment_method: 'debit', card_id: DEBIT.id }),
      ],
      budgets: [],
      householdSettings: null,
      goalMovementsCount: 0,
    };
    const m = mapRemoteFinanceToReadModel(raw);
    const byId = (id: string) => m.transactions.find((t) => t.id === id);
    check('read · existing card -> 신용카드', m.cards.find((c) => c.id === LEGACY_CARD.id)?.cardType === 'credit');
    check('read · debit card', m.cards.find((c) => c.id === DEBIT.id)?.cardType === 'debit');
    check(
      'D. read · legacy rows map with no card / no account',
      byId('legacy-plain')?.sourceAssetId === undefined &&
        byId('legacy-transfer')?.paymentMethod === 'transfer' &&
        byId('legacy-transfer')?.sourceAssetId === undefined &&
        byId('legacy-credit')?.cardId === LEGACY_CARD.id,
    );
    check('read · 출금 계좌 kept even when the asset is gone', byId('new-transfer')?.sourceAssetId === 'asset-gone');
    check('read · 체크 transaction keeps its card', byId('new-debit')?.cardId === DEBIT.id);
    check(
      'read · 체크카드 linked account mapped; legacy 신용카드 has none',
      m.cards.find((c) => c.id === DEBIT.id)?.linkedAssetId === 'asset-bank' &&
        m.cards.find((c) => c.id === LEGACY_CARD.id)?.linkedAssetId === undefined,
    );
    // The account this snapshot links to is NOT in `assets` (soft-deleted):
    // the card still maps, and the UI fallback label is used — no crash.
    const deletedLinkCard = m.cards.find((c) => c.id === DEBIT.id)!;
    const linkedRow = m.assets.find((a) => a.id === debitSourceAssetId(deletedLinkCard));
    check(
      '계좌 삭제 · card + transactions still map; 출금 계좌 label falls back',
      !linkedRow && m.transactions.length === 5 && (linkedRow ? describeAccount(linkedRow) : '삭제된 계좌') === '삭제된 계좌',
    );
  }

  /* ---- 체크카드 ↔ 은행계좌 연결 ---- */
  {
    const ctx = { id: 'card-2', householdId: 'hh' };
    const ins = buildCardInsert({ name: 'KB 노리', cardType: 'debit', linkedAssetId: BANK.id }, ctx);
    check('체크카드 + bank 연결 저장 (INSERT)', ins.card_type === 'debit' && ins.linked_asset_id === BANK.id);

    const credit = buildCardInsert({ name: '현대', cardType: 'credit', linkedAssetId: BANK.id }, ctx);
    check('신용카드에는 linked account 없음 (stray id -> NULL)', credit.linked_asset_id === null);

    const keep = buildCardUpdate({ name: 'KB 노리 (이름만 수정)', cardType: 'debit', linkedAssetId: BANK.id });
    check('체크카드 수정 시 연결 계좌 유지', keep.linked_asset_id === BANK.id);

    const toCredit = buildCardUpdate({ name: 'x', cardType: 'credit', linkedAssetId: BANK.id });
    check('체크 -> 신용 변경 시 연결 해제', toCredit.card_type === 'credit' && toCredit.linked_asset_id === null);

    const unlink = buildCardUpdate({ name: 'x', cardType: 'debit' });
    check('체크카드 「연결 안 함」 -> NULL', unlink.linked_asset_id === null);

    const legacyDraft = buildCardUpdate({ name: 'x' });
    check(
      '타입 없는 (구버전 대기열) 카드 draft -> card_type / linked_asset_id 둘 다 생략',
      !('card_type' in legacyDraft) && !('linked_asset_id' in legacyDraft),
    );

    check(
      'debitSourceAssetId · 체크 -> 연결 계좌, 신용/미연결 -> 없음',
      debitSourceAssetId({ cardType: 'debit', linkedAssetId: BANK.id }) === BANK.id &&
        debitSourceAssetId({ cardType: 'credit', linkedAssetId: BANK.id }) === undefined &&
        debitSourceAssetId({ cardType: 'debit' }) === undefined &&
        debitSourceAssetId(undefined) === undefined,
    );

    // Debit purchase: the form copies the card's account into the draft.
    const tIns = (d: NewTransactionDraft) =>
      buildTransactionInsert(d, { id: 'txn-9', householdId: 'hh', knownCardIds: KNOWN_CARDS });
    const cardV1: CreditCard = { ...DEBIT, linkedAssetId: 'asset-kb' };
    const txn1 = tIns(draft({ paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: debitSourceAssetId(cardV1) }));
    check('체크 거래 생성 시 source_asset_id 자동 기록', txn1.card_id === DEBIT.id && txn1.source_asset_id === 'asset-kb');

    // The card is re-linked to a different account.
    const relinked = buildCardUpdate({ name: DEBIT.name, cardType: 'debit', linkedAssetId: 'asset-kakao' });
    const cardV2: CreditCard = { ...DEBIT, linkedAssetId: relinked.linked_asset_id ?? undefined };
    // Editing the OLD transaction (e.g. its memo) carries its stored account.
    const oldEdit = buildTransactionUpdate(
      draft({ paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: txn1.source_asset_id ?? undefined, memo: '메모 수정' }),
      { knownCardIds: KNOWN_CARDS, originalRawCardId: DEBIT.id },
    );
    check('카드 연결 계좌 변경 후 과거 거래 source_asset_id 불변', oldEdit.source_asset_id === 'asset-kb');
    const txn2 = tIns(draft({ paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: debitSourceAssetId(cardV2) }));
    check('새 거래는 변경된 계좌 사용', txn2.source_asset_id === 'asset-kakao');

    // A future recurring materializer builds its draft through the SAME
    // helper (recurring_rules has no card link yet — see report).
    const materialized = tIns(
      draft({ paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: debitSourceAssetId(cardV2), memo: '넷플릭스' }),
    );
    check(
      '반복 debit materialize 계약 · 카드 + 출금계좌 둘 다 기록',
      materialized.payment_method === 'debit' && materialized.card_id === DEBIT.id && materialized.source_asset_id === 'asset-kakao',
    );

    const debitToCash = buildTransactionUpdate(draft({ paymentMethod: 'cash', sourceAssetId: 'asset-kb' }), {
      knownCardIds: KNOWN_CARDS,
    });
    check('체크 -> 현금 변경 시 source_asset_id 해제', debitToCash.source_asset_id === null && debitToCash.card_id === null);

    check(
      'queue · 체크카드 연결 계좌까지 확인',
      serverCardConfirmsUpdate(cardV2, { name: DEBIT.name, cardType: 'debit', linkedAssetId: 'asset-kakao' }) &&
        !serverCardConfirmsUpdate(cardV2, { name: DEBIT.name, cardType: 'debit', linkedAssetId: 'asset-kb' }),
    );
    check(
      'queue · 체크 거래의 출금 계좌 확인',
      serverRowConfirmsUpdate(
        txn({ paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: 'asset-kb' }),
        draft({ paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: 'asset-kb' }),
        KNOWN_CARDS,
      ),
    );

    // 어떤 경우에도 assets.balance 변화 없음: none of these rows names a balance.
    const allRows = [ins, credit, keep, toCredit, unlink, relinked, txn1, oldEdit, txn2, materialized, debitToCash];
    check(
      '어떤 카드/거래 write에도 balance 필드 없음',
      allRows.every((r) => !Object.keys(r).some((k) => k.includes('balance'))) && BANK.balance === 2_000_000,
    );
  }

  /* ---- offline-queue UPDATE confirmation sees the new fields ---- */
  {
    const d = draft({ paymentMethod: 'transfer', sourceAssetId: BANK.id });
    check(
      'queue · confirm when server row has the same 출금 계좌',
      serverRowConfirmsUpdate(txn({ paymentMethod: 'transfer', sourceAssetId: BANK.id }), d, KNOWN_CARDS),
    );
    check(
      'queue · NOT confirmed when the 출금 계좌 differs',
      !serverRowConfirmsUpdate(txn({ paymentMethod: 'transfer', sourceAssetId: 'other' }), d, KNOWN_CARDS),
    );
    check(
      'queue · card confirm checks the type when the draft has one',
      serverCardConfirmsUpdate({ ...DEBIT }, { name: DEBIT.name, cardType: 'debit' }) &&
        !serverCardConfirmsUpdate({ ...DEBIT }, { name: DEBIT.name, cardType: 'credit' }) &&
        serverCardConfirmsUpdate({ ...DEBIT }, { name: DEBIT.name }),
    );
  }

  /* ---- F. asset balance is never derived from transactions ---- */
  {
    const assets = [BANK];
    const before = calculateTotalAssets(assets);
    // Build every write row a 체크/이체 save would send; none of them names an
    // asset balance, and the asset objects themselves are untouched.
    const rows = [
      buildTransactionInsert(draft({ paymentMethod: 'transfer', sourceAssetId: BANK.id, amount: 100_000 }), {
        id: 'x',
        householdId: 'hh',
        knownCardIds: KNOWN_CARDS,
      }),
      buildTransactionUpdate(draft({ paymentMethod: 'debit', cardId: DEBIT.id }), { knownCardIds: KNOWN_CARDS }),
    ];
    const touchesBalance = rows.some((r) => Object.keys(r).some((k) => k.includes('balance')));
    check(
      'F. 체크/이체 writes carry no balance field; 총자산 unchanged',
      !touchesBalance && calculateTotalAssets(assets) === before && BANK.balance === 2_000_000,
    );
  }

  /* ================================================================ *
   * 수입 입금처 + 반복 규칙 결제수단/입금처
   * ================================================================ */
  {
    const tIns = (d: NewTransactionDraft) =>
      buildTransactionInsert(d, { id: 'txn-i', householdId: 'hh', knownCardIds: KNOWN_CARDS });
    const tUpd = (d: NewTransactionDraft) => buildTransactionUpdate(d, { knownCardIds: KNOWN_CARDS });

    // --- 일반 income ---
    const cashIn = tIns(draft({ type: 'income', category: 'salary', paymentMethod: 'cash' }));
    check('income · 현금 -> payment_method cash, no asset', cashIn.payment_method === 'cash' && cashIn.destination_asset_id === null);

    const bankIn = tIns(draft({ type: 'income', category: 'salary', paymentMethod: 'transfer', destinationAssetId: BANK.id }));
    check(
      'income · bank 입금처 -> transfer + destination_asset_id, no expense links',
      bankIn.payment_method === 'transfer' &&
        bankIn.destination_asset_id === BANK.id &&
        bankIn.source_asset_id === null &&
        bankIn.card_id === null,
    );

    const legacyIn = tIns(draft({ type: 'income', category: 'salary' }));
    check('income · legacy (입금처 없음) still saves, all links NULL', legacyIn.payment_method === null && legacyIn.destination_asset_id === null);

    const strayIncome = tIns(
      draft({ type: 'income', paymentMethod: 'credit', cardId: CREDIT.id, installment: undefined, sourceAssetId: BANK.id }),
    );
    check(
      'income · 신용/체크/카드/출금 계좌 never stored',
      strayIncome.payment_method === null && strayIncome.card_id === null && strayIncome.source_asset_id === null,
    );

    // --- income <-> expense ---
    const expToInc = tUpd(draft({ type: 'income', paymentMethod: 'transfer', destinationAssetId: BANK.id, cardId: DEBIT.id, sourceAssetId: 'asset-kb' }));
    check(
      'expense -> income · card / source cleared, 입금처 kept',
      expToInc.card_id === null && expToInc.source_asset_id === null && expToInc.destination_asset_id === BANK.id,
    );
    const incToExp = tUpd(draft({ type: 'expense', paymentMethod: 'cash', destinationAssetId: BANK.id }));
    check('income -> expense · destination_asset_id cleared', incToExp.destination_asset_id === null && incToExp.payment_method === 'cash');
    const expTransferDest = tIns(draft({ type: 'expense', paymentMethod: 'transfer', sourceAssetId: BANK.id, destinationAssetId: 'x' }));
    check('expense 이체 · destination never stored', expTransferDest.destination_asset_id === null && expTransferDest.source_asset_id === BANK.id);

    // --- recurring expense: 5 methods ---
    const rIns = (d: Partial<NewRecurringDraft>) =>
      buildRecurringInsert(
        {
          type: 'expense',
          name: 'r',
          amount: 10_000,
          category: 'subscribe',
          frequency: 'monthly',
          dayOfMonth: 10,
          dayOfWeek: null,
          ...d,
        },
        { id: 'rec-1', householdId: 'hh' },
      );
    const rCash = rIns({ paymentMethod: 'cash' });
    check('recurring expense · cash', rCash.payment_method === 'cash' && rCash.card_id === null && rCash.source_asset_id === null);
    const rDebit = rIns({ paymentMethod: 'debit', cardId: DEBIT.id });
    check(
      'recurring expense · debit -> card only (no account snapshot on the rule)',
      rDebit.payment_method === 'debit' && rDebit.card_id === DEBIT.id && rDebit.source_asset_id === null,
    );
    const rCredit = rIns({ paymentMethod: 'credit', cardId: CREDIT.id });
    check('recurring expense · credit -> card_id', rCredit.payment_method === 'credit' && rCredit.card_id === CREDIT.id);
    const rTransfer = rIns({ paymentMethod: 'transfer', sourceAssetId: BANK.id });
    check('recurring expense · transfer -> source_asset_id', rTransfer.source_asset_id === BANK.id && rTransfer.card_id === null);
    const rOther = rIns({ paymentMethod: 'other', cardId: CREDIT.id, sourceAssetId: BANK.id });
    check('recurring expense · other -> no links', rOther.payment_method === 'other' && rOther.card_id === null && rOther.source_asset_id === null);

    // --- recurring income ---
    const rInCash = rIns({ type: 'income', category: 'salary', paymentMethod: 'cash' });
    check('recurring income · cash', rInCash.payment_method === 'cash' && rInCash.destination_asset_id === null);
    const rInBank = rIns({ type: 'income', category: 'salary', paymentMethod: 'transfer', destinationAssetId: BANK.id });
    check('recurring income · bank destination', rInBank.payment_method === 'transfer' && rInBank.destination_asset_id === BANK.id);

    // --- legacy recurring ---
    const rLegacy = rIns({});
    check(
      'legacy recurring (no link) -> all four columns NULL',
      rLegacy.payment_method === null && rLegacy.card_id === null && rLegacy.source_asset_id === null && rLegacy.destination_asset_id === null,
    );
    const legacyUpdate = buildRecurringUpdate({
      type: 'expense',
      name: 'r',
      amount: 1,
      category: 'subscribe',
      frequency: 'monthly',
      dayOfMonth: 1,
      dayOfWeek: null,
    });
    check('legacy queued recurring UPDATE (no paymentMethod key) -> link columns omitted', !('payment_method' in legacyUpdate));
    const clearUpdate = buildRecurringUpdate({
      type: 'expense',
      name: 'r',
      amount: 1,
      category: 'subscribe',
      frequency: 'monthly',
      dayOfMonth: 1,
      dayOfWeek: null,
      paymentMethod: null,
    });
    check('recurring 「선택 안 함」 -> all four sent as NULL', clearUpdate.payment_method === null && clearUpdate.card_id === null);
    check(
      'recurring validator · bad method rejected, link-less draft accepted',
      !isValidRecurringDraft({ ...rawRuleDraft(), paymentMethod: 'bitcoin' as unknown as PaymentMethod }) &&
        isValidRecurringDraft(rawRuleDraft()),
    );

    // --- recurring read mapping + display (incl. deleted card / account) ---
    const m = mapRemoteFinanceToReadModel({
      customCategories: [],
      cards: [],
      recurringRules: [
        rawRule({ id: 'r-legacy' }),
        rawRule({ id: 'r-credit', payment_method: 'credit', card_id: 'card-gone' }),
        rawRule({ id: 'r-transfer', payment_method: 'transfer', source_asset_id: 'asset-gone' }),
        rawRule({ id: 'r-salary', type: 'income', payment_method: 'transfer', destination_asset_id: BANK.id }),
        rawRule({ id: 'r-stale', type: 'income', payment_method: 'credit', card_id: CREDIT.id }),
      ],
      plannedExpenses: [],
      goals: [],
      loans: [],
      loanPayments: [],
      assets: [],
      transactions: [],
      budgets: [],
      householdSettings: null,
      goalMovementsCount: 0,
    });
    const rr = (id: string) => m.recurring.find((r) => r.id === id)!;
    check(
      'read · legacy rule has no link fields',
      rr('r-legacy').paymentMethod === undefined && rr('r-legacy').cardId === undefined && rr('r-legacy').destinationAssetId === undefined,
    );
    check('read · income rule with a stale card link -> dropped', rr('r-stale').paymentMethod === undefined && rr('r-stale').cardId === undefined);
    check(
      '삭제 fallback · deleted card / account read as 삭제된 카드 / 삭제된 계좌',
      describePaymentLink('expense', rr('r-credit'), [], [BANK]) === '신용카드 · 삭제된 카드' &&
        describePaymentLink('expense', rr('r-transfer'), [], [BANK]) === '이체 · 삭제된 계좌',
    );
    check(
      'display · 반복 목록 1줄 예시',
      describePaymentLink('income', rr('r-salary'), [], [BANK]) === '입금 · KB국민은행 · 생활비통장' &&
        describePaymentLink('expense', { paymentMethod: 'credit', cardId: CREDIT.id }, [CREDIT], []) === '신용카드 · 현대카드' &&
        describePaymentLink('expense', { paymentMethod: 'debit', cardId: DEBIT.id }, [DEBIT], []) === '체크카드 · KB 노리 체크카드' &&
        describePaymentLink('income', { paymentMethod: 'cash' }, [], []) === '입금 · 현금' &&
        describePaymentLink('expense', {}, [], []) === '',
    );

    // --- future materializer hand-off (no materializer is built) ---
    const debitRule = { type: 'expense' as const, paymentMethod: 'debit' as const, cardId: DEBIT.id };
    const linkNow = recurringTransactionLink(debitRule, [{ ...DEBIT, linkedAssetId: 'asset-kb' }]);
    const linkLater = recurringTransactionLink(debitRule, [{ ...DEBIT, linkedAssetId: 'asset-kakao' }]);
    check(
      'rule -> transaction link · 체크카드 account resolved at creation time',
      linkNow.cardId === DEBIT.id && linkNow.sourceAssetId === 'asset-kb' && linkLater.sourceAssetId === 'asset-kakao',
    );
    check(
      'rule -> transaction link · income 입금처 copied 1:1',
      recurringTransactionLink({ type: 'income', paymentMethod: 'transfer', destinationAssetId: BANK.id }, []).destinationAssetId === BANK.id,
    );

    // --- offline queue confirmation sees 입금처 ---
    check(
      'queue · income 입금처 compared on confirm',
      serverRowConfirmsUpdate(
        txn({ type: 'income', paymentMethod: 'transfer', destinationAssetId: BANK.id }),
        draft({ type: 'income', paymentMethod: 'transfer', destinationAssetId: BANK.id }),
        KNOWN_CARDS,
      ) &&
        !serverRowConfirmsUpdate(
          txn({ type: 'income', paymentMethod: 'transfer', destinationAssetId: 'other' }),
          draft({ type: 'income', paymentMethod: 'transfer', destinationAssetId: BANK.id }),
          KNOWN_CARDS,
        ),
    );

    // --- assets.balance never touched ---
    const rows: object[] = [cashIn, bankIn, expToInc, incToExp, rCash, rDebit, rCredit, rTransfer, rOther, rInCash, rInBank, clearUpdate];
    check(
      '수입/반복 writes carry no balance field',
      rows.every((r) => !Object.keys(r).some((k) => k.includes('balance'))) && BANK.balance === 2_000_000,
    );
  }

  /* ================================================================ *
   * 계좌 상세 / 입출금 내역 (accountTransactions)
   * ================================================================ */
  {
    const A = 'asset-a';
    const B = 'asset-b';
    const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();
    const base: Transaction[] = [
      txn({ id: 'debit-a', date: at(4), memo: '스타벅스', amount: 5_500, paymentMethod: 'debit', cardId: DEBIT.id, sourceAssetId: A }),
      txn({ id: 'salary-a', date: at(3), type: 'income', category: 'salary', memo: '월급', amount: 3_000_000, paymentMethod: 'transfer', destinationAssetId: A }),
      txn({ id: 'transfer-a', date: at(2), memo: '관리비', amount: 180_000, paymentMethod: 'transfer', sourceAssetId: A }),
      txn({ id: 'transfer-b', date: at(5), memo: '다른 통장', paymentMethod: 'transfer', sourceAssetId: B }),
      txn({ id: 'legacy', date: at(6), paymentMethod: 'transfer' }), // source NULL
      txn({ id: 'legacy-income', date: at(6), type: 'income', category: 'salary' }), // destination NULL
      txn({ id: 'credit-stray', date: at(7), paymentMethod: 'credit', cardId: CREDIT.id, sourceAssetId: A }), // not a 계좌 출금
      txn({ id: 'cash-income-stray', date: at(7), type: 'income', category: 'salary', paymentMethod: 'cash', destinationAssetId: A }),
    ];
    const aRows = accountTransactions(base, A);
    check(
      '계좌 A · 체크/이체 출금 + 계좌 입금만, 최신순',
      JSON.stringify(aRows.map((e) => [e.transaction.id, e.direction])) ===
        JSON.stringify([
          ['debit-a', 'out'],
          ['salary-a', 'in'],
          ['transfer-a', 'out'],
        ]),
      JSON.stringify(aRows.map((e) => e.transaction.id)),
    );
    check('다른 은행계좌 거래 섞이지 않음', accountTransactions(base, B).map((e) => e.transaction.id).join() === 'transfer-b');
    check(
      'legacy source/destination NULL 거래는 어느 계좌에도 안 나옴 (오류 없음)',
      !aRows.some((e) => e.transaction.id.startsWith('legacy')) && accountTransactions(base, 'asset-none').length === 0,
    );
    check(
      '표시 라벨 · 체크카드 · 카드명 / 이체 / 입금',
      accountEntryLabel(aRows[0], [DEBIT]) === '체크카드 · KB 노리 체크카드' &&
        accountEntryLabel(aRows[1], [DEBIT]) === '입금' &&
        accountEntryLabel(aRows[2], [DEBIT]) === '이체',
    );
    check('삭제된 체크카드 (read model이 cardId 제거) -> "체크카드"', accountEntryLabel({ transaction: txn({ paymentMethod: 'debit', sourceAssetId: A }), direction: 'out' }, []) === '체크카드');

    // 거래 수정: 출금 계좌 A -> B. Derived, so the next run moves it.
    const edited = base.map((t) => (t.id === 'debit-a' ? { ...t, sourceAssetId: B } : t));
    check(
      '거래 수정 후 계좌 이동 반영 (A에서 사라지고 B에 나타남)',
      !accountTransactions(edited, A).some((e) => e.transaction.id === 'debit-a') &&
        accountTransactions(edited, B).some((e) => e.transaction.id === 'debit-a'),
    );
    // 거래 삭제: a soft-deleted row is no longer in the read model's array.
    const deleted = base.filter((t) => t.id !== 'transfer-a');
    check('거래 삭제 후 계좌 내역에서 사라짐', !accountTransactions(deleted, A).some((e) => e.transaction.id === 'transfer-a'));

    const assetsBefore: Asset[] = [{ ...BANK, id: A }];
    const snapshot = JSON.stringify(assetsBefore);
    accountTransactions(base, A);
    check('계좌 내역 계산은 assets/balance를 바꾸지 않음', JSON.stringify(assetsBefore) === snapshot);
  }

  /* ---- account label ---- */
  check('describeAccount · institution + name', describeAccount(BANK) === 'KB국민은행 · 생활비통장');
  check(
    'describeAccount · 기타/없는 기관 -> name only',
    describeAccount({ ...BANK, institution: 'other' }) === '생활비통장' &&
      describeAccount({ ...BANK, institution: undefined }) === '생활비통장',
  );

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
