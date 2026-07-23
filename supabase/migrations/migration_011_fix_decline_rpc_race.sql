-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 011: Fix consultant decline webhook race
-- ============================================================

create or replace function public.finalize_consultation_decline(
  p_consultation_id uuid,
  p_consultant_id uuid,
  p_decline_reason text default null
)
returns table (
  consultation_id uuid,
  consultation_status consultation_status,
  declined_at timestamptz,
  admin_attention_reason text
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
   * Idempotent replay after successful decline.
   */
  if v_consultation.status = 'admin_attention'
     and v_consultation.admin_attention_reason = 'declined'
     and v_consultation.declined_at is not null then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.declined_at,
      v_consultation.admin_attention_reason;

    return;
  end if;

  /*
   * The Stripe canceled webhook may arrive before this RPC.
   */
  if v_consultation.status not in (
    'pending_acceptance',
    'authorization_cancelled'
  ) then
    raise exception
      'Consultation cannot be declined from status %',
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
    status =
      'admin_attention',
    declined_at =
      coalesce(
        c.declined_at,
        v_now
      ),
    admin_attention_reason =
      'declined',
    updated_at =
      v_now
  where c.id =
    p_consultation_id
  returning c.*
  into v_consultation;

  return query
  select
    v_consultation.id,
    v_consultation.status,
    v_consultation.declined_at,
    v_consultation.admin_attention_reason;
end;
$$;

revoke all
on function public.finalize_consultation_decline(
  uuid,
  uuid,
  text
)
from public;

grant execute
on function public.finalize_consultation_decline(
  uuid,
  uuid,
  text
)
to service_role;
