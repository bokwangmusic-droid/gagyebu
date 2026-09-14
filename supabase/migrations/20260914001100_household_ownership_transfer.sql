-- ============================================================
-- 20260914001100_household_ownership_transfer.sql
-- STEP AUTH-F2-A — household ownership transfer RPC
--
-- Adds ONE new RPC, public.transfer_household_ownership(household_id,
-- target_user_id), on top of the unmodified existing schema. Does not
-- touch household_members' own grants/policies (20260905000400_rls.sql) —
-- it still has no client INSERT/UPDATE/DELETE path at all; this function
-- writes to it as the table owner (SECURITY DEFINER), exactly the same
-- mechanism private.handle_new_household() / redeem_household_invite()
-- (20260905000300 / 20260905000600) already use for the same reason.
--
-- WHY this is needed now (STEP AUTH-F2 account-deletion policy): a sole
-- owner of a household with other members present must transfer ownership
-- to one of them BEFORE their account can be deleted (owner+co-member
-- households cannot simply cascade the owner's membership away — nobody
-- would be left who can manage the household or issue invites). No
-- promotion/demotion path existed anywhere in this schema before this
-- migration (see 20260905000400_rls.sql's own household_members section:
-- "promotion/demotion... deferred to a future atomic RPC").
--
-- Security shape (mirrors create_household_invite/redeem_household_invite
-- exactly):
--   - SECURITY DEFINER, set search_path = '' (never inherits the caller's
--     search_path), every relation referenced fully schema-qualified
--     (public.households, public.household_members) — the same hardening
--     already applied to every other SECURITY DEFINER function in this
--     project (STEP 16-B2/16-C §10, restated in 20260905000300's header).
--   - Ownership is verified SERVER-SIDE via the existing
--     private.is_household_owner() helper (20260905000400_rls.sql, reused
--     as-is, not redefined) — the caller cannot claim ownership merely by
--     passing a household_id they are not the owner of.
--   - The target must already be a member of THIS SAME household — an
--     explicit `for update` row lookup against household_members, not a
--     client-asserted role/household pairing. A client cannot name an
--     arbitrary user_id from a different household and have it accepted.
--   - Self-transfer (target = caller) is rejected explicitly, before any
--     row is touched.
--   - The caller can never pass a `role` value at all — this function's
--     signature takes only (household_id, target_user_id); the two role
--     values it writes ('member' for the caller, 'owner' for the target)
--     are hard-coded literals in the function body, not client input, so
--     there is no privilege-escalation surface via a role parameter.
--   - Atomicity: a single PL/pgSQL function invocation is one Postgres
--     transaction — the demote-caller and promote-target UPDATEs either
--     both commit or neither does. Between them, no OTHER transaction can
--     observe an intermediate zero-owner state for this household: the
--     `select ... for update` on the households row below takes an
--     exclusive lock for the whole duration of this function, and
--     household_members has no other client write path (INSERT is invite-
--     redeem only, UPDATE has no policy anywhere) that could race a role
--     change in between — the ONLY way `role` ever changes is this
--     function itself, and this function serializes on that same
--     households-row lock across concurrent calls for the same household
--     (identical reasoning to create_household_invite's own locking
--     comment, 20260905000600_household_rpcs.sql).
-- ============================================================

create function public.transfer_household_ownership(
  p_household_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_locked_household_id uuid;
  v_target_member_id uuid;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if p_target_user_id = v_uid then
    raise exception 'CANNOT_TRANSFER_TO_SELF' using errcode = 'P0001';
  end if;

  -- Lock the household row for the duration of this transaction — same
  -- purpose as create_household_invite's identical lock: serializes
  -- concurrent calls against the SAME household so the demote/promote pair
  -- below can never interleave with another transfer attempt (or, since
  -- there is no other write path into household_members.role at all, with
  -- anything else that could change ownership).
  select h.id into v_locked_household_id
  from public.households h
  where h.id = p_household_id
  for update;

  if v_locked_household_id is null then
    raise exception 'HOUSEHOLD_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Server-side ownership check — the caller cannot assert ownership
  -- merely by passing a household_id; private.is_household_owner() reads
  -- household_members directly against auth.uid(), the same helper
  -- households_update's own RLS policy relies on.
  if not private.is_household_owner(p_household_id) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  -- Target must already be a member of THIS household. `for update` locks
  -- their row too, so a concurrent (impossible today, since there is no
  -- other write path, but kept for defense-in-depth) change to their row
  -- can't land between this check and the UPDATE below.
  select hm.user_id into v_target_member_id
  from public.household_members hm
  where hm.household_id = p_household_id and hm.user_id = p_target_user_id
  for update;

  if v_target_member_id is null then
    raise exception 'TARGET_NOT_MEMBER' using errcode = 'P0002';
  end if;

  -- Demote caller, promote target — both inside this one transaction.
  -- CORRECTED (post-audit): a single PL/pgSQL FUNCTION (not a PROCEDURE)
  -- has no way to COMMIT/ROLLBACK internally — both UPDATEs below run as
  -- part of the ONE transaction the calling PostgREST request already
  -- opened. If the second UPDATE raises for any reason (or the connection/
  -- server crashes before this function returns), the WHOLE transaction
  -- aborts and Postgres rolls back the first UPDATE too — there is no
  -- three-way outcome here, only "both applied" or "neither applied,
  -- caller is still owner". A permanent zero-owner state can never result
  -- from this function alone.
  --
  -- The order (demote first, promote second) is still deliberately kept —
  -- but the real reason is compatibility with the
  -- ux_household_members_one_owner partial unique index added below: a
  -- promote-then-demote order would momentarily create a SECOND 'owner'
  -- row for this household after the first statement, which that index
  -- would reject outright (aborting the transaction with a constraint
  -- violation before the demote statement ever ran). Demote-then-promote
  -- never has more than one owner row at any point a statement boundary
  -- is checked, so it satisfies the index by construction.
  update public.household_members
  set role = 'member'
  where household_id = p_household_id and user_id = v_uid;

  update public.household_members
  set role = 'owner'
  where household_id = p_household_id and user_id = p_target_user_id;
end;
$$;

revoke all on function public.transfer_household_ownership(uuid, uuid) from public;
revoke all on function public.transfer_household_ownership(uuid, uuid) from anon;
grant execute on function public.transfer_household_ownership(uuid, uuid) to authenticated;

-- ============================================================
-- DB-level safety net: at most one 'owner' row per household.
--
-- Added after an audit found no such constraint anywhere in the schema —
-- exactly-one-owner was previously guaranteed ONLY by the fact that every
-- write path to household_members.role (audited exhaustively across every
-- migration in this project: private.handle_new_household()'s bootstrap
-- INSERT, redeem_household_invite()'s member INSERT, and
-- transfer_household_ownership() above) happens to preserve it. That
-- remains true today, but nothing at the database level would catch a
-- FUTURE write path that didn't. This index makes the invariant
-- self-enforcing regardless of what application code does next.
--
-- IMPORTANT — this guarantees AT MOST one owner per household, NEVER AT
-- LEAST one. A household with zero 'owner' rows (e.g. mid-transaction
-- inside transfer_household_ownership, invisible to every other
-- transaction; or, hypothetically, if every member ever left without a
-- transfer — not reachable via any client path today) does not violate
-- this index at all. Enforcing a minimum is a materially different,
-- harder constraint (it cannot be expressed as a single-table index at
-- all — it would need a deferred constraint trigger checking all rows for
-- a given household_id) and is out of scope here.
--
-- Migration-safety: a `do` block below checks the CURRENT data for any
-- pre-existing violation before the index is created, so a genuine
-- historical violation fails this migration with a clear, actionable
-- message instead of an opaque "could not create unique index" error from
-- Postgres itself. Given the exhaustive write-path audit above, this is
-- expected to always report zero rows on this project's existing data.
--
-- Compatibility with transfer_household_ownership(): already analyzed in
-- that function's own body comment above — its demote-then-promote
-- statement order never creates a second 'owner' row for the same
-- household at any point this index would check, so it continues to work
-- unmodified. Existing role CHECK constraint and every RLS policy are
-- untouched by this migration.
-- ============================================================

do $$
declare
  v_bad_count int;
begin
  select count(*) into v_bad_count
  from (
    select household_id
    from public.household_members
    where role = 'owner'
    group by household_id
    having count(*) > 1
  ) dup;

  if v_bad_count > 0 then
    raise exception 'MIGRATION_PRECONDITION_FAILED: % household(s) already have more than one owner row', v_bad_count;
  end if;
end $$;

create unique index ux_household_members_one_owner
  on public.household_members (household_id)
  where role = 'owner';
