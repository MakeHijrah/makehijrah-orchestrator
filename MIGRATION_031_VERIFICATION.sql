-- ============================================================
-- Verification for migration_031_direct_message_admin_contact
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function shape, grants and non-parameterisation   read-only
--   Part 2  authorised and unauthorised callers               STAGING ONLY, rolls back
--   Part 3  migration 024 left untouched                      read-only
--   Part 4  scope inspection                                  read-only
--   Part 5  rollback guidance
--
-- Part 2 impersonates callers by setting request.jwt.claim.sub
-- transaction-locally, which is the value the standard Supabase
-- auth.uid() reads. No DDL is performed against auth.uid() and no
-- function is redefined, so a concurrent session on the same
-- database is unaffected.
--
-- Part 2 creates every fixture it needs inside a transaction and
-- rolls it back. It reads no business record.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths.
--
-- Check map:
--    1  authorised consultant receives profile_id + avatar_url   Part 2
--    2  returned avatar equals profiles.avatar_url               Part 2
--    3  non-consultant and unauthenticated callers rejected      Part 2
--    4  no arbitrary profile can be requested                    Parts 1, 2
--    5  no private admin field is returned                       Part 1
--    6  get_direct_message_admin() is unchanged                  Part 3
--    7  the two functions select the same administrator          Part 2
--    8  exactly one row is returned                              Part 2
--    9  PUBLIC / anon lack EXECUTE, authenticated holds it       Part 1
--   10  table count remains 16                                   Part 4
--   11  fixtures roll back, asserted not assumed                 Part 2
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, GRANTS AND NON-PARAMETERISATION (read-only)
-- ============================================================

-- Checks 4 and 5: the function takes NO argument, and returns
-- exactly two named columns.
--
-- Check 4 is structural rather than behavioural, and that is the
-- stronger form: a function with zero parameters has no channel
-- through which a caller could name another profile. There is
-- nothing to inject into.

do $$
declare
  v_oid       oid;
  v_overloads integer;
  v_nargs     integer;
  v_result    text;
  v_secdef    boolean;
  v_config    text;
  v_volatile  char;
begin
  v_oid := to_regprocedure('public.get_direct_message_admin_contact()');

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED: public.get_direct_message_admin_contact() does not exist';
  end if;

  -- No overload may accept arguments.
  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_direct_message_admin_contact';

  if v_overloads <> 1 then
    raise exception
      'VERIFICATION FAILED 4: expected exactly one overload, found %', v_overloads;
  end if;

  select p.pronargs,
         pg_get_function_result(p.oid),
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' | '), '(none)'),
         p.provolatile
    into v_nargs, v_result, v_secdef, v_config, v_volatile
    from pg_proc p
   where p.oid = v_oid;

  if v_nargs <> 0 then
    raise exception
      'VERIFICATION FAILED 4: the function accepts % argument(s); a caller could name a profile', v_nargs;
  end if;

  /*
   * Check 5. The result column list is compared exactly. Adding
   * email, phone_whatsapp, role or any other column to the
   * function would change this string and fail here.
   */
  if v_result is distinct from 'TABLE(profile_id uuid, avatar_url text)' then
    raise exception
      'VERIFICATION FAILED 5: result signature is %, expected TABLE(profile_id uuid, avatar_url text)',
      v_result;
  end if;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED: the function is not SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED: search_path is %, expected pg_catalog, public', v_config;
  end if;

  if v_volatile <> 's' then
    raise exception
      'VERIFICATION FAILED: the function is not STABLE (provolatile %)', v_volatile;
  end if;

  raise notice
    'PASS 4: zero arguments and a single overload - no profile can be requested';
  raise notice
    'PASS 5: returns exactly (profile_id uuid, avatar_url text) - no private column';
  raise notice
    'PASS: SECURITY DEFINER, STABLE, search_path=pg_catalog, public';
end $$;


-- The installed body must delegate rather than reimplement, and
-- must not select any private column.

do $$
declare v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure('public.get_direct_message_admin_contact()');

  if v_src not like '%get_direct_message_admin()%' then
    raise exception
      'VERIFICATION FAILED 6: the body does not delegate to get_direct_message_admin()';
  end if;

  if v_src ~* '(p\.email|p\.phone_whatsapp|p\.role|select\s+\*)' then
    raise exception
      'VERIFICATION FAILED 5: the body references a private profiles column or select *';
  end if;

  raise notice
    'PASS: the body delegates to get_direct_message_admin() and selects no private column';
end $$;


-- Check 9: execution rights.
--
-- proacl is inspected directly because PUBLIC is not an ordinary
-- role: it appears as grantee OID 0 and cannot be named in a
-- has_*_privilege call. A null proacl means PostgreSQL defaults
-- are in force, which for a function INCLUDES execute to PUBLIC,
-- so acldefault supplies that case rather than reading null as
-- "no rights".

do $$
declare
  v_oid     oid;
  v_acl     aclitem[];
  v_public  boolean;
  v_anon    boolean;
  v_auth    boolean;
begin
  v_oid := to_regprocedure('public.get_direct_message_admin_contact()');

  select coalesce(p.proacl, acldefault('f', p.proowner))
    into v_acl
    from pg_proc p
   where p.oid = v_oid;

  select
    bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('anon')::oid          and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('authenticated')::oid and a.privilege_type = 'EXECUTE')
    into v_public, v_anon, v_auth
    from aclexplode(v_acl) as a;

  if coalesce(v_public, false) then
    raise exception 'VERIFICATION FAILED 9: PUBLIC holds EXECUTE';
  end if;

  if coalesce(v_anon, false) then
    raise exception 'VERIFICATION FAILED 9: anon holds EXECUTE';
  end if;

  if not coalesce(v_auth, false) then
    raise exception 'VERIFICATION FAILED 9: authenticated lacks EXECUTE';
  end if;

  raise notice 'PASS 9: PUBLIC no, anon no, authenticated yes';
end $$;


-- ============================================================
-- PART 2 — CALLER BEHAVIOUR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================
--
-- Callers are impersonated with request.jwt.claim.sub, the setting
-- the standard Supabase auth.uid() reads. set_config's third
-- argument is true, so every value is transaction-local and
-- disappears with the rollback below.

begin;

do $$
declare
  v_admin_old uuid := gen_random_uuid();
  v_admin_new uuid := gen_random_uuid();
  v_consultant uuid := gen_random_uuid();
  v_client     uuid := gen_random_uuid();
  v_orphan     uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_admin_old,  'v31-admin-old@verification.invalid'),
    (v_admin_new,  'v31-admin-new@verification.invalid'),
    (v_consultant, 'v31-consultant@verification.invalid'),
    (v_client,     'v31-client@verification.invalid');

  /*
   * Two administrators exist on purpose. get_direct_message_admin()
   * selects oldest first with id ascending as the tie-breaker, so
   * the contact function must resolve the OLDER one. A single
   * admin fixture would pass even if selection were arbitrary.
   */
  insert into public.profiles (id, role, full_name, email, avatar_url, created_at) values
    (v_admin_old,  'admin',      'Older Admin',  'v31-admin-old@verification.invalid',
     'https://cdn.test/admin-old.png',  now() - interval '10 days'),
    (v_admin_new,  'admin',      'Newer Admin',  'v31-admin-new@verification.invalid',
     'https://cdn.test/admin-new.png',  now() - interval '1 day'),
    (v_consultant, 'consultant', 'A Consultant', 'v31-consultant@verification.invalid',
     'https://cdn.test/consultant.png', now()),
    (v_client,     'client',     'A Client',     'v31-client@verification.invalid',
     'https://cdn.test/client.png',     now())
  on conflict (id) do update
     set role = excluded.role,
         avatar_url = excluded.avatar_url,
         created_at = excluded.created_at;

  perform set_config('app.v31_admin_old',  v_admin_old::text,  true);
  perform set_config('app.v31_admin_new',  v_admin_new::text,  true);
  perform set_config('app.v31_consultant', v_consultant::text, true);
  perform set_config('app.v31_client',     v_client::text,     true);
  perform set_config('app.v31_orphan',     v_orphan::text,     true);

  raise notice 'FIXTURES CREATED (two admins, one consultant, one client)';
end $$;


-- Checks 1, 2, 7, 8: the authorised consultant path.

do $$
declare
  v_consultant uuid := current_setting('app.v31_consultant')::uuid;
  v_admin_old  uuid := current_setting('app.v31_admin_old')::uuid;
  v_rows       integer;
  v_pid        uuid;
  v_avatar     text;
  v_source     text;
  v_resolver   uuid;
begin
  perform set_config('request.jwt.claim.sub', v_consultant::text, true);

  -- Check 8: exactly one row.
  select count(*) into v_rows
    from public.get_direct_message_admin_contact();

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED 8: expected exactly one row, got %', v_rows;
  end if;

  select c.profile_id, c.avatar_url
    into v_pid, v_avatar
    from public.get_direct_message_admin_contact() c;

  -- Check 1: the selected administrator, deterministically the older one.
  if v_pid is distinct from v_admin_old then
    raise exception
      'VERIFICATION FAILED 1: returned profile_id % is not the deterministically selected admin %',
      v_pid, v_admin_old;
  end if;

  -- Check 7: the two functions agree, by construction and in fact.
  v_resolver := public.get_direct_message_admin();

  if v_pid is distinct from v_resolver then
    raise exception
      'VERIFICATION FAILED 7: contact returned % but the resolver returned %',
      v_pid, v_resolver;
  end if;

  -- Check 2: the avatar is the authoritative stored value.
  select p.avatar_url into v_source
    from public.profiles p
   where p.id = v_admin_old;

  if v_avatar is distinct from v_source then
    raise exception
      'VERIFICATION FAILED 2: returned avatar % does not match profiles.avatar_url %',
      coalesce(v_avatar, '(null)'), coalesce(v_source, '(null)');
  end if;

  if v_avatar is distinct from 'https://cdn.test/admin-old.png' then
    raise exception
      'VERIFICATION FAILED 2: returned avatar is %', coalesce(v_avatar, '(null)');
  end if;

  raise notice
    'PASS 1/8: an authorised consultant receives exactly one row for the selected admin';
  raise notice 'PASS 7: the contact function and the resolver select the same administrator';
  raise notice 'PASS 2: the returned avatar_url equals profiles.avatar_url';
end $$;


-- Check 2 continued: the avatar tracks the source. A value copied
-- at some earlier moment would fail here; a live read cannot.

do $$
declare
  v_consultant uuid := current_setting('app.v31_consultant')::uuid;
  v_admin_old  uuid := current_setting('app.v31_admin_old')::uuid;
  v_avatar     text;
begin
  update public.profiles
     set avatar_url = 'https://cdn.test/admin-changed-in-settings.png'
   where id = v_admin_old;

  perform set_config('request.jwt.claim.sub', v_consultant::text, true);

  select c.avatar_url into v_avatar
    from public.get_direct_message_admin_contact() c;

  if v_avatar is distinct from 'https://cdn.test/admin-changed-in-settings.png' then
    raise exception
      'VERIFICATION FAILED 2: after an /admin/settings change the avatar is %',
      coalesce(v_avatar, '(null)');
  end if;

  -- A null avatar is returned as null, not as an error and not as ''.
  update public.profiles set avatar_url = null where id = v_admin_old;

  select c.avatar_url into v_avatar
    from public.get_direct_message_admin_contact() c;

  if v_avatar is not null then
    raise exception
      'VERIFICATION FAILED 2: a null admin avatar returned "%"', v_avatar;
  end if;

  -- Restore for the checks that follow.
  update public.profiles
     set avatar_url = 'https://cdn.test/admin-old.png'
   where id = v_admin_old;

  raise notice
    'PASS 2: the avatar is read live - it follows an /admin/settings change, and null stays null';
end $$;


-- Check 3: every unauthorised caller is rejected.
--
-- Each case is asserted individually so a single blanket failure
-- cannot masquerade as four passes.

do $$
declare
  v_admin_old uuid := current_setting('app.v31_admin_old')::uuid;
  v_client    uuid := current_setting('app.v31_client')::uuid;
  v_orphan    uuid := current_setting('app.v31_orphan')::uuid;
  v_pid       uuid;
  v_ok        boolean;
begin
  -- 3a. An administrator is not a consultant.
  v_ok := false;
  perform set_config('request.jwt.claim.sub', v_admin_old::text, true);
  begin
    select c.profile_id into v_pid from public.get_direct_message_admin_contact() c;
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'VERIFICATION FAILED 3: an admin caller was served';
  end if;
  raise notice 'PASS 3a: an admin caller is rejected';

  -- 3b. A client is not a consultant.
  v_ok := false;
  perform set_config('request.jwt.claim.sub', v_client::text, true);
  begin
    select c.profile_id into v_pid from public.get_direct_message_admin_contact() c;
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'VERIFICATION FAILED 3: a client caller was served';
  end if;
  raise notice 'PASS 3b: a client caller is rejected';

  -- 3c. An authenticated uuid with no profile row.
  v_ok := false;
  perform set_config('request.jwt.claim.sub', v_orphan::text, true);
  begin
    select c.profile_id into v_pid from public.get_direct_message_admin_contact() c;
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'VERIFICATION FAILED 3: a caller with no profile was served';
  end if;
  raise notice 'PASS 3c: a caller with no profile row is rejected';

  -- 3d. Unauthenticated: auth.uid() resolves to null.
  v_ok := false;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    select c.profile_id into v_pid from public.get_direct_message_admin_contact() c;
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'VERIFICATION FAILED 3: an unauthenticated caller was served';
  end if;
  raise notice 'PASS 3d: an unauthenticated caller is rejected';
end $$;


-- Check 4 behavioural companion: a consultant cannot reach any
-- profile other than the one administrator.
--
-- The structural proof is in Part 1 - the function has no
-- parameters. This adds the observable consequence: the newer
-- admin, the client and the consultant's own row are all
-- unreachable through it, and remain unreadable directly.

do $$
declare
  v_consultant uuid := current_setting('app.v31_consultant')::uuid;
  v_admin_new  uuid := current_setting('app.v31_admin_new')::uuid;
  v_client     uuid := current_setting('app.v31_client')::uuid;
  v_reachable  uuid[];
begin
  perform set_config('request.jwt.claim.sub', v_consultant::text, true);

  select coalesce(array_agg(c.profile_id), '{}')
    into v_reachable
    from public.get_direct_message_admin_contact() c;

  if array_length(v_reachable, 1) <> 1 then
    raise exception
      'VERIFICATION FAILED 4: the function exposed % profiles', array_length(v_reachable, 1);
  end if;

  if v_admin_new = any(v_reachable) then
    raise exception 'VERIFICATION FAILED 4: the non-selected admin is reachable';
  end if;

  if v_client = any(v_reachable) then
    raise exception 'VERIFICATION FAILED 4: a client profile is reachable';
  end if;

  if v_consultant = any(v_reachable) then
    raise exception 'VERIFICATION FAILED 4: the caller''s own profile is returned';
  end if;

  raise notice
    'PASS 4: exactly one profile is reachable, and it is neither the other admin, a client, nor the caller';
end $$;

rollback;


-- Check 11: the rollback is asserted, not assumed.

do $$
declare
  v_profiles integer;
  v_users    integer;
begin
  select count(*) into v_profiles
    from public.profiles
   where email like 'v31-%@verification.invalid';

  select count(*) into v_users
    from auth.users
   where email like 'v31-%@verification.invalid';

  if v_profiles <> 0 then
    raise exception
      'VERIFICATION FAILED 11: % verification profile(s) survived the rollback', v_profiles;
  end if;

  if v_users <> 0 then
    raise exception
      'VERIFICATION FAILED 11: % verification auth user(s) survived the rollback', v_users;
  end if;

  raise notice 'PASS 11: no verification fixture survived';
end $$;


-- ============================================================
-- PART 3 — MIGRATION 024 LEFT UNTOUCHED (read-only)
-- ============================================================

-- Check 6: get_direct_message_admin() is byte-for-byte the
-- function migration 024 installed.
--
-- Every attribute migration 024 set is pinned, including its
-- ORIGINAL search_path. Migration 031 uses the newer hardened
-- pg_catalog, public form for its own function and deliberately
-- does not modernise 024's; if a future edit changes 024's
-- search_path, that is a decision to be made in migration 024, and
-- this check will notice it happening here by accident.

do $$
declare
  v_oid       oid;
  v_overloads integer;
  v_result    text;
  v_nargs     integer;
  v_secdef    boolean;
  v_config    text;
  v_src       text;
  v_public    boolean;
  v_anon      boolean;
  v_auth      boolean;
  v_acl       aclitem[];
begin
  v_oid := to_regprocedure('public.get_direct_message_admin()');

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 6: public.get_direct_message_admin() no longer exists';
  end if;

  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_direct_message_admin';

  if v_overloads <> 1 then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin has % overloads', v_overloads;
  end if;

  select p.pronargs,
         pg_get_function_result(p.oid),
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' | '), '(none)'),
         p.prosrc,
         coalesce(p.proacl, acldefault('f', p.proowner))
    into v_nargs, v_result, v_secdef, v_config, v_src, v_acl
    from pg_proc p
   where p.oid = v_oid;

  if v_nargs <> 0 then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin now takes % argument(s)', v_nargs;
  end if;

  if v_result is distinct from 'uuid' then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin now returns %', v_result;
  end if;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin is no longer SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=public, pg_temp' then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin search_path is now %', v_config;
  end if;

  -- The two decisions that define it: the consultant check and the
  -- deterministic selection order.
  if v_src not like '%only a consultant may resolve the direct message admin%' then
    raise exception
      'VERIFICATION FAILED 6: the consultant authorisation check is missing';
  end if;

  if v_src not like '%order by p.created_at asc, p.id asc%' then
    raise exception
      'VERIFICATION FAILED 6: the deterministic admin selection order changed';
  end if;

  select
    bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('anon')::oid          and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('authenticated')::oid and a.privilege_type = 'EXECUTE')
    into v_public, v_anon, v_auth
    from aclexplode(v_acl) as a;

  if coalesce(v_public, false) or coalesce(v_anon, false) then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin grants widened';
  end if;

  if not coalesce(v_auth, false) then
    raise exception
      'VERIFICATION FAILED 6: get_direct_message_admin lost EXECUTE for authenticated';
  end if;

  raise notice
    'PASS 6: get_direct_message_admin() is unchanged - signature, result, SECURITY DEFINER, its own search_path, logic and grants';
end $$;


-- ============================================================
-- PART 4 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 10: no table was added, and profiles RLS is untouched.

do $$
declare
  v_tables            integer;
  v_profile_policies  text;
  v_profiles_rls      boolean;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  if v_tables <> 16 then
    raise exception
      'VERIFICATION FAILED 10: expected 16 tables, found %', v_tables;
  end if;

  select string_agg(policyname, ', ' order by policyname)
    into v_profile_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles';

  if v_profile_policies is distinct from
     'profiles_select_own_or_admin, profiles_update_own' then
    raise exception
      'VERIFICATION FAILED: profiles policies are now: %', v_profile_policies;
  end if;

  select c.relrowsecurity into v_profiles_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'profiles';

  if not v_profiles_rls then
    raise exception
      'VERIFICATION FAILED: row level security is disabled on public.profiles';
  end if;

  raise notice
    'PASS 10: 16 tables, profiles RLS enabled and its policy set unchanged';
end $$;


do $$
begin
  raise notice 'ALL CHECKS 1-11 COMPLETE - no exception raised';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- To reverse migration 031:
--
--   drop function if exists public.get_direct_message_admin_contact();
--
-- That is the whole reversal. The migration adds one function and
-- changes nothing else: no table, no column, no policy, no grant on
-- any existing object, and no edit to
-- public.get_direct_message_admin().
--
-- Drop it only once no reader calls it, otherwise consultant
-- messaging will error where it previously rendered an avatar.
-- Leaving the function in place is harmless: it is reachable only
-- by an authenticated consultant and returns only the one
-- administrator's id and avatar.
