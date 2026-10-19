-- ============================================================
-- 20261019002300_payment_notification_event_completion.sql
-- 결제 알림 자동입력 — STEP 6. Linking a payment notification EVENT
-- (20261019002200) to the transaction saved for it — by "확실한 카드 결제
-- 자동입력" (src/lib/paymentNotification/autoSave.ts) OR by the user saving
-- a 후보함 candidate in /input — so that a second phone never saves the
-- same real payment again.
--
-- 20261019002200 is applied in production and is NOT changed. This file
-- adds two functions and one partial unique index. No column, policy or
-- table grant changes — payment_notification_events stays without any
-- client table privilege; these SECURITY DEFINER functions are the only
-- way in.
--
-- ---- the automatic flow (client side) ----
--   1. register_payment_notification_event (existing) → event id;
--   2. get_payment_notification_event_link → still pending? (handled by an
--      automatic OR a manual save → nothing is saved);
--   3. the ordinary transaction insert (src/services/remoteFinanceWrite.ts)
--      with the id DERIVED from the event: 'txn-pn-' || event id. The
--      transactions primary key makes that one row per event, whoever
--      saves it, however often it is retried;
--   4. complete_payment_notification_event(…, 'auto').
-- ---- the manual flow ----
--   The user saves a candidate in /input. A candidate already registered
--   uses the SAME derived id 'txn-pn-' || event id (online or through the
--   offline queue), so a manual and an automatic save — or two manual ones —
--   race on the transactions primary key: the first insert wins and is kept
--   as it is, the second is refused (23505) and the phone checks the event's
--   transaction here instead of adding one. A candidate saved before its
--   registration keeps an ordinary 'txn-<ms>-<rand>' id. Afterwards the phone
--   calls complete_payment_notification_event(…, 'manual'), retried until it
--   lands.
-- The insert and the link are two requests: a link lost after a successful
-- insert is retried by the phone (nothing is rolled back), and the link
-- doubles as "does that transaction exist?" when the insert came back as an
-- error. Nothing here creates or deletes a transaction.
--
-- ---- complete_payment_notification_event ----
-- Which transaction may be linked to which event:
--   event_type      transaction.type   'auto'   'manual'
--   card_purchase   expense            yes      yes
--   outflow         expense            no       yes
--   income          income             no       yes
--   card_cancel     —                  no       no
-- The transaction id is either the event's DERIVED id 'txn-pn-' || event id
-- ('auto': always; 'manual': a registered candidate) or, for 'manual' only,
-- an ordinary id that is not a 'txn-pn-' one. A derived id is that event's
-- transaction by construction, whoever saved it and with whatever amount /
-- memo / category the first save wrote: only the type is checked. An
-- ordinary manual id must also have been created by the caller. Amounts are
-- never compared — a manual save may correct the notification's amount,
-- and it may be the one that won the race.
-- Returns one word:
--   linked               this call linked the event to p_transaction_id
--   already_linked       it was already linked to the SAME transaction
--   conflict             it is linked to ANOTHER transaction (unchanged)
--   transaction_missing  no transaction with that id in this household
--   transaction_mismatch the transaction does not fit the event (type, or
--                        the creator of an ordinary id — above) (unchanged)
--   transaction_in_use   the transaction is already linked to ANOTHER
--                        event (unchanged)
-- A soft-deleted transaction still counts as existing: a saved payment the
-- user deleted again is handled — it must never be re-created.
-- Errors (message = code): AUTH_REQUIRED 28000, NOT_MEMBER 42501,
-- INVALID_ARGUMENT 22023, NOT_FOUND P0002 (no such event in this
-- household), NOT_ELIGIBLE 22023 (the event type cannot be linked this way,
-- table above). The event row is locked (FOR UPDATE), so two phones
-- completing at once are serialised: one links, the other gets
-- already_linked / conflict. One transaction ↔ at most one event is also
-- enforced by ux_payment_notification_events_handled_txn.
--
-- ---- get_payment_notification_event_link ----
-- The event's status and linked transaction id, for a member of its
-- household; no row otherwise (not signed in, not a member, no such event).
-- Members can read the household's transactions anyway; the hashes and the
-- claims stay internal.
--
-- REQUIRED FOLLOW-UP BEFORE PRODUCTION (unchanged from 20261019002200):
-- reset_household_finance_data() ("우리집 가계부 데이터 전체 초기화") clears
-- neither payment_notification_events nor payment_notification_event_claims.
-- After a reset, an event can still point at a deleted transaction id.
-- Decide the reset's scope before the automatic save ships.
--
-- Status: written and statically reviewed only — NOT yet executed on any
-- PostgreSQL instance.
-- ============================================================

-- A transaction is the save of ONE event at most (transaction ids are a
-- global primary key). Every existing row has handled_transaction_id null.
create unique index ux_payment_notification_events_handled_txn
  on public.payment_notification_events (handled_transaction_id)
  where handled_transaction_id is not null;

create function public.complete_payment_notification_event(
  p_household_id    uuid,
  p_event_id        uuid,
  p_transaction_id  text,
  p_source          text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid           uuid := auth.uid();
  v_event_type    text;
  v_status        text;
  v_linked        text;
  v_expected      text;
  v_txn_type      text;
  v_txn_creator   uuid;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_household_id is null or not private.is_household_member(p_household_id) then
    raise exception 'NOT_MEMBER' using errcode = '42501';
  end if;
  if p_event_id is null
     or p_transaction_id is null or char_length(p_transaction_id) not between 1 and 128
     or p_source is null or p_source not in ('auto', 'manual')
     or (p_transaction_id like 'txn-pn-%' and p_transaction_id <> ('txn-pn-' || p_event_id::text))
     or (p_source = 'auto' and p_transaction_id <> ('txn-pn-' || p_event_id::text)) then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  select e.event_type, e.status, e.handled_transaction_id
    into v_event_type, v_status, v_linked
  from public.payment_notification_events e
  where e.id = p_event_id
    and e.household_id = p_household_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  v_expected := case
                  when v_event_type = 'card_purchase' then 'expense'
                  when p_source = 'manual' and v_event_type = 'outflow' then 'expense'
                  when p_source = 'manual' and v_event_type = 'income' then 'income'
                end;
  if v_expected is null then
    raise exception 'NOT_ELIGIBLE' using errcode = '22023';
  end if;

  if v_status = 'handled' then
    if v_linked = p_transaction_id then
      return 'already_linked';
    end if;
    return 'conflict';
  end if;

  select t.type, t.created_by
    into v_txn_type, v_txn_creator
  from public.transactions t
  where t.id = p_transaction_id
    and t.household_id = p_household_id;
  if not found then
    return 'transaction_missing';
  end if;
  if v_txn_type <> v_expected
     or (p_transaction_id <> ('txn-pn-' || p_event_id::text) and v_txn_creator is distinct from v_uid) then
    return 'transaction_mismatch';
  end if;
  if exists (
    select 1
    from public.payment_notification_events x
    where x.handled_transaction_id = p_transaction_id
      and x.id <> p_event_id
  ) then
    return 'transaction_in_use';
  end if;

  begin
    update public.payment_notification_events e
       set status = 'handled',
           handled_transaction_id = p_transaction_id,
           handled_at = now()
     where e.id = p_event_id;
  exception when unique_violation then
    -- Another event took this transaction meanwhile (the index above).
    return 'transaction_in_use';
  end;
  return 'linked';
end;
$$;

revoke all on function public.complete_payment_notification_event(uuid, uuid, text, text) from public;
revoke all on function public.complete_payment_notification_event(uuid, uuid, text, text) from anon;
grant execute on function public.complete_payment_notification_event(uuid, uuid, text, text) to authenticated;

create function public.get_payment_notification_event_link(
  p_household_id  uuid,
  p_event_id      uuid
)
returns table (event_status text, linked_transaction_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.status, e.handled_transaction_id
  from public.payment_notification_events e
  where e.id = p_event_id
    and e.household_id = p_household_id
    and auth.uid() is not null
    and private.is_household_member(p_household_id);
$$;

revoke all on function public.get_payment_notification_event_link(uuid, uuid) from public;
revoke all on function public.get_payment_notification_event_link(uuid, uuid) from anon;
grant execute on function public.get_payment_notification_event_link(uuid, uuid) to authenticated;
