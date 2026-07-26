-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 015: Prevent duplicate active consultant invites
-- ============================================================

create or replace function
  public.enforce_single_active_consultant_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_normalized_email text;
begin
  v_normalized_email :=
    lower(btrim(new.email));

  /*
   * Serialize invite creation for the same email.
   * This prevents two concurrent requests from both succeeding.
   */
  perform pg_advisory_xact_lock(
    hashtextextended(
      v_normalized_email,
      0
    )
  );

  /*
   * Convert stale unused invitations to expired before checking
   * whether another active invitation exists.
   */
  update public.consultant_invites
  set status = 'expired'::invite_status
  where lower(btrim(email)) =
      v_normalized_email
    and status = 'unused'::invite_status
    and expires_at <= now();

  if exists (
    select 1
    from public.consultant_invites
    where lower(btrim(email)) =
        v_normalized_email
      and status =
        'unused'::invite_status
      and expires_at > now()
  ) then
    raise exception
      using
        errcode = 'P0001',
        message =
          'ACTIVE_CONSULTANT_INVITE_EXISTS';
  end if;

  new.email := v_normalized_email;

  return new;
end;
$$;

drop trigger if exists
  enforce_single_active_consultant_invite
on public.consultant_invites;

create trigger
  enforce_single_active_consultant_invite
before insert
on public.consultant_invites
for each row
execute function
  public.enforce_single_active_consultant_invite();

revoke all
on function
  public.enforce_single_active_consultant_invite()
from public;

grant execute
on function
  public.enforce_single_active_consultant_invite()
to service_role;