-- ============================================================
-- 20261008002000_reset_household_finance_data.sql
-- "우리집 가계부 데이터 전체 초기화" — owner-only, atomic hard reset of ONE
-- household's finance content, as ONE Postgres transaction.
--
-- Self-contained, like every migration after 20260905000400_rls.sql: no
-- existing migration file is edited. This file:
--   1. adds public.household_settings.data_reset_at (a "this household's
--      finance data was wiped at ..." marker), and
--   2. creates public.reset_household_finance_data(p_household_id uuid).
--
-- ---- why an RPC, and why hard DELETE ----
-- Every finance table's client grant is SELECT/INSERT/UPDATE only
-- (20260905000400_rls.sql / 20260918001300_assets.sql) — "delete" from the
-- app is always a soft delete via deleted_at. That stays exactly as it is:
-- this migration adds NO DELETE grant and NO DELETE policy for any client
-- role. The hard DELETEs below run only inside this SECURITY DEFINER
-- function (as the table owner), after it has verified the caller itself.
-- A client-side loop of per-table deletes was rejected: it cannot be
-- atomic, and a failure halfway would leave a household half-wiped.
-- Soft delete was rejected too: the rows would stay on the server (the
-- feature promises the data is gone), and bulk-setting deleted_at would
-- fire trg_goal_movements_apply / trg_loan_payments_apply row by row in
-- arbitrary order, which can trip goals_saved_non_negative /
-- loans_paid_within_principal mid-statement.
--
-- ---- what is wiped / what is kept ----
-- Hard-deleted, always `where household_id = p_household_id`:
--   transactions, recurring_rules, planned_expenses, cards, assets,
--   goal_movements, goals, loan_payments, loans, budgets,
--   custom_categories.
-- Reset in place (row kept — it is the handle_new_household bootstrap row
-- and a schema invariant): household_settings.notes / cat_order_expense /
-- cat_order_income back to their column defaults.
-- NEVER touched: auth.users, profiles, households, household_members,
-- invites, household_imports. household_imports is kept ON PURPOSE: its
-- row is what makes import_household_snapshot() raise ALREADY_IMPORTED,
-- so a wiped household cannot silently re-import the owner's old local
-- device data and resurrect what was just deleted.
--
-- ---- delete order (FK-driven) ----
-- Every FK below is NON-deferrable ON DELETE NO ACTION, so it is checked
-- at the end of the DELETE statement that removes the parent — children
-- must already be gone by then:
--   transactions    -> cards, recurring_rules, planned_expenses, assets
--                      (source_asset_id, destination_asset_id),
--                      household_members (kept, so never an issue)
--   recurring_rules -> cards, assets (source/destination)
--   cards           -> assets (linked_asset_id)
-- goal_movements -> goals and loan_payments -> loans are ON DELETE
-- CASCADE; the children are still deleted explicitly first so each table
-- gets its own row count in the result.
-- budgets and custom_categories have no FK to each other.
--
-- ---- triggers that fire ----
-- Only one trigger in the schema is declared for DELETE:
-- trg_transactions_asset_balance (20261004001900). Each deleted live
-- transaction reverses its delta on assets.balance. That is harmless —
-- those asset rows are deleted two statements later, and
-- assets_balance_check was dropped in the same migration so an
-- intermediate negative balance cannot raise — but it is per-row work, so
-- a household with a very large number of transactions makes this call
-- proportionally slower. trg_goal_movements_apply / trg_loan_payments_apply
-- are INSERT/UPDATE-only and do not fire.
--
-- ---- concurrency ----
-- The households row is locked FOR UPDATE, the same lock
-- import_household_snapshot() and transfer_household_ownership() take, so
-- two resets of the same household (or a reset racing an import / an
-- ownership transfer) serialize. A concurrent client INSERT into any
-- finance table needs FOR KEY SHARE on that same households row for its
-- own household_id FK, which conflicts with FOR UPDATE — it waits until
-- this transaction ends, then lands as ordinary post-reset data.
-- Ownership is checked twice: once before the lock (a non-owner is
-- rejected without ever locking a household they have no say over, and
-- without learning whether the id exists), and once after it (the
-- authoritative one — an ownership transfer cannot commit in between).
--
-- ---- data_reset_at ----
-- Set to this transaction's now() on every successful reset; NULL means
-- "never reset". Other members' devices may still hold offline-queued
-- writes made against the pre-reset data; a client compares this value
-- with the last one it saw for the household and discards that queue
-- when it changes (change detection, not a timestamp comparison, so
-- device clock skew is irrelevant). household_settings' client UPDATE
-- grant is column-level (notes, cat_order_expense, cat_order_income) and
-- is NOT widened here, so no client can write this column; the existing
-- table-level SELECT grant already lets members read it. The table is
-- already in the supabase_realtime publication, so the UPDATE below also
-- reaches other devices as a realtime event.
--
-- Not touched by this file: any existing table definition other than the
-- one added column, RLS policies, grants, existing triggers, the realtime
-- publication, and every existing RPC.
-- ============================================================

alter table public.household_settings
  add column if not exists data_reset_at timestamptz;

-- ============================================================
-- reset_household_finance_data
-- ============================================================
--
-- Returns the per-table deleted row counts plus the reset marker, e.g.
--   {"transactions": 812, "recurring_rules": 4, "planned_expenses": 2,
--    "cards": 3, "assets": 5, "goal_movements": 17, "goals": 2,
--    "loan_payments": 9, "loans": 1, "budgets": 11,
--    "custom_categories": 6, "reset_at": "2026-10-08T03:21:45.123456+00:00"}
-- Counts include soft-deleted rows (deleted_at is not filtered) — they
-- are removed too.
--
-- Errors (same codes/spelling as the existing household RPCs):
--   AUTH_REQUIRED                 28000  no authenticated caller
--   NOT_OWNER                     42501  caller is not this household's owner
--                                        (also: not a member / unknown id)
--   HOUSEHOLD_NOT_FOUND           P0002  household vanished before the lock
--   HOUSEHOLD_SETTINGS_NOT_FOUND  P0002  bootstrap settings row missing
-- Any error — these or an unexpected one from a statement below — aborts
-- the whole function call, and with it every DELETE already performed:
-- under PostgREST one RPC call is one transaction.
create function public.reset_household_finance_data(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_locked_household_id uuid;
  v_reset_at timestamptz := now();
  v_row_count bigint;
  v_transactions bigint;
  v_recurring_rules bigint;
  v_planned_expenses bigint;
  v_cards bigint;
  v_assets bigint;
  v_goal_movements bigint;
  v_goals bigint;
  v_loan_payments bigint;
  v_loans bigint;
  v_budgets bigint;
  v_custom_categories bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Pre-lock check: nothing below (not even the row lock) runs for a
  -- caller who is not currently this household's owner.
  if not private.is_household_owner(p_household_id) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  select h.id into v_locked_household_id
  from public.households h
  where h.id = p_household_id
  for update;

  if v_locked_household_id is null then
    raise exception 'HOUSEHOLD_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Authoritative check, now that the household row is locked.
  if not private.is_household_owner(p_household_id) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  -- 1. transactions — first: they reference cards, recurring_rules,
  -- planned_expenses and assets.
  delete from public.transactions t where t.household_id = p_household_id;
  get diagnostics v_transactions = row_count;

  -- 2. recurring_rules — before cards and assets.
  delete from public.recurring_rules t where t.household_id = p_household_id;
  get diagnostics v_recurring_rules = row_count;

  -- 3. planned_expenses
  delete from public.planned_expenses t where t.household_id = p_household_id;
  get diagnostics v_planned_expenses = row_count;

  -- 4. cards — before assets (linked_asset_id).
  delete from public.cards t where t.household_id = p_household_id;
  get diagnostics v_cards = row_count;

  -- 5. assets
  delete from public.assets t where t.household_id = p_household_id;
  get diagnostics v_assets = row_count;

  -- 6. goal_movements, then goals
  delete from public.goal_movements t where t.household_id = p_household_id;
  get diagnostics v_goal_movements = row_count;

  delete from public.goals t where t.household_id = p_household_id;
  get diagnostics v_goals = row_count;

  -- 7. loan_payments, then loans
  delete from public.loan_payments t where t.household_id = p_household_id;
  get diagnostics v_loan_payments = row_count;

  delete from public.loans t where t.household_id = p_household_id;
  get diagnostics v_loans = row_count;

  -- 8. budgets
  delete from public.budgets t where t.household_id = p_household_id;
  get diagnostics v_budgets = row_count;

  -- 9. custom_categories
  delete from public.custom_categories t where t.household_id = p_household_id;
  get diagnostics v_custom_categories = row_count;

  -- 10. household_settings — UPDATE, never delete. updated_by/updated_at
  -- are force-set by trg_household_settings_guard (20260905000300).
  update public.household_settings hs
  set notes = '',
      cat_order_expense = '{}',
      cat_order_income = '{}',
      data_reset_at = v_reset_at
  where hs.household_id = p_household_id;

  get diagnostics v_row_count = row_count;
  if v_row_count = 0 then
    raise exception 'HOUSEHOLD_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'transactions', v_transactions,
    'recurring_rules', v_recurring_rules,
    'planned_expenses', v_planned_expenses,
    'cards', v_cards,
    'assets', v_assets,
    'goal_movements', v_goal_movements,
    'goals', v_goals,
    'loan_payments', v_loan_payments,
    'loans', v_loans,
    'budgets', v_budgets,
    'custom_categories', v_custom_categories,
    'reset_at', v_reset_at
  );
end;
$$;

revoke all on function public.reset_household_finance_data(uuid) from public;
revoke all on function public.reset_household_finance_data(uuid) from anon;
grant execute on function public.reset_household_finance_data(uuid) to authenticated;
