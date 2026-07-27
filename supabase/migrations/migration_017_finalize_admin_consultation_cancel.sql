begin;

create or replace function public.finalize_admin_consultation_cancel(
  p_consultation_id uuid,
  p_refund boolean,
  p_note text default null
)
returns table (
  consultation_id uuid,
  consultation_status public.consultation_status,
  cancelled_at timestamptz,
  admin_attention_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_consultation public.consultations%rowtype;
  v_target_status public.consultation_status;
  v_note text;
begin
  select *
  into v_consultation
  from public.consultations
  where id = p_consultation_id
  for update;

  if not found then
    raise exception 'CONSULTATION_NOT_FOUND';
  end if;

  v_target_status :=
    case
      when p_refund then 'refunded'::public.consultation_status
      else 'cancelled'::public.consultation_status
    end;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  /*
   * Never downgrade a completed refund back to cancelled.
   */
  if v_consultation.status = 'refunded' then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.cancelled_at,
      v_consultation.admin_attention_reason;

    return;
  end if;

  /*
   * Repeated non-refund cancellation is idempotent.
   */
  if v_consultation.status = 'cancelled'
     and not p_refund then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.cancelled_at,
      v_consultation.admin_attention_reason;

    return;
  end if;

  /*
   * A refund may only finalize a consultation whose payment could have
   * already been captured, or one previously operationally cancelled.
   *
   * Stripe refund creation must happen before this RPC is called.
   */
  if p_refund
     and v_consultation.status not in (
       'confirmed',
       'captured',
       'completed',
       'cancelled',
       'admin_attention'
     ) then
    raise exception
      'INVALID_REFUND_TRANSITION:%',
      v_consultation.status;
  end if;

  /*
   * Non-refund administrative cancellation is permitted for any active
   * or intervention state. Terminal refunded records are handled above.
   */
  if not p_refund
     and v_consultation.status not in (
       'draft',
       'payment_authorized',
       'pending_acceptance',
       'confirmed',
       'declined',
       'admin_attention',
       'completed',
       'authorization_cancelled',
       'captured',
       'cancelled'
     ) then
    raise exception
      'INVALID_CANCEL_TRANSITION:%',
      v_consultation.status;
  end if;

  update public.consultations
  set
    status = v_target_status,
    cancelled_at = coalesce(
      consultations.cancelled_at,
      now()
    ),
    admin_attention_reason = coalesce(
      v_note,
      consultations.admin_attention_reason
    ),
    updated_at = now()
  where id = p_consultation_id
  returning *
  into v_consultation;

  return query
  select
    v_consultation.id,
    v_consultation.status,
    v_consultation.cancelled_at,
    v_consultation.admin_attention_reason;
end;
$$;

revoke all on function public.finalize_admin_consultation_cancel(
  uuid,
  boolean,
  text
) from public;

revoke all on function public.finalize_admin_consultation_cancel(
  uuid,
  boolean,
  text
) from anon;

revoke all on function public.finalize_admin_consultation_cancel(
  uuid,
  boolean,
  text
) from authenticated;

grant execute on function public.finalize_admin_consultation_cancel(
  uuid,
  boolean,
  text
) to service_role;

comment on function public.finalize_admin_consultation_cancel(
  uuid,
  boolean,
  text
) is
  'Finalizes an administrator-controlled consultation cancellation or refund after required Stripe and Google actions succeed. Service role only.';

commit;
