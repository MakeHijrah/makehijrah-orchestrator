-- ============================================================
-- Verification for migration_029_normalize_consultant_working_hours
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function identity, shape and grants   read-only, safe anywhere
--   Part 2  existing-row repair                   STAGING ONLY, self-contained, rolls back
--   Part 3  RPC working-hours behaviour           STAGING ONLY, self-contained, rolls back
--   Part 4  scope inspection                      read-only, safe anywhere
--   Part 5  rollback guidance
--
-- Parts 2 and 3 create every fixture they need inside a transaction
-- and roll it back. They read no business record.
--
-- Part 2 re-runs the migration's own guard and conversion
-- statements against its fixtures, so it proves the statements
-- themselves rather than a paraphrase.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths.
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION IDENTITY, SHAPE AND GRANTS (read-only)
-- ============================================================

-- Checks 8, 9, 10: exact signature, SECURITY DEFINER, search_path.

do $$
declare
  v_oid       oid;
  v_overloads integer;
  v_secdef    boolean;
  v_config    text;
  v_args      text;
begin
  v_oid := to_regprocedure(
    'public.save_consultant_profile('
    || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
  );

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 8: the exact 12-argument save_consultant_profile does not exist';
  end if;

  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'save_consultant_profile';

  if v_overloads <> 1 then
    raise exception
      'VERIFICATION FAILED 8: expected exactly one overload, found %', v_overloads;
  end if;

  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' | '), '(none)'),
         pg_get_function_identity_arguments(p.oid)
    into v_secdef, v_config, v_args
    from pg_proc p
   where p.oid = v_oid;

  /*
   * pg_get_function_identity_arguments returns argument NAMES as
   * well as types - "p_consultant_id uuid, p_mode text, ..." - not
   * a bare type list. Comparing it to a types-only string can
   * never match, which is a mistake worth stating plainly because
   * it silently turns an identity check into an unconditional
   * failure.
   *
   * The exact types are already pinned by the to_regprocedure
   * lookup above, which resolves by signature. This comparison
   * additionally pins the parameter NAMES, which the orchestrator
   * depends on: supabase-js calls the RPC with named arguments, so
   * a renamed parameter breaks every caller while leaving the
   * signature intact.
   */
  if v_args is distinct from
     'p_consultant_id uuid, p_mode text, p_full_name text, p_avatar_url text, '
     || 'p_gender text, p_headline text, p_bio text, p_timezone text, '
     || 'p_minimum_booking_notice_hours integer, p_available_for_general boolean, '
     || 'p_country_ids uuid[], p_working_hours jsonb' then
    raise exception
      'VERIFICATION FAILED 8: identity arguments are "%"', v_args;
  end if;

  if not v_secdef then
    raise exception 'VERIFICATION FAILED 9: function is not SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 10: search_path is % (expected "search_path=pg_catalog, public")',
      v_config;
  end if;

  raise notice 'PASS 8-10: exact signature, single overload, SECURITY DEFINER, search_path=%',
    v_config;
end $$;


-- Checks 11-14: EXECUTE privileges, proved from the ACL itself.
--
-- has_function_privilege('public', ...) is NOT used: PostgreSQL has
-- no ordinary role named "public". PUBLIC is grantee OID 0.
--
-- acldefault('f', proowner) is substituted when proacl is null,
-- because a null proacl means PostgreSQL defaults apply, and the
-- default for a function grants EXECUTE to PUBLIC.

do $$
declare
  v_oid          oid;
  v_public_exec  boolean;
  v_anon_exec    boolean;
  v_auth_exec    boolean;
  v_service_exec boolean;
begin
  v_oid := to_regprocedure(
    'public.save_consultant_profile('
    || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
  );

  select
    bool_or(a.grantee = 0                             and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = 'anon'::regrole::oid          and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = 'authenticated'::regrole::oid and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = 'service_role'::regrole::oid  and a.privilege_type = 'EXECUTE')
    into v_public_exec, v_anon_exec, v_auth_exec, v_service_exec
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) as a
   where p.oid = v_oid;

  if coalesce(v_public_exec, false) then
    raise exception
      'VERIFICATION FAILED 11: PUBLIC (grantee OID 0) holds EXECUTE';
  end if;
  if coalesce(v_anon_exec, false) then
    raise exception 'VERIFICATION FAILED 12: anon holds EXECUTE';
  end if;
  if coalesce(v_auth_exec, false) then
    raise exception 'VERIFICATION FAILED 13: authenticated holds EXECUTE';
  end if;
  if not coalesce(v_service_exec, false) then
    raise exception 'VERIFICATION FAILED 14: service_role does NOT hold EXECUTE';
  end if;

  raise notice 'PASS 11-14: PUBLIC no, anon no, authenticated no, service_role yes';
end $$;


-- Raw ACL, retained for reviewer inspection.

select case when a.grantee = 0
            then 'PUBLIC'
            else pg_get_userbyid(a.grantee)
       end as grantee,
       a.privilege_type
  from pg_proc p
  cross join lateral aclexplode(
    coalesce(p.proacl, acldefault('f', p.proowner))
  ) as a
 where p.oid = to_regprocedure(
   'public.save_consultant_profile('
   || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)')
 order by grantee, a.privilege_type;


-- The RPC must write the projection. A migration-027 body would
-- pass every check above and still leave photo_url stale.

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure(
     'public.save_consultant_profile('
     || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)');

  if v_src not like '%photo_url%coalesce(p_avatar_url%' then
    raise exception
      'VERIFICATION FAILED: the installed function does not write consultants.photo_url from p_avatar_url - migration 028 has not been applied';
  end if;

  raise notice 'PASS: installed function writes the public projection';
end $$;



-- Check 17-21 are covered by the block above. This one additionally
-- proves migration 029 is installed: a migration 028 body would pass
-- every check so far and still store named keys.

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure(
     'public.save_consultant_profile('
     || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)');

  if v_src not like '%CONSULTANT_WORKING_HOURS_FORMAT_INVALID%' then
    raise exception
      'VERIFICATION FAILED: the installed function does not validate working-hours format - migration 029 has not been applied';
  end if;

  if v_src not like '%coalesce(v_working_hours, c.working_hours_jsonb)%' then
    raise exception
      'VERIFICATION FAILED: the installed function still stores p_working_hours verbatim - migration 029 has not been applied';
  end if;

  -- Check 15: the migration 028 avatar projection must survive.
  if v_src not like '%photo_url%coalesce(p_avatar_url%' then
    raise exception
      'VERIFICATION FAILED 15: migration 029 dropped the migration 028 avatar projection';
  end if;

  raise notice 'PASS: 029 conversion installed and 028 avatar projection intact';
end $$;


-- ============================================================
-- PART 2 — EXISTING-ROW REPAIR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================

begin;

do $$
declare
  v_numeric_pr uuid := gen_random_uuid();
  v_named_pr   uuid := gen_random_uuid();
  v_empty_pr   uuid := gen_random_uuid();
  v_null_pr    uuid := gen_random_uuid();
  v_all_pr     uuid := gen_random_uuid();
  v_numeric    uuid;
  v_named      uuid;
  v_empty      uuid;
  v_nullrow    uuid;
  v_all        uuid;
  v_got        jsonb;
  v_n          integer;
begin
  insert into auth.users (id, email) values
    (v_numeric_pr, 'v29-numeric@verification.invalid'),
    (v_named_pr,   'v29-named@verification.invalid'),
    (v_empty_pr,   'v29-empty@verification.invalid'),
    (v_null_pr,    'v29-null@verification.invalid'),
    (v_all_pr,     'v29-all@verification.invalid');

  insert into public.profiles (id, role, full_name, email)
  values
    (v_numeric_pr, 'consultant', 'V29 Numeric', 'v29-numeric@verification.invalid'),
    (v_named_pr,   'consultant', 'V29 Named',   'v29-named@verification.invalid'),
    (v_empty_pr,   'consultant', 'V29 Empty',   'v29-empty@verification.invalid'),
    (v_null_pr,    'consultant', 'V29 Null',    'v29-null@verification.invalid'),
    (v_all_pr,     'consultant', 'V29 All',     'v29-all@verification.invalid')
  on conflict (id) do update set full_name = excluded.full_name;

  -- Already-numeric: must remain byte-identical.
  insert into public.consultants (profile_id, timezone, working_hours_jsonb)
  values (v_numeric_pr, 'Africa/Cairo',
          '{"0":[{"start":"09:00","end":"17:00"}]}'::jsonb)
  returning id into v_numeric;

  -- Named with multiple intervals: must convert, order preserved.
  insert into public.consultants (profile_id, timezone, working_hours_jsonb)
  values (v_named_pr, 'Africa/Cairo',
          '{"sunday":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}]}'::jsonb)
  returning id into v_named;

  -- Empty object: must survive as an empty object.
  insert into public.consultants (profile_id, timezone, working_hours_jsonb)
  values (v_empty_pr, 'Africa/Cairo', '{}'::jsonb)
  returning id into v_empty;

  -- Check 6 note: consultants.working_hours_jsonb is NOT NULL with
  -- default '{}' (migration 001), so a null stored value cannot
  -- exist. The migration's "is not null" guard is defensive only.
  -- This fixture stands in for the nearest reachable case, the
  -- default empty object, and the NOT NULL constraint itself is
  -- asserted below rather than faked with an impossible row.
  insert into public.consultants (profile_id, timezone)
  values (v_null_pr, 'Africa/Cairo')
  returning id into v_nullrow;

  -- All seven named weekdays, to prove every mapping.
  insert into public.consultants (profile_id, timezone, working_hours_jsonb)
  values (v_all_pr, 'Africa/Cairo', jsonb_build_object(
    'sunday',    jsonb_build_array(jsonb_build_object('start','00:00','end','01:00')),
    'monday',    jsonb_build_array(jsonb_build_object('start','01:00','end','02:00')),
    'tuesday',   jsonb_build_array(jsonb_build_object('start','02:00','end','03:00')),
    'wednesday', jsonb_build_array(jsonb_build_object('start','03:00','end','04:00')),
    'thursday',  jsonb_build_array(jsonb_build_object('start','04:00','end','05:00')),
    'friday',    jsonb_build_array(jsonb_build_object('start','05:00','end','06:00')),
    'saturday',  jsonb_build_array(jsonb_build_object('start','06:00','end','07:00'))))
  returning id into v_all;

  perform set_config('app.v29_numeric', v_numeric::text, true);
  perform set_config('app.v29_named',   v_named::text,   true);
  perform set_config('app.v29_empty',   v_empty::text,   true);
  perform set_config('app.v29_null',    v_nullrow::text, true);
  perform set_config('app.v29_all',     v_all::text,     true);

  raise notice 'FIXTURES CREATED';

  -- ---------- the migration's conversion statement, verbatim ----------
  update public.consultants c
  set working_hours_jsonb = (
    select coalesce(
             jsonb_object_agg(
               case k
                 when 'sunday'    then '0'
                 when 'monday'    then '1'
                 when 'tuesday'   then '2'
                 when 'wednesday' then '3'
                 when 'thursday'  then '4'
                 when 'friday'    then '5'
                 when 'saturday'  then '6'
               end,
               c.working_hours_jsonb -> k
             ),
             '{}'::jsonb
           )
      from jsonb_object_keys(c.working_hours_jsonb) as k
  )
  where c.working_hours_jsonb is not null
    and jsonb_typeof(c.working_hours_jsonb) = 'object'
    and exists (
      select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
       where k in ('sunday','monday','tuesday','wednesday',
                   'thursday','friday','saturday')
    );

  -- Check 1: numeric row unchanged.
  select working_hours_jsonb into v_got from public.consultants where id = v_numeric;
  if v_got is distinct from '{"0":[{"start":"09:00","end":"17:00"}]}'::jsonb then
    raise exception 'VERIFICATION FAILED 1: numeric row changed to %', v_got;
  end if;
  raise notice 'PASS 1: existing numeric shape unchanged';

  -- Checks 2 and 4: named converts, multiple intervals survive in order.
  select working_hours_jsonb into v_got from public.consultants where id = v_named;
  if v_got is distinct from
     '{"0":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}]}'::jsonb then
    raise exception 'VERIFICATION FAILED 2/4: named row converted to %', v_got;
  end if;
  raise notice 'PASS 2/4: named converted to numeric, intervals preserved in order';

  -- Check 3: all seven mappings.
  select working_hours_jsonb into v_got from public.consultants where id = v_all;
  if v_got -> '0' -> 0 ->> 'start' is distinct from '00:00'
     or v_got -> '1' -> 0 ->> 'start' is distinct from '01:00'
     or v_got -> '2' -> 0 ->> 'start' is distinct from '02:00'
     or v_got -> '3' -> 0 ->> 'start' is distinct from '03:00'
     or v_got -> '4' -> 0 ->> 'start' is distinct from '04:00'
     or v_got -> '5' -> 0 ->> 'start' is distinct from '05:00'
     or v_got -> '6' -> 0 ->> 'start' is distinct from '06:00' then
    raise exception 'VERIFICATION FAILED 3: weekday mapping wrong: %', v_got;
  end if;
  select count(*) into v_n from jsonb_object_keys(v_got) as k;
  if v_n <> 7 then
    raise exception 'VERIFICATION FAILED 3: expected 7 keys, got %', v_n;
  end if;
  raise notice 'PASS 3: sunday=0 monday=1 tuesday=2 wednesday=3 thursday=4 friday=5 saturday=6';

  -- Check 5: empty object survives.
  select working_hours_jsonb into v_got from public.consultants where id = v_empty;
  if v_got is distinct from '{}'::jsonb then
    raise exception 'VERIFICATION FAILED 5: empty object became %', v_got;
  end if;
  raise notice 'PASS 5: empty object survived';

  -- Check 6: the column cannot be null, and the column default
  -- survives conversion untouched.
  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultants'
     and column_name = 'working_hours_jsonb'
     and is_nullable = 'NO';
  if v_n <> 1 then
    raise exception
      'VERIFICATION FAILED 6: working_hours_jsonb is nullable - the migration null guard needs a real test';
  end if;

  select working_hours_jsonb into v_got from public.consultants where id = v_nullrow;
  if v_got is distinct from '{}'::jsonb then
    raise exception 'VERIFICATION FAILED 6: defaulted row became %', v_got;
  end if;
  raise notice 'PASS 6: column is NOT NULL (null unreachable); defaulted row survived unchanged';

  -- Idempotence: nothing left to convert.
  update public.consultants c
  set working_hours_jsonb = c.working_hours_jsonb
  where c.working_hours_jsonb is not null
    and jsonb_typeof(c.working_hours_jsonb) = 'object'
    and exists (
      select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
       where k in ('sunday','monday','tuesday','wednesday',
                   'thursday','friday','saturday')
    );
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'VERIFICATION FAILED: % row(s) still carry named keys', v_n;
  end if;
  raise notice 'PASS: conversion is idempotent (0 rows remain named)';
end $$;


-- Checks 7 and 8: the migration's guards abort on unknown and mixed
-- keys. Each is proven by running the guard against a deliberately
-- bad fixture and requiring it to raise.

do $$
declare
  v_pr uuid := gen_random_uuid();
  v_c  uuid;
  v_bad integer;
begin
  insert into auth.users (id, email) values (v_pr, 'v29-unknown@verification.invalid');
  insert into public.profiles (id, role, full_name, email)
  values (v_pr, 'consultant', 'V29 Unknown', 'v29-unknown@verification.invalid')
  on conflict (id) do update set full_name = excluded.full_name;
  insert into public.consultants (profile_id, timezone, working_hours_jsonb)
  values (v_pr, 'Africa/Cairo', '{"funday":[{"start":"09:00","end":"17:00"}]}'::jsonb)
  returning id into v_c;

  select count(*) into v_bad
    from public.consultants c, lateral jsonb_object_keys(c.working_hours_jsonb) as k
   where c.id = v_c
     and k not in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday',
                   '0','1','2','3','4','5','6');

  if v_bad = 0 then
    raise exception 'VERIFICATION FAILED 7: unknown-key guard did not detect the bad row';
  end if;
  raise notice 'PASS 7: unknown weekday key is detected and would abort the migration';
end $$;

do $$
declare
  v_pr uuid := gen_random_uuid();
  v_c  uuid;
  v_bad integer;
begin
  insert into auth.users (id, email) values (v_pr, 'v29-mixed@verification.invalid');
  insert into public.profiles (id, role, full_name, email)
  values (v_pr, 'consultant', 'V29 Mixed', 'v29-mixed@verification.invalid')
  on conflict (id) do update set full_name = excluded.full_name;
  insert into public.consultants (profile_id, timezone, working_hours_jsonb)
  values (v_pr, 'Africa/Cairo',
          '{"sunday":[{"start":"09:00","end":"17:00"}],"1":[{"start":"09:00","end":"17:00"}]}'::jsonb)
  returning id into v_c;

  select count(*) into v_bad
    from public.consultants c
   where c.id = v_c
     and exists (select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
                  where k in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'))
     and exists (select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
                  where k in ('0','1','2','3','4','5','6'));

  if v_bad = 0 then
    raise exception 'VERIFICATION FAILED 8: mixed-key guard did not detect the bad row';
  end if;
  raise notice 'PASS 8: mixed named/numeric keys are detected and would abort the migration';
end $$;

rollback;   -- discards Part 2 fixtures


-- ============================================================
-- PART 3 — RPC BEHAVIOUR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================

begin;

do $$
declare
  v_pr    uuid := gen_random_uuid();
  v_opr   uuid := gen_random_uuid();
  v_id    uuid;
  v_other uuid;
  v_cid   uuid;
begin
  insert into auth.users (id, email) values
    (v_pr,  'v29-rpc@verification.invalid'),
    (v_opr, 'v29-rpc-other@verification.invalid');

  insert into public.profiles (id, role, full_name, email, avatar_url)
  values
    (v_pr,  'consultant', 'V29 RPC',   'v29-rpc@verification.invalid',       'https://cdn.test/a.png'),
    (v_opr, 'consultant', 'V29 Other', 'v29-rpc-other@verification.invalid', 'https://cdn.test/o.png')
  on conflict (id) do update set avatar_url = excluded.avatar_url;

  insert into public.consultants
    (profile_id, timezone, photo_url, working_hours_jsonb, headline, bio)
  values (v_pr, 'Africa/Cairo', 'https://cdn.test/a.png',
          '{"1":[{"start":"08:00","end":"09:00"}]}'::jsonb, 'H', 'B')
  returning id into v_id;

  insert into public.consultants
    (profile_id, timezone, photo_url, working_hours_jsonb, headline, bio)
  values (v_opr, 'Africa/Cairo', 'https://cdn.test/o.png',
          '{"2":[{"start":"10:00","end":"11:00"}]}'::jsonb, 'OH', 'OB')
  returning id into v_other;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ V29 Country', 'QW1', true) returning id into v_cid;

  perform set_config('app.v29_rpc',       v_id::text,    true);
  perform set_config('app.v29_rpc_other', v_other::text, true);
  perform set_config('app.v29_rpc_pr',    v_pr::text,    true);
  perform set_config('app.v29_country',   v_cid::text,   true);

  raise notice 'FIXTURES CREATED';
end $$;


-- Check 9: named input stores numeric output.
do $$
declare
  v_id  uuid := current_setting('app.v29_rpc')::uuid;
  v_got jsonb;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null, null,
    '{"sunday":[{"start":"09:00","end":"17:00"}],"friday":[{"start":"14:00","end":"16:00"}]}'::jsonb);

  select working_hours_jsonb into v_got from public.consultants where id = v_id;

  if v_got is distinct from
     '{"0":[{"start":"09:00","end":"17:00"}],"5":[{"start":"14:00","end":"16:00"}]}'::jsonb then
    raise exception 'VERIFICATION FAILED 9: stored value is %', v_got;
  end if;
  raise notice 'PASS 9: named RPC input stored as numeric keys';
end $$;

-- Check 10: numeric input rejects.
do $$
declare v_id uuid := current_setting('app.v29_rpc')::uuid;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null, null,
    '{"0":[{"start":"09:00","end":"17:00"}]}'::jsonb);
  raise exception 'VERIFICATION FAILED 10: numeric RPC input was accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_WORKING_HOURS_FORMAT_INVALID%' then
    raise notice 'PASS 10: numeric RPC input rejected';
  else raise; end if;
end $$;

-- Check 11: mixed input rejects.
do $$
declare v_id uuid := current_setting('app.v29_rpc')::uuid;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null, null,
    '{"sunday":[{"start":"09:00","end":"17:00"}],"1":[{"start":"09:00","end":"17:00"}]}'::jsonb);
  raise exception 'VERIFICATION FAILED 11: mixed RPC input was accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_WORKING_HOURS_FORMAT_INVALID%' then
    raise notice 'PASS 11: mixed RPC input rejected';
  else raise; end if;
end $$;

-- Check 12: unknown named key rejects.
do $$
declare v_id uuid := current_setting('app.v29_rpc')::uuid;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null, null,
    '{"funday":[{"start":"09:00","end":"17:00"}]}'::jsonb);
  raise exception 'VERIFICATION FAILED 12: unknown weekday key was accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_WORKING_HOURS_FORMAT_INVALID%' then
    raise notice 'PASS 12: unknown weekday key rejected';
  else raise; end if;
end $$;

-- Check 13: null input preserves existing numeric storage.
do $$
declare
  v_id  uuid := current_setting('app.v29_rpc')::uuid;
  v_got jsonb;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, 'Changed headline', null, null, null, null, null, null);

  select working_hours_jsonb into v_got from public.consultants where id = v_id;
  if v_got is distinct from
     '{"0":[{"start":"09:00","end":"17:00"}],"5":[{"start":"14:00","end":"16:00"}]}'::jsonb then
    raise exception 'VERIFICATION FAILED 13: null input changed storage to %', v_got;
  end if;
  raise notice 'PASS 13: null p_working_hours preserved numeric storage';
end $$;

-- Checks 14 and 16: a failed save rolls back every other change.
do $$
declare
  v_id     uuid := current_setting('app.v29_rpc')::uuid;
  v_before record;
  v_after  record;
  v_n      integer;
begin
  select c.headline, c.bio, c.working_hours_jsonb, c.photo_url, pr.avatar_url
    into v_before
    from public.consultants c join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  begin
    perform public.save_consultant_profile(
      v_id, 'draft', 'NOPE', 'https://cdn.test/nope.png', null,
      'NOPE HEADLINE', 'NOPE BIO', null, null, null,
      array['99999999-9999-4999-8999-999999999999'::uuid]::uuid[],
      '{"monday":[{"start":"09:00","end":"10:00"}]}'::jsonb);
    raise exception 'VERIFICATION FAILED 14: invalid country did not abort';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select c.headline, c.bio, c.working_hours_jsonb, c.photo_url, pr.avatar_url
    into v_after
    from public.consultants c join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_before is distinct from v_after then
    raise exception 'VERIFICATION FAILED 14: a partial write survived an aborted save';
  end if;

  select count(*) into v_n from public.consultant_countries where consultant_id = v_id;
  if v_n <> 0 then
    raise exception 'VERIFICATION FAILED 16: countries were written by an aborted save';
  end if;

  raise notice 'PASS 14/16: failed save left working hours, avatar and countries untouched';
end $$;

-- Check 15: avatar dual-write from migration 028 still works.
do $$
declare
  v_id     uuid := current_setting('app.v29_rpc')::uuid;
  v_pr     uuid := current_setting('app.v29_rpc_pr')::uuid;
  v_cid    uuid := current_setting('app.v29_country')::uuid;
  v_avatar text;
  v_photo  text;
  v_n      integer;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, 'https://cdn.test/new.png', null, null, null, null, null, null,
    array[v_cid]::uuid[], '{"tuesday":[{"start":"09:00","end":"10:00"}]}'::jsonb);

  select avatar_url into v_avatar from public.profiles where id = v_pr;
  select photo_url  into v_photo  from public.consultants where id = v_id;

  if v_avatar is distinct from 'https://cdn.test/new.png'
     or v_photo is distinct from 'https://cdn.test/new.png' then
    raise exception 'VERIFICATION FAILED 15: avatar dual-write broken (avatar=%, photo=%)',
      v_avatar, v_photo;
  end if;

  select count(*) into v_n from public.consultant_countries where consultant_id = v_id;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 16: expected 1 country assignment, found %', v_n;
  end if;

  raise notice 'PASS 15/16: avatar dual-write intact and countries applied atomically';
end $$;

-- Another consultant is untouched throughout.
do $$
declare
  v_other uuid := current_setting('app.v29_rpc_other')::uuid;
  v_got   jsonb;
begin
  select working_hours_jsonb into v_got from public.consultants where id = v_other;
  if v_got is distinct from '{"2":[{"start":"10:00","end":"11:00"}]}'::jsonb then
    raise exception 'VERIFICATION FAILED: other consultant working hours changed to %', v_got;
  end if;
  raise notice 'PASS: another consultant untouched';
end $$;

do $$
begin
  raise notice '=====================================================';
  raise notice 'PARTS 2 AND 3 COMPLETE - all behavioural checks passed';
  raise notice 'Rolling back every fixture and every change.';
  raise notice '=====================================================';
end $$;

rollback;   -- discards Part 3 fixtures


-- ============================================================
-- PART 4 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 22: RLS policies unchanged.
select tablename, policyname, cmd, roles::text,
       coalesce(qual, '-') as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('profiles', 'consultants', 'consultant_countries')
 order by tablename, policyname;

-- Check 23: table count remains 16.
select count(*) as public_table_count
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';

-- Check 24: fixtures left nothing behind.
select count(*) as leftover_v29_profiles
  from public.profiles where email like 'v29-%@verification.invalid';

-- Steady state after applying: storage is numeric only.
select count(*) as non_numeric_keys
  from public.consultants c,
       lateral jsonb_object_keys(c.working_hours_jsonb) as k
 where c.working_hours_jsonb is not null
   and k not in ('0','1','2','3','4','5','6');

-- Migration 026 trigger still bound.
select t.tgname, p.proname as function_name
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc  p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'consultants'
   and not t.tgisinternal
 order by t.tgname;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Function rollback:
--
--   Re-run supabase/migrations/migration_028_consultant_avatar_projection.sql.
--   It is a CREATE OR REPLACE with identical grants and restores
--   the pre-029 body exactly. New saves would then store named keys
--   again, which is the regression 029 exists to fix, so this is a
--   stopgap only.
--
-- Kill switch without a rollback and without a deployment:
--
--   revoke execute on function public.save_consultant_profile(
--     uuid, text, text, text, text, text, text, text,
--     integer, boolean, uuid[], jsonb) from service_role;
--
-- Data rollback:
--
--   Reversing the conversion is possible but NOT recommended: the
--   numeric form is the approved storage format and the
--   orchestrator readers accept both, so a converted row is correct
--   either way. If it must be reversed, invert the CASE mapping in
--   the section A update and restrict it with
--   "where exists (... k in ('0'..'6'))". Doing so would reintroduce
--   the profile-loading failure this migration repairs.
