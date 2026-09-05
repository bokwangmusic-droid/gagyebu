-- ============================================================
-- 20260905000300_integrity_triggers.sql
-- STEP 16-C / STEP 16-C1 — private schema, trigger functions/bindings,
-- composite FKs, identity + transaction-provenance locking
--
-- Runs after 20260905000100_identity.sql and 20260905000200_household_data.sql,
-- so every table referenced below (household_members, household_settings,
-- goals, loans, cards, recurring_rules, planned_expenses, transactions,
-- goal_movements, loan_payments, budgets) already exists — this ordering is
-- exactly what fixes STEP 16-B's "household_settings created after the
-- trigger that inserts into it" bug.
--
-- RLS is already ON for every table here (enabled at CREATE TABLE time in
-- 20260905000100_identity.sql / 20260905000200_household_data.sql), but no
-- policy exists yet — so nothing this file does is reachable through the
-- Data API until 20260905000400_rls.sql adds policies + grants. This file
-- itself adds no policies/GRANTs — it is only "what happens automatically
-- on write" (identity locking, provenance locking, updated_at, the
-- goals.saved / loans.paid atomic cache), not "who is allowed to write".
--
-- SECURITY DEFINER is used ONLY where a function must act with more
-- privilege than the calling client has (bypassing household_members'
-- RLS to bootstrap it, or bypassing the column-level UPDATE restriction
-- on goals.saved / loans.paid put in place by 20260905000400_rls.sql).
-- Every other trigger here only rewrites fields on the row already being
-- written by an already-authorized caller, so it stays SECURITY INVOKER
-- (least privilege). Every function still lives in `private` and every
-- SECURITY DEFINER function sets search_path='' with fully schema-
-- qualified references, per STEP 16-B2/16-C §10.
-- ============================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ============================================================
-- Bootstrap triggers
-- ============================================================

-- New auth.users row -> profiles row. Standard Supabase pattern.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), '나')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- New households row -> creator becomes owner in household_members, plus a
-- household_settings row is bootstrapped. household_members has no client
-- INSERT policy at all (20260905000400_rls.sql), so this MUST run as the
-- table owner (SECURITY DEFINER) to succeed.
create function private.handle_new_household()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.household_members (household_id, user_id, role, display_name)
  values (
    new.id,
    new.created_by,
    'owner',
    coalesce((select p.display_name from public.profiles p where p.id = new.created_by), '나')
  );

  insert into public.household_settings (household_id)
  values (new.id);

  return new;
end;
$$;

create trigger trg_new_household
  after insert on public.households
  for each row execute function private.handle_new_household();

-- ============================================================
-- Generic identity-lock + updated_at triggers
-- (custom_categories, cards, recurring_rules, planned_expenses,
--  transactions, goals, loans)
-- ============================================================

-- INSERT: created_by is always forced to the caller, never trusted from
-- the client payload. UPDATE: id/household_id/created_by/created_at can
-- never change after creation (STEP 16-C §9, STEP 16-C1 §3/§7 — created_at
-- added on top of the STEP 16-C set).
create function private.trg_lock_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
  elsif TG_OP = 'UPDATE' then
    new.id := old.id;
    new.household_id := old.household_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create function private.trg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_custom_categories_identity
  before insert or update on public.custom_categories
  for each row execute function private.trg_lock_identity();
create trigger trg_custom_categories_touch
  before update on public.custom_categories
  for each row execute function private.trg_touch_updated_at();

create trigger trg_cards_identity
  before insert or update on public.cards
  for each row execute function private.trg_lock_identity();
create trigger trg_cards_touch
  before update on public.cards
  for each row execute function private.trg_touch_updated_at();

create trigger trg_recurring_rules_identity
  before insert or update on public.recurring_rules
  for each row execute function private.trg_lock_identity();
create trigger trg_recurring_rules_touch
  before update on public.recurring_rules
  for each row execute function private.trg_touch_updated_at();

create trigger trg_planned_expenses_identity
  before insert or update on public.planned_expenses
  for each row execute function private.trg_lock_identity();
create trigger trg_planned_expenses_touch
  before update on public.planned_expenses
  for each row execute function private.trg_touch_updated_at();

create trigger trg_transactions_identity
  before insert or update on public.transactions
  for each row execute function private.trg_lock_identity();
create trigger trg_transactions_touch
  before update on public.transactions
  for each row execute function private.trg_touch_updated_at();

-- Provenance lock (STEP 16-C1 §4): from_recurring / recurring_occurrence_date
-- / from_planned identify WHICH recurring occurrence or planned expense a
-- transaction came from, and the tombstone-uniqueness design
-- (ux_transactions_recurring_occurrence / ux_transactions_planned_once in
-- 20260905000200_household_data.sql) depends on that identity never moving
-- once set. A manual transaction is created with both null and must stay
-- null forever; a recurring/planned-derived transaction keeps whichever
-- values it was created with forever. Editing amount/memo/category/date/
-- payment_method/card_id/etc. is unaffected — only these three columns are
-- locked.
create function private.trg_lock_transaction_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE' then
    new.from_recurring := old.from_recurring;
    new.recurring_occurrence_date := old.recurring_occurrence_date;
    new.from_planned := old.from_planned;
  end if;
  return new;
end;
$$;

create trigger trg_transactions_provenance
  before update on public.transactions
  for each row execute function private.trg_lock_transaction_provenance();

create trigger trg_goals_identity
  before insert or update on public.goals
  for each row execute function private.trg_lock_identity();
create trigger trg_goals_touch
  before update on public.goals
  for each row execute function private.trg_touch_updated_at();

create trigger trg_loans_identity
  before insert or update on public.loans
  for each row execute function private.trg_lock_identity();
create trigger trg_loans_touch
  before update on public.loans
  for each row execute function private.trg_touch_updated_at();

-- ============================================================
-- budgets — composite PK (household_id, category_id) is its identity;
-- locked the same way id/household_id are locked elsewhere.
-- ============================================================

create function private.trg_lock_budget_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
  elsif TG_OP = 'UPDATE' then
    new.household_id := old.household_id;
    new.category_id := old.category_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger trg_budgets_identity
  before insert or update on public.budgets
  for each row execute function private.trg_lock_budget_identity();
create trigger trg_budgets_touch
  before update on public.budgets
  for each row execute function private.trg_touch_updated_at();

-- ============================================================
-- goal_movements: identity lock + atomic application to goals.saved
-- ============================================================

create function private.trg_lock_goal_movement_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
  elsif TG_OP = 'UPDATE' then
    new.id := old.id;
    new.household_id := old.household_id;
    new.goal_id := old.goal_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger trg_goal_movements_identity
  before insert or update on public.goal_movements
  for each row execute function private.trg_lock_goal_movement_identity();
create trigger trg_goal_movements_touch
  before update on public.goal_movements
  for each row execute function private.trg_touch_updated_at();

-- Applies amount_delta to goals.saved atomically. The UPDATE below runs as
-- this function's owner (SECURITY DEFINER), so it is unaffected by the
-- column-level UPDATE restriction 20260905000400_rls.sql puts on
-- goals.saved for `authenticated` — that restriction blocks a client's
-- own direct UPDATE, not this trigger's internal one.
--
-- Concurrency: `update goals set saved = saved + delta where id = ...`
-- takes a row lock on the target goal for the duration of the UPDATE, so
-- two simultaneous withdrawals serialize: the second one recomputes from
-- the first one's already-committed result. If that would take `saved`
-- negative, the goals_saved_non_negative CHECK constraint (STEP 16-C §8 /
-- goals table) raises, which aborts the whole statement that fired this
-- AFTER trigger — including the goal_movements row that triggered it. No
-- explicit rollback code is needed for that; it is how Postgres statement
-- atomicity works.
create function private.trg_apply_goal_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    if new.deleted_at is null then
      update public.goals set saved = saved + new.amount_delta where id = new.goal_id;
    end if;
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      update public.goals set saved = saved - old.amount_delta where id = new.goal_id;
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.goals set saved = saved + new.amount_delta where id = new.goal_id;
    elsif old.deleted_at is null and new.deleted_at is null
          and old.amount_delta is distinct from new.amount_delta then
      update public.goals
        set saved = saved - old.amount_delta + new.amount_delta
        where id = new.goal_id;
    end if;
    return new;
  end if;

  return new;
end;
$$;

create trigger trg_goal_movements_apply
  after insert or update on public.goal_movements
  for each row execute function private.trg_apply_goal_movement();

-- ============================================================
-- loan_payments: identity lock + atomic application to loans.paid
-- ============================================================

create function private.trg_lock_loan_payment_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    new.created_by := auth.uid();
  elsif TG_OP = 'UPDATE' then
    new.id := old.id;
    new.household_id := old.household_id;
    new.loan_id := old.loan_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger trg_loan_payments_identity
  before insert or update on public.loan_payments
  for each row execute function private.trg_lock_loan_payment_identity();
create trigger trg_loan_payments_touch
  before update on public.loan_payments
  for each row execute function private.trg_touch_updated_at();

-- Same atomic-cache pattern as goals.saved, guarded by
-- loans_paid_within_principal (paid >= 0 and paid <= principal).
create function private.trg_apply_loan_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    if new.deleted_at is null then
      update public.loans set paid = paid + new.principal_part where id = new.loan_id;
    end if;
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      update public.loans set paid = paid - old.principal_part where id = new.loan_id;
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.loans set paid = paid + new.principal_part where id = new.loan_id;
    elsif old.deleted_at is null and new.deleted_at is null
          and old.principal_part is distinct from new.principal_part then
      update public.loans
        set paid = paid - old.principal_part + new.principal_part
        where id = new.loan_id;
    end if;
    return new;
  end if;

  return new;
end;
$$;

create trigger trg_loan_payments_apply
  after insert or update on public.loan_payments
  for each row execute function private.trg_apply_loan_payment();

-- ============================================================
-- household_settings — updated_by/updated_at/household_id are always
-- server-forced; the client-writable columns (notes, cat_order_expense,
-- cat_order_income) are enforced at the grant level in
-- 20260905000400_rls.sql, not here.
-- ============================================================

create function private.trg_household_settings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.household_id := old.household_id;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_household_settings_guard
  before update on public.household_settings
  for each row execute function private.trg_household_settings_guard();

-- ============================================================
-- Cross-household FK prevention (STEP 16-B2 §2 / STEP 16-C §2)
--
-- Each child column is paired with household_id in a composite FK against
-- the parent's (household_id, id) unique constraint (declared alongside
-- the parent table in 20260905000100_identity.sql /
-- 20260905000200_household_data.sql). A row can only reference a parent
-- that belongs to the SAME household_id it itself carries — attaching a
-- goal_id/loan_id/card_id/etc. from a different household is rejected by
-- the FK itself, not by application code.
--
-- ON DELETE:
--  - transactions' four optional references use NO ACTION. Dondon never
--    hard-deletes cards/recurring_rules/planned_expenses/household_members
--    through a normal client path (soft delete via deleted_at only), so
--    this never fires in practice; if a parent ever is hard-deleted (e.g.
--    a future admin/service_role maintenance job), NO ACTION makes that
--    delete fail loudly instead of silently orphaning/nulling references —
--    SET NULL was rejected because household_id is NOT NULL and a
--    composite SET NULL would try to null it too.
--  - goal_movements -> goals and loan_payments -> loans use CASCADE: a
--    movement/payment is a genuine child component of its goal/loan, not
--    an independent record, so it should disappear if its parent does.
--
-- Cascade-safety check (household deletion): every table here also has
-- its own direct `household_id references households(id) on delete
-- cascade`. Deleting a household cascades to ALL of transactions, cards,
-- recurring_rules, planned_expenses, goals, goal_movements, loans,
-- loan_payments, budgets, custom_categories, household_settings,
-- household_members and invites in the SAME statement, because every one
-- of them independently cascades from households.id. So a transaction row
-- and the card row it composite-references are removed together in that
-- one cascading DELETE — the NO ACTION composite FK on
-- transactions.card_id never sees a dangling reference to check against.
-- (households has no DELETE RLS policy in this design, so this path is
-- currently unreachable from the client at all — noted here for the
-- future admin/service_role case, and worth an empirical check in the
-- STEP that first runs this against a real database.)
-- ============================================================

alter table public.transactions
  add constraint transactions_member_fk
    foreign key (household_id, member_id)
    references public.household_members (household_id, id)
    on delete no action,
  add constraint transactions_card_fk
    foreign key (household_id, card_id)
    references public.cards (household_id, id)
    on delete no action,
  add constraint transactions_recurring_fk
    foreign key (household_id, from_recurring)
    references public.recurring_rules (household_id, id)
    on delete no action,
  add constraint transactions_planned_fk
    foreign key (household_id, from_planned)
    references public.planned_expenses (household_id, id)
    on delete no action;

alter table public.goal_movements
  add constraint goal_movements_goal_fk
    foreign key (household_id, goal_id)
    references public.goals (household_id, id)
    on delete cascade;

alter table public.loan_payments
  add constraint loan_payments_loan_fk
    foreign key (household_id, loan_id)
    references public.loans (household_id, id)
    on delete cascade;
