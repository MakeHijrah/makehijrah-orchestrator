-- ============================================================
-- Verification for migration_030_consultant_display_name_projection
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function identity, shape and grants   read-only, safe anywhere
--   Part 2  column and backfill behaviour         STAGING ONLY, self-contained, rolls back
--   Part 3  RPC projection behaviour              STAGING ONLY, self-contained, rolls back
--   Part 4  scope inspection                      read-only, safe anywhere
--   Part 5  rollback guidance
--
-- Parts 2 and 3 create every fixture they need inside a
-- transaction and roll it back. They read no business record and
-- leave nothing behind.
--
-- Part 2 runs the migration's OWN backfill statement against its
-- fixtures, so it proves the statement itself rather than a
-- paraphrase of it.
--
-- Two DIFFERENT failure modes are tested, and they prove different
-- things. Conflating them is the defect this file was corrected
-- for:
--
--   6a  EARLY REJECTION — an invalid country id is caught in RPC
--       section 6, before section 7 or 8 has written anything.
--       Proves validation order. Proves NOTHING about rollback,
--       because no write had occurred.
--
--   6b  CONTROLLED FAILURE AFTER THE WRITES — a temporary trigger
--       raises once every field under test has already been
--       updated. This is the real rollback proof.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths:
-- no check is conditional on data that may or may not be present.
--
-- Check map:
--    1  display_name column exists                    Part 2
--    2  full_name backfills display_name              Part 2
--    3  matching projection remains stable            Part 2
--    4  p_full_name updates both fields               Part 3
--    5  null p_full_name preserves both fields        Part 3
--   6a  invalid country rejected before any mutation  Part 3
--   6b  post-write failure rolls back every field     Part 3
--    7  another consultant remains untouched          Part 3
--    8  avatar projection still works                 Part 3
--    9  working hours still store numeric keys        Part 3
--   10  country writes remain atomic                  Part 3
--   11  exact function signature unchanged            Part 1
--   12  parameter names unchanged                     Part 1
--   13  SECURITY DEFINER remains true                 Part 1
--   14  search_path remains pg_catalog, public        Part 1
--   15  PUBLIC lacks EXECUTE                          Part 1
--   16  anon lacks EXECUTE                            Part 1
--   17  authenticated lacks EXECUTE                   Part 1
--   18  service_role retains EXECUTE                  Part 1
--   19  RLS policies remain unchanged                 Part 4
--   20  table count remains 16                        Part 4
--   21  all fixtures roll back, asserted not assumed  Parts 2, 3
--   22  no SKIP paths                                 whole file
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION IDENTITY, SHAPE AND GRANTS (read-only)
-- ============================================================

-- Checks 11, 12, 13, 14: signature, parameter names, SECURITY
-- DEFINER, search_path.

do $$
declare
  v_oid       oid;
  v_overloads integer;
  v_secdef    boolean;
  v_config    text;
  v_args      text;
  v_expected  text :=
    'p_consultant_id uuid, p_mode text, p_full_name text, '
    || 'p_avatar_url text, p_gender text, p_headline text, '
    || 'p_bio text, p_timezone text, '
    || 'p_minimum_booking_notice_hours integer, '
    || 'p_available_for_general boolean, p_country_ids uuid[], '
    || 'p_working_hours jsonb';
begin
  v_oid := to_regprocedure(
    'public.save_consultant_profile('
    || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
  );

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 11: the exact 12-argument save_consultant_profile does not exist';
  end if;

  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'save_consultant_profile';

  if v_overloads <> 1 then
    raise exception
      'VERIFICATION FAILED 11: expected exactly one overload, found %', v_overloads;
  end if;

  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' | '), '(none)'),
         pg_get_function_identity_arguments(p.oid)
    into v_secdef, v_config, v_args
    from pg_proc p
   where p.oid = v_oid;

  /*
   * pg_get_function_identity_arguments returns NAME-qualified
   * arguments, not a bare type list, so the comparison string
   * carries the parameter names. That is what makes this a real
   * check 12 rather than a second copy of check 11.
   */
  if v_args is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 12: parameter names or types changed. Found: %', v_args;
  end if;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 13: function is not SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 14: search_path is %', v_config;
  end if;

  raise notice
    'PASS 11-14: exact signature, single overload, parameter names, SECURITY DEFINER, search_path';
end $$;


-- Checks 15, 16, 17, 18: execution rights.
--
-- proacl is inspected directly rather than through
-- has_function_privilege, because PUBLIC is not an ordinary role:
-- it appears in an ACL as grantee OID 0 and cannot be named in a
-- has_*_privilege call. A null proacl means "PostgreSQL defaults
-- are in force", which for a function INCLUDES execute to PUBLIC,
-- so acldefault supplies that case rather than treating null as
-- "no rights".

do $$
declare
  v_oid      oid;
  v_owner    oid;
  v_acl      aclitem[];
  v_public   boolean;
  v_anon     boolean;
  v_auth     boolean;
  v_service  boolean;
begin
  v_oid := to_regprocedure(
    'public.save_consultant_profile('
    || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
  );

  select p.proowner, coalesce(p.proacl, acldefault('f', p.proowner))
    into v_owner, v_acl
    from pg_proc p
   where p.oid = v_oid;

  select
    bool_or(a.grantee = 0                and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('anon')::oid          and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('authenticated')::oid and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('service_role')::oid  and a.privilege_type = 'EXECUTE')
    into v_public, v_anon, v_auth, v_service
    from aclexplode(v_acl) as a;

  if coalesce(v_public, false) then
    raise exception 'VERIFICATION FAILED 15: PUBLIC holds EXECUTE';
  end if;

  if coalesce(v_anon, false) then
    raise exception 'VERIFICATION FAILED 16: anon holds EXECUTE';
  end if;

  if coalesce(v_auth, false) then
    raise exception 'VERIFICATION FAILED 17: authenticated holds EXECUTE';
  end if;

  if not coalesce(v_service, false) then
    raise exception 'VERIFICATION FAILED 18: service_role lacks EXECUTE';
  end if;

  raise notice
    'PASS 15-18: PUBLIC no, anon no, authenticated no, service_role yes';
end $$;


-- The installed body must actually write the display-name
-- projection, and must still write the avatar projection and the
-- numeric working-hours conversion. A migration that ran but left
-- an older body installed would pass every check above.

do $$
declare v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure(
     'public.save_consultant_profile('
     || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)');

  if v_src not like '%display_name%coalesce(p_full_name%' then
    raise exception
      'VERIFICATION FAILED: the installed function does not project display_name';
  end if;

  if v_src not like '%photo_url%coalesce(p_avatar_url%' then
    raise exception
      'VERIFICATION FAILED 8: the migration 028 avatar projection is missing';
  end if;

  if v_src not like '%CONSULTANT_WORKING_HOURS_FORMAT_INVALID%' then
    raise exception
      'VERIFICATION FAILED 9: the migration 029 working-hours validation is missing';
  end if;

  raise notice
    'PASS: installed body projects display_name, and 028 avatar plus 029 working hours are intact';
end $$;


-- ============================================================
-- PART 2 — COLUMN AND BACKFILL (STAGING ONLY, SELF-CONTAINED)
-- ============================================================

begin;

-- Check 1: the column exists, is nullable, and has no default.
--
-- Nullability matters: a NOT NULL or DEFAULT '' column would make
-- "this consultant has no name yet" indistinguishable from "this
-- consultant's name is the empty string".

do $$
declare
  v_nullable text;
  v_default  text;
  v_type     text;
begin
  select is_nullable, column_default, data_type
    into v_nullable, v_default, v_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'consultants'
     and column_name  = 'display_name';

  if not found then
    raise exception
      'VERIFICATION FAILED 1: public.consultants.display_name does not exist';
  end if;

  if v_type <> 'text' then
    raise exception 'VERIFICATION FAILED 1: display_name is %, expected text', v_type;
  end if;

  if v_nullable <> 'YES' then
    raise exception 'VERIFICATION FAILED 1: display_name is NOT NULL';
  end if;

  if v_default is not null then
    raise exception
      'VERIFICATION FAILED 1: display_name has default %, expected none', v_default;
  end if;

  raise notice 'PASS 1: display_name exists as nullable text with no default';
end $$;


-- Checks 2 and 3: the migration's own backfill statement, run
-- verbatim against three fixtures created AFTER the migration
-- already ran.
--
-- The fixtures are created here on purpose. Had they existed
-- before the migration, the migration's own backfill would already
-- have populated them and the assertions below would prove
-- nothing.
--
--   needs_backfill  full_name set, display_name null   -> filled
--   already_matches full_name = display_name           -> untouched
--   null_name       full_name null                     -> stays null
--
-- The third fixture is the one that proves null is not coerced to
-- an empty string.

do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_ida uuid;
  v_idb uuid;
  v_idc uuid;
  v_rows integer;
  v_got  text;
begin
  insert into auth.users (id, email) values
    (v_a, 'v30-fill@verification.invalid'),
    (v_b, 'v30-same@verification.invalid'),
    (v_c, 'v30-null@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_a, 'consultant', 'Backfill Me',   'v30-fill@verification.invalid'),
    (v_b, 'consultant', 'Already Right', 'v30-same@verification.invalid'),
    (v_c, 'consultant', null,            'v30-null@verification.invalid')
  on conflict (id) do update set full_name = excluded.full_name;

  insert into public.consultants (profile_id, timezone, display_name)
  values (v_a, 'Africa/Cairo', null)            returning id into v_ida;
  insert into public.consultants (profile_id, timezone, display_name)
  values (v_b, 'Africa/Cairo', 'Already Right') returning id into v_idb;
  insert into public.consultants (profile_id, timezone, display_name)
  values (v_c, 'Africa/Cairo', null)            returning id into v_idc;

  -- === the migration's backfill statement, verbatim ===
  update public.consultants c
     set display_name = p.full_name
    from public.profiles p
   where p.id = c.profile_id
     and p.full_name is not null
     and c.display_name is distinct from p.full_name;

  get diagnostics v_rows = row_count;

  -- Check 2: the null projection was filled from the authoritative name.
  select display_name into v_got from public.consultants where id = v_ida;
  if v_got is distinct from 'Backfill Me' then
    raise exception
      'VERIFICATION FAILED 2: display_name is %, expected Backfill Me', coalesce(v_got, '(null)');
  end if;

  -- Check 3: the already-matching row was not rewritten. Exactly one
  -- row needed work, so a count above one means a stable row moved.
  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED 3: backfill touched % rows, expected exactly 1', v_rows;
  end if;

  select display_name into v_got from public.consultants where id = v_idb;
  if v_got is distinct from 'Already Right' then
    raise exception
      'VERIFICATION FAILED 3: a matching projection changed to %', coalesce(v_got, '(null)');
  end if;

  -- A null authoritative name leaves the projection null, never ''.
  select display_name into v_got from public.consultants where id = v_idc;
  if v_got is not null then
    raise exception
      'VERIFICATION FAILED 2: a null full_name produced "%" instead of null', v_got;
  end if;

  raise notice 'PASS 2: null projection backfilled from the authoritative name';
  raise notice 'PASS 3: matching projection stable, null name stays null (not blanked)';

  -- Idempotence: a second run of the same statement moves nothing.
  update public.consultants c
     set display_name = p.full_name
    from public.profiles p
   where p.id = c.profile_id
     and p.full_name is not null
     and c.display_name is distinct from p.full_name;

  get diagnostics v_rows = row_count;

  if v_rows <> 0 then
    raise exception
      'VERIFICATION FAILED 3: the backfill is not idempotent, second run touched % rows', v_rows;
  end if;

  raise notice 'PASS 3: backfill is idempotent (second run touched 0 rows)';
end $$;

rollback;

-- Check 21 (Part 2): the rollback is asserted, not assumed.
do $$
declare
  v_profiles    integer;
  v_consultants integer;
begin
  select count(*) into v_profiles
    from public.profiles
   where email like 'v30-%@verification.invalid';

  select count(*) into v_consultants
    from public.consultants c
    join public.profiles p on p.id = c.profile_id
   where p.email like 'v30-%@verification.invalid';

  if v_profiles <> 0 then
    raise exception
      'VERIFICATION FAILED 21: % Part 2 verification profile(s) survived the rollback', v_profiles;
  end if;

  if v_consultants <> 0 then
    raise exception
      'VERIFICATION FAILED 21: % Part 2 verification consultant(s) survived the rollback', v_consultants;
  end if;

  raise notice 'PASS 21 (Part 2): no verification profile or consultant survived';
end $$;


-- ============================================================
-- PART 3 — RPC PROJECTION BEHAVIOUR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================

begin;

do $$
declare
  v_pr    uuid := gen_random_uuid();
  v_opr   uuid := gen_random_uuid();
  v_id    uuid;
  v_other uuid;
  v_cid   uuid;
  v_cid2  uuid;
begin
  insert into auth.users (id, email) values
    (v_pr,  'v30-rpc@verification.invalid'),
    (v_opr, 'v30-rpc-other@verification.invalid');

  insert into public.profiles (id, role, full_name, email, avatar_url) values
    (v_pr,  'consultant', 'Original Name', 'v30-rpc@verification.invalid',       'https://cdn.test/a.png'),
    (v_opr, 'consultant', 'Other Name',    'v30-rpc-other@verification.invalid', 'https://cdn.test/o.png')
  on conflict (id) do update
     set full_name = excluded.full_name, avatar_url = excluded.avatar_url;

  insert into public.consultants
    (profile_id, timezone, display_name, photo_url, working_hours_jsonb, headline, bio)
  values (v_pr, 'Africa/Cairo', 'Original Name', 'https://cdn.test/a.png',
          '{"1":[{"start":"08:00","end":"09:00"}]}'::jsonb, 'H', 'B')
  returning id into v_id;

  insert into public.consultants
    (profile_id, timezone, display_name, photo_url, working_hours_jsonb, headline, bio)
  values (v_opr, 'Africa/Cairo', 'Other Name', 'https://cdn.test/o.png',
          '{"2":[{"start":"10:00","end":"11:00"}]}'::jsonb, 'OH', 'OB')
  returning id into v_other;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ V30 Country', 'QW3', true) returning id into v_cid;

  /*
   * A second country exists so the post-write rollback check can
   * attempt a country REPLACEMENT and prove the delete-then-insert
   * in RPC section 6 is undone, not merely that no row was added.
   */
  insert into public.countries (name, iso_code, is_active)
  values ('ZZ V30 Country Two', 'QW4', true) returning id into v_cid2;

  perform set_config('app.v30_rpc',       v_id::text,    true);
  perform set_config('app.v30_rpc_other', v_other::text, true);
  perform set_config('app.v30_rpc_pr',    v_pr::text,    true);
  perform set_config('app.v30_country',   v_cid::text,   true);
  perform set_config('app.v30_country2',  v_cid2::text,  true);

  raise notice 'FIXTURES CREATED';
end $$;


-- Check 4: a non-null p_full_name writes BOTH the authoritative
-- field and the projection, to the same value, in one call.

do $$
declare
  v_id   uuid := current_setting('app.v30_rpc')::uuid;
  v_auth text;
  v_proj text;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', 'Renamed Consultant', null, null, null, null, null,
    null, null, null, null);

  select pr.full_name, c.display_name
    into v_auth, v_proj
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_auth is distinct from 'Renamed Consultant' then
    raise exception
      'VERIFICATION FAILED 4: authoritative full_name is %', coalesce(v_auth, '(null)');
  end if;

  if v_proj is distinct from 'Renamed Consultant' then
    raise exception
      'VERIFICATION FAILED 4: projected display_name is %', coalesce(v_proj, '(null)');
  end if;

  if v_auth is distinct from v_proj then
    raise exception 'VERIFICATION FAILED 4: the two fields diverged';
  end if;

  raise notice 'PASS 4: p_full_name wrote both fields to the same value';
end $$;


-- Check 5: a null p_full_name preserves BOTH fields. It must not
-- blank the projection and must not blank the authoritative field.

do $$
declare
  v_id   uuid := current_setting('app.v30_rpc')::uuid;
  v_auth text;
  v_proj text;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', null, null, null, 'A new headline', null, null,
    null, null, null, null);

  select pr.full_name, c.display_name
    into v_auth, v_proj
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_auth is distinct from 'Renamed Consultant' then
    raise exception
      'VERIFICATION FAILED 5: null p_full_name changed full_name to %', coalesce(v_auth, '(null)');
  end if;

  if v_proj is distinct from 'Renamed Consultant' then
    raise exception
      'VERIFICATION FAILED 5: null p_full_name changed display_name to %', coalesce(v_proj, '(null)');
  end if;

  raise notice 'PASS 5: null p_full_name preserved both fields';
end $$;


-- Check 6a: EARLY REJECTION, BEFORE ANY MUTATION.
--
-- This is NOT a rollback proof, and must not be read as one.
--
-- An invalid country id is rejected in RPC section 6, which runs
-- BEFORE the authoritative profile update in section 7 and before
-- the consultant update in section 8. Nothing has been written
-- when the exception is raised, so "the fields are unchanged"
-- afterwards proves only that validation happens early. It would
-- hold true even in a function with no transactional guarantees
-- whatsoever.
--
-- What it does establish, and all it establishes: an invalid
-- country id is caught before mutation begins.
--
-- The genuine rollback proof — a controlled failure raised AFTER
-- the writes have happened — is check 6b, further below.

do $$
declare
  v_id     uuid := current_setting('app.v30_rpc')::uuid;
  v_before record;
  v_after  record;
  v_n      integer;
begin
  select pr.full_name, c.display_name, pr.avatar_url, c.photo_url,
         c.working_hours_jsonb
    into v_before
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  begin
    perform public.save_consultant_profile(
      v_id, 'draft', 'Should Not Persist', 'https://cdn.test/should-not-persist.png',
      null, null, null, null, null, null,
      array[gen_random_uuid()]::uuid[],
      '{"friday":[{"start":"14:00","end":"16:00"}]}'::jsonb);

    raise exception
      'VERIFICATION FAILED 6a: an invalid country id was accepted';
  exception when others then
    if sqlerrm not like 'CONSULTANT_COUNTRY_INVALID%' then
      raise;
    end if;
  end;

  select pr.full_name, c.display_name, pr.avatar_url, c.photo_url,
         c.working_hours_jsonb
    into v_after
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_after.full_name is distinct from v_before.full_name
     or v_after.display_name is distinct from v_before.display_name then
    raise exception
      'VERIFICATION FAILED 6a: early rejection left full_name=% display_name=%',
      coalesce(v_after.full_name, '(null)'), coalesce(v_after.display_name, '(null)');
  end if;

  if v_after.avatar_url is distinct from v_before.avatar_url
     or v_after.photo_url is distinct from v_before.photo_url then
    raise exception
      'VERIFICATION FAILED 6a: early rejection changed the avatar pair';
  end if;

  if v_after.working_hours_jsonb is distinct from v_before.working_hours_jsonb then
    raise exception
      'VERIFICATION FAILED 6a: early rejection changed working hours';
  end if;

  select count(*) into v_n
    from public.consultant_countries
   where consultant_id = v_id;

  if v_n <> 0 then
    raise exception
      'VERIFICATION FAILED 6a: early rejection left % country rows', v_n;
  end if;

  raise notice
    'PASS 6a: an invalid country id is rejected BEFORE any mutation (not a rollback proof)';
end $$;


-- Checks 8, 9, 10 on the success path: the name projection change
-- did not disturb avatar dual-write, numeric working-hours storage
-- or atomic country replacement.

do $$
declare
  v_id   uuid := current_setting('app.v30_rpc')::uuid;
  v_cid  uuid := current_setting('app.v30_country')::uuid;
  v_auth text;
  v_proj text;
  v_av   text;
  v_ph   text;
  v_wh   jsonb;
  v_n    integer;
begin
  perform public.save_consultant_profile(
    v_id, 'draft', 'Final Name', 'https://cdn.test/final.png',
    null, null, null, null, null, null,
    array[v_cid]::uuid[],
    '{"sunday":[{"start":"09:00","end":"17:00"}],"friday":[{"start":"14:00","end":"16:00"}]}'::jsonb);

  select pr.full_name, c.display_name, pr.avatar_url, c.photo_url,
         c.working_hours_jsonb
    into v_auth, v_proj, v_av, v_ph, v_wh
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  if v_auth is distinct from 'Final Name' or v_proj is distinct from 'Final Name' then
    raise exception
      'VERIFICATION FAILED 4: name pair is %/%',
      coalesce(v_auth, '(null)'), coalesce(v_proj, '(null)');
  end if;

  if v_av is distinct from 'https://cdn.test/final.png'
     or v_ph is distinct from 'https://cdn.test/final.png' then
    raise exception
      'VERIFICATION FAILED 8: avatar pair is %/%',
      coalesce(v_av, '(null)'), coalesce(v_ph, '(null)');
  end if;

  -- Storage stays numeric: named input in, numeric keys stored.
  if v_wh is distinct from
     '{"0":[{"start":"09:00","end":"17:00"}],"5":[{"start":"14:00","end":"16:00"}]}'::jsonb then
    raise exception
      'VERIFICATION FAILED 9: working hours stored as %', v_wh;
  end if;

  select count(*) into v_n
    from public.consultant_countries
   where consultant_id = v_id and country_id = v_cid;

  if v_n <> 1 then
    raise exception
      'VERIFICATION FAILED 10: expected exactly one country row, found %', v_n;
  end if;

  raise notice
    'PASS 8: avatar dual-write intact';
  raise notice
    'PASS 9: named input still stored as numeric weekday keys';
  raise notice
    'PASS 10: countries applied atomically alongside the name projection';
end $$;


-- ------------------------------------------------------------
-- Check 6b: CONTROLLED FAILURE AFTER THE WRITES — the real
-- rollback proof.
-- ------------------------------------------------------------
--
-- Check 6a could only show that validation happens early. This
-- check forces a failure at a point where the RPC has ALREADY
-- written every field under test, and then proves each one
-- reverted.
--
-- Method: a temporary AFTER UPDATE trigger on public.consultants
-- that raises only for this one consultant and only when a
-- sentinel headline is written. AFTER (not BEFORE) is deliberate:
-- the row modification is fully applied before the trigger fires,
-- so what follows is genuine rollback of applied writes rather
-- than a write that never happened.
--
-- By the time it fires, the RPC has completed:
--   section 6  delete + insert on consultant_countries
--   section 7  update profiles.full_name and avatar_url
--   section 8  update consultants: display_name, photo_url,
--              headline, working_hours_jsonb
--
-- The WHEN clause keeps the trigger inert for every other row and
-- every other write, so the migration 026 guard trigger
-- (trg_guard_consultants) and the migration 001 timestamp trigger
-- (trg_consultants_updated) are unaffected. Both continue to run
-- normally; this trigger is additive and fires last.
--
-- The function and trigger are created inside this transaction.
-- PostgreSQL DDL is transactional, so both vanish on the rollback
-- at the end of Part 3. Their absence is asserted afterwards.

create function public.v30_tmp_rollback_probe()
returns trigger
language plpgsql
as $probe$
begin
  raise exception
    'V30_ROLLBACK_PROBE: controlled failure after the consultant update';
end;
$probe$;

create trigger v30_tmp_rollback_probe
  after update on public.consultants
  for each row
  when (new.headline = 'V30 SENTINEL HEADLINE')
  execute function public.v30_tmp_rollback_probe();

do $$
declare
  v_id    uuid := current_setting('app.v30_rpc')::uuid;
  v_cid   uuid := current_setting('app.v30_country')::uuid;
  v_cid2  uuid := current_setting('app.v30_country2')::uuid;
  v_before record;
  v_after  record;
  v_fired  boolean := false;
  v_before_countries uuid[];
  v_after_countries  uuid[];
begin
  -- State established by the success-path check above.
  select pr.full_name, c.display_name, pr.avatar_url, c.photo_url,
         c.headline, c.working_hours_jsonb
    into v_before
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  select coalesce(array_agg(country_id order by country_id), '{}')
    into v_before_countries
    from public.consultant_countries
   where consultant_id = v_id;

  raise notice
    'BEFORE  full_name=% display_name=% avatar_url=% photo_url=% headline=% hours=% countries=%',
    v_before.full_name, v_before.display_name, v_before.avatar_url,
    v_before.photo_url, v_before.headline, v_before.working_hours_jsonb,
    v_before_countries;

  /*
   * Every argument below is VALID. The only thing that stops this
   * save is the sentinel headline, and it stops it after the work
   * is done. A country REPLACEMENT is requested too, so section
   * 6's delete-then-insert must also unwind.
   */
  begin
    perform public.save_consultant_profile(
      v_id, 'draft',
      'Rolled Back Name',
      'https://cdn.test/rolled-back.png',
      null,
      'V30 SENTINEL HEADLINE',
      null, null, null, null,
      array[v_cid2]::uuid[],
      '{"monday":[{"start":"07:00","end":"08:00"}]}'::jsonb);

    raise exception
      'VERIFICATION FAILED 6b: the controlled trigger did not fire';
  exception when others then
    if sqlerrm like 'V30_ROLLBACK_PROBE%' then
      v_fired := true;
    else
      raise;
    end if;
  end;

  if not v_fired then
    raise exception
      'VERIFICATION FAILED 6b: expected the controlled failure, got none';
  end if;

  select pr.full_name, c.display_name, pr.avatar_url, c.photo_url,
         c.headline, c.working_hours_jsonb
    into v_after
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_id;

  select coalesce(array_agg(country_id order by country_id), '{}')
    into v_after_countries
    from public.consultant_countries
   where consultant_id = v_id;

  raise notice
    'AFTER   full_name=% display_name=% avatar_url=% photo_url=% headline=% hours=% countries=%',
    v_after.full_name, v_after.display_name, v_after.avatar_url,
    v_after.photo_url, v_after.headline, v_after.working_hours_jsonb,
    v_after_countries;

  -- The authoritative name and its projection both reverted.
  if v_after.full_name is distinct from v_before.full_name then
    raise exception
      'VERIFICATION FAILED 6b: profiles.full_name persisted as %',
      coalesce(v_after.full_name, '(null)');
  end if;

  if v_after.display_name is distinct from v_before.display_name then
    raise exception
      'VERIFICATION FAILED 6b: consultants.display_name persisted as %',
      coalesce(v_after.display_name, '(null)');
  end if;

  -- The authoritative avatar and its projection both reverted.
  if v_after.avatar_url is distinct from v_before.avatar_url then
    raise exception
      'VERIFICATION FAILED 6b: profiles.avatar_url persisted as %',
      coalesce(v_after.avatar_url, '(null)');
  end if;

  if v_after.photo_url is distinct from v_before.photo_url then
    raise exception
      'VERIFICATION FAILED 6b: consultants.photo_url persisted as %',
      coalesce(v_after.photo_url, '(null)');
  end if;

  -- The sentinel itself must not survive.
  if v_after.headline is distinct from v_before.headline then
    raise exception
      'VERIFICATION FAILED 6b: consultants.headline persisted as %',
      coalesce(v_after.headline, '(null)');
  end if;

  if v_after.working_hours_jsonb is distinct from v_before.working_hours_jsonb then
    raise exception
      'VERIFICATION FAILED 6b: consultants.working_hours_jsonb persisted as %',
      v_after.working_hours_jsonb;
  end if;

  -- Section 6 ran to completion before the failure, so this proves
  -- the delete-then-insert unwound: the original assignment is
  -- back and the replacement is gone.
  if v_after_countries is distinct from v_before_countries then
    raise exception
      'VERIFICATION FAILED 6b: consultant_countries persisted as %, expected %',
      v_after_countries, v_before_countries;
  end if;

  if v_after_countries <> array[v_cid]::uuid[] then
    raise exception
      'VERIFICATION FAILED 6b: expected the original country assignment, found %',
      v_after_countries;
  end if;

  raise notice
    'PASS 6b: a failure raised AFTER the writes rolled back full_name, display_name, avatar_url, photo_url, headline, working_hours_jsonb and consultant_countries';
end $$;


-- Check 7: a different consultant was never touched by any call above.

do $$
declare
  v_other uuid := current_setting('app.v30_rpc_other')::uuid;
  v_auth  text;
  v_proj  text;
  v_ph    text;
  v_wh    jsonb;
begin
  select pr.full_name, c.display_name, c.photo_url, c.working_hours_jsonb
    into v_auth, v_proj, v_ph, v_wh
    from public.consultants c
    join public.profiles pr on pr.id = c.profile_id
   where c.id = v_other;

  if v_auth is distinct from 'Other Name'
     or v_proj is distinct from 'Other Name'
     or v_ph is distinct from 'https://cdn.test/o.png'
     or v_wh is distinct from '{"2":[{"start":"10:00","end":"11:00"}]}'::jsonb then
    raise exception
      'VERIFICATION FAILED 7: another consultant changed (name %/%, photo %, hours %)',
      coalesce(v_auth, '(null)'), coalesce(v_proj, '(null)'),
      coalesce(v_ph, '(null)'), v_wh;
  end if;

  raise notice 'PASS 7: another consultant remains untouched';
end $$;

rollback;

-- Check 21 (Part 3): the rollback is asserted, not assumed.
--
-- The temporary probe is included: a trigger left attached to
-- public.consultants would raise on a real save, so proving it is
-- gone matters more than proving the fixture rows are.

do $$
declare
  v_profiles    integer;
  v_consultants integer;
  v_countries   integer;
  v_trigger     integer;
  v_function    integer;
begin
  select count(*) into v_profiles
    from public.profiles
   where email like 'v30-%@verification.invalid';

  select count(*) into v_consultants
    from public.consultants c
    join public.profiles p on p.id = c.profile_id
   where p.email like 'v30-%@verification.invalid';

  select count(*) into v_countries
    from public.countries
   where iso_code in ('QW3', 'QW4')
      or name like 'ZZ V30 %';

  select count(*) into v_trigger
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'consultants'
     and t.tgname  = 'v30_tmp_rollback_probe';

  select count(*) into v_function
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'v30_tmp_rollback_probe';

  if v_profiles <> 0 then
    raise exception
      'VERIFICATION FAILED 21: % verification profile(s) survived the rollback', v_profiles;
  end if;

  if v_consultants <> 0 then
    raise exception
      'VERIFICATION FAILED 21: % verification consultant(s) survived the rollback', v_consultants;
  end if;

  if v_countries <> 0 then
    raise exception
      'VERIFICATION FAILED 21: % verification country row(s) survived the rollback', v_countries;
  end if;

  if v_trigger <> 0 then
    raise exception
      'VERIFICATION FAILED 21: the temporary probe TRIGGER is still attached to public.consultants';
  end if;

  if v_function <> 0 then
    raise exception
      'VERIFICATION FAILED 21: the temporary probe FUNCTION still exists in public';
  end if;

  raise notice
    'PASS 21 (Part 3): no verification profile, consultant or country survived, and the temporary trigger and function are gone';
end $$;

-- The pre-existing triggers on public.consultants must be exactly
-- what they were: the probe must not have displaced or replaced
-- one of them.

do $$
declare v_triggers text;
begin
  select string_agg(t.tgname, ', ' order by t.tgname)
    into v_triggers
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'consultants'
     and not t.tgisinternal;

  if v_triggers is distinct from 'trg_consultants_updated, trg_guard_consultants' then
    raise exception
      'VERIFICATION FAILED 21: triggers on public.consultants are now: %', v_triggers;
  end if;

  raise notice
    'PASS 21: the migration 026 guard trigger and the timestamp trigger are intact and alone';
end $$;


-- ============================================================
-- PART 4 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 19: RLS is unchanged.
--
-- The policy sets on the two tables this migration touches are
-- pinned by name. display_name becomes publicly readable through
-- the EXISTING consultants_select_active_public policy, because
-- RLS is row-level: a row a caller may already read, it may read
-- entirely. No policy was added, dropped or rewritten to achieve
-- that, and profiles remains exactly as restrictive as before.

do $$
declare
  v_consultant_policies text;
  v_profile_policies    text;
  v_profiles_rls        boolean;
  v_leak                integer;
begin
  select string_agg(policyname, ', ' order by policyname)
    into v_consultant_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'consultants';

  if v_consultant_policies is distinct from
     'consultants_select_active_public, consultants_select_own_or_admin, consultants_update_own_or_admin' then
    raise exception
      'VERIFICATION FAILED 19: consultants policies are now: %', v_consultant_policies;
  end if;

  select string_agg(policyname, ', ' order by policyname)
    into v_profile_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles';

  if v_profile_policies is distinct from
     'profiles_select_own_or_admin, profiles_update_own' then
    raise exception
      'VERIFICATION FAILED 19: profiles policies are now: %', v_profile_policies;
  end if;

  select c.relrowsecurity into v_profiles_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'profiles';

  if not v_profiles_rls then
    raise exception
      'VERIFICATION FAILED 19: row level security is disabled on public.profiles';
  end if;

  -- No policy anywhere was rewritten to mention the new column.
  select count(*) into v_leak
    from pg_policies
   where schemaname = 'public'
     and (coalesce(qual, '') like '%display_name%'
       or coalesce(with_check, '') like '%display_name%');

  if v_leak <> 0 then
    raise exception
      'VERIFICATION FAILED 19: % policy expression(s) reference display_name', v_leak;
  end if;

  raise notice
    'PASS 19: policy sets pinned, profiles RLS enabled, no policy rewritten';
end $$;


-- Check 20: the data model is still 16 tables, and no private
-- profiles column was copied onto consultants.

do $$
declare
  v_tables integer;
  v_leak   text;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  if v_tables <> 16 then
    raise exception
      'VERIFICATION FAILED 20: expected 16 tables, found %', v_tables;
  end if;

  /*
   * display_name is the ONLY thing this migration projects. If a
   * private profiles column ever appears on consultants, the
   * public projection has become a data leak and this fails.
   */
  select string_agg(column_name, ', ' order by column_name)
    into v_leak
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'consultants'
     and column_name in ('email', 'phone_whatsapp', 'role');

  if v_leak is not null then
    raise exception
      'VERIFICATION FAILED: private profiles column(s) present on consultants: %', v_leak;
  end if;

  raise notice
    'PASS 20: 16 tables, and no private profiles column projected onto consultants';
end $$;


-- Projection drift across the whole table. Zero after applying.
-- Reported rather than asserted only in the sense that it raises:
-- there is no data-dependent SKIP here either.

do $$
declare v_drift integer;
begin
  select count(*) into v_drift
    from public.consultants c
    join public.profiles p on p.id = c.profile_id
   where p.full_name is not null
     and c.display_name is distinct from p.full_name;

  if v_drift <> 0 then
    raise exception
      'VERIFICATION FAILED 2: % consultant row(s) have a stale display_name', v_drift;
  end if;

  raise notice 'PASS: no projection drift across the table';
end $$;


do $$
begin
  raise notice 'ALL CHECKS 1-22 COMPLETE - no exception raised';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- To reverse migration 030:
--
--   1. Re-apply migration 029 verbatim. That restores the previous
--      save_consultant_profile body, which never writes
--      display_name. Signature, grants and search_path are
--      identical, so nothing else moves.
--
--   2. Optionally drop the column:
--
--        alter table public.consultants drop column display_name;
--
--      Dropping is only safe once no reader selects it. The public
--      booking reader is the one consumer, so drop the column only
--      after that reader is reverted, or leave the column in place
--      as harmless dead weight.
--
-- Reversing does NOT need a data restore. display_name is a
-- projection: profiles.full_name remains authoritative and intact
-- throughout, and the projection can always be rebuilt with the
-- backfill statement in section B of the migration.
