-- ============================================================
-- Verification for migration_027_atomic_consultant_profile_save
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function identity, shape and grants  read-only, safe anywhere
--   Part 2  behaviour                            STAGING ONLY, self-contained, rolls back
--   Part 3  scope inspection                     read-only, safe anywhere
--   Part 4  rollback guidance
--
-- Part 2 calls the function directly, so it must run as a role
-- that holds EXECUTE - postgres or service_role. It never runs as
-- authenticated, because authenticated is not supposed to be able
-- to call it at all; Part 1 proves that separately.
--
-- Part 2 creates every fixture it needs inside one transaction and
-- rolls the whole thing back. It reads no business record and
-- depends on no pre-existing consultant or country, so it runs
-- correctly against a staging database holding a single consultant
-- or none at all.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths.
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION IDENTITY, SHAPE AND GRANTS (read-only)
-- ============================================================

-- 1. Exact identity, resolved by full signature rather than by
--    name. Fails loudly if the function is absent, if the exact
--    signature is missing, if an unexpected overload exists, if
--    SECURITY DEFINER is off, or if search_path is not exactly
--    pg_catalog, public.

do $$
declare
  v_oid           oid;
  v_overloads     integer;
  v_secdef        boolean;
  v_config        text;
  v_result        text;
  v_args          text;
  v_owner         text;
begin
  v_oid := to_regprocedure(
    'public.save_consultant_profile('
    || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
  );

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 1: public.save_consultant_profile with the exact 12-argument signature does not exist';
  end if;

  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'save_consultant_profile';

  if v_overloads <> 1 then
    raise exception
      'VERIFICATION FAILED 1: expected exactly one save_consultant_profile, found % overload(s)',
      v_overloads;
  end if;

  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' | '), '(none)'),
         pg_get_function_result(p.oid),
         pg_get_function_identity_arguments(p.oid),
         pg_get_userbyid(p.proowner)
    into v_secdef, v_config, v_result, v_args, v_owner
    from pg_proc p
   where p.oid = v_oid;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 2: function is not SECURITY DEFINER';
  end if;

  /*
   * Exact match. A looser test would accept search_path=public,
   * which is precisely the value this hardening replaced.
   */
  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 3: search_path config is % (expected "search_path=pg_catalog, public")',
      v_config;
  end if;

  if v_args is distinct from
     'uuid, text, text, text, text, text, text, text, integer, boolean, uuid[], jsonb' then
    raise exception
      'VERIFICATION FAILED 1: identity arguments are % ', v_args;
  end if;

  raise notice 'PASS 1-3: exact signature present, single overload, SECURITY DEFINER, search_path=%',
    v_config;
  raise notice '          owner=%  returns=%', v_owner, v_result;
end $$;


-- 4-7. EXECUTE privileges, proved from the ACL itself.
--
-- has_function_privilege('public', ...) is NOT used: PostgreSQL has
-- no ordinary role named "public", so that call errors rather than
-- answering the question. PUBLIC is represented in an ACL by
-- grantee OID 0, and that is what is inspected here.
--
-- acldefault('f', proowner) is substituted when proacl is null,
-- because a null proacl means "PostgreSQL defaults still apply",
-- and the default for a function is EXECUTE granted to PUBLIC.
-- Treating null as "no grants" would invert the result.

do $$
declare
  v_oid            oid;
  v_public_exec    boolean;
  v_anon_exec      boolean;
  v_auth_exec      boolean;
  v_service_exec   boolean;
begin
  v_oid := to_regprocedure(
    'public.save_consultant_profile('
    || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
  );

  if v_oid is null then
    raise exception 'VERIFICATION FAILED 4: function not found';
  end if;

  select
    bool_or(a.grantee = 0            and a.privilege_type = 'EXECUTE'),
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
      'VERIFICATION FAILED 4: PUBLIC (grantee OID 0) holds EXECUTE - the REVOKE FROM PUBLIC did not take effect';
  end if;

  if coalesce(v_anon_exec, false) then
    raise exception 'VERIFICATION FAILED 5: anon holds EXECUTE';
  end if;

  if coalesce(v_auth_exec, false) then
    raise exception 'VERIFICATION FAILED 6: authenticated holds EXECUTE';
  end if;

  if not coalesce(v_service_exec, false) then
    raise exception 'VERIFICATION FAILED 7: service_role does NOT hold EXECUTE';
  end if;

  raise notice 'PASS 4-7: PUBLIC no, anon no, authenticated no, service_role yes';
end $$;


-- Raw ACL, retained for reviewer inspection.
-- A grantee shown as "=X/owner" (empty left side) would be PUBLIC.

select coalesce(array_to_string(p.proacl, E'\n'),
                '(null proacl - PostgreSQL defaults apply, which grant EXECUTE to PUBLIC - INVESTIGATE)') as raw_acl
  from pg_proc p
 where p.oid = to_regprocedure(
   'public.save_consultant_profile('
   || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)');

-- Exploded ACL, one row per grant, for the same inspection.

select case when a.grantee = 0
            then 'PUBLIC'
            else pg_get_userbyid(a.grantee)
       end                as grantee,
       a.privilege_type,
       a.is_grantable
  from pg_proc p
  cross join lateral aclexplode(
    coalesce(p.proacl, acldefault('f', p.proowner))
  ) as a
 where p.oid = to_regprocedure(
   'public.save_consultant_profile('
   || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)')
 order by grantee, a.privilege_type;


-- ============================================================
-- PART 2 — BEHAVIOUR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================
--
-- Creates its own fixtures, exercises every rule, then rolls the
-- whole transaction back. Nothing is left behind and no business
-- record is read or written.
--
-- Fixture identities are deterministic and namespaced so they
-- cannot collide with real data:
--
--   profiles.email   v27-<role>@verification.invalid
--   countries.name   ZZ Verification <x>
--   countries.iso_code  QV1 / QV2 / QV3
--
-- .invalid is reserved by RFC 2606 and can never be a real domain.
-- QV1-QV3 are outside the ISO 3166-1 assigned set.

begin;

-- ------------------------------------------------------------
-- FIXTURES
-- ------------------------------------------------------------
--
-- profiles.id is a foreign key to auth.users(id), so an auth user
-- has to exist first. This runs as the privileged verification
-- session inside the transaction and is discarded by the rollback.

do $$
declare
  v_pending_profile   uuid := gen_random_uuid();
  v_completed_profile uuid := gen_random_uuid();
  v_other_profile     uuid := gen_random_uuid();
  v_update_profile    uuid := gen_random_uuid();
  v_pending           uuid;
  v_completed         uuid;
  v_other             uuid;
  v_update_target     uuid;
  v_a                 uuid;
  v_b                 uuid;
  v_inactive          uuid;
  v_n                 integer;
begin
  -- Auth users. Only id and email are supplied; every other column
  -- in auth.users is nullable or defaulted.
  insert into auth.users (id, email) values
    (v_pending_profile,   'v27-pending@verification.invalid'),
    (v_completed_profile, 'v27-completed@verification.invalid'),
    (v_other_profile,     'v27-other@verification.invalid'),
    (v_update_profile,    'v27-update@verification.invalid');

  get diagnostics v_n = row_count;
  if v_n <> 4 then
    raise exception 'FIXTURE FAILED: expected 4 auth users, inserted %', v_n;
  end if;

  -- Profiles. A trigger may already have created these from
  -- auth.users; upsert so the fixture is correct either way.
  insert into public.profiles (id, role, full_name, email)
  values
    (v_pending_profile,   'consultant', 'V27 Pending',   'v27-pending@verification.invalid'),
    (v_completed_profile, 'consultant', 'V27 Completed', 'v27-completed@verification.invalid'),
    (v_other_profile,     'consultant', 'V27 Other',     'v27-other@verification.invalid'),
    (v_update_profile,    'consultant', 'V27 Update',    'v27-update@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  -- Consultants. timezone is NOT NULL with no default.
  --
  -- The completed fixture's marker is set in the same INSERT.
  -- guard_consultants_columns only guards UPDATE, and this session
  -- is a privileged writer regardless.
  insert into public.consultants
    (profile_id, timezone, gender, onboarding_completed_at)
  values
    (v_pending_profile,   'Africa/Cairo', null,     null)
  returning id into v_pending;

  insert into public.consultants
    (profile_id, timezone, gender, onboarding_completed_at)
  values
    (v_completed_profile, 'Africa/Cairo', 'female', now())
  returning id into v_completed;

  insert into public.consultants
    (profile_id, timezone, gender, onboarding_completed_at)
  values
    (v_other_profile,     'Africa/Cairo', null,     null)
  returning id into v_other;

  -- A fourth, dedicated pending consultant reserved solely for the
  -- "update before completion" test, so that test can never be
  -- skipped because a shared fixture was already completed.
  insert into public.consultants
    (profile_id, timezone, gender, onboarding_completed_at)
  values
    (v_update_profile,    'Africa/Cairo', null,     null)
  returning id into v_update_target;

  -- Countries. Created fresh rather than reused, so the run does
  -- not depend on which countries staging happens to hold.
  insert into public.countries (name, iso_code, is_active)
  values ('ZZ Verification A', 'QV1', true)
  returning id into v_a;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ Verification B', 'QV2', true)
  returning id into v_b;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ Verification Inactive', 'QV3', false)
  returning id into v_inactive;

  -- Give the "other" consultant one assignment, so the
  -- cross-consultant isolation check has something to protect.
  insert into public.consultant_countries (consultant_id, country_id)
  values (v_other, v_b);

  perform set_config('app.v27_pending_consultant',   v_pending::text,       true);
  perform set_config('app.v27_completed_consultant', v_completed::text,     true);
  perform set_config('app.v27_other_consultant',     v_other::text,         true);
  perform set_config('app.v27_update_consultant',    v_update_target::text, true);
  perform set_config('app.v27_country_a',            v_a::text,             true);
  perform set_config('app.v27_country_b',            v_b::text,             true);
  perform set_config('app.v27_country_inactive',     v_inactive::text,      true);

  raise notice 'FIXTURES CREATED';
end $$;


-- ------------------------------------------------------------
-- FIXTURE PRECHECK — identity and row counts
-- ------------------------------------------------------------

do $$
declare
  v_pending   uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_completed uuid := current_setting('app.v27_completed_consultant')::uuid;
  v_other     uuid := current_setting('app.v27_other_consultant')::uuid;
  v_update    uuid := current_setting('app.v27_update_consultant')::uuid;
  v_a         uuid := current_setting('app.v27_country_a')::uuid;
  v_b         uuid := current_setting('app.v27_country_b')::uuid;
  v_inactive  uuid := current_setting('app.v27_country_inactive')::uuid;
  v_n         integer;
  v_marker    timestamptz;
  v_profile   uuid;
begin
  -- Fixture identifiers must all be distinct.
  if (select count(distinct id)
        from (values (v_pending), (v_completed), (v_other), (v_update)) as t(id)) <> 4 then
    raise exception 'PRECHECK FAILED: consultant fixture ids are not distinct';
  end if;

  if (select count(distinct id)
        from (values (v_a), (v_b), (v_inactive)) as t(id)) <> 3 then
    raise exception 'PRECHECK FAILED: country fixture ids are not distinct';
  end if;

  -- Pending consultant exists with a null marker.
  select c.onboarding_completed_at, c.profile_id into v_marker, v_profile
    from public.consultants c where c.id = v_pending;
  if not found then
    raise exception 'PRECHECK FAILED: pending consultant missing';
  end if;
  if v_marker is not null then
    raise exception 'PRECHECK FAILED: pending consultant marker is not null';
  end if;
  if v_profile is null
     or not exists (select 1 from public.profiles pr where pr.id = v_profile) then
    raise exception 'PRECHECK FAILED: pending consultant profile link is broken';
  end if;

  -- Completed consultant exists with a non-null marker.
  select c.onboarding_completed_at, c.profile_id into v_marker, v_profile
    from public.consultants c where c.id = v_completed;
  if not found then
    raise exception 'PRECHECK FAILED: completed consultant missing';
  end if;
  if v_marker is null then
    raise exception 'PRECHECK FAILED: completed consultant marker is null';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = v_profile) then
    raise exception 'PRECHECK FAILED: completed consultant profile link is broken';
  end if;

  -- Unrelated consultant exists, with its assignment.
  if not exists (select 1 from public.consultants c where c.id = v_other) then
    raise exception 'PRECHECK FAILED: other consultant missing';
  end if;
  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_other;
  if v_n <> 1 then
    raise exception 'PRECHECK FAILED: other consultant should hold exactly 1 assignment, holds %', v_n;
  end if;

  -- Dedicated update-test consultant exists, pending.
  select c.onboarding_completed_at into v_marker
    from public.consultants c where c.id = v_update;
  if not found then
    raise exception 'PRECHECK FAILED: update-test consultant missing';
  end if;
  if v_marker is not null then
    raise exception 'PRECHECK FAILED: update-test consultant marker is not null';
  end if;

  -- Exactly two active fixture countries and one inactive.
  select count(*) into v_n
    from public.countries co
   where co.id in (v_a, v_b) and co.is_active;
  if v_n <> 2 then
    raise exception 'PRECHECK FAILED: expected 2 active fixture countries, found %', v_n;
  end if;

  select count(*) into v_n
    from public.countries co
   where co.id = v_inactive and not co.is_active;
  if v_n <> 1 then
    raise exception 'PRECHECK FAILED: inactive fixture country is not inactive';
  end if;

  raise notice 'PRECHECK OK: fixtures distinct, linked and in the expected state';
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
  raise exception 'VERIFICATION FAILED 8: invalid mode accepted';
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
  raise exception 'VERIFICATION FAILED 9: unknown consultant accepted';
exception when others then
  if sqlerrm like 'CONSULTANT_PROFILE_NOT_FOUND%' then
    raise notice 'PASS 9: unknown consultant rejected';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- 10/11. Draft preserves nulls, sets no marker, returns one row
-- ------------------------------------------------------------
do $$
declare
  v_id       uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_before   record;
  v_after    record;
  v_returned timestamptz;
  v_rows     integer;
begin
  select c.headline, c.bio, c.timezone, c.minimum_booking_notice_hours,
         c.available_for_general, c.working_hours_jsonb, c.gender,
         c.onboarding_completed_at, pr.full_name, pr.avatar_url
    into v_before
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  select count(*) into v_rows
    from public.save_consultant_profile(
      v_id, 'draft',
      null, null, null, null, null, null, null, null, null, null) s;

  if v_rows <> 1 then
    raise exception 'VERIFICATION FAILED 10: expected exactly 1 result row, got %', v_rows;
  end if;

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
    raise exception 'VERIFICATION FAILED 11: all-null draft changed data';
  end if;
  if v_returned is not null then
    raise exception 'VERIFICATION FAILED 11: draft returned a marker';
  end if;

  raise notice 'PASS 10/11: all-null draft returned exactly one row, preserved every field, set no marker';
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
  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'draft', null, null, null, null, null, null, null, null,
      array[v_a, v_b, v_a, v_b, v_a]::uuid[], null) s;

  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 12: expected exactly 1 result row, got %', v_n;
  end if;

  select count(*) into v_n
    from public.consultant_countries cc
   where cc.consultant_id = v_id;

  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED 13: expected 2 assignments, found %', v_n;
  end if;

  -- Identity, not just count: the two stored rows must be A and B.
  if not exists (select 1 from public.consultant_countries cc
                  where cc.consultant_id = v_id and cc.country_id = v_a)
     or not exists (select 1 from public.consultant_countries cc
                     where cc.consultant_id = v_id and cc.country_id = v_b) then
    raise exception 'VERIFICATION FAILED 13: stored assignments are not exactly country A and B';
  end if;

  raise notice 'PASS 12/13: countries persisted, duplicates collapsed to % and identities match', v_n;
end $$;

-- ------------------------------------------------------------
-- 14. Null country_ids preserves assignments
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_n  integer;
begin
  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'draft', null, null, null, null, null, null, null, null, null, null) s;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 14: expected exactly 1 result row, got %', v_n;
  end if;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;

  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED 14: null country_ids changed assignments (now %)', v_n;
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
    raise exception 'VERIFICATION FAILED 16: inactive country accepted';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;
  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED 16: inactive-country abort disturbed assignments (now %)', v_n;
  end if;
  raise notice 'PASS 16: inactive country aborted, assignments preserved';

  begin
    perform public.save_consultant_profile(
      v_id, 'draft', null, null, null, null, null, null, null, null,
      array[v_a, '88888888-8888-4888-8888-888888888888'::uuid]::uuid[], null);
    raise exception 'VERIFICATION FAILED 17: unknown country accepted';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;
  if v_n <> 2 then
    raise exception 'VERIFICATION FAILED 17: unknown-country abort disturbed assignments (now %)', v_n;
  end if;
  raise notice 'PASS 17: unknown country aborted, assignments preserved';
end $$;

-- ------------------------------------------------------------
-- 24. Failure rolls back profile and consultant changes too
-- ------------------------------------------------------------
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
    raise exception 'VERIFICATION FAILED 24: invalid country did not abort';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select c.headline, c.bio, pr.full_name, pr.avatar_url
    into v_after
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_before is distinct from v_after then
    raise exception 'VERIFICATION FAILED 24: partial write survived an aborted save';
  end if;

  raise notice 'PASS 24: failed save left profile and consultant untouched';
end $$;

-- ------------------------------------------------------------
-- 27. No cross-consultant row is modified
-- ------------------------------------------------------------
do $$
declare
  v_id     uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_other  uuid := current_setting('app.v27_other_consultant')::uuid;
  v_a      uuid := current_setting('app.v27_country_a')::uuid;
  v_before record;
  v_after  record;
  v_bn     integer;
  v_an     integer;
begin
  select count(*) into v_bn
    from public.consultant_countries cc where cc.consultant_id = v_other;

  select c.headline, c.bio, c.gender, c.timezone, c.onboarding_completed_at,
         c.is_active, c.profile_id
    into v_before
    from public.consultants c where c.id = v_other;

  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, null, null, null, null, null,
    array[v_a]::uuid[], null);

  select count(*) into v_an
    from public.consultant_countries cc where cc.consultant_id = v_other;

  select c.headline, c.bio, c.gender, c.timezone, c.onboarding_completed_at,
         c.is_active, c.profile_id
    into v_after
    from public.consultants c where c.id = v_other;

  if v_bn is distinct from v_an then
    raise exception 'VERIFICATION FAILED 27: other consultant assignments changed % -> %', v_bn, v_an;
  end if;
  if v_before is distinct from v_after then
    raise exception 'VERIFICATION FAILED 27: other consultant row data changed';
  end if;

  raise notice 'PASS 27: other consultant untouched (% assignment row(s), all fields equal)', v_an;
end $$;

-- ------------------------------------------------------------
-- 15. Empty country_ids removes all assignments
-- ------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_n  integer;
begin
  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'draft', null, null, null, null, null, null, null, null,
      array[]::uuid[], null) s;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 15: expected exactly 1 result row, got %', v_n;
  end if;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;

  if v_n <> 0 then
    raise exception 'VERIFICATION FAILED 15: empty array left % assignment(s)', v_n;
  end if;

  raise notice 'PASS 15: empty array removed all assignments';
end $$;

-- ------------------------------------------------------------
-- 25/26. is_active and profile_id are untouched by any save
-- ------------------------------------------------------------
do $$
declare
  v_id       uuid := current_setting('app.v27_pending_consultant')::uuid;
  v_active   boolean;
  v_profile  uuid;
  v_active2  boolean;
  v_profile2 uuid;
  v_n        integer;
begin
  select c.is_active, c.profile_id into v_active, v_profile
    from public.consultants c where c.id = v_id;

  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'draft', 'Name', 'https://example.test/a.png', 'male',
      'Headline', 'Bio', 'Africa/Cairo', 12, true, null,
      '{"monday":[{"start":"09:00","end":"17:00"}]}'::jsonb) s;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 25: expected exactly 1 result row, got %', v_n;
  end if;

  select c.is_active, c.profile_id into v_active2, v_profile2
    from public.consultants c where c.id = v_id;

  if v_active is distinct from v_active2 then
    raise exception 'VERIFICATION FAILED 25: is_active changed';
  end if;
  if v_profile is distinct from v_profile2 then
    raise exception 'VERIFICATION FAILED 26: profile_id changed';
  end if;

  raise notice 'PASS 25/26: is_active and profile_id untouched';
end $$;

-- ------------------------------------------------------------
-- Update before completion is REJECTED
-- ------------------------------------------------------------
--
-- Uses the dedicated pending fixture, which no earlier test has
-- submitted. This test always executes; there is no SKIP path.
do $$
declare
  v_update uuid := current_setting('app.v27_update_consultant')::uuid;
  v_marker timestamptz;
begin
  -- Prove the precondition still holds at the moment of the test.
  select c.onboarding_completed_at into v_marker
    from public.consultants c where c.id = v_update;
  if v_marker is not null then
    raise exception
      'VERIFICATION FAILED: dedicated update fixture was completed by an earlier test';
  end if;

  perform public.save_consultant_profile(
    v_update, 'update', null, null, null, null, null, null, null, null, null, null);

  raise exception 'VERIFICATION FAILED: update accepted before completion';
exception when others then
  if sqlerrm like 'CONSULTANT_ONBOARDING_INCOMPLETE%' then
    raise notice 'PASS: update before completion rejected with CONSULTANT_ONBOARDING_INCOMPLETE';
  else raise; end if;
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
  v_n      integer;
begin
  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'submit', 'Submitted Name', 'https://example.test/s.png',
      'female', 'Submitted Headline', 'Submitted Bio',
      'Africa/Cairo', 24, false, array[v_a]::uuid[],
      '{"monday":[{"start":"09:00","end":"17:00"}]}'::jsonb) s;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 18: expected exactly 1 result row, got %', v_n;
  end if;

  select c.gender, c.onboarding_completed_at into v_gender, v_marker
    from public.consultants c where c.id = v_id;

  if v_gender is distinct from 'female' then
    raise exception 'VERIFICATION FAILED 19: gender not persisted (got %)', v_gender;
  end if;
  if v_marker is null then
    raise exception 'VERIFICATION FAILED 18: marker not persisted';
  end if;

  select count(*) into v_n
    from public.consultant_countries cc where cc.consultant_id = v_id;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 18: expected 1 assignment after submit, found %', v_n;
  end if;

  raise notice 'PASS 18/19: submit set the marker, persisted gender and one assignment';
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
  raise exception 'VERIFICATION FAILED 20: second submit accepted';
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
  raise exception 'VERIFICATION FAILED 21: update changed gender';
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
  v_head   text;
  v_n      integer;
begin
  select c.onboarding_completed_at into v_before
    from public.consultants c where c.id = v_id;

  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'update', null, null, 'female', 'Updated Headline',
      null, null, null, null, null, null) s;
  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 22: expected exactly 1 result row, got %', v_n;
  end if;

  select c.onboarding_completed_at, c.headline into v_after, v_head
    from public.consultants c where c.id = v_id;

  if v_after is distinct from v_before then
    raise exception 'VERIFICATION FAILED 23: update moved the marker';
  end if;
  if v_head is distinct from 'Updated Headline' then
    raise exception 'VERIFICATION FAILED 22: update did not persist headline (got %)', v_head;
  end if;

  raise notice 'PASS 22/23: unchanged gender tolerated, headline written, marker preserved';
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
    raise notice 'PASS: draft rejected after completion';
  else raise; end if;
end $$;

-- ------------------------------------------------------------
-- FINAL — every required check executed
-- ------------------------------------------------------------
do $$
begin
  raise notice '=====================================================';
  raise notice 'PART 2 COMPLETE — all behavioural checks passed';
  raise notice 'Rolling back every fixture and every change.';
  raise notice '=====================================================';
end $$;

rollback;   -- discards fixtures and all Part 2 changes


-- ============================================================
-- PART 3 — SCOPE INSPECTION (read-only)
-- ============================================================

-- 28. Table count remains 16.
select count(*) as public_table_count
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';

-- Fixtures left nothing behind.
select
  (select count(*) from public.profiles
    where email like 'v27-%@verification.invalid') as leftover_profiles,
  (select count(*) from public.countries
    where iso_code in ('QV1','QV2','QV3'))         as leftover_countries;

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
