-- ============================================================
-- 20260914001200_delete_sole_member_households_rpc.sql
-- STEP AUTH-F2-A (post-audit) — authoritative, race-free account-deletion
-- classification + household hard-delete, as ONE Postgres transaction.
--
-- Replaces supabase/functions/delete-account/index.ts's previous approach
-- (a classification SELECT, then a separate `households` DELETE — two
-- independent PostgREST calls / transactions) with a single SECURITY
-- DEFINER RPC, public.delete_sole_member_households_for_current_user().
-- The Edge Function now only: verifies the caller's JWT, calls this RPC
-- (through a client carrying the CALLER's own JWT, never service_role —
-- see that file's own header for why `auth.uid()` requires this), and
-- either surfaces the RPC's OWNERSHIP_TRANSFER_REQUIRED result as a 409
-- or, on success, calls auth.admin.deleteUser(). No classification or
-- household DELETE logic lives in application code anymore — the
-- database is the sole authority on it.
--
-- ---- TOCTOU race this closes ----
-- The previous two-call design had a real window: between "classification
-- SELECT says household X has 1 member" and "DELETE households WHERE id
-- IN (...)" (two separate transactions), another user could redeem an
-- invite into household X, and the DELETE would still fire, destroying
-- their brand-new membership/data access along with it. This function
-- closes that window by doing the re-count and the DELETE in the SAME
-- transaction, AFTER taking an explicit lock on every relevant household
-- row — see the concurrency analysis below for exactly why that lock is
-- sufficient (no advisory lock, no change to redeem_household_invite()
-- needed).
--
-- ---- lock ordering (deadlock avoidance) ----
-- Every household row this function will touch is locked ONE AT A TIME,
-- in ascending `id` order, via an explicit loop — NOT a single
-- `SELECT ... ORDER BY id FOR UPDATE`. The latter does not actually
-- guarantee locks are acquired in that sorted order: `FOR UPDATE` locks
-- rows as the underlying scan produces them, and a Sort node for the
-- ORDER BY can sit above that scan, so the final output order and the
-- actual lock-acquisition order are not the same thing in general. An
-- explicit loop over a pre-sorted array acquires locks strictly in
-- ascending id order, which is the standard, provably deadlock-safe
-- pattern when multiple transactions may lock overlapping sets of rows:
-- if every transaction that ever locks more than one household always
-- does so in the same global order, a wait-for cycle (the definition of a
-- deadlock) cannot form.
--
-- ---- concurrency analysis vs redeem_household_invite() (unmodified) ----
-- Case 1 — this function locks household X first:
--   `for update` on households.id = X takes Postgres's FOR UPDATE row
--   lock. `redeem_household_invite()` (20260905000600, unchanged) never
--   locks the households row directly, but its
--   `insert into household_members (household_id, ...) values (X, ...)`
--   references households(id) via household_members' existing foreign
--   key — and PostgreSQL's own referential-integrity machinery takes a
--   FOR KEY SHARE lock on the REFERENCED parent row (household X) as part
--   of validating that FK, specifically so the parent cannot be deleted
--   out from under a child insert that is still in flight. FOR KEY SHARE
--   conflicts with FOR UPDATE (Postgres row-lock compatibility: FOR
--   UPDATE conflicts with all four row-lock modes). So that INSERT BLOCKS
--   until this function's transaction commits or rolls back. If we go on
--   to DELETE household X (because our re-count found it still had
--   exactly one member), the now-unblocked INSERT re-validates its FK
--   against a household_id that no longer exists and fails outright with
--   a foreign-key-violation error — a safe, ordinary failure, not silent
--   data corruption. This is real, standard PostgreSQL FK-locking
--   behaviour (see the manual's chapter on explicit locking / foreign
--   keys), not an assumption.
-- Case 2 — redeem_household_invite() commits first:
--   Its INSERT (and the FOR KEY SHARE lock it briefly held on household
--   X) releases the moment that transaction commits. This function's own
--   `for update` on household X, which was blocked waiting, then
--   acquires the lock and proceeds. The re-count query below runs AFTER
--   that point, so it sees the NEWLY joined member: household X's member
--   count is now > 1. If the caller was owner there, X becomes a
--   blocking (OWNERSHIP_TRANSFER_REQUIRED) household for THIS call — the
--   whole account deletion is aborted, never partially applied — exactly
--   the safe, conservative outcome STEP AUTH-F2 policy already calls for
--   when an owner+co-member household is found. If the caller was already
--   a mere member there is nothing this function ever wanted to do to
--   household X in the first place.
-- Both cases are safe with NO changes to redeem_household_invite() and NO
-- advisory lock — the existing FK from household_members to households
-- already provides exactly the serialization needed.
--
-- ---- security shape (same as every other SECURITY DEFINER RPC here) ----
-- search_path = '' (never inherits caller's search_path), every relation
-- fully schema-qualified, no argument accepts a caller-asserted user id —
-- auth.uid() is the only source of "who is calling", exactly like
-- create_household_invite/redeem_household_invite/
-- transfer_household_ownership. PUBLIC/anon revoked, authenticated
-- granted execute — see the bottom of this file.
-- ============================================================

create function public.delete_sole_member_households_for_current_user()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_household_ids uuid[];
  v_hh_id uuid;
  v_blocking_ids uuid[];
  v_sole_ids uuid[];
  v_deleted_ids uuid[];
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select array_agg(hm.household_id) into v_household_ids
  from public.household_members hm
  where hm.user_id = v_uid;

  if v_household_ids is null then
    -- Never joined/created any household — nothing to classify or lock.
    return jsonb_build_object('ok', true, 'deletedHouseholdIds', '[]'::jsonb);
  end if;

  -- Lock every relevant household row, one at a time, in ascending id
  -- order — see this file's own header for why a plain
  -- `ORDER BY ... FOR UPDATE` would not actually guarantee this.
  for v_hh_id in select unnest(v_household_ids) as id order by id loop
    perform h.id from public.households h where h.id = v_hh_id for update;
  end loop;

  -- Authoritative, race-free classification: every household above is now
  -- locked, so this count reflects the true current membership and cannot
  -- change under us until this transaction ends.
  select
    array_agg(household_id) filter (where member_count > 1 and role = 'owner'),
    array_agg(household_id) filter (where member_count <= 1)
  into v_blocking_ids, v_sole_ids
  from (
    select
      mh.household_id,
      mh.role,
      (
        select count(*)
        from public.household_members inner_hm
        where inner_hm.household_id = mh.household_id
      ) as member_count
    from public.household_members mh
    where mh.user_id = v_uid and mh.household_id = any (v_household_ids)
  ) classified;

  if v_blocking_ids is not null and array_length(v_blocking_ids, 1) > 0 then
    -- Hard stop: no destructive statement anywhere in this function runs
    -- before this check. Returned as a normal (non-exception) result so
    -- the Edge Function can translate it to a 409 without needing to
    -- parse a raised exception's detail text.
    return jsonb_build_object(
      'ok', false,
      'error', 'OWNERSHIP_TRANSFER_REQUIRED',
      'householdIds', to_jsonb(v_blocking_ids)
    );
  end if;

  if v_sole_ids is null or array_length(v_sole_ids, 1) = 0 then
    -- Every household the caller belongs to has co-members and the caller
    -- is not owner in any of them — nothing to delete; those memberships
    -- simply cascade away once auth.users does.
    return jsonb_build_object('ok', true, 'deletedHouseholdIds', '[]'::jsonb);
  end if;

  with deleted as (
    delete from public.households
    where id = any (v_sole_ids)
    returning id
  )
  select array_agg(id) into v_deleted_ids from deleted;

  return jsonb_build_object(
    'ok', true,
    'deletedHouseholdIds', to_jsonb(coalesce(v_deleted_ids, array[]::uuid[]))
  );
end;
$$;

revoke all on function public.delete_sole_member_households_for_current_user() from public;
revoke all on function public.delete_sole_member_households_for_current_user() from anon;
grant execute on function public.delete_sole_member_households_for_current_user() to authenticated;
