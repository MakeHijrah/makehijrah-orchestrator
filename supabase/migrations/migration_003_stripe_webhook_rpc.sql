-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 003: Stripe webhook transaction RPC
-- ============================================================

create or replace function public.process_stripe_webhook_event(
  p_stripe_event_id text,
  p_event_type text,
  p_stripe_payment_intent_id text,
  p_consultation_id uuid,
  p_amount_cents integer,
  p_currency text,
  p_payment_status text,
  p_raw_jsonb jsonb,
  p_consultation_status consultation_status,
  p_payment_authorized_at timestamptz default null,
  p_captured_at timestamptz default null,
  p_cancelled_at timestamptz default null
)
returns table (
  processed boolean,
  already_processed boolean,
  payment_id uuid,
  consultation_status consultation_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_payment payments%rowtype;
  v_payment_id uuid;
  v_consultation_status consultation_status;
begin
  if p_stripe_event_id is null
     or length(trim(p_stripe_event_id)) = 0 then
    raise exception
      'Stripe event ID is required';
  end if;

  if p_stripe_payment_intent_id is null
     or length(trim(p_stripe_payment_intent_id)) = 0 then
    raise exception
      'Stripe PaymentIntent ID is required';
  end if;

  select *
  into v_existing_payment
  from payments
  where stripe_event_id = p_stripe_event_id
  for update;

  if found and v_existing_payment.processed_at is not null then
    select status
    into v_consultation_status
    from consultations
    where id = v_existing_payment.consultation_id;

    return query
    select
      false,
      true,
      v_existing_payment.id,
      v_consultation_status;

    return;
  end if;

  if not exists (
    select 1
    from consultations
    where id = p_consultation_id
    for update
  ) then
    raise exception
      'Consultation not found: %',
      p_consultation_id;
  end if;

  if found then
    update payments
    set
      consultation_id = p_consultation_id,
      stripe_payment_intent_id =
        p_stripe_payment_intent_id,
      event_type = p_event_type,
      amount_cents = p_amount_cents,
      currency = lower(p_currency),
      status = p_payment_status,
      raw_jsonb = p_raw_jsonb,
      processed_at = null,
      processing_error = null
    where id = v_existing_payment.id
    returning id into v_payment_id;
  else
    insert into payments (
      consultation_id,
      stripe_payment_intent_id,
      stripe_event_id,
      event_type,
      amount_cents,
      currency,
      status,
      raw_jsonb,
      processed_at,
      processing_error
    )
    values (
      p_consultation_id,
      p_stripe_payment_intent_id,
      p_stripe_event_id,
      p_event_type,
      p_amount_cents,
      lower(p_currency),
      p_payment_status,
      p_raw_jsonb,
      null,
      null
    )
    returning id into v_payment_id;
  end if;

  update consultations
  set
    stripe_payment_intent_id =
      coalesce(
        stripe_payment_intent_id,
        p_stripe_payment_intent_id
      ),
    status = p_consultation_status,
    payment_authorized_at =
      coalesce(
        p_payment_authorized_at,
        payment_authorized_at
      ),
    captured_at =
      coalesce(
        p_captured_at,
        captured_at
      ),
    cancelled_at =
      coalesce(
        p_cancelled_at,
        cancelled_at
      ),
    updated_at = now()
  where id = p_consultation_id
  returning status
  into v_consultation_status;

  update payments
  set
    processed_at = now(),
    processing_error = null
  where id = v_payment_id;

  return query
  select
    true,
    false,
    v_payment_id,
    v_consultation_status;
end;
$$;

revoke all
on function public.process_stripe_webhook_event(
  text,
  text,
  text,
  uuid,
  integer,
  text,
  text,
  jsonb,
  consultation_status,
  timestamptz,
  timestamptz,
  timestamptz
)
from public;

grant execute
on function public.process_stripe_webhook_event(
  text,
  text,
  text,
  uuid,
  integer,
  text,
  text,
  jsonb,
  consultation_status,
  timestamptz,
  timestamptz,
  timestamptz
)
to service_role;
