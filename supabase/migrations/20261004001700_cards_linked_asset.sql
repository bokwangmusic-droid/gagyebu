-- ============================================================
-- 20261004001700_cards_linked_asset.sql
-- 결제수단 연결 BATCH — 체크카드 ↔ 출금 은행계좌 연결
--
-- Adds public.cards.linked_asset_id  text NULL — the 은행계좌 (a
-- public.assets row) a 체크카드 withdraws from. NULL for every existing
-- card, every 신용카드, and a 체크카드 with no account linked.
--
-- Same household-scoped composite FK shape as transactions.card_id /
-- transactions.source_asset_id (20260905000300_integrity_triggers.sql,
-- 20261003001600_card_type_and_transaction_source_asset.sql): a card can
-- only point at an asset of its OWN household; assets(household_id, id) is
-- already unique. ON DELETE NO ACTION — assets are only ever soft-deleted,
-- so the card keeps pointing at its (soft-deleted) account and the app
-- shows a "삭제된 계좌" fallback.
--
-- History is NOT derived from this column: when a 체크카드 transaction is
-- saved the app COPIES the card's account at that moment into
-- transactions.source_asset_id, so re-linking a card later never changes
-- the 출금 계좌 recorded on past transactions. No trigger, no balance
-- arithmetic — public.assets.balance stays 100% manual entry.
--
-- Deliberately NO cross-column CHECK (e.g. "only debit cards may link"):
-- an app version that predates this column PATCHes card_type without
-- knowing about linked_asset_id, so a CHECK could make that older app's
-- save fail. The client ignores a link on a 신용카드 instead.
--
-- Not touched: existing columns / CHECKs, RLS policies, grants (table-level
-- grants already cover the new column), triggers, realtime publication,
-- the household_import RPC (it names its columns -> NULL here).
-- A separate migration on purpose: 20261003001600 is already applied
-- remotely, and every migration in this project is append-only.
-- ============================================================

alter table public.cards
  add column linked_asset_id text;

alter table public.cards
  add constraint cards_linked_asset_fk
    foreign key (household_id, linked_asset_id)
    references public.assets (household_id, id)
    on delete no action;
