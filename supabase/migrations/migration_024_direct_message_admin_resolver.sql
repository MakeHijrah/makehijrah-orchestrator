-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 024: Direct message admin resolver
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 005
--   "Admin <-> Consultant Direct Messaging" (APPROVED).
--   This migration adds the one missing read path required by
--   section 5.2 of that amendment and nothing beyond it.
--
-- Why this exists:
-- - Amendment 005 section 5.2 requires that a consultant may
--   INITIATE a direct message without a prior admin message.
-- - The live profiles policy set is:
--       profiles_select_own_or_admin
--         SELECT to authenticated
--         using ((id = auth.uid()) or is_admin())
--       profiles_update_own
--         UPDATE to authenticated
--         using (id = auth.uid())
--   A consultant can therefore read only its own profile row and
--   cannot discover any admin profile. Migration 023 permits the
--   insert, but the consultant has no way to learn the recipient
--   id, so 5.2 is unreachable in practice.
-- - Amendment 005 section 10.2 anticipated that no further change
--   would be needed. That expectation did not hold, for the reason
--   above. See the governance note at the end of this file.
--
-- What this migration deliberately does NOT do:
-- - It does not create or alter any table.
-- - It does not create, alter or drop any RLS policy.
-- - It does not widen profiles visibility. The function returns a
--   bare uuid; no name, email, phone, avatar or role is exposed.
-- - It does not accept a recipient argument, so it cannot be used
--   as a general profile lookup or an existence oracle.
-- - It does not hardcode any profile UUID.
-- - It introduces no service-role dependency.
--
-- Idempotent. Transaction-wrapped.
-- ============================================================

begin;

-- ------------------------------------------------------------- pre-flight ----
-- Fail before creating anything if a dependency is missing, so the
-- transaction rolls back and the live state is untouched.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'migration 024: public.profiles not found';
  end if;

  if to_regprocedure('auth.uid()') is null then
    raise exception
      'migration 024: auth.uid() not found - required for caller identity';
  end if;

  if to_regtype('public.user_role') is null then
    raise exception 'migration 024: type public.user_role not found';
  end if;

  -- Both labels are compared against inside the function body.
  if not exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role'
       and t.typnamespace = 'public'::regnamespace
       and e.enumlabel = 'admin'
  ) then
    raise exception 'migration 024: public.user_role has no admin label';
  end if;

  if not exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role'
       and t.typnamespace = 'public'::regnamespace
       and e.enumlabel = 'consultant'
  ) then
    raise exception 'migration 024: public.user_role has no consultant label';
  end if;

  -- Required by the grant/revoke block below.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'migration 024: role anon not found';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'migration 024: role authenticated not found';
  end if;
end;
$$;

-- ---------------------------------------------------------------- function ----
-- SECURITY DEFINER because the caller cannot read admin rows under
-- profiles_select_own_or_admin. The definer's reach is confined by the fact
-- that the function takes no argument, checks the caller's own role from
-- public.profiles before doing anything, and returns a single uuid.

create or replace function public.get_direct_message_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_role public.user_role;
  v_admin_id uuid;
begin
  -- 1. Caller must be authenticated.
  if v_caller is null then
    raise exception 'authentication is required'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. Caller must be a consultant. The role is read from public.profiles,
  --    never from anything the caller supplies.
  select p.role
    into v_caller_role
    from public.profiles p
   where p.id = v_caller;

  if v_caller_role is null then
    raise exception 'caller profile not found'
      using errcode = 'insufficient_privilege';
  end if;

  if v_caller_role <> 'consultant'::public.user_role then
    raise exception 'only a consultant may resolve the direct message admin'
      using errcode = 'insufficient_privilege';
  end if;

  -- 3. Deterministic selection: oldest admin first, id ascending as the
  --    tie-breaker, so every consultant resolves the same admin and the
  --    answer is stable across calls.
  select p.id
    into v_admin_id
    from public.profiles p
   where p.role = 'admin'::public.user_role
   order by p.created_at asc, p.id asc
   limit 1;

  if v_admin_id is null then
    raise exception 'no administrator is available'
      using errcode = 'no_data_found';
  end if;

  -- 4. The uuid, and nothing else.
  return v_admin_id;
end;
$$;

comment on function public.get_direct_message_admin() is
  'Amendment 005 section 5.2. Returns the uuid of the single deterministic '
  'administrator a consultant may open a direct conversation with, so a '
  'consultant can initiate without a prior admin message. Callable only by an '
  'authenticated consultant; raises otherwise. Takes no argument and returns a '
  'bare uuid, so it cannot be used as a general profile lookup. Does not widen '
  'profiles visibility and does not alter any RLS policy.';

-- -------------------------------------------------------------- privileges ----
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. Revoke that first,
-- then grant to authenticated only. anon is revoked explicitly as well as
-- through PUBLIC, so the intent survives any future grant to PUBLIC.

revoke all on function public.get_direct_message_admin() from public;
revoke all on function public.get_direct_message_admin() from anon;
grant execute on function public.get_direct_message_admin() to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Run through the anon key as each existing test user.
--
-- 1. consultant calls get_direct_message_admin()   : returns one uuid
-- 2. same consultant calls it twice                : identical uuid
-- 3. a second consultant calls it                  : same uuid as 1
-- 4. admin calls it                                : fails, insufficient_privilege
-- 5. client calls it                               : fails, insufficient_privilege
-- 6. unauthenticated (anon) calls it               : fails, no EXECUTE privilege
-- 7. consultant selects an admin row from profiles : still 0 rows (RLS intact)
-- 8. select proname, prosecdef, provolatile,
--      proconfig from pg_proc
--      where proname = 'get_direct_message_admin' : secdef t, volatile s,
--                                                    search_path pinned
-- 9. select policyname from pg_policies
--      where tablename = 'profiles'                : unchanged, two policies
--
-- ------------------------------------------------------------- governance ----
-- PROJECT_LOCK.md section 28 "Change Control" requires written approval for a
-- change that adds or modifies a table, enum, status, route, endpoint, payment
-- behaviour, calendar behaviour or auth behaviour. This migration adds none of
-- those: no table, no enum label, no status, no HTTP route or endpoint, no
-- payment or calendar behaviour, and no change to authentication, to any role
-- assignment or to any RLS policy.
--
-- It does, however, contradict the expectation recorded in Amendment 005
-- section 10.2 that "no further schema or policy change is expected" for the
-- consultant interface. That sentence is a forecast, not a prohibition, and
-- the work here remains inside the authorisation given by section 5.2. Under
-- PROJECT_LOCK.md line 5 ("Any deviation requires written approval from Dave")
-- this file should carry Dave's written approval before it is applied, but it
-- does not require a new amendment document.
