-- ============================================================
-- Verification for migration_027_atomic_consultant_profile_save
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function shape and grants   read-only, safe anywhere
--   Part 2  behaviour                   STAGING ONLY, rolls back
--   Part 3  scope inspection            read-only, safe anywhere
--   Part 4  rollback guidance
--
-- Part 2 calls the function directly, so it must run as a role
-- that holds EXECUTE - postgres or service_role. It never runs as
-- authenticated, because authenticated is not supposed to be able
-- to call it at all; check 5 proves that separately.
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION SHAPE AND GRANTS (read-only)
-- ============================================================

-- 1. Function exists with the expected argument signature.
--    Expect one row, 12 arguments, returning a two-column record.

select p.proname,
       pg_get_function_identity_arguments(p.oid) as argument_signature,
       pg_get_function_result(p.oid)             as result_type,
       p.pronargs                                as argument_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'save_consultant_profile';

-- 2. SECURITY DEFINER.  Expect security_definer = true.
-- 3. search_path fixed to public. Expect config to contain
--    search_path=public.

select p.proname,
       p.prosecdef                                as security_definer,
       coalesce(array_to_string(p.proconfig, ' | '), '(none)') as config,
       pg_get_userbyid(p.proowner)                as owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'save_consultant_profile';

-- 4-7. EXECUTE privileges.
--      Expect exactly one row: service_role = true.
--      anon, authenticated and PUBLIC must all be false.

select 'anon'          as grantee,
       has_function_privilege('anon',
         'public.save_consultant_profile(uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)',
         'EXECUTE') as has_execute
union all
select 'authenticated',
       has_function_privilege('authenticated',
         'public.save_consultant_profile(uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)',
         'EXECUTE')
union all
select 'public',
       has_function_privilege('public',
         'public.save_consultant_profile(uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)',
         'EXECUTE')
union all
select 'service_role',
       has_function_privilege('service_role',
         'public.save_consultant_profile(uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)',
         'EXECUTE');

-- Raw ACL, for the reviewer. Expect no "=X/" entry for PUBLIC
-- (an ACL entry with an empty grantee), anon or authenticated.

select coalesce(array_to_string(p.proacl, E'\n'), '(default - INVESTIGATE)') as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'save_consultant_profile';


-- ============================================================
-- PART 2 — BEHAVIOUR (STAGING ONLY)
-- ============================================================
--
-- Mutates, then rolls back. Values come from transaction-local
-- settings rather than psql :'variables', which do not
-- interpolate inside DO blocks.

begin;

-- ------------------------------------------------------------
-- CONFIGURATION — replace all six values before running
-- ------------------------------------------------------------
--
--   pending   = consultant with onboarding_completed_at NULL
--   completed = consultant with onboarding_completed_at NOT NULL
--   other     = any third consultant, used to prove no
--               cross-consultant country row is touched
--   country_a / country_b = two ACTIVE countries
--   country_inactive      = one INACTIVE country

select set_config('app.v27_pending_consultant',   '00000000-0000-0000-0000-000000000000', true);
select set_config('app.v27_completed_consultant', '00000000-0000-0000-0000-000000000000', true);
select set_config('app.v27_other_consultant',     '00000000-0000-0000-0000-000000000000', true);
select set_config('app.v27_country_a',            '00000000-0000-0000-0000-000000000000', true);
select set_config('app.v27_country_b',            '00000000-0000-0000-0000-000000000000', true);
select set_config('app.v27_country_inactive',     '00000000-0000-0000-0000-000000000000', true);


-- ------------------------------------------------------------
-- PRECHECK — configuration is coherent
-- ------------------------------------------------------------

do $$
declare
  v_pending   uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_completed uuid := current_setting('app.v27_completed_consultant')::uuid;
  v_other     uuid := current_setting('app.v27_other_consultant')::uuid;
  v_a         uuid := current_setting('app.v27_country_a')::uuid;
  v_b         uuid := current_setting('app.v27_country_b')::uuid;
  v_inactive  uuid := current_setting('app.v27_country_inactive')::uuid;
  v_marker    timestamptz;
begin
  if v_pending = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'VERIFICATION ABORT: configuration values were not replaced';
  end if;

  select c.onboarding_completed_at into v_marker
    from public.consultants c where c.id = v_pending;
  if not found then
    raise exception 'VERIFICATION ABORT: pending consultant % missing', v_pending;
  end if;
  if v_marker is not null then
    raise exception 'VERIFICATION ABORT: pending consultant already completed';
  end if;

  select c.onboarding_completed_at into v_marker
    from public.consultants c where c.id = v_completed;
  if not found then
    raise exception 'VERIFICATION ABORT: completed consultant % missing', v_completed;
  end if;
  if v_marker is null then
    raise exception 'VERIFICATION ABORT: completed consultant has a null marker';
  end if;

  if not exists (select 1 from public.consultants c where c.id = v_other) then
    raise exception 'VERIFICATION ABORT: other consultant % missing', v_other;
  end if;

  if not exists (select 1 from public.countries co
                  where co.id = v_a and co.is_active) then
    raise exception 'VERIFICATION ABORT: country_a is not an active country';
  end if;
  if not exists (select 1 from public.countries co
                  where co.id = v_b and co.is_active) then
    raise exception 'VERIFICATION ABORT: country_b is not an active country';
  end if;
  if not exists (select 1 from public.countries co
                  where co.id = v_inactive and not co.is_active) then
    raise exception 'VERIFICATION ABORT: country_inactive is not an inactive country';
  end if;

  raise notice 'PRECHECK OK';
end $$;


-- ------------------------------------------------------------
-- 8. Invalid mode rejects
-- ------------------------------------------------------------
do $$
begin
  perform public.save_consultant_profile(
    current_setting('app.v27_pending_consultant')::uuid,
    'delete_everything',
    null, null, null, null, null, null, null, null, null, null);
  raise exception 'VERIFICATION FAILED: invalid mode accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_PROFILE_MODE_INVALID%' then
    raise notice 'PASS 8: invalid mode rejected';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- 9. Unknown consultant rejects
-- ------------------------------------------------------------
do $$
begin
  perform public.save_consultant_profile(
    '99999999-9999-4999-8999-999999999999'::uuid,
    'draft',
    null, null, null, null, null, null, null, null, null, null);
  raise exception 'VERIFICATION FAILED: unknown consultant accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_PROFILE_NOT_FOUND%' then
    raise notice 'PASS 9: unknown consultant rejected';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- 10/11. Draft preserves nulls and does not set the marker
-- ------------------------------------------------------------
do $$
declare
  v_id       uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_before   record;
  v_after    record;
  v_returned timestamptz;
begin
  select c.headline, c.bio, c.timezone, c.minimum_booking_notice_hours,
         c.available_for_general, c.working_hours_jsonb, c.gender,
         c.onboarding_completed_at, pr.full_name, pr.avatar_url
    into v_before
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  select s.onboarding_completed_at into v_returned
    from public.save_consultant_profile(
      v_id, 'draft',
      null, null, null, null, null, null, null, null, null, null) s;

  select c.headline, c.bio, c.timezone, c.minimum_booking_notice_hours,
         c.available_for_general, c.working_hours_jsonb, c.gender,
         c.onboarding_completed_at, pr.full_name, pr.avatar_url
    into v_after
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_before is distinct from v_after then
    raise exception 'VERIFICATION FAILED: all-null draft changed data';
  end if;
  if v_returned is not null then
    raise exception 'VERIFICATION FAILED: draft returned a marker';
  end if;

  raise notice 'PASS 10/11: all-null draft preserved every field and set no marker';
end $$;

-- ------------------------------------------------------------
-- 12/13. Draft replaces countries; duplicates collapse
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_a  uuid := current_setting('app.v27_country_a')::uuid;
  v_b  uuid := current_setting('app.v27_country_b')::uuid;
  v_n  integer;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null,
    array[v_a, v_b, v_a, v_b, v_a]::uuid[], null);

  select count(*) into v_n
    from public.consultant_countries cc
   where cc.consultant_id = v_id;

  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED: expected 2 assignments, found %', v_n;
  end if;

  raise notice 'PASS 12/13: multiple countries persisted, duplicates collapsed to %', v_n;
end $$;

-- ------------------------------------------------------------
-- 14. Null country_ids preserves assignments
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_n  integer;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null, null, null);

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;

  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED: null country_ids changed assignments (now %)', v_n;
  end if;

  raise notice 'PASS 14: null country_ids preserved assignments';
end $$;

-- ------------------------------------------------------------
-- 16/17. Invalid or inactive country aborts and preserves
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_a  uuid := current_setting('app.v27_country_a')::uuid;
  v_x  uuid := current_setting('app.v27_country_inactive')::uuid;
  v_n  integer;
begin
  begin
    perform public.save_consultant_profile(
      v_id, 'draft', null, null, null, null, null, null, null, null,
      array[v_a, v_x]::uuid[], null);
    raise exception 'VERIFICATION FAILED: inactive country accepted';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;
  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED: inactive-country abort disturbed assignments (now %)', v_n;
  end if;
  raise notice 'PASS 16: inactive country aborted, assignments preserved';

  begin
    perform public.save_consultant_profile(
      v_id, 'draft', null, null, null, null, null, null, null, null,
      array[v_a, '88888888-8888-4888-8888-888888888888'::uuid]::uuid[], null);
    raise exception 'VERIFICATION FAILED: unknown country accepted';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;
  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED: unknown-country abort disturbed assignments (now %)', v_n;
  end if;
  raise notice 'PASS 17: unknown country aborted, assignments preserved';
end $$;

-- ------------------------------------------------------------
-- 24. Failure rolls back profile and consultant changes too
-- ------------------------------------------------------------
--
-- The invalid country is supplied alongside real field changes.
-- Nothing may survive.
do $$
declare
  v_id     uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_x      uuid := current_setting('app.v27_country_inactive')::uuid;
  v_before record;
  v_after  record;
begin
  select c.headline, c.bio, pr.full_name, pr.avatar_url
    into v_before
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  begin
    perform public.save_consultant_profile(
      v_id, 'draft',
      'ROLLED BACK NAME', 'https://example.test/rolled-back.png',
      null, 'ROLLED BACK HEADLINE', 'ROLLED BACK BIO',
      null, null, null,
      array[v_x]::uuid[], null);
    raise exception 'VERIFICATION FAILED: invalid country did not abort';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select c.headline, c.bio, pr.full_name, pr.avatar_url
    into v_after
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_before is distinct from v_after then
    raise exception 'VERIFICATION FAILED: partial write survived an aborted save';
  end if;

  raise notice 'PASS 24: failed save left profile and consultant untouched';
end $$;

-- ------------------------------------------------------------
-- 27. No cross-consultant country rows are modified
-- ------------------------------------------------------------
do $$
declare
  v_id    uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_other uuid := current_setting('app.v27_other_consultant')::uuid;
  v_a     uuid := current_setting('app.v27_country_a')::uuid;
  v_before integer;
  v_after  integer;
begin
  select count(*) into v_before
    from public.consultant_countries cc where cc.consultant_id = v_other;

  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null,
    array[v_a]::uuid[], null);

  select count(*) into v_after
    from public.consultant_countries cc where cc.consultant_id = v_other;

  if v_before is distinct from v_after then
    raise exception 'VERIFICATION FAILED: other consultant assignments changed % -> %',
      v_before, v_after;
  end if;

  raise notice 'PASS 27: other consultant assignments untouched (% rows)', v_after;
end $$;

-- ------------------------------------------------------------
-- 15. Empty country_ids removes all assignments
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_n  integer;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null,
    array[]::uuid[], null);

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;

  if v_n <> 0 then
    raise exception 'VERIFICATION FAILED: empty array left % assignment(s)', v_n;
  end if;

  raise notice 'PASS 15: empty array removed all assignments';
end $$;

-- ------------------------------------------------------------
-- 25/26. is_active and profile_id are untouched by any save
-- ------------------------------------------------------------
do $$
declare
  v_id      uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_active  boolean;
  v_profile uuid;
  v_active2 boolean;
  v_profile2 uuid;
begin
  select c.is_active, c.profile_id into v_active, v_profile
    from public.consultants c where c.id = v_id;

  perform public.save_consultant_profile(
    v_id, 'draft', 'Name', 'https://example.test/a.png', 'male',
    'Headline', 'Bio', 'Africa/Cairo', 12, true, null,
    '{"monday":[{"start":"09:00","end":"17:00"}]}'::jsonb);

  select c.is_active, c.profile_id into v_active2, v_profile2
    from public.consultants c where c.id = v_id;

  if v_active is distinct from v_active2 then
    raise exception 'VERIFICATION FAILED: is_active changed';
  end if;
  if v_profile is distinct from v_profile2 then
    raise exception 'VERIFICATION FAILED: profile_id changed';
  end if;

  raise notice 'PASS 25/26: is_active and profile_id untouched';
end $$;

-- ------------------------------------------------------------
-- 18/19. Submit sets the marker once and persists gender
-- ------------------------------------------------------------
do $$
declare
  v_id     uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_a      uuid := current_setting('app.v27_country_a')::uuid;
  v_marker timestamptz;
  v_gender text;
begin
  select s.onboarding_completed_at into v_marker
    from public.save_consultant_profile(
      v_id, 'submit', 'Submitted Name', 'https://example.test/s.png',
      'female', 'Submitted Headline', 'Submitted Bio',
      'Africa/Cairo', 24, false, array[v_a]::uuid[],
      '{"monday":[{"start":"09:00","end":"17:00"}]}'::jsonb) s;

  if v_marker is null then
    raise exception 'VERIFICATION FAILED: submit returned a null marker';
  end if;

  select c.gender, c.onboarding_completed_at into v_gender, v_marker
    from public.consultants c where c.id = v_id;

  if v_gender is distinct from 'female' then
    raise exception 'VERIFICATION FAILED: gender not persisted (got %)', v_gender;
  end if;
  if v_marker is null then
    raise exception 'VERIFICATION FAILED: marker not persisted';
  end if;

  raise notice 'PASS 18/19: submit set the marker and persisted gender';
end $$;

-- ------------------------------------------------------------
-- 20. Second submit rejects
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_a  uuid := current_setting('app.v27_country_a')::uuid;
begin
  perform public.save_consultant_profile(
    v_id, 'submit', null, null, 'male', null, null, null, null, null,
    array[v_a]::uuid[], null);
  raise exception 'VERIFICATION FAILED: second submit accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_ONBOARDING_ALREADY_COMPLETED%' then
    raise notice 'PASS 20: second submit rejected';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- 21. Update cannot change gender
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
begin
  perform public.save_consultant_profile(
    v_id, 'update', null, null, 'male', null, null, null, null, null, null, null);
  raise exception 'VERIFICATION FAILED: update changed gender';
exception when others then
  if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
    raise notice 'PASS 21: update rejected a gender change';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- 22/23. Update tolerates unchanged gender and keeps the marker
-- ------------------------------------------------------------
do $$
declare
  v_id     uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_before timestamptz;
  v_after  timestamptz;
begin
  select c.onboarding_completed_at into v_before
    from public.consultants c where c.id = v_id;

  perform public.save_consultant_profile(
    v_id, 'update', null, null, 'female', 'Updated Headline',
    null, null, null, null, null, null);

  select c.onboarding_completed_at into v_after
    from public.consultants c where c.id = v_id;

  if v_after is distinct from v_before then
    raise exception 'VERIFICATION FAILED: update moved the marker';
  end if;

  raise notice 'PASS 22/23: unchanged legacy gender tolerated, marker preserved';
end $$;

-- ------------------------------------------------------------
-- Draft after completion is rejected
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null, null, null);
  raise exception 'VERIFICATION FAILED: draft accepted after completion';
exception when others then
  if sqlerrm like 'CONSULTANT_ONBOARDING_ALREADY_COMPLETED%' then
    raise notice 'PASS extra: draft rejected after completion';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- Update before completion is rejected
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_completed_consultant')::uuid;
begin
  -- The completed consultant is already complete, so use the
  -- "other" consultant, which has no marker.
  perform public.save_consultant_profile(
    current_setting('app.v27_other_consultant')::uuid,
    'update', null, null, null, null, null, null, null, null, null, null);
  raise exception 'VERIFICATION FAILED: update accepted before completion';
exception when others then
  if sqlerrm like 'CONSULTANT_ONBOARDING_INCOMPLETE%' then
    raise notice 'PASS extra: update rejected before completion';
  elsif sqlerrm like 'CONSULTANT_ONBOARDING_ALREADY_COMPLETED%' then
    raise notice 'SKIP: other consultant already completed; pick an unmarked third consultant';
  else raise; end if;
end $$;

rollback;   -- discard everything Part 2 changed


-- ============================================================
-- PART 3 — SCOPE INSPECTION (read-only)
-- ============================================================

-- 28. Table count remains 16.
select count(*) as public_table_count
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';

-- 29. RLS policies unchanged on the three tables this touches.
select tablename, policyname, cmd, roles::text,
       coalesce(qual, '-') as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('consultants', 'consultant_countries', 'profiles')
 order by tablename, policyname;

select c.relname, c.relrowsecurity as rls_enabled
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('consultants', 'consultant_countries', 'profiles');

-- 30. Migration 026 trigger remains present and bound.
select t.tgname, p.proname as function_name, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc  p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'consultants'
   and not t.tgisinternal
 order by t.tgname;

-- The 026 gender lock must still be in the guard body.
select prosrc like '%CONSULTANT_GENDER_IMMUTABLE%'            as has_gender_lock,
       prosrc like '%CONSULTANT_ONBOARDING_MARKER_IMMUTABLE%' as has_marker_lock,
       prosrc like '%is_active may not be changed by clients%' as has_is_active_guard,
       prosrc like '%profile_id may not be changed by clients%' as has_profile_id_guard
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'guard_consultants_columns';

-- consultants columns unchanged by 027 (no column added or dropped).
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'consultants'
 order by ordinal_position;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 027 adds one function and changes nothing else. It is
-- the cleanest rollback in the series.
--
-- Full rollback:
--
--   drop function if exists public.save_consultant_profile(
--     uuid, text, text, text, text, text, text, text,
--     integer, boolean, uuid[], jsonb);
--
-- Safe once no orchestrator build calls it. Dropping it while a
-- deployed orchestrator still calls it turns every profile save
-- into a 500; roll the orchestrator back first.
--
-- Kill switch without a drop and without a deployment:
--
--   revoke execute on function public.save_consultant_profile(
--     uuid, text, text, text, text, text, text, text,
--     integer, boolean, uuid[], jsonb) from service_role;
--
-- This disables profile saves while leaving the definition in
-- place for inspection.
--
-- No data written through this function needs reversing: it
-- writes only values the caller supplied. Country assignments and
-- onboarding_completed_at values already written must NOT be
-- deleted as part of a rollback - see Amendment 008 §20.
