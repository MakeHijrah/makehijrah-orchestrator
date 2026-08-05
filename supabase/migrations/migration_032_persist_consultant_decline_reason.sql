-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 032: Persist consultant decline reason
-- ============================================================
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- The problem this solves:
-- - finalize_consultation_decline has accepted p_decline_reason
--   since migration 010, and has never stored it. The orchestrator
--   passes a reason on every decline (decline.service.ts), so the
--   argument has been silently discarded for the whole life of the
--   function. Nothing recorded why a consultant declined.
--
-- What this migration does:
--   A. Adds public.consultations.consultant_decline_reason.
--   B. Replaces finalize_consultation_decline with the identical
--      migration 011 contract, changing ONLY that the already
--      accepted argument is now written to that column.
--
-- Deliberately NOT done here:
-- - No change to the function signature, its argument names, its
--   returned columns, its SECURITY DEFINER attribute, its
--   search_path, or its grants. Migration 011's `set search_path =
--   public` is carried through verbatim rather than modernised to
--   the pg_catalog, public form used from migration 027 onward;
--   hardening it is a separate decision, not a side effect of
--   storing a string.
-- - No change to consultation statuses, the transition guards, the
--   idempotent replay branch, the FOR UPDATE lock, the Stripe
--   PaymentIntent precondition, admin_attention_reason, declined_at
--   or updated_at.
-- - No refund logic, no notification, no Redis payload, no email
--   content, no RLS policy is touched. This migration writes one
--   column and nothing else.
-- - No backfill. The reason was never stored, so there is no
--   historical source to recover it from; every pre-existing row
--   keeps a null and that null is honest.
-- - No table, trigger or enum change. The data model remains
--   16 tables.
--
-- Rerun safety:
-- - The column add is idempotent. The function replacement is not:
--   do not reapply this migration after a later migration has
--   replaced finalize_consultation_decline, because CREATE OR
--   REPLACE would reinstate migration 032's older body.
-- ============================================================

begin;

-- ------------------------------------------- A. Decline reason column ----
--
-- Nullable with no default. A decline carries no reason when the
-- consultant supplied none, and null is the honest representation
-- of that. It is not defaulted to an empty string, which would be
-- indistinguishable from a reason of zero length.
--
-- The column is on consultations rather than a new table because
-- it is a single attribute of exactly one consultation, written
-- once at the moment of decline.

do $$
begin
  if to_regclass('public.consultations') is null then
    raise exception 'migration 032: public.consultations not found';
  end if;

  if to_regprocedure(
       'public.finalize_consultation_decline(uuid,uuid,text)'
     ) is null then
    raise exception
      'migration 032: finalize_consultation_decline(uuid,uuid,text) not found - migration 011 must be applied first';
  end if;
end;
$$;

alter table public.consultations
  add column if not exists consultant_decline_reason text;

comment on column public.consultations.consultant_decline_reason is
  'The reason a consultant gave when declining, as supplied to '
  'public.finalize_consultation_decline. Null when no reason was given, or '
  'when the reason was blank or whitespace only. Null on every consultation '
  'declined before migration 032, because the argument was accepted and '
  'discarded until then. Never written by any other path.';

-- --------------------------------------------- B. RPC replacement ----
-- Identical to migration 011 in every respect - signature,
-- argument names, returned columns, status guards, idempotent
-- replay, FOR UPDATE locking, PaymentIntent precondition,
-- admin_attention_reason, declined_at, updated_at, SECURITY
-- DEFINER, search_path and grants - except that p_decline_reason
-- is now stored.
--
-- The stored value is nullif(btrim(p_decline_reason), ''): a null
-- argument stays null, and a blank or whitespace-only argument
-- becomes null rather than being recorded as a reason that says
-- nothing.
--
-- The write sits inside the SAME single UPDATE that sets the
-- status, so the reason cannot be persisted for a decline that did
-- not otherwise complete, and any failure rolls the two back
-- together.
--
-- The idempotent replay branch above returns BEFORE this UPDATE,
-- so replaying a completed decline cannot overwrite the reason
-- recorded by the first one. That is why the assignment is a plain
-- write rather than a coalesce over the existing value.

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
    consultant_decline_reason =
      nullif(
        btrim(
          p_decline_reason
        ),
        ''
      ),
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

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See MIGRATION_032_VERIFICATION.sql
-- for the full self-contained suite.
--
--  1. select count(*) from information_schema.columns
--      where table_schema = 'public'
--        and table_name   = 'consultations'
--        and column_name  = 'consultant_decline_reason';
--       -> 1
--
--  2. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
