-- ============================================================
-- 20260918001300_assets.sql
-- 전체자산/순자산 기능 STEP 1 — public.assets (household-owned, manual-entry
-- asset balances: 현금/은행계좌/예적금/투자/기타).
--
-- Self-contained, like every migration after 20260905000400_rls.sql: no
-- existing migration file is edited. This file creates the table, enables
-- RLS immediately (same fail-closed reasoning as every prior table — no
-- window where `assets` is public-with-RLS-off), then attaches the
-- identity-lock / updated_at triggers and the RLS policies + grants in the
-- same file, reusing `private.trg_lock_identity()`,
-- `private.trg_touch_updated_at()` and `private.is_household_member()`
-- from 20260905000300_integrity_triggers.sql / 20260905000400_rls.sql —
-- no new trigger functions, no new RLS helper.
--
-- Entity id is client-generated TEXT (`asset-<ms>-<rand>`), matching the
-- app's existing `uid(prefix)` scheme — same as cards/loans/goals/etc.
--
-- Scope (per 돈돈 가계부 전체자산 STEP 1 조사):
--   - balance is 100% MANUAL ENTRY. No transaction<->balance link exists
--     yet (that is explicitly deferred to a later STEP) — nothing here
--     computes or auto-adjusts `balance`. Unlike goals.saved / loans.paid,
--     there is no companion "movement" child table and no atomic-cache
--     trigger: the client's own UPDATE of `balance` IS the whole write.
--   - loans (existing table) are NOT duplicated here and are NOT rows in
--     `assets` — total-debt stays `sum(loans.principal - loans.paid)`,
--     computed independently. Mixing a loan into `assets` would double
--     count it against net worth.
--   - goals.saved (savings-goal progress) is NOT mirrored into `assets`
--     either — a goal is a target-tracking construct, not a held balance.
--   - Card outstanding balances are out of scope for this table entirely
--     (1st-cut total-debt intentionally excludes card debt).
--   - No offline queue integration in this STEP (online-only), matching
--     the household-write-gating stack added in a later STEP for every
--     other entity (src/lib/financeMode.ts) — this migration itself is
--     transport-agnostic and doesn't care.
-- ============================================================

-- ---------- assets ----------
-- `balance` is NOT NULL DEFAULT 0 and constrained >= 0, mirroring how this
-- app already treats "amount" columns everywhere else (transactions.amount,
-- planned_expenses.amount, recurring_rules.amount, loans.principal are all
-- `check (... > 0)`; budgets.amount too). Overdraft-style negative balances
-- (마이너스 통장) are deliberately OUT of scope for `assets` — a negative
-- "asset" is actually a liability, and the 조사 STEP already concluded a
-- 마이너스 통장 belongs with a future debt/liability model, not here. A
-- household that needs to model one today should track it as a `loans` row
-- instead until that liability model exists.
create table public.assets (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  name          text not null,
  type          text not null check (type in ('cash', 'bank', 'savings', 'investment', 'other')),
  balance       numeric not null default 0 check (balance >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (household_id, id)
);

alter table public.assets enable row level security;

-- ---------- identity lock + updated_at ----------
-- Same generic triggers every other household-owned table uses
-- (20260905000300_integrity_triggers.sql): created_by is forced to the
-- caller on INSERT; id/household_id/created_by/created_at can never change
-- on UPDATE; updated_at is server-stamped on every UPDATE (the concurrency
-- token the app's write layer already reads via updated_at on every other
-- entity — see src/lib/remoteLoanWriteMapping.ts / remoteCardWriteMapping.ts
-- for the pattern this table is meant to slot into next STEP).
create trigger trg_assets_identity
  before insert or update on public.assets
  for each row execute function private.trg_lock_identity();

create trigger trg_assets_touch
  before update on public.assets
  for each row execute function private.trg_touch_updated_at();

-- ---------- RLS + grants ----------
-- Same shape as cards (20260905000400_rls.sql): any household member can
-- read and write any row (shared ledger), created_by on INSERT must match
-- the caller (also enforced by trg_lock_identity), no DELETE policy —
-- delete is soft, via an UPDATE that sets deleted_at. UPDATE grant is
-- BLANKET (not column-restricted) because — unlike goals.saved / loans.paid
-- — `balance` has no server-maintained trigger cache to protect; the
-- identity columns are already locked at the trigger level, exactly like
-- cards' own blanket grant.
revoke all on public.assets from anon, authenticated;
grant select, insert, update on public.assets to authenticated;

create policy assets_select on public.assets
  for select to authenticated using (private.is_household_member(household_id));
create policy assets_insert on public.assets
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy assets_update on public.assets
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));
