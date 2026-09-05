-- ============================================================
-- 20260905000400_rls.sql
-- STEP 16-C1 — RLS helper functions, row policies, explicit table/column
-- grants
--
-- RLS itself is already ON for all 15 tables (enabled at CREATE TABLE
-- time in 20260905000100_identity.sql / 20260905000200_household_data.sql)
-- — this file adds no `enable row level security` statements, only
-- policies. Before this file runs, every one of these tables has RLS on
-- and zero policies, which is fail-closed by construction (RLS-on + no
-- policy = no role, anon included, can see or write any row through the
-- Data API). This file is what opens up exactly the access `authenticated`
-- needs; anon gets nothing anywhere below.
--
-- Three independent, all-required security layers (STEP 16-C1 §2/§9):
--   1. RLS policies         -> which ROWS a role may see/insert/update
--   2. Table-level GRANT     -> whether a role may touch the table at all
--      (explicit REVOKE ALL + targeted re-GRANT per table, below — we do
--      not rely on whatever Supabase's project-default privileges are)
--   3. Column-level GRANT   -> which COLUMNS a role may reference in an
--      INSERT/UPDATE statement, checked before RLS even runs
-- `service_role` is never touched by any REVOKE/GRANT in this file — it
-- keeps whatever full access it already has.
--
-- private.is_household_member / private.is_household_owner run
-- SECURITY DEFINER (as the table owner) specifically so that
-- household_members' own RLS policy can call them without recursing back
-- into household_members' RLS. Because of that, household_members (and
-- every other table these helpers query) must NEVER get
-- `FORCE ROW LEVEL SECURITY` — forcing it would make the table owner
-- subject to RLS again inside the SECURITY DEFINER call and reintroduce
-- the recursion.
-- ============================================================

-- ---------- RLS helper functions ----------

create function private.is_household_member(hid uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = hid and hm.user_id = auth.uid()
  );
$$;

create function private.is_household_owner(hid uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = hid and hm.user_id = auth.uid() and hm.role = 'owner'
  );
$$;

revoke all on function private.is_household_member(uuid) from public;
revoke all on function private.is_household_owner(uuid) from public;
grant execute on function private.is_household_member(uuid) to authenticated;
grant execute on function private.is_household_owner(uuid) to authenticated;

-- RLS was already enabled on all 15 tables in 20260905000100_identity.sql /
-- 20260905000200_household_data.sql. Deliberately no
-- FORCE ROW LEVEL SECURITY anywhere — see file header.

-- ---------- profiles ----------
-- Self only. A spouse's display name for the shared ledger comes from
-- household_members.display_name, not from profiles. Only display_name is
-- client-writable: id is the PK (mirrors auth.users.id), email mirrors
-- auth.users.email (Supabase Auth is the source of truth for it, not a
-- value a client should be able to overwrite directly), created_at is
-- immutable history. No INSERT/DELETE grant — the row is created solely by
-- private.handle_new_user() (SECURITY DEFINER), which runs as the table
-- owner regardless of what's granted to authenticated/anon here.

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- households ----------
-- SELECT includes `created_by = auth.uid()` in addition to
-- is_household_member(id) so the creator can always see the household
-- they just created without depending on trigger-firing/RETURNING
-- ordering relative to handle_new_household()'s household_members insert.
-- UPDATE is owner-only at the row level; column grants further restrict
-- it to `name` only (id/created_by/created_at are immutable) — this alone
-- is simple enough that no extra lock trigger is needed here.

revoke all on public.households from anon, authenticated;
grant select, insert on public.households to authenticated;
grant update (name) on public.households to authenticated;

create policy households_select on public.households
  for select to authenticated
  using (created_by = auth.uid() or private.is_household_member(id));

create policy households_insert on public.households
  for insert to authenticated
  with check (created_by = auth.uid());

create policy households_update on public.households
  for update to authenticated
  using (private.is_household_owner(id))
  with check (private.is_household_owner(id));

-- ---------- household_members ----------
-- SELECT only. No INSERT/UPDATE/DELETE policy exists for this table at
-- all — rows are created solely by handle_new_household() (owner
-- bootstrap) or, in a future step, an invite-redeem SECURITY DEFINER RPC.
-- This is the fix for STEP 16-B's role-escalation hole: with no UPDATE
-- policy, a member cannot promote themselves to owner, change another
-- member's role, or edit household_id/user_id/joined_at, because there is
-- no UPDATE path into this table whatsoever. With no DELETE policy, a
-- member cannot remove themselves or anyone else, so a last-owner-leaves
-- situation can't be triggered directly either. Self-service display-name
-- editing, promotion/demotion, removal and leaving are all deferred to a
-- future atomic RPC (STEP 16-D).

revoke all on public.household_members from anon, authenticated;
grant select on public.household_members to authenticated;

create policy household_members_select on public.household_members
  for select to authenticated
  using (private.is_household_member(household_id));

-- ---------- invites ----------
-- SELECT: any household member (so both spouses can see invite status).
-- INSERT: owner only, created_by forced to match the caller.
-- No UPDATE, no DELETE policy: redeeming (used_by/used_at) and revoking
-- (revoked_at) are NOT client UPDATE paths in this step — both will be
-- implemented as an atomic SECURITY DEFINER RPC later (STEP 16-D). With
-- no UPDATE policy at all, a client can't touch code_hash, household_id,
-- created_by, expires_at, used_by, used_at or revoked_at directly.

revoke all on public.invites from anon, authenticated;
grant select, insert on public.invites to authenticated;

create policy invites_select on public.invites
  for select to authenticated
  using (private.is_household_member(household_id));

create policy invites_insert on public.invites
  for insert to authenticated
  with check (private.is_household_owner(household_id) and created_by = auth.uid());

-- ---------- household_settings ----------
-- Row-level: any household member. Column-level: only notes/
-- cat_order_expense/cat_order_income are client-writable — household_id,
-- updated_by and updated_at are excluded from the grant entirely (and are
-- also force-set by trg_household_settings_guard regardless).

revoke all on public.household_settings from anon, authenticated;
grant select on public.household_settings to authenticated;
grant update (notes, cat_order_expense, cat_order_income) on public.household_settings to authenticated;

create policy household_settings_select on public.household_settings
  for select to authenticated
  using (private.is_household_member(household_id));

create policy household_settings_update on public.household_settings
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- ---------- shared household data: common SELECT/INSERT/UPDATE pattern ----------
-- custom_categories, cards, recurring_rules, planned_expenses,
-- transactions, goal_movements, loan_payments: household members can read
-- and write each other's rows (this is the whole point of a shared
-- ledger), created_by on INSERT must match the caller (also enforced by
-- trg_lock_identity / trg_lock_goal_movement_identity /
-- trg_lock_loan_payment_identity), and there is no DELETE policy anywhere
-- — every delete is a soft delete via an UPDATE that sets deleted_at.
-- goals, loans and budgets follow the same SELECT/INSERT/UPDATE shape but
-- additionally get column-level UPDATE restrictions below.

revoke all on public.custom_categories from anon, authenticated;
grant select, insert, update on public.custom_categories to authenticated;

create policy custom_categories_select on public.custom_categories
  for select to authenticated using (private.is_household_member(household_id));
create policy custom_categories_insert on public.custom_categories
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy custom_categories_update on public.custom_categories
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

revoke all on public.cards from anon, authenticated;
grant select, insert, update on public.cards to authenticated;

create policy cards_select on public.cards
  for select to authenticated using (private.is_household_member(household_id));
create policy cards_insert on public.cards
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy cards_update on public.cards
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

revoke all on public.recurring_rules from anon, authenticated;
grant select, insert, update on public.recurring_rules to authenticated;

create policy recurring_rules_select on public.recurring_rules
  for select to authenticated using (private.is_household_member(household_id));
create policy recurring_rules_insert on public.recurring_rules
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy recurring_rules_update on public.recurring_rules
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

revoke all on public.planned_expenses from anon, authenticated;
grant select, insert, update on public.planned_expenses to authenticated;

create policy planned_expenses_select on public.planned_expenses
  for select to authenticated using (private.is_household_member(household_id));
create policy planned_expenses_insert on public.planned_expenses
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy planned_expenses_update on public.planned_expenses
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- transactions' UPDATE grant stays blanket (not column-restricted): the
-- provenance columns (from_recurring/recurring_occurrence_date/
-- from_planned) are protected by trg_lock_transaction_provenance() instead
-- (20260905000300_integrity_triggers.sql), because most of this table's
-- other columns (amount/memo/category/date/payment_method/card_id/
-- installment_months/splits/tags) are legitimately editable and an
-- allow-list here would just duplicate that trigger's job.
revoke all on public.transactions from anon, authenticated;
grant select, insert, update on public.transactions to authenticated;

create policy transactions_select on public.transactions
  for select to authenticated using (private.is_household_member(household_id));
create policy transactions_insert on public.transactions
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy transactions_update on public.transactions
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- amount_delta/memo stay editable; id/household_id/goal_id/created_by/
-- created_at are locked by trg_lock_goal_movement_identity(), not by a
-- column grant restriction.
revoke all on public.goal_movements from anon, authenticated;
grant select, insert, update on public.goal_movements to authenticated;

create policy goal_movements_select on public.goal_movements
  for select to authenticated using (private.is_household_member(household_id));
create policy goal_movements_insert on public.goal_movements
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy goal_movements_update on public.goal_movements
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- amount/principal_part/interest_part/memo/date stay editable; id/
-- household_id/loan_id/created_by/created_at are locked by
-- trg_lock_loan_payment_identity(), not by a column grant restriction.
revoke all on public.loan_payments from anon, authenticated;
grant select, insert, update on public.loan_payments to authenticated;

create policy loan_payments_select on public.loan_payments
  for select to authenticated using (private.is_household_member(household_id));
create policy loan_payments_insert on public.loan_payments
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy loan_payments_update on public.loan_payments
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- ---------- goals ----------
-- saved is excluded from the UPDATE grant entirely: only
-- trg_apply_goal_movement() (SECURITY DEFINER, runs as the table owner)
-- can change it. A client UPDATE that includes `saved` in its SET list is
-- rejected outright by the column privilege check, before RLS is even
-- evaluated — no pg_trigger_depth()-based trickery needed or used.
-- Editable columns matched against the actual app code (app/goal-add.tsx,
-- app/goals.tsx): name, target, deadline, icon; deleted_at is added for
-- the future soft-delete sync path.

revoke all on public.goals from anon, authenticated;
grant select, insert on public.goals to authenticated;
grant update (name, target, deadline, icon, deleted_at) on public.goals to authenticated;

create policy goals_select on public.goals
  for select to authenticated using (private.is_household_member(household_id));
create policy goals_insert on public.goals
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy goals_update on public.goals
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- ---------- loans ----------
-- paid is excluded the same way saved is on goals — only
-- trg_apply_loan_payment() can change it. Editable columns matched against
-- the actual app code (app/loan-add.tsx; the store's updateLoan() action
-- accepts these fields even though no edit screen calls it yet).

revoke all on public.loans from anon, authenticated;
grant select, insert on public.loans to authenticated;
grant update (
  name, lender, principal, annual_rate, term_months,
  start_date, payment_day, repay_type, deleted_at
) on public.loans to authenticated;

create policy loans_select on public.loans
  for select to authenticated using (private.is_household_member(household_id));
create policy loans_insert on public.loans
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy loans_update on public.loans
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- ---------- budgets ----------
-- category_id/household_id are this row's identity (composite PK) and are
-- excluded from the UPDATE grant — changing a budget's category is
-- modelled as soft-delete-old-row + insert-new-row, never an in-place
-- identity move. Only amount/deleted_at are directly editable.

revoke all on public.budgets from anon, authenticated;
grant select, insert on public.budgets to authenticated;
grant update (amount, deleted_at) on public.budgets to authenticated;

create policy budgets_select on public.budgets
  for select to authenticated using (private.is_household_member(household_id));
create policy budgets_insert on public.budgets
  for insert to authenticated
  with check (private.is_household_member(household_id) and created_by = auth.uid());
create policy budgets_update on public.budgets
  for update to authenticated
  using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));
