-- ============================================================
-- Verification for migration_026_consultant_onboarding_and_gender_lock
-- ============================================================
--
-- Review and staging aid. This file is NOT a migration and lives
-- outside supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
-- Sections 1-3 and 8-14 are read-only inspections and are safe
-- anywhere. Sections 4-7 mutate data and MUST run only on a
-- staging database, inside the provided transaction, which rolls
-- back.
--
-- Non-privileged behaviour cannot be observed while connected as
-- postgres or service_role, because is_privileged_writer()
-- exempts them. Sections 4-7 therefore SET LOCAL ROLE to a
-- non-privileged role first. Adjust the role name to match the
-- environment; Supabase uses "authenticated".
-- ============================================================


-- ------------------------------------------------------------
-- 1. Column exists and is nullable
-- ------------------------------------------------------------
-- Expect exactly one row: timestamptz, is_nullable = YES,
-- column_default null.

select column_name,
       data_type,
       is_nullable,
       column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'consultants'
   and column_name  = 'onboarding_completed_at';


-- ------------------------------------------------------------
-- 2. Active consultants are backfilled
-- ------------------------------------------------------------
-- Expect unmarked_active = 0.

select count(*) filter (where is_active and onboarding_completed_at is null)
         as unmarked_active,
       count(*) filter (where is_active and onboarding_completed_at is not null)
         as marked_active
  from public.consultants;


-- ------------------------------------------------------------
-- 3. Inactive consultants remain null
-- ------------------------------------------------------------
-- Expect marked_inactive = 0.

select count(*) filter (where not is_active and onboarding_completed_at is not null)
         as marked_inactive,
       count(*) filter (where not is_active and onboarding_completed_at is null)
         as unmarked_inactive
  from public.consultants;


-- ------------------------------------------------------------
-- 4-7. Guard behaviour  (STAGING ONLY - mutates, then rolls back)
-- ------------------------------------------------------------
--
-- Each block should RAISE. If any block completes without an
-- exception, migration 026 has not taken effect correctly.
--
-- Replace :consultant_completed and :consultant_pending with a
-- backfilled (marker not null) and a pending (marker null)
-- consultant id from staging.

begin;

set local role authenticated;

-- 4. Post-onboarding gender CHANGE must fail.
--    Expect: CONSULTANT_GENDER_IMMUTABLE
do $$
begin
  update public.consultants
     set gender = case when gender = 'male' then 'female' else 'male' end
   where id = :'consultant_completed';
  raise exception 'VERIFICATION FAILED: gender change was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
      raise notice 'PASS 4: gender change rejected';
    else
      raise;
    end if;
end $$;

-- 5. Post-onboarding gender CLEAR must fail.
--    Expect: CONSULTANT_GENDER_IMMUTABLE
do $$
begin
  update public.consultants
     set gender = null
   where id = :'consultant_completed';
  raise exception 'VERIFICATION FAILED: gender clear was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
      raise notice 'PASS 5: gender clear rejected';
    else
      raise;
    end if;
end $$;

-- 6. Deactivation does not reopen gender.
--    A client cannot deactivate at all (is_active guard), so the
--    check is that the gender lock keys on the marker, not on
--    is_active. Deactivate as a privileged writer, then confirm
--    the lock still holds for a client.
reset role;

update public.consultants
   set is_active = false
 where id = :'consultant_completed';

set local role authenticated;

do $$
begin
  update public.consultants
     set gender = case when gender = 'male' then 'female' else 'male' end
   where id = :'consultant_completed';
  raise exception 'VERIFICATION FAILED: gender editable after deactivation';
exception
  when others then
    if sqlerrm like 'CONSULTANT_GENDER_IMMUTABLE%' then
      raise notice 'PASS 6: gender still locked after deactivation';
    else
      raise;
    end if;
end $$;

-- 7. Marker changes by a client must fail, in both directions.
--    Expect: CONSULTANT_ONBOARDING_MARKER_IMMUTABLE
do $$
begin
  update public.consultants
     set onboarding_completed_at = null
   where id = :'consultant_completed';
  raise exception 'VERIFICATION FAILED: marker clear was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_ONBOARDING_MARKER_IMMUTABLE%' then
      raise notice 'PASS 7a: marker clear rejected';
    else
      raise;
    end if;
end $$;

do $$
begin
  update public.consultants
     set onboarding_completed_at = now()
   where id = :'consultant_pending';
  raise exception 'VERIFICATION FAILED: marker set was permitted';
exception
  when others then
    if sqlerrm like 'CONSULTANT_ONBOARDING_MARKER_IMMUTABLE%' then
      raise notice 'PASS 7b: marker set rejected';
    else
      raise;
    end if;
end $$;

-- 8. Existing is_active protection remains.
do $$
begin
  update public.consultants
     set is_active = true
   where id = :'consultant_pending';
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
   where id = :'consultant_pending';
  raise exception 'VERIFICATION FAILED: profile_id was client-writable';
exception
  when others then
    if sqlerrm like '%profile_id may not be changed by clients%' then
      raise notice 'PASS 9: profile_id still protected';
    else
      raise;
    end if;
end $$;

-- 9b. Gender is still settable BEFORE completion.
--     Expect no exception.
update public.consultants
   set gender = 'female'
 where id = :'consultant_pending';

-- 10. Service-role / privileged writes remain possible.
reset role;

update public.consultants
   set gender = case when gender = 'male' then 'female' else 'male' end
 where id = :'consultant_completed';

rollback;   -- discard every change made by sections 4-10


-- ------------------------------------------------------------
-- 11. RLS remains enabled
-- ------------------------------------------------------------
-- Expect relrowsecurity = true for both tables.

select c.relname,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('consultants', 'consultant_countries');


-- ------------------------------------------------------------
-- 12. Country-assignment write policies are NOT broadened
-- ------------------------------------------------------------
-- Expect exactly three policies, unchanged:
--   cc_select_public  SELECT  using (true)
--   cc_insert_admin   INSERT  with check (is_admin())
--   cc_delete_admin   DELETE  using (is_admin())
-- No consultant-scoped INSERT or DELETE may appear.

select policyname, cmd, roles::text,
       coalesce(qual, '-')       as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename  = 'consultant_countries'
 order by policyname;

-- Consultants policies must also be unchanged (3 policies).
select policyname, cmd, roles::text,
       coalesce(qual, '-')       as using_expr,
       coalesce(with_check, '-') as with_check
  from pg_policies
 where schemaname = 'public'
   and tablename  = 'consultants'
 order by policyname;


-- ------------------------------------------------------------
-- 13. RPC EXECUTE grants
-- ------------------------------------------------------------
-- migration 026 creates no function other than replacing
-- guard_consultants_columns, so save_consultant_profile must NOT
-- exist yet. Expect zero rows.
--
-- When it is created in the orchestrator phase, re-run this and
-- expect service_role only - never authenticated or anon.

select p.proname,
       pg_get_userbyid(p.proowner) as owner,
       coalesce(array_to_string(p.proacl, ' | '), '(default)') as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'save_consultant_profile';


-- ------------------------------------------------------------
-- 14. No schema object outside the approved scope changed
-- ------------------------------------------------------------
-- 14a. consultants columns. Expect the pre-existing set plus
--      exactly one new column, onboarding_completed_at.

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

-- 14c. Constraints on consultants must be unchanged;
--      consultants_gender_check must still be present and its
--      definition untouched.
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
-- Rollback guidance
-- ============================================================
--
-- Preferred partial rollback - restore the previous guard only.
-- This removes the gender lock and the marker immutability while
-- keeping the column and its data intact. Use this if the lock
-- causes an operational problem.
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
-- The backfill itself is not reversible in a meaningful sense:
-- there is no record of which rows were marked by the backfill
-- versus by a later submission. If a full reversal is ever
-- required, capture the affected ids BEFORE applying:
--
--   create table _bak_026_backfilled as
--   select id from public.consultants
--    where is_active = true and onboarding_completed_at is null;
--
-- Country assignments are untouched by this migration and must
-- never be deleted as part of any rollback.
