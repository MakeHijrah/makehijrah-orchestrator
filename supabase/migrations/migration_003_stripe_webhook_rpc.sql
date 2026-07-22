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
  v_payment payments%rowtype;
  v_consultation consultations%rowtype;
begin
  if p_stripe_event_id is null
     or length(trim(p_stripe_event_id)) = 0 then
    raise exception
      'Stripe event ID is required';
  end if;

  if p_event_type is null
     or length(trim(p_event_type)) = 0 then
    raise exception
      'Stripe event type is required';
  end if;

  if p_stripe_payment_intent_id is null
     or length(trim(p_stripe_payment_intent_id)) = 0 then
    raise exception
      'Stripe PaymentIntent ID is required';
  end if;

  if p_consultation_id is null then
    raise exception
      'Consultation ID is required';
  end if;

  if p_amount_cents is null
     or p_amount_cents < 0 then
    raise exception
      'Stripe amount must be zero or greater';
  end if;

  if p_currency is null
     or length(trim(p_currency)) <> 3 then
    raise exception
      'Stripe currency must contain exactly three characters';
  end if;

  if p_payment_status is null
     or length(trim(p_payment_status)) = 0 then
    raise exception
      'Stripe payment status is required';
  end if;

  /*
   * Insert the event ledger row first.
   *
   * ON CONFLICT handles concurrent delivery of the same Stripe
   * event without creating duplicate payment rows.
   */
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
    trim(p_stripe_payment_intent_id),
    trim(p_stripe_event_id),
    trim(p_event_type),
    p_amount_cents,
    lower(trim(p_currency)),
    trim(p_payment_status),
    p_raw_jsonb,
    null,
    null
  )
  on conflict (stripe_event_id)
  do nothing;

  /*
   * Lock the payment event row.
   *
   * A replay with processed_at set is a successful no-op.
   * A replay with processed_at null retries the transaction.
   */
  select *
  into v_payment
  from payments
  where stripe_event_id =
    trim(p_stripe_event_id)
  for update;

  if not found then
    raise exception
      'Stripe payment event row could not be created or loaded';
  end if;

  if v_payment.processed_at is not null then
    select *
    into v_consultation
    from consultations
    where id = v_payment.consultation_id;

    return query
    select
      false,
      true,
      v_payment.id,
      v_consultation.status;

    return;
  end if;

  /*
   * Lock the consultation before applying its state transition.
   */
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
   * Prevent a Stripe event from replacing a different
   * PaymentIntent already attached to the consultation.
   */
  if v_consultation.stripe_payment_intent_id is not null
     and v_consultation.stripe_payment_intent_id <>
       trim(p_stripe_payment_intent_id) then
    raise exception
      'Consultation % is already linked to a different PaymentIntent',
      p_consultation_id;
  end if;

  /*
   * Refresh an existing unprocessed payment row before retrying.
   */
  update payments
  set
    consultation_id =
      p_consultation_id,
    stripe_payment_intent_id =
      trim(p_stripe_payment_intent_id),
    event_type =
      trim(p_event_type),
    amount_cents =
      p_amount_cents,
    currency =
      lower(trim(p_currency)),
    status =
      trim(p_payment_status),
    raw_jsonb =
      p_raw_jsonb,
    processed_at =
      null,
    processing_error =
      null
  where id = v_payment.id;

  /*
   * The payment ledger update and consultation transition occur
   * inside this single database transaction.
   */
  update consultations
  set
    stripe_payment_intent_id =
      trim(p_stripe_payment_intent_id),
    status =
      p_consultation_status,
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
    updated_at =
      now()
  where id = p_consultation_id
  returning *
  into v_consultation;

  update payments
  set
    processed_at = now(),
    processing_error = null
  where id = v_payment.id;

  return query
  select
    true,
    false,
    v_payment.id,
    v_consultation.status;
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
