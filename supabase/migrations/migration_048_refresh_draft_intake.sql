-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 048: Refresh a draft's intake
-- ============================================================
--
-- Classification:
-- - Correctness fix. One function. No table, no column, no index,
--   no policy, no RLS change, and no finance mutation of any kind.
--
-- WHAT THIS FIXES:
--
-- Migration 047 gave the draft endpoint a same-slot short circuit:
-- a visitor who goes back and re-picks the time they already hold
-- gets their existing draft returned rather than being refused by
-- their own booking. That is right about the SLOT and wrong about
-- everything else on the form.
--
-- The visitor did not only go back to the Time step. They may have
-- gone back to Details, corrected a typo in their email, fixed
-- their name, added a WhatsApp number, rewritten what they want to
-- discuss - and then re-picked the same time. Returning the draft
-- unchanged silently discards every one of those edits, and the
-- consultant receives the version the visitor already decided was
-- wrong.
--
-- consultation_intake.email is not a dead snapshot: it is the
-- address every consultation notification is actually sent to -
-- decline, authorization timeout, admin cancellation,
-- recommendation, message notification. A discarded correction
-- there means mail to an address the visitor knows is wrong.
--
-- WHAT IS MUTABLE, and it is exactly what the booking form asks:
--
--   consultation_intake  full_name, email, phone_whatsapp,
--                        answers_jsonb
--   consultations        client_timezone, country_id,
--                        client_profile_id
--
-- No field is invented here. Every one is already written by
-- create_draft_consultation from the same request body, through
-- the same Zod schema and the same normalisation.
--
-- WHY client_profile_id IS IN THAT LIST, which deserves saying
-- plainly because it looks like booking identity:
-- - It is DERIVED from the intake email. resolveBookingClient
--   turns the submitted address into a provisioned client profile
--   (Amendment 002), and create_draft_consultation stores the
--   result.
-- - So refreshing the email while leaving client_profile_id alone
--   would produce exactly the divergence this migration exists to
--   prevent: notifications to the corrected address, dashboard
--   access under the old one.
-- - It moves only while the consultation is a DRAFT, before any
--   payment, and only to the profile the visitor's own submitted
--   email resolves to - which is precisely what a fresh draft
--   would have done. The orchestrator passes null when the email
--   has not changed, and null means leave it alone.
--
-- WHAT IS NOT MUTABLE, and cannot be reached from here at all:
-- consultant_id, scheduled_start_at, scheduled_end_at, status,
-- price_cents, currency, booking_source, every Stripe identifier,
-- every payment timestamp, and everything in the ledger. None of
-- them is a parameter of this function. A caller cannot ask for
-- them to change, so no check has to refuse it.
--
-- THE STATUS PREDICATE IS THE SAFETY ARGUMENT, as it is for
-- migrations 046 and 047: the row is matched on id AND
-- status = 'draft'. A consultation that has been paid for,
-- accepted or completed is not editable by a booking form,
-- whatever a caller sends.
--
-- Rerun safety:
-- - Idempotent in both senses. CREATE OR REPLACE at a fixed
--   signature with declarative REVOKE/GRANT, and the function
--   itself writes the same values on a repeat call.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.consultations') is null
     or to_regclass('public.consultation_intake') is null then
    raise exception
      'migration 048: core tables not found - migration 001 must be applied first';
  end if;

  if to_regprocedure(
       'public.abandon_draft_consultation(uuid)'
     ) is null then
    raise exception
      'migration 048: abandon_draft_consultation not found - migration 046 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. refresh_draft_consultation_intake
-- ============================================================
--
-- Rewrites the visitor-editable half of a draft, and nothing else.
--
-- The consultation row is locked first, so the status check and
-- both updates see one consistent state - a draft cannot be
-- expired by migration 047's worker, or cancelled by migration
-- 046's compensation, between the check and the write.
--
-- The intake row is updated, and inserted only if it is somehow
-- missing. The row is created with the consultation and the pair is
-- unique, so in practice it is always the update.

create or replace function public.refresh_draft_consultation_intake(
  p_consultation_id uuid,
  p_full_name text,
  p_email text,
  p_phone_whatsapp text,
  p_answers_jsonb jsonb,
  p_client_timezone text,
  p_country_id uuid,
  /*
   * Null means "leave it as it is". The orchestrator resolves a
   * client profile only when the submitted email has actually
   * changed, so an ordinary refresh costs no account lookup.
   */
  p_client_profile_id uuid default null
)
returns table (
  consultation_id uuid,
  refreshed boolean,
  reason text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consultation public.consultations%rowtype;
begin
  if p_consultation_id is null then
    raise exception
      using
        errcode = '22023',
        message = 'A consultation id is required.';
  end if;

  select * into v_consultation
    from public.consultations c
   where c.id = p_consultation_id
   for update;

  if not found then
    return query
    select p_consultation_id, false, 'not_found'::text;
    return;
  end if;

  /*
   * The guard. A booking form may edit a draft and nothing else -
   * a consultation that has been paid for, accepted, completed or
   * cancelled is not editable, and this is where that is decided
   * rather than in a caller.
   */
  if v_consultation.status <> 'draft' then
    return query
    select p_consultation_id, false, 'not_draft'::text;
    return;
  end if;

  /*
   * The same validations create_draft_consultation applies to the
   * same values, so a refreshed draft cannot hold something a
   * fresh one would have refused.
   */
  if p_full_name is null or btrim(p_full_name) = '' then
    raise exception
      using
        errcode = '22023',
        message = 'A full name is required.';
  end if;

  if p_email is null or btrim(p_email) = '' then
    raise exception
      using
        errcode = '22023',
        message = 'An email address is required.';
  end if;

  if p_client_timezone is null
     or btrim(p_client_timezone) = '' then
    raise exception
      using
        errcode = '22023',
        message = 'A client timezone is required.';
  end if;

  /*
   * The consultation's own mutable half. Note what is absent:
   * consultant_id, the schedule, the status, the price, the
   * currency, the booking source and every payment column. They
   * are not parameters of this function, so they cannot be
   * reached.
   *
   * country_id is written unconditionally, including to null - a
   * null country is a general-information consultation and is a
   * real choice the visitor can make and unmake.
   */
  update public.consultations c
     set client_timezone = p_client_timezone,
         country_id = p_country_id,
         client_profile_id = coalesce(
           p_client_profile_id, c.client_profile_id)
   where c.id = p_consultation_id;

  update public.consultation_intake i
     set full_name = p_full_name,
         email = p_email,
         /* The same normalisation migration 005 applies. */
         phone_whatsapp = nullif(trim(p_phone_whatsapp), ''),
         answers_jsonb = coalesce(p_answers_jsonb, '{}'::jsonb)
   where i.consultation_id = p_consultation_id;

  /*
   * Written as UPDATE-then-INSERT rather than INSERT ... ON
   * CONFLICT deliberately. `consultation_id` is both an OUT
   * parameter of this function and a column of the target table,
   * and an ON CONFLICT inference clause cannot be table-qualified
   * - plpgsql resolves the bare name to the variable and the
   * statement will not compile. Every other reference here is
   * aliased for the same reason.
   *
   * The intake row is created with the consultation and the pair
   * is unique, so in practice the UPDATE always matches. The
   * INSERT is repair for a draft whose intake somehow went
   * missing, rather than a silent no-op.
   */
  if not found then
    insert into public.consultation_intake (
      consultation_id,
      full_name,
      email,
      phone_whatsapp,
      answers_jsonb
    )
    values (
      p_consultation_id,
      p_full_name,
      p_email,
      nullif(trim(p_phone_whatsapp), ''),
      coalesce(p_answers_jsonb, '{}'::jsonb)
    );
  end if;

  return query
  select p_consultation_id, true, 'refreshed'::text;
end;
$$;

comment on function public.refresh_draft_consultation_intake(
  uuid, text, text, text, jsonb, text, uuid, uuid) is
  'Migration 048. Rewrites the visitor-editable half of a DRAFT '
  'consultation - name, email, WhatsApp, answers, timezone, '
  'country, and the client profile the email resolves to - so a '
  'visitor who edits their details and then re-picks the same slot '
  'does not silently lose those edits. Matches id AND status = '
  'draft, so nothing past draft is editable. The consultant, the '
  'schedule, the price, the currency, the booking source and every '
  'payment field are not parameters and cannot be reached.';


-- ============================================================
-- B. Privileges
-- ============================================================
--
-- Migration 036's rule. Orchestrator-only: the endpoint in front
-- of it verifies the caller holds the draft's checkout capability
-- before this is ever called, and a function that rewrites a
-- booking's contact details must not be reachable from a browser.

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'refresh_draft_consultation_intake'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_fn
    );

    execute format(
      'grant execute on function %s to service_role',
      v_fn
    );
  end loop;
end;
$$;

commit;
