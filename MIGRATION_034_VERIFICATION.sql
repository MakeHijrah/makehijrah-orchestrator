-- ============================================================
-- Verification for migration_034_financial_foundation
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  structure, privileges and policies   read-only
--   Part 2  ledger behaviour                     STAGING ONLY, rolls back
--   Part 3  payout and allocation behaviour      STAGING ONLY, rolls back
--   Part 4  scope inspection                     read-only
--   Part 5  rollback guidance
--
-- Parts 2 and 3 create every fixture they need inside a
-- transaction and roll it back. They read no business record.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths.
--
-- Check map:
--    1  the four finance tables exist                    Part 1
--    2  services.consultant_commission_bps exists and is
--       unreadable by anon and authenticated             Part 1
--    3  app_settings carries the 50% consultation split  Part 1
--    4  RLS is enabled on all four tables, with exactly
--       one SELECT policy each and no write policy       Part 1
--    5  anon holds nothing; authenticated holds SELECT
--       only                                             Part 1
--    6  consultant_balances exists as a security_invoker
--       view                                             Part 1
--    7  an earning records the full 50/50 split          Part 2
--    8  a duplicate earning for one source is refused    Part 2
--    9  the amount identity is enforced                  Part 2
--   10  sign rules per entry type are enforced           Part 2
--   11  currency must be lowercase ISO 4217 alpha-3      Part 2
--   12  the commission basis must match its source type  Part 2
--   13  an adjustment requires an admin and a memo       Part 2
--   14  a ledger entry cannot be edited or deleted       Part 2
--   15  available_at advances once and only once         Part 2
--   16  a direct booking records both tiers, and only a
--       direct booking may carry a tier                  Part 2
--   17  a reversal must name its original and never
--       alters it                                        Part 2
--   18  one open payout per consultant per currency      Part 3
--   19  invalid payout state is refused                  Part 3
--   20  a pending or cross-currency earning cannot be
--       allocated                                        Part 3
--   21  a paid payout cannot release its allocations     Part 3
--   22  one earning can never reach two payouts          Part 3
--   23  balances derive correctly and never read null    Part 3
--   24  a recurring service earns per renewal; a
--       redelivered Stripe object does not               Part 3
--   25  fixtures roll back, asserted not assumed         Part 3
--   26  table count is 20, no existing policy changed    Part 4
-- ============================================================


-- ============================================================
-- PART 1 — STRUCTURE, PRIVILEGES AND POLICIES (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_missing text;
begin
  select string_agg(t, ', ')
    into v_missing
    from unnest(array[
      'public.consultant_ledger_entries',
      'public.payouts',
      'public.payout_allocations',
      'public.service_purchases'
    ]) as t
   where to_regclass(t) is null;

  if v_missing is not null then
    raise exception
      'VERIFICATION FAILED 1: missing finance table(s): %', v_missing;
  end if;

  raise notice 'PASS 1: the four finance tables exist';
end $$;


-- Check 2.
--
-- The rate a consultant earns is not the client's business, and
-- services_select_active is readable by every authenticated user.
-- RLS filters rows, not columns, so the column privilege is the
-- only thing standing between the two.

do $$
declare
  v_type text;
begin
  select data_type into v_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'services'
     and column_name  = 'consultant_commission_bps';

  if v_type is null then
    raise exception
      'VERIFICATION FAILED 2: services.consultant_commission_bps does not exist';
  end if;

  if has_column_privilege(
       'authenticated', 'public.services',
       'consultant_commission_bps', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 2: authenticated can read the commission rate';
  end if;

  if has_column_privilege(
       'anon', 'public.services',
       'consultant_commission_bps', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 2: anon can read the commission rate';
  end if;

  -- The rest of the catalogue must still be readable, or the
  -- booking surface breaks.
  if not has_column_privilege(
       'authenticated', 'public.services', 'name', 'SELECT')
     or not has_column_privilege(
       'authenticated', 'public.services', 'price_cents', 'SELECT')
     or not has_column_privilege(
       'anon', 'public.services', 'name', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 2: the services SELECT grant lost a client-visible column';
  end if;

  raise notice
    'PASS 2: the commission rate exists and is hidden from anon and authenticated';
end $$;


-- Check 3.

do $$
declare
  v_bps integer;
  v_nullable text;
begin
  select is_nullable into v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'app_settings'
     and column_name  = 'consultation_consultant_commission_bps';

  if v_nullable is null then
    raise exception
      'VERIFICATION FAILED 3: app_settings.consultation_consultant_commission_bps does not exist';
  end if;

  if v_nullable <> 'NO' then
    raise exception
      'VERIFICATION FAILED 3: the commission setting is nullable';
  end if;

  select consultation_consultant_commission_bps
    into v_bps from public.app_settings;

  if v_bps <> 5000 then
    raise notice
      'CHECK 3: the consultation split is % bps, not the 5000 this migration seeded. Expected only if an admin has changed it.',
      v_bps;
  else
    raise notice 'PASS 3: the standard consultation split is 50%%';
  end if;
end $$;


-- Check 4.

do $$
declare
  v_table text;
  v_rls   boolean;
  v_all   integer;
  v_sel   integer;
begin
  foreach v_table in array array[
    'consultant_ledger_entries',
    'payouts',
    'payout_allocations',
    'service_purchases'
  ]
  loop
    select c.relrowsecurity into v_rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_table;

    if v_rls is not true then
      raise exception
        'VERIFICATION FAILED 4: RLS is not enabled on public.%', v_table;
    end if;

    select count(*),
           count(*) filter (where cmd = 'SELECT')
      into v_all, v_sel
      from pg_policies
     where schemaname = 'public' and tablename = v_table;

    if v_all <> 1 or v_sel <> 1 then
      raise exception
        'VERIFICATION FAILED 4: public.% carries % policies (% SELECT), expected exactly one SELECT policy',
        v_table, v_all, v_sel;
    end if;
  end loop;

  raise notice
    'PASS 4: RLS on, one SELECT policy each, no write policy anywhere';
end $$;


-- Check 5.
--
-- Supabase grants everything on a new public table to anon and
-- authenticated by default, so what a finance table does NOT
-- grant has to be asserted rather than assumed.

do $$
declare
  v_table text;
  v_priv  text;
begin
  foreach v_table in array array[
    'consultant_ledger_entries',
    'payouts',
    'payout_allocations',
    'service_purchases'
  ]
  loop
    foreach v_priv in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE'
    ]
    loop
      if has_table_privilege('anon', 'public.' || v_table, v_priv) then
        raise exception
          'VERIFICATION FAILED 5: anon holds % on public.%',
          v_priv, v_table;
      end if;
    end loop;

    if not has_table_privilege(
         'authenticated', 'public.' || v_table, 'SELECT') then
      raise exception
        'VERIFICATION FAILED 5: authenticated cannot SELECT public.%',
        v_table;
    end if;

    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE']
    loop
      if has_table_privilege(
           'authenticated', 'public.' || v_table, v_priv) then
        raise exception
          'VERIFICATION FAILED 5: authenticated holds % on public.%; financial writes are service role only',
          v_priv, v_table;
      end if;
    end loop;
  end loop;

  raise notice
    'PASS 5: anon holds nothing, authenticated holds SELECT only';
end $$;


-- Check 6.
--
-- Without security_invoker the view would run with its owner's
-- rights and hand every consultant's balance to every caller.

do $$
declare
  v_options text[];
begin
  select c.reloptions into v_options
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'consultant_balances'
     and c.relkind = 'v';

  if not found then
    raise exception
      'VERIFICATION FAILED 6: public.consultant_balances is not a view';
  end if;

  if v_options is null
     or not ('security_invoker=on' = any(v_options)) then
    raise exception
      'VERIFICATION FAILED 6: consultant_balances is not security_invoker; it would leak every balance to every caller';
  end if;

  if has_table_privilege('anon', 'public.consultant_balances', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 6: anon can select consultant_balances';
  end if;

  raise notice 'PASS 6: consultant_balances is a security_invoker view';
end $$;


-- ============================================================
-- PART 2 — LEDGER BEHAVIOUR (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_cpr    uuid := gen_random_uuid();
  v_apr    uuid := gen_random_uuid();
  v_con    uuid;
  v_source uuid := gen_random_uuid();
  v_booking uuid := gen_random_uuid();
  v_entry  uuid;
  v_amount integer;
begin
  insert into auth.users (id, email) values
    (v_cpr, 'v34-consultant@verification.invalid'),
    (v_apr, 'v34-admin@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr, 'consultant', 'V34 Consultant',
     'v34-consultant@verification.invalid'),
    (v_apr, 'admin', 'V34 Admin',
     'v34-admin@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone)
  values (v_cpr, 'Africa/Cairo') returning id into v_con;

  perform set_config('app.v34_con', v_con::text, true);
  perform set_config('app.v34_admin', v_apr::text, true);

  -- ---------------------------------------------------------
  -- Check 7 — the locked standard split, on gross.
  -- ---------------------------------------------------------
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis, currency)
  values (v_con, 'earning', 'consultation', v_source,
    15000, 7500, 7500, 5000, 'standard_50_50', 'usd')
  returning id into v_entry;

  perform set_config('app.v34_entry', v_entry::text, true);

  select consultant_amount_minor into v_amount
    from public.consultant_ledger_entries where id = v_entry;

  if v_amount <> 7500 then
    raise exception
      'VERIFICATION FAILED 7: the consultant share stored as %', v_amount;
  end if;

  -- ---------------------------------------------------------
  -- Check 8 — a replayed webhook cannot credit twice.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'consultation', v_source,
      15000, 7500, 7500, 5000, 'standard_50_50', 'usd');
    raise exception
      'VERIFICATION FAILED 8: a duplicate earning was accepted';
  exception when unique_violation then null;
  end;

  -- ---------------------------------------------------------
  -- Check 9 — the split must add up to what was charged.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'consultation', gen_random_uuid(),
      15000, 7500, 6000, 5000, 'standard_50_50', 'usd');
    raise exception
      'VERIFICATION FAILED 9: a split that does not add up was accepted';
  exception when check_violation then null;
  end;

  -- ---------------------------------------------------------
  -- Check 10 — sign is meaning, not convention.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'consultation', gen_random_uuid(),
      -15000, -7500, -7500, 5000, 'standard_50_50', 'usd');
    raise exception
      'VERIFICATION FAILED 10: a negative earning was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_bps, commission_basis,
      currency, reverses_entry_id)
    values (v_con, 'reversal', 'consultation', v_source,
      15000, 7500, 7500, 5000, 'standard_50_50', 'usd', v_entry);
    raise exception
      'VERIFICATION FAILED 10: a positive reversal was accepted';
  exception when check_violation then null;
  end;

  -- ---------------------------------------------------------
  -- Check 11 — currency formatting, which is what makes a
  -- per-currency balance safe to group by.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'consultation', gen_random_uuid(),
      15000, 7500, 7500, 5000, 'standard_50_50', 'USD');
    raise exception
      'VERIFICATION FAILED 11: an uppercase currency was accepted';
  exception when check_violation then null;
  end;

  -- ---------------------------------------------------------
  -- Check 12 — an entry cannot misreport where it came from.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'service_purchase', gen_random_uuid(),
      15000, 7500, 7500, 5000, 'standard_50_50', 'usd');
    raise exception
      'VERIFICATION FAILED 12: a mismatched commission basis was accepted';
  exception when check_violation then null;
  end;

  -- ---------------------------------------------------------
  -- Check 13 — an admin adjustment says who and why.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_basis, currency)
    values (v_con, 'adjustment', 'manual',
      500, 500, 0, 'manual', 'usd');
    raise exception
      'VERIFICATION FAILED 13: an unattributed adjustment was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type,
      gross_amount_minor, consultant_amount_minor,
      platform_amount_minor, commission_basis, currency,
      created_by_admin_profile_id, memo)
    values (v_con, 'adjustment', 'manual',
      500, 500, 0, 'manual', 'usd', v_apr, '   ');
    raise exception
      'VERIFICATION FAILED 13: a blank memo was accepted as a reason';
  exception when check_violation then null;
  end;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_basis, currency,
    created_by_admin_profile_id, memo, available_at)
  values (v_con, 'adjustment', 'manual',
    500, 500, 0, 'manual', 'usd', v_apr,
    'goodwill correction', now());

  raise notice 'PASS 7-13: ledger entry rules hold';

  -- ---------------------------------------------------------
  -- Check 14 — append-only, with no exemption for the caller
  -- running this file.
  -- ---------------------------------------------------------
  begin
    update public.consultant_ledger_entries
       set consultant_amount_minor = 999999 where id = v_entry;
    raise exception
      'VERIFICATION FAILED 14: a ledger amount was edited';
  exception when raise_exception then null;
  end;

  begin
    update public.consultant_ledger_entries
       set memo = 'rewriting history' where id = v_entry;
    raise exception
      'VERIFICATION FAILED 14: a ledger memo was edited';
  exception when raise_exception then null;
  end;

  begin
    delete from public.consultant_ledger_entries where id = v_entry;
    raise exception
      'VERIFICATION FAILED 14: a ledger entry was deleted';
  exception when raise_exception then null;
  end;

  -- ---------------------------------------------------------
  -- Check 15 — availability advances once.
  -- ---------------------------------------------------------
  update public.consultant_ledger_entries
     set available_at = now() where id = v_entry;

  begin
    update public.consultant_ledger_entries
       set available_at = now() + interval '1 day' where id = v_entry;
    raise exception
      'VERIFICATION FAILED 15: availability was moved';
  exception when raise_exception then null;
  end;

  begin
    update public.consultant_ledger_entries
       set available_at = null where id = v_entry;
    raise exception
      'VERIFICATION FAILED 15: availability was cleared';
  exception when raise_exception then null;
  end;

  raise notice 'PASS 14-15: the ledger is append-only';

  -- ---------------------------------------------------------
  -- Check 16 — the direct-booking split: the standard portion
  -- at 50/50 and the premium above it at 80/20, each its own
  -- entry carrying its own flat rate.
  -- ---------------------------------------------------------
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id, source_component,
    gross_amount_minor, consultant_amount_minor, platform_amount_minor,
    commission_bps, commission_basis, currency, available_at)
  values
    (v_con, 'earning', 'direct_booking', v_booking, 'standard',
     15000, 7500, 7500, 5000, 'direct_booking_standard', 'usd', now()),
    (v_con, 'earning', 'direct_booking', v_booking, 'premium',
     10000, 8000, 2000, 8000, 'direct_booking_premium', 'usd', now());

  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id, source_component,
      gross_amount_minor, consultant_amount_minor, platform_amount_minor,
      commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'direct_booking', v_booking, 'premium',
      10000, 8000, 2000, 8000, 'direct_booking_premium', 'usd');
    raise exception
      'VERIFICATION FAILED 16: a duplicate premium component was accepted';
  exception when unique_violation then null;
  end;

  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id, source_component,
      gross_amount_minor, consultant_amount_minor, platform_amount_minor,
      commission_bps, commission_basis, currency)
    values (v_con, 'earning', 'consultation', gen_random_uuid(), 'premium',
      10000, 8000, 2000, 8000, 'standard_50_50', 'usd');
    raise exception
      'VERIFICATION FAILED 16: a consultation carried a premium tier';
  exception when check_violation then null;
  end;

  -- ---------------------------------------------------------
  -- Check 17 — a refund reverses, it does not edit.
  -- ---------------------------------------------------------
  begin
    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      gross_amount_minor, consultant_amount_minor, platform_amount_minor,
      commission_bps, commission_basis, currency)
    values (v_con, 'reversal', 'consultation', v_source,
      -15000, -7500, -7500, 5000, 'standard_50_50', 'usd');
    raise exception
      'VERIFICATION FAILED 17: a reversal named no original';
  exception when check_violation then null;
  end;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor, platform_amount_minor,
    commission_bps, commission_basis, currency,
    reverses_entry_id, available_at)
  values (v_con, 'reversal', 'consultation', v_source,
    -15000, -7500, -7500, 5000, 'standard_50_50', 'usd',
    v_entry, now());

  select consultant_amount_minor into v_amount
    from public.consultant_ledger_entries where id = v_entry;

  if v_amount <> 7500 then
    raise exception
      'VERIFICATION FAILED 17: the reversed earning changed to %', v_amount;
  end if;

  raise notice 'PASS 16-17: tiered earnings and reversals behave';
end $$;


-- ============================================================
-- PART 3 — PAYOUTS AND ALLOCATIONS (same transaction)
-- ============================================================

do $$
declare
  v_con     uuid := current_setting('app.v34_con')::uuid;
  v_admin   uuid := current_setting('app.v34_admin')::uuid;
  v_entry   uuid := current_setting('app.v34_entry')::uuid;
  v_pending uuid;
  v_payout  uuid;
  v_gbp     uuid;
  v_second  uuid;
  v_service uuid;
  v_n       integer;
  v_p       integer;
  v_a       integer;
  v_paid    integer;
  v_life    integer;
begin
  -- ---------------------------------------------------------
  -- Check 18 — one open request per consultant per currency.
  -- ---------------------------------------------------------
  insert into public.payouts (
    consultant_id, currency, requested_amount_minor)
  values (v_con, 'usd', 500)
  returning id into v_payout;

  begin
    insert into public.payouts (
      consultant_id, currency, requested_amount_minor)
    values (v_con, 'usd', 100);
    raise exception
      'VERIFICATION FAILED 18: a second open payout was accepted';
  exception when unique_violation then null;
  end;

  -- A different currency is a different balance, so it is allowed.
  insert into public.payouts (
    consultant_id, currency, requested_amount_minor)
  values (v_con, 'gbp', 100)
  returning id into v_gbp;

  -- ---------------------------------------------------------
  -- Check 19 — a payout cannot claim an outcome it has no
  -- record of, and cannot carry a paid amount while unpaid.
  -- ---------------------------------------------------------
  begin
    update public.payouts set status = 'paid' where id = v_payout;
    raise exception
      'VERIFICATION FAILED 19: paid with no amount, date or admin';
  exception when check_violation then null;
  end;

  begin
    update public.payouts
       set status = 'rejected' where id = v_payout;
    raise exception
      'VERIFICATION FAILED 19: rejected with no date or admin';
  exception when check_violation then null;
  end;

  begin
    insert into public.payouts (
      consultant_id, currency, requested_amount_minor, paid_amount_minor)
    values (v_con, 'eur', 100, 100);
    raise exception
      'VERIFICATION FAILED 19: an unpaid payout carried a paid amount';
  exception when check_violation then null;
  end;

  raise notice 'PASS 18-19: payout state is constrained';

  -- ---------------------------------------------------------
  -- Check 20 — an allocation has to be coherent.
  -- ---------------------------------------------------------
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor, platform_amount_minor,
    commission_bps, commission_basis, currency)
  values (v_con, 'earning', 'consultation', gen_random_uuid(),
    20000, 10000, 10000, 5000, 'standard_50_50', 'usd')
  returning id into v_pending;

  begin
    insert into public.payout_allocations (payout_id, ledger_entry_id)
    values (v_payout, v_pending);
    raise exception
      'VERIFICATION FAILED 20: a pending earning was allocated';
  exception when raise_exception then null;
  end;

  begin
    insert into public.payout_allocations (payout_id, ledger_entry_id)
    values (v_gbp, v_entry);
    raise exception
      'VERIFICATION FAILED 20: an earning was allocated across currencies';
  exception when raise_exception then null;
  end;

  insert into public.payout_allocations (payout_id, ledger_entry_id)
  values (v_payout, v_entry);

  update public.payouts
     set status = 'cancelled', cancelled_at = now() where id = v_gbp;

  -- ---------------------------------------------------------
  -- Check 21 — settled money stays settled.
  -- ---------------------------------------------------------
  update public.payouts
     set status = 'approved', approved_at = now(),
         decided_by_admin_profile_id = v_admin
   where id = v_payout;

  update public.payouts
     set status = 'paid', paid_at = now(), paid_amount_minor = 7500
   where id = v_payout;

  begin
    delete from public.payout_allocations where payout_id = v_payout;
    raise exception
      'VERIFICATION FAILED 21: a paid payout released its allocations';
  exception when raise_exception then null;
  end;

  -- ---------------------------------------------------------
  -- Check 22 — the double-payment guarantee. The first payout
  -- is settled, so a new request is legal again; the earning it
  -- already paid still cannot be claimed a second time.
  -- ---------------------------------------------------------
  insert into public.payouts (
    consultant_id, currency, requested_amount_minor)
  values (v_con, 'usd', 100)
  returning id into v_second;

  begin
    insert into public.payout_allocations (payout_id, ledger_entry_id)
    values (v_second, v_entry);
    raise exception
      'VERIFICATION FAILED 22: one earning reached two payouts';
  exception when unique_violation then null;
  end;

  update public.payouts
     set status = 'cancelled', cancelled_at = now() where id = v_second;

  raise notice 'PASS 20-22: an earning is paid at most once';

  -- ---------------------------------------------------------
  -- Check 23 — balances derive, and never read null.
  --
  -- 7500 paid out, +500 adjustment, +7500 standard tier,
  -- +8000 premium tier, -7500 reversal, and 10000 still pending.
  -- ---------------------------------------------------------
  select pending_minor, available_minor, paid_minor, lifetime_minor
    into v_p, v_a, v_paid, v_life
    from public.consultant_balances
   where consultant_id = v_con and currency = 'usd';

  if v_p <> 10000 then
    raise exception 'VERIFICATION FAILED 23: pending is %, expected 10000', v_p;
  end if;
  if v_paid <> 7500 then
    raise exception 'VERIFICATION FAILED 23: paid is %, expected 7500', v_paid;
  end if;
  if v_a <> 8500 then
    raise exception 'VERIFICATION FAILED 23: available is %, expected 8500', v_a;
  end if;
  if v_life <> 26000 then
    raise exception 'VERIFICATION FAILED 23: lifetime is %, expected 26000', v_life;
  end if;

  select count(*) into v_n
    from public.consultant_balances
   where pending_minor is null or available_minor is null
      or reserved_minor is null or paid_minor is null
      or lifetime_minor is null;

  if v_n <> 0 then
    raise exception
      'VERIFICATION FAILED 23: % balance row(s) read null', v_n;
  end if;

  raise notice 'PASS 23: balances derive correctly and never read null';

  -- ---------------------------------------------------------
  -- Check 24 — a recurring service earns on every renewal, and
  -- a redelivered Stripe object earns nothing extra.
  -- ---------------------------------------------------------
  insert into public.services (name, consultant_commission_bps)
  values ('ZZ V34 Service', 3000) returning id into v_service;

  insert into public.service_purchases (
    service_id, attributed_consultant_id, gross_amount_minor, currency,
    billing_type, recurring_interval, billing_period_sequence,
    stripe_invoice_id)
  values
    (v_service, v_con, 50000, 'usd', 'recurring', 'month', 1, 'in_v34_1'),
    (v_service, v_con, 50000, 'usd', 'recurring', 'month', 2, 'in_v34_2');

  begin
    insert into public.service_purchases (
      service_id, attributed_consultant_id, gross_amount_minor, currency,
      billing_type, recurring_interval, billing_period_sequence,
      stripe_invoice_id)
    values (v_service, v_con, 50000, 'usd', 'recurring', 'month', 3,
      'in_v34_2');
    raise exception
      'VERIFICATION FAILED 24: a redelivered Stripe invoice created a second purchase';
  exception when unique_violation then null;
  end;

  begin
    insert into public.service_purchases (
      service_id, gross_amount_minor, currency, billing_type)
    values (v_service, 50000, 'usd', 'recurring');
    raise exception
      'VERIFICATION FAILED 24: a recurring purchase had no interval';
  exception when check_violation then null;
  end;

  begin
    insert into public.service_purchases (
      service_id, gross_amount_minor, currency, billing_type, status)
    values (v_service, 50000, 'usd', 'one_time', 'fulfilled');
    raise exception
      'VERIFICATION FAILED 24: a fulfilled purchase carried no fulfillment date';
  exception when check_violation then null;
  end;

  raise notice 'PASS 24: service purchases and renewals behave';
end $$;

rollback;


-- Check 25 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v34-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 25: % verification profile(s) survived the rollback',
      v_left;
  end if;

  select count(*) into v_left
    from public.services where name = 'ZZ V34 Service';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 25: the verification service survived the rollback';
  end if;

  raise notice 'PASS 25: every fixture rolled back';
end $$;


-- ============================================================
-- PART 4 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 26.
--
-- Migration 034 adds four tables and touches no existing policy.
-- The policy counts below are the ones migration 002 and its
-- successors left in place.

do $$
declare
  v_tables integer;
  v_countries integer;
  v_services integer;
  v_consultations integer;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  if v_tables <> 20 then
    raise exception
      'VERIFICATION FAILED 26: public holds % base tables, expected 20',
      v_tables;
  end if;

  select count(*) into v_countries from pg_policies
   where schemaname = 'public' and tablename = 'countries';
  select count(*) into v_services from pg_policies
   where schemaname = 'public' and tablename = 'services';
  select count(*) into v_consultations from pg_policies
   where schemaname = 'public' and tablename = 'consultations';

  if v_countries <> 4 then
    raise exception
      'VERIFICATION FAILED 26: countries carries % policies, expected 4',
      v_countries;
  end if;

  -- Migration 022 dropped the three admin write policies, leaving
  -- services_select_active alone.
  if v_services <> 1 then
    raise exception
      'VERIFICATION FAILED 26: services carries % policies, expected 1',
      v_services;
  end if;

  if v_consultations <> 1 then
    raise exception
      'VERIFICATION FAILED 26: consultations carries % policies, expected 1',
      v_consultations;
  end if;

  raise notice
    'PASS 26: 20 base tables and no existing policy changed';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 034 is additive. Nothing reads these tables yet, so
-- leaving them in place and unused is the preferred response to
-- a problem with them.
--
-- To reverse it fully, in this order:
--
--   drop view if exists public.consultant_balances;
--   drop table if exists public.payout_allocations;
--   drop table if exists public.payouts;
--   drop table if exists public.consultant_ledger_entries;
--   drop table if exists public.service_purchases;
--   drop function if exists public.enforce_ledger_append_only();
--   drop function if exists public.enforce_payout_allocation();
--   drop function if exists public.can_view_payout(uuid);
--   alter table public.app_settings
--     drop column if exists consultation_consultant_commission_bps;
--   alter table public.services
--     drop column if exists consultant_commission_bps;
--
-- Dropping the ledger destroys the only record of what any
-- consultant earned. Export it first if any earning has been
-- written:
--
--   select * from public.consultant_ledger_entries order by created_at;
--
-- Restoring the services SELECT grant, which part E replaced with
-- a column list:
--
--   grant select on public.services to anon, authenticated;
--
-- Do that BEFORE dropping services.consultant_commission_bps if
-- the column list is to be abandoned, so no window exists in
-- which the catalogue is unreadable.
-- ============================================================

do $$
begin
  raise notice
    'migration 034 verification complete: no check raised';
end $$;
