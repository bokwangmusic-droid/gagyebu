-- ============================================================
-- 20261003001600_card_type_and_transaction_source_asset.sql
-- 결제수단 연결 BATCH — 신용/체크카드 구분 + 이체 출금계좌 연결
--
-- 1) public.cards.card_type
--      text NOT NULL DEFAULT 'credit', CHECK in ('credit', 'debit')
--    Every existing card was registered as a credit card (the app had no
--    other kind), so the default keeps their meaning. ADD COLUMN with a
--    constant default is a catalog-only change in PG 11+ (no row rewrite).
--    An app version that predates this column INSERTs without it (-> the
--    default 'credit') and PATCHes only name/colour/days (-> card_type is
--    left as it was), so older clients keep working unchanged.
--
-- 2) public.transactions.source_asset_id
--      text NULL — the 출금 계좌 (a public.assets row) a 「이체」 expense was
--    paid from. NULL on every existing row and on every non-transfer row.
--    Same household-scoped composite FK shape as transactions.card_id
--    (20260905000300_integrity_triggers.sql): a transaction can only point
--    at an asset of its OWN household; assets(household_id, id) is already
--    unique (20260918001300_assets.sql). ON DELETE NO ACTION for the same
--    reason as card_id — assets are only ever soft-deleted, so a
--    transaction keeps pointing at its (soft-deleted) account.
--
--    This is a RECORD of which account paid, nothing more: no trigger and
--    no balance arithmetic — public.assets.balance stays 100% manual entry.
--
-- Not touched: existing columns / CHECKs, RLS policies, grants (both
-- tables already have table-level select/insert/update grants, which cover
-- new columns), triggers, realtime publication (table-level), the
-- household_import RPC (it names its columns, so imported cards get the
-- 'credit' default and imported transactions a NULL source_asset_id).
-- ============================================================

alter table public.cards
  add column card_type text not null default 'credit'
    check (card_type in ('credit', 'debit'));

alter table public.transactions
  add column source_asset_id text;

alter table public.transactions
  add constraint transactions_source_asset_fk
    foreign key (household_id, source_asset_id)
    references public.assets (household_id, id)
    on delete no action;
