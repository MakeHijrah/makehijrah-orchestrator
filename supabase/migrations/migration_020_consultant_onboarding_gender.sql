-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 020: Consultant onboarding gender capture
-- ============================================================
--
-- Purpose:
-- - Capture consultants.gender during invite redemption.
-- - Replace the four-argument redemption function with a
--   five-argument function that also accepts p_gender.
--
-- Important:
-- - consultants.gender already exists from migration 018 and is
--   constrained to 'male' or 'female'. No enum type is created.
-- - All validation, locking, email binding, role checks, atomic
--   promotion, invite consumption, return columns, and result
--   codes from migration 014 are preserved unchanged.
-- - The obsolete four-argument overload is removed so no legacy
--   signature remains callable.
-- - Execution is restricted to service_role.
-- ============================================================

begin;

/*
 * Remove the obsolete four-argument function.
 *
 * PostgreSQL would otherwise keep it as a callable overload
 * alongside the new five-argument signature.
 */
drop function if exists public.redeem_consultant_invite(
  uuid,
  uuid,
  text,
  text
);

create or replace function public.redeem_consultant_invite(
  p_invite_id uuid,
  p_profile_id uuid,
  p_full_name text,
  p_timezone text,
  p_gender text
)
returns table (
  result_code text,
  profile_id uuid,
  consultant_id uuid,
  profile_role user_role,
  consultant_is_active boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite consultant_invites%rowtype;
  v_profile profiles%rowtype;
  v_existing_consultant consultants%rowtype;
  v_consultant consultants%rowtype;
  v_now timestamptz := now();
  v_full_name text;
  v_timezone text;
  v_gender text;
begin
  /*
   * Validate server-supplied arguments defensively.
   * The orchestrator remains responsible for request validation.
   */
  if p_invite_id is null
     or p_profile_id is null then
    return query
    select
      'VALIDATION_ERROR'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  v_full_name := nullif(
    btrim(coalesce(p_full_name, '')),
    ''
  );

  v_timezone := nullif(
    btrim(coalesce(p_timezone, '')),
    ''
  );

  v_gender := lower(
    btrim(coalesce(p_gender, ''))
  );

  if v_full_name is null
     or char_length(v_full_name) > 200
     or v_timezone is null
     or char_length(v_timezone) > 100 then
    return query
    select
      'VALIDATION_ERROR'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Gender is mandatory during onboarding and is restricted to the
   * two values allowed by the consultants_gender_check constraint.
   */
  if v_gender not in ('male', 'female') then
    return query
    select
      'VALIDATION_ERROR'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Require a valid IANA timezone known to PostgreSQL.
   */
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names
    where name = v_timezone
  ) then
    return query
    select
      'VALIDATION_ERROR'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Lock the invite row.
   *
   * This prevents two concurrent redemption attempts from both
   * observing the invite as unused.
   */
  select ci.*
  into v_invite
  from public.consultant_invites as ci
  where ci.id = p_invite_id
  for update;

  if not found then
    return query
    select
      'INVITE_INVALID'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Used and revoked invitations are intentionally reported with
   * the same generic code.
   */
  if v_invite.status in (
    'used'::invite_status,
    'revoked'::invite_status
  ) then
    return query
    select
      'INVITE_INVALID'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  if v_invite.status = 'expired'::invite_status then
    return query
    select
      'INVITE_EXPIRED'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Persist expiration before returning so stale unused invitations
   * do not remain indefinitely marked as unused.
   */
  if v_invite.expires_at <= v_now then
    update public.consultant_invites as ci
    set status = 'expired'::invite_status
    where ci.id = v_invite.id
      and ci.status = 'unused'::invite_status;

    return query
    select
      'INVITE_EXPIRED'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  if v_invite.status <> 'unused'::invite_status then
    return query
    select
      'INVITE_INVALID'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Lock the authenticated profile so its role cannot change during
   * redemption.
   */
  select p.*
  into v_profile
  from public.profiles as p
  where p.id = p_profile_id
  for update;

  if not found then
    return query
    select
      'FORBIDDEN'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Bind the invitation to the authenticated user's email.
   *
   * Do not reveal the invited email in any response.
   */
  if lower(btrim(v_profile.email)) <>
     lower(btrim(v_invite.email)) then
    return query
    select
      'FORBIDDEN'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Only a normal client profile may be promoted.
   *
   * Admin profiles and existing consultant profiles are rejected.
   */
  if v_profile.role <> 'client'::user_role then
    return query
    select
      'FORBIDDEN'::text,
      null::uuid,
      null::uuid,
      v_profile.role,
      null::boolean;

    return;
  end if;

  /*
   * The unique constraint on consultants.profile_id is the final
   * database safeguard, but detect an existing row explicitly to
   * return a controlled result.
   */
  select c.*
  into v_existing_consultant
  from public.consultants as c
  where c.profile_id = p_profile_id
  for update;

  if found then
    return query
    select
      'FORBIDDEN'::text,
      v_profile.id,
      v_existing_consultant.id,
      v_profile.role,
      v_existing_consultant.is_active;

    return;
  end if;

  /*
   * Promote the profile.
   */
  update public.profiles as p
  set
    role = 'consultant'::user_role,
    full_name = v_full_name,
    updated_at = v_now
  where p.id = p_profile_id
    and p.role = 'client'::user_role
  returning p.*
  into v_profile;

  if not found then
    return query
    select
      'FORBIDDEN'::text,
      null::uuid,
      null::uuid,
      null::user_role,
      null::boolean;

    return;
  end if;

  /*
   * Create the inactive consultant profile using locked defaults.
   *
   * Gender is written atomically with profile_id and timezone.
   *
   * Defaults retained:
   * - working_hours_jsonb = {}
   * - minimum_booking_notice_hours = 24
   * - available_for_general = false
   * - is_active = false
   */
  insert into public.consultants (
    profile_id,
    timezone,
    gender,
    is_active
  )
  values (
    p_profile_id,
    v_timezone,
    v_gender,
    false
  )
  returning *
  into v_consultant;

  /*
   * Consume the invitation only after the profile promotion and
   * consultant creation have succeeded.
   *
   * The row is already locked, and the status predicate provides
   * an additional concurrency safeguard.
   */
  update public.consultant_invites as ci
  set
    status = 'used'::invite_status,
    used_at = v_now,
    used_by_profile_id = p_profile_id
  where ci.id = v_invite.id
    and ci.status = 'unused'::invite_status;

  if not found then
    raise exception
      using
        errcode = 'P0001',
        message =
          'Consultant invite changed during redemption';
  end if;

  return query
  select
    'OK'::text,
    v_profile.id,
    v_consultant.id,
    v_profile.role,
    v_consultant.is_active;
end;
$$;

revoke all
on function public.redeem_consultant_invite(
  uuid,
  uuid,
  text,
  text,
  text
)
from public;

revoke all
on function public.redeem_consultant_invite(
  uuid,
  uuid,
  text,
  text,
  text
)
from anon;

revoke all
on function public.redeem_consultant_invite(
  uuid,
  uuid,
  text,
  text,
  text
)
from authenticated;

grant execute
on function public.redeem_consultant_invite(
  uuid,
  uuid,
  text,
  text,
  text
)
to service_role;

commit;
