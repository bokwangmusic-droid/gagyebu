-- ============================================================
-- 20260905000500_realtime.sql
-- STEP 16-C — Realtime (Postgres Changes) publication
--
-- Realtime here is convenience only: it makes a change show up on the
-- other spouse's phone quickly while both apps are open. It is NOT the
-- system of record for correctness.
--
-- Dondon never hard-deletes rows in these tables through a normal client
-- path — every delete is a soft delete via an UPDATE that sets
-- deleted_at, which arrives to subscribers as an UPDATE event carrying a
-- complete NEW row that RLS can filter normally. Hard DELETE events are
-- therefore not part of this design's correctness story at all: with RLS
-- enabled, a DELETE event's replication payload is not guaranteed to
-- carry every column a policy might need (household_id included) the way
-- a normal SELECT does, so no client logic here should ever depend on
-- receiving/parsing a DELETE payload correctly. REPLICA IDENTITY FULL is
-- set below only as a mild, optional improvement (e.g. for future old-
-- record debugging) — never treat it as a correctness guarantee for
-- RLS-filtered realtime.
--
-- The final source of truth is always the next pull sync (on app launch /
-- foreground), independent of whether Realtime delivered anything.
-- ============================================================

alter table public.transactions       replica identity full;
alter table public.budgets            replica identity full;
alter table public.recurring_rules    replica identity full;
alter table public.planned_expenses   replica identity full;
alter table public.cards              replica identity full;
alter table public.goals              replica identity full;
alter table public.goal_movements     replica identity full;
alter table public.loans              replica identity full;
alter table public.loan_payments      replica identity full;
alter table public.household_members  replica identity full;
alter table public.custom_categories  replica identity full;
alter table public.household_settings replica identity full;

alter publication supabase_realtime add table
  public.transactions,
  public.budgets,
  public.recurring_rules,
  public.planned_expenses,
  public.cards,
  public.goals,
  public.goal_movements,
  public.loans,
  public.loan_payments,
  public.household_members,
  public.custom_categories,
  public.household_settings;

-- invites and profiles are intentionally NOT published: invites carries a
-- code_hash and has no real-time UX need, profiles is personal data. Their
-- changes reach clients only through the next pull sync.
