-- ============================================================
-- Verification for migration_038_admin_finance_kpis
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, grants and regressions      read-only
--   Part 2  the totals are correct             STAGING ONLY, rolls back
--   Part 3  only an admin gets them            STAGING ONLY, rolls back
--   Part 4  the migration is idempotent        STAGING ONLY, rolls back
--   Part 5  rollback guidance
--
-- Parts 2 to 4 share one transaction that ends in ROLLBACK and
-- create every fixture they need.
--
-- The fixtures sit in JANUARY 2031 on purpose. The totals asserted
-- below are exact, not lower bounds, so the period under test has
-- to contain the fixtures and nothing else — and a staging
-- database may well hold real ledger rows. A period no real row
-- can occupy is what makes an exact assertion honest.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  the function exists exactly once, SECURITY DEFINER,
--       STABLE, with a pinned search_path                  Part 1
--    2  it returns exactly the seven documented columns, in
--       order, with the documented types                   Part 1
--    3  authenticated may execute it; PUBLIC, anon and
--       service_role may not                               Part 1
--    4  idx_ledger_created_at exists on the ledger's
--       created_at                                         Part 1
--    5  no table was added and the four finance tables keep
--       exactly one SELECT policy each        (034 regression)
--    6  is_admin() is still the only function an anon key
--       may execute                           (036 regression)
--    7  the eight finance write RPCs are still service_role
--       only                              (035/036 regression)
--    8  an admin gets exact per-currency totals, spanning
--       every consultant                                   Part 2
--    9  usd and eur come back as separate rows and nothing
--       is summed across them                              Part 2
--   10  a reversal reduces all three totals and is reported
--       in reversals_minor                                 Part 2
--   11  an adjustment reduces the totals and is reported in
--       adjustments_minor                                  Part 2
--   12  the identity consultant + platform = gross holds on
--       the totals, per currency                           Part 2
--   13  the period is half-open: p_from is included, p_to is
--       excluded, and consecutive periods tile exactly     Part 2
--   14  an empty period returns zero rows and raises nothing Part 2
--   15  no ledger row, consultant, rate or memo is reachable
--       through the result                                 Part 2
--   16  null and inverted arguments are refused            Part 2
--   17  a consultant is denied                             Part 3
--   18  a client is denied                                 Part 3
--   19  anon is denied at the privilege layer              Part 3
--   20  availability is ignored: a pending earning still
--       counts toward the period                           Part 2
--   21  consultant_balances still answers the point-in-time
--       questions this RPC deliberately does not
--                                             (034 regression)
--   22  the ledger is still append-only     (034/035 regression)
--   23  re-running the migration's index and grants changes
--       nothing and creates no overload                    Part 4
--   24  fixtures roll back, asserted not assumed           Part 4
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, GRANTS AND REGRESSIONS (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_oid oid;
  v_count integer;
  v_secdef boolean;
  v_volatile char;
  v_config text;
begin
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_admin_finance_kpis';

  if v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 1: expected exactly 1 get_admin_finance_kpis, found %',
      v_count;
  end if;

  select p.oid, p.prosecdef, p.provolatile,
         coalesce(array_to_string(p.proconfig, ', '), '(none)')
    into v_oid, v_secdef, v_volatile, v_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_admin_finance_kpis';

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 1: get_admin_finance_kpis is not SECURITY DEFINER; it could not aggregate across consultants';
  end if;

  if v_volatile <> 's' then
    raise exception
      'VERIFICATION FAILED 1: get_admin_finance_kpis has volatility %, expected STABLE',
      v_volatile;
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 1: get_admin_finance_kpis has search_path %; a SECURITY DEFINER function must pin it',
      v_config;
  end if;

  raise notice
    'PASS 1: get_admin_finance_kpis exists once, SECURITY DEFINER, STABLE, search_path pinned';
end $$;


-- Check 2.
--
-- The returned shape is a contract the admin UI will be written
-- against. Renaming or reordering a column later is a silent
-- break, so the whole list is asserted rather than sampled.

do $$
declare
  v_expected text :=
    'currency text, '
    'gross_revenue_minor bigint, '
    'platform_revenue_minor bigint, '
    'consultant_earnings_minor bigint, '
    'reversals_minor bigint, '
    'adjustments_minor bigint, '
    'ledger_entry_count bigint';
  v_actual text;
begin
  select string_agg(
           a.name || ' ' || a.typ, ', ' order by a.ord)
    into v_actual
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

  if v_actual is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 2: returned columns are [%], expected [%]',
      coalesce(v_actual, '(none)'), v_expected;
  end if;

  raise notice
    'PASS 2: the seven documented columns are returned, in order, with the documented types';
end $$;


-- Check 3.
--
-- authenticated is granted deliberately — the caller is an
-- admin's browser — and everything else is not. service_role is
-- included because Supabase's default privileges grant it too,
-- and a grant held by name is not removed by revoking PUBLIC.

do $$
declare
  v_fn text :=
    'public.get_admin_finance_kpis(timestamptz, timestamptz)';
  v_role text;
begin
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 3: authenticated cannot execute %; the admin UI would get 404 from PostgREST',
      v_fn;
  end if;

  foreach v_role in array array['anon', 'service_role']
  loop
    if has_function_privilege(v_role, v_fn, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 3: % can execute %', v_role, v_fn;
    end if;
  end loop;

  /*
   * PUBLIC is grantee 0 in an exploded ACL. A null proacl is the
   * default ACL, which for a function means PUBLIC holds EXECUTE
   * — the exact state migration 038's revokes exist to leave
   * behind, so it fails here rather than reading as "no grants".
   */
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'get_admin_finance_kpis'
       and (
         p.proacl is null
         or exists (
           select 1 from aclexplode(p.proacl) a
            where a.grantee = 0
         )
       )
  ) then
    raise exception
      'VERIFICATION FAILED 3: PUBLIC still holds EXECUTE on %', v_fn;
  end if;

  raise notice
    'PASS 3: authenticated only; anon, service_role and PUBLIC are revoked';
end $$;


-- Check 4.

do $$
declare
  v_def text;
begin
  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public'
     and tablename = 'consultant_ledger_entries'
     and indexname = 'idx_ledger_created_at';

  if v_def is null then
    raise exception
      'VERIFICATION FAILED 4: idx_ledger_created_at does not exist; every period query is a full ledger scan';
  end if;

  if v_def not like '%(created_at)%' then
    raise exception
      'VERIFICATION FAILED 4: idx_ledger_created_at is not on created_at: %',
      v_def;
  end if;

  raise notice 'PASS 4: idx_ledger_created_at is on created_at';
end $$;


-- Check 5 — migration 034 is untouched.
--
-- This migration adds a function and an index. If the table count
-- or the finance policy set moved, something else was applied
-- with it.

do $$
declare
  v_tables integer;
  v_policies integer;
  v_writes integer;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE';

  /* 20 when written; 21 since migration 039 added
     public.consultant_payout_settings. */
  if v_tables <> 21 then
    raise exception
      'VERIFICATION FAILED 5: % base tables in public, expected 21',
      v_tables;
  end if;

  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public'
     and tablename in (
       'consultant_ledger_entries', 'payouts',
       'payout_allocations', 'service_purchases');

  if v_policies <> 4 then
    raise exception
      'VERIFICATION FAILED 5: % policies on the finance tables, expected 4',
      v_policies;
  end if;

  select count(*) into v_writes
    from pg_policies
   where schemaname = 'public'
     and tablename in (
       'consultant_ledger_entries', 'payouts',
       'payout_allocations', 'service_purchases')
     and cmd <> 'SELECT';

  if v_writes <> 0 then
    raise exception
      'VERIFICATION FAILED 5: % write policies appeared on a finance table',
      v_writes;
  end if;

  raise notice
    'PASS 5: 20 base tables, 4 finance policies, all SELECT — migration 034 intact';
end $$;


-- Check 6 — migration 036's tightest assertion still holds.
--
-- The new function is granted to authenticated, which is the
-- exception 036 did not have to consider. anon must still be able
-- to execute nothing but is_admin().

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
      'VERIFICATION FAILED 6: anon can execute: %', v_leaks;
  end if;

  if not has_function_privilege(
       'anon', 'public.is_admin()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 6: anon LOST is_admin(), which countries_select_active_public needs';
  end if;

  raise notice
    'PASS 6: is_admin() is still the only function an anon key may execute';
end $$;


-- Check 7 — migrations 035 and 036 are untouched.
--
-- The write paths are the ones that move money. A read model has
-- no business changing their reachability, so it is proved that
-- it did not.

do $$
declare
  v_fn regprocedure;
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
  v_checked integer := 0;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE')
       or has_function_privilege(
            'authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 7: % became client-callable', v_fn;
    end if;

    if not has_function_privilege(
         'service_role', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 7: service_role LOST execute on %', v_fn;
    end if;

    v_checked := v_checked + 1;
  end loop;

  if v_checked <> array_length(v_names, 1) then
    raise exception
      'VERIFICATION FAILED 7: found % of % finance write RPCs',
      v_checked, array_length(v_names, 1);
  end if;

  raise notice
    'PASS 7: all 8 finance write RPCs are still service_role only';
end $$;


-- ============================================================
-- PART 2 — THE TOTALS ARE CORRECT (STAGING ONLY, rolls back)
-- ============================================================

begin;

-- Fixtures.
--
-- Two consultants, so "the admin sees everything" is a claim with
-- something to prove rather than a single consultant's numbers
-- under another name.
--
-- The ledger under test, all of January 2031:
--
--   usd  E1  con A  earning     gross  15000  (at exactly p_from)
--   usd  E2  con B  earning     gross  20000
--   usd  R1  con A  reversal    gross -15000  (reverses E1)
--   usd  A1  con B  adjustment  gross   -500
--   eur  E3  con A  earning     gross   9000  (pending, no availability)
--
-- and two rows placed just outside it:
--
--   usd  E4  con A  earning     gross  50000  one second before p_from
--   usd  E5  con A  earning     gross  70000  at exactly p_to
--
-- Expected usd:  gross 19500, platform 10000, consultant 9500,
--                reversals -15000, adjustments -500, count 4
-- Expected eur:  gross  9000, platform  4500, consultant 4500,
--                reversals 0, adjustments 0, count 1

do $$
declare
  v_apr uuid := gen_random_uuid();
  v_cpr uuid := gen_random_uuid();
  v_bpr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con_a uuid;
  v_con_b uuid;
  v_e1 uuid;
  v_src_e1 uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_apr, 'v38-admin@verification.invalid'),
    (v_cpr, 'v38-consultant-a@verification.invalid'),
    (v_bpr, 'v38-consultant-b@verification.invalid'),
    (v_clp, 'v38-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_apr, 'admin', 'V38 Admin',
     'v38-admin@verification.invalid'),
    (v_cpr, 'consultant', 'V38 Consultant A',
     'v38-consultant-a@verification.invalid'),
    (v_bpr, 'consultant', 'V38 Consultant B',
     'v38-consultant-b@verification.invalid'),
    (v_clp, 'client', 'V38 Client',
     'v38-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true) returning id into v_con_a;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_bpr, 'Africa/Cairo', true) returning id into v_con_b;

  /* E1 — usd earning, at exactly p_from, released. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con_a, 'earning', 'consultation', v_src_e1,
    15000, 7500, 7500, 5000, 'standard_50_50', 'usd',
    timestamptz '2031-01-01 00:00:00+00',
    timestamptz '2031-01-01 00:00:00+00')
  returning id into v_e1;

  /* E2 — usd earning, the other consultant. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con_b, 'earning', 'consultation', gen_random_uuid(),
    20000, 10000, 10000, 5000, 'standard_50_50', 'usd',
    timestamptz '2031-01-10 12:00:00+00',
    timestamptz '2031-01-10 12:00:00+00');

  /* R1 — usd reversal of E1. Negative on all three columns, by
     ledger_sign_check; nothing here chooses that sign. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, reverses_entry_id, memo, created_at)
  values (v_con_a, 'reversal', 'consultation', v_src_e1,
    -15000, -7500, -7500, 5000, 'standard_50_50', 'usd',
    v_e1, 'V38 fixture refund',
    timestamptz '2031-01-15 09:00:00+00');

  /* A1 — usd admin adjustment, a flat correction with no rate. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, created_by_admin_profile_id, memo, created_at)
  values (v_con_b, 'adjustment', 'manual', null,
    -500, -500, 0, null, 'manual', 'usd',
    v_apr, 'V38 fixture correction',
    timestamptz '2031-01-20 09:00:00+00');

  /* E3 — eur earning, deliberately still PENDING (available_at
     null). It must still count: this is a period read model, not
     a withdrawability read model. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, created_at)
  values (v_con_a, 'earning', 'service_purchase',
    gen_random_uuid(),
    9000, 4500, 4500, 5000, 'service_rate', 'eur',
    timestamptz '2031-01-05 08:00:00+00');

  /* E4 — one second before the period opens. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con_a, 'earning', 'consultation', gen_random_uuid(),
    50000, 25000, 25000, 5000, 'standard_50_50', 'usd',
    timestamptz '2030-12-31 23:59:59+00',
    timestamptz '2030-12-31 23:59:59+00');

  /* E5 — at exactly p_to, which belongs to the NEXT period. */
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_at)
  values (v_con_a, 'earning', 'consultation', gen_random_uuid(),
    70000, 35000, 35000, 5000, 'standard_50_50', 'usd',
    timestamptz '2031-02-01 00:00:00+00',
    timestamptz '2031-02-01 00:00:00+00');

  perform set_config('app.v38_admin', v_apr::text, true);
  perform set_config('app.v38_consultant', v_cpr::text, true);
  perform set_config('app.v38_client', v_clp::text, true);
  perform set_config('app.v38_con_a', v_con_a::text, true);
  perform set_config('app.v38_entry', v_e1::text, true);
end $$;


-- Checks 8, 9, 10, 11, 12 and 20.

do $$
declare
  r record;
  v_rows integer := 0;
  v_seen_usd boolean := false;
  v_seen_eur boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v38_admin'), true);

  for r in
    select *
      from public.get_admin_finance_kpis(
        timestamptz '2031-01-01 00:00:00+00',
        timestamptz '2031-02-01 00:00:00+00')
  loop
    v_rows := v_rows + 1;

    /* Check 12 — the identity, per currency, on the totals. */
    if r.consultant_earnings_minor + r.platform_revenue_minor
       <> r.gross_revenue_minor then
      raise exception
        'VERIFICATION FAILED 12: % totals do not add up: % + % <> %',
        r.currency, r.consultant_earnings_minor,
        r.platform_revenue_minor, r.gross_revenue_minor;
    end if;

    if r.currency = 'usd' then
      v_seen_usd := true;

      /* Check 8 — spans both consultants (15000 + 20000 of
         earnings), check 10 — the reversal took 15000 back out,
         check 11 — the adjustment took 500 more. */
      if r.gross_revenue_minor <> 19500
         or r.platform_revenue_minor <> 10000
         or r.consultant_earnings_minor <> 9500
         or r.reversals_minor <> -15000
         or r.adjustments_minor <> -500
         or r.ledger_entry_count <> 4 then
        raise exception
          'VERIFICATION FAILED 8/10/11: usd totals were gross %, platform %, consultant %, reversals %, adjustments %, count %; expected 19500 / 10000 / 9500 / -15000 / -500 / 4',
          r.gross_revenue_minor, r.platform_revenue_minor,
          r.consultant_earnings_minor, r.reversals_minor,
          r.adjustments_minor, r.ledger_entry_count;
      end if;

    elsif r.currency = 'eur' then
      v_seen_eur := true;

      /* Check 20 — E3 is still pending and still counted. */
      if r.gross_revenue_minor <> 9000
         or r.platform_revenue_minor <> 4500
         or r.consultant_earnings_minor <> 4500
         or r.reversals_minor <> 0
         or r.adjustments_minor <> 0
         or r.ledger_entry_count <> 1 then
        raise exception
          'VERIFICATION FAILED 9/20: eur totals were gross %, platform %, consultant %, reversals %, adjustments %, count %; expected 9000 / 4500 / 4500 / 0 / 0 / 1',
          r.gross_revenue_minor, r.platform_revenue_minor,
          r.consultant_earnings_minor, r.reversals_minor,
          r.adjustments_minor, r.ledger_entry_count;
      end if;

    else
      raise exception
        'VERIFICATION FAILED 9: an unexpected currency % appeared in the period',
        r.currency;
    end if;
  end loop;

  reset role;

  /* Check 9 — two rows, not one. If the function had summed
     across currencies there would be one row here, and 19500 and
     9000 would have been added together as though a dollar were
     a euro. */
  if v_rows <> 2 or not v_seen_usd or not v_seen_eur then
    raise exception
      'VERIFICATION FAILED 9: % row(s) returned (usd seen: %, eur seen: %), expected one per currency',
      v_rows, v_seen_usd, v_seen_eur;
  end if;

  raise notice
    'PASS 8, 10, 11, 12 and 20: exact totals across both consultants, reversal and adjustment reported and deducted, identity holds, pending earnings counted';
  raise notice
    'PASS 9: usd and eur are separate rows; nothing is converted or combined';
end $$;


-- Check 13 — the period is half-open and consecutive periods
-- tile exactly.
--
-- E4 sits one second before January and E5 sits at exactly the
-- February boundary. Each must appear in precisely one of the
-- three periods below, and January's totals above already proved
-- neither leaked into it.

do $$
declare
  v_gross bigint;
  v_count bigint;
  v_rows integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v38_admin'), true);

  /* December owns E4. */
  select count(*), max(k.gross_revenue_minor),
         max(k.ledger_entry_count)
    into v_rows, v_gross, v_count
    from public.get_admin_finance_kpis(
      timestamptz '2030-12-01 00:00:00+00',
      timestamptz '2031-01-01 00:00:00+00') k;

  if v_rows <> 1 or v_gross <> 50000 or v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 13: December returned % row(s), gross %, count %; expected 1 / 50000 / 1',
      v_rows, v_gross, v_count;
  end if;

  /* February owns E5, the row sitting at exactly January's p_to. */
  select count(*), max(k.gross_revenue_minor),
         max(k.ledger_entry_count)
    into v_rows, v_gross, v_count
    from public.get_admin_finance_kpis(
      timestamptz '2031-02-01 00:00:00+00',
      timestamptz '2031-03-01 00:00:00+00') k;

  if v_rows <> 1 or v_gross <> 70000 or v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 13: February returned % row(s), gross %, count %; expected 1 / 70000 / 1',
      v_rows, v_gross, v_count;
  end if;

  reset role;

  raise notice
    'PASS 13: [p_from, p_to) is half-open; the boundary row belongs to exactly one period';
end $$;


-- Check 14 — an empty period.
--
-- Zero rows, not an error and not a null row. A caller renders
-- this as zeros.

do $$
declare
  v_rows integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v38_admin'), true);

  select count(*) into v_rows
    from public.get_admin_finance_kpis(
      timestamptz '2031-03-01 00:00:00+00',
      timestamptz '2031-04-01 00:00:00+00') k;

  reset role;

  if v_rows <> 0 then
    raise exception
      'VERIFICATION FAILED 14: an empty period returned % row(s)',
      v_rows;
  end if;

  raise notice
    'PASS 14: an empty period returns zero rows and raises nothing';
end $$;


-- Check 15 — nothing row-level is reachable.
--
-- The function's whole safety argument is that it aggregates
-- before it returns. This asserts the argument at the catalogue
-- level: no returned column names a consultant, an entry, a rate,
-- a memo or a source, and there is no parameter through which one
-- could be requested.

do $$
declare
  v_leaky text;
  v_args text;
begin
  select string_agg(name, ', ')
    into v_leaky
    from (
      select p.proargnames[t.ord] as name
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral generate_subscripts(
          p.proallargtypes, 1) as t(ord)
       where n.nspname = 'public'
         and p.proname = 'get_admin_finance_kpis'
         and p.proargmodes[t.ord] = 't'
    ) c
   where c.name ~ '(consultant_id|entry_id|source|memo|commission_bps|profile)';

  if v_leaky is not null then
    raise exception
      'VERIFICATION FAILED 15: the result exposes row-level column(s): %',
      v_leaky;
  end if;

  select coalesce(string_agg(
           p.proargnames[t.ord] || ' ' ||
           format_type(p.proallargtypes[t.ord], null), ', '
           order by t.ord), '(none)')
    into v_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral generate_subscripts(
      p.proallargtypes, 1) as t(ord)
   where n.nspname = 'public'
     and p.proname = 'get_admin_finance_kpis'
     and p.proargmodes[t.ord] = 'i';

  if v_args <> 'p_from timestamp with time zone, p_to timestamp with time zone' then
    raise exception
      'VERIFICATION FAILED 15: the parameter list is [%]; only the two period bounds are permitted',
      v_args;
  end if;

  raise notice
    'PASS 15: aggregates only, and the parameter surface is two timestamps — no filter, no column list, no SQL';
end $$;


-- Check 16 — the arguments are validated.

do $$
declare
  v_ok integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v38_admin'), true);

  begin
    perform 1 from public.get_admin_finance_kpis(
      null, timestamptz '2031-02-01 00:00:00+00');
    raise exception
      'VERIFICATION FAILED 16: a null p_from was accepted and would have totalled the whole ledger';
  exception
    when sqlstate '22004' then v_ok := v_ok + 1;
  end;

  begin
    perform 1 from public.get_admin_finance_kpis(
      timestamptz '2031-01-01 00:00:00+00', null);
    raise exception
      'VERIFICATION FAILED 16: a null p_to was accepted';
  exception
    when sqlstate '22004' then v_ok := v_ok + 1;
  end;

  begin
    perform 1 from public.get_admin_finance_kpis(
      timestamptz '2031-02-01 00:00:00+00',
      timestamptz '2031-01-01 00:00:00+00');
    raise exception
      'VERIFICATION FAILED 16: an inverted period was accepted';
  exception
    when sqlstate '22023' then v_ok := v_ok + 1;
  end;

  begin
    perform 1 from public.get_admin_finance_kpis(
      timestamptz '2031-01-01 00:00:00+00',
      timestamptz '2031-01-01 00:00:00+00');
    raise exception
      'VERIFICATION FAILED 16: an empty p_from = p_to period was accepted';
  exception
    when sqlstate '22023' then v_ok := v_ok + 1;
  end;

  reset role;

  if v_ok <> 4 then
    raise exception
      'VERIFICATION FAILED 16: only % of 4 argument checks refused',
      v_ok;
  end if;

  raise notice
    'PASS 16: null, inverted and empty argument pairs are all refused';
end $$;


-- ============================================================
-- PART 3 — ONLY AN ADMIN GETS THEM (STAGING ONLY, rolls back)
-- ============================================================

-- Checks 17 and 18.
--
-- Both hold an authenticated key, so both reach the function.
-- What stops them is is_admin() inside it, which is the point of
-- the pattern: the grant is the door, not the decision.

do $$
declare
  v_msg text;
  v_state text;
  v_denied integer := 0;
  v_who text;
begin
  foreach v_who in array array['app.v38_consultant', 'app.v38_client']
  loop
    set local role authenticated;
    perform set_config('request.jwt.claim.sub',
      current_setting(v_who), true);

    begin
      perform 1 from public.get_admin_finance_kpis(
        timestamptz '2031-01-01 00:00:00+00',
        timestamptz '2031-02-01 00:00:00+00');

      reset role;
      raise exception
        'VERIFICATION FAILED 17/18: % received platform finance totals',
        v_who;
    exception
      when insufficient_privilege then
        get stacked diagnostics
          v_msg = message_text, v_state = returned_sqlstate;

        if v_msg not like '%administrator access required%' then
          raise exception
            'VERIFICATION FAILED 17/18: % was refused with the wrong error: % (%)',
            v_who, v_msg, v_state;
        end if;

        v_denied := v_denied + 1;
    end;

    reset role;
  end loop;

  if v_denied <> 2 then
    raise exception
      'VERIFICATION FAILED 17/18: only % of 2 non-admin callers were refused',
      v_denied;
  end if;

  raise notice
    'PASS 17 and 18: a consultant and a client are both refused inside the function';
end $$;


-- Check 19 — anon.
--
-- Refused a layer earlier, at the ACL, so the function body is
-- never entered and an unauthenticated key cannot even establish
-- that the function exists.

do $$
declare
  v_denied boolean := false;
begin
  set local role anon;

  begin
    perform 1 from public.get_admin_finance_kpis(
      timestamptz '2031-01-01 00:00:00+00',
      timestamptz '2031-02-01 00:00:00+00');
  exception
    when insufficient_privilege then v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception
      'VERIFICATION FAILED 19: anon executed get_admin_finance_kpis';
  end if;

  raise notice
    'PASS 19: anon is refused at the privilege layer, before the body runs';
end $$;


-- Check 21 — the point-in-time figures still live where they did.
--
-- This migration deliberately did not copy available, reserved or
-- pending into the RPC. That is only a defensible choice while
-- consultant_balances still answers them, so it is checked rather
-- than assumed.

do $$
declare
  v_pending bigint;
  v_available bigint;
  v_cols integer;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultant_balances'
     and column_name in (
       'pending_minor', 'available_minor', 'reserved_minor',
       'paid_minor', 'lifetime_minor');

  if v_cols <> 5 then
    raise exception
      'VERIFICATION FAILED 21: consultant_balances exposes % of its 5 balance columns',
      v_cols;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v38_admin'), true);

  /* Consultant A: E1 15000/7500 released then fully reversed,
     E3 4500 still pending, E4 25000 and E5 35000 released. */
  select b.pending_minor, b.available_minor
    into v_pending, v_available
    from public.consultant_balances b
   where b.consultant_id = current_setting('app.v38_con_a')::uuid
     and b.currency = 'eur';

  reset role;

  if v_pending is distinct from 4500
     or v_available is distinct from 0 then
    raise exception
      'VERIFICATION FAILED 21: consultant_balances reported eur pending %, available %; expected 4500 / 0',
      v_pending, v_available;
  end if;

  raise notice
    'PASS 21: consultant_balances still answers pending / available / reserved; they are not duplicated into the RPC';
end $$;


-- Check 22 — the ledger is still append-only.

do $$
declare
  v_blocked integer := 0;
begin
  begin
    update public.consultant_ledger_entries
       set gross_amount_minor = 1
     where id = current_setting('app.v38_entry')::uuid;
    raise exception
      'VERIFICATION FAILED 22: a ledger amount was updated';
  exception
    when raise_exception then
      if sqlerrm not like '%append-only%' then
        raise;
      end if;
      v_blocked := v_blocked + 1;
  end;

  begin
    delete from public.consultant_ledger_entries
     where id = current_setting('app.v38_entry')::uuid;
    raise exception
      'VERIFICATION FAILED 22: a ledger entry was deleted';
  exception
    when raise_exception then
      if sqlerrm not like '%append-only%' then
        raise;
      end if;
      v_blocked := v_blocked + 1;
  end;

  if v_blocked <> 2 then
    raise exception
      'VERIFICATION FAILED 22: only % of 2 mutations were blocked',
      v_blocked;
  end if;

  raise notice
    'PASS 22: trg_ledger_append_only still refuses both UPDATE and DELETE';
end $$;


-- ============================================================
-- PART 4 — IDEMPOTENCE (STAGING ONLY, rolls back)
-- ============================================================

-- Check 23.
--
-- What a re-run of migration 038 actually executes is a guarded
-- DO block, one CREATE INDEX IF NOT EXISTS, one CREATE OR REPLACE
-- FUNCTION at a fixed signature, and four REVOKE/GRANT statements.
-- The index and the privilege statements are re-executed here for
-- real and the resulting ACL is compared byte for byte with the
-- one that was there before.
--
-- The function is not re-created here, because pasting its body
-- into a verification file is how the two drift apart. Its
-- idempotence rests on two facts this file already proves: the
-- signature is fixed, so CREATE OR REPLACE can only replace
-- (check 1 asserts exactly one exists and no overload), and the
-- privilege block that follows it re-establishes the ACL, which
-- is exactly what is exercised below.

do $$
declare
  v_acl_before text;
  v_acl_after text;
  v_count_before integer;
  v_count_after integer;
  v_index_before text;
  v_index_after text;
begin
  /*
   * The ACL is compared as a sorted set of aclitems rather than
   * as the raw array, so a re-grant that happens to reorder the
   * entries is not mistaken for a privilege change.
   */
  select count(*),
         coalesce(
           max((
             select string_agg(a::text, ',' order by a::text)
               from unnest(p.proacl) a
           )),
           '(none)')
    into v_count_before, v_acl_before
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_admin_finance_kpis';

  select indexdef into v_index_before
    from pg_indexes
   where schemaname = 'public'
     and indexname = 'idx_ledger_created_at';

  /* The migration's part A, verbatim. */
  create index if not exists idx_ledger_created_at
    on public.consultant_ledger_entries (created_at);

  /* The migration's part C, verbatim. */
  revoke all on function public.get_admin_finance_kpis(
    timestamptz, timestamptz) from public;
  revoke all on function public.get_admin_finance_kpis(
    timestamptz, timestamptz) from anon;
  revoke all on function public.get_admin_finance_kpis(
    timestamptz, timestamptz) from service_role;

  grant execute on function public.get_admin_finance_kpis(
    timestamptz, timestamptz) to authenticated;

  select count(*),
         coalesce(
           max((
             select string_agg(a::text, ',' order by a::text)
               from unnest(p.proacl) a
           )),
           '(none)')
    into v_count_after, v_acl_after
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_admin_finance_kpis';

  select indexdef into v_index_after
    from pg_indexes
   where schemaname = 'public'
     and indexname = 'idx_ledger_created_at';

  if v_count_after <> v_count_before or v_count_after <> 1 then
    raise exception
      'VERIFICATION FAILED 23: the function count moved from % to %',
      v_count_before, v_count_after;
  end if;

  if v_acl_after is distinct from v_acl_before then
    raise exception
      'VERIFICATION FAILED 23: the ACL changed on re-run, from [%] to [%]',
      v_acl_before, v_acl_after;
  end if;

  if v_index_after is distinct from v_index_before then
    raise exception
      'VERIFICATION FAILED 23: the index definition changed on re-run, from [%] to [%]',
      v_index_before, v_index_after;
  end if;

  raise notice
    'PASS 23: re-running the index and privilege statements is a no-op and creates no overload';
end $$;


-- Check 23, continued — the admin still gets the same answer
-- after the re-run. A privilege statement that quietly changed
-- behaviour would show up here rather than in the ACL diff.

do $$
declare
  v_gross bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v38_admin'), true);

  select k.gross_revenue_minor into v_gross
    from public.get_admin_finance_kpis(
      timestamptz '2031-01-01 00:00:00+00',
      timestamptz '2031-02-01 00:00:00+00') k
   where k.currency = 'usd';

  reset role;

  if v_gross <> 19500 then
    raise exception
      'VERIFICATION FAILED 23: after the re-run the usd total is %, expected 19500',
      v_gross;
  end if;

  raise notice 'PASS 23: the totals survive the re-run unchanged';
end $$;

rollback;


-- Check 24 — the fixtures are gone.

do $$
declare
  v_left integer;
  v_rows integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v38-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 24: % verification profile(s) survived the rollback',
      v_left;
  end if;

  select count(*) into v_rows
    from public.consultant_ledger_entries
   where created_at >= timestamptz '2030-12-01 00:00:00+00'
     and created_at <  timestamptz '2031-04-01 00:00:00+00';

  if v_rows <> 0 then
    raise exception
      'VERIFICATION FAILED 24: % fixture ledger row(s) survived the rollback',
      v_rows;
  end if;

  raise notice 'PASS 24: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 038 adds one function and one index and writes no
-- data. Dropping both destroys nothing and is reversible by
-- re-applying the file.
--
--   drop function if exists public.get_admin_finance_kpis(
--     timestamptz, timestamptz);
--   drop index if exists public.idx_ledger_created_at;
--
-- The consequence of dropping the function is that the admin
-- finance period KPIs have no server-side source. There is no
-- fallback: PostgREST aggregates are disabled, so the screen goes
-- blank rather than quietly downloading the ledger. That is the
-- intended failure mode.
--
-- Dropping the index costs performance only. Every period query
-- becomes a sequential scan of consultant_ledger_entries and
-- returns the same numbers.
--
-- Nothing else needs undoing: no table, column, constraint,
-- trigger, policy or grant on any pre-existing object was
-- changed, and no ledger row was written.
-- ============================================================

do $$
begin
  raise notice
    'migration 038 verification complete: no check raised';
end $$;
