-- ============================================================
-- 20261004001800_transaction_income_and_recurring_payment_links.sql
-- 결제수단 연결 BATCH — 수입 입금처 + 반복 규칙 결제수단/입금처
--
-- 1) public.transactions.destination_asset_id  text NULL
--    The 은행계좌 an INCOME landed in (입금처). Counterpart of
--    source_asset_id (expense 출금 계좌, 20261003001600). A 현금 income is
--    payment_method = 'cash' with no asset, so no cash Asset is ever needed.
--
-- 2) public.recurring_rules
--      payment_method        text NULL, same CHECK values as transactions
--      card_id               text NULL  -> cards   (신용/체크카드)
--      source_asset_id       text NULL  -> assets  (이체 출금 계좌)
--      destination_asset_id  text NULL  -> assets  (수입 입금처)
--    Same column names / meaning as on public.transactions, so a future
--    "rule -> real transaction" materializer copies them 1:1. A 체크카드
--    rule stores the card only (no account snapshot): a rule describes
--    FUTURE payments, so the card's account is resolved when a transaction
--    is actually created — and frozen there, on the transaction.
--
-- Every new FK reuses the household-scoped composite pattern
-- (20260905000300_integrity_triggers.sql): (household_id, x_id) ->
-- parent(household_id, id), ON DELETE NO ACTION (parents are only ever
-- soft-deleted; the app shows a "삭제된 카드/계좌" fallback).
-- cards(household_id, id) and assets(household_id, id) are already unique.
--
-- All columns are NULLABLE with no default: every existing transaction and
-- recurring rule keeps working as-is (NULL = no link recorded). No
-- backfill, no trigger, no balance arithmetic — public.assets.balance stays
-- 100% manual entry. No cross-column CHECK (an older app version PATCHes
-- without these columns; the client ignores a link that does not fit the
-- row's type / payment_method instead).
--
-- Not touched: existing columns / CHECKs / FKs, RLS policies, grants
-- (table-level grants cover new columns), triggers, realtime publication,
-- the household_import RPC (names its columns -> NULL here), and
-- 20261004001700_cards_linked_asset.sql (separate, still pending).
-- ============================================================

-- ---------- transactions: 수입 입금처 ----------
alter table public.transactions
  add column destination_asset_id text;

alter table public.transactions
  add constraint transactions_destination_asset_fk
    foreign key (household_id, destination_asset_id)
    references public.assets (household_id, id)
    on delete no action;

-- ---------- recurring_rules: 결제수단 / 입금처 ----------
alter table public.recurring_rules
  add column payment_method text
    check (payment_method in ('cash', 'debit', 'credit', 'transfer', 'other')),
  add column card_id text,
  add column source_asset_id text,
  add column destination_asset_id text;

alter table public.recurring_rules
  add constraint recurring_rules_card_fk
    foreign key (household_id, card_id)
    references public.cards (household_id, id)
    on delete no action,
  add constraint recurring_rules_source_asset_fk
    foreign key (household_id, source_asset_id)
    references public.assets (household_id, id)
    on delete no action,
  add constraint recurring_rules_destination_asset_fk
    foreign key (household_id, destination_asset_id)
    references public.assets (household_id, id)
    on delete no action;
