-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 031: Direct message admin contact avatar
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 005 §5.2, extended to the contact
--   avatar.
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- The problem this solves:
-- - The administrator avatar is managed in /admin/settings and
--   stored in public.profiles.avatar_url. Consultant messaging
--   needs to render it beside the conversation.
-- - A consultant cannot read an admin profile row:
--   profiles_select_own_or_admin restricts SELECT to the caller's
--   own row (or an admin's). So the avatar is invisible to exactly
--   the person the conversation is with.
-- - Widening profiles SELECT would expose email, phone_whatsapp
--   and every other private column in order to reach one field.
--   That is not done here and is not authorised.
--
-- The approved shape:
-- - A second SECURITY DEFINER function, taking NO argument, that
--   returns exactly one row of exactly two public-safe columns for
--   exactly the one administrator the caller may already message.
--
-- Why this is the smallest safe fix:
-- - Authorisation and administrator selection are not reimplemented
--   here. This function CALLS public.get_direct_message_admin(),
--   so the caller must pass that function's consultant check, and
--   the administrator returned is by construction the same one it
--   resolves. The two cannot drift apart, because there is only one
--   implementation.
-- - The only new capability is reading avatar_url for that already
--   authorised, already determined profile id.
--
-- Deliberately NOT done here:
-- - No RLS policy change of any kind. profiles SELECT is untouched.
-- - public.get_direct_message_admin() is neither altered nor
--   dropped. Migration 024 remains in force exactly as written.
-- - No table, column, constraint, trigger or enum change. The data
--   model remains 16 tables.
-- - No email, phone_whatsapp, role, timestamps or any other
--   profiles column is returned. Two columns, both public-safe.
--
-- Rerun safety:
-- - CREATE OR REPLACE on a function this migration introduces, plus
--   idempotent guards. Safe to run more than once, provided no
--   later migration has replaced this same function.
-- ============================================================

begin;

-- ---------------------------------------------------------- preconditions ----
-- Fail loudly and before anything else if the objects this
-- function depends on are not present.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'migration 031: public.profiles not found';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'profiles'
       and column_name  = 'avatar_url'
  ) then
    raise exception 'migration 031: public.profiles.avatar_url not found';
  end if;

  -- The whole design depends on delegating to this function.
  if to_regprocedure('public.get_direct_message_admin()') is null then
    raise exception
      'migration 031: public.get_direct_message_admin() not found - migration 024 must be applied first';
  end if;

  -- Required by the grant/revoke block below.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'migration 031: role anon not found';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'migration 031: role authenticated not found';
  end if;
end;
$$;

-- ---------------------------------------------------------------- function ----
-- SECURITY DEFINER because the caller cannot read admin rows under
-- profiles_select_own_or_admin. The definer's reach is confined the
-- same way migration 024 confines it: the function takes no
-- argument, delegates the caller check to
-- get_direct_message_admin(), and returns two public-safe columns
-- for one profile.
--
-- search_path is the hardened pg_catalog, public form used from
-- migration 027 onward. Migration 024 predates that convention and
-- is deliberately left as it is; this migration does not touch it.

create or replace function public.get_direct_message_admin_contact()
returns table (
  profile_id uuid,
  avatar_url text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_admin_id uuid;
begin
  /*
   * 1. Authorisation AND administrator selection, in one call.
   *
   *    get_direct_message_admin() raises insufficient_privilege
   *    unless auth.uid() is present and resolves to a profile whose
   *    role is exactly 'consultant', and raises no_data_found when
   *    no administrator exists. Every one of those failures
   *    propagates from here unchanged, because nothing below
   *    catches them.
   *
   *    Delegating rather than copying is the point: the caller
   *    check and the deterministic oldest-admin-first selection
   *    have exactly one implementation, so this function cannot
   *    authorise someone that one would refuse, and cannot name an
   *    administrator that one would not.
   */
  v_admin_id := public.get_direct_message_admin();

  /*
   * 2. Two public-safe columns for that one profile.
   *
   *    The id is the value returned above, never anything a caller
   *    supplied - this function accepts no argument, so there is no
   *    parameter through which another profile could be requested.
   *
   *    The select list is exhaustive on purpose. email,
   *    phone_whatsapp, role, full_name, created_at and every other
   *    column stay behind.
   */
  return query
  select p.id, p.avatar_url
    from public.profiles p
   where p.id = v_admin_id;
end;
$$;

comment on function public.get_direct_message_admin_contact() is
  'Amendment 005 section 5.2, extended for the contact avatar. Returns exactly '
  'one row - profile_id and avatar_url - for the single deterministic '
  'administrator a consultant may open a direct conversation with, so consultant '
  'messaging can render the admin avatar managed in /admin/settings. Delegates '
  'both the consultant authorisation check and the administrator selection to '
  'public.get_direct_message_admin(), so the two can never disagree. Takes no '
  'argument, so it cannot be used as a general profile lookup. Returns no email, '
  'phone_whatsapp, role or any other profiles column. Does not widen profiles '
  'visibility and does not alter any RLS policy.';

-- -------------------------------------------------------------- privileges ----
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. Revoke that
-- first, then grant to authenticated only. anon is revoked
-- explicitly as well as through PUBLIC, so the intent survives any
-- future grant to PUBLIC.
--
-- service_role is deliberately NOT granted: this function exists
-- for an authenticated consultant acting as themselves, and the
-- orchestrator's service-role client can already read profiles
-- directly. Matches migration 024.

revoke all on function public.get_direct_message_admin_contact() from public;
revoke all on function public.get_direct_message_admin_contact() from anon;
grant execute on function public.get_direct_message_admin_contact() to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See MIGRATION_031_VERIFICATION.sql
-- for the full self-contained suite.
--
--  1. select count(*) from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname = 'get_direct_message_admin_contact';
--       -> 1
--
--  2. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
