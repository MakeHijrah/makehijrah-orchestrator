-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 012: Complete consultation
-- ============================================================

create or replace function public.complete_consultation(
  p_consultation_id uuid,
  p_consultant_id uuid default null,
  p_is_admin boolean default false
)
returns table (
  consultation_id uuid,
  consultation_status consultation_status,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_consultation consultations%rowtype;
  v_now timestamptz := now();
begin
  if p_consultation_id is null then
    raise exception
      'Consultation ID is required';
  end if;

  if not p_is_admin
     and p_consultant_id is null then
    raise exception
      'Consultant ID is required';
  end if;

  select *
  into v_consultation
  from consultations
  where id = p_consultation_id
  for update;

  if not found then
    raise exception
      'Consultation not found: %',
      p_consultation_id;
  end if;

  if not p_is_admin
     and v_consultation.consultant_id <>
       p_consultant_id then
    raise exception
      'Consultation is not assigned to this consultant';
  end if;

  /*
   * Idempotent replay after successful completion.
   */
  if v_consultation.status = 'completed'
     and v_consultation.completed_at is not null then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.completed_at;

    return;
  end if;

  if v_consultation.status not in (
    'confirmed',
    'captured'
  ) then
    raise exception
      'Consultation cannot be completed from status %',
      v_consultation.status;
  end if;

  if v_consultation.scheduled_end_at >
     v_now then
    raise exception
      'Consultation cannot be completed before its scheduled end time';
  end if;

  update consultations as c
  set
    status = 'completed',
    completed_at = coalesce(
      c.completed_at,
      v_now
    ),
    updated_at = v_now
  where c.id = p_consultation_id
  returning c.*
  into v_consultation;

  return query
  select
    v_consultation.id,
    v_consultation.status,
    v_consultation.completed_at;
end;
$$;

revoke all
on function public.complete_consultation(
  uuid,
  uuid,
  boolean
)
from public;

grant execute
on function public.complete_consultation(
  uuid,
  uuid,
  boolean
)
to service_role;
