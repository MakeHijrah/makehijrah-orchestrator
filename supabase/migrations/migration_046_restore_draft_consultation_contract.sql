-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 046: Restore the draft consultation contract
-- ============================================================
--
-- Classification:
-- - Regression fix. Repairs create_draft_consultation, which
--   migration 045 replaced with a different return contract, and
--   adds one narrow compensation RPC. No schema change, no policy
--   change, no finance change.
--
-- WHAT WENT WRONG, stated plainly:
--
-- Migration 005 declared create_draft_consultation as returning
-- FIVE columns:
--
--     consultation_id, consultation_status, hold_expires_at,
--     consultation_price_cents, consultation_currency
--
-- Migration 045 needed to add a booking_source argument. Because
-- the old signature was dropped rather than overloaded, the
-- function was rewritten - and the rewrite returned only
-- (consultation_id, created_at). Four columns vanished.
--
-- The orchestrator reads hold_expires_at off that row and turns it
-- into the TTL of the Redis checkout capability. Reading a column
-- that is no longer returned yields undefined, Date.parse gives
-- NaN, the TTL calculation refuses it, and the endpoint answers
-- 500 - AFTER the consultation row has already been inserted. Every
-- generic booking failed this way, every direct booking with it,
-- and each failed attempt left a draft holding the slot.
--
-- This migration restores migration 005's body VERBATIM. The only
-- differences from 005 are the two things migration 045 was
-- legitimately adding: the p_booking_source parameter and the
-- booking_source insert column. Everything else - the validations,
-- the whatsapp trim, the hold arithmetic, the returned shape - is
-- migration 005's, character for character.
--
-- THE OVERLAP GUARD IS REMOVED, and that is deliberate:
-- - Migration 045 added an EXISTS check that raised
--   'SLOT_TAKEN: ...' as a plain exception, SQLSTATE P0001. The
--   orchestrator maps only 23505 to a 409, so a genuine double
--   booking became a 500 with an orphaned draft - which is how a
--   consultant's whole day could be consumed by retries.
-- - The guard was also BROADER than the index it duplicated. The
--   index covers draft, payment_authorized, pending_acceptance,
--   confirmed and captured; the guard excluded only cancelled,
--   declined and authorization_cancelled, so a slot left in
--   admin_attention by a decline or a 48-hour timeout was blocked
--   forever, as was one whose consultation had completed.
-- - unique_reserved_consultant_slot has been the sole authority on
--   slot conflicts since migration 001 and is again. It is not
--   touched by this migration.
--
-- WHAT THIS MIGRATION DOES:
--   A. create_draft_consultation, restored.
--   B. abandon_draft_consultation, new.
--   C. Privileges.
--
-- WHAT IT DOES NOT TOUCH:
-- - record_consultation_earning keeps its migration 045
--   FINANCE_NOT_STANDARD_BOOKING guard. That guard prevents two
--   earnings for one payment and is unrelated to this regression.
-- - record/release/reverse_direct_booking_earning are unchanged.
-- - No table, column, index, constraint, policy or grant on any
--   existing object is altered.
--
-- Rerun safety:
-- - Idempotent. The replaced function is dropped by name at both
--   known signatures before being recreated, the new function is
--   CREATE OR REPLACE at a fixed signature, and REVOKE/GRANT are
--   declarative.
--
-- NOT INCLUDED, deliberately: the cleanup of drafts already
-- stranded by this bug. Those rows are operational data, not
-- schema, and cancelling them is a judgement about live bookings
-- that belongs in a reviewed statement an operator runs and reads
-- the count of - not in a migration that runs unattended on every
-- environment. The statement is in MIGRATION_046_VERIFICATION.sql
-- part 7.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.consultations') is null
     or to_regclass('public.consultation_intake') is null then
    raise exception
      'migration 046: core tables not found - migration 001 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'consultations'
       and column_name = 'booking_source'
  ) then
    raise exception
      'migration 046: consultations.booking_source not found - migration 045 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. create_draft_consultation, restored
-- ============================================================
--
-- Dropped at BOTH known signatures: the twelve-argument one from
-- migration 005, in case this runs against a database that never
-- received 045, and the thirteen-argument one from 045, whose
-- return type cannot be changed by CREATE OR REPLACE.

drop function if exists public.create_draft_consultation(
  uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text,
  text, text, text, jsonb);

drop function if exists public.create_draft_consultation(
  uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text,
  text, text, text, jsonb, text);

create or replace function public.create_draft_consultation(
  p_client_profile_id uuid,
  p_consultant_id uuid,
  p_country_id uuid,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at timestamptz,
  p_client_timezone text,
  p_price_cents integer,
  p_currency text,
  p_full_name text,
  p_email text,
  p_phone_whatsapp text,
  p_answers_jsonb jsonb,
  p_booking_source text default 'standard'
)
returns table (
  consultation_id uuid,
  consultation_status consultation_status,
  hold_expires_at timestamptz,
  consultation_price_cents integer,
  consultation_currency text
)
language plpgsql
security definer
/*
 * Migration 036's hardened form, retained. Migration 005 pinned
 * 'public, pg_temp'; 036 moved every orchestrator RPC to this.
 */
set search_path = pg_catalog, public
as $$
declare
  v_consultation_id uuid;
  v_created_at timestamptz;
  v_source text := coalesce(
    nullif(btrim(lower(p_booking_source)), ''), 'standard');
begin
  /*
   * The one addition from migration 045. booking_source decides
   * which commission rule applies to the money, so an unknown
   * value is refused rather than defaulted - a typo must not
   * silently become a standard booking.
   */
  if v_source not in ('standard', 'direct_booking') then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation booking source is not supported.';
  end if;

  if p_scheduled_end_at <= p_scheduled_start_at then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation end time must be later than start time.';
  end if;

  if p_price_cents <= 0 then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation price must be greater than zero.';
  end if;

  if p_currency is null or p_currency <> lower(p_currency) then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation currency must be lowercase.';
  end if;

  /*
   * NO OVERLAP GUARD. unique_reserved_consultant_slot is the sole
   * authority on slot conflicts, exactly as it has been since
   * migration 001, and a conflict surfaces as 23505 - which is
   * what the orchestrator maps to 409 SLOT_TAKEN. A guard here
   * that raised its own exception would produce P0001 instead and
   * turn every double booking into a 500.
   */
  insert into public.consultations (
    client_profile_id,
    consultant_id,
    country_id,
    status,
    scheduled_start_at,
    scheduled_end_at,
    client_timezone,
    price_cents,
    currency,
    booking_source
  )
  values (
    p_client_profile_id,
    p_consultant_id,
    p_country_id,
    'draft',
    p_scheduled_start_at,
    p_scheduled_end_at,
    p_client_timezone,
    p_price_cents,
    p_currency,
    v_source
  )
  returning
    id,
    created_at
  into
    v_consultation_id,
    v_created_at;

  insert into public.consultation_intake (
    consultation_id,
    full_name,
    email,
    phone_whatsapp,
    answers_jsonb
  )
  values (
    v_consultation_id,
    p_full_name,
    p_email,
    nullif(trim(p_phone_whatsapp), ''),
    coalesce(p_answers_jsonb, '{}'::jsonb)
  );

  /*
   * THE FIVE COLUMNS THE ORCHESTRATOR READS. hold_expires_at is
   * derived here, not stored: the draft hold is thirty minutes
   * from creation, and it is the TTL of the Redis checkout
   * capability the caller is about to mint. Dropping this column
   * is what broke every booking between migrations 045 and 046.
   */
  return query
  select
    v_consultation_id,
    'draft'::consultation_status,
    v_created_at + interval '30 minutes',
    p_price_cents,
    p_currency;
end;
$$;

comment on function public.create_draft_consultation(
  uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text,
  text, text, text, jsonb, text) is
  'Migration 005, restored by migration 046 after migration 045 '
  'replaced its five-column return contract with a two-column one '
  'and broke every booking. Returns consultation_id, '
  'consultation_status, hold_expires_at (created_at + 30 minutes), '
  'consultation_price_cents and consultation_currency. The only '
  'additions to migration 005 are p_booking_source and the '
  'booking_source insert. Slot conflicts are left entirely to '
  'unique_reserved_consultant_slot, so a duplicate raises 23505.';


-- ============================================================
-- B. abandon_draft_consultation
-- ============================================================
--
-- Compensation for a draft that was created and then could not be
-- prepared for payment.
--
-- The endpoint inserts the consultation and then mints a Redis
-- checkout capability. Those two steps cannot share a transaction -
-- one is PostgreSQL and one is Redis - so there is a window in
-- which the row exists and the booking cannot proceed. Before this
-- function existed, such a row sat in 'draft' forever, holding a
-- slot no one could book, because nothing in the system reclaims an
-- abandoned draft: the expire-drafts job named in API_CONTRACT
-- section 5 has never been implemented.
--
-- WHY CANCEL RATHER THAN DELETE:
-- - 'cancelled' is outside unique_reserved_consultant_slot's status
--   list, so the slot is free the moment this commits. Deleting
--   would free it too, and would also destroy the evidence of the
--   failure being investigated. consultation_intake cascades, so a
--   delete would take the intake with it.
--
-- THE STATUS PREDICATE IS THE WHOLE SAFETY ARGUMENT:
-- - The update matches on id AND status = 'draft'. A consultation
--   that has advanced - authorized, accepted, captured, completed -
--   does not match, so this function CANNOT cancel a booking whose
--   payment preparation actually succeeded, however it is called.
-- - It is therefore idempotent: the second call matches nothing and
--   reports cancelled = false.
-- - It takes no status argument and can produce no status other
--   than 'cancelled'. It is not a general transition RPC.

create or replace function public.abandon_draft_consultation(
  p_consultation_id uuid
)
returns table (
  consultation_id uuid,
  cancelled boolean,
  reason text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_updated integer;
  v_exists boolean;
begin
  if p_consultation_id is null then
    raise exception
      using
        errcode = '22023',
        message = 'A consultation id is required.';
  end if;

  update public.consultations c
     set status = 'cancelled',
         cancelled_at = now()
   where c.id = p_consultation_id
     and c.status = 'draft';

  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    return query
    select p_consultation_id, true, 'cancelled'::text;
    return;
  end if;

  /*
   * Nothing changed. Distinguish the two harmless reasons, because
   * a caller logging 'not_draft' against a consultation it believed
   * it had just created is worth seeing.
   */
  select exists (
    select 1 from public.consultations c
     where c.id = p_consultation_id
  ) into v_exists;

  return query
  select p_consultation_id, false,
         case when v_exists then 'not_draft'::text
              else 'not_found'::text
         end;
end;
$$;

comment on function public.abandon_draft_consultation(uuid) is
  'Migration 046. Cancels a consultation that is still in draft, '
  'so a request that created the row and then failed to prepare it '
  'for payment does not leave the slot reserved. Matches on id AND '
  'status = draft, so it cannot touch a consultation that has '
  'advanced past draft and is idempotent by construction. Sets no '
  'status other than cancelled and is not a general transition RPC.';


-- ============================================================
-- C. Privileges
-- ============================================================
--
-- Migration 036's rule, reapplied. create_draft_consultation was
-- DROPPED above, which discards its ACL, and Supabase's default
-- privileges would otherwise hand EXECUTE straight back to anon
-- and authenticated. Both functions are orchestrator-only: the
-- endpoints in front of them do the authorisation.

do $$
declare
  v_fn regprocedure;
  v_names text[] := array[
    'create_draft_consultation',
    'abandon_draft_consultation'
  ];
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
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
