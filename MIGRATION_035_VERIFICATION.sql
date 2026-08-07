-- ============================================================
-- Verification for migration_035_financial_write_paths
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function inventory and grants   read-only
--   Part 2  earning lifecycle               STAGING ONLY, rolls back
--   Part 3  reversals                       STAGING ONLY, rolls back
--   Part 4  adjustments and payouts         STAGING ONLY, rolls back
--   Part 5  rollback guidance
--
-- Parts 2 to 4 share one transaction that ends in ROLLBACK and
-- create every fixture they need. They read no business record.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  all eight functions exist, SECURITY DEFINER, pinned
--       search_path                                       Part 1
--    2  anon and authenticated cannot execute any of them  Part 1
--    3  an uncaptured consultation cannot create an earning Part 2
--    4  a captured consultation creates a pending 50/50
--       earning on gross                                  Part 2
--    5  a second call does not double-credit               Part 2
--    6  captured but not completed does not release        Part 2
--    7  completed and captured releases; the odd minor unit
--       rounds to the consultant and the platform takes the
--       remainder                                          Part 2
--    8  releasing twice is a no-op                         Part 2
--    9  a reversal is negative and leaves the original
--       untouched                                          Part 3
--   10  over-reversal is refused                           Part 3
--   11  a reversal requires a reason                       Part 3
--   12  reversing a pending earning stays pending          Part 3
--   13  a consultation-scoped reversal handles no-entry and
--       redelivery without raising                         Part 3
--   14  an adjustment requires an amount, a memo and an
--       admin                                              Part 4
--   15  a payout reserves every available entry and sums
--       them server-side                                   Part 4
--   16  a second open request is refused                   Part 4
--   17  approval preserves the reservation                 Part 4
--   18  rejection and cancellation release it              Part 4
--   19  only an approved payout may be paid, and a paid one
--       can never move again                               Part 4
--   20  a non-positive balance is refused and later
--       earnings offset it                                 Part 4
--   21  fixtures roll back, asserted not assumed           Part 4
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION INVENTORY AND GRANTS (read-only)
-- ============================================================

-- Checks 1 and 2.
--
-- The grants matter as much as the bodies. Supabase issues
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon,
-- authenticated, so a new function is executable by both the
-- moment it is created and revoking from PUBLIC does not undo a
-- grant held by name. If check 2 fails, an anon key can move
-- money.

do $$
declare
  v_name text;
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_names text[] := array[
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_ledger_entry',
    'reverse_consultation_earning',
    'create_ledger_adjustment',
    'request_consultant_payout',
    'decide_payout',
    'mark_payout_paid'
  ];
begin
  foreach v_name in array v_names
  loop
    select p.oid, p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(none)')
      into v_oid, v_secdef, v_config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;

    if v_oid is null then
      raise exception
        'VERIFICATION FAILED 1: public.% does not exist', v_name;
    end if;

    if not v_secdef then
      raise exception
        'VERIFICATION FAILED 1: public.% is not SECURITY DEFINER',
        v_name;
    end if;

    if v_config is distinct from 'search_path=pg_catalog, public' then
      raise exception
        'VERIFICATION FAILED 1: public.% has search_path %',
        v_name, v_config;
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 2: anon can execute public.%', v_name;
    end if;

    if has_function_privilege(
         'authenticated', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 2: authenticated can execute public.%',
        v_name;
    end if;

    if not has_function_privilege(
         'service_role', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 2: service_role cannot execute public.%',
        v_name;
    end if;
  end loop;

  raise notice
    'PASS 1-2: eight SECURITY DEFINER functions, service role only';
end $$;


-- ============================================================
-- PART 2 — EARNING LIFECYCLE (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_cpr uuid := gen_random_uuid();
  v_apr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con uuid;
  v_country uuid;
  v_uncaptured uuid;
  v_captured uuid;
  v_complete uuid;
  v_entry uuid;
  v_created boolean;
  v_released boolean;
  v_reason text;
  v_amount integer;
  v_platform integer;
  v_available timestamptz;
  v_count integer;
begin
  insert into auth.users (id, email) values
    (v_cpr, 'v35-consultant@verification.invalid'),
    (v_apr, 'v35-admin@verification.invalid'),
    (v_clp, 'v35-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr, 'consultant', 'V35 Consultant',
     'v35-consultant@verification.invalid'),
    (v_apr, 'admin', 'V35 Admin',
     'v35-admin@verification.invalid'),
    (v_clp, 'client', 'V35 Client',
     'v35-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone)
  values (v_cpr, 'Africa/Cairo') returning id into v_con;

  insert into public.countries (name, iso_code)
  values ('ZZ V35 Country', 'Q7') returning id into v_country;

  /* Confirmed, never captured: money was authorized, not taken. */
  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status,
     price_cents, currency, scheduled_start_at, scheduled_end_at)
  values (v_clp, v_con, v_country, 'confirmed', 15000, 'usd',
    now() - interval '2 hours', now() - interval '1 hour')
  returning id into v_uncaptured;

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status,
     price_cents, currency, scheduled_start_at, scheduled_end_at,
     captured_at)
  values (v_clp, v_con, v_country, 'captured', 15000, 'usd',
    now() - interval '4 hours', now() - interval '3 hours', now())
  returning id into v_captured;

  /* An odd price, so the rounding rule is exercised. */
  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status,
     price_cents, currency, scheduled_start_at, scheduled_end_at,
     captured_at, completed_at)
  values (v_clp, v_con, v_country, 'completed', 15001, 'usd',
    now() - interval '6 hours', now() - interval '5 hours',
    now(), now())
  returning id into v_complete;

  perform set_config('app.v35_con', v_con::text, true);
  perform set_config('app.v35_admin', v_apr::text, true);
  perform set_config('app.v35_complete', v_complete::text, true);
  perform set_config('app.v35_captured', v_captured::text, true);

  -- Check 3
  begin
    perform public.record_consultation_earning(v_uncaptured);
    raise exception
      'VERIFICATION FAILED 3: an uncaptured consultation created an earning';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_CONSULTATION_NOT_CAPTURED%' then
      raise;
    end if;
  end;

  -- Check 4
  select entry_id, created, consultant_amount_minor, available_at
    into v_entry, v_created, v_amount, v_available
    from public.record_consultation_earning(v_captured);

  if not v_created or v_amount <> 7500
     or v_available is not null then
    raise exception
      'VERIFICATION FAILED 4: created=% amount=% available=%',
      v_created, v_amount, v_available;
  end if;

  perform set_config('app.v35_entry', v_entry::text, true);

  -- Check 5
  select created into v_created
    from public.record_consultation_earning(v_captured);

  select count(*) into v_count
    from public.consultant_ledger_entries
   where entry_type = 'earning' and source_id = v_captured;

  if v_created or v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 5: a duplicate earning was created (% rows)',
      v_count;
  end if;

  -- Check 6
  select released, reason into v_released, v_reason
    from public.release_consultation_earning(v_captured);

  if v_released or v_reason <> 'not_completed' then
    raise exception
      'VERIFICATION FAILED 6: released=% reason=%',
      v_released, v_reason;
  end if;

  -- Check 7
  perform public.record_consultation_earning(v_complete);

  select consultant_amount_minor, platform_amount_minor
    into v_amount, v_platform
    from public.consultant_ledger_entries
   where entry_type = 'earning' and source_id = v_complete;

  if v_amount <> 7501 or v_platform <> 7500 then
    raise exception
      'VERIFICATION FAILED 7: the odd split is %/%',
      v_amount, v_platform;
  end if;

  select released, reason into v_released, v_reason
    from public.release_consultation_earning(v_complete);

  if not v_released or v_reason <> 'released' then
    raise exception
      'VERIFICATION FAILED 7: released=% reason=%',
      v_released, v_reason;
  end if;

  -- Check 8
  select released, reason into v_released, v_reason
    from public.release_consultation_earning(v_complete);

  if v_released or v_reason <> 'already_available' then
    raise exception
      'VERIFICATION FAILED 8: a second release reported %', v_reason;
  end if;

  raise notice 'PASS 3-8: earning lifecycle';
end $$;


-- ============================================================
-- PART 3 — REVERSALS (same transaction)
-- ============================================================

do $$
declare
  v_complete uuid := current_setting('app.v35_complete')::uuid;
  v_captured uuid := current_setting('app.v35_captured')::uuid;
  v_entry uuid := current_setting('app.v35_entry')::uuid;
  v_original uuid;
  v_amount integer;
  v_available timestamptz;
  v_reversed boolean;
  v_reason text;
begin
  select id into v_original
    from public.consultant_ledger_entries
   where entry_type = 'earning' and source_id = v_complete;

  -- Check 9
  perform public.reverse_ledger_entry(
    v_original, 'client refunded');

  select consultant_amount_minor into v_amount
    from public.consultant_ledger_entries where id = v_original;

  if v_amount <> 7501 then
    raise exception
      'VERIFICATION FAILED 9: the original changed to %', v_amount;
  end if;

  select consultant_amount_minor, available_at
    into v_amount, v_available
    from public.consultant_ledger_entries
   where reverses_entry_id = v_original;

  if v_amount <> -7501 or v_available is null then
    raise exception
      'VERIFICATION FAILED 9: reversal is % available %',
      v_amount, v_available;
  end if;

  -- Check 10
  begin
    perform public.reverse_ledger_entry(v_original, 'again');
    raise exception
      'VERIFICATION FAILED 10: a second full reversal was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_REVERSAL_EXCEEDS_ORIGINAL%' then
      raise;
    end if;
  end;

  -- Check 11
  begin
    perform public.reverse_ledger_entry(v_entry, '   ');
    raise exception
      'VERIFICATION FAILED 11: a blank reason was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_REASON_REQUIRED%' then raise; end if;
  end;

  /*
   * Check 12. v_entry is the still-pending earning of the
   * captured-but-incomplete consultation. Its reversal must stay
   * pending too, so pending nets to zero rather than the
   * reversal landing in a balance the earning never reached.
   */
  perform public.reverse_ledger_entry(
    v_entry, 'authorization released', 5000);

  select consultant_amount_minor, available_at
    into v_amount, v_available
    from public.consultant_ledger_entries
   where reverses_entry_id = v_entry;

  if v_available is not null then
    raise exception
      'VERIFICATION FAILED 12: a pending reversal became available';
  end if;

  if v_amount <> -2500 then
    raise exception
      'VERIFICATION FAILED 12: the partial reversal is %', v_amount;
  end if;

  -- Check 13
  select reversed, reason into v_reversed, v_reason
    from public.reverse_consultation_earning(
      v_complete, 'redelivered refund');

  if v_reversed or v_reason <> 'already_reversed' then
    raise exception
      'VERIFICATION FAILED 13: a redelivered refund reported %/%',
      v_reversed, v_reason;
  end if;

  select reversed, reason into v_reversed, v_reason
    from public.reverse_consultation_earning(
      gen_random_uuid(), 'refund');

  if v_reversed or v_reason <> 'no_entry' then
    raise exception
      'VERIFICATION FAILED 13: an unknown consultation reported %/%',
      v_reversed, v_reason;
  end if;

  raise notice 'PASS 9-13: reversals';
end $$;


-- ============================================================
-- PART 4 — ADJUSTMENTS AND PAYOUTS (same transaction)
-- ============================================================

do $$
declare
  v_con uuid := current_setting('app.v35_con')::uuid;
  v_admin uuid := current_setting('app.v35_admin')::uuid;
  v_client uuid;
  v_payout uuid;
  v_second uuid;
  v_amount integer;
  v_total integer;
  v_count integer;
  v_status text;
  v_released integer;
begin
  select id into v_client from public.profiles
   where email = 'v35-client@verification.invalid';

  -- Check 14
  begin
    perform public.create_ledger_adjustment(
      v_con, 500, 'usd', '   ', v_admin);
    raise exception
      'VERIFICATION FAILED 14: a blank memo was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_REASON_REQUIRED%' then raise; end if;
  end;

  begin
    perform public.create_ledger_adjustment(
      v_con, 0, 'usd', 'nothing', v_admin);
    raise exception
      'VERIFICATION FAILED 14: a zero adjustment was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_ADJUSTMENT_AMOUNT_INVALID%' then
      raise;
    end if;
  end;

  begin
    perform public.create_ledger_adjustment(
      v_con, 500, 'usd', 'self serve', v_client);
    raise exception
      'VERIFICATION FAILED 14: a client authored an adjustment';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_ADMIN_REQUIRED%' then raise; end if;
  end;

  select consultant_amount_minor into v_amount
    from public.create_ledger_adjustment(
      v_con, 1000, 'usd', 'goodwill', v_admin);

  if v_amount <> 1000 then
    raise exception
      'VERIFICATION FAILED 14: the adjustment stored %', v_amount;
  end if;

  /*
   * Check 15. Available now: 7501 released - 7501 reversed
   * + 1000 adjustment = 1000, across three entries. The payout
   * takes all three, including the negative one, which is how a
   * reversal settles.
   */
  select payout_id, requested_amount_minor, entry_count, status
    into v_payout, v_total, v_count, v_status
    from public.request_consultant_payout(
      v_con, 'usd', 'Wise account, manual transfer');

  if v_total <> 1000 or v_count <> 3 or v_status <> 'requested' then
    raise exception
      'VERIFICATION FAILED 15: total=% entries=% status=%',
      v_total, v_count, v_status;
  end if;

  -- Check 16
  begin
    perform public.request_consultant_payout(v_con, 'usd');
    raise exception
      'VERIFICATION FAILED 16: a second open request was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_PAYOUT_ALREADY_OPEN%' then raise; end if;
  end;

  -- Check 17
  select status, released_entry_count into v_status, v_released
    from public.decide_payout(
      v_payout, 'approve', v_admin, 'checked');

  if v_status <> 'approved' or v_released <> 0 then
    raise exception
      'VERIFICATION FAILED 17: status=% released=%',
      v_status, v_released;
  end if;

  select available_minor into v_amount
    from public.consultant_balances
   where consultant_id = v_con and currency = 'usd';

  if v_amount <> 0 then
    raise exception
      'VERIFICATION FAILED 17: an approved payout freed % ', v_amount;
  end if;

  -- Check 19: a payment must carry a reference, and a paid
  -- payout can never move again.
  begin
    perform public.mark_payout_paid(
      v_payout, 1000, '   ', v_admin);
    raise exception
      'VERIFICATION FAILED 19: a blank reference was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_REFERENCE_REQUIRED%' then raise; end if;
  end;

  select status into v_status
    from public.mark_payout_paid(
      v_payout, 990, 'WISE-VERIFY-1', v_admin, now(),
      'net of bank fee');

  if v_status <> 'paid' then
    raise exception
      'VERIFICATION FAILED 19: status after payment is %', v_status;
  end if;

  begin
    perform public.decide_payout(v_payout, 'cancel', v_admin);
    raise exception
      'VERIFICATION FAILED 19: a paid payout was cancelled';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_PAYOUT_ALREADY_PAID%' then raise; end if;
  end;

  begin
    perform public.mark_payout_paid(
      v_payout, 10, 'WISE-VERIFY-2', v_admin);
    raise exception
      'VERIFICATION FAILED 19: a paid payout was paid twice';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_PAYOUT_ALREADY_PAID%' then raise; end if;
  end;

  -- Check 18
  perform public.create_ledger_adjustment(
    v_con, 2500, 'usd', 'bonus', v_admin);

  select payout_id into v_second
    from public.request_consultant_payout(v_con, 'usd');

  select released_entry_count into v_released
    from public.decide_payout(
      v_second, 'reject', v_admin, 'wrong account');

  if v_released <> 1 then
    raise exception
      'VERIFICATION FAILED 18: rejection released % allocations',
      v_released;
  end if;

  select available_minor into v_amount
    from public.consultant_balances
   where consultant_id = v_con and currency = 'usd';

  if v_amount <> 2500 then
    raise exception
      'VERIFICATION FAILED 18: available after rejection is %',
      v_amount;
  end if;

  select payout_id into v_second
    from public.request_consultant_payout(v_con, 'usd');
  perform public.decide_payout(v_second, 'cancel', v_admin);

  select available_minor into v_amount
    from public.consultant_balances
   where consultant_id = v_con and currency = 'usd';

  if v_amount <> 2500 then
    raise exception
      'VERIFICATION FAILED 18: available after cancellation is %',
      v_amount;
  end if;

  -- Check 20
  perform public.create_ledger_adjustment(
    v_con, -3000, 'usd', 'clawback', v_admin);

  begin
    perform public.request_consultant_payout(v_con, 'usd');
    raise exception
      'VERIFICATION FAILED 20: a negative balance was requested';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_BALANCE_NOT_POSITIVE%' then raise; end if;
  end;

  select available_minor into v_amount
    from public.consultant_balances
   where consultant_id = v_con and currency = 'usd';

  if v_amount <> -500 then
    raise exception
      'VERIFICATION FAILED 20: the negative balance is %, expected -500',
      v_amount;
  end if;

  perform public.create_ledger_adjustment(
    v_con, 4000, 'usd', 'later work', v_admin);

  select requested_amount_minor into v_total
    from public.request_consultant_payout(v_con, 'usd');

  if v_total <> 3500 then
    raise exception
      'VERIFICATION FAILED 20: the offset payout is %, expected 3500',
      v_total;
  end if;

  raise notice 'PASS 14-20: adjustments and payouts';
end $$;

rollback;


-- Check 21 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v35-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 21: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS 21: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 035 creates functions and nothing else. Dropping them
-- destroys no data; it removes the only supported way to write
-- the ledger, which stops earnings being recorded and payouts
-- being requested. The orchestrator's finance endpoints will
-- return 500 for as long as they are missing.
--
--   drop function if exists public.mark_payout_paid(
--     uuid, integer, text, uuid, timestamptz, text);
--   drop function if exists public.decide_payout(
--     uuid, text, uuid, text);
--   drop function if exists public.request_consultant_payout(
--     uuid, text, text);
--   drop function if exists public.create_ledger_adjustment(
--     uuid, integer, text, text, uuid);
--   drop function if exists public.reverse_consultation_earning(
--     uuid, text, integer);
--   drop function if exists public.reverse_ledger_entry(
--     uuid, text, integer);
--   drop function if exists public.release_consultation_earning(uuid);
--   drop function if exists public.record_consultation_earning(uuid);
--
-- reverse_consultation_earning calls reverse_ledger_entry, so
-- drop it first or the intermediate state has a function whose
-- body cannot resolve.
--
-- Entries already written stay written. They are append-only and
-- no rollback of this migration touches them.
-- ============================================================

do $$
begin
  raise notice
    'migration 035 verification complete: no check raised';
end $$;
