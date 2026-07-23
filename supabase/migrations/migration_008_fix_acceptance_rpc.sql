-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 008: Fix acceptance RPC ambiguity and recovery
-- ============================================================

create or replace function public.finalize_consultation_acceptance(
  p_consultation_id uuid,
  p_consultant_id uuid,
  p_google_event_id text,
  p_meet_link text
)
returns table (
  consultation_id uuid,
  consultation_status consultation_status,
  accepted_at timestamptz,
  google_event_id text,
  meet_link text
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

  if p_consultant_id is null then
    raise exception
      'Consultant ID is required';
  end if;

  if p_google_event_id is null
     or length(trim(p_google_event_id)) = 0 then
    raise exception
      'Google event ID is required';
  end if;

  if p_meet_link is null
     or length(trim(p_meet_link)) = 0 then
    raise exception
      'Meet link is required';
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

  if v_consultation.consultant_id <>
     p_consultant_id then
    raise exception
      'Consultation is not assigned to this consultant';
  end if;

  /*
   * Idempotent replay after successful acceptance.
   */
  if v_consultation.status = 'confirmed'
     and v_consultation.google_event_id =
       trim(p_google_event_id)
     and v_consultation.meet_link =
       trim(p_meet_link) then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.accepted_at,
      v_consultation.google_event_id,
      v_consultation.meet_link;

    return;
  end if;

  /*
   * admin_attention is allowed only for recovery from the known
   * post-calendar finalization failure.
   */
  if v_consultation.status = 'admin_attention'
     and v_consultation.admin_attention_reason <>
       'calendar_created_confirmation_failed' then
    raise exception
      'Consultation cannot be recovered from admin attention reason %',
      v_consultation.admin_attention_reason;
  end if;

  if v_consultation.status not in (
    'pending_acceptance',
    'captured',
    'admin_attention'
  ) then
    raise exception
      'Consultation cannot be accepted from status %',
      v_consultation.status;
  end if;

  if v_consultation.stripe_payment_intent_id is null
     or length(
       trim(
         v_consultation.stripe_payment_intent_id
       )
     ) = 0 then
    raise exception
      'Consultation has no Stripe PaymentIntent';
  end if;

  update consultations as c
  set
    status = 'confirmed',
    accepted_at =
      coalesce(
        c.accepted_at,
        v_now
      ),
    google_event_id =
      trim(p_google_event_id),
    meet_link =
      trim(p_meet_link),
    admin_attention_reason =
      null,
    updated_at =
      v_now
  where c.id = p_consultation_id
  returning c.*
  into v_consultation;

  return query
  select
    v_consultation.id,
    v_consultation.status,
    v_consultation.accepted_at,
    v_consultation.google_event_id,
    v_consultation.meet_link;
end;
$$;

revoke all
on function public.finalize_consultation_acceptance(
  uuid,
  uuid,
  text,
  text
)
from public;

grant execute
on function public.finalize_consultation_acceptance(
  uuid,
  uuid,
  text,
  text
)
to service_role;
