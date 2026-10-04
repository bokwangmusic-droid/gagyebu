-- ============================================================
-- 20261004001900_asset_balance_sync.sql
-- 결제수단 연결 BATCH — 거래에 따른 계좌 잔액 자동 반영
--
-- public.assets.balance becomes transaction-driven for 은행계좌-linked
-- payments, computed IN THE DATABASE from each transactions row change, so
-- the client never sends a separate "balance -= amount" write (and an
-- offline-queue replay of the same transaction can never double-apply).
--
-- ---------- the rule (mirrored 1:1 by src/lib/assetBalance.ts) ----------
-- A transactions row has an account EFFECT only when it is
--   active (deleted_at IS NULL)  AND  asset_balance_applied = true  AND
--     expense + payment_method in ('transfer','debit') + source_asset_id
--         -> source asset       -amount
--     income  + payment_method = 'transfer'           + destination_asset_id
--         -> destination asset  +amount
-- These are exactly the links the app itself keeps (src/lib/paymentLink.ts
-- `normalizePaymentLink`); 신용카드 / 현금 / 기타 never move a balance.
--
-- On every INSERT / UPDATE / DELETE:  balance -= OLD effect; balance += NEW
-- effect. So: insert applies, delete (hard or soft) reverts, restore
-- re-applies, an amount / account / type change moves exactly the
-- difference, and an UPDATE that changes nothing balance-relevant (a memo
-- edit, an idempotent replay of the same PATCH) is a no-op — no UPDATE of
-- public.assets is issued at all in that case.
--
-- ---------- no back-dating ----------
-- 1) transactions.asset_balance_applied boolean NOT NULL DEFAULT false.
--    Every row that exists when this migration runs gets false (ADD COLUMN
--    with a constant default is catalog-only — no row rewrite, no UPDATE).
--    A BEFORE INSERT trigger sets it true on every NEW row; a BEFORE UPDATE
--    keeps the stored value (clients can't flip it). Rows with false never
--    have an effect — not on insert, edit, delete or restore — so the
--    balances users typed in by hand are never retro-adjusted for history,
--    and deleting a pre-migration transaction never "refunds" an amount that
--    was never deducted. No existing assets.balance value is recalculated.
--
-- ---------- negative balances ----------
-- 2) assets_balance_check (balance >= 0, 20260918001300_assets.sql) is
--    dropped: a 체크카드 / 이체 spend larger than the registered balance must
--    still save (otherwise the transaction write itself would fail, and an
--    offline-queued one would fail terminally). Existing rows are all >= 0
--    and are untouched.
--
-- ---------- security ----------
-- Both functions are SECURITY INVOKER (default) with search_path = '' and
-- schema-qualified names, like every non-bootstrap trigger in
-- 20260905000300_integrity_triggers.sql. No SECURITY DEFINER is needed:
-- `authenticated` already has a table-level UPDATE grant on public.assets
-- and the assets_update RLS policy admits any member of the asset's
-- household; the composite FKs (household_id, source_asset_id) /
-- (household_id, destination_asset_id) guarantee the asset belongs to the
-- SAME household as the transaction whose write (already authorized by the
-- transactions RLS policies) fired the trigger. The UPDATE goes through the
-- normal assets triggers (identity lock, updated_at touch) — so an open
-- asset edit form correctly sees a concurrency conflict after a balance
-- move instead of overwriting it.
--
-- Concurrency: `balance = balance + delta` row-locks the asset for the
-- statement, so simultaneous transactions serialize; each AFTER trigger is
-- part of its triggering statement, so if the asset UPDATE failed the
-- transaction write would roll back with it.
--
-- Not touched: existing columns (other than the dropped CHECK), FKs, RLS
-- policies, grants, existing triggers, realtime publication, and every
-- existing row of every table.
-- ============================================================

-- ---------- 1. negative balances allowed ----------
alter table public.assets
  drop constraint if exists assets_balance_check;

-- ---------- 2. per-row "affects balances" flag (false for all existing rows) ----------
alter table public.transactions
  add column asset_balance_applied boolean not null default false;

create function private.trg_lock_transaction_balance_flag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    new.asset_balance_applied := true;
  elsif TG_OP = 'UPDATE' then
    new.asset_balance_applied := old.asset_balance_applied;
  end if;
  return new;
end;
$$;

create trigger trg_transactions_balance_flag
  before insert or update on public.transactions
  for each row execute function private.trg_lock_transaction_balance_flag();

-- ---------- 3. apply OLD/NEW effects to assets.balance ----------
create function private.trg_apply_transaction_asset_balance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_asset text;
  old_delta numeric := 0;
  new_asset text;
  new_delta numeric := 0;
begin
  if TG_OP in ('UPDATE', 'DELETE') and old.asset_balance_applied and old.deleted_at is null then
    if old.type = 'expense' and old.payment_method in ('transfer', 'debit')
       and old.source_asset_id is not null then
      old_asset := old.source_asset_id;
      old_delta := -old.amount;
    elsif old.type = 'income' and old.payment_method = 'transfer'
       and old.destination_asset_id is not null then
      old_asset := old.destination_asset_id;
      old_delta := old.amount;
    end if;
  end if;

  if TG_OP in ('INSERT', 'UPDATE') and new.asset_balance_applied and new.deleted_at is null then
    if new.type = 'expense' and new.payment_method in ('transfer', 'debit')
       and new.source_asset_id is not null then
      new_asset := new.source_asset_id;
      new_delta := -new.amount;
    elsif new.type = 'income' and new.payment_method = 'transfer'
       and new.destination_asset_id is not null then
      new_asset := new.destination_asset_id;
      new_delta := new.amount;
    end if;
  end if;

  -- Same account, same signed amount (memo edit, idempotent replay, change
  -- between two non-balance methods, deleted-row edit): nothing to do.
  if old_asset is not distinct from new_asset and old_delta = new_delta then
    return null;
  end if;

  if old_asset is not null and old_asset = new_asset then
    update public.assets
      set balance = balance - old_delta + new_delta
      where household_id = new.household_id and id = new_asset;
    return null;
  end if;

  if old_asset is not null then
    update public.assets
      set balance = balance - old_delta
      where household_id = old.household_id and id = old_asset;
  end if;
  if new_asset is not null then
    update public.assets
      set balance = balance + new_delta
      where household_id = new.household_id and id = new_asset;
  end if;
  return null;
end;
$$;

create trigger trg_transactions_asset_balance
  after insert or update or delete on public.transactions
  for each row execute function private.trg_apply_transaction_asset_balance();
