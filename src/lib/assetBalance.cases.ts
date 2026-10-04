/**
 * Dev verification for 계좌 잔액 자동 반영 (20261004001900_asset_balance_sync.sql).
 *
 * Same convention as the other *.cases.ts files (plain data + a runner,
 * not bundled, type-checked by `tsc --noEmit`). The SQL trigger can't run
 * here (no local Postgres), so these cases pin down its rule through the
 * TypeScript mirror in src/lib/assetBalance.ts — the trigger implements the
 * identical OLD/NEW effect arithmetic, flag and soft-delete handling.
 */
import {
  applyTransactionChange,
  pendingAssetBalanceDeltas,
  signedBalance,
  transactionBalanceEffect,
  type BalanceTxn,
  type PendingTransactionOpLike,
} from '@/lib/assetBalance';
import { debitSourceAssetId } from '@/lib/card';
import { fmt } from '@/lib/format';
import type { PendingWrite } from '@/lib/offlineQueue';
import { serverRowConfirmsUpdate } from '@/lib/offlineQueue';
import { buildCardInsert } from '@/lib/remoteCardWriteMapping';
import {
  buildTransactionInsert,
  buildTransactionUpdate,
  type NewTransactionDraft,
} from '@/lib/remoteFinanceWriteMapping';
import type { CreditCard, Transaction } from '@/store/types';

export interface AssetBalanceCaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

// Compile-time guarantee: the offline queue has NO asset-balance op kind, so
// a transaction replay can never be paired with a second "balance" write.
type AssetEntityInQueue = Extract<PendingWrite['entity'], 'asset' | 'assetBalance'>;
const NO_ASSET_QUEUE_ENTITY: [AssetEntityInQueue] extends [never] ? true : false = true;

const A = 'asset-a';
const B = 'asset-b';
const ISO = new Date(2026, 9, 4, 12).toISOString();

const debit = (amount: number, asset = A): BalanceTxn => ({
  type: 'expense',
  amount,
  paymentMethod: 'debit',
  sourceAssetId: asset,
  applied: true,
});
const income = (amount: number, asset = A): BalanceTxn => ({
  type: 'income',
  amount,
  paymentMethod: 'transfer',
  destinationAssetId: asset,
  applied: true,
});

const start = () =>
  new Map<string, number>([
    [A, 2_000_000],
    [B, 1_000_000],
  ]);

export function runAssetBalanceCases(): { results: AssetBalanceCaseResult[]; passed: number; failed: number } {
  const results: AssetBalanceCaseResult[] = [];
  const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
  const bal = (m: Map<string, number>) => `A=${m.get(A)} B=${m.get(B)}`;

  check('queue has no asset/balance op entity (compile-time)', NO_ASSET_QUEUE_ENTITY);

  /* ---- C. 잔액 규칙 ---- */
  {
    // 체크카드 10,000 -> 15,000 -> 삭제 (요청 시나리오 그대로)
    let m = applyTransactionChange(start(), null, debit(10_000));
    check('expense insert · 2,000,000 -> 1,990,000', m.get(A) === 1_990_000, bal(m));
    m = applyTransactionChange(m, debit(10_000), debit(15_000));
    check('amount update · 1,990,000 -> 1,985,000 (not 1,975,000)', m.get(A) === 1_985_000, bal(m));
    m = applyTransactionChange(m, debit(15_000), null);
    check('delete · 1,985,000 -> 2,000,000', m.get(A) === 2_000_000, bal(m));
  }
  {
    let m = applyTransactionChange(start(), null, debit(10_000, A));
    m = applyTransactionChange(m, debit(10_000, A), debit(10_000, B));
    check('source account A -> B · A restored, B charged', m.get(A) === 2_000_000 && m.get(B) === 990_000, bal(m));
  }
  {
    let m = applyTransactionChange(start(), null, income(500_000));
    check('income insert · +500,000', m.get(A) === 2_500_000, bal(m));
    m = applyTransactionChange(m, income(500_000, A), income(500_000, B));
    check('destination account A -> B', m.get(A) === 2_000_000 && m.get(B) === 1_500_000, bal(m));
    m = applyTransactionChange(m, income(500_000, B), { ...income(500_000, B), deleted: true });
    check('income soft delete · reverted', m.get(B) === 1_000_000, bal(m));
  }
  {
    // 시나리오: 체크 -10,000, 이체 -20,000, 월급 +500,000
    let m = applyTransactionChange(start(), null, debit(10_000));
    m = applyTransactionChange(m, null, { type: 'expense', amount: 20_000, paymentMethod: 'transfer', sourceAssetId: A, applied: true });
    m = applyTransactionChange(m, null, income(500_000));
    check('예시 · 2,000,000 -> 1,990,000 -> 1,970,000 -> 2,470,000', m.get(A) === 2_470_000, bal(m));
  }
  {
    const live = debit(10_000);
    const gone = { ...live, deleted: true };
    let m = applyTransactionChange(start(), null, live);
    m = applyTransactionChange(m, live, gone);
    check('soft delete (active -> deleted) · reverted', m.get(A) === 2_000_000, bal(m));
    m = applyTransactionChange(m, gone, live);
    check('restore (deleted -> active) · re-applied', m.get(A) === 1_990_000, bal(m));
    const before = new Map(m);
    m = applyTransactionChange(m, gone, { ...gone, amount: 99_999 });
    check('deleted row edited · no change', m.get(A) === before.get(A), bal(m));
  }
  {
    const t = debit(10_000);
    let m = applyTransactionChange(start(), null, t);
    m = applyTransactionChange(m, t, { ...t }); // same PATCH replayed / memo edit
    m = applyTransactionChange(m, t, { ...t });
    check('no-op retry/update · charged exactly once', m.get(A) === 1_990_000, bal(m));
  }
  {
    // expense -> income type change on the same account
    let m = applyTransactionChange(start(), null, debit(10_000));
    m = applyTransactionChange(m, debit(10_000), income(10_000));
    check('type change expense -> income · -10,000 reverted, +10,000 applied', m.get(A) === 2_010_000, bal(m));
  }
  {
    const credit: BalanceTxn = { type: 'expense', amount: 50_000, paymentMethod: 'credit', sourceAssetId: A, applied: true };
    const cash: BalanceTxn = { type: 'expense', amount: 50_000, paymentMethod: 'cash', applied: true };
    const cashIncome: BalanceTxn = { type: 'income', amount: 50_000, paymentMethod: 'cash', destinationAssetId: A, applied: true };
    check(
      '신용카드 / 현금 / 현금 수입 · never move a balance',
      transactionBalanceEffect(credit) === null && transactionBalanceEffect(cash) === null && transactionBalanceEffect(cashIncome) === null,
    );
  }
  {
    // Pre-migration rows (asset_balance_applied = false) never count.
    const legacy: BalanceTxn = { ...debit(10_000), applied: false };
    let m = applyTransactionChange(start(), legacy, { ...legacy, amount: 15_000 });
    m = applyTransactionChange(m, legacy, null);
    m = applyTransactionChange(m, legacy, { ...legacy, deleted: true });
    check('legacy (pre-migration) row · edit/delete/soft-delete never touch balances', m.get(A) === 2_000_000, bal(m));
  }
  {
    const m = applyTransactionChange(new Map([[A, 5_000]]), null, debit(10_000));
    check('overspend · balance goes negative (CHECK dropped) instead of failing', m.get(A) === -5_000, bal(m));
    check('signed label · −5,000', signedBalance(-5_000, fmt) === '−5,000' && signedBalance(5_000, fmt) === '5,000');
  }

  /* ---- A. 체크카드 연결 ---- */
  {
    const linked: CreditCard = { id: 'card-d', name: '국민체크', cardType: 'debit', linkedAssetId: A, createdAt: ISO };
    const ins = buildCardInsert({ name: '국민체크', cardType: 'debit', linkedAssetId: A }, { id: 'card-d', householdId: 'hh' });
    check('debit + linked bank saved', ins.card_type === 'debit' && ins.linked_asset_id === A);
    check(
      'credit card · no linked account / no auto source',
      buildCardInsert({ name: '현대', cardType: 'credit', linkedAssetId: A }, { id: 'c', householdId: 'hh' }).linked_asset_id === null &&
        debitSourceAssetId({ cardType: 'credit', linkedAssetId: A }) === undefined,
    );
    check('legacy debit (linked null) · resolves no account (form then blocks saving)', debitSourceAssetId({ cardType: 'debit' }) === undefined);

    // Card re-linked to B: a past transaction keeps A, so its balance effect stays on A.
    const past = buildTransactionInsert(
      { type: 'expense', category: 'food', amount: 10_000, memo: '', date: ISO, paymentMethod: 'debit', cardId: linked.id, sourceAssetId: debitSourceAssetId(linked) },
      { id: 't1', householdId: 'hh', knownCardIds: new Set([linked.id]) },
    );
    const relinked: CreditCard = { ...linked, linkedAssetId: B };
    const memoEdit = buildTransactionUpdate(
      { type: 'expense', category: 'food', amount: 10_000, memo: '메모', date: ISO, paymentMethod: 'debit', cardId: linked.id, sourceAssetId: past.source_asset_id ?? undefined },
      { knownCardIds: new Set([linked.id]), originalRawCardId: linked.id },
    );
    check(
      'card link 변경 후 과거 거래 불변 · still source A',
      past.source_asset_id === A && memoEdit.source_asset_id === A && debitSourceAssetId(relinked) === B,
    );
  }

  /* ---- B. transaction mapping ---- */
  {
    const ins = (d: Partial<NewTransactionDraft>) =>
      buildTransactionInsert(
        { type: 'expense', category: 'food', amount: 1_000, memo: '', date: ISO, ...d },
        { id: 'x', householdId: 'hh', knownCardIds: new Set(['card-d', 'card-c']) },
      );
    check('debit -> source_asset_id', ins({ paymentMethod: 'debit', cardId: 'card-d', sourceAssetId: A }).source_asset_id === A);
    check('transfer -> source_asset_id', ins({ paymentMethod: 'transfer', sourceAssetId: B }).source_asset_id === B);
    check(
      'income -> destination_asset_id',
      ins({ type: 'income', category: 'salary', paymentMethod: 'transfer', destinationAssetId: A }).destination_asset_id === A,
    );
    check('credit -> no source_asset_id', ins({ paymentMethod: 'credit', cardId: 'card-c', sourceAssetId: A }).source_asset_id === null);
  }

  /* ---- D. offline queue: display overlay + no double count ---- */
  {
    const server: Transaction[] = [
      { id: 'old', type: 'expense', category: 'food', amount: 7_000, memo: '', date: ISO, paymentMethod: 'debit', sourceAssetId: A },
      { id: 'synced', type: 'expense', category: 'food', amount: 3_000, memo: '', date: ISO, paymentMethod: 'transfer', sourceAssetId: A },
    ];
    const applied = (id: string) => id === 'synced'; // 'old' predates the migration
    const draft = (d: Partial<NewTransactionDraft>): NewTransactionDraft => ({
      type: 'expense',
      category: 'food',
      amount: 10_000,
      memo: '',
      date: ISO,
      paymentMethod: 'debit',
      cardId: 'card-d',
      sourceAssetId: A,
      ...d,
    });
    const createOp: PendingTransactionOpLike = { op: 'create', entityId: 'new', payload: draft({}) };
    const d1 = pendingAssetBalanceDeltas(server, applied, [createOp], new Set());
    check('offline create · shown as -10,000 on A before sync', d1.get(A) === -10_000, JSON.stringify([...d1]));

    // After the write lands, the server snapshot has the row (trigger applied it): overlay -> 0.
    const serverAfter = [...server, { ...server[1], id: 'new', amount: 10_000, paymentMethod: 'debit' as const }];
    const d2 = pendingAssetBalanceDeltas(serverAfter, (id) => id !== 'old', [createOp], new Set());
    check('server already has the row · overlay 0 (no double count)', (d2.get(A) ?? 0) === 0, JSON.stringify([...d2]));

    const upd: PendingTransactionOpLike = { op: 'update', entityId: 'synced', payload: draft({ amount: 5_000, paymentMethod: 'transfer', cardId: undefined }) };
    check('offline update · only the difference (-2,000)', pendingAssetBalanceDeltas(server, applied, [upd], new Set()).get(A) === -2_000);
    const del: PendingTransactionOpLike = { op: 'delete', entityId: 'synced' };
    check('offline delete · reverts (+3,000)', pendingAssetBalanceDeltas(server, applied, [del], new Set()).get(A) === 3_000);
    const legacyUpd: PendingTransactionOpLike = { op: 'update', entityId: 'old', payload: draft({ amount: 99_000 }) };
    check(
      'offline edit of a pre-migration row · overlay 0',
      (pendingAssetBalanceDeltas(server, applied, [legacyUpd], new Set()).get(A) ?? 0) === 0,
    );
    check(
      'terminal-failed op · excluded',
      pendingAssetBalanceDeltas(server, applied, [createOp], new Set(['new'])).size === 0,
    );

    // Queue drafts carry the account ids verbatim (confirmation compares them).
    const queued = draft({ type: 'income', category: 'salary', paymentMethod: 'transfer', cardId: undefined, sourceAssetId: undefined, destinationAssetId: B });
    check(
      'queue mapping · source / destination preserved through confirm',
      serverRowConfirmsUpdate({ id: 'q', ...queued, destinationAssetId: B } as Transaction, queued, new Set()) &&
        serverRowConfirmsUpdate({ id: 'q2', ...draft({}) } as Transaction, draft({}), new Set(['card-d'])),
    );
  }

  const failed = results.filter((r) => !r.pass).length;
  return { results, passed: results.length - failed, failed };
}
