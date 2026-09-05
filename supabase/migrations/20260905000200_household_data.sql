-- ============================================================
-- 20260905000200_household_data.sql
-- STEP 16-C / STEP 16-C1 — household-owned data tables
--
-- household_settings, custom_categories, cards, recurring_rules,
-- planned_expenses, goals, goal_movements, loans, loan_payments,
-- transactions, budgets.
--
-- STEP 16-C1 hardening: RLS is enabled on every table in THIS file,
-- immediately after its CREATE TABLE (same fail-closed reasoning as
-- 20260905000100_identity.sql — no window where these tables exist in the
-- public schema without RLS already on).
--
-- Otherwise structure only: tables, CHECK constraints, and the
-- composite-FK target uniques (household_id, id). The composite FKs
-- themselves (which need multiple sibling tables to already exist) and
-- every trigger live in 20260905000300_integrity_triggers.sql. Policies
-- and explicit GRANTs live in 20260905000400_rls.sql.
--
-- Entity ids (goals/cards/recurring_rules/planned_expenses/loans/
-- loan_payments/goal_movements/custom_categories/transactions) are
-- client-generated TEXT, matching the app's existing `uid(prefix)` scheme
-- (src/store/store.tsx) — no uuid remapping. Infra ids stay uuid
-- (20260905000100_identity.sql).
-- ============================================================

-- ---------- household_settings ----------
-- Shared per-household preferences: notes + category display order.
-- Per-device/per-user prefs (quickPaste, profileName, ...) intentionally
-- stay client-local, not modelled here (STEP 16-A §household_settings).
create table public.household_settings (
  household_id       uuid primary key references public.households (id) on delete cascade,
  notes               text not null default '',
  cat_order_expense   text[] not null default '{}',
  cat_order_income    text[] not null default '{}',
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now()
);

alter table public.household_settings enable row level security;

-- ---------- custom_categories ----------
create table public.custom_categories (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  type          text not null check (type in ('income', 'expense')),
  name          text not null,
  bg            text not null,
  color         text not null,
  icon          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

alter table public.custom_categories enable row level security;

-- ---------- cards ----------
create table public.cards (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  name          text not null,
  color_bg      text,
  color_fg      text,
  payment_day   int check (payment_day between 1 and 31),
  closing_day   int check (closing_day between 1 and 31),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (household_id, id)
);

alter table public.cards enable row level security;

-- ---------- recurring_rules ----------
create table public.recurring_rules (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  type          text not null check (type in ('income', 'expense')),
  name          text not null,
  amount        numeric not null check (amount > 0),
  category      text not null,
  frequency     text not null check (frequency in ('monthly', 'weekly')),
  day_of_month  int check (day_of_month between 1 and 31),
  day_of_week   int check (day_of_week between 0 and 6),
  active        boolean not null default true,
  last_run      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (household_id, id)
);

alter table public.recurring_rules enable row level security;

-- ---------- planned_expenses ----------
create table public.planned_expenses (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  name          text not null,
  amount        numeric not null check (amount > 0),
  category      text not null,
  date          date not null,
  memo          text not null default '',
  type          text not null check (type in ('income', 'expense')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (household_id, id)
);

alter table public.planned_expenses enable row level security;

-- ---------- goals ----------
-- `saved` is a server-maintained cache, kept in sync by goal_movements'
-- trg_apply_goal_movement() trigger only. Client UPDATE access to this
-- column is revoked at the grant level in 20260905000400_rls.sql, not by a
-- trigger-depth trick — see that file for the reasoning.
create table public.goals (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  name          text not null,
  target        numeric not null check (target > 0),
  saved         numeric not null default 0,
  deadline      date,
  icon          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (household_id, id),
  constraint goals_saved_non_negative check (saved >= 0)
);

alter table public.goals enable row level security;

-- ---------- goal_movements ----------
-- One row per deposit/withdrawal. goal_id's composite FK to goals is added
-- in 20260905000300_integrity_triggers.sql (needs goals' unique
-- (household_id, id), already declared above).
create table public.goal_movements (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  goal_id       text not null,
  amount_delta  numeric not null check (amount_delta <> 0),
  memo          text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

alter table public.goal_movements enable row level security;

-- ---------- loans ----------
-- `paid` is a server-maintained cache, kept in sync by loan_payments'
-- trg_apply_loan_payment() trigger only (same pattern as goals.saved).
create table public.loans (
  id            text primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.profiles (id) on delete set null,
  name          text not null,
  lender        text not null default '',
  principal     numeric not null check (principal > 0),
  annual_rate   numeric not null check (annual_rate >= 0),
  term_months   int not null check (term_months > 0),
  start_date    date not null,
  payment_day   int not null check (payment_day between 1 and 31),
  repay_type    text not null check (repay_type in ('amortizing', 'bullet')),
  paid          numeric not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (household_id, id),
  constraint loans_paid_within_principal check (paid >= 0 and paid <= principal)
);

alter table public.loans enable row level security;

-- ---------- loan_payments ----------
-- amount = principal_part + interest_part is NOT enforced as an exact
-- equality: src/lib/loan.ts splitPayment() legitimately produces
-- principal_part + interest_part < amount on an early-payoff overpayment
-- (the excess is simply not tracked client-side today). The "<=" form
-- below still catches a corrupted/impossible split without rejecting that
-- real client behaviour.
create table public.loan_payments (
  id               text primary key,
  household_id     uuid not null references public.households (id) on delete cascade,
  loan_id          text not null,
  date             date not null,
  amount           numeric not null check (amount > 0),
  principal_part   numeric not null check (principal_part >= 0),
  interest_part    numeric not null check (interest_part >= 0),
  memo             text,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint loan_payments_parts_within_amount check (principal_part + interest_part <= amount)
);

alter table public.loan_payments enable row level security;

-- ---------- transactions ----------
-- member_id/card_id/from_recurring/from_planned are plain columns here;
-- their composite FKs (household-scoped, ON DELETE NO ACTION) are added in
-- 20260905000300_integrity_triggers.sql once every referenced parent table
-- exists with its (household_id, id) unique constraint.
create table public.transactions (
  id                         text primary key,
  household_id               uuid not null references public.households (id) on delete cascade,
  created_by                 uuid references public.profiles (id) on delete set null,
  member_id                  uuid,
  type                       text not null check (type in ('income', 'expense')),
  category                   text not null,
  amount                     numeric not null check (amount > 0),
  memo                       text not null default '',
  date                       timestamptz not null,
  from_recurring             text,
  recurring_occurrence_date  date,
  from_planned               text,
  payment_method             text check (payment_method in ('cash', 'debit', 'credit', 'transfer', 'other')),
  card_id                    text,
  installment_months         int check (installment_months is null or installment_months >= 2),
  splits                     jsonb,
  tags                       text[],
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  deleted_at                 timestamptz,
  constraint transactions_recurring_fields_together check (
    (from_recurring is null and recurring_occurrence_date is null)
    or (from_recurring is not null and recurring_occurrence_date is not null)
  )
);

alter table public.transactions enable row level security;

-- Recurring-occurrence dedup (STEP 16-B2 §6 fix): tombstones count.
-- A soft-deleted row for a given (household, rule, occurrence date) still
-- occupies this uniqueness slot forever, so a second device can never
-- recreate a deleted auto-generated occurrence. Ordinary manual
-- transactions (from_recurring is null) are entirely unaffected.
create unique index ux_transactions_recurring_occurrence
  on public.transactions (household_id, from_recurring, recurring_occurrence_date)
  where from_recurring is not null;

-- Planned-expense completion dedup (STEP 16-B2 §7 fix): same tombstone
-- reasoning — a soft-deleted completion transaction still blocks a second
-- completion transaction for the same planned expense.
create unique index ux_transactions_planned_once
  on public.transactions (household_id, from_planned)
  where from_planned is not null;

-- ---------- budgets ----------
-- BudgetMap is one amount per category, so (household_id, category_id) IS
-- the natural key — no separate text id needed. category_id/household_id
-- are locked against UPDATE (identity columns of this row) in the triggers
-- + grants files; changing a budget's category is modelled as
-- soft-delete-old-row + insert-new-row, not an UPDATE of category_id.
create table public.budgets (
  household_id  uuid not null references public.households (id) on delete cascade,
  category_id   text not null,
  amount        numeric not null check (amount > 0),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (household_id, category_id)
);

alter table public.budgets enable row level security;
