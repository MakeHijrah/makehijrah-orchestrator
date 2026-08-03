-- ============================================================
-- Verification for migration_026_consultant_onboarding_and_gender_lock
-- ============================================================
--
-- Review and staging aid. This file is NOT a migration and lives
-- outside supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
-- Layout:
--   Part 0  pre-application inspection      read-only, safe anywhere
--   Part 1  post-application inspection     read-only, safe anywhere
--   Part 2  guard behaviour                 STAGING ONLY, mutates, rolls back
--   Part 3  scope and policy inspection     read-only, safe anywhere
--   Part 4  rollback guidance
--
-- Part 2 must run as a superuser or a role that may SET ROLE to
-- authenticated, because it deliberately switches identity to
-- exercise the non-privileged path. is_privileged_writer()
-- exempts postgres and service_role, so a test run as either of
-- those would silently prove nothing.
-- ============================================================


-- ============================================================
-- PART 0 — BEFORE APPLYING migration 026
-- ============================================================
--
-- The backfill locks gender permanently for every consultant it
-- marks. Migration 026 aborts if any active consultant has a
-- gender that is not exactly 'male' or 'female'. Run this first
-- so the offending rows are known before the apply fails.
--
-- Expected: ZERO rows.

select id,
       profile_id,
       is_active,
       gender,
       onboarding_completed_at
  from public.consultants
 where is_active = true
   and (
     gender is distinct from 'male'
     and gender is distinct from 'female'
   );

-- Summary count. Expected: invalid_active_consultants = 0.
-- If it is non-zero, migration 026 will raise
-- MIGRATION_026_ACTIVE_CONSULTANT_GENDER_INVALID and roll back
-- without modifying a single row.

select count(*) filter (
         where is_active
           and gender is distinct from 'male'
           and gender is distinct from 'female'
       ) as invalid_active_consultants,
       count(*) filter (where is_active) as active_consultants,
       count(*) as total_consultants
  from public.consultants;


-- ============================================================
-- PART 1 — AFTER APPLYING migration 026 (read-only)
-- ============================================================

-- 1. Column exists and is nullable.
--    Expect one row: timestamptz, is_nullable = YES, no default.

select column_name,
       data_type,
       is_nullable,
       coalesce(column_default, '(none)') as column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'consultants'
   and column_name  = 'onboarding_completed_at';

-- 2. Active consultants are backfilled. Expect unmarked_active = 0.
-- 3. Inactive consultants remain null. Expect marked_inactive = 0.

select count(*) filter (where is_active and onboarding_completed_at is null)
         as unmarked_active,
       count(*) filter (where is_active and onboarding_completed_at is not null)
         as marked_active,
       count(*) filter (where not is_active and onboarding_completed_at is not null)
         as marked_inactive,
       count(*) filter (where not is_active and onboarding_completed_at is null)
         as unmarked_inactive
  from public.consultants;


-- ============================================================
-- PART 2 — GUARD BEHAVIOUR  (STAGING ONLY)
-- ============================================================
--
-- Mutates data, then rolls back. Every DO block either raises
-- VERIFICATION ABORT / VERIFICATION FAILED, or emits a PASS
-- notice. Any raised exception aborts the transaction, so a
-- failure cannot leave staging modified.
--
-- Two problems this is written to avoid:
--
--   1. psql :'variables' do not interpolate inside DO blocks.
--      Values are passed through transaction-local settings and
--      read with current_setting() instead.
--
--   2. Under RLS, an UPDATE with no auth.uid() matches zero rows
--      and raises nothing. A trigger test that treats "no
--      exception" as failure would then be misleading, and a
--      permitted-operation test would pass on zero rows. Every
--      block below proves the target row is reachable and counts
--      affected rows.

begin;

-- ------------------------------------------------------------
-- CONFIGURATION — replace all four UUIDs before running
-- ------------------------------------------------------------
--
--   completed = a consultant with onboarding_completed_at NOT NULL
--   pending   = a consultant with onboarding_completed_at NULL
--
-- The profile id must be that consultant's own consultants.profile_id.

select set_config('app.verify_completed_consultant_id',
                  '00000000-0000-0000-0000-000000000000', true);

select set_config('app.verify_completed_profile_id',
                  '00000000-0000-0000-0000-000000000000', true);

select set_config('app.verify_pending_consultant_id',
                  '00000000-0000-0000-0000-000000000000', true);

select set_config('app.verify_pending_profile_id',
                  '00000000-0000-0000-0000-000000000000', true);


-- ------------------------------------------------------------
-- PRECHECK — configuration is coherent (runs as the migration role)
-- ------------------------------------------------------------

do $$
declare
  v_completed_id      uuid := current_setting('app.verify_completed_consultant_id')::uuid;
  v_completed_profile uuid := current_setting('app.verify_completed_profile_id')::uuid;
  v_pending_id        uuid := current_setting('app.verify_pending_consultant_id')::uuid;
  v_pending_profile   uuid := current_setting('app.verify_pending_profile_id')::uuid;
  v_profile           uuid;
  v_marker            timestamptz;
begin
  if v_completed_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception
      'VERIFICATION ABORT: configuration UUIDs were not replaced';
  end if;

  -- Completed consultant exists, owns the configured profile, marker set.
  select profile_id, onboarding_completed_at
    into v_profile, v_marker
    from public.consultants
   where id = v_completed_id;

  if not found then
    raise exception
      'VERIFICATION ABORT: completed consultant % does not exist', v_completed_id;
  end if;

  if v_profile is distinct from v_completed_profile then
    raise exception
      'VERIFICATION ABORT: completed consultant profile_id is %, configured %',
      v_profile, v_completed_profile;
  end if;

  if v_marker is null then
    raise exception
      'VERIFICATION ABORT: completed consultant % has a null marker; pick a backfilled row',
      v_completed_id;
  end if;

  -- Pending consultant exists, owns the configured profile, marker null.
  select profile_id, onboarding_completed_at
    into v_profile, v_marker
    from public.consultants
   where id = v_pending_id;

  if not found then
    raise exception
      'VERIFICATION ABORT: pending consultant % does not exist', v_pending_id;
  end if;

  if v_profile is distinct from v_pending_profile then
    raise exception
      'VERIFICATION ABORT: pending consultant profile_id is %, configured %',
      v_profile, v_pending_profile;
  end if;

  if v_marker is not null then
    raise exception
      'VERIFICATION ABORT: pending consultant % already has a marker; pick an unmarked row',
      v_pending_id;
  end if;

  raise notice 'PRECHECK OK: both consultants exist with the expected ownership and marker state';
end $$;


-- ------------------------------------------------------------
-- AUTHENTICATED CONTEXT — the COMPLETED consultant
-- ------------------------------------------------------------
--
-- Both claim shapes are set. Older Supabase auth.uid() reads
-- request.jwt.claim.sub; newer reads request.jwt.claims ->> 'sub'.
-- Setting both makes this work regardless of which the project's
-- current auth schema uses.

set local role authenticated;

select set_config('request.jwt.claim.sub',
                  current_setting('app.verify_completed_profile_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims',
                  json_build_object(
                    'sub',  current_setting('app.verify_completed_profile_id'),
                    'role', 'authenticated'
                  )::text, true);

-- 1. Completed consultant is accessible AS ITS OWNER.
--    Proves auth.uid() resolves and RLS admits the row, so a
--    later "no rows updated" cannot be mistaken for a trigger
--    rejection.

do $$
declare
  v_uid  uuid := auth.uid();
  v_rows integer;
begin
  if v_uid is distinct from current_setting('app.verify_completed_profile_id')::uuid then
    raise exception
      'VERIFICATION ABORT: auth.uid() is %, expected %',
      v_uid, current_setting('app.verify_completed_profile_id');
  end if;

  if not exists (
    select 1 from public.consultants
     where id = current_setting('app.verify_completed_consultant_id')::uuid
  ) then
    raise exception
      'VERIFICATION ABORT: completed consultant not visible under owner context (RLS)';
  end if;

  -- Benign self-assignment: touches no guarded column, so it must
  -- pass the trigger and affect exactly one row.
  update public.consultants
     set headline = headline
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION ABORT: completed consultant not updateable under owner context (rows=%)', v_rows;
  end if;

  raise notice 'PASS 1: completed consultant reachable and updateable as owner';
end $$;

-- 4. Post-onboarding gender CHANGE must be rejected.

do $$
begin
  update public.consultants
     set gender = case when gender = 'male' then 'female' else 'male' end
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: gender change was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
      raise notice 'PASS 4: post-onboarding gender change rejected';
    else
      raise;
    end if;
end $$;

-- 5. Post-onboarding gender CLEAR must be rejected.

do $$
begin
  update public.consultants
     set gender = null
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: gender clear was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
      raise notice 'PASS 5: post-onboarding gender clear rejected';
    else
      raise;
    end if;
end $$;

-- 7a. Marker CLEAR by a client must be rejected.

do $$
begin
  update public.consultants
     set onboarding_completed_at = null
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: marker clear was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_ONBOARDING_MARKER_IMMUTABLE%' then
      raise notice 'PASS 7a: marker clear rejected';
    else
      raise;
    end if;
end $$;

-- 8. Existing is_active protection remains.

do $$
begin
  update public.consultants
     set is_active = not is_active
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: is_active was client-writable';
exception
  when others then
    if sqlerrm like '%is_active may not be changed by clients%' then
      raise notice 'PASS 8: is_active still protected';
    else
      raise;
    end if;
end $$;

-- 9. Existing profile_id protection remains.

do $$
begin
  update public.consultants
     set profile_id = gen_random_uuid()
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: profile_id was client-writable';
exception
  when others then
    if sqlerrm like '%profile_id may not be changed by clients%' then
      raise notice 'PASS 9: profile_id still protected';
    else
      raise;
    end if;
end $$;


-- ------------------------------------------------------------
-- AUTHENTICATED CONTEXT — the PENDING consultant
-- ------------------------------------------------------------

select set_config('request.jwt.claim.sub',
                  current_setting('app.verify_pending_profile_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims',
                  json_build_object(
                    'sub',  current_setting('app.verify_pending_profile_id'),
                    'role', 'authenticated'
                  )::text, true);

-- 2. Pending consultant is accessible AS ITS OWNER.

do $$
declare
  v_uid  uuid := auth.uid();
  v_rows integer;
begin
  if v_uid is distinct from current_setting('app.verify_pending_profile_id')::uuid then
    raise exception
      'VERIFICATION ABORT: auth.uid() is %, expected %',
      v_uid, current_setting('app.verify_pending_profile_id');
  end if;

  update public.consultants
     set headline = headline
   where id = current_setting('app.verify_pending_consultant_id')::uuid;

  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION ABORT: pending consultant not updateable under owner context (rows=%)', v_rows;
  end if;

  raise notice 'PASS 2: pending consultant reachable and updateable as owner';
end $$;

-- 3. Pre-completion gender update affects EXACTLY ONE row.
--    This is the behaviour that lets a consultant choose gender
--    during onboarding, and it must not be blocked.

do $$
declare
  v_rows integer;
begin
  update public.consultants
     set gender = case when gender = 'male' then 'female' else 'male' end
   where id = current_setting('app.verify_pending_consultant_id')::uuid;

  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED: pre-completion gender update affected % row(s), expected 1', v_rows;
  end if;

  raise notice 'PASS 3: pre-completion gender update affected exactly one row';
end $$;

-- 7b. Marker SET by a client must be rejected.

do $$
begin
  update public.consultants
     set onboarding_completed_at = now()
   where id = current_setting('app.verify_pending_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: marker set was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_ONBOARDING_MARKER_IMMUTABLE%' then
      raise notice 'PASS 7b: marker set rejected';
    else
      raise;
    end if;
end $$;


-- ------------------------------------------------------------
-- PRIVILEGED CONTEXT — deactivation and controlled correction
-- ------------------------------------------------------------

reset role;

-- 5b. Privileged deactivation affects exactly one row.

do $$
declare
  v_rows integer;
begin
  update public.consultants
     set is_active = false
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED: privileged deactivation affected % row(s), expected 1', v_rows;
  end if;

  raise notice 'PASS 5b: privileged deactivation affected exactly one row';
end $$;

-- 6. Deactivation does NOT reopen gender for the owning consultant.

set local role authenticated;

select set_config('request.jwt.claim.sub',
                  current_setting('app.verify_completed_profile_id'), true);
select set_config('request.jwt.claims',
                  json_build_object(
                    'sub',  current_setting('app.verify_completed_profile_id'),
                    'role', 'authenticated'
                  )::text, true);

do $$
begin
  update public.consultants
     set gender = case when gender = 'male' then 'female' else 'male' end
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  raise exception 'VERIFICATION FAILED: gender editable after deactivation';
exception
  when others then
    if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
      raise notice 'PASS 6: gender still locked after deactivation';
    else
      raise;
    end if;
end $$;

reset role;

-- 4b. Privileged gender update affects exactly one row.
--     This is the Amendment 008 section 5.6 correction path. It
--     must remain possible and must never be exposed through a
--     route.

do $$
declare
  v_rows integer;
begin
  update public.consultants
     set gender = case when gender = 'male' then 'female' else 'male' end
   where id = current_setting('app.verify_completed_consultant_id')::uuid;

  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception
      'VERIFICATION FAILED: privileged gender update affected % row(s), expected 1', v_rows;
  end if;

  raise notice 'PASS 4b: privileged gender update affected exactly one row';
end $$;

rollback;   -- discard everything Part 2 changed


-- ============================================================
-- PART 3 — SCOPE AND POLICY INSPECTION (read-only)
-- ============================================================

-- 11. RLS remains enabled. Expect rls_enabled = true for both.

select c.relname,
       c.relrowsecurity      as rls_enabled,
       c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('consultants', 'consultant_countries');

-- 12. Country-assignment write policies are NOT broadened.
--     Expect exactly three, unchanged:
--       cc_select_public  SELECT  using (true)
--       cc_insert_admin   INSERT  with check (is_admin())
--       cc_delete_admin   DELETE  using (is_admin())
--     No consultant-scoped INSERT or DELETE may appear.

select policyname, cmd, roles::text,
       coalesce(qual, '-')       as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename  = 'consultant_countries'
 order by policyname;

-- consultants policies must also be unchanged (three policies).

select policyname, cmd, roles::text,
       coalesce(qual, '-')       as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename  = 'consultants'
 order by policyname;

-- 13. save_consultant_profile is deferred and must NOT exist yet.
--     Expect zero rows. When it is created in the orchestrator
--     phase, re-run and expect service_role only.

select p.proname,
       pg_get_userbyid(p.proowner) as owner,
       coalesce(array_to_string(p.proacl, ' | '), '(default)') as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'save_consultant_profile';

-- 14a. consultants columns: the pre-existing set plus exactly one
--      new column, onboarding_completed_at.

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'consultants'
 order by ordinal_position;

-- 14b. Table count must remain 16.

select count(*) as public_table_count
  from information_schema.tables
 where table_schema = 'public'
   and table_type   = 'BASE TABLE';

-- 14c. Constraints unchanged; consultants_gender_check still present.

select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname = 'consultants'
 order by con.conname;

-- 14d. Exactly one guard trigger on consultants, still bound to
--      guard_consultants_columns.

select t.tgname,
       p.proname as function_name,
       t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc  p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname = 'consultants'
   and not t.tgisinternal
 order by t.tgname;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Preferred partial rollback - restore the previous guard only.
-- Removes the gender lock and marker immutability while keeping
-- the column and its data intact. Use this if the lock causes an
-- operational problem.
--
--   Re-apply the guard_consultants_columns body from
--   migration_021_allow_consultant_general_availability.sql
--   verbatim. It is a create-or-replace, so it needs no drop.
--
-- Do NOT drop the column once values are written:
--
--   -- PROHIBITED without explicit written approval:
--   -- alter table public.consultants
--   --   drop column onboarding_completed_at;
--
--   Dropping it silently reopens gender for every completed
--   consultant and destroys the record of who has onboarded.
--   Amendment 008 section 20.1.
--
-- The backfill is not reversible after the fact: nothing records
-- which rows were marked by the backfill rather than by a later
-- submission. If reversal must remain possible, capture the ids
-- BEFORE applying:
--
--   create table _bak_026_backfilled as
--   select id from public.consultants
--    where is_active = true and onboarding_completed_at is null;
--
-- Country assignments are untouched by migration 026 and must
-- never be deleted as part of any rollback.
