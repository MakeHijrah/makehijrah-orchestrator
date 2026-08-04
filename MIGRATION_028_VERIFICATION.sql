-- ============================================================
-- Verification for migration_028_consultant_avatar_projection
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function identity, shape and grants   read-only, safe anywhere
--   Part 2  backfill and projection               STAGING ONLY, self-contained, rolls back
--   Part 3  RPC avatar behaviour                  STAGING ONLY, self-contained, rolls back
--   Part 4  scope inspection                      read-only, safe anywhere
--   Part 5  rollback guidance
--
-- Parts 2 and 3 create every fixture they need inside one
-- transaction and roll the whole thing back. They read no business
-- record and depend on no pre-existing consultant, so they run
-- correctly against a staging database holding none.
--
-- Part 2 re-runs the migration's own backfill and synchronisation
-- statements against its fixtures, so it proves the statements
-- themselves rather than a paraphrase of them.
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


-- ============================================================
-- PART 2 — BACKFILL AND PROJECTION (STAGING ONLY, SELF-CONTAINED)
-- ============================================================
--
-- Re-runs the migration's own two statements against fixtures it
-- creates, then rolls everything back.
--
-- Fixture namespacing that cannot collide with real data:
--   profiles.email  v28-<case>@verification.invalid
-- .invalid is reserved by RFC 2606 and can never be a real domain.

begin;

-- ------------------------------------------------------------
-- STAGE 1 — backfill fixtures and statement A
-- ------------------------------------------------------------
--
-- The null-authoritative projection fixture is deliberately NOT
-- created yet. Statement A would adopt its legacy photo into the
-- authoritative field, after which "avatar_url is null" would no
-- longer hold and the statement B test would prove nothing. It is
-- created in stage 2, after A has already run.

do $$
declare
  v_keep_profile   uuid := gen_random_uuid();
  v_adopt_profile  uuid := gen_random_uuid();
  v_stale_profile  uuid := gen_random_uuid();
  v_keep           uuid;
  v_adopt          uuid;
  v_stale          uuid;
  v_n              integer;
  v_avatar         text;
  v_photo          text;
begin
  insert into auth.users (id, email) values
    (v_keep_profile,  'v28-keep@verification.invalid'),
    (v_adopt_profile, 'v28-adopt@verification.invalid'),
    (v_stale_profile, 'v28-stale@verification.invalid');

  get diagnostics v_n = row_count;
  if v_n <> 3 then
    raise exception 'FIXTURE FAILED: expected 3 auth users, inserted %', v_n;
  end if;

  insert into public.profiles (id, role, full_name, email, avatar_url)
  values
    -- Authoritative present, legacy photo different. Must survive A.
    (v_keep_profile,  'consultant', 'V28 Keep',  'v28-keep@verification.invalid',
     'https://cdn.test/authoritative-keep.png'),
    -- Authoritative null, legacy photo present. Must adopt in A.
    (v_adopt_profile, 'consultant', 'V28 Adopt', 'v28-adopt@verification.invalid',
     null),
    -- Authoritative present, projection stale. Must be synced in B.
    (v_stale_profile, 'consultant', 'V28 Stale', 'v28-stale@verification.invalid',
     'https://cdn.test/authoritative-stale.png')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name,
        avatar_url = excluded.avatar_url;

  insert into public.consultants (profile_id, timezone, photo_url)
  values (v_keep_profile, 'Africa/Cairo', 'https://cdn.test/legacy-keep.png')
  returning id into v_keep;

  insert into public.consultants (profile_id, timezone, photo_url)
  values (v_adopt_profile, 'Africa/Cairo', 'https://cdn.test/legacy-adopt.png')
  returning id into v_adopt;

  insert into public.consultants (profile_id, timezone, photo_url)
  values (v_stale_profile, 'Africa/Cairo', 'https://cdn.test/stale-projection.png')
  returning id into v_stale;

  perform set_config('app.v28_keep',    v_keep::text,          true);
  perform set_config('app.v28_adopt',   v_adopt::text,         true);
  perform set_config('app.v28_stale',   v_stale::text,         true);
  perform set_config('app.v28_keep_pr', v_keep_profile::text,  true);
  perform set_config('app.v28_adopt_pr',v_adopt_profile::text, true);
  perform set_config('app.v28_stale_pr',v_stale_profile::text, true);

  -- Fixture state assertions BEFORE statement A.
  select avatar_url into v_avatar from public.profiles where id = v_keep_profile;
  if v_avatar is distinct from 'https://cdn.test/authoritative-keep.png' then
    raise exception 'PRECHECK FAILED: keep fixture avatar_url is %', v_avatar;
  end if;

  select avatar_url into v_avatar from public.profiles where id = v_adopt_profile;
  if v_avatar is not null then
    raise exception 'PRECHECK FAILED: adopt fixture avatar_url is not null';
  end if;

  select photo_url into v_photo from public.consultants where id = v_adopt;
  if v_photo is distinct from 'https://cdn.test/legacy-adopt.png' then
    raise exception 'PRECHECK FAILED: adopt fixture photo_url is %', v_photo;
  end if;

  select photo_url into v_photo from public.consultants where id = v_stale;
  if v_photo is distinct from 'https://cdn.test/stale-projection.png' then
    raise exception 'PRECHECK FAILED: stale fixture photo_url is %', v_photo;
  end if;

  raise notice 'STAGE 1 FIXTURES CREATED AND VERIFIED';

  -- ---------- the migration's statement A, verbatim ----------
  update public.profiles p
  set avatar_url = c.photo_url
  from public.consultants c
  where c.profile_id = p.id
    and p.avatar_url is null
    and c.photo_url is not null;

  -- Check 1: an existing authoritative value is never overwritten.
  select avatar_url into v_avatar
    from public.profiles where id = v_keep_profile;
  if v_avatar is distinct from 'https://cdn.test/authoritative-keep.png' then
    raise exception
      'VERIFICATION FAILED 1: backfill overwrote an existing avatar_url (now %)', v_avatar;
  end if;
  raise notice 'PASS 1: existing profiles.avatar_url survived the backfill';

  -- Check 2: a null authoritative value adopts the legacy photo.
  select avatar_url into v_avatar
    from public.profiles where id = v_adopt_profile;
  if v_avatar is distinct from 'https://cdn.test/legacy-adopt.png' then
    raise exception
      'VERIFICATION FAILED 2: null avatar_url did not adopt the legacy photo (got %)', v_avatar;
  end if;
  raise notice 'PASS 2: null avatar_url adopted consultants.photo_url';

  -- Idempotence of statement A: every eligible row is already
  -- backfilled, so a second run must affect zero rows.
  update public.profiles p
  set avatar_url = c.photo_url
  from public.consultants c
  where c.profile_id = p.id
    and p.avatar_url is null
    and c.photo_url is not null;

  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception
      'VERIFICATION FAILED: re-running statement A affected % row(s), expected 0', v_n;
  end if;
  raise notice 'PASS: statement A is idempotent (second run affected 0 rows)';
end $$;


-- ------------------------------------------------------------
-- STAGE 2 — null-authoritative fixture, created AFTER statement A
-- ------------------------------------------------------------
--
-- This is the fixture the previous version of this file got wrong.
-- Creating it before statement A meant the backfill populated its
-- authoritative field, so the later assertion compared photo_url
-- against a value that was equal for the wrong reason and proved
-- nothing about statement B.
--
-- Created here, after A has run and will not run again, its
-- authoritative field is genuinely null when B executes.

do $$
declare
  v_legacy_profile uuid := gen_random_uuid();
  v_legacy         uuid;
  v_avatar         text;
  v_photo          text;
begin
  insert into auth.users (id, email)
  values (v_legacy_profile, 'v28-legacy@verification.invalid');

  insert into public.profiles (id, role, full_name, email, avatar_url)
  values (v_legacy_profile, 'consultant', 'V28 Legacy',
          'v28-legacy@verification.invalid', null)
  on conflict (id) do update
    set avatar_url = excluded.avatar_url;

  insert into public.consultants (profile_id, timezone, photo_url)
  values (v_legacy_profile, 'Africa/Cairo', 'https://cdn.test/legacy-only.png')
  returning id into v_legacy;

  perform set_config('app.v28_legacy',    v_legacy::text,         true);
  perform set_config('app.v28_legacy_pr', v_legacy_profile::text, true);

  -- Fixture state assertions IMMEDIATELY BEFORE statement B.
  select avatar_url into v_avatar from public.profiles where id = v_legacy_profile;
  if v_avatar is not null then
    raise exception
      'PRECHECK FAILED: null-authoritative fixture avatar_url is % - statement B cannot be tested',
      v_avatar;
  end if;

  select photo_url into v_photo from public.consultants where id = v_legacy;
  if v_photo is distinct from 'https://cdn.test/legacy-only.png' then
    raise exception
      'PRECHECK FAILED: null-authoritative fixture photo_url is %', v_photo;
  end if;

  raise notice 'STAGE 2 FIXTURE CREATED: avatar_url IS NULL, photo_url = legacy-only.png';
end $$;


-- ------------------------------------------------------------
-- STAGE 3 — statement B and its assertions
-- ------------------------------------------------------------

do $$
declare
  v_keep      uuid := current_setting('app.v28_keep')::uuid;
  v_stale     uuid := current_setting('app.v28_stale')::uuid;
  v_legacy    uuid := current_setting('app.v28_legacy')::uuid;
  v_legacy_pr uuid := current_setting('app.v28_legacy_pr')::uuid;
  v_avatar    text;
  v_photo     text;
  v_n         integer;
begin
  -- ---------- the migration's statement B, verbatim ----------
  update public.consultants c
  set photo_url = p.avatar_url
  from public.profiles p
  where p.id = c.profile_id
    and p.avatar_url is not null
    and c.photo_url is distinct from p.avatar_url;

  -- Check 3: the projection is synchronised from the authoritative field.
  select photo_url into v_photo
    from public.consultants where id = v_stale;
  if v_photo is distinct from 'https://cdn.test/authoritative-stale.png' then
    raise exception
      'VERIFICATION FAILED 3: stale projection was not synchronised (got %)', v_photo;
  end if;

  select photo_url into v_photo
    from public.consultants where id = v_keep;
  if v_photo is distinct from 'https://cdn.test/authoritative-keep.png' then
    raise exception
      'VERIFICATION FAILED 3: projection did not follow the surviving authoritative value (got %)', v_photo;
  end if;
  raise notice 'PASS 3: projection synchronised from profiles.avatar_url';

  -- Check 3b: a NULL authoritative value never clears the projection.
  --
  -- This is now a real proof: the fixture's avatar_url was still
  -- null when statement B ran, so B had to skip it by its own
  -- predicate rather than by coincidence.
  select avatar_url into v_avatar
    from public.profiles where id = v_legacy_pr;
  if v_avatar is not null then
    raise exception
      'VERIFICATION FAILED 3b: statement B populated avatar_url (now %) - it must never write profiles',
      v_avatar;
  end if;

  select photo_url into v_photo
    from public.consultants where id = v_legacy;
  if v_photo is distinct from 'https://cdn.test/legacy-only.png' then
    raise exception
      'VERIFICATION FAILED 3b: projection was cleared or altered where avatar_url is null (got %)', v_photo;
  end if;
  raise notice 'PASS 3b: avatar_url still NULL and photo_url unchanged at legacy-only.png';

  -- Idempotence of statement B: everything eligible is already
  -- synchronised, so a second run must affect zero rows.
  update public.consultants c
  set photo_url = p.avatar_url
  from public.profiles p
  where p.id = c.profile_id
    and p.avatar_url is not null
    and c.photo_url is distinct from p.avatar_url;

  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception
      'VERIFICATION FAILED: re-running statement B affected % row(s), expected 0', v_n;
  end if;
  raise notice 'PASS: statement B is idempotent (second run affected 0 rows)';

  raise notice 'PART 2 COMPLETE - backfill and projection proven independently';
end $$;

rollback;   -- discards Part 2 fixtures and changes


-- ============================================================
-- PART 3 — RPC AVATAR BEHAVIOUR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================

begin;

do $$
declare
  v_profile  uuid := gen_random_uuid();
  v_other_pr uuid := gen_random_uuid();
  v_id       uuid;
  v_other    uuid;
  v_n        integer;
begin
  insert into auth.users (id, email) values
    (v_profile,  'v28-rpc@verification.invalid'),
    (v_other_pr, 'v28-rpc-other@verification.invalid');

  insert into public.profiles (id, role, full_name, email, avatar_url)
  values
    (v_profile,  'consultant', 'V28 RPC',   'v28-rpc@verification.invalid',
     'https://cdn.test/before.png'),
    (v_other_pr, 'consultant', 'V28 Other', 'v28-rpc-other@verification.invalid',
     'https://cdn.test/other-avatar.png')
  on conflict (id) do update
    set avatar_url = excluded.avatar_url;

  insert into public.consultants
    (profile_id, timezone, photo_url, headline, bio, gender, available_for_general)
  values
    (v_profile, 'Africa/Cairo', 'https://cdn.test/before.png',
     'Headline', 'Bio', null, true)
  returning id into v_id;

  insert into public.consultants
    (profile_id, timezone, photo_url, headline, bio, gender, available_for_general)
  values
    (v_other_pr, 'Africa/Cairo', 'https://cdn.test/other-photo.png',
     'Other headline', 'Other bio', null, true)
  returning id into v_other;

  perform set_config('app.v28_rpc',       v_id::text,       true);
  perform set_config('app.v28_rpc_other', v_other::text,    true);
  perform set_config('app.v28_rpc_pr',    v_profile::text,  true);
  perform set_config('app.v28_other_pr',  v_other_pr::text, true);

  select count(*) into v_n from public.consultants where id in (v_id, v_other);
  if v_n <> 2 then
    raise exception 'FIXTURE FAILED: expected 2 consultants, found %', v_n;
  end if;

  raise notice 'FIXTURES CREATED';
end $$;


-- Check 4: a non-null p_avatar_url updates BOTH fields to that value.
do $$
declare
  v_id     uuid := current_setting('app.v28_rpc')::uuid;
  v_pr     uuid := current_setting('app.v28_rpc_pr')::uuid;
  v_avatar text;
  v_photo  text;
  v_n      integer;
begin
  select count(*) into v_n
    from public.save_consultant_profile(
      v_id, 'draft', null, 'https://cdn.test/after.png',
      null, null, null, null, null, null, null, null) s;

  if v_n <> 1 then
    raise exception 'VERIFICATION FAILED 4: expected exactly 1 result row, got %', v_n;
  end if;

  select avatar_url into v_avatar from public.profiles where id = v_pr;
  select photo_url  into v_photo  from public.consultants where id = v_id;

  if v_avatar is distinct from 'https://cdn.test/after.png' then
    raise exception 'VERIFICATION FAILED 4: profiles.avatar_url is % ', v_avatar;
  end if;
  if v_photo is distinct from 'https://cdn.test/after.png' then
    raise exception 'VERIFICATION FAILED 4: consultants.photo_url is % ', v_photo;
  end if;
  if v_avatar is distinct from v_photo then
    raise exception 'VERIFICATION FAILED 4: the two avatar fields diverged';
  end if;

  raise notice 'PASS 4: both avatar fields written to the same value in one call';
end $$;


-- Check 5: a null p_avatar_url preserves BOTH fields.
do $$
declare
  v_id     uuid := current_setting('app.v28_rpc')::uuid;
  v_pr     uuid := current_setting('app.v28_rpc_pr')::uuid;
  v_avatar text;
  v_photo  text;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', 'Renamed Only', null,
    null, 'New headline', null, null, null, null, null, null);

  select avatar_url into v_avatar from public.profiles where id = v_pr;
  select photo_url  into v_photo  from public.consultants where id = v_id;

  if v_avatar is distinct from 'https://cdn.test/after.png' then
    raise exception 'VERIFICATION FAILED 5: null argument changed avatar_url to %', v_avatar;
  end if;
  if v_photo is distinct from 'https://cdn.test/after.png' then
    raise exception 'VERIFICATION FAILED 5: null argument changed photo_url to %', v_photo;
  end if;

  raise notice 'PASS 5: null p_avatar_url preserved both avatar fields';
end $$;


-- Check 6: a failed call changes NEITHER avatar field.
do $$
declare
  v_id     uuid := current_setting('app.v28_rpc')::uuid;
  v_pr     uuid := current_setting('app.v28_rpc_pr')::uuid;
  v_avatar text;
  v_photo  text;
begin
  begin
    -- A real avatar change supplied alongside an invalid country.
    perform public.save_consultant_profile(
      v_id, 'draft', null, 'https://cdn.test/must-not-persist.png',
      null, null, null, null, null, null,
      array['99999999-9999-4999-8999-999999999999'::uuid]::uuid[], null);
    raise exception 'VERIFICATION FAILED 6: invalid country did not abort';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then raise; end if;
  end;

  select avatar_url into v_avatar from public.profiles where id = v_pr;
  select photo_url  into v_photo  from public.consultants where id = v_id;

  if v_avatar is distinct from 'https://cdn.test/after.png' then
    raise exception 'VERIFICATION FAILED 6: avatar_url survived a failed save as %', v_avatar;
  end if;
  if v_photo is distinct from 'https://cdn.test/after.png' then
    raise exception 'VERIFICATION FAILED 6: photo_url survived a failed save as %', v_photo;
  end if;

  raise notice 'PASS 6: failed save changed neither avatar field';
end $$;


-- Check 7: another consultant's avatar fields are untouched.
do $$
declare
  v_id     uuid := current_setting('app.v28_rpc')::uuid;
  v_other  uuid := current_setting('app.v28_rpc_other')::uuid;
  v_opr    uuid := current_setting('app.v28_other_pr')::uuid;
  v_avatar text;
  v_photo  text;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, 'https://cdn.test/mine-only.png',
    null, null, null, null, null, null, null, null);

  select avatar_url into v_avatar from public.profiles where id = v_opr;
  select photo_url  into v_photo  from public.consultants where id = v_other;

  if v_avatar is distinct from 'https://cdn.test/other-avatar.png' then
    raise exception 'VERIFICATION FAILED 7: other consultant avatar_url changed to %', v_avatar;
  end if;
  if v_photo is distinct from 'https://cdn.test/other-photo.png' then
    raise exception 'VERIFICATION FAILED 7: other consultant photo_url changed to %', v_photo;
  end if;

  raise notice 'PASS 7: another consultant''s avatar fields untouched';
end $$;


do $$
begin
  raise notice '=====================================================';
  raise notice 'PARTS 2 AND 3 COMPLETE - all behavioural checks passed';
  raise notice 'Rolling back every fixture and every change.';
  raise notice '=====================================================';
end $$;

rollback;   -- discards Part 3 fixtures and changes


-- ============================================================
-- PART 4 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 15: the migration 026 trigger remains present and bound.
select t.tgname, p.proname as function_name, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc  p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'consultants'
   and not t.tgisinternal
 order by t.tgname;

select prosrc like '%CONSULTANT_GENDER_IMMUTABLE%'            as has_gender_lock,
       prosrc like '%CONSULTANT_ONBOARDING_MARKER_IMMUTABLE%' as has_marker_lock
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'guard_consultants_columns';

-- Check 16: RLS policies unchanged. profiles in particular must be
-- exactly what it was before this migration - no new policy, no
-- widened USING clause, no public read.
select tablename, policyname, cmd, roles::text,
       coalesce(qual, '-') as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('profiles', 'consultants')
 order by tablename, policyname;

select c.relname, c.relrowsecurity as rls_enabled
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('profiles', 'consultants');

-- Check 17: table count remains 16.
select count(*) as public_table_count
  from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';

-- Check 18: fixtures left nothing behind.
select
  (select count(*) from public.profiles
    where email like 'v28-%@verification.invalid') as leftover_profiles,
  (select count(*) from public.consultants c
     join public.profiles p on p.id = c.profile_id
    where p.email like 'v28-%@verification.invalid')  as leftover_consultants;

-- Steady state after applying: nothing left to adopt, nothing stale.
select
  (select count(*) from public.profiles p
     join public.consultants c on c.profile_id = p.id
    where p.avatar_url is null and c.photo_url is not null) as unadopted_legacy,
  (select count(*) from public.consultants c
     join public.profiles p on p.id = c.profile_id
    where p.avatar_url is not null
      and c.photo_url is distinct from p.avatar_url)        as stale_projections;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 028 changes one function body and two columns' data. It
-- has no schema change to reverse.
--
-- Function rollback - restore the migration 027 body:
--
--   Re-run supabase/migrations/migration_027_atomic_consultant_profile_save.sql.
--   It is a CREATE OR REPLACE with identical grants, so re-running
--   it restores the pre-028 behaviour exactly. The projection then
--   stops being maintained; it does not become wrong retroactively.
--
-- Kill switch without a rollback and without a deployment:
--
--   revoke execute on function public.save_consultant_profile(
--     uuid, text, text, text, text, text, text, text,
--     integer, boolean, uuid[], jsonb) from service_role;
--
-- Data rollback:
--
--   NOT recommended and NOT required. The backfill only populated
--   profiles.avatar_url where it was null, and the synchronisation
--   only aligned a projection with its authoritative source. Both
--   are corrections, not losses. Reversing them would reintroduce
--   the divergence this migration exists to remove.
--
--   In particular, do NOT null out profiles.avatar_url values that
--   the backfill populated: after the backfill they are the
--   consultant's authoritative photograph, and no record survives
--   of which ones were adopted.
