-- ============================================================
-- Verification for migration_048_refresh_draft_intake
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, security and ACLs        read-only
--   Part 2  what the refresh changes        STAGING ONLY, rolls back
--   Part 3  what it cannot change           STAGING ONLY, rolls back
--   Part 4  the draft guard                 STAGING ONLY, rolls back
--   Part 5  regressions                     STAGING ONLY, rolls back
--   Part 6  rollback guidance
--
-- Parts 2 to 5 share one transaction that ends in ROLLBACK.
--
-- Per the standing rule established by migration 046: this file
-- INVOKES the RPC and asserts what it actually does. A signature
-- says nothing about what a function writes.
--
-- Part 3 is the important half. It takes a full snapshot of the
-- consultation before the refresh and compares it field by field
-- afterwards, so a column that should not have moved is caught
-- whether or not anybody thought to name it in a check.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  a draft's intake can be refreshed at all
--    2  full_name updates
--    3  email updates - the address every consultation
--       notification is actually sent to
--    4  client_gender updates, inside answers_jsonb
--    5  phone_whatsapp updates
--    6  a blank WhatsApp normalises to null, as on creation
--    7  the consultation summary updates
--    8  client_timezone updates
--    9  country_id updates, including to null
--   10  a repeated refresh with the same values changes nothing
--   11  the consultation id is unchanged
--   12  consultant_id is unchanged
--   13  scheduled_start_at is unchanged
--   14  scheduled_end_at is unchanged
--   15  price_cents is unchanged
--   16  currency is unchanged
--   17  booking_source is unchanged
--   18  every payment and finance field is unchanged, and so is
--       every other column nobody thought to name
--   19  a consultation past draft is refused, and left alone
--   20  an expired draft is still refusable at the database layer,
--       and is refused by the application before it gets here
--   21  service_role may execute it
--   22  PUBLIC, anon and authenticated may not
--   23  SECURITY DEFINER
--   24  a pinned search_path
--   25  migration 046's abandon_draft_consultation is unchanged
--   26  migration 047's expiry behaviour is unchanged
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, SECURITY AND ACLS (read-only)
-- ============================================================

-- Checks 21, 22, 23 and 24.

do $$
declare
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_role text;
  v_result text;
  v_expected constant text :=
    'TABLE(consultation_id uuid, refreshed boolean, reason text)';
begin
  v_oid := to_regprocedure(
    'public.refresh_draft_consultation_intake(uuid, text, text, text, jsonb, text, uuid, uuid)');

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 21: refresh_draft_consultation_intake does not exist at its expected signature';
  end if;

  select pg_get_function_result(v_oid) into v_result;

  if v_result is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 21: the RPC returns % and must return %',
      v_result, v_expected;
  end if;

  /* Check 23. */
  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ', '), '(none)')
    into v_secdef, v_config
    from pg_proc p
   where p.oid = v_oid;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 23: the RPC is not SECURITY DEFINER';
  end if;

  /* Check 24. */
  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 24: the RPC has search_path %', v_config;
  end if;

  /*
   * Check 22. The endpoint in front of this verifies the caller
   * holds the draft's checkout capability. A function that
   * rewrites a booking's contact details must not be reachable
   * without that.
   */
  foreach v_role in array array['public', 'anon', 'authenticated']
  loop
    if has_function_privilege(v_role, v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 22: % may rewrite draft intake through PostgREST',
        v_role;
    end if;
  end loop;

  /* Check 21. */
  if not has_function_privilege(
       'service_role', v_oid, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 21: service_role cannot execute the refresh RPC';
  end if;

  raise notice 'PASS 21-24: definer, pinned, service_role only, and the returned shape is right';
end $$;


-- ============================================================
-- PARTS 2 TO 5 — ONE TRANSACTION, ROLLED BACK
-- ============================================================

begin;

do $$
declare
  v_client uuid := gen_random_uuid();
  v_other_client uuid := gen_random_uuid();
  v_pro uuid := gen_random_uuid();
  v_con uuid := gen_random_uuid();
  v_country uuid;
begin
  insert into auth.users (id, email) values
    (v_client,       'v48-client@verification.invalid'),
    (v_other_client, 'v48-other@verification.invalid'),
    (v_pro,          'v48-a@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_client,       'client',     'V48 Client', 'v48-client@verification.invalid'),
    (v_other_client, 'client',     'V48 Other',  'v48-other@verification.invalid'),
    (v_pro,          'consultant', 'V48 A',      'v48-a@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  insert into public.consultants (id, profile_id, timezone, is_active)
  values (v_con, v_pro, 'UTC', true);

  /* A real country to move the booking to. */
  select id into v_country
    from public.countries
   order by id
   limit 1;

  perform set_config('app.v48_client', v_client::text, true);
  perform set_config('app.v48_other',  v_other_client::text, true);
  perform set_config('app.v48_con',    v_con::text, true);
  perform set_config('app.v48_country',
    coalesce(v_country::text, ''), true);
end $$;


-- ============================================================
-- PART 2 — WHAT THE REFRESH CHANGES
-- ============================================================

-- Checks 1 to 10.

do $$
declare
  v_client uuid := current_setting('app.v48_client')::uuid;
  v_other uuid := current_setting('app.v48_other')::uuid;
  v_con uuid := current_setting('app.v48_con')::uuid;
  v_country uuid := nullif(
    current_setting('app.v48_country'), '')::uuid;
  v_draft uuid;
  r record;
  v_intake public.consultation_intake%rowtype;
  v_consultation public.consultations%rowtype;
begin
  /* The booking as first submitted, with a typo in the email. */
  select consultation_id into v_draft
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2034-01-10 09:00:00+00',
      timestamptz '2034-01-10 10:00:00+00',
      'Europe/Istanbul',
      9700, 'usd',
      'Aisha Rahmn',
      'aisha@gmial.invalid',
      '+905551112233',
      '{"consultation_summary": "Moving to Turkiye.",
        "client_gender": "female",
        "preferred_consultant_gender": "female"}'::jsonb);

  /*
   * And the same booking as the visitor corrected it: name fixed,
   * email fixed, WhatsApp removed, summary rewritten, timezone and
   * destination changed, and the client profile re-resolved from
   * the corrected address.
   */
  select * into r
    from public.refresh_draft_consultation_intake(
      v_draft,
      'Aisha Rahman',
      'aisha@example.invalid',
      '   ',
      '{"consultation_summary": "Moving to Turkiye with two children.",
        "client_gender": "male",
        "preferred_consultant_gender": "no_preference"}'::jsonb,
      'Europe/London',
      v_country,
      v_other);

  /* Check 1. */
  if not r.refreshed or r.reason <> 'refreshed' then
    raise exception
      'VERIFICATION FAILED 1: refreshing a draft reported % / %',
      r.refreshed, r.reason;
  end if;

  select * into v_intake
    from public.consultation_intake i
   where i.consultation_id = v_draft;

  select * into v_consultation
    from public.consultations c
   where c.id = v_draft;

  /* Check 2. */
  if v_intake.full_name <> 'Aisha Rahman' then
    raise exception
      'VERIFICATION FAILED 2: full_name is %', v_intake.full_name;
  end if;

  /*
   * Check 3. Not cosmetic: consultation_intake.email is the
   * address the decline, timeout, admin cancellation,
   * recommendation and message notifications are actually sent to.
   * A discarded correction here means mail to an address the
   * visitor already knows is wrong.
   */
  if v_intake.email <> 'aisha@example.invalid' then
    raise exception
      'VERIFICATION FAILED 3: email is %', v_intake.email;
  end if;

  /* Check 4. */
  if v_intake.answers_jsonb ->> 'client_gender'
     <> 'male' then
    raise exception
      'VERIFICATION FAILED 4: client_gender is %',
      v_intake.answers_jsonb ->> 'client_gender';
  end if;

  if v_intake.answers_jsonb ->> 'preferred_consultant_gender'
     <> 'no_preference' then
    raise exception
      'VERIFICATION FAILED 4: preferred_consultant_gender is %',
      v_intake.answers_jsonb ->> 'preferred_consultant_gender';
  end if;

  /* Checks 5 and 6 — a cleared WhatsApp is null, not ''. */
  if v_intake.phone_whatsapp is not null then
    raise exception
      'VERIFICATION FAILED 6: a blank WhatsApp was stored as %; migration 005 trims it to null',
      quote_literal(v_intake.phone_whatsapp);
  end if;

  /* Check 7. */
  if v_intake.answers_jsonb ->> 'consultation_summary'
     <> 'Moving to Turkiye with two children.' then
    raise exception
      'VERIFICATION FAILED 7: the summary is %',
      v_intake.answers_jsonb ->> 'consultation_summary';
  end if;

  /* Check 8. */
  if v_consultation.client_timezone <> 'Europe/London' then
    raise exception
      'VERIFICATION FAILED 8: client_timezone is %',
      v_consultation.client_timezone;
  end if;

  /* Check 9. */
  if v_consultation.country_id is distinct from v_country then
    raise exception
      'VERIFICATION FAILED 9: country_id is %',
      v_consultation.country_id;
  end if;

  /*
   * And the client profile followed the corrected email. Leaving
   * it behind would send notifications to the new address while
   * dashboard access stayed under the old one.
   */
  if v_consultation.client_profile_id <> v_other then
    raise exception
      'VERIFICATION FAILED 3: client_profile_id did not follow the corrected email';
  end if;

  /* A null country is a real choice: general information. */
  perform public.refresh_draft_consultation_intake(
    v_draft, 'Aisha Rahman', 'aisha@example.invalid', null,
    '{"consultation_summary": "General questions."}'::jsonb,
    'Europe/London', null, null);

  select * into v_consultation
    from public.consultations c where c.id = v_draft;

  if v_consultation.country_id is not null then
    raise exception
      'VERIFICATION FAILED 9: a general-information booking kept country %',
      v_consultation.country_id;
  end if;

  /* And a null profile id leaves the profile alone. */
  if v_consultation.client_profile_id <> v_other then
    raise exception
      'VERIFICATION FAILED 9: a null client profile id moved the consultation';
  end if;

  /* Check 10 — the same values again change nothing. */
  perform public.refresh_draft_consultation_intake(
    v_draft, 'Aisha Rahman', 'aisha@example.invalid', null,
    '{"consultation_summary": "General questions."}'::jsonb,
    'Europe/London', null, null);

  select * into v_intake
    from public.consultation_intake i
   where i.consultation_id = v_draft;

  if v_intake.full_name <> 'Aisha Rahman'
     or v_intake.email <> 'aisha@example.invalid'
     or v_intake.phone_whatsapp is not null then
    raise exception
      'VERIFICATION FAILED 10: a repeated refresh changed the intake';
  end if;

  if (select count(*) from public.consultation_intake i
       where i.consultation_id = v_draft) <> 1 then
    raise exception
      'VERIFICATION FAILED 10: a repeated refresh created a second intake row';
  end if;

  perform set_config('app.v48_draft', v_draft::text, true);

  raise notice 'PASS 1-10: every visitor-editable field refreshes, blanks normalise, and a repeat is a no-op';
end $$;


-- ============================================================
-- PART 3 — WHAT IT CANNOT CHANGE
-- ============================================================

-- Checks 11 to 18.

do $$
declare
  v_client uuid := current_setting('app.v48_client')::uuid;
  v_con uuid := current_setting('app.v48_con')::uuid;
  v_draft uuid;
  v_before jsonb;
  v_after jsonb;
  v_key text;
  v_mutable constant text[] := array[
    'client_timezone', 'country_id', 'client_profile_id',
    'updated_at'
  ];
begin
  select consultation_id into v_draft
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2034-02-10 09:00:00+00',
      timestamptz '2034-02-10 10:00:00+00',
      'Europe/Istanbul', 20000, 'usd',
      'V48 Client', 'v48-client@verification.invalid',
      '+905551112233', '{}'::jsonb, 'direct_booking');

  /*
   * Give it a full payment history first, so the assertion below
   * covers columns a bare draft would leave null - a refresh that
   * quietly cleared a Stripe identifier would look identical to
   * one that never set it.
   */
  update public.consultations
     set stripe_payment_intent_id = 'pi_v48_immutable',
         stripe_mode = 'test',
         payment_authorized_at = timestamptz '2034-02-09 09:00:00+00',
         meet_link = 'https://meet.invalid/v48',
         google_event_id = 'evt_v48'
   where id = v_draft;

  select to_jsonb(c) into v_before
    from public.consultations c where c.id = v_draft;

  perform public.refresh_draft_consultation_intake(
    v_draft,
    'Someone Else Entirely',
    'someone-else@verification.invalid',
    '+441111111111',
    '{"consultation_summary": "Rewritten."}'::jsonb,
    'Pacific/Auckland',
    null,
    null);

  select to_jsonb(c) into v_after
    from public.consultations c where c.id = v_draft;

  /*
   * Checks 11 to 18, as one statement rather than eight.
   *
   * EVERY column is compared, and only the three the refresh is
   * allowed to touch are excused. A column added to consultations
   * later - a new payment field, a new finance attribution - is
   * covered by this the day it exists, without anybody
   * remembering to add a check for it. That is the point of
   * comparing the whole row.
   */
  for v_key in
    select jsonb_object_keys(v_before)
  loop
    if v_key = any(v_mutable) then
      continue;
    end if;

    if v_before -> v_key is distinct from v_after -> v_key then
      raise exception
        'VERIFICATION FAILED 11-18: the refresh changed consultations.% from % to %',
        v_key, v_before -> v_key, v_after -> v_key;
    end if;
  end loop;

  /* Named explicitly too, so a failure reads plainly. */
  if (v_after ->> 'consultant_id') is distinct from v_con::text then
    raise exception
      'VERIFICATION FAILED 12: consultant_id moved';
  end if;

  if (v_after ->> 'price_cents') <> '20000' then
    raise exception
      'VERIFICATION FAILED 15: price_cents is %',
      v_after ->> 'price_cents';
  end if;

  if (v_after ->> 'currency') <> 'usd' then
    raise exception
      'VERIFICATION FAILED 16: currency is %',
      v_after ->> 'currency';
  end if;

  if (v_after ->> 'booking_source') <> 'direct_booking' then
    raise exception
      'VERIFICATION FAILED 17: booking_source is %',
      v_after ->> 'booking_source';
  end if;

  if (v_after ->> 'stripe_payment_intent_id')
     <> 'pi_v48_immutable' then
    raise exception
      'VERIFICATION FAILED 18: the Stripe payment intent moved';
  end if;

  if (v_after ->> 'id') is distinct from v_draft::text then
    raise exception
      'VERIFICATION FAILED 11: the consultation id moved';
  end if;

  raise notice 'PASS 11-18: every column except timezone, country and client profile is byte-identical after a refresh';
end $$;


-- ============================================================
-- PART 4 — THE DRAFT GUARD
-- ============================================================

-- Checks 19 and 20.

do $$
declare
  v_client uuid := current_setting('app.v48_client')::uuid;
  v_con uuid := current_setting('app.v48_con')::uuid;
  v_id uuid;
  v_status text;
  r record;
  v_name text;
  v_index integer := 0;
  v_statuses text[] := array[
    'payment_authorized',
    'pending_acceptance',
    'confirmed',
    'captured',
    'completed',
    'cancelled'
  ];
begin
  /* Check 19 — nothing past draft is editable by a booking form. */
  foreach v_status in array v_statuses
  loop
    v_index := v_index + 1;

    select consultation_id into v_id
      from public.create_draft_consultation(
        v_client, v_con, null,
        (timestamptz '2034-03-01 09:00:00+00'
           + (v_index || ' days')::interval),
        (timestamptz '2034-03-01 10:00:00+00'
           + (v_index || ' days')::interval),
        'Europe/Istanbul', 9700, 'usd',
        'Original Name', 'original@verification.invalid',
        null, '{}'::jsonb);

    update public.consultations
       set status = v_status::consultation_status
     where id = v_id;

    select * into r
      from public.refresh_draft_consultation_intake(
        v_id, 'Tampered Name',
        'tampered@verification.invalid', null,
        '{}'::jsonb, 'Pacific/Auckland', null, null);

    if r.refreshed then
      raise exception
        'VERIFICATION FAILED 19: a % consultation was edited by the booking form',
        v_status;
    end if;

    if r.reason <> 'not_draft' then
      raise exception
        'VERIFICATION FAILED 19: refreshing a % consultation reported %',
        v_status, r.reason;
    end if;

    select i.full_name into v_name
      from public.consultation_intake i
     where i.consultation_id = v_id;

    if v_name <> 'Original Name' then
      raise exception
        'VERIFICATION FAILED 19: a % consultation''s intake is now %',
        v_status, v_name;
    end if;
  end loop;

  /* An unknown consultation is an outcome, not an error. */
  select * into r
    from public.refresh_draft_consultation_intake(
      gen_random_uuid(), 'Nobody', 'nobody@verification.invalid',
      null, '{}'::jsonb, 'UTC', null, null);

  if r.refreshed or r.reason <> 'not_found' then
    raise exception
      'VERIFICATION FAILED 19: refreshing an unknown consultation reported % / %',
      r.refreshed, r.reason;
  end if;

  /*
   * Check 20. An expired draft is still 'draft' in the database,
   * so this function will refresh it - deliberately. The hold is
   * an APPLICATION rule, enforced by the orchestrator before it
   * calls this and by migration 047's worker after; encoding it
   * here too would give the thirty minutes a third definition to
   * drift from. What this asserts is that the database does not
   * pretend to enforce something it does not.
   */
  select consultation_id into v_id
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2034-04-01 09:00:00+00',
      timestamptz '2034-04-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'Original Name', 'original@verification.invalid',
      null, '{}'::jsonb);

  update public.consultations
     set created_at = now() - interval '31 minutes'
   where id = v_id;

  select * into r
    from public.refresh_draft_consultation_intake(
      v_id, 'Late Edit', 'late@verification.invalid', null,
      '{}'::jsonb, 'UTC', null, null);

  if not r.refreshed then
    raise exception
      'VERIFICATION FAILED 20: the database refused an expired draft; the hold is an application rule and must have exactly one definition';
  end if;

  /* And migration 047 still takes it, edited or not. */
  perform public.expire_stale_draft_consultations(200);

  select c.status into v_status
    from public.consultations c where c.id = v_id;

  if v_status <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 20: an edited stale draft survived expiry as %',
      v_status;
  end if;

  raise notice 'PASS 19, 20: nothing past draft is editable, and the hold stays an application rule';
end $$;


-- ============================================================
-- PART 5 — REGRESSIONS
-- ============================================================

-- Checks 25 and 26.

do $$
declare
  v_client uuid := current_setting('app.v48_client')::uuid;
  v_con uuid := current_setting('app.v48_con')::uuid;
  v_draft uuid;
  v_stale uuid;
  v_advanced uuid;
  r record;
  v_status text;
begin
  /* Check 25 — migration 046's compensation, untouched. */
  select consultation_id into v_draft
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2034-05-01 09:00:00+00',
      timestamptz '2034-05-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V48 Client', 'v48-client@verification.invalid',
      null, '{}'::jsonb);

  /* A refreshed draft is still an ordinary draft afterwards. */
  perform public.refresh_draft_consultation_intake(
    v_draft, 'Refreshed Name', 'refreshed@verification.invalid',
    null, '{}'::jsonb, 'UTC', null, null);

  select * into r
    from public.abandon_draft_consultation(v_draft);

  if not r.cancelled or r.reason <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 25: abandoning a refreshed draft reported % / %',
      r.cancelled, r.reason;
  end if;

  select * into r
    from public.abandon_draft_consultation(v_draft);

  if r.cancelled or r.reason <> 'not_draft' then
    raise exception
      'VERIFICATION FAILED 25: abandon_draft_consultation is no longer idempotent';
  end if;

  select consultation_id into v_advanced
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2034-05-02 09:00:00+00',
      timestamptz '2034-05-02 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V48 Client', 'v48-client@verification.invalid',
      null, '{}'::jsonb);

  update public.consultations
     set status = 'confirmed' where id = v_advanced;

  select * into r
    from public.abandon_draft_consultation(v_advanced);

  if r.cancelled then
    raise exception
      'VERIFICATION FAILED 25: abandon_draft_consultation cancelled a confirmed booking';
  end if;

  /* Check 26 — migration 047's boundary, untouched. */
  select consultation_id into v_stale
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2034-06-01 09:00:00+00',
      timestamptz '2034-06-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V48 Client', 'v48-client@verification.invalid',
      null, '{}'::jsonb);

  update public.consultations
     set created_at = now() - interval '29 minutes'
   where id = v_stale;

  perform public.expire_stale_draft_consultations(200);

  select c.status into v_status
    from public.consultations c where c.id = v_stale;

  if v_status <> 'draft' then
    raise exception
      'VERIFICATION FAILED 26: a twenty-nine minute draft is now %',
      v_status;
  end if;

  select c.status into v_status
    from public.consultations c where c.id = v_advanced;

  if v_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 26: the confirmed booking is now %', v_status;
  end if;

  raise notice 'PASS 25, 26: migrations 046 and 047 are unaffected';
end $$;


rollback;


-- ============================================================
-- Confirm the rollback
-- ============================================================

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v48-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS: every fixture rolled back';
end $$;


-- ============================================================
-- PART 6 — ROLLBACK GUIDANCE
-- ============================================================
--
-- This migration adds one function and writes no data of its own.
-- Dropping it destroys nothing:
--
--   drop function if exists
--     public.refresh_draft_consultation_intake(
--       uuid, text, text, text, jsonb, text, uuid, uuid);
--
-- The consequence is that a visitor who edits their details and
-- then re-picks the same slot silently loses those edits again -
-- including a corrected email address, which is where every
-- consultation notification is sent. The orchestrator would fail
-- the refresh, and per its own rule would return an error while
-- leaving the existing draft and its hold intact, so no booking is
-- lost; the visitor simply cannot correct one.
--
-- Nothing else needs undoing. No table, column, index, constraint,
-- policy or grant on any existing object was changed, and
-- create_draft_consultation, abandon_draft_consultation,
-- expire_stale_draft_consultations and
-- unique_reserved_consultant_slot were not touched.
-- ============================================================

do $$
begin
  raise notice
    'migration 048 verification complete: no check raised';
end $$;
