-- ============================================================
-- Verification for migration_042_service_post_purchase_instructions
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  the column and its bound          read-only
--   Part 2  the column is private             read-only
--   Part 3  the admin view                    STAGING ONLY, rolls back
--   Part 4  regressions                       read-only
--   Part 5  rollback guidance
--
-- Part 3 creates its fixtures and ends in ROLLBACK.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  services.post_purchase_instructions_html exists, is text
--       and is nullable
--    2  the 20,000-character bound is enforced, and null and a
--       normal value are both accepted
--    3  anon cannot select the column from public.services
--    4  authenticated cannot select the column from
--       public.services
--    5  consultant_commission_bps is STILL private — the column
--       migration 034 protected did not become collateral damage
--    6  admin_services exposes BOTH private columns, appended in
--       order, with the original seventeen unmoved
--    7  an admin reads instructions there, for an active and an
--       inactive service alike
--    8  a client reads zero rows from admin_services and cannot
--       select the column from services
--    9  a consultant reads zero rows and cannot select the column
--   10  anon is refused the view at the privilege layer
--   11  authenticated holds SELECT on admin_services and nothing
--       else
--   12  no INSERT, UPDATE or DELETE is possible through the view,
--       which is auto-updatable and would otherwise be a write
--       path into services
--   13  migrations 034, 038, 039, 040 and 041 are intact
-- ============================================================


-- ============================================================
-- PART 1 — THE COLUMN AND ITS BOUND (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_type text;
  v_nullable text;
begin
  select data_type, is_nullable
    into v_type, v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'services'
     and column_name = 'post_purchase_instructions_html';

  if v_type is distinct from 'text' then
    raise exception
      'VERIFICATION FAILED 1: post_purchase_instructions_html is [%], expected text',
      coalesce(v_type, '(absent)');
  end if;

  if v_nullable is distinct from 'YES' then
    raise exception
      'VERIFICATION FAILED 1: the column is NOT NULL; a service with no instructions must be representable';
  end if;

  raise notice
    'PASS 1: services.post_purchase_instructions_html exists, text, nullable';
end $$;


-- Check 2.
--
-- Exercised rather than inspected: the constraint is asserted by
-- trying to break it, inside a transaction that rolls back.

begin;

do $$
declare
  v_id uuid;
  v_rejected boolean := false;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.services'::regclass
       and conname = 'services_post_purchase_instructions_length_check'
  ) then
    raise exception
      'VERIFICATION FAILED 2: services_post_purchase_instructions_length_check is missing';
  end if;

  insert into public.services (name, is_active)
  values ('V42 Bound Probe', false)
  returning id into v_id;

  /* Null is the resting state and must be accepted. */
  update public.services
     set post_purchase_instructions_html = null
   where id = v_id;

  /* A realistic value is accepted. */
  update public.services
     set post_purchase_instructions_html =
           '<p>Book your onboarding call.</p>'
   where id = v_id;

  /* Exactly at the bound is accepted. */
  update public.services
     set post_purchase_instructions_html = repeat('x', 20000)
   where id = v_id;

  /* One character over is not. */
  begin
    update public.services
       set post_purchase_instructions_html = repeat('x', 20001)
     where id = v_id;
    raise exception
      'VERIFICATION FAILED 2: a 20001-character value was accepted';
  exception when check_violation then
    v_rejected := true;
  end;

  if not v_rejected then
    raise exception
      'VERIFICATION FAILED 2: the length bound is not enforced';
  end if;

  raise notice
    'PASS 2: null, a normal value and exactly 20000 characters are accepted; 20001 is refused';
end $$;

rollback;


-- ============================================================
-- PART 2 — THE COLUMN IS PRIVATE (read-only)
-- ============================================================

-- Checks 3, 4 and 5.
--
-- The whole privacy claim rests on migration 034 part E's column
-- list failing closed when a column is added. That is a claim
-- about behaviour nobody wrote code for, so it is checked
-- directly rather than reasoned about.

do $$
declare
  v_role text;
  v_private text;
  v_private_columns text[] := array[
    'consultant_commission_bps',
    'post_purchase_instructions_html'
  ];
begin
  foreach v_role in array array['anon', 'authenticated']
  loop
    if has_table_privilege(v_role, 'public.services', 'SELECT') then
      raise exception
        'VERIFICATION FAILED 3/4: % holds a TABLE-level SELECT on services, which overrides every column-level revoke',
        v_role;
    end if;

    foreach v_private in array v_private_columns
    loop
      if has_column_privilege(
           v_role, 'public.services', v_private, 'SELECT') then
        raise exception
          'VERIFICATION FAILED 3/4/5: % can select services.%',
          v_role, v_private;
      end if;
    end loop;
  end loop;

  raise notice
    'PASS 3, 4 and 5: neither anon nor authenticated can select either private column from public.services';
end $$;


-- Check 6.

do $$
declare
  v_columns text;
  v_expected text :=
    'id, name, description, price_display, is_active, sort_order, '
    'created_at, updated_at, billing_type, recurring_interval, '
    'price_cents, currency, stripe_product_id, stripe_price_id, '
    'stripe_payment_link_id, stripe_payment_link_url, '
    'consultant_commission_bps, post_purchase_instructions_html';
begin
  select string_agg(a.attname, ', ' order by a.attnum)
    into v_columns
    from pg_attribute a
   where a.attrelid = 'public.admin_services'::regclass
     and a.attnum > 0
     and not a.attisdropped;

  if v_columns is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 6: admin_services columns are [%], expected [%]',
      coalesce(v_columns, '(none)'), v_expected;
  end if;

  raise notice
    'PASS 6: admin_services exposes both private columns, appended after the original seventeen';
end $$;


-- Check 11.

do $$
declare
  v_role text;
begin
  if not has_table_privilege(
       'authenticated', 'public.admin_services', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 11: authenticated cannot select admin_services';
  end if;

  foreach v_role in array array['anon', 'service_role']
  loop
    if has_table_privilege(
         v_role, 'public.admin_services', 'SELECT') then
      raise exception
        'VERIFICATION FAILED 11: % can select admin_services', v_role;
    end if;
  end loop;

  if exists (
    select 1 from pg_class c
    cross join lateral aclexplode(c.relacl) a
   where c.oid = 'public.admin_services'::regclass
     and a.grantee = 0
  ) then
    raise exception
      'VERIFICATION FAILED 11: PUBLIC holds a privilege on admin_services';
  end if;

  /*
   * Check 12, at the privilege layer. This view is a simple view
   * over one table and is therefore AUTO-UPDATABLE: with
   * Supabase's default GRANT ALL it would be a write path into
   * public.services that bypasses the admin endpoints entirely.
   */
  foreach v_role in array array['authenticated', 'anon']
  loop
    if has_table_privilege(
         v_role, 'public.admin_services', 'INSERT')
       or has_table_privilege(
         v_role, 'public.admin_services', 'UPDATE')
       or has_table_privilege(
         v_role, 'public.admin_services', 'DELETE') then
      raise exception
        'VERIFICATION FAILED 12: % holds a write privilege on admin_services',
        v_role;
    end if;
  end loop;

  raise notice
    'PASS 11 and 12: authenticated may SELECT admin_services and nothing else; anon, PUBLIC and service_role hold nothing';
end $$;


-- ============================================================
-- PART 3 — THE ADMIN VIEW IN USE (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_cpr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_active uuid;
  v_inactive uuid;
begin
  insert into auth.users (id, email) values
    (v_admin, 'v42-admin@verification.invalid'),
    (v_cpr, 'v42-consultant@verification.invalid'),
    (v_clp, 'v42-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin, 'admin', 'V42 Admin',
     'v42-admin@verification.invalid'),
    (v_cpr, 'consultant', 'V42 Consultant',
     'v42-consultant@verification.invalid'),
    (v_clp, 'client', 'V42 Client',
     'v42-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true);

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, post_purchase_instructions_html,
    is_active)
  values ('V42 Active Service', 'one_time', 12000, 'usd', 4500,
          '<p>Welcome. <a href="https://example.test" rel="noopener noreferrer nofollow" target="_blank">Book here</a>.</p>',
          true)
  returning id into v_active;

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, post_purchase_instructions_html,
    is_active)
  values ('V42 Retired Service', 'one_time', 9000, 'usd', 3000,
          '<p>Legacy delivery notes.</p>', false)
  returning id into v_inactive;

  perform set_config('app.v42_admin', v_admin::text, true);
  perform set_config('app.v42_consultant', v_cpr::text, true);
  perform set_config('app.v42_client', v_clp::text, true);
  perform set_config('app.v42_active', v_active::text, true);
  perform set_config('app.v42_inactive', v_inactive::text, true);
end $$;


-- Check 7 — the administrator.

do $$
declare
  v_html text;
  v_inactive_html text;
  v_bps integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v42_admin'), true);

  begin
    select post_purchase_instructions_html,
           consultant_commission_bps
      into v_html, v_bps
      from public.admin_services
     where id = current_setting('app.v42_active')::uuid;
  exception when insufficient_privilege then
    reset role;
    raise exception
      'VERIFICATION FAILED 7: the admin read raised insufficient_privilege';
  end;

  select post_purchase_instructions_html
    into v_inactive_html
    from public.admin_services
   where id = current_setting('app.v42_inactive')::uuid;

  reset role;

  if v_html is null or v_html not like '%Book here%' then
    raise exception
      'VERIFICATION FAILED 7: the admin read instructions as [%]',
      coalesce(v_html, '(null)');
  end if;

  if v_bps is distinct from 4500 then
    raise exception
      'VERIFICATION FAILED 7: the admin read the commission as [%]',
      coalesce(v_bps::text, '(null)');
  end if;

  if v_inactive_html is null then
    raise exception
      'VERIFICATION FAILED 7: the admin cannot read instructions for an inactive service, which a catalog manager needs';
  end if;

  raise notice
    'PASS 7: an admin reads instructions and the commission, for an active and an inactive service alike';
end $$;


-- Checks 8, 9 and 10 — everybody else.

do $$
declare
  v_who text;
  v_rows integer;
  v_denied integer := 0;
  v_anon_denied boolean := false;
begin
  foreach v_who in array array['app.v42_client', 'app.v42_consultant']
  loop
    set local role authenticated;
    perform set_config('request.jwt.claim.sub',
      current_setting(v_who), true);

    select count(*) into v_rows from public.admin_services;

    if v_rows <> 0 then
      reset role;
      raise exception
        'VERIFICATION FAILED 8/9: % sees % row(s) in admin_services',
        v_who, v_rows;
    end if;

    begin
      perform s.post_purchase_instructions_html
        from public.services s
       where s.id = current_setting('app.v42_active')::uuid;

      reset role;
      raise exception
        'VERIFICATION FAILED 8/9: % selected post_purchase_instructions_html from services',
        v_who;
    exception when insufficient_privilege then
      v_denied := v_denied + 1;
    end;

    reset role;
  end loop;

  if v_denied <> 2 then
    raise exception
      'VERIFICATION FAILED 8/9: only % of 2 non-admins were refused the column',
      v_denied;
  end if;

  set local role anon;

  begin
    perform 1 from public.admin_services;
  exception when insufficient_privilege then
    v_anon_denied := true;
  end;

  reset role;

  if not v_anon_denied then
    raise exception
      'VERIFICATION FAILED 10: anon could read admin_services';
  end if;

  raise notice
    'PASS 8, 9 and 10: a client and a consultant each read zero rows and are refused the column; anon is refused the view outright';
end $$;


-- Check 12, exercised.
--
-- The privilege check above says an admin holds no write. This
-- proves it by trying, because the failure mode being guarded
-- against — an auto-updatable view quietly becoming a write path
-- into the catalog — is one nobody would notice from a grant
-- matrix alone.

do $$
declare
  v_refused integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v42_admin'), true);

  begin
    update public.admin_services
       set post_purchase_instructions_html = '<p>injected</p>'
     where id = current_setting('app.v42_active')::uuid;
    reset role;
    raise exception
      'VERIFICATION FAILED 12: an admin wrote to services THROUGH admin_services, bypassing the admin endpoints';
  exception when insufficient_privilege then
    v_refused := v_refused + 1;
  end;

  begin
    delete from public.admin_services
     where id = current_setting('app.v42_active')::uuid;
    reset role;
    raise exception
      'VERIFICATION FAILED 12: an admin deleted a service through admin_services';
  exception when insufficient_privilege then
    v_refused := v_refused + 1;
  end;

  reset role;

  if v_refused <> 2 then
    raise exception
      'VERIFICATION FAILED 12: only % of 2 writes through the view were refused',
      v_refused;
  end if;

  raise notice
    'PASS 12: the view is read-only in practice, not merely on paper';
end $$;

rollback;


-- ============================================================
-- PART 4 — REGRESSIONS (read-only)
-- ============================================================

-- Check 13.

do $$
declare
  v_tables integer;
  v_fn regprocedure;
  v_names text[] := array[
    'record_service_purchase',
    'fulfill_service_purchase',
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent'
  ];
  v_leak text;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE';

  if v_tables <> 21 then
    raise exception
      'VERIFICATION FAILED 13: % base tables in public, expected 21; this migration adds none',
      v_tables;
  end if;

  /* Migration 040's RPCs are still orchestrator-only. */
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
        'VERIFICATION FAILED 13: migration 040''s % became client-callable',
        v_fn;
    end if;
  end loop;

  if to_regprocedure(
       'public.get_admin_finance_kpis(timestamptz, timestamptz)'
     ) is null then
    raise exception
      'VERIFICATION FAILED 13: migration 038''s get_admin_finance_kpis disappeared';
  end if;

  if to_regclass('public.consultant_payout_settings') is null
     or has_table_privilege(
       'anon', 'public.consultant_payout_settings', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 13: migration 039''s payout settings are missing or exposed to anon';
  end if;

  if to_regclass('public.consultant_balances') is null then
    raise exception
      'VERIFICATION FAILED 13: migration 034''s consultant_balances disappeared';
  end if;

  /*
   * And nothing anywhere exposes either private column to anon,
   * nor to authenticated outside the admin view.
   */
  select string_agg(
           c.table_name || '.' || c.column_name, ', ')
    into v_leak
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.column_name in (
       'consultant_commission_bps',
       'post_purchase_instructions_html')
     and (
       has_column_privilege(
         'anon',
         format('%I.%I', c.table_schema, c.table_name)::regclass,
         c.column_name, 'SELECT')
       or (c.table_name <> 'admin_services'
           and has_column_privilege(
             'authenticated',
             format('%I.%I', c.table_schema, c.table_name)::regclass,
             c.column_name, 'SELECT'))
     );

  if v_leak is not null then
    raise exception
      'VERIFICATION FAILED 13: a private column is reachable through: %',
      v_leak;
  end if;

  raise notice
    'PASS 13: 21 base tables, migrations 034-041 intact, and both private columns are reachable only through admin_services';
end $$;


-- Fixtures rolled back.

do $$
declare
  v_left integer;
  v_services integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v42-%@verification.invalid';

  select count(*) into v_services
    from public.services
   where name like 'V42 %';

  if v_left <> 0 or v_services <> 0 then
    raise exception
      'VERIFICATION FAILED: % profile(s) and % service(s) survived the rollback',
      v_left, v_services;
  end if;

  raise notice 'PASS: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Rolling this back has one consequence worth stating first:
-- dropping the column DESTROYS every service's delivery
-- instructions. Export them before you do.
--
--   -- 1. restore the migration 041 view definition, which is the
--   --    same statement without the final column:
--   create or replace view public.admin_services
--   with (security_barrier = true) as
--   select s.id, …, s.consultant_commission_bps
--   from public.services s where public.is_admin();
--
--   -- CREATE OR REPLACE cannot REMOVE a view column, so this
--   -- needs a drop and recreate — and a recreated view picks up
--   -- Supabase's default GRANT ALL, on a view that is
--   -- auto-updatable. Re-apply migration 042 part C's revokes
--   -- immediately, or the view becomes a write path into
--   -- public.services.
--
--   -- 2. the column.
--   alter table public.services
--     drop column if exists post_purchase_instructions_html;
--
-- The orchestrator must be rolled back with it: the admin service
-- endpoints would otherwise write a column that no longer exists,
-- and the client instructions endpoint would 500 on every call.
--
-- Nothing else needs undoing. No grant on public.services was
-- changed, no policy, no RPC, and nothing that touches money.
-- ============================================================

do $$
begin
  raise notice
    'migration 042 verification complete: no check raised';
end $$;
