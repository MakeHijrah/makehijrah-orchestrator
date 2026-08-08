-- ============================================================
-- Verification for migration_041_admin_services_read_model
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  the view, its shape and its grants   read-only
--   Part 2  the base table is untouched          read-only
--   Part 3  who can read what                    STAGING ONLY, rolls back
--   Part 4  regressions                          read-only
--   Part 5  rollback guidance
--
-- Part 3 creates its fixtures and ends in ROLLBACK.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  admin_services exists with exactly the expected columns
--    2  it is owner-executed with security_barrier, NOT
--       security_invoker — a security_invoker view would fail
--       with the very 403 this migration fixes
--    3  authenticated may select it; anon, PUBLIC and
--       service_role may not
--    4  public.services is UNCHANGED: authenticated still cannot
--       select consultant_commission_bps
--    5  every other services column is still granted exactly as
--       migration 034 left it — no public selector was widened
--    6  an admin reads the view INCLUDING the commission
--    7  an admin sees inactive services there, which is what an
--       admin catalog needs
--    8  a client reads zero rows from the view, and still cannot
--       select the column from services
--    9  a consultant reads zero rows from the view, and still
--       cannot select the column from services
--   10  anon is refused the view at the privilege layer, and
--       still cannot select the column from services
--   11  ordinary service reads are unaffected: a client still
--       reads the public columns of active services
--   12  admin create/update of the commission still works, and
--       the value is immediately visible through the view
--   13  no relation anywhere exposes the commission to anon, and
--       none exposes it to authenticated except this view
--   14  migrations 034, 038, 039 and 040 are intact
-- ============================================================


-- ============================================================
-- PART 1 — THE VIEW, ITS SHAPE AND ITS GRANTS (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_columns text;
  v_expected text :=
    'id, name, description, price_display, is_active, sort_order, '
    'created_at, updated_at, billing_type, recurring_interval, '
    'price_cents, currency, stripe_product_id, stripe_price_id, '
    'stripe_payment_link_id, stripe_payment_link_url, '
    'consultant_commission_bps';
begin
  if to_regclass('public.admin_services') is null then
    raise exception
      'VERIFICATION FAILED 1: public.admin_services does not exist';
  end if;

  select string_agg(a.attname, ', ' order by a.attnum)
    into v_columns
    from pg_attribute a
   where a.attrelid = 'public.admin_services'::regclass
     and a.attnum > 0
     and not a.attisdropped;

  if v_columns is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 1: columns are [%], expected [%]',
      coalesce(v_columns, '(none)'), v_expected;
  end if;

  raise notice
    'PASS 1: admin_services exposes exactly the admin projection plus the commission rate';
end $$;


-- Check 2.
--
-- The mechanism, asserted rather than assumed. A view marked
-- security_invoker would apply the caller's own column privileges
-- and reproduce the 403 this migration exists to remove; a view
-- without security_barrier could let a caller-supplied predicate
-- run below the is_admin() gate.

do $$
declare
  v_options text;
  v_definition text;
begin
  select coalesce(array_to_string(c.reloptions, ', '), '(none)')
    into v_options
    from pg_class c
   where c.oid = 'public.admin_services'::regclass;

  if v_options not like '%security_barrier=true%' then
    raise exception
      'VERIFICATION FAILED 2: admin_services has options [%]; security_barrier must be on',
      v_options;
  end if;

  if v_options like '%security_invoker=true%' then
    raise exception
      'VERIFICATION FAILED 2: admin_services is security_invoker, which would apply the caller''s column privileges and fail exactly as the base table does';
  end if;

  select pg_get_viewdef('public.admin_services'::regclass, true)
    into v_definition;

  if v_definition not like '%is_admin()%' then
    raise exception
      'VERIFICATION FAILED 2: admin_services does not gate on is_admin(); an owner-executed view without that predicate would expose the commission to everyone';
  end if;

  raise notice
    'PASS 2: owner-executed, security_barrier on, gated on is_admin()';
end $$;


-- Check 3.

do $$
declare
  v_role text;
begin
  if not has_table_privilege(
       'authenticated', 'public.admin_services', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 3: authenticated cannot select admin_services; the admin page would still get 403';
  end if;

  foreach v_role in array array['anon', 'service_role']
  loop
    if has_table_privilege(
         v_role, 'public.admin_services', 'SELECT') then
      raise exception
        'VERIFICATION FAILED 3: % can select admin_services', v_role;
    end if;
  end loop;

  /* PUBLIC is grantee 0 in an exploded ACL. */
  if exists (
    select 1 from pg_class c
    cross join lateral aclexplode(c.relacl) a
   where c.oid = 'public.admin_services'::regclass
     and a.grantee = 0
  ) then
    raise exception
      'VERIFICATION FAILED 3: PUBLIC holds a privilege on admin_services';
  end if;

  /* Read-only. A view over the catalog must never be a write path. */
  foreach v_role in array array['authenticated', 'anon']
  loop
    if has_table_privilege(
         v_role, 'public.admin_services', 'INSERT')
       or has_table_privilege(
         v_role, 'public.admin_services', 'UPDATE')
       or has_table_privilege(
         v_role, 'public.admin_services', 'DELETE') then
      raise exception
        'VERIFICATION FAILED 3: % holds a write privilege on admin_services',
        v_role;
    end if;
  end loop;

  raise notice
    'PASS 3: authenticated may SELECT and nothing more; anon, PUBLIC and service_role hold nothing';
end $$;


-- ============================================================
-- PART 2 — THE BASE TABLE IS UNTOUCHED (read-only)
-- ============================================================

-- Checks 4 and 5.
--
-- The claim this migration makes is that it fixes the admin read
-- WITHOUT weakening column privacy. That claim is worthless
-- unless the base table is checked, so it is checked first and
-- exactly: the commission column is still ungranted, and every
-- other column is still granted.

do $$
declare
  v_missing text;
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated']
  loop
    if has_column_privilege(
         v_role, 'public.services',
         'consultant_commission_bps', 'SELECT') then
      raise exception
        'VERIFICATION FAILED 4: % can select services.consultant_commission_bps; migration 034 part E has been undone',
        v_role;
    end if;

    if has_table_privilege(v_role, 'public.services', 'SELECT') then
      raise exception
        'VERIFICATION FAILED 4: % holds a TABLE-level SELECT on services, which overrides every column-level revoke',
        v_role;
    end if;
  end loop;

  /* Check 5 — nothing was narrowed either. */
  select string_agg(c.column_name, ', ')
    into v_missing
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'services'
     and c.column_name <> 'consultant_commission_bps'
     and not has_column_privilege(
           'authenticated', 'public.services',
           c.column_name, 'SELECT');

  if v_missing is not null then
    raise exception
      'VERIFICATION FAILED 5: authenticated LOST select on services column(s): %',
      v_missing;
  end if;

  select string_agg(c.column_name, ', ')
    into v_missing
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'services'
     and c.column_name <> 'consultant_commission_bps'
     and not has_column_privilege(
           'anon', 'public.services', c.column_name, 'SELECT');

  if v_missing is not null then
    raise exception
      'VERIFICATION FAILED 5: anon LOST select on services column(s): %',
      v_missing;
  end if;

  raise notice
    'PASS 4 and 5: the commission column is still ungranted to anon and authenticated, and every other services column is still readable exactly as before';
end $$;


-- ============================================================
-- PART 3 — WHO CAN READ WHAT (STAGING ONLY, rolls back)
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
    (v_admin, 'v41-admin@verification.invalid'),
    (v_cpr, 'v41-consultant@verification.invalid'),
    (v_clp, 'v41-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin, 'admin', 'V41 Admin',
     'v41-admin@verification.invalid'),
    (v_cpr, 'consultant', 'V41 Consultant',
     'v41-consultant@verification.invalid'),
    (v_clp, 'client', 'V41 Client',
     'v41-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true);

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V41 Active Service', 'one_time', 12000, 'usd',
          4500, true)
  returning id into v_active;

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V41 Retired Service', 'one_time', 9000, 'usd',
          3000, false)
  returning id into v_inactive;

  perform set_config('app.v41_admin', v_admin::text, true);
  perform set_config('app.v41_consultant', v_cpr::text, true);
  perform set_config('app.v41_client', v_clp::text, true);
  perform set_config('app.v41_active', v_active::text, true);
  perform set_config('app.v41_inactive', v_inactive::text, true);
end $$;


-- Checks 6 and 7 — the administrator.

do $$
declare
  v_bps integer;
  v_rows integer;
  v_inactive_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v41_admin'), true);

  begin
    select consultant_commission_bps into v_bps
      from public.admin_services
     where id = current_setting('app.v41_active')::uuid;
  exception when insufficient_privilege then
    reset role;
    raise exception
      'VERIFICATION FAILED 6: the admin read raised insufficient_privilege; the view is not reachable';
  end;

  select count(*) into v_rows from public.admin_services;

  select count(*) into v_inactive_seen
    from public.admin_services
   where id = current_setting('app.v41_inactive')::uuid;

  reset role;

  if v_bps is distinct from 4500 then
    raise exception
      'VERIFICATION FAILED 6: the admin read the commission as [%], expected 4500',
      coalesce(v_bps::text, '(null)');
  end if;

  if v_rows < 2 then
    raise exception
      'VERIFICATION FAILED 6: the admin sees % rows in admin_services, expected at least the two fixtures',
      v_rows;
  end if;

  if v_inactive_seen <> 1 then
    raise exception
      'VERIFICATION FAILED 7: the admin cannot see the inactive service, which an admin catalog needs';
  end if;

  raise notice
    'PASS 6 and 7: an admin reads the commission through admin_services, inactive services included';
end $$;


-- Checks 8 and 9 — a client and a consultant.
--
-- Two separate refusals, both asserted: zero rows from the view,
-- AND still no column privilege on the base table. Either alone
-- would be a weaker statement than this migration claims.

do $$
declare
  v_who text;
  v_rows integer;
  v_denied integer := 0;
begin
  foreach v_who in array array['app.v41_client', 'app.v41_consultant']
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
      perform s.consultant_commission_bps
        from public.services s
       where s.id = current_setting('app.v41_active')::uuid;

      reset role;
      raise exception
        'VERIFICATION FAILED 8/9: % selected consultant_commission_bps from services',
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

  raise notice
    'PASS 8 and 9: a client and a consultant each read zero rows from admin_services and are still refused the column on services';
end $$;


-- Check 10 — anon.

do $$
declare
  v_view_denied boolean := false;
  v_column_denied boolean := false;
begin
  set local role anon;

  begin
    perform 1 from public.admin_services;
  exception when insufficient_privilege then
    v_view_denied := true;
  end;

  begin
    perform s.consultant_commission_bps from public.services s;
  exception when insufficient_privilege then
    v_column_denied := true;
  end;

  reset role;

  if not v_view_denied then
    raise exception
      'VERIFICATION FAILED 10: anon could read admin_services';
  end if;

  if not v_column_denied then
    raise exception
      'VERIFICATION FAILED 10: anon could read services.consultant_commission_bps';
  end if;

  raise notice
    'PASS 10: anon is refused both the view and the column, at the privilege layer';
end $$;


-- Check 11 — ordinary service reads are exactly as they were.
--
-- The regression that would matter most and be noticed least: if
-- this migration had disturbed the base table, the public booking
-- surface and every client catalog would break.

do $$
declare
  v_name text;
  v_price integer;
  v_active integer;
  v_inactive integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v41_client'), true);

  select s.name, s.price_cents into v_name, v_price
    from public.services s
   where s.id = current_setting('app.v41_active')::uuid;

  select count(*) into v_active
    from public.services s where s.is_active;

  select count(*) into v_inactive
    from public.services s
   where s.id = current_setting('app.v41_inactive')::uuid;

  reset role;

  if v_name is distinct from 'V41 Active Service'
     or v_price is distinct from 12000 then
    raise exception
      'VERIFICATION FAILED 11: a client read the active service as [% / %]',
      v_name, v_price;
  end if;

  if v_active < 1 then
    raise exception
      'VERIFICATION FAILED 11: a client sees no active services';
  end if;

  if v_inactive <> 0 then
    raise exception
      'VERIFICATION FAILED 11: a client can see an inactive service; services_select_active was widened';
  end if;

  raise notice
    'PASS 11: a client still reads the public columns of active services, and still cannot see an inactive one';
end $$;


-- Check 12 — admin writes still work, and land in the view.
--
-- The catalog is written by the orchestrator with the service
-- role, which bypasses RLS and column privileges. What is checked
-- here is that the write path is intact and that the value it
-- writes is immediately readable by an admin through the view —
-- the round trip the Admin Services page actually performs.

do $$
declare
  v_bps integer;
  v_rejected boolean := false;
begin
  if not has_table_privilege(
       'service_role', 'public.services', 'UPDATE')
     or not has_table_privilege(
       'service_role', 'public.services', 'INSERT') then
    raise exception
      'VERIFICATION FAILED 12: service_role lost write access to services; the admin catalog endpoints would fail';
  end if;

  update public.services
     set consultant_commission_bps = 6000
   where id = current_setting('app.v41_active')::uuid;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v41_admin'), true);

  select consultant_commission_bps into v_bps
    from public.admin_services
   where id = current_setting('app.v41_active')::uuid;

  reset role;

  if v_bps is distinct from 6000 then
    raise exception
      'VERIFICATION FAILED 12: after an update the admin reads [%], expected 6000',
      coalesce(v_bps::text, '(null)');
  end if;

  /* The bound is still enforced. */
  begin
    update public.services
       set consultant_commission_bps = 10001
     where id = current_setting('app.v41_active')::uuid;
    raise exception
      'VERIFICATION FAILED 12: a commission above 100%% was accepted';
  exception when check_violation then
    v_rejected := true;
  end;

  if not v_rejected then
    raise exception
      'VERIFICATION FAILED 12: services_commission_bps_check is not enforcing its range';
  end if;

  /* Null is still meaningful and still writable. */
  update public.services
     set consultant_commission_bps = null
   where id = current_setting('app.v41_active')::uuid;

  raise notice
    'PASS 12: an admin write still lands, is immediately visible through the view, and the 0-10000 bound still holds';
end $$;

rollback;


-- ============================================================
-- PART 4 — REGRESSIONS (read-only)
-- ============================================================

-- Checks 13 and 14.

do $$
declare
  v_leak text;
  v_tables integer;
  v_fn regprocedure;
  v_names text[] := array[
    'record_service_purchase',
    'fulfill_service_purchase',
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent'
  ];
begin
  /* Check 13 — nothing anywhere leaks the commission to anon. */
  select string_agg(
           c.table_name || '.' || c.column_name, ', ')
    into v_leak
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.column_name = 'consultant_commission_bps'
     and has_column_privilege(
           'anon',
           format('%I.%I', c.table_schema, c.table_name)::regclass,
           c.column_name, 'SELECT');

  if v_leak is not null then
    raise exception
      'VERIFICATION FAILED 13: anon can select the commission through: %',
      v_leak;
  end if;

  /* And authenticated reaches it through exactly one relation. */
  select string_agg(
           c.table_name || '.' || c.column_name, ', ')
    into v_leak
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.column_name = 'consultant_commission_bps'
     and c.table_name <> 'admin_services'
     and has_column_privilege(
           'authenticated',
           format('%I.%I', c.table_schema, c.table_name)::regclass,
           c.column_name, 'SELECT');

  if v_leak is not null then
    raise exception
      'VERIFICATION FAILED 13: authenticated can select the commission outside admin_services, through: %',
      v_leak;
  end if;

  /* Check 14 — nothing else moved. */
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE';

  if v_tables <> 21 then
    raise exception
      'VERIFICATION FAILED 14: % base tables in public, expected 21; this migration adds none',
      v_tables;
  end if;

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
        'VERIFICATION FAILED 14: migration 040''s % became client-callable',
        v_fn;
    end if;
  end loop;

  if to_regprocedure(
       'public.get_admin_finance_kpis(timestamptz, timestamptz)'
     ) is null then
    raise exception
      'VERIFICATION FAILED 14: migration 038''s get_admin_finance_kpis disappeared';
  end if;

  if to_regclass('public.consultant_payout_settings') is null
     or has_table_privilege(
       'anon', 'public.consultant_payout_settings', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 14: migration 039''s payout settings are missing or exposed to anon';
  end if;

  if to_regclass('public.consultant_balances') is null then
    raise exception
      'VERIFICATION FAILED 14: migration 034''s consultant_balances disappeared';
  end if;

  raise notice
    'PASS 13 and 14: the commission is reachable through admin_services and nowhere else, and migrations 034-040 are intact';
end $$;


-- Fixtures rolled back.

do $$
declare
  v_left integer;
  v_services integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v41-%@verification.invalid';

  select count(*) into v_services
    from public.services where name like 'V41 %';

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
-- This migration adds one view and writes no data. Dropping it
-- destroys nothing:
--
--   drop view if exists public.admin_services;
--
-- The consequence is that the Admin Services page returns to 403
-- when it selects consultant_commission_bps. It is NOT fixed by
-- granting the column — every logged-in user shares the
-- `authenticated` role, so that grant would hand the platform's
-- margin to every client and consultant and would undo migration
-- 034 part E. The supported alternatives are this view or an
-- admin-only RPC; there is no third option that keeps the column
-- private.
--
-- Nothing else needs undoing. public.services was not altered in
-- any way: not its grants, not its column list, not its policies.
-- ============================================================

do $$
begin
  raise notice
    'migration 041 verification complete: no check raised';
end $$;
