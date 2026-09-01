-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 051: Allow acceptance recovery from calendar_failed
-- ============================================================
--
-- The defect this fixes, end to end:
--
--   A consultant accepts. The payment is CAPTURED. Creating the
--   Google Calendar event then fails, so the orchestrator sets
--   status = 'admin_attention', admin_attention_reason =
--   'calendar_failed' and returns an error.
--
--   The consultant now cannot accept. Their client has paid, no
--   calendar event exists, and every retry is refused.
--
-- Migration 008 already anticipated this shape of failure and
-- allowed admin_attention to be recovered — but whitelisted only
-- 'calendar_created_confirmation_failed', the *later* of the two
-- post-capture failures. 'calendar_failed' was never added, so the
-- more common failure had no way back.
--
-- Both reasons mean exactly the same thing: the consultant
-- accepted, the money was taken, and an infrastructure step after
-- the capture failed. Both are safe to retry — capture
-- short-circuits on an already succeeded PaymentIntent, and this
-- function is idempotent on replay.
--
-- Terminal reasons stay refused. 'declined' and 'timeout' both
-- cancelled the authorization and an admin cancellation note means
-- the money was refunded; accepting from any of them would confirm
-- a consultation that has no live payment. This remains a
-- whitelist, widened by exactly one value.
--
-- This is migration 008's function reproduced verbatim, including
-- its search_path, with only the recovery whitelist changed. No
-- parameter, no return column, no status transition and no
-- privilege is altered.
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
   * admin_attention is allowed only for recovery from a failure
   * that happened AFTER the payment was captured.
   *
   * Widened by migration 051 to include 'calendar_failed'. Every
   * other reason is terminal: the authorization was cancelled or
   * the payment refunded, so there is nothing left to confirm.
   */
  if v_consultation.status = 'admin_attention'
     and coalesce(
       v_consultation.admin_attention_reason,
       ''
     ) not in (
       'calendar_failed',
       'calendar_created_confirmation_failed'
     ) then
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

-- Privileges restated exactly as migrations 008 and 036 left them.
revoke all
on function public.finalize_consultation_acceptance(
  uuid,
  uuid,
  text,
  text
)
from public, anon, authenticated;

grant execute
on function public.finalize_consultation_acceptance(
  uuid,
  uuid,
  text,
  text
)
to service_role;
