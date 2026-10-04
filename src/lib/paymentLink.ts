/**
 * Payment links — pure, no store/UI/Supabase imports (결제수단 연결 BATCH).
 *
 * ONE rule set for "which payment link fields mean something", shared by
 * transactions (write mapping, offline-queue overlay/confirmation) and
 * recurring rules, so both always store the same shape:
 *
 *   지출 (expense)
 *     paymentMethod      any of cash / debit / credit / transfer / other
 *     cardId             신용 ('credit') or 체크 ('debit') only
 *     sourceAssetId      이체 (picked 출금 계좌) or 체크 (the card's account,
 *                        copied when a transaction is created)
 *   수입 (income) — 입금처
 *     paymentMethod      'cash' (현금) or 'transfer' (계좌 입금) only
 *     destinationAssetId 'transfer' only
 *
 * Everything else is dropped, which is also what makes switching
 * 지출 <-> 수입 or changing the method clear the links that no longer apply.
 * Nothing here touches Asset.balance; for transactions the DB trigger
 * (20261004001900) applies the SAME rule server-side, mirrored in
 * src/lib/assetBalance.ts. Recurring rules never move a balance.
 */
import type { TxnType } from '@/data/categories';
import { describeAccount } from '@/lib/asset';
import { debitSourceAssetId } from '@/lib/card';
import type { Asset, CreditCard, PaymentMethod, RecurringRule, Transaction } from '@/store/types';

export interface PaymentLink {
  paymentMethod?: PaymentMethod;
  cardId?: string;
  sourceAssetId?: string;
  destinationAssetId?: string;
}

/** Only the link fields that fit `type` + `paymentMethod`; undefined keys omitted. */
export function normalizePaymentLink(type: TxnType, link: PaymentLink): PaymentLink {
  const pm = link.paymentMethod;
  const out: PaymentLink = {};
  if (type === 'expense') {
    if (pm) out.paymentMethod = pm;
    if ((pm === 'credit' || pm === 'debit') && link.cardId) out.cardId = link.cardId;
    if ((pm === 'transfer' || pm === 'debit') && link.sourceAssetId) out.sourceAssetId = link.sourceAssetId;
  } else if (type === 'income') {
    if (pm === 'cash' || pm === 'transfer') out.paymentMethod = pm;
    if (pm === 'transfer' && link.destinationAssetId) out.destinationAssetId = link.destinationAssetId;
  }
  return out;
}

/** The four snake_case columns for a link (NULL for anything not kept). */
export function paymentLinkColumns(
  type: TxnType,
  link: PaymentLink,
): {
  payment_method: PaymentMethod | null;
  card_id: string | null;
  source_asset_id: string | null;
  destination_asset_id: string | null;
} {
  const n = normalizePaymentLink(type, link);
  return {
    payment_method: n.paymentMethod ?? null,
    card_id: n.cardId ?? null,
    source_asset_id: n.sourceAssetId ?? null,
    destination_asset_id: n.destinationAssetId ?? null,
  };
}

/**
 * One short line for a list row: "신용카드 · 현대카드", "체크카드 · KB 노리",
 * "이체 · KB국민은행 · 생활비통장", "입금 · 신한은행 · 월급통장", "입금 · 현금".
 * A card / account that is no longer active reads "삭제된 카드" /
 * "삭제된 계좌" instead of breaking the row. '' when nothing is recorded
 * (legacy rows), so callers can simply skip the line.
 */
export function describePaymentLink(
  type: TxnType,
  link: PaymentLink,
  cards: readonly CreditCard[],
  assets: readonly Asset[],
): string {
  const n = normalizePaymentLink(type, link);
  const account = (id: string | undefined) => {
    if (!id) return undefined;
    const a = assets.find((x) => x.id === id);
    return a ? describeAccount(a) : '삭제된 계좌';
  };
  const card = (id: string | undefined) =>
    id ? cards.find((c) => c.id === id)?.name ?? '삭제된 카드' : undefined;
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

  if (type === 'income') {
    if (n.paymentMethod === 'cash') return '입금 · 현금';
    if (n.paymentMethod === 'transfer') return join('입금', account(n.destinationAssetId) ?? '계좌');
    return '';
  }
  switch (n.paymentMethod) {
    case 'cash':
      return '현금';
    case 'credit':
      return join('신용카드', card(n.cardId));
    case 'debit':
      return join('체크카드', card(n.cardId));
    case 'transfer':
      return join('이체', account(n.sourceAssetId));
    case 'other':
      return '기타';
    default:
      return '';
  }
}

/** One row of an account's 입출금 내역. */
export interface AccountEntry {
  transaction: Transaction;
  /** 'out' = 출금 (지출, source_asset_id), 'in' = 입금 (수입, destination_asset_id). */
  direction: 'out' | 'in';
}

/**
 * 계좌 상세의 입출금 내역 — always DERIVED from the transactions themselves
 * (no separate ledger), so editing a transaction's account or deleting it
 * is reflected the next time this runs. A transaction counts only when the
 * account link is one `normalizePaymentLink` keeps (지출 이체/체크 ->
 * 출금, 수입 계좌 입금 -> 입금); legacy rows with no link never match.
 * Newest first. Pure — never touches Asset.balance.
 */
export function accountTransactions(txns: readonly Transaction[], assetId: string): AccountEntry[] {
  const out: AccountEntry[] = [];
  for (const t of txns) {
    const link = normalizePaymentLink(t.type, t);
    if (t.type === 'expense' && link.sourceAssetId === assetId) out.push({ transaction: t, direction: 'out' });
    else if (t.type === 'income' && link.destinationAssetId === assetId) out.push({ transaction: t, direction: 'in' });
  }
  return out.sort((a, b) => {
    const d = new Date(b.transaction.date).getTime() - new Date(a.transaction.date).getTime();
    return d !== 0 ? d : b.transaction.id.localeCompare(a.transaction.id);
  });
}

/**
 * The method line for a row INSIDE an account's detail (the account itself
 * is implied): "체크카드 · KB 노리 체크카드", "이체", "입금". A card that is
 * no longer active reads just "체크카드" (the read model drops its id).
 */
export function accountEntryLabel(entry: AccountEntry, cards: readonly CreditCard[]): string {
  if (entry.direction === 'in') return '입금';
  const t = entry.transaction;
  if (t.paymentMethod === 'debit') {
    const name = t.cardId ? cards.find((c) => c.id === t.cardId)?.name : undefined;
    return name ? `체크카드 · ${name}` : '체크카드';
  }
  return '이체';
}

/**
 * The link a transaction created FROM a recurring rule should carry — the
 * hand-off for a future rule -> transaction materializer (none exists
 * today). The rule's own fields copy 1:1, except a 체크카드 rule: its
 * 출금 계좌 is the card's account AT CREATION TIME (`debitSourceAssetId`),
 * which the new transaction then keeps forever.
 */
export function recurringTransactionLink(
  rule: Pick<RecurringRule, 'type' | 'paymentMethod' | 'cardId' | 'sourceAssetId' | 'destinationAssetId'>,
  cards: readonly CreditCard[],
): PaymentLink {
  const card = rule.cardId ? cards.find((c) => c.id === rule.cardId) : undefined;
  return normalizePaymentLink(rule.type, {
    paymentMethod: rule.paymentMethod,
    cardId: rule.cardId,
    sourceAssetId: rule.paymentMethod === 'debit' ? debitSourceAssetId(card) : rule.sourceAssetId,
    destinationAssetId: rule.destinationAssetId,
  });
}
