-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 016: Finalize authorization timeout
-- ============================================================

create or replace function public.finalize_authorization_timeout(
  p_consultation_id uuid
)
returns table (
  consultation_id uuid,
  consultation_status consultation_status,
  cancelled_at timestamptz,
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

  /*
   * Idempotent replay after a successful timeout.
   */
  if v_consultation.status =
       'admin_attention'
     and v_consultation.admin_attention_reason =
       'timeout'
     and v_consultation.cancelled_at is not null then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.cancelled_at,
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
      'Consultation cannot time out from status %',
      v_consultation.status;
  end if;

  if v_consultation.payment_authorized_at is null then
    raise exception
      'Consultation has no payment authorization timestamp';
  end if;

  if v_consultation.payment_authorized_at >
     v_now - interval '48 hours' then
    raise exception
      'Consultation authorization has not expired';
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
    cancelled_at =
      coalesce(
        c.cancelled_at,
        v_now
      ),
    admin_attention_reason =
      'timeout',
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
    v_consultation.cancelled_at,
    v_consultation.admin_attention_reason;
end;
$$;

revoke all
on function public.finalize_authorization_timeout(
  uuid
)
from public;

grant execute
on function public.finalize_authorization_timeout(
  uuid
)
to service_role;