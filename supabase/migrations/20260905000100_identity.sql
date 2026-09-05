-- ============================================================
-- 20260905000100_identity.sql
-- STEP 16-C / STEP 16-C1 — identity / account infrastructure
--
-- profiles, households, household_members, invites.
--
-- STEP 16-C1 hardening: RLS is enabled on every table in THIS file,
-- immediately after its CREATE TABLE, not deferred to
-- 20260905000400_rls.sql. No table this migration creates exists in a
-- public-with-RLS-off state at any point, even mid-deployment — a Data
-- API client hitting these tables between this file and 20260905000400
-- (before any policy exists) is fail-closed (RLS on + zero policies =
-- zero rows, zero writes for every non-superuser role, anon included).
--
-- Column constraints + the composite-FK target uniques that later
-- migrations need also live here. No triggers, no policies, no grants —
-- 20260905000300_integrity_triggers.sql attaches behaviour once every
-- table it touches (including household_settings, created in
-- 20260905000200_household_data.sql) actually exists, and
-- 20260905000400_rls.sql adds the policies + explicit GRANTs that open up
-- exactly the access `authenticated` needs.
-- ============================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------- profiles ----------
-- One row per auth.users row (see handle_new_user() in the triggers file).
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default '나',
  email         text,
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- ---------- households ----------
create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '우리집 가계부',
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.households enable row level security;

-- ---------- household_members ----------
-- No client-facing INSERT/UPDATE/DELETE policy exists for this table
-- (see 20260905000400_rls.sql) — every row is created by the
-- handle_new_household() trigger (owner bootstrap) or, in a future step,
-- a SECURITY DEFINER invite-redeem RPC. role/user_id/household_id/
-- joined_at can never be changed by a client because there is no UPDATE
-- path into this table at all.
create table public.household_members (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  role          text not null check (role in ('owner', 'member')),
  display_name  text not null default '나',
  joined_at     timestamptz not null default now(),
  unique (household_id, user_id),
  -- composite-FK target: lets transactions.member_id be pinned to a member
  -- of the SAME household (see transactions_member_fk in the triggers file).
  unique (household_id, id)
);

create index ix_household_members_user on public.household_members (user_id);

alter table public.household_members enable row level security;

-- ---------- invites ----------
-- Plaintext invite codes are never stored — code_hash only. Redeem
-- (used_by/used_at) and revoke (revoked_at) are deliberately NOT exposed
-- as client UPDATE paths in this step (see 20260905000400_rls.sql) — both
-- will be implemented as an atomic SECURITY DEFINER RPC in a later step
-- (STEP 16-D). This table is effectively insert-only from the client side
-- for now.
create table public.invites (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  code_hash     text not null,
  created_by    uuid references public.profiles (id) on delete set null,
  expires_at    timestamptz not null,
  used_by       uuid references public.profiles (id) on delete set null,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint invites_expires_after_created check (expires_at > created_at)
);

create unique index ux_invites_code_hash on public.invites (code_hash);
create index ix_invites_household on public.invites (household_id);

alter table public.invites enable row level security;
