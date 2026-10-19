-- ============================================================
-- 20261019002200_payment_notification_events.sql
-- 결제 알림 자동입력 — STEP 5. Server-side dedup of payment notification
-- EVENTS, before any automatic transaction save exists.
--
-- One event = one real money move a household member's phone saw as a
-- notification. Several phones of the same household, a retried request or
-- a later screen visit should land on the SAME event — but two real moves
-- must never become one. This file only records events; it creates no
-- transaction, and nothing in the app turns an event into one yet.
--
-- ---- what is stored ----
-- payment_notification_events — one row per event:
--   dedup_key       the BASE FINGERPRINT: SHA-256 hex computed ON THE PHONE
--                   over a whitelist of the fields the parser extracted —
--                   "pn1", household id, source package, event type,
--                   instrument, amount, last 4, account/card name,
--                   merchant candidate, counterparty
--                   (src/lib/paymentNotification/serverDedup.ts). The raw
--                   title/body never leave the phone and are never hashed.
--                   The household id in the preimage means the same payment
--                   gives a different key in another household.
--   event_type      card_purchase / card_cancel / income / outflow
--   amount, last4, occurred_at, source_package, parser_id/version
-- payment_notification_event_claims — one row per (phone, local candidate)
-- that reported an event:
--   device_hash       SHA-256 over "pnd1", household id and a random
--                     install id made by the app (a UUID in AsyncStorage —
--                     not a hardware id, not the account, not the Android
--                     notification key). New after a reinstall.
--   local_claim_hash  SHA-256 over "pnc1", household id, that install id
--                     and the phone's own candidate fingerprint. The same
--                     candidate always gives the same value on that phone.
--   occurred_at       that phone's post time of the push
-- The install id never leaves the phone, so neither hash can be traced
-- back to it or to the notification. No merchant / counterparty name (a
-- counterparty is often a person) and no balance are stored.
--
-- ---- no balance, anywhere ----
-- A KakaoBank body ends in "잔액 N원" (the account balance after the move).
-- The parser cuts it off before reading any field, and only the whitelisted
-- fields are hashed, so the balance is neither stored nor part of a hash
-- (a hash over it could be brute-forced back to the balance). The parser
-- id / version are NOT in the key either: a version bump alone must not
-- turn an already-registered event into a "new" one.
--
-- ---- the dedup rule ----
-- The base fingerprint is NOT an identity: two real payments of the same
-- amount, card and merchant have the same one. What a phone knows for sure
-- is that each of its own candidates is a different real move (it sees a
-- push once, and folds its own re-posts locally). So:
--   A. this (household, device_hash, local_claim_hash) is already claimed
--      → its event (created = false). A retry, a lost reply, a later visit.
--   B. else: the event to join is the nearest one with the same dedup_key
--      whose occurred_at is within ±30 seconds, that THIS device has not
--      claimed yet, and with no event of the opposite card type
--      (purchase ↔ cancel) of the same package / amount / last 4 between
--      the two times (pay → cancel → pay again is two purchases). It is
--      joined only if no second such event is within 10 seconds of the
--      same distance; then a claim is added (created = false).
--   C. anything else → a new event + its claim (created = true).
-- Why it leans to a new event: when a merge is unclear, a duplicate can be
-- seen and dismissed; a real payment merged into another is lost without a
-- trace — and the goal is an automatic save. So: one phone's two
-- candidates never share an event (two real payments 30 s apart seen by one
-- phone stay two); another phone joins only a close, unambiguous match; a
-- phone that gets the push more than 30 s late (Doze, offline) makes a
-- second event — a visible duplicate. 30 s / 10 s are NOT backed by
-- measured two-phone data yet: re-check on real devices.
-- KNOWN LIMIT: a payment that only phone B saw, within 30 s of a same-
-- amount / card / merchant payment that only phone A saw, joins A's event.
--
-- Every registration of one (household, dedup_key) runs under a
-- transaction-scoped advisory lock, so two phones racing on the same push
-- see each other's rows. The same claim arriving twice at once with two
-- different keys (a parser change in between) is caught by the claims
-- unique index and answered with the claim that won.
--
-- ---- access ----
-- Any household MEMBER may register (the shared-ledger model of
-- transactions_insert). Rows are written only through
-- public.register_payment_notification_event (SECURITY DEFINER,
-- search_path = '', everything schema-qualified), which returns just the
-- event id and whether it was created. The app never reads either table
-- itself, so NO client role gets any table privilege or policy: RLS is on
-- with zero policies (fail-closed), and the hashes stay internal. A later
-- step that needs to read events adds a narrow RPC or grant for exactly
-- that. No realtime publication.
-- status / handled_* exist for the next step (link to the saved
-- transaction); nothing writes them yet.
--
-- Not touched: transactions, the reset / import / account-deletion RPCs.
-- A household delete cascades to both tables.
-- REQUIRED FOLLOW-UP BEFORE PRODUCTION / BEFORE ANY AUTOMATIC SAVE:
-- reset_household_finance_data() ("우리집 가계부 데이터 전체 초기화" =
-- delete all finance data) clears NEITHER payment_notification_events NOR
-- payment_notification_event_claims. Decide whether both are in the
-- reset's scope before any build ships this migration.
--
-- Status: written and statically reviewed only — NOT yet executed on any
-- PostgreSQL instance.
-- ============================================================

create table public.payment_notification_events (
  id                      uuid primary key default gen_random_uuid(),
  household_id            uuid not null references public.households (id) on delete cascade,
  dedup_key               text not null check (dedup_key ~ '^[0-9a-f]{64}$'),
  source_package          text not null check (char_length(source_package) between 1 and 255),
  parser_id               text not null check (char_length(parser_id) between 1 and 64),
  parser_version          int not null check (parser_version >= 1),
  event_type              text not null check (event_type in ('card_purchase', 'card_cancel', 'income', 'outflow')),
  amount                  numeric not null check (amount > 0 and amount <= 9999999999 and amount = trunc(amount)),
  last4                   text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  occurred_at             timestamptz not null,
  status                  text not null default 'pending' check (status in ('pending', 'handled')),
  handled_transaction_id  text,
  handled_at              timestamptz,
  created_by              uuid references public.profiles (id) on delete set null,
  created_at              timestamptz not null default now()
);

alter table public.payment_notification_events enable row level security;

-- Not unique: two real events may share key and time (rule B / C above).
create index ix_payment_notification_events_match
  on public.payment_notification_events (household_id, dedup_key, occurred_at);
-- The purchase ↔ cancel "in between" check.
create index ix_payment_notification_events_card_amount
  on public.payment_notification_events (household_id, event_type, amount, occurred_at);

create table public.payment_notification_event_claims (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.payment_notification_events (id) on delete cascade,
  household_id      uuid not null references public.households (id) on delete cascade,
  device_hash       text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  local_claim_hash  text not null check (local_claim_hash ~ '^[0-9a-f]{64}$'),
  occurred_at       timestamptz not null,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now()
);

alter table public.payment_notification_event_claims enable row level security;

-- One local candidate of one device = one claim (rule A).
create unique index ux_payment_notification_event_claims_local
  on public.payment_notification_event_claims (household_id, device_hash, local_claim_hash);
-- One device claims an event at most once (its candidates are distinct moves).
create unique index ux_payment_notification_event_claims_device
  on public.payment_notification_event_claims (event_id, device_hash);

-- No client access to either table at all (see header): RLS on, no policy,
-- no grant. Only the SECURITY DEFINER RPC below (running as the table
-- owner) reads or writes them.
revoke all on public.payment_notification_events from anon, authenticated;
revoke all on public.payment_notification_event_claims from anon, authenticated;

-- ---------- register (claim-or-match-or-insert) ----------
-- Returns the event this phone's candidate belongs to and whether THIS
-- call created it. Errors (message = code):
--   AUTH_REQUIRED     28000  no session
--   NOT_MEMBER        42501  caller is not a member of p_household_id
--   INVALID_ARGUMENT  22023  any argument out of its documented shape
create function public.register_payment_notification_event(
  p_household_id      uuid,
  p_dedup_key         text,
  p_source_package    text,
  p_parser_id         text,
  p_parser_version    int,
  p_event_type        text,
  p_amount            numeric,
  p_last4             text,
  p_occurred_at       timestamptz,
  p_device_hash       text,
  p_local_claim_hash  text
)
returns table (event_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_id        uuid;
  v_created   boolean;
  v_best      uuid;
  v_best_d    numeric;
  v_second_d  numeric;
  v_opposite  text;
  r           record;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_household_id is null or not private.is_household_member(p_household_id) then
    raise exception 'NOT_MEMBER' using errcode = '42501';
  end if;
  if p_dedup_key is null or p_dedup_key !~ '^[0-9a-f]{64}$'
     or p_source_package is null or char_length(p_source_package) not between 1 and 255
     or p_parser_id is null or char_length(p_parser_id) not between 1 and 64
     or p_parser_version is null or p_parser_version < 1
     or p_event_type is null or p_event_type not in ('card_purchase', 'card_cancel', 'income', 'outflow')
     or p_amount is null or p_amount <= 0 or p_amount > 9999999999 or p_amount <> trunc(p_amount)
     or (p_last4 is not null and p_last4 !~ '^[0-9]{4}$')
     or p_occurred_at is null
     or p_occurred_at > now() + interval '1 day'
     or p_occurred_at < now() - interval '60 days'
     or p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$'
     or p_local_claim_hash is null or p_local_claim_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- One registration of this (household, key) at a time, until commit.
  perform pg_advisory_xact_lock(
    hashtextextended('payment_notification_event:' || p_household_id::text || ':' || p_dedup_key, 0)
  );

  -- A. This device already claimed this candidate.
  select c.event_id into v_id
  from public.payment_notification_event_claims c
  where c.household_id = p_household_id
    and c.device_hash = p_device_hash
    and c.local_claim_hash = p_local_claim_hash;
  if v_id is not null then
    return query select v_id, false;
    return;
  end if;

  -- B. The two nearest events this report could be (see header).
  v_opposite := case p_event_type
                  when 'card_purchase' then 'card_cancel'
                  when 'card_cancel' then 'card_purchase'
                end;
  for r in
    select e.id, abs(extract(epoch from (e.occurred_at - p_occurred_at))) as d
    from public.payment_notification_events e
    where e.household_id = p_household_id
      and e.dedup_key = p_dedup_key
      and e.event_type = p_event_type
      and e.amount = p_amount
      and e.last4 is not distinct from p_last4
      and e.occurred_at between p_occurred_at - interval '30 seconds' and p_occurred_at + interval '30 seconds'
      and not exists (
        select 1
        from public.payment_notification_event_claims c
        where c.event_id = e.id
          and c.device_hash = p_device_hash
      )
      and not exists (
        select 1
        from public.payment_notification_events x
        where x.household_id = p_household_id
          and x.event_type = v_opposite
          and x.source_package = p_source_package
          and x.amount = p_amount
          and x.last4 is not distinct from p_last4
          and x.occurred_at > least(e.occurred_at, p_occurred_at)
          and x.occurred_at < greatest(e.occurred_at, p_occurred_at)
      )
    order by 2, e.created_at
    limit 2
  loop
    if v_best is null then
      v_best := r.id;
      v_best_d := r.d;
    else
      v_second_d := r.d;
    end if;
  end loop;

  begin
    if v_best is not null and (v_second_d is null or v_second_d - v_best_d >= 10) then
      v_id := v_best;
      v_created := false;
    else
      -- C. No clear match.
      insert into public.payment_notification_events (
        household_id, dedup_key, source_package, parser_id, parser_version,
        event_type, amount, last4, occurred_at, created_by
      ) values (
        p_household_id, p_dedup_key, p_source_package, p_parser_id, p_parser_version,
        p_event_type, p_amount, p_last4, p_occurred_at, v_uid
      )
      returning id into v_id;
      v_created := true;
    end if;

    insert into public.payment_notification_event_claims (
      event_id, household_id, device_hash, local_claim_hash, occurred_at, created_by
    ) values (
      v_id, p_household_id, p_device_hash, p_local_claim_hash, p_occurred_at, v_uid
    );
  exception when unique_violation then
    -- The same claim, registered meanwhile under another key: its event.
    -- (The event inserted above, if any, is rolled back with this block.)
    select c.event_id into v_id
    from public.payment_notification_event_claims c
    where c.household_id = p_household_id
      and c.device_hash = p_device_hash
      and c.local_claim_hash = p_local_claim_hash;
    if v_id is null then
      raise;
    end if;
    v_created := false;
  end;

  return query select v_id, v_created;
end;
$$;

revoke all on function public.register_payment_notification_event(uuid, text, text, text, int, text, numeric, text, timestamptz, text, text) from public;
revoke all on function public.register_payment_notification_event(uuid, text, text, text, int, text, numeric, text, timestamptz, text, text) from anon;
grant execute on function public.register_payment_notification_event(uuid, text, text, text, int, text, numeric, text, timestamptz, text, text) to authenticated;
