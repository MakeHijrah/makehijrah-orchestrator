-- MakeHijrah Relocation OS v1.0
-- migration_005_create_draft_consultation_rpc.sql
--
-- Purpose:
-- Atomically create a draft consultation and its intake row.
-- Callable only by the Supabase service role through the orchestrator.

begin;

create or replace function public.create_draft_consultation(
  p_client_profile_id uuid,
  p_consultant_id uuid,
  p_country_id uuid,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at timestamptz,
  p_client_timezone text,
  p_price_cents integer,
  p_currency text,
  p_full_name text,
  p_email text,
  p_phone_whatsapp text,
  p_answers_jsonb jsonb
)
returns table (
  consultation_id uuid,
  consultation_status consultation_status,
  hold_expires_at timestamptz,
  consultation_price_cents integer,
  consultation_currency text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_consultation_id uuid;
  v_created_at timestamptz;
begin
  if p_scheduled_end_at <= p_scheduled_start_at then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation end time must be later than start time.';
  end if;

  if p_price_cents <= 0 then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation price must be greater than zero.';
  end if;

  if p_currency is null or p_currency <> lower(p_currency) then
    raise exception
      using
        errcode = '22023',
        message = 'Consultation currency must be lowercase.';
  end if;

  insert into public.consultations (
    client_profile_id,
    consultant_id,
    country_id,
    status,
    scheduled_start_at,
    scheduled_end_at,
    client_timezone,
    price_cents,
    currency
  )
  values (
    p_client_profile_id,
    p_consultant_id,
    p_country_id,
    'draft',
    p_scheduled_start_at,
    p_scheduled_end_at,
    p_client_timezone,
    p_price_cents,
    p_currency
  )
  returning
    id,
    created_at
  into
    v_consultation_id,
    v_created_at;

  insert into public.consultation_intake (
    consultation_id,
    full_name,
    email,
    phone_whatsapp,
    answers_jsonb
  )
  values (
    v_consultation_id,
    p_full_name,
    p_email,
    nullif(trim(p_phone_whatsapp), ''),
    coalesce(p_answers_jsonb, '{}'::jsonb)
  );

  return query
  select
    v_consultation_id,
    'draft'::consultation_status,
    v_created_at + interval '30 minutes',
    p_price_cents,
    p_currency;
end;
$$;

revoke all
on function public.create_draft_consultation(
  uuid,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  text,
  integer,
  text,
  text,
  text,
  text,
  jsonb
)
from public;

revoke all
on function public.create_draft_consultation(
  uuid,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  text,
  integer,
  text,
  text,
  text,
  text,
  jsonb
)
from anon;

revoke all
on function public.create_draft_consultation(
  uuid,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  text,
  integer,
  text,
  text,
  text,
  text,
  jsonb
)
from authenticated;

grant execute
on function public.create_draft_consultation(
  uuid,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  text,
  integer,
  text,
  text,
  text,
  text,
  jsonb
)
to service_role;

comment on function public.create_draft_consultation(
  uuid,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  text,
  integer,
  text,
  text,
  text,
  text,
  jsonb
) is
  'Service-role-only atomic creation of a draft consultation and consultation intake row.';

commit;
