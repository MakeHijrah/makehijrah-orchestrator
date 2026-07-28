alter table public.oauth_connections
  add column if not exists health_status text
    not null default 'unknown',
  add column if not exists last_health_check_at timestamptz,
  add column if not exists last_health_success_at timestamptz,
  add column if not exists health_failure_code text,
  add column if not exists health_failure_message text,
  add column if not exists consultant_notified_at timestamptz,
  add column if not exists admin_notified_at timestamptz;

alter table public.oauth_connections
  drop constraint if exists oauth_connections_health_status_check;

alter table public.oauth_connections
  add constraint oauth_connections_health_status_check
  check (
    health_status in (
      'unknown',
      'healthy',
      'revoked',
      'error'
    )
  );

create index if not exists idx_oauth_connections_health_due
  on public.oauth_connections (
    last_health_check_at,
    health_status
  )
  where provider = 'google';

update public.oauth_connections
set
  health_status = case
    when revoked_at is null then 'unknown'
    else 'revoked'
  end,
  health_failure_code = case
    when revoked_at is null then null
    else 'OAUTH_REVOKED'
  end,
  health_failure_message = case
    when revoked_at is null then null
    else 'Google Calendar connection is revoked.'
  end
where provider = 'google';
