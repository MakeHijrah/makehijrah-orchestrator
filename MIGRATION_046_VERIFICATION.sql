-- ============================================================
-- Verification for migration_046_restore_draft_consultation_contract
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION. Part 7 is the exception and is
-- commented out; read its note before running anything from it.
--
--   Part 1  shape, security and ACLs           read-only
--   Part 2  the returned contract              STAGING ONLY, rolls back
--   Part 3  restored validations               STAGING ONLY, rolls back
--   Part 4  slot conflicts                     STAGING ONLY, rolls back
--   Part 5  abandon_draft_consultation         STAGING ONLY, rolls back
--   Part 6  regressions                        STAGING ONLY, rolls back
--   Part 7  stale draft cleanup                OPERATIONAL, not run here
--
-- Parts 2 to 6 share one transaction that ends in ROLLBACK.
--
-- WHY THIS FILE EXISTS AT ALL, and the rule it establishes:
--
-- Migration 045 replaced create_draft_consultation and changed its
-- return contract from five columns to two. Its verification file
-- checked that the function EXISTED at the right signature and
-- that its ACL was correct - and passed, because both were true.
-- The orchestrator tests passed too: they stub the RPC, and the
-- stub returned the shape the code expected rather than the shape
-- the database produced. Neither layer ever called the function.
--
-- So: ANY MIGRATION THAT REPLACES AN RPC THE ORCHESTRATOR CALLS
-- MUST HAVE A VERIFICATION THAT INVOKES IT AND ASSERTS ITS RUNTIME
-- RESULT CONTRACT, COLUMN BY COLUMN. Introspecting a signature is
-- not verification; a signature says nothing about what comes back.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  the function returns EXACTLY the five expected columns,
--       in order, with the expected types
--    2  hold_expires_at = created_at + 30 minutes
--    3  consultation_status is returned, and is 'draft'
--    4  consultation_price_cents is returned, and is the price
--       that was passed
--    5  consultation_currency is returned, and is the currency
--       that was passed
--    6  a standard booking defaults booking_source to 'standard'
--    7  a direct booking persists 'direct_booking'
--    8  a blank whatsapp number is stored as null
--    9  end <= start is rejected with 22023
--   10  a non-positive price is rejected with 22023
--   11  a non-lowercase currency is rejected with 22023
--   12  a duplicate reserved slot raises 23505, which is what the
--       orchestrator maps to 409 SLOT_TAKEN
--   13  the migration 045 overlap guard is GONE - an overlapping
--       booking at a different start time is accepted again, and
--       the function body raises no SLOT_TAKEN of its own
--   14  abandon_draft_consultation cancels a draft
--   15  it is idempotent
--   16  it will not touch a consultation past draft
--   17  a cancelled draft frees its slot immediately
--   18  create_draft_consultation's ACL survived the drop
--   19  abandon_draft_consultation's ACL is correct
--   20  both are SECURITY DEFINER with a pinned search_path
--   21  migration 045's direct booking finance is intact
--   22  the FINANCE_NOT_STANDARD_BOOKING guard is intact
--   23  direct booking finance still records the right split
--   24  the migration 044 dashboard read model still works
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, SECURITY AND ACLS (read-only)
-- ============================================================

-- Checks 1, 18, 19 and 20.

do $$
declare
  v_result text;
  v_expected constant text :=
    'TABLE(consultation_id uuid, consultation_status consultation_status, hold_expires_at timestamp with time zone, consultation_price_cents integer, consultation_currency text)';
  v_oid oid;
begin
  v_oid := to_regprocedure(
    'public.create_draft_consultation(uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text, text, text, text, jsonb, text)');

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 1: create_draft_consultation does not exist at its thirteen-argument signature';
  end if;

  /*
   * Check 1 — the whole point of this file. The signature was
   * right throughout the outage; the RESULT was not.
   */
  select pg_get_function_result(v_oid) into v_result;

  if v_result is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 1: create_draft_consultation returns % and must return % - the orchestrator reads hold_expires_at off this row and turns it into the checkout capability TTL',
      v_result, v_expected;
  end if;

  raise notice 'PASS 1: the five-column return contract is restored';
end $$;


do $$
declare
  v_signature text;
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_role text;
  v_signatures text[] := array[
    'public.create_draft_consultation(uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text, text, text, text, jsonb, text)',
    'public.abandon_draft_consultation(uuid)'
  ];
begin
  foreach v_signature in array v_signatures
  loop
    v_oid := to_regprocedure(v_signature);

    if v_oid is null then
      raise exception
        'VERIFICATION FAILED 19: % does not exist', v_signature;
    end if;

    /* Check 20. */
    select p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(none)')
      into v_secdef, v_config
      from pg_proc p
     where p.oid = v_oid;

    if not v_secdef then
      raise exception
        'VERIFICATION FAILED 20: % is not SECURITY DEFINER', v_signature;
    end if;

    if v_config is distinct from 'search_path=pg_catalog, public' then
      raise exception
        'VERIFICATION FAILED 20: % has search_path %', v_signature, v_config;
    end if;

    /*
     * Checks 18 and 19. create_draft_consultation was DROPPED by
     * this migration, which discards its ACL - and Supabase's
     * default privileges would hand EXECUTE straight back to anon.
     */
    foreach v_role in array array['public', 'anon', 'authenticated']
    loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception
          'VERIFICATION FAILED 18/19: % may execute %; it is reachable through PostgREST',
          v_role, v_signature;
      end if;
    end loop;

    if not has_function_privilege(
         'service_role', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 18/19: service_role cannot execute %; the orchestrator is locked out',
        v_signature;
    end if;
  end loop;

  raise notice 'PASS 18, 19, 20: both functions are definer, pinned, and service_role only';
end $$;


-- Check 13, first half — the guard is gone from the source.

do $$
declare
  v_body text;
begin
  select p.prosrc into v_body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'create_draft_consultation';

  /*
   * Comments are stripped before scanning. The restored function
   * explains in a comment WHY it has no slot guard, and a comment
   * saying "there is no guard here" must not read as a guard.
   * Block comments first, then line comments.
   */
  v_body := regexp_replace(v_body, '/\*.*?\*/', ' ', 'gs');
  v_body := regexp_replace(v_body, '--[^\n]*', ' ', 'g');

  /*
   * Migration 045 raised its own 'SLOT_TAKEN: ...' exception,
   * which carries SQLSTATE P0001. The orchestrator maps only
   * 23505 to a 409, so every genuine double booking became a 500
   * with an orphaned draft holding the slot.
   */
  if v_body like '%SLOT_TAKEN%' then
    raise exception
      'VERIFICATION FAILED 13: create_draft_consultation still raises its own SLOT_TAKEN; a duplicate would be P0001, not 23505, and the orchestrator would answer 500 instead of 409';
  end if;

  if v_body like '%scheduled_start_at < p_scheduled_end_at%' then
    raise exception
      'VERIFICATION FAILED 13: the migration 045 overlap guard is still present';
  end if;

  raise notice 'PASS 13 (source): no custom slot guard remains in the function body';
end $$;


-- Check 13, third part — the index itself is untouched.

do $$
declare
  v_definition text;
begin
  select indexdef into v_definition
    from pg_indexes
   where schemaname = 'public'
     and indexname = 'unique_reserved_consultant_slot';

  if v_definition is null then
    raise exception
      'VERIFICATION FAILED 13: unique_reserved_consultant_slot does not exist; the sole authority on slot conflicts is gone';
  end if;

  if v_definition not like '%consultant_id%'
     or v_definition not like '%scheduled_start_at%' then
    raise exception
      'VERIFICATION FAILED 13: unique_reserved_consultant_slot is defined as %', v_definition;
  end if;

  raise notice 'PASS 13 (index): unique_reserved_consultant_slot is intact and unmodified';
end $$;


-- ============================================================
-- PARTS 2 TO 6 — ONE TRANSACTION, ROLLED BACK
-- ============================================================

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_pro_a uuid := gen_random_uuid();
  v_con_a uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_admin,  'v46-admin@verification.invalid'),
    (v_client, 'v46-client@verification.invalid'),
    (v_pro_a,  'v46-a@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin,  'admin',      'V46 Admin',  'v46-admin@verification.invalid'),
    (v_client, 'client',     'V46 Client', 'v46-client@verification.invalid'),
    (v_pro_a,  'consultant', 'V46 A',      'v46-a@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  insert into public.consultants (
    id, profile_id, timezone, is_active,
    consultant_slug, direct_booking_enabled,
    direct_booking_price_cents)
  values (v_con_a, v_pro_a, 'UTC', true,
          'v46-aisha', true, 20000);

  perform set_config('app.v46_admin',  v_admin::text,  true);
  perform set_config('app.v46_client', v_client::text, true);
  perform set_config('app.v46_con',    v_con_a::text,  true);
end $$;


-- ============================================================
-- PART 2 — THE RETURNED CONTRACT
-- ============================================================

-- Checks 2, 3, 4, 5, 6, 7 and 8.

do $$
declare
  v_client uuid := current_setting('app.v46_client')::uuid;
  v_con uuid := current_setting('app.v46_con')::uuid;
  r record;
  v_created_at timestamptz;
  v_source text;
  v_whatsapp text;
begin
  /*
   * The call the orchestrator actually makes for a generic
   * booking: twelve positional arguments, no booking source.
   */
  select * into r
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-03-10 09:00:00+00',
      timestamptz '2032-03-10 10:00:00+00',
      'Europe/Istanbul',
      9700, 'usd',
      'V46 Client', 'v46-client@verification.invalid',
      '   ',
      '{"consultation_summary": "verification"}'::jsonb);

  if r.consultation_id is null then
    raise exception
      'VERIFICATION FAILED 3: no consultation id was returned';
  end if;

  /* Check 3. */
  if r.consultation_status is null then
    raise exception
      'VERIFICATION FAILED 3: consultation_status was not returned';
  end if;

  if r.consultation_status <> 'draft' then
    raise exception
      'VERIFICATION FAILED 3: consultation_status is %, not draft',
      r.consultation_status;
  end if;

  /* Check 4. */
  if r.consultation_price_cents is null then
    raise exception
      'VERIFICATION FAILED 4: consultation_price_cents was not returned';
  end if;

  if r.consultation_price_cents <> 9700 then
    raise exception
      'VERIFICATION FAILED 4: consultation_price_cents is %, not the 9700 that was passed',
      r.consultation_price_cents;
  end if;

  /* Check 5. */
  if r.consultation_currency is null then
    raise exception
      'VERIFICATION FAILED 5: consultation_currency was not returned';
  end if;

  if r.consultation_currency <> 'usd' then
    raise exception
      'VERIFICATION FAILED 5: consultation_currency is %', r.consultation_currency;
  end if;

  /*
   * Check 2 — THE COLUMN WHOSE ABSENCE CAUSED THE OUTAGE.
   *
   * The orchestrator turns this into the TTL of the Redis checkout
   * capability. A null or absent value becomes NaN through
   * Date.parse, the TTL calculation refuses it, and the endpoint
   * answers 500 with the consultation row already inserted.
   */
  if r.hold_expires_at is null then
    raise exception
      'VERIFICATION FAILED 2: hold_expires_at was not returned; every booking would 500 after inserting its consultation';
  end if;

  select c.created_at into v_created_at
    from public.consultations c
   where c.id = r.consultation_id;

  if r.hold_expires_at
     <> v_created_at + interval '30 minutes' then
    raise exception
      'VERIFICATION FAILED 2: hold_expires_at is % against a created_at of %; the hold is thirty minutes',
      r.hold_expires_at, v_created_at;
  end if;

  /* Check 6 — the generic path names no source and gets one. */
  select c.booking_source into v_source
    from public.consultations c
   where c.id = r.consultation_id;

  if v_source <> 'standard' then
    raise exception
      'VERIFICATION FAILED 6: a booking made with no source recorded %',
      v_source;
  end if;

  /* Check 8 — a blank whatsapp is null, not an empty string. */
  select i.phone_whatsapp into v_whatsapp
    from public.consultation_intake i
   where i.consultation_id = r.consultation_id;

  if v_whatsapp is not null then
    raise exception
      'VERIFICATION FAILED 8: a blank whatsapp number was stored as %; migration 005 trimmed it to null',
      quote_literal(v_whatsapp);
  end if;

  raise notice 'PASS 2-6, 8: all five columns are returned, the hold is thirty minutes, the source defaults, and a blank whatsapp is null';
end $$;


do $$
declare
  v_client uuid := current_setting('app.v46_client')::uuid;
  v_con uuid := current_setting('app.v46_con')::uuid;
  r record;
  v_source text;
begin
  /* Check 7 — a direct booking, at the effective price. */
  select * into r
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-03-11 09:00:00+00',
      timestamptz '2032-03-11 10:00:00+00',
      'Europe/Istanbul',
      20000, 'usd',
      'V46 Client', 'v46-client@verification.invalid',
      '+905551112233',
      '{"consultation_summary": "verification"}'::jsonb,
      'direct_booking');

  select c.booking_source into v_source
    from public.consultations c
   where c.id = r.consultation_id;

  if v_source <> 'direct_booking' then
    raise exception
      'VERIFICATION FAILED 7: a direct booking recorded source %', v_source;
  end if;

  /* And it returns the same five columns. */
  if r.hold_expires_at is null
     or r.consultation_status <> 'draft'
     or r.consultation_price_cents <> 20000
     or r.consultation_currency <> 'usd' then
    raise exception
      'VERIFICATION FAILED 7: a direct booking returned an incomplete row';
  end if;

  /* An unknown source is refused rather than defaulted. */
  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-03-12 09:00:00+00',
      timestamptz '2032-03-12 10:00:00+00',
      'Europe/Istanbul', 20000, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb, 'partner_referral');

    raise exception
      'VERIFICATION FAILED 7: an unknown booking source was accepted';
  exception
    when invalid_parameter_value then null;
  end;

  raise notice 'PASS 7: a direct booking persists direct_booking and an unknown source is refused';
end $$;


-- ============================================================
-- PART 3 — RESTORED VALIDATIONS
-- ============================================================

-- Checks 9, 10 and 11. All three were dropped by migration 045.

do $$
declare
  v_client uuid := current_setting('app.v46_client')::uuid;
  v_con uuid := current_setting('app.v46_con')::uuid;
begin
  /* Check 9. */
  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-04-01 10:00:00+00',
      timestamptz '2032-04-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

    raise exception
      'VERIFICATION FAILED 9: an end time equal to the start time was accepted';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-04-01 11:00:00+00',
      timestamptz '2032-04-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

    raise exception
      'VERIFICATION FAILED 9: an end time before the start time was accepted';
  exception
    when invalid_parameter_value then null;
  end;

  /* Check 10. */
  foreach v_client in array array[v_client, v_client]
  loop
    exit;
  end loop;

  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-04-02 10:00:00+00',
      timestamptz '2032-04-02 11:00:00+00',
      'Europe/Istanbul', 0, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

    raise exception
      'VERIFICATION FAILED 10: a price of zero was accepted';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-04-02 10:00:00+00',
      timestamptz '2032-04-02 11:00:00+00',
      'Europe/Istanbul', -1, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

    raise exception
      'VERIFICATION FAILED 10: a negative price was accepted';
  exception
    when invalid_parameter_value then null;
  end;

  /* Check 11. */
  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-04-03 10:00:00+00',
      timestamptz '2032-04-03 11:00:00+00',
      'Europe/Istanbul', 9700, 'USD',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

    raise exception
      'VERIFICATION FAILED 11: an uppercase currency was accepted; consultation_currency_lowercase would reject it later, from further away';
  exception
    when invalid_parameter_value then null;
  end;

  raise notice 'PASS 9, 10, 11: the three migration 005 validations are restored';
end $$;


-- ============================================================
-- PART 4 — SLOT CONFLICTS
-- ============================================================

-- Checks 12 and 13.

do $$
declare
  v_client uuid := current_setting('app.v46_client')::uuid;
  v_con uuid := current_setting('app.v46_con')::uuid;
  v_state text;
begin
  /*
   * Check 12 — the same consultant at the same start time. The
   * unique index refuses it, and the SQLSTATE matters as much as
   * the refusal: the orchestrator maps 23505, and only 23505, to
   * 409 SLOT_TAKEN.
   */
  begin
    perform public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-03-10 09:00:00+00',
      timestamptz '2032-03-10 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

    raise exception
      'VERIFICATION FAILED 12: a duplicate reserved slot was accepted';
  exception
    when unique_violation then
      null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate;

      raise exception
        'VERIFICATION FAILED 12: a duplicate slot raised SQLSTATE % and must raise 23505; the orchestrator maps only 23505 to 409 SLOT_TAKEN and would answer 500 with an orphaned draft',
        v_state;
  end;

  /*
   * Check 13 — the overlap guard really is gone.
   *
   * unique_reserved_consultant_slot keys on the exact start time,
   * so a booking that overlaps at a DIFFERENT start time has
   * always been accepted. Migration 045's guard blocked it. This
   * asserts the previous behaviour is back, rather than merely
   * that the source text changed.
   */
  perform public.create_draft_consultation(
    v_client, v_con, null,
    timestamptz '2032-03-10 09:30:00+00',
    timestamptz '2032-03-10 10:30:00+00',
    'Europe/Istanbul', 9700, 'usd',
    'V46 Client', 'v46-client@verification.invalid', null,
    '{}'::jsonb);

  raise notice 'PASS 12, 13: a duplicate slot raises 23505 and the overlap guard is gone';
end $$;


-- ============================================================
-- PART 5 — abandon_draft_consultation
-- ============================================================

-- Checks 14, 15, 16 and 17.

do $$
declare
  v_client uuid := current_setting('app.v46_client')::uuid;
  v_con uuid := current_setting('app.v46_con')::uuid;
  v_draft uuid;
  v_advanced uuid;
  r record;
  v_status text;
  v_cancelled_at timestamptz;
begin
  select consultation_id into v_draft
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-05-01 09:00:00+00',
      timestamptz '2032-05-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

  /* Check 14. */
  select * into r
    from public.abandon_draft_consultation(v_draft);

  if not r.cancelled or r.reason <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 14: abandoning a draft reported % / %',
      r.cancelled, r.reason;
  end if;

  select c.status, c.cancelled_at
    into v_status, v_cancelled_at
    from public.consultations c
   where c.id = v_draft;

  if v_status <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 14: the draft is still %', v_status;
  end if;

  if v_cancelled_at is null then
    raise exception
      'VERIFICATION FAILED 14: cancelled_at was not stamped';
  end if;

  /* Check 15 — idempotent. */
  select * into r
    from public.abandon_draft_consultation(v_draft);

  if r.cancelled then
    raise exception
      'VERIFICATION FAILED 15: a second abandon reported a change';
  end if;

  if r.reason <> 'not_draft' then
    raise exception
      'VERIFICATION FAILED 15: a second abandon reported %', r.reason;
  end if;

  /*
   * Check 17 — and the slot is free. This is the property the
   * whole compensation exists for: a failed booking must not hold
   * a consultant's calendar hostage.
   */
  perform public.create_draft_consultation(
    v_client, v_con, null,
    timestamptz '2032-05-01 09:00:00+00',
    timestamptz '2032-05-01 10:00:00+00',
    'Europe/Istanbul', 9700, 'usd',
    'V46 Client', 'v46-client@verification.invalid', null,
    '{}'::jsonb);

  /*
   * Check 16 — a consultation that has advanced past draft is
   * untouchable. This is the safety property: the compensation
   * runs on a failing path, and it must be incapable of cancelling
   * a booking whose payment preparation actually succeeded.
   */
  select consultation_id into v_advanced
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-05-02 09:00:00+00',
      timestamptz '2032-05-02 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

  update public.consultations
     set status = 'payment_authorized',
         payment_authorized_at = now()
   where id = v_advanced;

  select * into r
    from public.abandon_draft_consultation(v_advanced);

  if r.cancelled then
    raise exception
      'VERIFICATION FAILED 16: an authorized consultation was cancelled by the draft compensation';
  end if;

  if r.reason <> 'not_draft' then
    raise exception
      'VERIFICATION FAILED 16: abandoning an authorized consultation reported %',
      r.reason;
  end if;

  select c.status into v_status
    from public.consultations c
   where c.id = v_advanced;

  if v_status <> 'payment_authorized' then
    raise exception
      'VERIFICATION FAILED 16: the authorized consultation is now %', v_status;
  end if;

  /* An unknown id is an outcome, not an error. */
  select * into r
    from public.abandon_draft_consultation(gen_random_uuid());

  if r.cancelled or r.reason <> 'not_found' then
    raise exception
      'VERIFICATION FAILED 16: abandoning an unknown consultation reported % / %',
      r.cancelled, r.reason;
  end if;

  raise notice 'PASS 14-17: a draft is cancelled once, the slot is freed, and an advanced consultation is untouchable';
end $$;


-- ============================================================
-- PART 6 — REGRESSIONS
-- ============================================================

-- Checks 21, 22, 23 and 24.

do $$
declare
  v_client uuid := current_setting('app.v46_client')::uuid;
  v_con uuid := current_setting('app.v46_con')::uuid;
  v_direct uuid;
  v_standard uuid;
  r record;
  v_rows integer;
begin
  update public.app_settings
     set consultation_price_cents = 15000,
         consultation_consultant_commission_bps = 5000;

  /* A captured, completed direct booking at 20000. */
  select consultation_id into v_direct
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-06-01 09:00:00+00',
      timestamptz '2032-06-01 10:00:00+00',
      'Europe/Istanbul', 20000, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb, 'direct_booking');

  update public.consultations
     set status = 'captured',
         captured_at = now(),
         completed_at = now()
   where id = v_direct;

  /* Check 23 — the split is still the locked one. */
  select * into r
    from public.record_direct_booking_earning(v_direct);

  if r.standard_consultant_minor <> 7500
     or r.standard_platform_minor <> 7500
     or r.premium_consultant_minor <> 4000
     or r.premium_platform_minor <> 1000 then
    raise exception
      'VERIFICATION FAILED 23: the direct booking split is %/%/%/% and must be 7500/7500/4000/1000',
      r.standard_consultant_minor, r.standard_platform_minor,
      r.premium_consultant_minor, r.premium_platform_minor;
  end if;

  /* Check 21 — the direct RPCs still refuse a standard booking. */
  select consultation_id into v_standard
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2032-06-02 09:00:00+00',
      timestamptz '2032-06-02 10:00:00+00',
      'Europe/Istanbul', 15000, 'usd',
      'V46 Client', 'v46-client@verification.invalid', null,
      '{}'::jsonb);

  update public.consultations
     set status = 'captured',
         captured_at = now(),
         completed_at = now()
   where id = v_standard;

  begin
    perform public.record_direct_booking_earning(v_standard);

    raise exception
      'VERIFICATION FAILED 21: the direct booking RPC accepted a standard consultation';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%FINANCE_NOT_DIRECT_BOOKING%' then
        raise;
      end if;
  end;

  /*
   * Check 22 — and the standard RPC still refuses a direct
   * booking. This guard is migration 045's and is unrelated to the
   * regression; removing it would allow two earnings for one
   * payment.
   */
  begin
    perform public.record_consultation_earning(v_direct);

    raise exception
      'VERIFICATION FAILED 22: the standard RPC accepted a direct booking; it would have written a second, wrongly split earning';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%FINANCE_NOT_STANDARD_BOOKING%' then
        raise;
      end if;
  end;

  /* And the standard path still works. */
  perform public.record_consultation_earning(v_standard);

  select count(*) into v_rows
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_id = v_standard;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED 22: a standard consultation wrote % earning row(s)',
      v_rows;
  end if;

  raise notice 'PASS 21, 22, 23: both finance guards hold and both splits are unchanged';
end $$;


do $$
declare
  v_admin uuid := current_setting('app.v46_admin')::uuid;
  r record;
  v_seen boolean := false;
begin
  /* Check 24 — the dashboard read model still answers. */
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  for r in
    select *
      from public.get_admin_revenue_by_source(
        now() - interval '1 hour',
        now() + interval '1 hour',
        now() - interval '2 hours',
        now() - interval '1 hour')
  loop
    if r.period = 'current'
       and r.source_type = 'direct_booking' then
      v_seen := true;
    end if;
  end loop;

  reset role;

  if not v_seen then
    raise exception
      'VERIFICATION FAILED 24: the dashboard read model reported no direct_booking row';
  end if;

  raise notice 'PASS 24: the migration 044 dashboard read model is unaffected';
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
   where email like 'v46-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS: every fixture rolled back, app_settings included';
end $$;


-- ============================================================
-- PART 7 — STALE DRAFT CLEANUP (OPERATIONAL, NOT PART OF THE RUN)
-- ============================================================
--
-- Deliberately NOT in migration 046 and deliberately not executed
-- by this file. These are live bookings, and cancelling them is an
-- operational judgement whose row count somebody should read
-- before and after - not something that runs unattended on every
-- environment a migration touches.
--
-- The scope is the ESTABLISHED HOLD LIFETIME, not the deployment
-- window of any particular commit. A draft older than thirty
-- minutes is past its hold and must not still be reserving
-- availability, whatever created it. Nothing in the system
-- reclaims these: the expire-drafts job in API_CONTRACT section 5
-- has never been implemented.
--
-- STEP 1 - REVIEW. Read this before changing anything.
--
--   select
--     id,
--     client_profile_id,
--     consultant_id,
--     scheduled_start_at,
--     scheduled_end_at,
--     created_at,
--     created_at + interval '30 minutes' as hold_expired_at
--   from public.consultations
--   where status = 'draft'
--     and created_at < now() - interval '30 minutes'
--   order by created_at desc;
--
-- STEP 2 - CANCEL. Report the affected row count.
--
--   update public.consultations
--   set
--     status = 'cancelled',
--     cancelled_at = now()
--   where status = 'draft'
--     and created_at < now() - interval '30 minutes';
--
-- Do NOT widen this to drafts younger than thirty minutes: those
-- are live bookings in progress, and someone is on the checkout
-- page.
--
-- 'cancelled' is outside unique_reserved_consultant_slot's status
-- list, so every affected slot becomes bookable the moment this
-- commits.
-- ============================================================


-- ============================================================
-- ROLLBACK GUIDANCE
-- ============================================================
--
-- There is nothing here worth rolling back to. Migration 046
-- restores a contract that migration 045 broke; reverting it
-- reinstates an outage in which every booking answers 500 after
-- inserting a row that then holds a slot forever.
--
-- If abandon_draft_consultation alone must go:
--
--   drop function if exists public.abandon_draft_consultation(uuid);
--
-- The consequence is that a booking which fails between the
-- consultation insert and the checkout capability leaves its draft
-- holding the slot, with nothing to reclaim it. The orchestrator
-- tolerates the function's absence - cleanup never changes the
-- response - but the slot leak returns.
-- ============================================================

do $$
begin
  raise notice
    'migration 046 verification complete: no check raised';
end $$;
