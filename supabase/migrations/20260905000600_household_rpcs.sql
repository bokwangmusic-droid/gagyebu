-- ============================================================
-- 20260905000600_household_rpcs.sql
-- STEP 16-E — invite create/redeem RPCs
--
-- Adds exactly two client-callable RPCs on top of the unmodified STEP
-- 16-C/16-C1 schema (20260905000100~000500). household_members and
-- invites keep the exact same client-facing grants/policies they already
-- have — this file does not touch them directly. Both RPCs below write to
-- those tables as the table owner (SECURITY DEFINER), the same mechanism
-- private.handle_new_household() already uses; there is still no client
-- INSERT/UPDATE/DELETE path into household_members, and no client UPDATE/
-- DELETE path into invites (see 20260905000400_rls.sql — unchanged).
--
-- Household creation itself is NOT an RPC — a client still does a plain
-- `insert into households (name, created_by)` through the existing
-- households_insert policy, and private.handle_new_household() (existing,
-- 20260905000300) creates the owner membership + household_settings row
-- automatically, exactly as before. This file is only about invites.
--
-- Deliberately built from CORE Postgres functions only —
-- gen_random_uuid(), sha256(), encode() — instead of pgcrypto's
-- digest()/gen_random_bytes(). Both of the former have lived in
-- pg_catalog since PG13/PG14 respectively, so they resolve under
-- search_path='' unconditionally; pgcrypto's functions live wherever that
-- extension happened to be installed on this project (public vs
-- extensions), which this migration has no way to inspect. Same reasoning
-- already relied on for bare now() inside every search_path='' trigger in
-- 20260905000300_integrity_triggers.sql.
-- ============================================================

-- ---------- normalize (private — never directly callable) ----------
-- Strips spaces/hyphens/any non-alphanumeric and uppercases. Both RPCs
-- below run the exact same normalization before hashing, so
-- "a1b2-c3d4-e5f6-1234-5678", "A1B2 C3D4 E5F6 1234 5678" and
-- "A1B2C3D4E5F612345678" all hash identically.
create function private.normalize_invite_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
$$;

revoke all on function private.normalize_invite_code(text) from public;
-- No grant to authenticated either: only the two SECURITY DEFINER
-- functions below call this, and by the time they do they are already
-- running as the table owner (postgres), which always has execute on
-- everything it owns regardless of grants to other roles.

-- ---------- create_household_invite ----------
-- Owner-only (checked server-side via the existing private.is_household_
-- owner() helper from 20260905000400_rls.sql — reused as-is, not
-- redefined). At most one active (unused, unrevoked, unexpired) invite
-- can exist per household: any such invite is revoked before a new one is
-- issued, so "새 코드 만들기" always leaves exactly one usable code behind.
-- The plaintext code is returned exactly once here and never persisted —
-- only its SHA-256 hash goes into invites.code_hash.
create function public.create_household_invite(p_household_id uuid)
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

  update public.invites
  set revoked_at = now()
  where household_id = p_household_id
    and used_at is null
    and revoked_at is null
    and expires_at > now();

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
  -- pgcrypto's gen_random_bytes() (same search_path='' reasoning as the
  -- file header — gen_random_uuid() is a pg_catalog builtin since PG13,
  -- always resolvable regardless of extension schema placement).
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

  return query select v_code, v_expires_at;
end;
$$;

revoke all on function public.create_household_invite(uuid) from public;
revoke all on function public.create_household_invite(uuid) from anon;
grant execute on function public.create_household_invite(uuid) to authenticated;

-- ---------- redeem_household_invite ----------
-- Any authenticated user. `select ... for update` locks the matching
-- invite row for the duration of this transaction: if two devices redeem
-- the same code at the same moment, the second call blocks on that lock
-- until the first commits, then re-reads the now-committed row and finds
-- used_at already set — it fails with ALREADY_USED rather than both
-- succeeding. household_members' own `unique (household_id, user_id)`
-- constraint (20260905000100_identity.sql) is a second, independent
-- backstop against the same user ending up double-inserted.
--
-- Distinct short exception messages (INVALID_CODE / ALREADY_USED /
-- REVOKED_CODE / EXPIRED_CODE / ALREADY_MEMBER) are deliberate — enough
-- for the client to show a specific, friendly message without leaking raw
-- row/constraint details. "already a member" is checked against THIS
-- invite's specific household only, not "any household anywhere" — the
-- household count is intentionally not hard-capped at the DB level (see
-- household_members having no CHECK/trigger limiting membership count).
create function public.redeem_household_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_norm text;
  v_hash text;
  v_invite public.invites%rowtype;
  v_display_name text;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  v_norm := private.normalize_invite_code(p_code);
  if length(v_norm) = 0 then
    raise exception 'INVALID_CODE' using errcode = 'P0001';
  end if;

  v_hash := encode(sha256(v_norm::bytea), 'hex');

  select i.* into v_invite
  from public.invites i
  where i.code_hash = v_hash
  for update;

  if not found then
    raise exception 'INVALID_CODE' using errcode = 'P0001';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'REVOKED_CODE' using errcode = 'P0001';
  end if;
  if v_invite.used_at is not null then
    raise exception 'ALREADY_USED' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'EXPIRED_CODE' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.household_members hm
    where hm.household_id = v_invite.household_id and hm.user_id = v_uid
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = 'P0001';
  end if;

  select p.display_name into v_display_name
  from public.profiles p
  where p.id = v_uid;

  insert into public.household_members (household_id, user_id, role, display_name)
  values (v_invite.household_id, v_uid, 'member', coalesce(v_display_name, '나'));

  update public.invites
  set used_by = v_uid, used_at = now()
  where id = v_invite.id;

  return v_invite.household_id;
end;
$$;

revoke all on function public.redeem_household_invite(text) from public;
revoke all on function public.redeem_household_invite(text) from anon;
grant execute on function public.redeem_household_invite(text) to authenticated;
