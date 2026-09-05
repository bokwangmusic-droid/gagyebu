-- ============================================================
-- 20260905000700_fix_household_invite_ambiguity.sql
-- STEP 16-E corrective — fixes 42702 in create_household_invite
--
-- Real device error (STEP 16-E RPC diagnostics):
--   code: 42702
--   message: column reference "expires_at" is ambiguous
--   details: It could refer to either a PL/pgSQL variable or a table column.
--
-- Root cause: create_household_invite's `returns table (code text,
-- expires_at timestamptz)` implicitly declares `code` and `expires_at` as
-- PL/pgSQL variables visible through the WHOLE function body, on top of
-- whatever's in the `declare` block. public.invites also has a real
-- `expires_at` column, so the bare `expires_at` in the housekeeping
-- UPDATE's WHERE clause (revoking any still-active invite before issuing
-- a new one) was ambiguous between the two — Postgres correctly refused
-- to guess which one was meant.
--
-- 20260905000600_household_rpcs.sql is already applied remotely and is
-- NOT modified here (migration history stays intact) — this file only
-- CREATE OR REPLACEs the one function, with the exact same signature so
-- it replaces in place rather than creating an overload. Every other
-- object from 000600 (private.normalize_invite_code,
-- public.redeem_household_invite) and every other migration are
-- untouched. Behaviour is otherwise identical to 000600's version:
-- SECURITY DEFINER, search_path='', auth.uid() check,
-- private.is_household_owner() ownership check, the households row
-- `for update` lock, revoke-then-insert of exactly one active invite,
-- the 20-hex-char / 80-bit code, SHA-256-only storage, 7-day expiry —
-- only the ambiguous column reference is fixed.
-- ============================================================

create or replace function public.create_household_invite(p_household_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_locked_household_id uuid;
  v_uuid_text text;
  v_code text;
  v_expires_at timestamptz;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if not private.is_household_owner(p_household_id) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  -- Serialize concurrent invite creation for the SAME household: invites
  -- has no per-household "only one active row" constraint to lean on
  -- (code_hash is unique per code, not per household), so two overlapping
  -- calls could otherwise both read "no active invite yet", both revoke
  -- nothing, and both insert — leaving two simultaneously-active codes.
  -- Locking the households row itself (exactly one row per household)
  -- makes the revoke-then-insert below happen as one atomic step per
  -- caller: the second caller's FOR UPDATE blocks until the first
  -- transaction commits, then proceeds against the now-committed state
  -- (its own revoke query will see and revoke the first caller's
  -- freshly-inserted invite too), so exactly one invite ends up active no
  -- matter how the two calls interleave. Unreachable via any exposed
  -- client path today (is_household_owner already implies the household
  -- exists), but kept as a defensive, explicit check rather than trusting
  -- that invariant silently.
  select h.id into v_locked_household_id
  from public.households h
  where h.id = p_household_id
  for update;

  if v_locked_household_id is null then
    raise exception 'HOUSEHOLD_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Fix for 42702: table alias `i` + fully qualified WHERE columns. Only
  -- `expires_at` was actually ambiguous (it collides with the RETURNS
  -- TABLE output parameter of the same name) — household_id/used_at/
  -- revoked_at were never ambiguous (no PL/pgSQL variable shares those
  -- names) — but all four are qualified here for clarity/consistency
  -- rather than qualifying only the one that strictly required it.
  update public.invites as i
  set revoked_at = now()
  where i.household_id = p_household_id
    and i.used_at is null
    and i.revoked_at is null
    and i.expires_at > now();

  -- 20 uppercase hex chars = 80 bits of real entropy from a single fresh
  -- UUID (text form "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx", 36 chars,
  -- 1-indexed):
  --   chars 1-13  = first 8 random hex + '-' + next 4 random hex
  --                 (12 random hex chars, stops before the fixed version
  --                 nibble at char 15 — never touched)
  --   chars 25-32 = 8 more random hex chars from the last 12-char group
  --                 (chars 25-36), well clear of the variant nibble at
  --                 char 20 (2 of its 4 bits are fixed) — never touched
  -- 12 + 8 = 20 hex chars, all from portions of the UUID that are fully
  -- random; the fixed version nibble and the fixed top-2-bits of the
  -- variant nibble are both skipped entirely (not treated as entropy).
  -- A single gen_random_uuid() has 122 truly random bits on tap, so 80 of
  -- them is comfortably available without reaching for a second UUID or
  -- pgcrypto's gen_random_bytes() (same search_path='' reasoning as
  -- 20260905000600_household_rpcs.sql's file header — gen_random_uuid()
  -- is a pg_catalog builtin since PG13, always resolvable regardless of
  -- extension schema placement).
  v_uuid_text := gen_random_uuid()::text;
  v_code := upper(replace(substring(v_uuid_text, 1, 13), '-', '') || substring(v_uuid_text, 25, 8));
  v_expires_at := now() + interval '7 days';

  insert into public.invites (household_id, code_hash, created_by, expires_at)
  values (
    p_household_id,
    encode(sha256(v_code::bytea), 'hex'),
    v_uid,
    v_expires_at
  );

  -- Local variables v_code/v_expires_at, not the bare output-parameter
  -- names — no ambiguity risk here either.
  return query select v_code, v_expires_at;
end;
$$;

-- CREATE OR REPLACE FUNCTION preserves the function's existing ACL (grants
-- aren't reset by a body replace), so this is not strictly required for
-- 20260905000600_household_rpcs.sql's grants to keep holding — restated
-- anyway, matching this project's convention of always making a function's
-- permission state explicit in the same file that defines it.
revoke all on function public.create_household_invite(uuid) from public;
revoke all on function public.create_household_invite(uuid) from anon;
grant execute on function public.create_household_invite(uuid) to authenticated;
