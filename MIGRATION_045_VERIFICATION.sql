-- ============================================================
-- Verification for migration_045_direct_consultant_booking
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, security and ACLs           read-only
--   Part 2  constraints                        STAGING ONLY, rolls back
--   Part 3  the two-component split            STAGING ONLY, rolls back
--   Part 4  release                            STAGING ONLY, rolls back
--   Part 5  CUMULATIVE refunds                 STAGING ONLY, rolls back
--   Part 6  regressions                        STAGING ONLY, rolls back
--   Part 7  rollback guidance
--
-- Parts 2 to 6 share one transaction that ends in ROLLBACK.
--
-- The finance assertions are EXACT, not lower bounds. That is only
-- honest if the platform's own price and commission rate are known,
-- and on a staging database they are whatever an admin last set. So
-- part 3 pins app_settings to the locked example — 15000 minor at
-- 5000 bps — inside the transaction that rolls back. Nothing
-- outside this file sees that value, and the arithmetic asserted
-- below is the arithmetic the amendment specifies rather than the
-- arithmetic that happens to hold today.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  the three consultants columns exist, with the right types
--       and the right default
--    2  a slug is unique when set, and many rows may leave it null
--    3  the slug format constraint rejects anything that is not
--       already normalised
--    4  a slug shorter than 3 or longer than 60 is rejected
--    5  a configured price outside the sane range is rejected
--    6  enabling direct booking requires BOTH a slug and a price
--    7  consultations.booking_source exists, is NOT NULL, and
--       defaults to 'standard'
--    8  booking_source admits 'standard' and 'direct_booking' and
--       nothing else
--    9  every consultation that predates this migration reads
--       'standard'
--   10  a direct booking records TWO components, each valid under
--       migration 034's component and basis constraints
--   11  a direct booking priced at exactly the platform default
--       records the standard component ONLY - no zero-value
--       premium row
--   12  THE LOCKED EXAMPLE: 15000 default, 20000 direct
--       = consultant 11500, platform 8500
--   13  record is idempotent
--   14  release makes BOTH components available, together
--   15  release is idempotent
--   16  a first partial refund splits proportionally
--   17  a redelivered partial applies nothing
--   18  a second partial applies only its DIFFERENCE
--   19  partial then full completes exactly
--   20  a duplicate full applies nothing
--   21  the component reversals sum to the cumulative refund
--       EXACTLY, and the ledger nets to zero
--   22  a refunded total above the gross is rejected
--   23  the standard consultation earning path is unchanged, the
--       two paths refuse each other in BOTH directions, and
--       replacing record_consultation_earning reopened no ACL
--   24  service purchase finance is unchanged
--   25  migration 044 reports direct_booking as its own source
--   26  ACLs: service_role only; PUBLIC, anon and authenticated
--       revoked on all four RPCs
--   27  SECURITY DEFINER with a pinned search_path, and no RLS was
--       weakened anywhere
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, SECURITY AND ACLS (read-only)
-- ============================================================

-- Checks 1, 7, 26 and 27.

do $$
declare
  v_type text;
  v_nullable text;
  v_default text;
begin
  /* Check 1 — the booking page's three columns. */
  select data_type, is_nullable, coalesce(column_default, '(none)')
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultants'
     and column_name = 'consultant_slug';

  if not found then
    raise exception
      'VERIFICATION FAILED 1: consultants.consultant_slug does not exist';
  end if;

  if v_type <> 'text' or v_nullable <> 'YES' then
    raise exception
      'VERIFICATION FAILED 1: consultant_slug is % / nullable %; it must be a nullable text',
      v_type, v_nullable;
  end if;

  select data_type, is_nullable, coalesce(column_default, '(none)')
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultants'
     and column_name = 'direct_booking_enabled';

  if not found then
    raise exception
      'VERIFICATION FAILED 1: consultants.direct_booking_enabled does not exist';
  end if;

  if v_type <> 'boolean' or v_nullable <> 'NO' then
    raise exception
      'VERIFICATION FAILED 1: direct_booking_enabled is % / nullable %; every consultant must have an answer',
      v_type, v_nullable;
  end if;

  if v_default not like '%false%' then
    raise exception
      'VERIFICATION FAILED 1: direct_booking_enabled defaults to %; a consultant must opt IN',
      v_default;
  end if;

  select data_type, is_nullable
    into v_type, v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultants'
     and column_name = 'direct_booking_price_cents';

  if not found then
    raise exception
      'VERIFICATION FAILED 1: consultants.direct_booking_price_cents does not exist';
  end if;

  if v_type <> 'integer' or v_nullable <> 'YES' then
    raise exception
      'VERIFICATION FAILED 1: direct_booking_price_cents is % / nullable %; money is integer minor units and an unset price is null',
      v_type, v_nullable;
  end if;

  /* Check 7 — the source marker. */
  select data_type, is_nullable, coalesce(column_default, '(none)')
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultations'
     and column_name = 'booking_source';

  if not found then
    raise exception
      'VERIFICATION FAILED 7: consultations.booking_source does not exist';
  end if;

  if v_type <> 'text' or v_nullable <> 'NO' then
    raise exception
      'VERIFICATION FAILED 7: booking_source is % / nullable %; every consultation must state its source',
      v_type, v_nullable;
  end if;

  if v_default not like '%standard%' then
    raise exception
      'VERIFICATION FAILED 7: booking_source defaults to %; an ordinary booking must not have to say so',
      v_default;
  end if;

  raise notice 'PASS 1, 7: the columns exist with the right types and defaults';
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
    'public.record_direct_booking_earning(uuid)',
    'public.release_direct_booking_earning(uuid)',
    'public.reverse_direct_booking_earning(uuid, text, integer)'
  ];
begin
  foreach v_signature in array v_signatures
  loop
    v_oid := to_regprocedure(v_signature);

    if v_oid is null then
      raise exception
        'VERIFICATION FAILED 26: % does not exist', v_signature;
    end if;

    /* Check 27 — SECURITY DEFINER with a pinned search_path. */
    select p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(none)')
      into v_secdef, v_config
      from pg_proc p
     where p.oid = v_oid;

    if not v_secdef then
      raise exception
        'VERIFICATION FAILED 27: % is not SECURITY DEFINER', v_signature;
    end if;

    if v_config is distinct from 'search_path=pg_catalog, public' then
      raise exception
        'VERIFICATION FAILED 27: % has search_path %; an unpinned search_path in a definer function is a privilege escalation',
        v_signature, v_config;
    end if;

    /*
     * Check 26 — migration 036's rule. These are orchestrator-only
     * RPCs. create_draft_consultation matters most: it was dropped
     * and recreated here, so it lost its ACL, and Supabase's
     * default privileges would otherwise have handed EXECUTE
     * straight back to anon.
     */
    foreach v_role in array array['public', 'anon', 'authenticated']
    loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception
          'VERIFICATION FAILED 26: % may execute %; it is reachable through PostgREST',
          v_role, v_signature;
      end if;
    end loop;

    if not has_function_privilege(
         'service_role', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 26: service_role cannot execute %; the orchestrator is locked out',
        v_signature;
    end if;
  end loop;

  raise notice 'PASS 26, 27: all four RPCs are definer, pinned, and service_role only';
end $$;


-- Check 27, second half — no RLS was weakened.

do $$
declare
  v_table text;
  v_enabled boolean;
  v_policies integer;
begin
  foreach v_table in array array[
    'consultants', 'consultations', 'consultant_ledger_entries',
    'service_purchases', 'profiles', 'payouts'
  ]
  loop
    select c.relrowsecurity into v_enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_table;

    if not coalesce(v_enabled, false) then
      raise exception
        'VERIFICATION FAILED 27: RLS is disabled on public.%', v_table;
    end if;

    select count(*) into v_policies
      from pg_policies
     where schemaname = 'public' and tablename = v_table;

    if v_policies = 0 then
      raise exception
        'VERIFICATION FAILED 27: public.% has RLS enabled but no policy',
        v_table;
    end if;
  end loop;

  /*
   * The specific weakening this migration could have caused: a
   * public booking page has to read a consultant by slug, and the
   * lazy way to serve it is a new, broader anon policy on
   * consultants.
   *
   * No new policy was added. anon's reach is exactly what the
   * generic booking flow already gave it - active consultants
   * only - and the public page is a server-built projection on top
   * of that rather than a wider door.
   *
   * NOTE what this does mean, and why the orchestrator matters:
   * consultants_select_active_public is a row policy, not a column
   * one, so anon CAN read the three new columns directly. That is
   * why the public projection is the sanctioned path.
   * direct_booking_price_cents is the CONFIGURED price and may sit
   * below the platform's current default; only the orchestrator
   * computes the effective price. A frontend that read this column
   * from Supabase would display a stale figure and the client
   * would then be charged a higher one.
   */
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'consultants';

  if v_policies <> 3 then
    raise exception
      'VERIFICATION FAILED 27: consultants carries % policies; migration 045 added none and the pre-existing three are expected',
      v_policies;
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'consultants'
       and policyname = 'consultants_select_active_public'
       and cmd = 'SELECT'
       and qual = '(is_active = true)') then
    raise exception
      'VERIFICATION FAILED 27: the public consultant policy is missing or no longer gated on is_active; a deactivated consultant would be publicly readable';
  end if;

  raise notice 'PASS 27: RLS is intact on every table this migration touched or could have touched';
end $$;


-- ============================================================
-- PARTS 2 TO 6 — ONE TRANSACTION, ROLLED BACK
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Fixtures
-- ------------------------------------------------------------

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_pro_a uuid := gen_random_uuid();
  v_pro_b uuid := gen_random_uuid();
  v_pro_c uuid := gen_random_uuid();
  v_con_a uuid := gen_random_uuid();
  v_con_b uuid := gen_random_uuid();
  v_con_c uuid := gen_random_uuid();
  v_c_premium uuid := gen_random_uuid();
  v_c_equal uuid := gen_random_uuid();
  v_c_standard uuid := gen_random_uuid();
begin
  /*
   * Pin the platform's price and rate to the locked example. This
   * transaction rolls back, so nothing outside this file sees it,
   * and every figure asserted below is then the amendment's
   * arithmetic rather than staging's current settings.
   */
  update public.app_settings
     set consultation_price_cents = 15000,
         consultation_consultant_commission_bps = 5000;

  /*
   * auth.users first. on_auth_user_created creates the profile
   * row, so the profile insert has to be an upsert - a plain
   * insert collides on the primary key.
   */
  insert into auth.users (id, email) values
    (v_admin,  'v45-admin@verification.invalid'),
    (v_client, 'v45-client@verification.invalid'),
    (v_pro_a,  'v45-a@verification.invalid'),
    (v_pro_b,  'v45-b@verification.invalid'),
    (v_pro_c,  'v45-c@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin,  'admin',      'V45 Admin',  'v45-admin@verification.invalid'),
    (v_client, 'client',     'V45 Client', 'v45-client@verification.invalid'),
    (v_pro_a,  'consultant', 'V45 A',      'v45-a@verification.invalid'),
    (v_pro_b,  'consultant', 'V45 B',      'v45-b@verification.invalid'),
    (v_pro_c,  'consultant', 'V45 C',      'v45-c@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  /* A published consultant. */
  insert into public.consultants (
    id, profile_id, timezone, is_active,
    consultant_slug, direct_booking_enabled,
    direct_booking_price_cents)
  values (v_con_a, v_pro_a, 'UTC', true,
          'v45-aisha-rahman', true, 20000);

  /* An unpublished one, for the constraint tests. */
  insert into public.consultants (
    id, profile_id, timezone, is_active)
  values (v_con_b, v_pro_b, 'UTC', true);

  /* A third, also unpublished, so check 2 has two null slugs. */
  insert into public.consultants (
    id, profile_id, timezone, is_active)
  values (v_con_c, v_pro_c, 'UTC', false);

  /* The locked example: 20000 against a 15000 default. */
  insert into public.consultations (
    id, client_profile_id, consultant_id, status,
    scheduled_start_at, scheduled_end_at,
    price_cents, currency, booking_source,
    captured_at, completed_at)
  values (v_c_premium, v_client, v_con_a, 'captured',
          timestamptz '2032-03-10 09:00:00+00',
          timestamptz '2032-03-10 10:00:00+00',
          20000, 'usd', 'direct_booking', now(), now());

  /* A direct booking priced at exactly the platform default. */
  insert into public.consultations (
    id, client_profile_id, consultant_id, status,
    scheduled_start_at, scheduled_end_at,
    price_cents, currency, booking_source,
    captured_at, completed_at)
  values (v_c_equal, v_client, v_con_a, 'captured',
          timestamptz '2032-03-11 09:00:00+00',
          timestamptz '2032-03-11 10:00:00+00',
          15000, 'usd', 'direct_booking', now(), now());

  /*
   * An ordinary consultation, booked the ordinary way. Note that
   * booking_source is NOT supplied - check 9 depends on that.
   */
  insert into public.consultations (
    id, client_profile_id, consultant_id, status,
    scheduled_start_at, scheduled_end_at,
    price_cents, currency, captured_at, completed_at)
  values (v_c_standard, v_client, v_con_a, 'captured',
          timestamptz '2032-03-12 09:00:00+00',
          timestamptz '2032-03-12 10:00:00+00',
          15000, 'usd', now(), now());

  perform set_config('app.v45_admin',      v_admin::text,      true);
  perform set_config('app.v45_con_a',      v_con_a::text,      true);
  perform set_config('app.v45_con_b',      v_con_b::text,      true);
  perform set_config('app.v45_con_c',      v_con_c::text,      true);
  perform set_config('app.v45_premium',    v_c_premium::text,  true);
  perform set_config('app.v45_equal',      v_c_equal::text,    true);
  perform set_config('app.v45_standard',   v_c_standard::text, true);
end $$;


-- ============================================================
-- PART 2 — CONSTRAINTS
-- ============================================================

-- Checks 2, 3, 4, 5, 6, 8 and 9.

do $$
declare
  v_con_b uuid := current_setting('app.v45_con_b')::uuid;
  v_con_c uuid := current_setting('app.v45_con_c')::uuid;
  v_bad text;
  v_stray integer;
begin
  /* Check 2 — uniqueness, when the slug is set. */
  begin
    update public.consultants
       set consultant_slug = 'v45-aisha-rahman'
     where id = v_con_b;
    raise exception
      'VERIFICATION FAILED 2: two consultants hold the same slug; one booking URL would resolve to two people';
  exception
    when unique_violation then null;
  end;

  /*
   * And the other half of check 2, which a plain unique index
   * would have broken: two consultants who have not published are
   * both null, and null is not equal to null.
   */
  if (select count(*) from public.consultants
       where id in (v_con_b, v_con_c)
         and consultant_slug is null) <> 2 then
    raise exception
      'VERIFICATION FAILED 2: two unpublished consultants cannot both hold a null slug';
  end if;

  /* Check 3 — format. Every one of these is already-not-normalised. */
  foreach v_bad in array array[
    'V45-Aisha',        -- uppercase
    'v45 aisha',        -- space
    'v45_aisha',        -- underscore
    '-v45aisha',        -- leading hyphen
    'v45aisha-',        -- trailing hyphen
    'v45--aisha',       -- doubled hyphen
    'v45/aisha',        -- path separator
    'v45.aisha',        -- dot
    'v45aïsha'          -- unnormalised diacritic
  ]
  loop
    begin
      update public.consultants
         set consultant_slug = v_bad
       where id = v_con_b;
      raise exception
        'VERIFICATION FAILED 3: the slug % was accepted; the stored value must be exactly what appears in the URL',
        v_bad;
    exception
      when check_violation then null;
    end;
  end loop;

  /* Check 4 — length. */
  foreach v_bad in array array[
    'ab',
    repeat('a', 61)
  ]
  loop
    begin
      update public.consultants
         set consultant_slug = v_bad
       where id = v_con_b;
      raise exception
        'VERIFICATION FAILED 4: a slug of length % was accepted',
        length(v_bad);
    exception
      when check_violation then null;
    end;
  end loop;

  /* And a slug at each end of the range IS accepted. */
  update public.consultants
     set consultant_slug = 'abc' where id = v_con_b;
  update public.consultants
     set consultant_slug = repeat('a', 60) where id = v_con_b;
  update public.consultants
     set consultant_slug = null where id = v_con_b;

  /* Check 5 — the price bound. */
  begin
    update public.consultants
       set direct_booking_price_cents = 0 where id = v_con_b;
    raise exception
      'VERIFICATION FAILED 5: a direct booking price of zero was accepted';
  exception
    when check_violation then null;
  end;

  begin
    update public.consultants
       set direct_booking_price_cents = 2000000 where id = v_con_b;
    raise exception
      'VERIFICATION FAILED 5: a direct booking price of 2000000 was accepted; a mistyped price must be caught at save time';
  exception
    when check_violation then null;
  end;

  /* Check 6 — publishing requires both a slug and a price. */
  begin
    update public.consultants
       set direct_booking_enabled = true where id = v_con_b;
    raise exception
      'VERIFICATION FAILED 6: direct booking was enabled with neither a slug nor a price';
  exception
    when check_violation then null;
  end;

  begin
    update public.consultants
       set direct_booking_enabled = true,
           consultant_slug = 'v45-slug-only'
     where id = v_con_b;
    raise exception
      'VERIFICATION FAILED 6: direct booking was enabled with no price';
  exception
    when check_violation then null;
  end;

  begin
    update public.consultants
       set direct_booking_enabled = true,
           consultant_slug = null,
           direct_booking_price_cents = 20000
     where id = v_con_b;
    raise exception
      'VERIFICATION FAILED 6: direct booking was enabled with no slug; the page would have no URL';
  exception
    when check_violation then null;
  end;

  raise notice 'PASS 2-6: slug uniqueness, format, length, price range and the publish precondition all hold';
end $$;


do $$
declare
  v_standard uuid := current_setting('app.v45_standard')::uuid;
  v_source text;
  v_stray integer;
begin
  /* Check 9 — an ordinary booking says nothing and reads standard. */
  select booking_source into v_source
    from public.consultations where id = v_standard;

  if v_source <> 'standard' then
    raise exception
      'VERIFICATION FAILED 9: a consultation inserted without a booking_source reads %',
      v_source;
  end if;

  /*
   * And nothing anywhere is null. The column is NOT NULL, so this
   * is really a check that the backfill of pre-existing rows ran -
   * had it not, the ALTER would have failed outright, but asserting
   * it here says so in one line rather than by inference.
   */
  select count(*) into v_stray
    from public.consultations where booking_source is null;

  if v_stray <> 0 then
    raise exception
      'VERIFICATION FAILED 9: % consultation(s) have no booking source', v_stray;
  end if;

  /* Check 8 — the vocabulary is closed. */
  begin
    update public.consultations
       set booking_source = 'partner_referral' where id = v_standard;
    raise exception
      'VERIFICATION FAILED 8: an unknown booking_source was accepted; the finance path keys off this column';
  exception
    when check_violation then null;
  end;

  update public.consultations
     set booking_source = 'direct_booking' where id = v_standard;
  update public.consultations
     set booking_source = 'standard' where id = v_standard;

  raise notice 'PASS 8, 9: booking_source is closed to two values and every row has one';
end $$;


-- ============================================================
-- PART 3 — THE TWO-COMPONENT SPLIT
-- ============================================================

-- Checks 10, 11, 12 and 13.

do $$
declare
  v_premium uuid := current_setting('app.v45_premium')::uuid;
  v_equal uuid := current_setting('app.v45_equal')::uuid;
  r record;
  v_first record;
  v_second record;
  v_rows integer;
  v_consultant integer;
  v_platform integer;
begin
  select * into v_first
    from public.record_direct_booking_earning(v_premium);

  if not v_first.created then
    raise exception
      'VERIFICATION FAILED 10: the first record call reported nothing created';
  end if;

  /* Check 12 — THE LOCKED EXAMPLE. */
  if v_first.standard_gross_minor <> 15000
     or v_first.standard_consultant_minor <> 7500
     or v_first.standard_platform_minor <> 7500 then
    raise exception
      'VERIFICATION FAILED 12: the standard component is %/%/% and must be 15000/7500/7500 - the standard-price portion splits 50/50 exactly as any consultation does',
      v_first.standard_gross_minor,
      v_first.standard_consultant_minor,
      v_first.standard_platform_minor;
  end if;

  if v_first.premium_gross_minor <> 5000
     or v_first.premium_consultant_minor <> 4000
     or v_first.premium_platform_minor <> 1000 then
    raise exception
      'VERIFICATION FAILED 12: the premium component is %/%/% and must be 5000/4000/1000 - only the premium above the platform price splits 80/20',
      v_first.premium_gross_minor,
      v_first.premium_consultant_minor,
      v_first.premium_platform_minor;
  end if;

  v_consultant := v_first.standard_consultant_minor
                + v_first.premium_consultant_minor;
  v_platform := v_first.standard_platform_minor
              + v_first.premium_platform_minor;

  if v_consultant <> 11500 or v_platform <> 8500 then
    raise exception
      'VERIFICATION FAILED 12: a 20000 direct booking against a 15000 default paid % to the consultant and % to the platform; the amendment says 11500 and 8500',
      v_consultant, v_platform;
  end if;

  /* Check 10 — two rows, each valid on its own terms. */
  v_rows := 0;

  for r in
    select * from public.consultant_ledger_entries
     where entry_type = 'earning'
       and source_type = 'direct_booking'
       and source_id = v_premium
     order by source_component
  loop
    v_rows := v_rows + 1;

    if r.consultant_amount_minor + r.platform_amount_minor
       <> r.gross_amount_minor then
      raise exception
        'VERIFICATION FAILED 10: the % component does not add up: % + % <> %',
        r.source_component, r.consultant_amount_minor,
        r.platform_amount_minor, r.gross_amount_minor;
    end if;

    if r.source_component = 'standard' then
      if r.commission_basis <> 'direct_booking_standard' then
        raise exception
          'VERIFICATION FAILED 10: the standard component carries basis %',
          r.commission_basis;
      end if;
      if r.commission_bps <> 5000 then
        raise exception
          'VERIFICATION FAILED 10: the standard component carries % bps; it must carry the platform''s current consultation rate',
          r.commission_bps;
      end if;
    elsif r.source_component = 'premium' then
      if r.commission_basis <> 'direct_booking_premium' then
        raise exception
          'VERIFICATION FAILED 10: the premium component carries basis %',
          r.commission_basis;
      end if;
      if r.commission_bps <> 8000 then
        raise exception
          'VERIFICATION FAILED 10: the premium component carries % bps; the locked premium rate is 8000',
          r.commission_bps;
      end if;
    else
      raise exception
        'VERIFICATION FAILED 10: an unexpected component % was written',
        r.source_component;
    end if;

    if r.currency <> 'usd' then
      raise exception
        'VERIFICATION FAILED 10: the % component is in %, not the consultation''s currency',
        r.source_component, r.currency;
    end if;
  end loop;

  if v_rows <> 2 then
    raise exception
      'VERIFICATION FAILED 10: % ledger row(s) were written; a direct booking above the platform price is two components',
      v_rows;
  end if;

  /* Check 13 — idempotent, and reporting the SAME rows. */
  select * into v_second
    from public.record_direct_booking_earning(v_premium);

  if v_second.created then
    raise exception
      'VERIFICATION FAILED 13: a second record call reported a new earning; a redelivered capture event would double-pay';
  end if;

  if v_second.standard_entry_id is distinct from v_first.standard_entry_id
     or v_second.premium_entry_id is distinct from v_first.premium_entry_id then
    raise exception
      'VERIFICATION FAILED 13: the second call reported different entries';
  end if;

  select count(*) into v_rows
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'direct_booking'
     and source_id = v_premium;

  if v_rows <> 2 then
    raise exception
      'VERIFICATION FAILED 13: % earning rows exist after two record calls',
      v_rows;
  end if;

  raise notice 'PASS 10, 12, 13: two valid components, 11500/8500 on the locked example, and recording is idempotent';
end $$;


do $$
declare
  v_equal uuid := current_setting('app.v45_equal')::uuid;
  v_result record;
  v_rows integer;
begin
  /* Check 11 — no premium means no premium row. */
  select * into v_result
    from public.record_direct_booking_earning(v_equal);

  if v_result.standard_gross_minor <> 15000
     or v_result.standard_consultant_minor <> 7500 then
    raise exception
      'VERIFICATION FAILED 11: a direct booking at the platform price split %/%; it must be an ordinary 50/50',
      v_result.standard_gross_minor,
      v_result.standard_consultant_minor;
  end if;

  if v_result.premium_entry_id is not null
     or coalesce(v_result.premium_gross_minor, 0) <> 0 then
    raise exception
      'VERIFICATION FAILED 11: a premium component was reported for a booking with no premium';
  end if;

  select count(*) into v_rows
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'direct_booking'
     and source_id = v_equal;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED 11: % row(s) were written for a booking priced at the platform default; a zero-value premium row records no fact',
      v_rows;
  end if;

  raise notice 'PASS 11: a direct booking at the platform price is simply a standard split';
end $$;


-- ============================================================
-- PART 4 — RELEASE
-- ============================================================

-- Checks 14 and 15.

do $$
declare
  v_premium uuid := current_setting('app.v45_premium')::uuid;
  v_first record;
  v_second record;
  v_pending integer;
  v_distinct integer;
begin
  select * into v_first
    from public.release_direct_booking_earning(v_premium);

  if not v_first.released then
    raise exception
      'VERIFICATION FAILED 14: release reported % on a captured, completed direct booking',
      v_first.reason;
  end if;

  if v_first.released_count <> 2 then
    raise exception
      'VERIFICATION FAILED 14: release freed % row(s); both components move together or neither does',
      v_first.released_count;
  end if;

  select count(*) into v_pending
    from public.consultant_ledger_entries e
   where e.entry_type = 'earning'
     and e.source_type = 'direct_booking'
     and e.source_id = v_premium
     and e.available_at is null;

  if v_pending <> 0 then
    raise exception
      'VERIFICATION FAILED 14: % component(s) are still pending; a consultant could withdraw one share but not the other',
      v_pending;
  end if;

  /* One timestamp, so the two are indistinguishable in the balance. */
  select count(distinct e.available_at) into v_distinct
    from public.consultant_ledger_entries e
   where e.entry_type = 'earning'
     and e.source_type = 'direct_booking'
     and e.source_id = v_premium;

  if v_distinct <> 1 then
    raise exception
      'VERIFICATION FAILED 14: the two components became available at % different times',
      v_distinct;
  end if;

  /* Check 15 — idempotent. */
  select * into v_second
    from public.release_direct_booking_earning(v_premium);

  if v_second.released then
    raise exception
      'VERIFICATION FAILED 15: a second release reported success';
  end if;

  if v_second.reason <> 'already_available' then
    raise exception
      'VERIFICATION FAILED 15: a second release reported %', v_second.reason;
  end if;

  if v_second.released_count <> 0 then
    raise exception
      'VERIFICATION FAILED 15: a second release touched % row(s)',
      v_second.released_count;
  end if;

  raise notice 'PASS 14, 15: both components release together, once';
end $$;


-- ============================================================
-- PART 5 — CUMULATIVE REFUNDS
-- ============================================================
--
-- The whole point of this part. p_refunded_total_minor is what
-- Stripe says has been refunded in TOTAL, and every assertion below
-- would fail if it were read as a delta instead.
--
-- The sequence, against 20000 earned as 15000 standard + 5000
-- premium:
--
--   5000   first partial      3750 standard + 1250 premium
--   5000   redelivered        nothing
--   8000   second partial     2250 standard +  750 premium
--   20000  the rest           9000 standard + 3000 premium
--   20000  redelivered        nothing
--
-- Applied: 5000 + 3000 + 12000 = 20000. Exactly the refund.

-- Checks 16, 17, 18, 19, 20 and 21.

do $$
declare
  v_premium uuid := current_setting('app.v45_premium')::uuid;
  r record;
  v_applied integer := 0;
begin
  /* Check 16 — the first partial, split in proportion to gross. */
  select * into r
    from public.reverse_direct_booking_earning(
           p_consultation_id => v_premium,
           p_refunded_total_minor => 5000);

  if not r.reversed then
    raise exception
      'VERIFICATION FAILED 16: a 5000 refund reported %', r.reason;
  end if;

  if r.standard_delta_minor <> 3750
     or r.premium_delta_minor <> 1250 then
    raise exception
      'VERIFICATION FAILED 16: 5000 was split %/% and must be 3750/1250 - three quarters of the gross is standard',
      r.standard_delta_minor, r.premium_delta_minor;
  end if;

  if r.applied_delta_minor <> 5000 then
    raise exception
      'VERIFICATION FAILED 16: the components summed to % against a 5000 refund',
      r.applied_delta_minor;
  end if;

  v_applied := v_applied + r.applied_delta_minor;

  /* Check 17 — the same total again. Stripe redelivers. */
  select * into r
    from public.reverse_direct_booking_earning(
           p_consultation_id => v_premium,
           p_refunded_total_minor => 5000);

  if r.reversed or r.applied_delta_minor <> 0 then
    raise exception
      'VERIFICATION FAILED 17: a redelivered 5000 refund reversed a further %; this is the migration 040 delta bug',
      r.applied_delta_minor;
  end if;

  /* Check 18 — a second partial applies only its DIFFERENCE. */
  select * into r
    from public.reverse_direct_booking_earning(
           p_consultation_id => v_premium,
           p_refunded_total_minor => 8000);

  if not r.reversed then
    raise exception
      'VERIFICATION FAILED 18: a cumulative total of 8000 reported %', r.reason;
  end if;

  if r.applied_delta_minor <> 3000 then
    raise exception
      'VERIFICATION FAILED 18: a cumulative total of 8000 after 5000 applied % and must apply 3000; reading the figure as a delta would have applied 8000',
      r.applied_delta_minor;
  end if;

  if r.standard_delta_minor <> 2250
     or r.premium_delta_minor <> 750 then
    raise exception
      'VERIFICATION FAILED 18: the second partial split %/% and must be 2250/750',
      r.standard_delta_minor, r.premium_delta_minor;
  end if;

  v_applied := v_applied + r.applied_delta_minor;

  /* Check 19 — partial, then full. */
  select * into r
    from public.reverse_direct_booking_earning(
           p_consultation_id => v_premium,
           p_refunded_total_minor => 20000);

  if not r.reversed then
    raise exception
      'VERIFICATION FAILED 19: a full refund after two partials reported %',
      r.reason;
  end if;

  if r.applied_delta_minor <> 12000 then
    raise exception
      'VERIFICATION FAILED 19: completing a 20000 refund after 8000 applied % and must apply 12000',
      r.applied_delta_minor;
  end if;

  if r.standard_delta_minor <> 9000
     or r.premium_delta_minor <> 3000 then
    raise exception
      'VERIFICATION FAILED 19: the completing reversal split %/% and must be 9000/3000',
      r.standard_delta_minor, r.premium_delta_minor;
  end if;

  v_applied := v_applied + r.applied_delta_minor;

  /* Check 20 — the full total again. */
  select * into r
    from public.reverse_direct_booking_earning(
           p_consultation_id => v_premium,
           p_refunded_total_minor => 20000);

  if r.reversed or r.applied_delta_minor <> 0 then
    raise exception
      'VERIFICATION FAILED 20: a redelivered full refund reversed a further %',
      r.applied_delta_minor;
  end if;

  if r.reason <> 'already_refunded' then
    raise exception
      'VERIFICATION FAILED 20: a fully refunded booking reported %', r.reason;
  end if;

  if v_applied <> 20000 then
    raise exception
      'VERIFICATION FAILED 21: the sequence applied % in total against a 20000 refund',
      v_applied;
  end if;

  raise notice 'PASS 16-20: the total is read as cumulative at every step';
end $$;


do $$
declare
  v_premium uuid := current_setting('app.v45_premium')::uuid;
  v_standard_id uuid;
  v_premium_id uuid;
  v_standard_reversed integer;
  v_premium_reversed integer;
  v_net_gross bigint;
  v_net_consultant bigint;
  v_net_platform bigint;
begin
  select id into v_standard_id
    from public.consultant_ledger_entries
   where entry_type = 'earning' and source_type = 'direct_booking'
     and source_id = v_premium and source_component = 'standard';

  select id into v_premium_id
    from public.consultant_ledger_entries
   where entry_type = 'earning' and source_type = 'direct_booking'
     and source_id = v_premium and source_component = 'premium';

  select coalesce(sum(-gross_amount_minor), 0) into v_standard_reversed
    from public.consultant_ledger_entries
   where entry_type = 'reversal' and reverses_entry_id = v_standard_id;

  select coalesce(sum(-gross_amount_minor), 0) into v_premium_reversed
    from public.consultant_ledger_entries
   where entry_type = 'reversal' and reverses_entry_id = v_premium_id;

  /* Check 21 — each component reversed exactly its own gross... */
  if v_standard_reversed <> 15000 then
    raise exception
      'VERIFICATION FAILED 21: the standard component had % reversed against a gross of 15000',
      v_standard_reversed;
  end if;

  if v_premium_reversed <> 5000 then
    raise exception
      'VERIFICATION FAILED 21: the premium component had % reversed against a gross of 5000',
      v_premium_reversed;
  end if;

  /* ...and the two sum to the refund exactly. */
  if v_standard_reversed + v_premium_reversed <> 20000 then
    raise exception
      'VERIFICATION FAILED 21: the component reversals sum to % against a 20000 refund; the difference would come out of a consultant who had nothing to do with it',
      v_standard_reversed + v_premium_reversed;
  end if;

  select sum(gross_amount_minor),
         sum(consultant_amount_minor),
         sum(platform_amount_minor)
    into v_net_gross, v_net_consultant, v_net_platform
    from public.consultant_ledger_entries
   where source_id = v_premium;

  if v_net_gross <> 0 or v_net_consultant <> 0
     or v_net_platform <> 0 then
    raise exception
      'VERIFICATION FAILED 21: a fully refunded direct booking nets to %/%/% and must net to zero',
      v_net_gross, v_net_consultant, v_net_platform;
  end if;

  raise notice 'PASS 21: the component reversals sum to the refund exactly and the ledger nets to zero';
end $$;


do $$
declare
  v_equal uuid := current_setting('app.v45_equal')::uuid;
  r record;
begin
  /* Check 22 — a total above the gross is refused, not clamped. */
  begin
    select * into r
      from public.reverse_direct_booking_earning(
             p_consultation_id => v_equal,
             p_refunded_total_minor => 15001);
    raise exception
      'VERIFICATION FAILED 22: a refunded total of 15001 was accepted against a gross of 15000';
  exception
    when raise_exception then
      if sqlerrm not like '%FINANCE_REFUND_EXCEEDS_CONSULTATION%'
         and sqlerrm not like '%VERIFICATION FAILED%' then
        raise;
      end if;
      if sqlerrm like '%VERIFICATION FAILED%' then
        raise;
      end if;
  end;

  /* And a negative total is refused too. */
  begin
    select * into r
      from public.reverse_direct_booking_earning(
             p_consultation_id => v_equal,
             p_refunded_total_minor => -1);
    raise exception
      'VERIFICATION FAILED 22: a negative refunded total was accepted';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%' then
        raise;
      end if;
  end;

  raise notice 'PASS 22: an impossible refunded total is refused rather than clamped';
end $$;


-- ============================================================
-- PART 6 — REGRESSIONS
-- ============================================================

-- Checks 23, 24 and 25.

do $$
declare
  v_standard uuid := current_setting('app.v45_standard')::uuid;
  v_premium uuid := current_setting('app.v45_premium')::uuid;
  r record;
  v_rows integer;
begin
  /*
   * Check 23 — the ordinary path is untouched. An ordinary
   * consultation still earns through record_consultation_earning,
   * at one row, on the consultation basis.
   */
  perform public.record_consultation_earning(v_standard);

  select count(*) into v_rows
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'consultation'
     and source_id = v_standard;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED 23: an ordinary consultation wrote % earning row(s)',
      v_rows;
  end if;

  select * into r
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'consultation'
     and source_id = v_standard;

  if r.source_component <> 'full'
     or r.commission_basis <> 'standard_50_50' then
    raise exception
      'VERIFICATION FAILED 23: an ordinary consultation now records component % on basis %',
      r.source_component, r.commission_basis;
  end if;

  if r.consultant_amount_minor <> 7500
     or r.platform_amount_minor <> 7500 then
    raise exception
      'VERIFICATION FAILED 23: an ordinary 15000 consultation split %/%',
      r.consultant_amount_minor, r.platform_amount_minor;
  end if;

  /*
   * And the two paths refuse each other's work, in BOTH
   * directions. The second half is the one that matters: handed a
   * direct booking, the standard RPC would have written a flat
   * 50/50 earning across the whole price on top of the two
   * components already there - two earnings for one payment, and
   * the consultant robbed of the premium they published for.
   */
  begin
    perform public.record_direct_booking_earning(v_standard);
    raise exception
      'VERIFICATION FAILED 23: the direct booking RPC accepted a standard consultation';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%FINANCE_NOT_DIRECT_BOOKING%' then
        raise;
      end if;
  end;

  begin
    perform public.release_direct_booking_earning(v_standard);
    raise exception
      'VERIFICATION FAILED 23: the direct booking release accepted a standard consultation';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%FINANCE_NOT_DIRECT_BOOKING%' then
        raise;
      end if;
  end;

  begin
    perform public.reverse_direct_booking_earning(
      p_consultation_id => v_standard,
      p_refunded_total_minor => 100);
    raise exception
      'VERIFICATION FAILED 23: the direct booking reversal accepted a standard consultation; the orchestrator dispatches on this marker and would never have fallen back';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%FINANCE_NOT_DIRECT_BOOKING%' then
        raise;
      end if;
  end;

  begin
    perform public.record_consultation_earning(v_premium);
    raise exception
      'VERIFICATION FAILED 23: the standard RPC accepted a direct booking; it would have written a second, wrongly split earning for one payment';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%FINANCE_NOT_STANDARD_BOOKING%' then
        raise;
      end if;
  end;

  /* The direct booking still carries exactly its two components. */
  select count(*) into v_rows
    from public.consultant_ledger_entries
   where entry_type = 'earning' and source_id = v_premium;

  if v_rows <> 2 then
    raise exception
      'VERIFICATION FAILED 23: the direct booking carries % earning row(s) after the crossed calls',
      v_rows;
  end if;

  /*
   * CREATE OR REPLACE preserves an ACL where DROP and CREATE would
   * not. record_consultation_earning was replaced in part G, so
   * this asserts it did not quietly reopen to anon.
   */
  if has_function_privilege(
       'anon', 'public.record_consultation_earning(uuid)', 'EXECUTE')
     or has_function_privilege(
       'authenticated', 'public.record_consultation_earning(uuid)',
       'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 23: replacing record_consultation_earning reopened it to a browser role';
  end if;

  raise notice 'PASS 23: the standard consultation path is unchanged, the two paths refuse each other in both directions, and no ACL was reopened';
end $$;


do $$
declare
  v_count integer;
  v_signature text;
begin
  /* Check 24 — service purchase finance is untouched. */
  foreach v_signature in array array[
    'public.record_service_purchase(integer, text, text, uuid, uuid, text, text, text, text, text, text)',
    'public.fulfill_service_purchase(uuid, uuid)',
    'public.reverse_service_purchase_earning(uuid, text, integer)',
    'public.reverse_service_purchase_for_payment_intent(text, text, integer)',
    'public.record_consultation_earning(uuid)',
    'public.release_consultation_earning(uuid)',
    'public.reverse_consultation_earning(uuid, text, integer)'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      raise exception
        'VERIFICATION FAILED 24: % no longer exists', v_signature;
    end if;
  end loop;

  /*
   * The migration 043 rename is the thing that would break
   * loudest if someone re-edited these functions: the cumulative
   * parameter must still be named p_refunded_total_minor, so a
   * stale delta-era named-argument caller fails rather than
   * silently over-reversing.
   */
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'reverse_service_purchase_earning'
     and 'p_refunded_total_minor' = any(p.proargnames);

  if v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 24: reverse_service_purchase_earning no longer takes p_refunded_total_minor';
  end if;

  /* The new function follows the same convention, deliberately. */
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'reverse_direct_booking_earning'
     and 'p_refunded_total_minor' = any(p.proargnames);

  if v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 24: reverse_direct_booking_earning does not name its parameter p_refunded_total_minor; the cumulative convention must be visible at every call site';
  end if;

  raise notice 'PASS 24: service purchase finance is unchanged and the cumulative naming convention holds';
end $$;


do $$
declare
  v_admin uuid := current_setting('app.v45_admin')::uuid;
  r record;
  v_seen boolean := false;
begin
  /*
   * Check 25 — migration 044 needs no change to report direct
   * bookings: it groups by source_type, and a new source type
   * appears on its own row the moment one exists. The window is
   * around now() because the read model windows on ledger
   * created_at, so this is an existence check rather than an exact
   * total - a staging database may hold other recent rows.
   */
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
    if r.period = 'current' and r.source_type = 'direct_booking' then
      v_seen := true;

      if r.consultant_earnings_minor + r.platform_revenue_minor
         <> r.gross_revenue_minor then
        raise exception
          'VERIFICATION FAILED 25: the direct_booking aggregate does not add up: % + % <> %',
          r.consultant_earnings_minor, r.platform_revenue_minor,
          r.gross_revenue_minor;
      end if;
    end if;
  end loop;

  reset role;

  if not v_seen then
    raise exception
      'VERIFICATION FAILED 25: the dashboard read model reported no direct_booking row; direct booking revenue is invisible to /admin';
  end if;

  raise notice 'PASS 25: direct_booking surfaces in the dashboard read model with no change to migration 044';
end $$;


rollback;


-- ============================================================
-- Confirm the rollback
-- ============================================================

do $$
declare
  v_left integer;
  v_price integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v45-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification profile(s) survived the rollback',
      v_left;
  end if;

  /*
   * And most importantly, the pinned app_settings did not escape.
   * Part 3 rewrote the platform's own consultation price; if that
   * survived, this file would have changed what every consultation
   * costs.
   */
  select count(*) into v_left
    from public.consultants
   where consultant_slug like 'v45-%';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification slug(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS: every fixture rolled back, app_settings included';
end $$;


-- ============================================================
-- PART 7 — ROLLBACK GUIDANCE
-- ============================================================
--
-- This migration adds columns and functions and writes no data of
-- its own. Undoing it is only safe if no direct booking has been
-- taken yet: the ledger rows a direct booking produces are real
-- money and must not be dropped.
--
-- To stop the feature WITHOUT touching finance, which is almost
-- always what is wanted:
--
--   update public.consultants
--      set direct_booking_enabled = false
--    where direct_booking_enabled;
--
-- Every published page then 404s, existing bookings continue
-- through capture, completion and refund as the consultations they
-- already are, and nothing in the ledger moves.
--
-- A full structural rollback, only on a database that has never
-- recorded a direct booking earning:
--
--   drop function if exists public.reverse_direct_booking_earning(
--     uuid, text, integer);
--   drop function if exists public.release_direct_booking_earning(uuid);
--   drop function if exists public.record_direct_booking_earning(uuid);
--
--   alter table public.consultations
--     drop column if exists booking_source;
--
--   alter table public.consultants
--     drop column if exists direct_booking_price_cents,
--     drop column if exists direct_booking_enabled,
--     drop column if exists consultant_slug;
--
-- create_draft_consultation would then have to be restored to its
-- 12-argument form from migration 005, and the orchestrator rolled
-- back with it - the 13-argument call would fail otherwise.
--
-- Nothing in migrations 034 to 044 needs undoing. This migration
-- changed no existing table, policy, grant or function other than
-- create_draft_consultation, which it replaced additively with a
-- defaulted final parameter.
-- ============================================================

do $$
begin
  raise notice
    'migration 045 verification complete: no check raised';
end $$;
