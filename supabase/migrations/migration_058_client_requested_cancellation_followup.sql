-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 058: Client-requested cancellation follow-up
-- ============================================================
--
-- Classification:
-- - Additive feature migration. One column, one constraint, one
--   RPC replaced to persist it atomically with the cancellation
--   it already performs.
--
-- The problem this solves:
-- - A consultation reaching status = 'cancelled' records nothing
--   about WHY. An admin cancelling because a client called and
--   asked to cancel, an admin cancelling because a booking was
--   made in error, and a client-initiated cancellation once one
--   exists (there is none today — see below) are indistinguishable
--   at the data layer. A follow-up email asking "what happened?"
--   fired off every cancelled row would reach people whose
--   consultant made an error or whose booking was cancelled for a
--   reason that has nothing to do with their own intent — the
--   opposite of the non-presumptuous tone that email is written in.
--
-- What this migration does:
--   A. consultations.cancellation_source text, nullable, no
--      default, constrained to 'client_requested' | 'admin' |
--      'system'.
--   B. finalize_admin_consultation_cancel gains a fourth
--      parameter, p_cancellation_source, defaulted to 'admin' so
--      an existing caller that does not yet pass it behaves
--      exactly as before.
--
-- Why this is the admin RPC and not a new client endpoint:
-- - There is still no client self-service cancellation endpoint
--   in this backend, and this migration does not add one. Every
--   'cancelled' consultation is cancelled by an admin, through
--   this function, whether the admin is acting on their own
--   judgement or because a client asked them to. 'client_requested'
--   records WHICH of those two happened, decided by the admin
--   through a structured field — never inferred from the existing
--   free-text note, which stays exactly as free-text as before.
--
-- Why 'system' is in the vocabulary but never written by this
-- migration:
-- - Two other paths can also set status = 'cancelled':
--   abandon_draft_consultation (migration 046, a visitor
--   superseding an unpaid draft) and
--   expire_stale_draft_consultations (migration 047, an
--   abandoned unpaid draft timing out). Both are genuinely
--   'system' in character, but neither is the function this
--   migration was asked to change, and neither transition is one
--   a client could recognise as "cancelling a booking" — no
--   payment, frequently no completed intake. Widening their scope
--   is a separate decision; rows they cancel keep
--   cancellation_source = null, which the constraint permits and
--   which reads honestly: "not classified by this migration,"
--   not "system, asserted."
--
-- Backward compatibility:
-- - finalize_admin_consultation_cancel's RETURNS TABLE gains a
--   column, which PostgreSQL does not permit via CREATE OR
--   REPLACE — the function is dropped and recreated. This is
--   safe for every existing caller: Supabase's .rpc() call always
--   passes named parameters, the three original parameter names
--   (p_consultation_id, p_refund, p_note) are unchanged, and the
--   new parameter carries a default. A caller that has not been
--   updated to pass p_cancellation_source omits the key entirely
--   and gets 'admin' — never client_requested, never inferred.
-- - A dropped function loses its ACL. Every grant this function
--   already carried (migrations 017, 036) is re-asserted below,
--   explicitly, by name — REVOKE ... FROM PUBLIC alone does not
--   remove Supabase's ambient default EXECUTE grant to anon and
--   authenticated, which is exactly the defect migration 036
--   exists to correct and which a drop-and-recreate would
--   otherwise silently reopen.
--
-- Deliberately NOT done here:
-- - No backfill. Every consultation already cancelled keeps
--   cancellation_source = null, permanently — this migration
--   invents no history. A null is never treated as
--   'client_requested' by anything that reads this column.
-- - No change to refund logic, note semantics, the status
--   vocabulary, the existing transition guards, or the two
--   idempotent early-return branches (already-refunded,
--   already-cancelled-and-not-refunding). A repeat call against
--   an already-cancelled consultation returns the stored row
--   unchanged and does not re-evaluate or overwrite
--   cancellation_source — the same idempotency that already
--   protects status and admin_attention_reason from a second
--   invocation now protects this column too, for free.
-- - No email, no notification, no new endpoint, no new RPC. This
--   migration is the structured signal the follow-up email will
--   read; sending it is orchestrator code, not database logic.
--
-- Rerun safety:
-- - Idempotent. The column add is guarded, the constraint is
--   dropped before being re-added, and the function is dropped
--   and recreated identically on a second run.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.consultations') is null then
    raise exception
      'migration 058: public.consultations not found';
  end if;

  if to_regprocedure(
       'public.finalize_admin_consultation_cancel(uuid,boolean,text)'
     ) is null then
    raise exception
      'migration 058: finalize_admin_consultation_cancel(uuid,boolean,text) not found - migration 017 must be applied first';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- A. consultations.cancellation_source
-- ------------------------------------------------------------
--
-- Nullable with no default. A consultation that has never been
-- through the admin cancel RPC under this migration has nothing
-- to say about a cancellation source, and null says exactly that
-- rather than asserting a value nobody chose.

alter table public.consultations
  add column if not exists cancellation_source text;

alter table public.consultations
  drop constraint if exists consultations_cancellation_source_check;
alter table public.consultations
  add constraint consultations_cancellation_source_check
  check (
    cancellation_source is null
    or cancellation_source in ('client_requested', 'admin', 'system')
  );

comment on column public.consultations.cancellation_source is
  'Migration 058. Why an admin-performed cancellation happened: '
  '''client_requested'' when the admin is acting because the '
  'client asked to cancel, ''admin'' for an administrative '
  'decision, ''system'' reserved for automated cancellation paths '
  '(not currently written by any of them). Null on every row '
  'cancelled before this migration, and on any row cancelled by a '
  'path this migration does not touch. Never inferred from free '
  'text; set only by an explicit, structured caller argument. '
  'client_requested is the sole trigger for the cancellation '
  'follow-up email.';

-- ------------------------------------------------------------
-- B. finalize_admin_consultation_cancel — one new parameter
-- ------------------------------------------------------------
--
-- Every branch below is byte-for-byte migration 017's logic
-- except: the new parameter, its validation, its presence in the
-- UPDATE and in the returned row. The refund/no-refund transition
-- rules, the two idempotent early returns, and the note handling
-- are unchanged.

drop function if exists public.finalize_admin_consultation_cancel(
  uuid, boolean, text
);

create or replace function public.finalize_admin_consultation_cancel(
  p_consultation_id uuid,
  p_refund boolean,
  p_note text default null,
  p_cancellation_source text default 'admin'
)
returns table (
  consultation_id uuid,
  consultation_status public.consultation_status,
  cancelled_at timestamptz,
  admin_attention_reason text,
  cancellation_source text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_consultation public.consultations%rowtype;
  v_target_status public.consultation_status;
  v_note text;
  v_source text;
begin
  v_source := nullif(btrim(coalesce(p_cancellation_source, '')), '');

  /*
   * Validated here as well as by the table CHECK, matching this
   * project's convention for an RPC argument the table would
   * otherwise reject with a less specific error: a named marker
   * the orchestrator layer can map to a clean 400, before any row
   * is touched.
   */
  if v_source is not null
     and v_source not in ('client_requested', 'admin', 'system') then
    raise exception
      'INVALID_CANCELLATION_SOURCE:%', v_source;
  end if;

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
      v_consultation.admin_attention_reason,
      v_consultation.cancellation_source;

    return;
  end if;

  /*
   * Repeated non-refund cancellation is idempotent. The stored
   * cancellation_source from the FIRST successful call is what is
   * returned; a second call cannot overwrite it, deliberately —
   * see the migration header.
   */
  if v_consultation.status = 'cancelled'
     and not p_refund then
    return query
    select
      v_consultation.id,
      v_consultation.status,
      v_consultation.cancelled_at,
      v_consultation.admin_attention_reason,
      v_consultation.cancellation_source;

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
    cancellation_source = coalesce(
      consultations.cancellation_source,
      v_source
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
    v_consultation.admin_attention_reason,
    v_consultation.cancellation_source;
end;
$$;

-- Re-asserted by name, not only from PUBLIC. See "Backward
-- compatibility" above.
revoke all on function public.finalize_admin_consultation_cancel(
  uuid, boolean, text, text
) from public, anon, authenticated;

grant execute on function public.finalize_admin_consultation_cancel(
  uuid, boolean, text, text
) to service_role;

comment on function public.finalize_admin_consultation_cancel(
  uuid, boolean, text, text
) is
  'Finalizes an administrator-controlled consultation cancellation '
  'or refund after required Stripe and Google actions succeed. '
  'Migration 058 adds p_cancellation_source (default ''admin''), '
  'persisted once and never overwritten by a repeat call. Service '
  'role only.';

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_058_VERIFICATION.sql for the full self-contained suite.
--
--  1. select data_type, is_nullable, column_default
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'consultations'
--        and column_name = 'cancellation_source';
--       -> text | YES | null
--
--  2. select count(*) from public.consultations
--      where cancellation_source is not null;
--       -> 0 immediately after applying (no backfill)
--
--  3. select has_function_privilege('anon',
--       'public.finalize_admin_consultation_cancel(uuid,boolean,text,text)',
--       'EXECUTE');
--       -> false
