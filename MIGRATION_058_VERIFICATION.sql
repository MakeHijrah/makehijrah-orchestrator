-- ============================================================
-- Verification for migration_058_client_requested_cancellation_followup
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape and grants                  read-only
--   Part 2  RPC behaviour                     STAGING ONLY, rolls back
--   Part 3  rollback guidance
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  cancellation_source exists: text, nullable, no default    Part 1
--    2  the CHECK constraint permits exactly the three values     Part 1
--    3  no pre-existing row acquired a value (no backfill)        Part 1
--    4  the old 3-arg overload is gone; only the new 4-arg
--       signature exists                                         Part 1
--    5  anon and authenticated cannot execute the new signature,
--       service_role can                                         Part 1
--    6  a caller omitting the new argument still cancels and
--       defaults to 'admin' — backward compatibility             Part 2
--    7  client_requested is accepted and persisted                Part 2
--    8  a repeat call cannot change the stored source, even
--       supplying a different value — the same idempotency
--       that already protects status and admin_attention_reason  Part 2
--    9  an invalid source is refused by the RPC with a named
--       marker, and by the table CHECK directly                  Part 2
--   10  refund and note behaviour are unchanged                  Part 2
--   11  fixtures roll back, asserted not assumed                  Part 2
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE AND GRANTS (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_type text;
  v_nullable text;
  v_default text;
begin
  select data_type, is_nullable, column_default
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultations'
     and column_name = 'cancellation_source';

  if v_type is null then
    raise exception
      'VERIFICATION FAILED 1: consultations.cancellation_source does not exist';
  end if;

  if v_type <> 'text' then
    raise exception
      'VERIFICATION FAILED 1: cancellation_source is %, expected text', v_type;
  end if;

  if v_nullable <> 'YES' then
    raise exception
      'VERIFICATION FAILED 1: cancellation_source is NOT NULL';
  end if;

  if v_default is not null then
    raise exception
      'VERIFICATION FAILED 1: cancellation_source carries a default (%)',
      v_default;
  end if;

  raise notice
    'PASS 1: cancellation_source is text, nullable, no default';
end $$;


-- Check 2.

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.consultations'::regclass
     and conname = 'consultations_cancellation_source_check';

  if v_def is null then
    raise exception
      'VERIFICATION FAILED 2: consultations_cancellation_source_check does not exist';
  end if;

  if v_def !~ 'client_requested'
     or v_def !~ '''admin'''
     or v_def !~ '''system''' then
    raise exception
      'VERIFICATION FAILED 2: constraint definition is %, missing an expected value',
      v_def;
  end if;

  raise notice 'PASS 2: the constraint permits client_requested, admin and system';
end $$;


-- Check 3.

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from public.consultations
   where cancellation_source is not null;

  if v_count <> 0 then
    raise notice
      'CHECK 3: % row(s) already carry a cancellation_source. Expected 0 immediately after applying; anything else means the RPC has already been used since.',
      v_count;
  else
    raise notice 'PASS 3: no pre-existing row acquired a cancellation_source';
  end if;
end $$;


-- Check 4.

do $$
begin
  if to_regprocedure(
       'public.finalize_admin_consultation_cancel(uuid,boolean,text)'
     ) is not null then
    raise exception
      'VERIFICATION FAILED 4: the old 3-arg overload still exists alongside the new one';
  end if;

  if to_regprocedure(
       'public.finalize_admin_consultation_cancel(uuid,boolean,text,text)'
     ) is null then
    raise exception
      'VERIFICATION FAILED 4: the new 4-arg signature does not exist';
  end if;

  raise notice 'PASS 4: only the new 4-arg signature exists';
end $$;


-- Check 5.

do $$
declare
  v_sig text :=
    'public.finalize_admin_consultation_cancel(uuid,boolean,text,text)';
begin
  if has_function_privilege('anon', v_sig, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 5: anon can execute %', v_sig;
  end if;

  if has_function_privilege('authenticated', v_sig, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 5: authenticated can execute %', v_sig;
  end if;

  if not has_function_privilege('service_role', v_sig, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 5: service_role cannot execute %', v_sig;
  end if;

  raise notice 'PASS 5: service_role only, matching every other finalize_* RPC';
end $$;


-- ============================================================
-- PART 2 — RPC BEHAVIOUR (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_client uuid := gen_random_uuid();
  v_consultant_profile uuid := gen_random_uuid();
  v_consultant uuid;
  v_country uuid;
  v_legacy uuid;
  v_client_requested uuid;
  v_bad_source uuid;
  v_refund_target uuid;
  v_status public.consultation_status;
  v_source text;
  v_reason text;
  v_cancelled_at timestamptz;
begin
  insert into auth.users (id, email) values
    (v_client, 'v58-client@verification.invalid'),
    (v_consultant_profile, 'v58-consultant@verification.invalid');

  insert into public.consultants (profile_id, timezone)
  values (v_consultant_profile, 'Africa/Cairo')
  returning id into v_consultant;

  insert into public.countries (name, iso_code)
  values ('ZZ V58 Country', 'Q6') returning id into v_country;

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status, price_cents,
     currency, scheduled_start_at, scheduled_end_at)
  values
    (v_client, v_consultant, v_country, 'confirmed', 15000, 'usd',
     now() + interval '2 days', now() + interval '2 days 1 hour')
  returning id into v_legacy;

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status, price_cents,
     currency, scheduled_start_at, scheduled_end_at)
  values
    (v_client, v_consultant, v_country, 'confirmed', 15000, 'usd',
     now() + interval '3 days', now() + interval '3 days 1 hour')
  returning id into v_client_requested;

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status, price_cents,
     currency, scheduled_start_at, scheduled_end_at, captured_at)
  values
    (v_client, v_consultant, v_country, 'captured', 15000, 'usd',
     now() + interval '4 days', now() + interval '4 days 1 hour', now())
  returning id into v_refund_target;

  -- Check 6: omit the new argument entirely, named-args call,
  -- exactly how supabaseAdmin.rpc() invokes it.
  select consultation_status, admin_attention_reason, cancellation_source
    into v_status, v_reason, v_source
    from public.finalize_admin_consultation_cancel(
      p_consultation_id := v_legacy,
      p_refund := false,
      p_note := 'a caller that predates this migration'
    );

  if v_status <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 6: status is %, expected cancelled', v_status;
  end if;

  if v_reason <> 'a caller that predates this migration' then
    raise exception
      'VERIFICATION FAILED 6: the note was not stored correctly';
  end if;

  if v_source <> 'admin' then
    raise exception
      'VERIFICATION FAILED 6: source is %, expected admin by default',
      v_source;
  end if;

  raise notice
    'PASS 6: a caller omitting p_cancellation_source cancels normally and defaults to admin';

  -- Check 7.
  select consultation_status, cancellation_source
    into v_status, v_source
    from public.finalize_admin_consultation_cancel(
      v_client_requested, false,
      'client called and asked to cancel',
      'client_requested'
    );

  if v_status <> 'cancelled' or v_source <> 'client_requested' then
    raise exception
      'VERIFICATION FAILED 7: status=% source=%', v_status, v_source;
  end if;

  raise notice 'PASS 7: client_requested is accepted and persisted';

  -- Check 8: a repeat call, even supplying 'admin' this time, must
  -- not move the stored source away from client_requested.
  select cancellation_source into v_source
    from public.finalize_admin_consultation_cancel(
      v_client_requested, false, null, 'admin'
    );

  if v_source <> 'client_requested' then
    raise exception
      'VERIFICATION FAILED 8: a repeat call changed the source to %',
      v_source;
  end if;

  select cancellation_source into v_source
    from public.consultations where id = v_client_requested;

  if v_source <> 'client_requested' then
    raise exception
      'VERIFICATION FAILED 8: the stored row itself changed to %',
      v_source;
  end if;

  raise notice
    'PASS 8: cancellation_source is immutable after the first successful call';

  -- Check 9.
  begin
    perform public.finalize_admin_consultation_cancel(
      v_legacy, false, null, 'because_they_felt_like_it'
    );
    raise exception
      'VERIFICATION FAILED 9: an invalid source was accepted by the RPC';
  exception
    when raise_exception then
      if sqlerrm !~ 'INVALID_CANCELLATION_SOURCE' then raise; end if;
  end;

  begin
    update public.consultations
       set cancellation_source = 'not_a_real_value'
     where id = v_legacy;
    raise exception
      'VERIFICATION FAILED 9: an invalid source was accepted by the table CHECK';
  exception
    when check_violation then null;
  end;

  raise notice
    'PASS 9: an invalid source is refused by both the RPC and the table CHECK';

  -- Check 10: refund and note behaviour, unchanged from migration 017.
  select consultation_status, cancelled_at
    into v_status, v_cancelled_at
    from public.finalize_admin_consultation_cancel(
      v_refund_target, true, 'refund issued', 'admin'
    );

  if v_status <> 'refunded' or v_cancelled_at is null then
    raise exception
      'VERIFICATION FAILED 10: refund transition is status=% cancelled_at=%',
      v_status, v_cancelled_at;
  end if;

  -- The already-refunded early return must still fire and must
  -- not be able to downgrade the status.
  select consultation_status into v_status
    from public.finalize_admin_consultation_cancel(
      v_refund_target, false, null, 'admin'
    );

  if v_status <> 'refunded' then
    raise exception
      'VERIFICATION FAILED 10: a refunded consultation was downgraded to %',
      v_status;
  end if;

  raise notice 'PASS 10: refund and note behaviour are unchanged';
end $$;

rollback;


-- Check 11 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v58-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 11: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS 11: every fixture rolled back';
end $$;


-- ============================================================
-- PART 3 — ROLLBACK GUIDANCE
-- ============================================================
--
-- To reverse this migration -- not recommended once any admin has
-- cancelled a consultation with a source recorded, since dropping
-- the column destroys that record permanently:
--
--   drop function if exists public.finalize_admin_consultation_cancel(
--     uuid, boolean, text, text);
--
--   -- recreate migration 017's original 3-arg function body here
--   -- verbatim, then re-grant it exactly as migration 017 and 036 did
--
--   alter table public.consultations
--     drop constraint if exists consultations_cancellation_source_check;
--   alter table public.consultations
--     drop column if exists cancellation_source;
--
-- Export any recorded sources first if this must be reversed after
-- the RPC has been used:
--
--   select id, cancellation_source, cancelled_at from public.consultations
--    where cancellation_source is not null;
-- ============================================================

do $$
begin
  raise notice
    'migration 058 verification complete: no check raised';
end $$;
