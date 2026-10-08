-- ============================================================
-- 20261008002100_household_reset_serialized_verdict.sql
-- Makes the outcome of reset_household_finance_data() DECIDABLE when its
-- reply is lost, and makes household_settings.data_reset_at strictly
-- monotonic. Self-contained: 20261008002000 is not edited.
--
-- This file:
--   1. creates private.household_reset_requests (one row per reset attempt
--      that carried a request id: either "committed" or "closed unused"),
--   2. creates public.reset_household_finance_data(uuid, text) — the
--      request id is REQUIRED,
--   3. creates public.get_household_reset_marker_serialized(uuid, text), and
--   4. LAST, drops the old public.reset_household_finance_data(uuid).
--
-- ---- the problem ----
-- A client that loses the reply of the reset RPC (network drop, gateway
-- 502/504) cannot tell "rolled back" from "committed" from "still running
-- or still waiting for the household lock". Re-reading data_reset_at with a
-- plain SELECT only answers the first two: a reset that is still in flight
-- shows the old marker until it commits, however long the client waits. If
-- the client then lets its offline queue send again, a queued INSERT waits
-- on the household row lock and lands right after the reset commits — data
-- the owner just deleted comes back.
--
-- ---- how the outcome is decided ----
-- get_household_reset_marker_serialized() takes a row lock on the SAME
-- public.households row the reset locks FOR UPDATE, so it cannot return
-- while a reset of that household holds the lock: it waits for that
-- transaction to commit or roll back, and only then reads data_reset_at.
--
-- A lock alone cannot see a reset whose request has not REACHED the lock
-- yet (still in transit, or between BEGIN and its SELECT ... FOR UPDATE).
-- That is what the request id is for. Under the lock, the check either
--   - finds the request's row with committed = true  -> it committed, or
--   - finds none and INSERTS a committed = false row -> the request is
--     closed: when that reset finally gets the lock it finds this row and
--     raises RESET_REQUEST_CLOSED before deleting anything.
-- Both functions read/write that row only while holding the household row
-- lock, so exactly one of them gets there first and the answer the check
-- returns can never be invalidated afterwards. No timeout is involved.
--
-- ---- lock mode ----
-- The check uses FOR KEY SHARE, not FOR UPDATE. FOR KEY SHARE conflicts
-- with FOR UPDATE in both directions (it waits for a running reset / import
-- / ownership transfer, and a reset that starts later waits for it), which
-- is all the serialization needed. It does NOT conflict with other
-- FOR KEY SHARE holders — i.e. with every ordinary client INSERT into a
-- finance table (its household_id FK check) — so a member checking a reset
-- outcome never blocks the household's normal writes. Two concurrent checks
-- of the same request id are harmless: the INSERT is ON CONFLICT DO NOTHING
-- and both then read the same row.
--
-- ---- who may call the check ----
-- Only the household's OWNER — the same rule as the reset itself, checked
-- before the lock and again under it. A plain member gets NOT_OWNER and
-- nothing is read, locked or written for them, so a member can neither
-- close a request nor add rows to private.household_reset_requests.
--
-- A caller who WAS the owner when they sent the reset and is not any more
-- also gets NOT_OWNER. That is still a final state for their request:
-- transfer_household_ownership() takes the same households row FOR UPDATE,
-- so it cannot commit while a reset holds the lock, and once it has
-- committed the reset's own under-lock owner check refuses every reset that
-- arrives later. The request therefore either committed before the
-- transfer — visible in data_reset_at — or never will.
--
-- ---- data_reset_at is now strictly monotonic ----
-- 20261008002000 stamped data_reset_at with v_reset_at := now(), i.e. the
-- transaction's START time, fixed before the household lock was taken. Two
-- resets of one household could therefore commit in the opposite order of
-- their timestamps (the one that started first but got the lock second
-- wrote the OLDER value last), moving the marker backwards — and clients
-- treat an older marker as a stale read, so they would miss that reset.
-- The value is now computed inside the UPDATE, after the lock:
--   greatest(clock_timestamp(), <existing value> + 1 microsecond)
-- clock_timestamp() is the real time of that statement; the second term
-- guarantees "strictly newer than what is stored" even if the server clock
-- steps back. The RPC returns the value actually stored (RETURNING), not a
-- separately computed one.
--
-- ---- security ----
-- Both functions: SECURITY DEFINER, search_path = '', every object
-- schema-qualified, EXECUTE for `authenticated` only. No table grant, RLS
-- policy, trigger or publication is changed. The new table lives in
-- `private`, has RLS enabled with no policy and no client grant: only the
-- two functions (running as the table owner) can touch it.
--
-- ---- replacing the function ----
-- A function's argument list cannot be changed with CREATE OR REPLACE, so
-- the two-argument function is a new object next to the old one. Order:
-- create it and set its privileges, create the check, and only then drop
-- EXACTLY public.reset_household_finance_data(uuid) — no IF EXISTS, no
-- CASCADE, no other overload exists. If any earlier statement fails, the
-- old function is still there untouched. p_request_id has NO default, so
-- the two signatures are never ambiguous while both exist (one named
-- argument resolves to the old one, two to the new one), and after this
-- file a reset without a request id is not callable at all: every reset
-- that can run can also be closed.
-- No released client calls the old signature (the first caller ships with
-- the two-argument call).
-- ============================================================

create table private.household_reset_requests (
  household_id uuid not null references public.households (id) on delete cascade,
  request_id   text not null,
  requested_by uuid,
  -- true: the reset carrying this id committed. false: a check closed the
  -- id before any reset used it; a reset arriving later must not run.
  committed    boolean not null,
  reset_at     timestamptz,
  created_at   timestamptz not null default now(),
  primary key (household_id, request_id),
  constraint household_reset_requests_committed_has_reset_at
    check (committed = (reset_at is not null))
);

alter table private.household_reset_requests enable row level security;
revoke all on private.household_reset_requests from public;
revoke all on private.household_reset_requests from anon;
revoke all on private.household_reset_requests from authenticated;

-- ============================================================
-- reset_household_finance_data
-- ============================================================
--
-- Unchanged from 20261008002000 except:
--   - p_request_id (required): rejected with RESET_REQUEST_CLOSED if a row
--     for it already exists (closed by a check, or already used), recorded
--     as committed on success;
--   - data_reset_at is decided after the lock and is strictly monotonic;
--   - "reset_at" in the result is the value the UPDATE stored.
--
-- Errors: as before, plus
--   INVALID_REQUEST_ID     22023  p_request_id is NULL or not 8..64 characters
--   RESET_REQUEST_CLOSED   P0001  this request id can no longer run
create function public.reset_household_finance_data(
  p_household_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_locked_household_id uuid;
  v_reset_at timestamptz;
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

  if p_request_id is null or char_length(p_request_id) not between 8 and 64 then
    raise exception 'INVALID_REQUEST_ID' using errcode = '22023';
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

  -- Under the lock: has this request been closed by
  -- get_household_reset_marker_serialized(), or already been used?
  if exists (
    select 1
    from private.household_reset_requests r
    where r.household_id = p_household_id
      and r.request_id = p_request_id
  ) then
    raise exception 'RESET_REQUEST_CLOSED' using errcode = 'P0001';
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
  -- are force-set by trg_household_settings_guard (20260905000300), which
  -- does not touch data_reset_at. The marker is decided HERE, after the
  -- lock, and always moves forward; RETURNING hands back the stored value.
  update public.household_settings hs
  set notes = '',
      cat_order_expense = '{}',
      cat_order_income = '{}',
      data_reset_at = greatest(
        clock_timestamp(),
        coalesce(hs.data_reset_at + interval '1 microsecond', clock_timestamp())
      )
  where hs.household_id = p_household_id
  returning hs.data_reset_at into v_reset_at;

  if v_reset_at is null then
    raise exception 'HOUSEHOLD_SETTINGS_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into private.household_reset_requests
    (household_id, request_id, requested_by, committed, reset_at)
  values
    (p_household_id, p_request_id, v_uid, true, v_reset_at);

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

revoke all on function public.reset_household_finance_data(uuid, text) from public;
revoke all on function public.reset_household_finance_data(uuid, text) from anon;
grant execute on function public.reset_household_finance_data(uuid, text) to authenticated;

-- ============================================================
-- get_household_reset_marker_serialized
-- ============================================================
--
-- "What happened to the reset I sent?" — answered only after every reset of
-- this household that already holds the household lock has finished.
--
-- Returns
--   {"data_reset_at": <timestamptz | null>,   -- the household's marker now
--    "committed":     <boolean>,              -- did p_request_id's reset commit
--    "reset_at":      <timestamptz | null>}   -- that reset's marker, if so
-- When "committed" is false, that request id is closed by this very call:
-- it will never commit.
--
-- Errors:
--   AUTH_REQUIRED        28000  no authenticated caller
--   INVALID_REQUEST_ID   22023  p_request_id is NULL or not 8..64 characters
--   NOT_OWNER            42501  caller is not this household's owner
--                               (also: plain member / not a member / unknown id)
--   HOUSEHOLD_NOT_FOUND  P0002  household vanished before the lock
create function public.get_household_reset_marker_serialized(
  p_household_id uuid,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_locked_household_id uuid;
  v_marker timestamptz;
  v_committed boolean := false;
  v_request_reset_at timestamptz;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if p_request_id is null or char_length(p_request_id) not between 8 and 64 then
    raise exception 'INVALID_REQUEST_ID' using errcode = '22023';
  end if;

  -- Pre-lock check: a non-owner never takes the row lock.
  if not private.is_household_owner(p_household_id) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  -- Waits here for a reset (FOR UPDATE) that holds this row.
  select h.id into v_locked_household_id
  from public.households h
  where h.id = p_household_id
  for key share;

  if v_locked_household_id is null then
    raise exception 'HOUSEHOLD_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Authoritative check, now that the household row is locked.
  if not private.is_household_owner(p_household_id) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  -- Close the request unless its reset already committed. From here on a
  -- reset carrying this id finds the row and refuses to run.
  insert into private.household_reset_requests
    (household_id, request_id, requested_by, committed, reset_at)
  values
    (p_household_id, p_request_id, v_uid, false, null)
  on conflict (household_id, request_id) do nothing;

  select r.committed, r.reset_at
  into v_committed, v_request_reset_at
  from private.household_reset_requests r
  where r.household_id = p_household_id
    and r.request_id = p_request_id;

  select hs.data_reset_at into v_marker
  from public.household_settings hs
  where hs.household_id = p_household_id;

  return jsonb_build_object(
    'data_reset_at', v_marker,
    'committed', coalesce(v_committed, false),
    'reset_at', v_request_reset_at
  );
end;
$$;

revoke all on function public.get_household_reset_marker_serialized(uuid, text) from public;
revoke all on function public.get_household_reset_marker_serialized(uuid, text) from anon;
grant execute on function public.get_household_reset_marker_serialized(uuid, text) to authenticated;

-- ============================================================
-- Last: remove the old signature. Exactly (uuid); see the header.
-- ============================================================
drop function public.reset_household_finance_data(uuid);
