-- ============================================================
-- 20261019002200_payment_notification_events.sql
-- 결제 알림 자동입력 — STEP 5. Server-side dedup of payment notification
-- EVENTS, before any automatic transaction save exists.
--
-- One row = one real money move a household member's phone saw as a
-- notification. Several phones of the same household, a re-posted
-- notification, an app restart or a retried request must all land on the
-- SAME row. This file only records events; it creates no transaction, and
-- nothing in the app turns a row into one yet.
--
-- ---- what is stored ----
-- Only the parse result needed to recognise the event and a hash:
--   dedup_key       the BASE FINGERPRINT: SHA-256 hex computed ON THE PHONE
--                   over "pn1" + household id + source package + whitespace-
--                   normalised notification title + body
--                   (src/lib/paymentNotification/serverDedup.ts). The raw
--                   title/body never leave the phone. The household id in
--                   the preimage means the same notification text gives a
--                   different key in another household.
--   event_type      card_purchase / card_cancel / income / outflow
--   amount, last4, occurred_at, source_package, parser_id/version
-- No merchant / counterparty name (a counterparty is often a person) and no
-- balance are stored.
--
-- ---- why the text (not the parsed fields) is the key ----
-- The KakaoBank body carries the balance after the move, so two real
-- payments of the same amount at the same shop seconds apart still differ,
-- while the same notification on two phones is byte-for-byte the same text.
-- The parser id / version are deliberately NOT in the key: a parser update
-- must not turn an already-registered event into a "new" one. Nothing from
-- one phone's own history (counters, ordinals) is in the key either — two
-- phones with different past captures still compute the same value.
-- event_type / amount / last4 are not hashed separately: they are read
-- from this same text, so they add nothing and would tie the key to the
-- parser.
--
-- ---- the dedup rule ----
-- Same household + same dedup_key + occurred_at within ±2 minutes of an
-- existing row  → that row (created = false). Otherwise a new row.
-- occurred_at is each phone's own arrival time of the push
-- (StatusBarNotification.postTime), so it is compared with a tolerance,
-- never part of the key. 2 minutes = the window the app already folds an
-- identical re-posted text into one notification (REPOST_WINDOW_MS); pushes
-- of one event to two awake phones arrive seconds apart. It is kept small
-- on purpose: the identical text again later (pay → cancel → pay again
-- leaves the same balance) is a separate real event and must not merge. A
-- phone that receives the push more than 2 minutes late gets a second row —
-- a visible duplicate rather than a silently lost payment. The value is
-- not backed by measured two-phone data yet: re-check it on real devices.
-- A plain UNIQUE cannot say "within 2 minutes", so the RPC serialises every
-- registration of one (household, dedup_key) with a transaction-scoped
-- advisory lock, looks for a match under it and only then inserts. Two
-- phones racing on the same event therefore get the same row; a different
-- household or a different key never waits on that lock. The unique index
-- on (household_id, dedup_key, occurred_at) is a backstop for an exact
-- replay.
--
-- ---- access ----
-- Any household MEMBER may register and read (the shared-ledger model of
-- transactions_insert / transactions_select). Rows are written only through
-- public.register_payment_notification_event (SECURITY DEFINER,
-- search_path = '', everything schema-qualified); authenticated gets SELECT
-- on the table and nothing else, anon nothing. No realtime publication.
-- status / handled_* exist for the next step (link to the saved
-- transaction); nothing writes them yet.
--
-- Not touched: transactions, the reset / import / account-deletion RPCs.
-- A household delete cascades.
-- REQUIRED FOLLOW-UP BEFORE PRODUCTION: reset_household_finance_data()
-- ("우리집 가계부 데이터 전체 초기화" = delete all finance data) does NOT
-- clear these rows. Decide whether this table is in the reset's scope
-- before any build ships this migration.
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

create unique index ux_payment_notification_events_exact
  on public.payment_notification_events (household_id, dedup_key, occurred_at);

revoke all on public.payment_notification_events from anon, authenticated;
grant select on public.payment_notification_events to authenticated;

create policy payment_notification_events_select on public.payment_notification_events
  for select to authenticated using (private.is_household_member(household_id));

-- ---------- register (insert-or-get) ----------
-- Returns the event row the notification belongs to and whether THIS call
-- created it. Errors (message = code):
--   AUTH_REQUIRED     28000  no session
--   NOT_MEMBER        42501  caller is not a member of p_household_id
--   INVALID_ARGUMENT  22023  any argument out of its documented shape
create function public.register_payment_notification_event(
  p_household_id   uuid,
  p_dedup_key      text,
  p_source_package text,
  p_parser_id      text,
  p_parser_version int,
  p_event_type     text,
  p_amount         numeric,
  p_last4          text,
  p_occurred_at    timestamptz
)
returns table (event_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
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
     or p_occurred_at < now() - interval '60 days' then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- One registration of this (household, key) at a time, until commit.
  perform pg_advisory_xact_lock(
    hashtextextended('payment_notification_event:' || p_household_id::text || ':' || p_dedup_key, 0)
  );

  select e.id into v_id
  from public.payment_notification_events e
  where e.household_id = p_household_id
    and e.dedup_key = p_dedup_key
    and e.occurred_at between p_occurred_at - interval '2 minutes' and p_occurred_at + interval '2 minutes'
  order by abs(extract(epoch from (e.occurred_at - p_occurred_at))), e.created_at
  limit 1;

  if v_id is not null then
    return query select v_id, false;
    return;
  end if;

  insert into public.payment_notification_events (
    household_id, dedup_key, source_package, parser_id, parser_version,
    event_type, amount, last4, occurred_at, created_by
  ) values (
    p_household_id, p_dedup_key, p_source_package, p_parser_id, p_parser_version,
    p_event_type, p_amount, p_last4, p_occurred_at, v_uid
  )
  returning id into v_id;

  return query select v_id, true;
end;
$$;

revoke all on function public.register_payment_notification_event(uuid, text, text, text, int, text, numeric, text, timestamptz) from public;
revoke all on function public.register_payment_notification_event(uuid, text, text, text, int, text, numeric, text, timestamptz) from anon;
grant execute on function public.register_payment_notification_event(uuid, text, text, text, int, text, numeric, text, timestamptz) to authenticated;
