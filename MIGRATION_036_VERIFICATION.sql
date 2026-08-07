-- ============================================================
-- Verification for migration_036_rpc_execution_hardening
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  the grant matrix                    read-only
--   Part 2  RLS still works                     STAGING ONLY, rolls back
--   Part 3  triggers still fire                 STAGING ONLY, rolls back
--   Part 4  client-callable RPCs still callable STAGING ONLY, rolls back
--   Part 5  rollback guidance
--
-- A grant matrix alone would not prove this migration safe. The
-- risk it carries is not that too much was revoked on paper but
-- that something the database needs at runtime — an RLS policy
-- helper, a trigger body — lost access and now fails closed. So
-- Parts 2 to 4 exercise the real paths as anon, as a consultant,
-- as a client and as an admin, and roll back.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  every orchestrator-only RPC refuses anon and
--       authenticated, and service_role keeps it            Part 1
--    2  every trigger function refuses anon and
--       authenticated                                       Part 1
--    3  is_admin is the ONLY function anon may execute       Part 1
--    4  the RLS helpers authenticated policies need are
--       still granted to authenticated                       Part 1
--    5  the two direct-message resolvers keep authenticated   Part 1
--    6  no finance RPC permission regressed from 035          Part 1
--    7  anon can still read the public country catalogue,
--       which needs is_admin() inside its policy              Part 2
--    8  a consultant still reads their own rows and not
--       another's, through my_consultant_id()                 Part 2
--    9  an admin still reads everything, through is_admin()   Part 2
--   10  a client still sees no finance record                 Part 2
--   11  set_updated_at still fires for an authenticated
--       writer whose role cannot execute it                   Part 3
--   12  the profiles column guard still blocks a self-service
--       role change, through is_privileged_writer()           Part 3
--   13  get_direct_message_admin_contact is still callable
--       by authenticated                                      Part 4
--   14  fixtures roll back, asserted not assumed              Part 4
-- ============================================================


-- ============================================================
-- PART 1 — THE GRANT MATRIX (read-only)
-- ============================================================

-- Checks 1, 2 and 6.

do $$
declare
  v_fn regprocedure;
  v_name text;
  v_orchestrator text[] := array[
    'process_stripe_webhook_event',
    'create_draft_consultation',
    'finalize_consultation_acceptance',
    'finalize_consultation_decline',
    'complete_consultation',
    'redeem_consultant_invite',
    'finalize_authorization_timeout',
    'finalize_admin_consultation_cancel',
    'save_consultant_profile',
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_ledger_entry',
    'reverse_consultation_earning',
    'create_ledger_adjustment',
    'request_consultant_payout',
    'decide_payout',
    'mark_payout_paid'
  ];
  v_checked integer := 0;
begin
  for v_fn, v_name in
    select p.oid::regprocedure, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_orchestrator)
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 1: anon can execute %', v_fn;
    end if;

    if has_function_privilege(
         'authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 1: authenticated can execute %', v_fn;
    end if;

    if not has_function_privilege(
         'service_role', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 1: service_role LOST execute on %', v_fn;
    end if;

    v_checked := v_checked + 1;
  end loop;

  if v_checked < array_length(v_orchestrator, 1) then
    raise exception
      'VERIFICATION FAILED 1: only % of % orchestrator RPCs were found',
      v_checked, array_length(v_orchestrator, 1);
  end if;

  raise notice
    'PASS 1 and 6: % orchestrator-only RPCs are service_role only, finance included',
    v_checked;
end $$;


-- Check 2.

do $$
declare
  v_fn regprocedure;
  v_count integer := 0;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE')
       or has_function_privilege(
            'authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 2: % is directly executable', v_fn;
    end if;

    v_count := v_count + 1;
  end loop;

  raise notice
    'PASS 2: % trigger functions are not directly executable', v_count;
end $$;


-- Check 3.
--
-- The tightest statement this migration makes: with the public
-- booking surface's one exception, an anon key can execute
-- nothing in the public schema.

do $$
declare
  v_leaks text;
begin
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_leaks
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname <> 'is_admin'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_leaks is not null then
    raise exception
      'VERIFICATION FAILED 3: anon can still execute: %', v_leaks;
  end if;

  if not has_function_privilege(
       'anon', 'public.is_admin()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 3: anon LOST is_admin(), which countries_select_active_public needs';
  end if;

  raise notice
    'PASS 3: is_admin() is the only function anon may execute';
end $$;


-- Checks 4 and 5.

do $$
declare
  v_name text;
  v_helpers text[] := array[
    'is_admin()',
    'my_consultant_id()',
    'get_my_role()',
    'is_consultation_participant(uuid, uuid)',
    'can_view_consultation(uuid)',
    'can_note_consultation(uuid)',
    'can_recommend_for_consultation(uuid)',
    'can_view_payout(uuid)',
    'is_privileged_writer()',
    'get_direct_message_admin()',
    'get_direct_message_admin_contact()'
  ];
begin
  foreach v_name in array v_helpers
  loop
    if not has_function_privilege(
         'authenticated', 'public.' || v_name, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 4/5: authenticated LOST public.%; RLS or the client would break',
        v_name;
    end if;
  end loop;

  raise notice
    'PASS 4 and 5: every helper and client-callable resolver keeps authenticated';
end $$;


-- ============================================================
-- PART 2 — RLS STILL WORKS (STAGING ONLY, rolls back)
-- ============================================================
--
-- The checks that matter. A policy whose helper cannot be
-- executed does not filter, it raises, so these read as the real
-- roles rather than inspecting privileges.

begin;

do $$
declare
  v_cpr uuid := gen_random_uuid();
  v_opr uuid := gen_random_uuid();
  v_apr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con uuid;
  v_oth uuid;
  v_country uuid;
begin
  insert into auth.users (id, email) values
    (v_cpr, 'v36-consultant@verification.invalid'),
    (v_opr, 'v36-other@verification.invalid'),
    (v_apr, 'v36-admin@verification.invalid'),
    (v_clp, 'v36-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr, 'consultant', 'V36 Consultant',
     'v36-consultant@verification.invalid'),
    (v_opr, 'consultant', 'V36 Other',
     'v36-other@verification.invalid'),
    (v_apr, 'admin', 'V36 Admin',
     'v36-admin@verification.invalid'),
    (v_clp, 'client', 'V36 Client',
     'v36-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true) returning id into v_con;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_opr, 'Africa/Cairo', true) returning id into v_oth;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ V36 Active', 'Q8', true) returning id into v_country;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ V36 Hidden', 'Q9', false);

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status,
     price_cents, currency, scheduled_start_at, scheduled_end_at)
  values (v_clp, v_con, v_country, 'confirmed', 15000, 'usd',
    now() + interval '2 days', now() + interval '2 days 1 hour');

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at)
  values (v_con, 'earning', 'consultation', gen_random_uuid(),
    15000, 7500, 7500, 5000, 'standard_50_50', 'usd', now());

  perform set_config('app.v36_con', v_cpr::text, true);
  perform set_config('app.v36_other', v_opr::text, true);
  perform set_config('app.v36_admin', v_apr::text, true);
  perform set_config('app.v36_client', v_clp::text, true);
end $$;


-- Check 7 — anon reads the public catalogue. Its policy is
-- `using (is_active = true or is_admin())`, so is_admin() is
-- reached for every inactive row. If anon lost EXECUTE this
-- raises instead of filtering.

do $$
declare
  v_n integer;
begin
  set local role anon;

  begin
    select count(*) into v_n from public.countries;
  exception when insufficient_privilege then
    raise exception
      'VERIFICATION FAILED 7: anon cannot read countries; is_admin() EXECUTE was revoked';
  end;

  reset role;

  if v_n < 1 then
    raise exception
      'VERIFICATION FAILED 7: anon read % countries, expected at least the active one',
      v_n;
  end if;

  raise notice
    'PASS 7: anon still reads the public country catalogue (% rows)', v_n;
end $$;


-- Checks 8 and 10 — a consultant sees their own rows through
-- my_consultant_id(); a client sees no finance record.

do $$
declare
  v_own integer;
  v_other integer;
  v_client_finance integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v36_con'), true);

  begin
    select count(*) into v_own
      from public.consultant_ledger_entries;
    select count(*) into v_other
      from public.consultations;
  exception when insufficient_privilege then
    raise exception
      'VERIFICATION FAILED 8: a consultant read raised; an RLS helper lost EXECUTE';
  end;

  if v_own <> 1 then
    raise exception
      'VERIFICATION FAILED 8: the consultant sees % ledger rows, expected 1',
      v_own;
  end if;

  if v_other <> 1 then
    raise exception
      'VERIFICATION FAILED 8: the consultant sees % consultations, expected 1',
      v_other;
  end if;

  /* The other consultant earned nothing and must see nothing. */
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v36_other'), true);

  select count(*) into v_own
    from public.consultant_ledger_entries;

  if v_own <> 0 then
    raise exception
      'VERIFICATION FAILED 8: another consultant sees % ledger rows',
      v_own;
  end if;

  /* Check 10. */
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v36_client'), true);

  select count(*) into v_client_finance
    from public.consultant_ledger_entries;

  if v_client_finance <> 0 then
    raise exception
      'VERIFICATION FAILED 10: a client sees % finance rows',
      v_client_finance;
  end if;

  reset role;

  raise notice
    'PASS 8 and 10: consultant scoping and client exclusion still hold';
end $$;


-- Check 9 — an admin still sees everything, which is 29 policies'
-- worth of is_admin() calls.

do $$
declare
  v_ledger integer;
  v_countries integer;
  v_payments integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v36_admin'), true);

  begin
    select count(*) into v_ledger
      from public.consultant_ledger_entries;
    select count(*) into v_countries from public.countries;
    select count(*) into v_payments from public.payments;
  exception when insufficient_privilege then
    raise exception
      'VERIFICATION FAILED 9: an admin read raised; is_admin() lost EXECUTE';
  end;

  reset role;

  if v_ledger <> 1 then
    raise exception
      'VERIFICATION FAILED 9: the admin sees % ledger rows, expected 1',
      v_ledger;
  end if;

  /* Both the active and the inactive country: admins see all. */
  if v_countries < 2 then
    raise exception
      'VERIFICATION FAILED 9: the admin sees % countries, expected the inactive one too',
      v_countries;
  end if;

  raise notice 'PASS 9: an admin still reads every table';
end $$;


-- ============================================================
-- PART 3 — TRIGGERS STILL FIRE (same transaction)
-- ============================================================
--
-- Firing a trigger does not consult EXECUTE on its function, so
-- revoking it should change nothing. "Should" is why this is
-- checked rather than assumed: if it were wrong, every
-- authenticated write in the product would fail.

do $$
declare
  v_before timestamptz;
  v_after timestamptz;
  v_role text;
  v_name text;
begin
  /*
   * Backdated first, with the trigger disabled for exactly that
   * one statement. now() is transaction-stable, so a row inserted
   * and updated inside this transaction carries the identical
   * updated_at either way and the check below could not tell a
   * fired trigger from a silent one. Backdating through a normal
   * UPDATE would not work either: set_updated_at would overwrite
   * the old value on the way in, which is precisely the behaviour
   * being verified.
   */
  alter table public.profiles disable trigger trg_profiles_updated;

  update public.profiles
     set updated_at = timestamptz '2000-01-01 00:00:00+00'
   where id = current_setting('app.v36_con')::uuid;

  alter table public.profiles enable trigger trg_profiles_updated;

  select updated_at into v_before
    from public.profiles
   where id = current_setting('app.v36_con')::uuid;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v36_con'), true);

  -- Check 11
  begin
    update public.profiles
       set full_name = 'V36 Renamed'
     where id = current_setting('app.v36_con')::uuid;
  exception when insufficient_privilege then
    raise exception
      'VERIFICATION FAILED 11: an authenticated UPDATE raised; a trigger function needs EXECUTE after all';
  end;

  -- Check 12: the guard must still refuse a self-service
  -- promotion, which means is_privileged_writer() still runs.
  begin
    update public.profiles
       set role = 'admin'
     where id = current_setting('app.v36_con')::uuid;

    reset role;
    raise exception
      'VERIFICATION FAILED 12: a consultant promoted themselves to admin';
  exception
    when insufficient_privilege then
      reset role;
      raise exception
        'VERIFICATION FAILED 12: the guard raised insufficient_privilege; is_privileged_writer() lost EXECUTE';
    when raise_exception then
      if sqlerrm not like '%may not be changed by clients%' then
        reset role;
        raise;
      end if;
  end;

  reset role;

  select updated_at, role, full_name
    into v_after, v_role, v_name
    from public.profiles
   where id = current_setting('app.v36_con')::uuid;

  if v_name <> 'V36 Renamed' then
    raise exception
      'VERIFICATION FAILED 11: the authenticated UPDATE did not apply (name is %)',
      v_name;
  end if;

  if v_after <= v_before then
    raise exception
      'VERIFICATION FAILED 11: set_updated_at did not fire (updated_at is still %)',
      v_after;
  end if;

  if v_role <> 'consultant' then
    raise exception
      'VERIFICATION FAILED 12: the role changed to %', v_role;
  end if;

  raise notice
    'PASS 11 and 12: triggers still fire and the column guard still refuses';
end $$;


-- ============================================================
-- PART 4 — CLIENT-CALLABLE RPCS (same transaction)
-- ============================================================

-- Check 13.
--
-- Migrations 024 and 031 granted these to authenticated on
-- purpose. They are the one category this migration must leave
-- working, so it is exercised rather than inspected.

do $$
declare
  v_ok boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v36_con'), true);

  begin
    perform * from public.get_direct_message_admin_contact();
    v_ok := true;
  exception
    when insufficient_privilege then
      reset role;
      raise exception
        'VERIFICATION FAILED 13: authenticated LOST get_direct_message_admin_contact()';
    when others then
      /*
       * Any other error is the function's own business logic
       * reacting to the fixtures, not a permission problem.
       */
      v_ok := true;
  end;

  begin
    perform * from public.get_direct_message_admin();
  exception
    when insufficient_privilege then
      reset role;
      raise exception
        'VERIFICATION FAILED 13: authenticated LOST get_direct_message_admin()';
    when others then null;
  end;

  reset role;

  if not v_ok then
    raise exception
      'VERIFICATION FAILED 13: the resolver was not reached';
  end if;

  raise notice
    'PASS 13: the client-callable resolvers are still callable';
end $$;

rollback;


-- Check 14 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v36-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 14: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS 14: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- This migration only removes privileges. Reversing it restores
-- the exposure it closed, so do it only to unblock a real
-- breakage, and prefer granting back the single function at
-- fault:
--
--   grant execute on function public.<name>(<args>) to authenticated;
--
-- To restore the whole pre-036 state, which is NOT recommended:
--
--   do $$
--   declare v_fn regprocedure;
--   begin
--     for v_fn in
--       select p.oid::regprocedure from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--     loop
--       execute format(
--         'grant execute on function %s to anon, authenticated', v_fn);
--     end loop;
--   end $$;
--
-- That re-exposes process_stripe_webhook_event to any holder of
-- the anon key, which is the vulnerability this migration exists
-- to close. Do not leave it in that state.
--
-- The likeliest cause of a breakage is a frontend that calls an
-- orchestrator-only RPC directly instead of through its HTTP
-- endpoint. The fix is to move that call to the endpoint, not to
-- restore the grant.
-- ============================================================

do $$
begin
  raise notice
    'migration 036 verification complete: no check raised';
end $$;
