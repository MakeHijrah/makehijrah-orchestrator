-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 006: Consultant acceptance transaction RPC
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
   * The Stripe capture webhook may already have changed the
   * consultation from pending_acceptance to captured.
   */
  if v_consultation.status not in (
    'pending_acceptance',
    'captured'
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

  update consultations
  set
    status = 'confirmed',
    accepted_at =
      coalesce(
        accepted_at,
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
  where id = p_consultation_id
  returning *
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
