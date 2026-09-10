-- ============================================================
-- 20260910001000_delete_custom_category_with_budget.sql
-- STEP 16-H2 — CATEGORY DELETE WITH BUDGET A1: atomic server contract only.
--
-- Adds ONE new RPC, public.delete_custom_category_with_budget(...), that
-- soft-deletes a custom category AND its (optional) related budget row in
-- ONE Postgres transaction — either both happen or NEITHER does. It does
-- NOT replace or change the existing single-entity write paths
-- (softDeleteCustomCategory / softDeleteBudget, both client-side, both
-- still calling plain `.update(...)` against custom_categories/budgets
-- directly) — those are untouched, still used elsewhere, and this
-- migration adds no constraint/trigger/grant change to either table.
--
-- WHY an RPC at all, given `authenticated` already has UPDATE grants on
-- both tables (20260905000400_rls.sql): NOT for privilege escalation —
-- purely for ATOMICITY. Two independent client PostgREST calls (category
-- delete, then budget delete) can leave "category deleted, budget still
-- active" if the second call fails after the first succeeds (transport
-- drop, conflict, app kill) — see STEP 16-H2 audit. This function performs
-- both writes inside one transaction so that outcome becomes impossible.
--
-- SECURITY INVOKER (the Postgres default — no `security definer` below),
-- deliberately NOT SECURITY DEFINER: unlike
-- create_household_invite/redeem_household_invite (20260905000600, which
-- write to household_members/invites — tables `authenticated` has ZERO
-- grant on), there is no privilege gap here for a DEFINER function to
-- bridge. Running as INVOKER means every `select ... for update` and
-- `update ...` inside this function is STILL filtered by
-- custom_categories_select/update and budgets_select/update RLS exactly as
-- if the client had issued them directly — RLS stays the real authorization
-- boundary (matches this project's stated three-layer security model), and
-- the explicit NOT_MEMBER check below exists only to turn "RLS silently
-- hid/blocked it" into a clean, specific error message, not to grant any
-- access RLS wouldn't already grant.
--
-- Natural-key isolation (STEP 16-H2 audit §12): budgets.category_id is a
-- plain shared-namespace text column, NOT a foreign key to
-- custom_categories.id (built-in categories have no custom_categories row
-- at all). This function only ever touches the exact
-- (household_id, category_id) pair supplied — never a LIKE/wildcard match —
-- so it can only reach the ONE budget row that shares that exact key, in
-- that exact household. A built-in category id simply matches no
-- custom_categories row -> CATEGORY_NOT_FOUND, so this path can never
-- delete a built-in category (there is no client UI for that either).
--
-- Validation-before-mutation (STEP 16-H2 audit §6): every optimistic-
-- concurrency / existence check below runs to completion, locking both
-- target rows (`for update`, category first then budget — a fixed order,
-- so two concurrent calls on the same pair can never deadlock each other)
-- BEFORE any `update` statement is issued. A conflict always `raise
-- exception`s before either row is touched — this is a structural
-- guarantee (mutation is textually the LAST thing in the function body),
-- not an accident of Postgres's implicit per-call transaction/rollback.
-- ============================================================

create function public.delete_custom_category_with_budget(
  p_household_id uuid,
  p_category_id text,
  -- The active custom category's `updated_at` at the moment the user
  -- confirmed delete. Required — there is no "category didn't exist"
  -- case for this argument (the client only offers delete on a category it
  -- has just displayed as live).
  p_expected_category_updated_at timestamptz,
  -- STEP 16-H2 audit §3 — optimistic-concurrency intent, NOT "budget
  -- existence is irrelevant":
  --   non-null = "an ACTIVE budget existed for this category at
  --              delete-intent time, with exactly this `updated_at`."
  --   null     = "NO active budget existed for this category at
  --              delete-intent time." A NEW active budget appearing before
  --              this call runs is exactly as much a conflict as a changed
  --              token would be for the non-null case — see below.
  p_expected_budget_updated_at timestamptz default null
)
returns table (
  category_deleted_at timestamptz,
  -- null when there never was a budget to delete (no row existed and none
  -- appeared); otherwise the timestamp its `deleted_at` now holds — either
  -- freshly set by THIS call, or an EXISTING tombstone's own timestamp
  -- (ours from an earlier successful attempt whose response was lost, or
  -- another device's earlier delete — STEP 16-H2 audit A1.1 §3: a
  -- tombstone is accepted as-is, never token-checked).
  budget_deleted_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_category public.custom_categories%rowtype;
  v_budget public.budgets%rowtype;
  v_budget_found boolean;
  v_category_deleted_at timestamptz;
  v_budget_deleted_at timestamptz;
  v_mutate_category boolean;
  v_mutate_budget boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if not private.is_household_member(p_household_id) then
    raise exception 'NOT_MEMBER' using errcode = '42501';
  end if;

  -- ---------------- 1. validate the category (lock first) ----------------
  select c.* into v_category
  from public.custom_categories c
  where c.id = p_category_id and c.household_id = p_household_id
  for update;

  if not found then
    -- Covers: no such id at all, a BUILT-IN category id (never has a row
    -- here), and a category id that belongs to a DIFFERENT household.
    raise exception 'CATEGORY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_category.deleted_at is not null then
    -- Already gone — either this exact delete-intent's own earlier attempt
    -- (response lost, safe to treat as done) or a legacy/other-device
    -- delete. Either way there is nothing further to validate/mutate on
    -- the category side; `updated_at` is NOT re-checked here (matches the
    -- existing softDeleteCustomCategory 0-row reconcile's own rule: an
    -- already-deleted row is unconditionally idempotent-success, STEP
    -- 16-H2 audit §9 first paragraph — deleted-is-deleted, no partial
    -- "wrongly deleted" state exists for a one-way soft delete).
    v_mutate_category := false;
    v_category_deleted_at := v_category.deleted_at;
  else
    if v_category.updated_at <> p_expected_category_updated_at then
      raise exception 'CATEGORY_CONFLICT' using errcode = 'P0001';
    end if;
    v_mutate_category := true; -- v_category_deleted_at filled in at mutation time
  end if;

  -- ---------------- 2. validate the budget (lock second, fixed order) ----
  select b.* into v_budget
  from public.budgets b
  where b.category_id = p_category_id and b.household_id = p_household_id
  for update;
  v_budget_found := found;

  if p_expected_budget_updated_at is null then
    -- STEP 16-H2 audit §3 — "no active budget at intent time" is itself an
    -- optimistic-concurrency claim. A row that doesn't exist, or exists but
    -- is already a tombstone, both satisfy "no ACTIVE budget" and need no
    -- mutation. A row that exists and is ACTIVE means one appeared since
    -- the client's snapshot -> conflict, and NEITHER table gets touched
    -- (the category conflict-check above already passed, but we still
    -- raise here BEFORE any `update` runs).
    if v_budget_found and v_budget.deleted_at is null then
      raise exception 'BUDGET_CONFLICT' using errcode = 'P0001';
    end if;
    v_mutate_budget := false;
    v_budget_deleted_at := case when v_budget_found then v_budget.deleted_at else null end;
  else
    if not v_budget_found then
      -- Defensive / near-unreachable: budgets are never hard-deleted, so a
      -- client that captured a real token should always find *some* row
      -- here. Treat as a conflict rather than silently accepting a token
      -- that names a row this transaction can't see.
      raise exception 'BUDGET_NOT_FOUND' using errcode = 'P0002';
    end if;

    if v_budget.deleted_at is not null then
      -- STEP 16-H2 audit A1.1 FIX — already a tombstone. `updated_at` is
      -- deliberately NOT compared here (unlike the active branch below).
      -- A soft delete itself stamps a fresh `updated_at` via
      -- trg_budgets_touch, so a frozen token captured while the row was
      -- still ACTIVE can NEVER equal a tombstone's `updated_at` — not even
      -- for our OWN successful delete whose response was lost. Requiring
      -- token equality here would make a plain response-loss retry of a
      -- SUCCESSFUL delete fail as a false conflict every single time. The
      -- fact that `deleted_at IS NOT NULL` already IS the delete intent's
      -- desired end-state — no token can add or remove confidence in that,
      -- so none is needed (mirrors the category side's identical rule
      -- above). Idempotent no-op; the row is left exactly as-is.
      v_mutate_budget := false;
      v_budget_deleted_at := v_budget.deleted_at;
    else
      -- ACTIVE — this branch is what actually protects a concurrently
      -- edited OR revived budget (STEP 16-H2 audit A1.1 §4 case 2 and case
      -- 3): once a budget is active again — whether it was never deleted,
      -- or was deleted-then-revived by another device — it needs a
      -- CURRENT matching token, full stop. The frozen token from a client
      -- whose own delete already succeeded once (case 1) never reaches
      -- this branch at all, because that budget is a tombstone by then.
      if v_budget.updated_at <> p_expected_budget_updated_at then
        raise exception 'BUDGET_CONFLICT' using errcode = 'P0001';
      end if;
      v_mutate_budget := true; -- v_budget_deleted_at filled in at mutation time
    end if;
  end if;

  -- ---------------- 3. mutate — only reached once BOTH validations above
  -- have fully passed without raising. Same `v_now` for both rows. ----
  if v_mutate_category then
    update public.custom_categories
    set deleted_at = v_now
    where id = p_category_id and household_id = p_household_id;
    v_category_deleted_at := v_now;
  end if;

  if v_mutate_budget then
    update public.budgets
    set deleted_at = v_now
    where category_id = p_category_id and household_id = p_household_id;
    v_budget_deleted_at := v_now;
  end if;

  return query select v_category_deleted_at, v_budget_deleted_at;
end;
$$;

revoke all on function public.delete_custom_category_with_budget(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.delete_custom_category_with_budget(uuid, text, timestamptz, timestamptz) from anon;
grant execute on function public.delete_custom_category_with_budget(uuid, text, timestamptz, timestamptz) to authenticated;
