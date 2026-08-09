-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 047: Expire stale draft consultations
-- ============================================================
--
-- Classification:
-- - Operational completion. One function. No table, no column, no
--   index, no policy, no grant on any existing object, and no
--   change to any finance rule.
--
-- WHAT THIS FIXES:
--
-- A draft consultation IS the slot hold. unique_reserved_consultant_
-- slot covers draft, payment_authorized, pending_acceptance,
-- confirmed and captured, so while a row sits in 'draft' nobody
-- else can book that time.
--
-- create_draft_consultation has always advertised a hold of thirty
-- minutes - hold_expires_at is created_at + interval '30 minutes' -
-- and checkout has always refused a draft past it. But nothing ever
-- CANCELLED one. The expire-drafts job named in API_CONTRACT
-- section 5 was specified, indexed for, and never written:
-- idx_consultations_stale_drafts on (status, created_at) where
-- status = 'draft' has been sitting unused in migration 001 since
-- day one.
--
-- So a visitor who reached the payment step and closed the tab held
-- that slot forever. So did every draft left behind by the
-- migration 045 outage. "Thirty minute hold" was true of what
-- checkout would accept and false of what the calendar would offer.
--
-- WHY THE CUTOFF IS HERE AND NOT IN THE WORKER:
--
-- The thirty minutes is defined by create_draft_consultation, in
-- SQL, as part of hold_expires_at. Expressing the expiry cutoff in
-- TypeScript would make a second definition of the same rule that
-- can drift from the first - and a worker that disagreed with
-- hold_expires_at would either cancel live bookings or leave dead
-- ones standing. The cutoff belongs beside the definition.
--
-- (There is already a second copy in checkout.service.ts as
-- DRAFT_HOLD_MINUTES. That predates this migration and is not
-- addressed here; noted so it is not mistaken for something this
-- migration introduced.)
--
-- WHY ONE SET-BASED STATEMENT:
--
-- The worker runs in every Railway replica. A single UPDATE is
-- atomic, so a second replica's call simply matches the rows the
-- first has not taken - FOR UPDATE SKIP LOCKED makes that explicit
-- rather than a lock wait. The database is the correctness
-- boundary; any Redis lock in the worker is an optimisation that
-- can fail open without consequence.
--
-- Rerun safety:
-- - Idempotent in both senses. The migration is CREATE OR REPLACE
--   at a fixed signature with declarative REVOKE/GRANT, and the
--   function itself is idempotent: a cancelled row no longer
--   matches 'draft', so a second call returns nothing.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.consultations') is null then
    raise exception
      'migration 047: consultations not found - migration 001 must be applied first';
  end if;

  if to_regprocedure(
       'public.abandon_draft_consultation(uuid)'
     ) is null then
    raise exception
      'migration 047: abandon_draft_consultation not found - migration 046 must be applied first';
  end if;

  if to_regclass('public.idx_consultations_stale_drafts') is null then
    raise exception
      'migration 047: idx_consultations_stale_drafts not found - migration 001 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. expire_stale_draft_consultations
-- ============================================================
--
-- Cancels drafts whose thirty-minute hold has passed, oldest
-- first, in batches.
--
-- THE PREDICATE IS THE WHOLE SAFETY ARGUMENT, and it is in the
-- database rather than in a caller that could be rewritten:
--
--     status = 'draft'
--     and created_at <= now() - interval '30 minutes'
--
-- 'draft' is the only status this function can read and 'cancelled'
-- the only one it can write. A payment_authorized, pending_
-- acceptance, confirmed, captured, completed or refunded
-- consultation does not match and cannot be reached from here, at
-- any batch size, from any caller, however it is invoked.
--
-- CANCEL RATHER THAN DELETE, for the same reason migration 046
-- cancels: 'cancelled' is outside unique_reserved_consultant_slot's
-- status list, so the slot frees the moment this commits, and the
-- row survives as the record of a booking someone started and did
-- not finish.
--
-- The inner select is ordered oldest-first and limited, so a large
-- backlog is drained across several calls rather than locking the
-- table in one. SKIP LOCKED means two replicas running the same
-- cycle divide the work instead of queueing behind each other.

create or replace function public.expire_stale_draft_consultations(
  p_limit integer default 200
)
returns table (
  consultation_id uuid,
  consultant_id uuid,
  scheduled_start_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  /*
   * Clamped rather than rejected. This is called by a worker on a
   * timer, and a bad limit should not stop expiry from happening
   * at all - the ceiling bounds one statement's work, the floor
   * stops a zero or negative limit from silently doing nothing.
   */
  v_limit constant integer :=
    greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  return query
  update public.consultations c
     set status = 'cancelled',
         cancelled_at = now()
   where c.id in (
     select d.id
       from public.consultations d
      where d.status = 'draft'
        and d.created_at <= now() - interval '30 minutes'
      order by d.created_at
      limit v_limit
      for update skip locked
   )
  returning c.id, c.consultant_id, c.scheduled_start_at;
end;
$$;

comment on function public.expire_stale_draft_consultations(integer) is
  'Migration 047. Cancels draft consultations whose thirty-minute '
  'hold has passed, oldest first, in batches, so an abandoned '
  'booking stops reserving a slot. Matches status = draft only, so '
  'no advanced consultation can be reached from here at any batch '
  'size. Idempotent: a cancelled row no longer matches. Returns the '
  'rows it cancelled so the worker can log them. Serves the '
  'idx_consultations_stale_drafts partial index that migration 001 '
  'created for this job and that nothing used until now.';


-- ============================================================
-- B. Privileges
-- ============================================================
--
-- Migration 036's rule. This is an orchestrator-only RPC: it is
-- called by a background worker, never by a browser, and a
-- function that cancels bookings in bulk must not be reachable
-- through PostgREST.

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'expire_stale_draft_consultations'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_fn
    );

    execute format(
      'grant execute on function %s to service_role',
      v_fn
    );
  end loop;
end;
$$;

commit;
