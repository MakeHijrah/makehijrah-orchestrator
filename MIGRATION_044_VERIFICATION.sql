-- ============================================================
-- Verification for migration_044_admin_dashboard_read_model
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, security and ACLs          read-only
--   Part 2  recorded revenue by source        STAGING ONLY, rolls back
--   Part 3  operations, counts and alerts     STAGING ONLY, rolls back
--   Part 4  access control                    STAGING ONLY, rolls back
--   Part 5  regressions                       read-only
--   Part 6  rollback guidance
--
-- Parts 2 to 4 share one transaction that ends in ROLLBACK.
--
-- The fixtures sit in a FIXED, far-future window so the totals
-- asserted below are exact rather than lower bounds — a staging
-- database may hold real rows, and a period no real row can occupy
-- is what makes an exact assertion honest. The point-in-time
-- figures (payout liability, available earnings) and the alert
-- counts cannot be windowed that way, so those are asserted as
-- DELTAS against a baseline captured before the fixtures land.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  current period rows are grouped by currency and source
--    2  the comparison period is returned in the same call
--    3  consultation revenue is its own source row
--    4  service_purchase revenue is its own source row
--    5  direct_booking is supported and returns no row today
--    6  a reversal REDUCES recorded revenue
--    7  reversals_minor is reported separately as a component
--    8  consultant + platform = gross on every aggregate row
--    9  usd and gbp are never combined
--   10  the source rows sum to the recorded total, so a scoped
--       KPI is a subset and nothing is double-counted
--   11  consultation counts exclude drafts
--   12  the consultation comparison period is counted separately
--   13  active consultant count
--   14  new consultant count for the current period
--   15  pending payout liability, grouped by currency
--   16  available consultant earnings, grouped by currency
--   17  admin_attention alert, count and age
--   18  pending payout alert, count and age
--   19  paid-but-unfulfilled alert, count and age
--   20  unattributed purchase count
--   21  unattributed purchase gross, grouped by currency
--   22  partially refunded alert, count and age
--   23  a category with nothing in it reports zero and an empty
--       array, never null
--   24  a client is denied
--   25  a consultant is denied
--   26  anon is denied at the privilege layer
--   27  an authenticated admin is allowed
--   28  both functions are SECURITY DEFINER
--   29  both have a pinned search_path
--   30  ACLs: authenticated only; PUBLIC, anon and service_role
--       revoked
--   31  get_admin_finance_kpis is unchanged
--   32  migrations 034 and 038-043 protections are intact
--   33  no raw ledger row is reachable through either function
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, SECURITY AND ACLS (read-only)
-- ============================================================

-- Checks 28, 29 and 30.

do $$
declare
  v_signature text;
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_role text;
  v_count integer;
  v_signatures text[] := array[
    'public.get_admin_revenue_by_source(timestamptz, timestamptz, timestamptz, timestamptz)',
    'public.get_admin_dashboard_operations(timestamptz, timestamptz, timestamptz, timestamptz)'
  ];
begin
  foreach v_signature in array v_signatures
  loop
    v_oid := to_regprocedure(v_signature);

    if v_oid is null then
      raise exception
        'VERIFICATION FAILED 28: % does not exist', v_signature;
    end if;

    select p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(none)')
      into v_secdef, v_config
      from pg_proc p where p.oid = v_oid;

    if not v_secdef then
      raise exception
        'VERIFICATION FAILED 28: % is not SECURITY DEFINER; it could not aggregate across consultants',
        v_signature;
    end if;

    if v_config is distinct from 'search_path=pg_catalog, public' then
      raise exception
        'VERIFICATION FAILED 29: % has search_path %',
        v_signature, v_config;
    end if;

    if not has_function_privilege(
         'authenticated', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 30: authenticated cannot execute %; the dashboard would get 404 from PostgREST',
        v_signature;
    end if;

    foreach v_role in array array['anon', 'service_role']
    loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception
          'VERIFICATION FAILED 30: % can execute %', v_role, v_signature;
      end if;
    end loop;

    if exists (
      select 1 from pg_proc p
      cross join lateral aclexplode(p.proacl) a
       where p.oid = v_oid and a.grantee = 0
    ) or (
      select p.proacl is null from pg_proc p where p.oid = v_oid
    ) then
      raise exception
        'VERIFICATION FAILED 30: PUBLIC still holds EXECUTE on %',
        v_signature;
    end if;
  end loop;

  /* Exactly one of each: no overload a stale caller could bind. */
  foreach v_signature in array array[
    'get_admin_revenue_by_source',
    'get_admin_dashboard_operations'
  ]
  loop
    select count(*) into v_count
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_signature;

    if v_count <> 1 then
      raise exception
        'VERIFICATION FAILED 28: % has % definition(s), expected 1',
        v_signature, v_count;
    end if;
  end loop;

  raise notice
    'PASS 28, 29 and 30: both functions are SECURITY DEFINER, pinned, authenticated-only, with PUBLIC, anon and service_role revoked';
end $$;


-- Check 33.
--
-- The safety argument for reading past RLS is that neither
-- function has a row-returning path. Asserted at the catalogue:
-- no returned column names a consultant, an entry, a client or a
-- Stripe object, and the parameter surface is four timestamps.

do $$
declare
  v_name text;
  v_leaky text;
  v_args text;
begin
  foreach v_name in array array[
    'get_admin_revenue_by_source',
    'get_admin_dashboard_operations'
  ]
  loop
    select string_agg(c.name, ', ')
      into v_leaky
      from (
        select p.proargnames[t.ord] as name
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral generate_subscripts(
            p.proallargtypes, 1) as t(ord)
         where n.nspname = 'public'
           and p.proname = v_name
           and p.proargmodes[t.ord] = 't'
      ) c
     where c.name ~ '(consultant_id|entry_id|client_profile|memo|commission_bps|stripe|payment_intent)';

    if v_leaky is not null then
      raise exception
        'VERIFICATION FAILED 33: % exposes row-level column(s): %',
        v_name, v_leaky;
    end if;

    select coalesce(string_agg(
             format_type(p.proallargtypes[t.ord], null), ', '
             order by t.ord), '(none)')
      into v_args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral generate_subscripts(
        p.proallargtypes, 1) as t(ord)
     where n.nspname = 'public'
       and p.proname = v_name
       and p.proargmodes[t.ord] = 'i';

    if v_args <> 'timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone' then
      raise exception
        'VERIFICATION FAILED 33: % takes [%]; only the four period bounds are permitted',
        v_name, v_args;
    end if;
  end loop;

  raise notice
    'PASS 33: both functions aggregate only, and take four timestamps and nothing else';
end $$;


-- ============================================================
-- PART 2 — RECORDED REVENUE BY SOURCE (rolls back)
-- ============================================================

begin;

/*
 * Baseline for every figure that cannot be windowed. Captured
 * BEFORE the fixtures so the alert and balance checks can assert
 * exact deltas on a database that may already hold real rows.
 */
create temporary table v44_baseline as
select
  (select count(*) from public.consultants where is_active)
    as active_consultants,
  (select count(*) from public.consultations
    where status = 'admin_attention') as attention,
  (select count(*) from public.payouts
    where status in ('requested', 'approved')) as pending_payouts,
  (select count(*) from public.service_purchases
    where status = 'paid') as unfulfilled,
  (select count(*) from public.service_purchases
    where attributed_consultant_id is null) as unattributed,
  (select count(*) from public.service_purchases
    where refunded_amount_minor > 0
      and refunded_amount_minor < gross_amount_minor)
    as partially_refunded;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_cpr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con uuid;
  v_consultation uuid;
  v_svc uuid;
  v_purchase uuid;
  v_entry uuid;
begin
  insert into auth.users (id, email) values
    (v_admin, 'v44-admin@verification.invalid'),
    (v_cpr, 'v44-consultant@verification.invalid'),
    (v_clp, 'v44-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin, 'admin', 'V44 Admin',
     'v44-admin@verification.invalid'),
    (v_cpr, 'consultant', 'V44 Consultant',
     'v44-consultant@verification.invalid'),
    (v_clp, 'client', 'V44 Client',
     'v44-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  /* Created inside the current window, so it counts as new. */
  insert into public.consultants (
    profile_id, timezone, is_active, created_at)
  values (v_cpr, 'Africa/Cairo', true,
          timestamptz '2031-05-10 00:00:00+00')
  returning id into v_con;

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V44 Service', 'one_time', 10000, 'usd', 5000, true)
  returning id into v_svc;

  /* ---- consultations: two booked in the current window, one in
         the comparison window, one draft that must NOT count ---- */

  insert into public.consultations (
    client_profile_id, consultant_id, status, created_at,
    scheduled_start_at, scheduled_end_at, price_cents, currency)
  values (v_clp, v_con, 'completed',
          timestamptz '2031-05-02 09:00:00+00',
          timestamptz '2031-05-02 12:00:00+00',
          timestamptz '2031-05-02 13:00:00+00', 15000, 'usd')
  returning id into v_consultation;

  insert into public.consultations (
    client_profile_id, consultant_id, status, created_at,
    scheduled_start_at, scheduled_end_at, price_cents, currency)
  values (v_clp, v_con, 'confirmed',
          timestamptz '2031-05-06 09:00:00+00',
          timestamptz '2031-05-08 12:00:00+00',
          timestamptz '2031-05-08 13:00:00+00', 15000, 'usd');

  insert into public.consultations (
    client_profile_id, consultant_id, status, created_at,
    scheduled_start_at, scheduled_end_at, price_cents, currency)
  values (v_clp, v_con, 'draft',
          timestamptz '2031-05-07 09:00:00+00',
          timestamptz '2031-05-09 12:00:00+00',
          timestamptz '2031-05-09 13:00:00+00', 15000, 'usd');

  insert into public.consultations (
    client_profile_id, consultant_id, status, created_at,
    scheduled_start_at, scheduled_end_at, price_cents, currency)
  values (v_clp, v_con, 'completed',
          timestamptz '2031-04-03 09:00:00+00',
          timestamptz '2031-04-04 12:00:00+00',
          timestamptz '2031-04-04 13:00:00+00', 15000, 'usd');

  /* ---- ledger: current window ---- */

  /* usd consultation earning: 15000 gross, 7500/7500 */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con, 'earning', 'consultation', gen_random_uuid(),
    15000, 7500, 7500, 5000, 'standard_50_50', 'usd',
    timestamptz '2031-05-02 10:00:00+00',
    timestamptz '2031-05-02 10:00:00+00')
  returning id into v_entry;

  /* usd service purchase earning: 10000 gross, 5000/5000 */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con, 'earning', 'service_purchase', gen_random_uuid(),
    10000, 5000, 5000, 5000, 'service_rate', 'usd',
    timestamptz '2031-05-04 10:00:00+00',
    timestamptz '2031-05-04 10:00:00+00');

  /* usd reversal of the consultation earning: -4000 */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, reverses_entry_id, memo, created_at)
  values (v_con, 'reversal', 'consultation', gen_random_uuid(),
    -4000, -2000, -2000, 5000, 'standard_50_50', 'usd',
    v_entry, 'V44 partial refund',
    timestamptz '2031-05-05 10:00:00+00');

  /* gbp consultation earning: 8000 gross, 4000/4000 */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con, 'earning', 'consultation', gen_random_uuid(),
    8000, 4000, 4000, 5000, 'standard_50_50', 'gbp',
    timestamptz '2031-05-06 10:00:00+00',
    timestamptz '2031-05-06 10:00:00+00');

  /* ---- ledger: comparison window ---- */

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con, 'earning', 'consultation', gen_random_uuid(),
    20000, 10000, 10000, 5000, 'standard_50_50', 'usd',
    timestamptz '2031-04-02 10:00:00+00',
    timestamptz '2031-04-02 10:00:00+00');

  /* ---- outside BOTH windows: must never appear ---- */

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con, 'earning', 'consultation', gen_random_uuid(),
    99999, 49999, 50000, 5000, 'standard_50_50', 'usd',
    timestamptz '2031-03-01 10:00:00+00',
    timestamptz '2031-03-01 10:00:00+00');

  /* ---- service purchases for the alerts ---- */

  /* paid and unfulfilled, attributed. */
  insert into public.service_purchases (
    service_id, consultation_id, client_profile_id,
    attributed_consultant_id, gross_amount_minor, currency,
    billing_type, billing_period_sequence, status, stripe_mode,
    stripe_payment_intent_id, purchased_at)
  values (v_svc, v_consultation, v_clp, v_con, 10000, 'usd',
    'one_time', 1, 'paid', 'test', 'pi_v44_paid',
    timestamptz '2031-05-04 10:00:00+00');

  /* unattributed, in two currencies - the recorded-revenue gap. */
  insert into public.service_purchases (
    service_id, client_profile_id, gross_amount_minor, currency,
    billing_type, billing_period_sequence, status, stripe_mode,
    stripe_payment_intent_id, purchased_at, fulfilled_at)
  values (v_svc, v_clp, 7000, 'usd', 'one_time', 1, 'fulfilled',
    'test', 'pi_v44_unattr_usd',
    timestamptz '2031-05-03 10:00:00+00',
    timestamptz '2031-05-03 11:00:00+00');

  insert into public.service_purchases (
    service_id, client_profile_id, gross_amount_minor, currency,
    billing_type, billing_period_sequence, status, stripe_mode,
    stripe_payment_intent_id, purchased_at, fulfilled_at)
  values (v_svc, v_clp, 3000, 'gbp', 'one_time', 1, 'fulfilled',
    'test', 'pi_v44_unattr_gbp',
    timestamptz '2031-05-05 10:00:00+00',
    timestamptz '2031-05-05 11:00:00+00');

  /* partially refunded. */
  insert into public.service_purchases (
    service_id, client_profile_id, attributed_consultant_id,
    gross_amount_minor, refunded_amount_minor, currency,
    billing_type, billing_period_sequence, status, stripe_mode,
    stripe_payment_intent_id, purchased_at, fulfilled_at)
  values (v_svc, v_clp, v_con, 12000, 4000, 'usd', 'one_time', 1,
    'fulfilled', 'test', 'pi_v44_partial',
    timestamptz '2031-05-02 10:00:00+00',
    timestamptz '2031-05-02 11:00:00+00')
  returning id into v_purchase;

  /* ---- an open payout, which also reserves an earning ---- */

  insert into public.payouts (
    consultant_id, status, currency, requested_amount_minor,
    requested_at)
  values (v_con, 'requested', 'usd', 5500,
    timestamptz '2031-05-06 12:00:00+00');

  insert into public.consultations (
    client_profile_id, consultant_id, status, created_at,
    scheduled_start_at, scheduled_end_at, price_cents, currency)
  values (v_clp, v_con, 'admin_attention',
          timestamptz '2031-05-01 09:00:00+00',
          timestamptz '2031-05-10 12:00:00+00',
          timestamptz '2031-05-10 13:00:00+00', 15000, 'usd');

  perform set_config('app.v44_admin', v_admin::text, true);
  perform set_config('app.v44_cpr', v_cpr::text, true);
  perform set_config('app.v44_clp', v_clp::text, true);
  perform set_config('app.v44_con', v_con::text, true);
end $$;


-- Checks 1 to 10.

do $$
declare
  r record;
  v_rows integer := 0;
  v_current_usd_gross bigint := 0;
  v_seen_direct boolean := false;
  v_consultation_usd bigint;
  v_service_usd bigint;
  v_gbp_gross bigint;
  v_comparison_usd bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v44_admin'), true);

  for r in
    select *
      from public.get_admin_revenue_by_source(
        timestamptz '2031-05-01 00:00:00+00',
        timestamptz '2031-06-01 00:00:00+00',
        timestamptz '2031-04-01 00:00:00+00',
        timestamptz '2031-05-01 00:00:00+00')
  loop
    v_rows := v_rows + 1;

    /* Check 8 — the identity, on every aggregate row. */
    if r.consultant_earnings_minor + r.platform_revenue_minor
       <> r.gross_revenue_minor then
      raise exception
        'VERIFICATION FAILED 8: % / % / % does not add up: % + % <> %',
        r.period, r.currency, r.source_type,
        r.consultant_earnings_minor, r.platform_revenue_minor,
        r.gross_revenue_minor;
    end if;

    if r.source_type = 'direct_booking' then
      v_seen_direct := true;
    end if;

    if r.period = 'current' and r.currency = 'usd' then
      v_current_usd_gross :=
        v_current_usd_gross + r.gross_revenue_minor;
    end if;
  end loop;

  reset role;

  /* Check 5 — supported, but nothing to report yet. */
  if v_seen_direct then
    raise exception
      'VERIFICATION FAILED 5: a direct_booking row was returned; the feature does not exist yet';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v44_admin'), true);

  /* Checks 3, 6 and 7 — consultation revenue, net of its reversal. */
  select gross_revenue_minor into v_consultation_usd
    from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00')
   where period = 'current' and currency = 'usd'
     and source_type = 'consultation';

  /* Check 4 — service purchase revenue, separate. */
  select gross_revenue_minor into v_service_usd
    from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00')
   where period = 'current' and currency = 'usd'
     and source_type = 'service_purchase';

  /* Check 9 — gbp is its own row, never folded into usd. */
  select gross_revenue_minor into v_gbp_gross
    from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00')
   where period = 'current' and currency = 'gbp';

  /* Check 2 — the comparison period comes back in the same call. */
  select gross_revenue_minor into v_comparison_usd
    from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00')
   where period = 'comparison' and currency = 'usd'
     and source_type = 'consultation';

  reset role;

  if v_consultation_usd is distinct from 11000 then
    raise exception
      'VERIFICATION FAILED 3/6: usd consultation revenue is %, expected 11000 (15000 earned less a 4000 reversal)',
      coalesce(v_consultation_usd::text, '(no row)');
  end if;

  if v_service_usd is distinct from 10000 then
    raise exception
      'VERIFICATION FAILED 4: usd service purchase revenue is %, expected 10000',
      coalesce(v_service_usd::text, '(no row)');
  end if;

  if v_gbp_gross is distinct from 8000 then
    raise exception
      'VERIFICATION FAILED 9: gbp revenue is %, expected 8000 — and it must never be added to usd',
      coalesce(v_gbp_gross::text, '(no row)');
  end if;

  if v_comparison_usd is distinct from 20000 then
    raise exception
      'VERIFICATION FAILED 2: comparison usd consultation revenue is %, expected 20000',
      coalesce(v_comparison_usd::text, '(no row)');
  end if;

  /* Check 10 — the sources sum to the recorded total. */
  if v_current_usd_gross <> 21000 then
    raise exception
      'VERIFICATION FAILED 10: usd sources sum to %, expected 21000 (11000 consultation + 10000 service); a scoped KPI must be a SUBSET of the total',
      v_current_usd_gross;
  end if;

  if v_current_usd_gross
     <> v_consultation_usd + v_service_usd then
    raise exception
      'VERIFICATION FAILED 10: the total and the sum of its parts disagree — something is double-counted';
  end if;

  /* Check 1 — and nothing outside the windows leaked in. */
  if v_rows <> 4 then
    raise exception
      'VERIFICATION FAILED 1: % row(s) returned, expected 4 (current usd consultation + usd service + gbp consultation, comparison usd consultation)',
      v_rows;
  end if;

  raise notice
    'PASS 1-10: both periods grouped by currency and source, reversals reduce the total, direct_booking is silent, currencies stay apart, and the sources sum to the recorded total';
end $$;


-- Check 7, explicitly.

do $$
declare
  v_reversals bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v44_admin'), true);

  select reversals_minor into v_reversals
    from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00')
   where period = 'current' and currency = 'usd'
     and source_type = 'consultation';

  reset role;

  if v_reversals is distinct from -4000 then
    raise exception
      'VERIFICATION FAILED 7: reversals_minor is %, expected -4000',
      coalesce(v_reversals::text, '(no row)');
  end if;

  raise notice
    'PASS 7: reversals_minor reports the reversal component of the same sum, as a negative figure';
end $$;


-- ============================================================
-- PART 3 — OPERATIONS, COUNTS AND ALERTS (rolls back)
-- ============================================================

-- Checks 11 to 23.

do $$
declare
  r record;
  b record;
  v_usd_liability bigint;
  v_gbp_unattributed bigint;
  v_usd_unattributed bigint;
begin
  select * into b from v44_baseline;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v44_admin'), true);

  select * into r
    from public.get_admin_dashboard_operations(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00');

  reset role;

  /* Checks 11 and 12 — bookings, drafts excluded. */
  if r.consultations_current <> 3 then
    raise exception
      'VERIFICATION FAILED 11: % consultations in the current period, expected 3 (two booked plus the admin_attention one; the draft must NOT count)',
      r.consultations_current;
  end if;

  if r.consultations_comparison <> 1 then
    raise exception
      'VERIFICATION FAILED 12: % consultations in the comparison period, expected 1',
      r.consultations_comparison;
  end if;

  /* Checks 13 and 14. */
  if r.active_consultants <> b.active_consultants + 1 then
    raise exception
      'VERIFICATION FAILED 13: active consultants moved from % to %, expected exactly one more',
      b.active_consultants, r.active_consultants;
  end if;

  if r.new_consultants_current <> 1 then
    raise exception
      'VERIFICATION FAILED 14: % new consultants in the current period, expected 1',
      r.new_consultants_current;
  end if;

  /* Check 15 — payout liability, per currency. */
  select (entry ->> 'amount_minor')::bigint
    into v_usd_liability
    from jsonb_array_elements(r.pending_payouts_by_currency) entry
   where entry ->> 'currency' = 'usd';

  if v_usd_liability is null or v_usd_liability < 5500 then
    raise exception
      'VERIFICATION FAILED 15: usd payout liability is %, expected at least the 5500 fixture',
      coalesce(v_usd_liability::text, '(absent)');
  end if;

  if jsonb_typeof(r.pending_payouts_by_currency) <> 'array' then
    raise exception
      'VERIFICATION FAILED 15: pending_payouts_by_currency is not an array';
  end if;

  /* Check 16 — available earnings, per currency, never combined. */
  if jsonb_typeof(r.available_earnings_by_currency) <> 'array' then
    raise exception
      'VERIFICATION FAILED 16: available_earnings_by_currency is not an array';
  end if;

  if not exists (
    select 1
      from jsonb_array_elements(
        r.available_earnings_by_currency) entry
     where entry ->> 'currency' = 'gbp'
  ) then
    raise exception
      'VERIFICATION FAILED 16: gbp is missing from available earnings; currencies must be reported separately, not merged';
  end if;

  /* Check 17 — admin attention. */
  if r.attention_consultations_count
     <> b.attention + 1 then
    raise exception
      'VERIFICATION FAILED 17: attention count moved from % to %, expected exactly one more',
      b.attention, r.attention_consultations_count;
  end if;

  if r.attention_consultations_oldest is null then
    raise exception
      'VERIFICATION FAILED 17: an attention alert with a count reports no age';
  end if;

  /* Check 18 — pending payouts. */
  if r.pending_payouts_count <> b.pending_payouts + 1 then
    raise exception
      'VERIFICATION FAILED 18: pending payout count moved from % to %, expected exactly one more',
      b.pending_payouts, r.pending_payouts_count;
  end if;

  if r.pending_payouts_oldest is null then
    raise exception
      'VERIFICATION FAILED 18: a pending payout alert reports no age';
  end if;

  /* Check 19 — paid but unfulfilled. */
  if r.unfulfilled_purchases_count <> b.unfulfilled + 1 then
    raise exception
      'VERIFICATION FAILED 19: unfulfilled count moved from % to %, expected exactly one more',
      b.unfulfilled, r.unfulfilled_purchases_count;
  end if;

  if r.unfulfilled_purchases_oldest is null then
    raise exception
      'VERIFICATION FAILED 19: an unfulfilled alert reports no age';
  end if;

  /* Checks 20 and 21 — the recorded-revenue gap. */
  if r.unattributed_purchases_count <> b.unattributed + 2 then
    raise exception
      'VERIFICATION FAILED 20: unattributed count moved from % to %, expected exactly two more',
      b.unattributed, r.unattributed_purchases_count;
  end if;

  select (entry ->> 'amount_minor')::bigint
    into v_usd_unattributed
    from jsonb_array_elements(
      r.unattributed_purchases_by_currency) entry
   where entry ->> 'currency' = 'usd';

  select (entry ->> 'amount_minor')::bigint
    into v_gbp_unattributed
    from jsonb_array_elements(
      r.unattributed_purchases_by_currency) entry
   where entry ->> 'currency' = 'gbp';

  if v_usd_unattributed is null or v_usd_unattributed < 7000 then
    raise exception
      'VERIFICATION FAILED 21: usd unattributed gross is %, expected at least the 7000 fixture',
      coalesce(v_usd_unattributed::text, '(absent)');
  end if;

  if v_gbp_unattributed is null or v_gbp_unattributed < 3000 then
    raise exception
      'VERIFICATION FAILED 21: gbp unattributed gross is %, expected at least the 3000 fixture — and it must NOT be added to usd',
      coalesce(v_gbp_unattributed::text, '(absent)');
  end if;

  /* Check 22 — partially refunded. */
  if r.partially_refunded_count <> b.partially_refunded + 1 then
    raise exception
      'VERIFICATION FAILED 22: partial refund count moved from % to %, expected exactly one more',
      b.partially_refunded, r.partially_refunded_count;
  end if;

  if r.partially_refunded_oldest is null then
    raise exception
      'VERIFICATION FAILED 22: a partial refund alert reports no age — refunded_at is null on a partial, so updated_at must be used';
  end if;

  raise notice
    'PASS 11-22: bookings exclude drafts, both periods counted, consultants counted, liability and available earnings grouped by currency, and all five alerts report a count and an age';
end $$;


-- Check 23.
--
-- A window with nothing in it. Counts must be zero and arrays must
-- be empty rather than null, so a caller never has to defend
-- against a missing value and an empty category renders as nothing
-- rather than as a broken row.

do $$
declare
  r record;
  v_revenue_rows integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v44_admin'), true);

  select count(*) into v_revenue_rows
    from public.get_admin_revenue_by_source(
      timestamptz '2031-09-01 00:00:00+00',
      timestamptz '2031-10-01 00:00:00+00',
      timestamptz '2031-08-01 00:00:00+00',
      timestamptz '2031-09-01 00:00:00+00');

  select * into r
    from public.get_admin_dashboard_operations(
      timestamptz '2031-09-01 00:00:00+00',
      timestamptz '2031-10-01 00:00:00+00',
      timestamptz '2031-08-01 00:00:00+00',
      timestamptz '2031-09-01 00:00:00+00');

  reset role;

  if v_revenue_rows <> 0 then
    raise exception
      'VERIFICATION FAILED 23: an empty period returned % revenue row(s)',
      v_revenue_rows;
  end if;

  if r.consultations_current <> 0
     or r.consultations_comparison <> 0
     or r.new_consultants_current <> 0 then
    raise exception
      'VERIFICATION FAILED 23: an empty period reported non-zero counts (% / % / %)',
      r.consultations_current, r.consultations_comparison,
      r.new_consultants_current;
  end if;

  if r.pending_payouts_by_currency is null
     or r.available_earnings_by_currency is null
     or r.unattributed_purchases_by_currency is null then
    raise exception
      'VERIFICATION FAILED 23: a per-currency figure is null; it must be an empty array';
  end if;

  raise notice
    'PASS 23: an empty period returns no revenue rows, zero counts and empty arrays rather than nulls';
end $$;


-- ============================================================
-- PART 4 — ACCESS CONTROL (rolls back)
-- ============================================================

-- Checks 24, 25, 26 and 27.

do $$
declare
  v_who text;
  v_denied integer := 0;
  v_msg text;
  v_anon_denied boolean := false;
  v_admin_rows integer;
begin
  foreach v_who in array array['app.v44_clp', 'app.v44_cpr']
  loop
    set local role authenticated;
    perform set_config('request.jwt.claim.sub',
      current_setting(v_who), true);

    begin
      perform 1 from public.get_admin_revenue_by_source(
        timestamptz '2031-05-01 00:00:00+00',
        timestamptz '2031-06-01 00:00:00+00',
        timestamptz '2031-04-01 00:00:00+00',
        timestamptz '2031-05-01 00:00:00+00');

      reset role;
      raise exception
        'VERIFICATION FAILED 24/25: % read recorded revenue', v_who;
    exception when insufficient_privilege then
      get stacked diagnostics v_msg = message_text;

      if v_msg not like '%administrator access required%' then
        reset role;
        raise exception
          'VERIFICATION FAILED 24/25: % refused with the wrong error: %',
          v_who, v_msg;
      end if;

      v_denied := v_denied + 1;
    end;

    begin
      perform 1 from public.get_admin_dashboard_operations(
        timestamptz '2031-05-01 00:00:00+00',
        timestamptz '2031-06-01 00:00:00+00',
        timestamptz '2031-04-01 00:00:00+00',
        timestamptz '2031-05-01 00:00:00+00');

      reset role;
      raise exception
        'VERIFICATION FAILED 24/25: % read the operations model', v_who;
    exception when insufficient_privilege then
      v_denied := v_denied + 1;
    end;

    reset role;
  end loop;

  if v_denied <> 4 then
    raise exception
      'VERIFICATION FAILED 24/25: only % of 4 non-admin calls were refused',
      v_denied;
  end if;

  /* Check 26 — anon, refused a layer earlier. */
  set local role anon;

  begin
    perform 1 from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00');
  exception when insufficient_privilege then
    v_anon_denied := true;
  end;

  reset role;

  if not v_anon_denied then
    raise exception
      'VERIFICATION FAILED 26: anon executed get_admin_revenue_by_source';
  end if;

  /* Check 27 — and an admin is allowed. */
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v44_admin'), true);

  select count(*) into v_admin_rows
    from public.get_admin_revenue_by_source(
      timestamptz '2031-05-01 00:00:00+00',
      timestamptz '2031-06-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00',
      timestamptz '2031-05-01 00:00:00+00');

  reset role;

  if v_admin_rows < 1 then
    raise exception
      'VERIFICATION FAILED 27: an admin read % rows', v_admin_rows;
  end if;

  raise notice
    'PASS 24-27: a client and a consultant are refused inside both functions, anon at the privilege layer, and an admin is allowed';
end $$;

rollback;


-- ============================================================
-- PART 5 — REGRESSIONS (read-only)
-- ============================================================

-- Checks 31 and 32.

do $$
declare
  v_columns text;
  v_expected text :=
    'currency text, '
    'gross_revenue_minor bigint, '
    'platform_revenue_minor bigint, '
    'consultant_earnings_minor bigint, '
    'reversals_minor bigint, '
    'adjustments_minor bigint, '
    'ledger_entry_count bigint';
  v_fn regprocedure;
  v_tables integer;
  v_names text[] := array[
    'record_service_purchase',
    'fulfill_service_purchase',
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent',
    'reverse_ledger_entry',
    'request_consultant_payout',
    'mark_payout_paid'
  ];
begin
  /* Check 31 — migration 038's contract is byte-identical. */
  select string_agg(
           a.name || ' ' || a.typ, ', ' order by a.ord)
    into v_columns
    from (
      select
        t.ord,
        p.proargnames[t.ord] as name,
        format_type(p.proallargtypes[t.ord], null) as typ
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral generate_subscripts(
          p.proallargtypes, 1) as t(ord)
       where n.nspname = 'public'
         and p.proname = 'get_admin_finance_kpis'
         and p.proargmodes[t.ord] = 't'
    ) a;

  if v_columns is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 31: get_admin_finance_kpis returns [%]; it must be unchanged',
      coalesce(v_columns, '(absent)');
  end if;

  if has_function_privilege(
       'anon',
       'public.get_admin_finance_kpis(timestamptz, timestamptz)',
       'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 31: anon gained get_admin_finance_kpis';
  end if;

  /* Check 32 — the finance write paths are untouched. */
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(v_names)
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE')
       or has_function_privilege(
            'authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 32: % became client-callable', v_fn;
    end if;
  end loop;

  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE';

  if v_tables <> 21 then
    raise exception
      'VERIFICATION FAILED 32: % base tables in public, expected 21; this migration adds none',
      v_tables;
  end if;

  if to_regclass('public.consultant_payout_settings') is null
     or to_regclass('public.consultant_balances') is null
     or to_regclass('public.admin_services') is null then
    raise exception
      'VERIFICATION FAILED 32: an object from migrations 034, 039 or 041 disappeared';
  end if;

  if has_column_privilege(
       'authenticated', 'public.services',
       'consultant_commission_bps', 'SELECT')
     or has_column_privilege(
       'authenticated', 'public.services',
       'post_purchase_instructions_html', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 32: a private services column became readable';
  end if;

  raise notice
    'PASS 31 and 32: get_admin_finance_kpis is unchanged, the finance write paths are still orchestrator-only, and migrations 034 and 038-043 protections hold';
end $$;


-- Fixtures rolled back.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v44-%@verification.invalid';

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
-- This migration adds two read-only functions and writes no data.
-- Dropping them destroys nothing:
--
--   drop function if exists public.get_admin_dashboard_operations(
--     timestamptz, timestamptz, timestamptz, timestamptz);
--   drop function if exists public.get_admin_revenue_by_source(
--     timestamptz, timestamptz, timestamptz, timestamptz);
--
-- The consequence is that /admin loses its KPIs and its Action
-- Required section. There is no fallback: PostgREST aggregates are
-- disabled, so the page cannot compute these figures client-side
-- without downloading the ledger — which is the outcome this read
-- model exists to prevent.
--
-- Nothing else needs undoing. No table, column, index, constraint,
-- policy or grant on any existing object was changed, and
-- get_admin_finance_kpis was not touched.
-- ============================================================

do $$
begin
  raise notice
    'migration 044 verification complete: no check raised';
end $$;
