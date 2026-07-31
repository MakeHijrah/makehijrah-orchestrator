-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 023: Admin <-> consultant direct messages
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 005
--   "Admin <-> Consultant Direct Messaging"
--   (APPROVED). This migration implements sections 3-7 of that
--   amendment and nothing beyond them.
--
-- Purpose:
-- - Allow public.messages to carry a direct admin <-> consultant
--   message by making consultation_id nullable.
-- - Preserve consultation messaging exactly as it behaves today,
--   by re-scoping its policies to consultation_id is not null.
-- - Enforce the direct-message invariant in the database.
--
-- Built from the inspected live state:
-- - Columns already include read_at and email_notification_sent_at.
--   Neither is added here.
-- - messages_recipient_unread_idx already exists and is not
--   duplicated.
-- - public.messages is already in the supabase_realtime
--   publication. This migration does not touch any publication.
-- - No custom trigger exists on public.messages, so both triggers
--   below are new, not replacements.
-- - The three live policies are dropped by their exact names.
--
-- A message is exactly one of:
--   1. consultation message -> consultation_id is not null
--   2. direct message       -> consultation_id is null,
--                              admin <-> consultant only
--
-- Both directions are permitted. A consultant may initiate a direct
-- message without a prior admin message.
--
-- Idempotent. Transaction-wrapped.
-- ============================================================

begin;

-- ------------------------------------------------------------- pre-flight ----
-- The policy replacement below drops the three live policies before
-- recreating them. If a dependency were missing, the recreate would fail
-- after the drop. Fail before touching anything instead; the transaction
-- rolls back and the live policy set is untouched.

do $$
begin
  if to_regclass('public.messages') is null then
    raise exception 'migration 023: public.messages not found';
  end if;

  if to_regclass('public.profiles') is null then
    raise exception 'migration 023: public.profiles not found';
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception
      'migration 023: public.is_admin() not found - required by the SELECT policies';
  end if;

  -- Two-argument signature, as discovered live. There is no one-argument overload.
  if to_regprocedure('public.is_consultation_participant(uuid, uuid)') is null then
    raise exception
      'migration 023: public.is_consultation_participant(uuid, uuid) not found - required by the consultation INSERT policy';
  end if;

  if to_regprocedure('public.is_privileged_writer()') is null then
    raise exception
      'migration 023: public.is_privileged_writer() not found - required by the immutability guard';
  end if;
end;
$$;

-- ---------------------------------------------------------------- schema ----
-- Direct messages carry no consultation.

alter table public.messages
  alter column consultation_id drop not null;

-- No self-send, for either message class. Dropped first so the migration is
-- safe to re-run.
alter table public.messages
  drop constraint if exists messages_no_self_send;
alter table public.messages
  add constraint messages_no_self_send
  check (sender_profile_id <> recipient_profile_id);

-- --------------------------------------------------------------- indexes ----
-- Only the missing direct-conversation index is added.
--
-- messages_recipient_unread_idx (recipient_profile_id, created_at)
--   where read_at is null                      -- already exists, serves unread
-- idx_messages_consultation (consultation_id, created_at)
--   -- already exists, serves consultation threads
--
-- One pair index is sufficient. The frontend direct-conversation query is an
-- OR across both directions:
--   (sender = me and recipient = peer) or (sender = peer and recipient = me)
-- PostgreSQL evaluates that as a BitmapOr: the leading sender_profile_id
-- column serves each branch independently, so both directions are covered by
-- this one partial index. A mirrored (recipient, sender) index would only be
-- justified if a real plan showed a sequential scan on the reverse branch, so
-- it is deliberately not added here.

create index if not exists messages_direct_pair_idx
  on public.messages (sender_profile_id, recipient_profile_id, created_at desc)
  where consultation_id is null;

-- ------------------------------------------------------------- invariants ----
-- A check constraint cannot read profiles.role, so the admin/consultant
-- pairing is enforced by trigger. This holds for both directions and blocks
-- consultant-to-consultant and any client participation independently of RLS.

create or replace function public.enforce_direct_message_pairing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender_role public.user_role;
  v_recipient_role public.user_role;
begin
  -- Consultation messages keep their existing rules untouched.
  if new.consultation_id is not null then
    return new;
  end if;

  -- Roles are read from public.profiles, never from anything the caller
  -- supplies. search_path is fixed and tables are schema-qualified.
  select p.role into v_sender_role
    from public.profiles p
   where p.id = new.sender_profile_id;

  select p.role into v_recipient_role
    from public.profiles p
   where p.id = new.recipient_profile_id;

  if v_sender_role is null or v_recipient_role is null then
    raise exception 'direct message participants must exist'
      using errcode = 'check_violation';
  end if;

  if new.sender_profile_id = new.recipient_profile_id then
    raise exception 'a direct message may not be sent to yourself'
      using errcode = 'check_violation';
  end if;

  -- Exactly one admin and one consultant, in either direction. A consultant
  -- may therefore initiate without a prior admin message.
  if not (
    (v_sender_role = 'admin'::public.user_role
      and v_recipient_role = 'consultant'::public.user_role)
    or (v_sender_role = 'consultant'::public.user_role
      and v_recipient_role = 'admin'::public.user_role)
  ) then
    raise exception
      'direct messages are permitted only between an admin and a consultant'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_direct_pairing on public.messages;
create trigger messages_direct_pairing
  before insert on public.messages
  for each row execute function public.enforce_direct_message_pairing();

-- Column guard. Recipients hold UPDATE permission so they can set read_at;
-- without this they could also rewrite the body. Applies to consultation and
-- direct messages alike.
--
-- Privileged writers (service_role and admin) are exempt, following the same
-- is_privileged_writer() convention as guard_consultants_columns. That keeps
-- the orchestrator's authorised maintenance working - notably its writes to
-- email_notification_sent_at, which a client may never change.

create or replace function public.guard_messages_columns()
returns trigger
language plpgsql
as $$
begin
  if public.is_privileged_writer() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.consultation_id is distinct from old.consultation_id
     or new.sender_profile_id is distinct from old.sender_profile_id
     or new.recipient_profile_id is distinct from old.recipient_profile_id
     or new.body is distinct from old.body
     or new.created_at is distinct from old.created_at
     or new.email_notification_sent_at is distinct from old.email_notification_sent_at
  then
    raise exception 'only messages.read_at may be changed by clients';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_guard_columns on public.messages;
create trigger messages_guard_columns
  before update on public.messages
  for each row execute function public.guard_messages_columns();

-- -------------------------------------------------------------------- RLS ----
-- The three live policies are dropped by their exact discovered names and
-- replaced with a six-policy set: three for consultation messages (behaviour
-- preserved, scoped to consultation_id is not null) and three for direct
-- messages (scoped to consultation_id is null).

drop policy if exists messages_insert_participant on public.messages;
drop policy if exists messages_select_participants on public.messages;
drop policy if exists messages_update_recipient_read on public.messages;

-- --- Consultation messages: existing behaviour, explicitly re-scoped ---

create policy messages_consultation_select on public.messages
  for select
  to authenticated
  using (
    consultation_id is not null
    and (
      sender_profile_id = auth.uid()
      or recipient_profile_id = auth.uid()
      or public.is_admin()
    )
  );

create policy messages_consultation_insert on public.messages
  for insert
  to authenticated
  with check (
    consultation_id is not null
    and sender_profile_id = auth.uid()
    and recipient_profile_id <> auth.uid()
    and public.is_consultation_participant(consultation_id, auth.uid())
    and public.is_consultation_participant(consultation_id, recipient_profile_id)
  );

create policy messages_consultation_update on public.messages
  for update
  to authenticated
  using (
    consultation_id is not null
    and recipient_profile_id = auth.uid()
  )
  with check (
    consultation_id is not null
    and recipient_profile_id = auth.uid()
  );

-- --- Direct admin <-> consultant messages ---

create policy messages_direct_select on public.messages
  for select
  to authenticated
  using (
    consultation_id is null
    and (
      sender_profile_id = auth.uid()
      or recipient_profile_id = auth.uid()
      or public.is_admin()
    )
  );

-- The admin/consultant pairing is enforced by messages_direct_pairing, so the
-- policy itself only has to pin the sender to the caller.
create policy messages_direct_insert on public.messages
  for insert
  to authenticated
  with check (
    consultation_id is null
    and sender_profile_id = auth.uid()
    and recipient_profile_id <> auth.uid()
  );

create policy messages_direct_update on public.messages
  for update
  to authenticated
  using (
    consultation_id is null
    and recipient_profile_id = auth.uid()
  )
  with check (
    consultation_id is null
    and recipient_profile_id = auth.uid()
  );

-- No DELETE policy on either class: messages are immutable and not deletable.
-- Removing QA rows is an authorised service_role maintenance action.

commit;

-- ------------------------------------------------------------ verification ----
-- Run as the existing client / consultant / admin test users via the anon key.
-- Use clearly identified QA bodies.
--
--  1. admin -> consultant direct insert            : succeeds
--  2. consultant -> admin direct insert, no prior  : succeeds (initiation allowed)
--  3. consultant -> consultant direct insert       : fails (pairing trigger)
--  4. client -> admin direct insert                : fails (pairing trigger)
--  5. spoofed sender_profile_id                    : fails (RLS with check)
--  6. unrelated consultant reads the thread        : 0 rows
--  7. admin reads direct conversations             : succeeds
--  8. consultant reads only its own direct thread  : succeeds, scoped
--  9. recipient sets read_at                       : succeeds
-- 10. sender marks own sent message read           : fails (RLS using)
-- 11. direct body update                           : fails (guard trigger)
-- 12. consultation body update                     : fails (guard trigger)
-- 13. delete any message                           : fails (no DELETE policy)
-- 14. existing consultation send + read + read_at  : unchanged, still succeeds
-- 15. consultation-scoped query excludes direct    : direct rows absent
--
-- Cleanup: messages cannot be deleted through RLS. Remove QA rows afterwards
-- with an authorised service_role maintenance statement.
