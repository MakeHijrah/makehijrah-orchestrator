-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 035: Financial write paths
-- ============================================================
--
-- Classification:
-- - Phase 1 of the approved Finance, Payouts & Direct Booking
--   build plan. The write paths against migration 034's schema.
--
-- What this migration does:
--   A. record_consultation_earning     create the pending earning
--   B. release_consultation_earning    make it withdrawable
--   C. reverse_ledger_entry            refunds and chargebacks
--   D. create_ledger_adjustment        admin credit or debit
--   E. request_consultant_payout       reserve available earnings
--   F. decide_payout                   approve / reject / cancel
--   G. mark_payout_paid                settle an approved payout
--
-- Why these are RPCs rather than orchestrator code:
-- - Every one of them spans more than one row and must be
--   all-or-nothing. A payout request in particular reads a
--   balance, creates a header and writes one allocation per
--   earning; done from the orchestrator, two concurrent requests
--   could read the same balance and reserve the same earning
--   twice. Inside a function they share one transaction, and the
--   FOR UPDATE lock plus the unique index on
--   payout_allocations.ledger_entry_id make that impossible.
-- - The 50/50 split is computed here, once, from the gross the
--   consultation actually charged and the rate in app_settings.
--   No caller supplies an amount, so no caller can get it wrong,
--   and nothing recalculates a historical entry.
--
-- Failure signalling follows the project convention: every
-- rejection raises an exception whose message begins with a
-- stable FINANCE_* marker. The orchestrator matches the marker
-- and never surfaces raw PostgreSQL text.
--
-- Deliberately NOT done here:
-- - No partial payout. A request takes the WHOLE available
--   balance in one currency, so no earning is ever split across
--   two payouts and no allocation needs a part-amount column.
--   See part E.
-- - No FX. Every function is single-currency end to end.
-- - No Stripe call, no notification, no Stripe Connect. These
--   functions move ledger rows and nothing else.
-- - No direct-booking or service-purchase earning. The ledger
--   already carries their shape (migration 034); their write
--   paths arrive with their integrations.
-- - No schema change of any kind. This migration creates
--   functions only.
--
-- Rerun safety:
-- - Idempotent. Every function is CREATE OR REPLACE with its
--   grants reapplied.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.consultant_ledger_entries') is null
     or to_regclass('public.payouts') is null
     or to_regclass('public.payout_allocations') is null then
    raise exception
      'migration 035: finance tables not found - migration 034 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. record_consultation_earning
-- ============================================================
--
-- Creates the consultant's pending earning for one consultation.
--
-- Requires captured_at. That is the whole guard: an earning is
-- only ever written against money the platform actually
-- collected, so no completion, admin action or webhook ordering
-- can credit a consultant for a payment that never landed.
--
-- The split is computed here from the gross price the
-- consultation charged and app_settings, before Stripe fees —
-- fees are the platform's cost, not the consultant's. The
-- consultant share rounds half up and the platform takes the
-- remainder, so the two always sum to the gross exactly.
--
-- Idempotent by the ledger's own unique index rather than by a
-- prior read: a concurrent second call loses the insert race and
-- returns the existing entry instead of a duplicate.

create or replace function public.record_consultation_earning(
  p_consultation_id uuid
)
returns table (
  entry_id uuid,
  created boolean,
  gross_amount_minor integer,
  consultant_amount_minor integer,
  platform_amount_minor integer,
  commission_bps integer,
  currency text,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consultation public.consultations%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
  v_bps integer;
  v_consultant integer;
  v_platform integer;
begin
  if p_consultation_id is null then
    raise exception
      'FINANCE_CONSULTATION_NOT_FOUND: a consultation id is required';
  end if;

  select * into v_consultation
    from public.consultations
   where id = p_consultation_id
   for update;

  if not found then
    raise exception
      'FINANCE_CONSULTATION_NOT_FOUND: consultation % does not exist',
      p_consultation_id;
  end if;

  /*
   * Returned before the capture check so a repeat call on an
   * already-credited consultation stays a no-op even if the
   * consultation has since been refunded.
   */
  select * into v_entry
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'consultation'
     and source_id = p_consultation_id
     and source_component = 'full';

  if found then
    return query
    select v_entry.id, false, v_entry.gross_amount_minor,
           v_entry.consultant_amount_minor,
           v_entry.platform_amount_minor, v_entry.commission_bps,
           v_entry.currency, v_entry.available_at;
    return;
  end if;

  if v_consultation.captured_at is null then
    raise exception
      'FINANCE_CONSULTATION_NOT_CAPTURED: consultation % has no captured payment',
      p_consultation_id;
  end if;

  if v_consultation.price_cents is null
     or v_consultation.price_cents <= 0 then
    raise exception
      'FINANCE_CONSULTATION_AMOUNT_INVALID: consultation % has no positive price',
      p_consultation_id;
  end if;

  select consultation_consultant_commission_bps
    into v_bps
    from public.app_settings
   limit 1;

  if v_bps is null then
    raise exception
      'FINANCE_SETTINGS_MISSING: no app_settings row carries a consultation commission rate';
  end if;

  v_consultant := round(
    v_consultation.price_cents::numeric * v_bps / 10000
  )::integer;

  v_platform := v_consultation.price_cents - v_consultant;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    source_component, gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at
  )
  values (
    v_consultation.consultant_id, 'earning', 'consultation',
    p_consultation_id, 'full', v_consultation.price_cents,
    v_consultant, v_platform, v_bps, 'standard_50_50',
    lower(v_consultation.currency), null
  )
  on conflict do nothing
  returning * into v_entry;

  /*
   * A lost insert race, not an error: another transaction wrote
   * the same earning first. Read theirs and report it as
   * pre-existing.
   */
  if v_entry.id is null then
    select * into v_entry
      from public.consultant_ledger_entries
     where entry_type = 'earning'
       and source_type = 'consultation'
       and source_id = p_consultation_id
       and source_component = 'full';

    return query
    select v_entry.id, false, v_entry.gross_amount_minor,
           v_entry.consultant_amount_minor,
           v_entry.platform_amount_minor, v_entry.commission_bps,
           v_entry.currency, v_entry.available_at;
    return;
  end if;

  return query
  select v_entry.id, true, v_entry.gross_amount_minor,
         v_entry.consultant_amount_minor,
         v_entry.platform_amount_minor, v_entry.commission_bps,
         v_entry.currency, v_entry.available_at;
end;
$$;


-- ============================================================
-- B. release_consultation_earning
-- ============================================================
--
-- Makes a pending consultation earning withdrawable, and only
-- when BOTH locked conditions hold: the consultation is
-- completed, and the payment was captured. Completion alone is
-- never enough — complete_consultation (migration 012) accepts a
-- consultation in 'confirmed', which is a state where no money
-- has been taken.
--
-- Returns a reason rather than raising when there is simply
-- nothing to do, because both call sites invoke it
-- opportunistically: the capture webhook (in case completion
-- already happened) and completion (in case capture already
-- happened). Whichever runs second releases; the first is a
-- no-op. Neither has to know the order.

create or replace function public.release_consultation_earning(
  p_consultation_id uuid
)
returns table (
  entry_id uuid,
  released boolean,
  reason text,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consultation public.consultations%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
  v_now timestamptz := now();
begin
  if p_consultation_id is null then
    raise exception
      'FINANCE_CONSULTATION_NOT_FOUND: a consultation id is required';
  end if;

  select * into v_consultation
    from public.consultations
   where id = p_consultation_id
   for update;

  if not found then
    raise exception
      'FINANCE_CONSULTATION_NOT_FOUND: consultation % does not exist',
      p_consultation_id;
  end if;

  select * into v_entry
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'consultation'
     and source_id = p_consultation_id
     and source_component = 'full'
   for update;

  if not found then
    return query select null::uuid, false, 'no_entry'::text,
                        null::timestamptz;
    return;
  end if;

  if v_entry.available_at is not null then
    return query select v_entry.id, false, 'already_available'::text,
                        v_entry.available_at;
    return;
  end if;

  if v_consultation.captured_at is null then
    return query select v_entry.id, false, 'not_captured'::text,
                        null::timestamptz;
    return;
  end if;

  /*
   * status is checked as well as completed_at: a consultation
   * that completed and was then refunded carries a completed_at
   * but must not start a fresh release.
   */
  if v_consultation.status <> 'completed'
     or v_consultation.completed_at is null then
    return query select v_entry.id, false, 'not_completed'::text,
                        null::timestamptz;
    return;
  end if;

  /*
   * Aliased because this function's OUT parameters share names
   * with the table's columns, and an unqualified available_at in
   * the WHERE clause would be ambiguous between the two.
   */
  update public.consultant_ledger_entries as e
     set available_at = v_now
   where e.id = v_entry.id
     and e.available_at is null;

  return query select v_entry.id, true, 'released'::text, v_now;
end;
$$;


-- ============================================================
-- C. reverse_ledger_entry
-- ============================================================
--
-- A refund or chargeback. The original earning is never touched;
-- a negative entry is inserted alongside it, linked through
-- reverses_entry_id.
--
-- p_gross_amount_minor null reverses whatever remains
-- un-reversed, which is the ordinary full-refund case and negates
-- the original amounts exactly, with no rounding drift. A partial
-- refund supplies the gross portion refunded and the consultant
-- share is recomputed at the ORIGINAL snapshotted rate, never at
-- today's.
--
-- Over-reversal is refused: the sum of reversals against one
-- earning can never exceed it, so a redelivered refund webhook
-- cannot claw back twice.
--
-- The reversal inherits the original's availability. Reversing a
-- pending earning nets pending to zero; reversing an available or
-- already-paid one takes the balance down immediately, and a
-- negative balance is legal — future earnings offset it.

create or replace function public.reverse_ledger_entry(
  p_entry_id uuid,
  p_reason text,
  p_gross_amount_minor integer default null
)
returns table (
  entry_id uuid,
  reverses_entry_id uuid,
  gross_amount_minor integer,
  consultant_amount_minor integer,
  platform_amount_minor integer,
  currency text,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_original public.consultant_ledger_entries%rowtype;
  v_reversal public.consultant_ledger_entries%rowtype;
  v_reversed integer;
  v_remaining integer;
  v_portion integer;
  v_consultant integer;
  v_platform integer;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception
      'FINANCE_REASON_REQUIRED: a reversal must state a reason';
  end if;

  select * into v_original
    from public.consultant_ledger_entries
   where id = p_entry_id
   for update;

  if not found then
    raise exception
      'FINANCE_ENTRY_NOT_FOUND: ledger entry % does not exist',
      p_entry_id;
  end if;

  if v_original.entry_type <> 'earning' then
    raise exception
      'FINANCE_ENTRY_NOT_REVERSIBLE: entry % is a %, only an earning may be reversed',
      p_entry_id, v_original.entry_type;
  end if;

  /* Aliased: gross_amount_minor and reverses_entry_id are both
   * OUT parameters of this function as well as columns. */
  select coalesce(sum(-r.gross_amount_minor), 0)
    into v_reversed
    from public.consultant_ledger_entries r
   where r.entry_type = 'reversal'
     and r.reverses_entry_id = p_entry_id;

  v_remaining := v_original.gross_amount_minor - v_reversed;

  if v_remaining <= 0 then
    raise exception
      'FINANCE_REVERSAL_EXCEEDS_ORIGINAL: entry % is already fully reversed',
      p_entry_id;
  end if;

  v_portion := coalesce(p_gross_amount_minor, v_remaining);

  if v_portion <= 0 then
    raise exception
      'FINANCE_REVERSAL_AMOUNT_INVALID: a reversal must be a positive gross amount';
  end if;

  if v_portion > v_remaining then
    raise exception
      'FINANCE_REVERSAL_EXCEEDS_ORIGINAL: % exceeds the % remaining on entry %',
      v_portion, v_remaining, p_entry_id;
  end if;

  if v_portion = v_original.gross_amount_minor and v_reversed = 0 then
    /* Full reversal of an untouched earning: negate exactly. */
    v_consultant := v_original.consultant_amount_minor;
    v_platform := v_original.platform_amount_minor;
  else
    v_consultant := round(
      v_portion::numeric * v_original.commission_bps / 10000
    )::integer;
    v_platform := v_portion - v_consultant;
  end if;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    source_component, gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, reverses_entry_id, memo
  )
  values (
    v_original.consultant_id, 'reversal', v_original.source_type,
    v_original.source_id, v_original.source_component,
    -v_portion, -v_consultant, -v_platform,
    v_original.commission_bps, v_original.commission_basis,
    v_original.currency,
    case
      when v_original.available_at is null then null
      else now()
    end,
    v_original.id, btrim(p_reason)
  )
  returning * into v_reversal;

  return query
  select v_reversal.id, v_reversal.reverses_entry_id,
         v_reversal.gross_amount_minor,
         v_reversal.consultant_amount_minor,
         v_reversal.platform_amount_minor, v_reversal.currency,
         v_reversal.available_at;
end;
$$;


-- ============================================================
-- C2. reverse_consultation_earning
-- ============================================================
--
-- The refund path's entry point: reverse whatever a consultation
-- earned, named by the consultation rather than by the ledger
-- entry.
--
-- It exists so the Stripe webhook never has to read a table to
-- find out what to reverse. Amendment 004 section 10.3.3 holds
-- the webhook to RPC calls only, and finding the entry from the
-- orchestrator would have meant a direct SELECT on the ledger
-- plus a second round trip in which the entry could change.
--
-- All the reversal arithmetic stays in reverse_ledger_entry;
-- this is a lookup and a translation. A consultation that never
-- earned, and one already fully reversed by an earlier delivery
-- of the same refund, are both ordinary outcomes rather than
-- failures — which is what makes a redelivered webhook safe.

create or replace function public.reverse_consultation_earning(
  p_consultation_id uuid,
  p_reason text,
  p_gross_amount_minor integer default null
)
returns table (
  entry_id uuid,
  reversed boolean,
  reason text,
  consultant_amount_minor integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_original uuid;
  v_reversal record;
begin
  select e.id into v_original
    from public.consultant_ledger_entries e
   where e.entry_type = 'earning'
     and e.source_type = 'consultation'
     and e.source_id = p_consultation_id
     and e.source_component = 'full';

  if not found then
    return query
    select null::uuid, false, 'no_entry'::text, null::integer;
    return;
  end if;

  begin
    select * into v_reversal
      from public.reverse_ledger_entry(
        v_original, p_reason, p_gross_amount_minor
      );
  exception when others then
    /*
     * A repeat delivery of a refund that was already applied.
     * The ledger is correct and nothing more is owed, so this is
     * reported rather than raised. Every other failure is a real
     * one and keeps propagating.
     */
    if sqlerrm like 'FINANCE_REVERSAL_EXCEEDS_ORIGINAL%' then
      return query
      select v_original, false, 'already_reversed'::text,
             null::integer;
      return;
    end if;

    raise;
  end;

  return query
  select v_reversal.entry_id, true, 'reversed'::text,
         v_reversal.consultant_amount_minor;
end;
$$;


-- ============================================================
-- D. create_ledger_adjustment
-- ============================================================
--
-- An admin correction, credit or debit. A signed amount, a named
-- admin and a reason, all three required — an adjustment is the
-- one entry a human authors freely, so it is the one that must
-- say who made it and why.
--
-- Immediately available: a correction the consultant cannot
-- withdraw is not a correction. A debit therefore reduces the
-- available balance at once and may take it negative.
--
-- No balance is written. The adjustment is a row like any other
-- and the balance follows from it.

create or replace function public.create_ledger_adjustment(
  p_consultant_id uuid,
  p_amount_minor integer,
  p_currency text,
  p_memo text,
  p_admin_profile_id uuid
)
returns table (
  entry_id uuid,
  consultant_id uuid,
  consultant_amount_minor integer,
  currency text,
  memo text,
  available_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry public.consultant_ledger_entries%rowtype;
  v_currency text := lower(btrim(coalesce(p_currency, '')));
  v_memo text := btrim(coalesce(p_memo, ''));
begin
  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception
      'FINANCE_ADJUSTMENT_AMOUNT_INVALID: an adjustment must be a non-zero amount';
  end if;

  if v_memo = '' then
    raise exception
      'FINANCE_REASON_REQUIRED: an adjustment must state a reason';
  end if;

  if v_currency !~ '^[a-z]{3}$' then
    raise exception
      'FINANCE_CURRENCY_INVALID: % is not a three-letter currency code',
      p_currency;
  end if;

  if not exists (
    select 1 from public.consultants where id = p_consultant_id
  ) then
    raise exception
      'FINANCE_CONSULTANT_NOT_FOUND: consultant % does not exist',
      p_consultant_id;
  end if;

  if not exists (
    select 1 from public.profiles
     where id = p_admin_profile_id and role = 'admin'
  ) then
    raise exception
      'FINANCE_ADMIN_REQUIRED: profile % is not an admin',
      p_admin_profile_id;
  end if;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    source_component, gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at, created_by_admin_profile_id, memo
  )
  values (
    p_consultant_id, 'adjustment', 'manual', null, 'full',
    p_amount_minor, p_amount_minor, 0, null, 'manual',
    v_currency, now(), p_admin_profile_id, v_memo
  )
  returning * into v_entry;

  return query
  select v_entry.id, v_entry.consultant_id,
         v_entry.consultant_amount_minor, v_entry.currency,
         v_entry.memo, v_entry.available_at, v_entry.created_at;
end;
$$;


-- ============================================================
-- E. request_consultant_payout
-- ============================================================
--
-- Reserves every available, unallocated earning in one currency
-- and creates the payout that will pay them.
--
-- PARTIAL ALLOCATION IS NOT SUPPORTED, deliberately. A request
-- takes the WHOLE available balance in that currency. The
-- consequences are all simplifications: no earning is ever split
-- across two payouts, an allocation needs no part-amount column,
-- the requested amount is a plain sum, and "which earnings are in
-- this payout" has one answer forever. A consultant who wants
-- less than their balance waits; there is no partial-withdraw
-- product requirement in V1.
--
-- The amount is computed here and no caller supplies one, so a
-- client-supplied balance cannot be trusted or even offered.
--
-- Reversals are allocated alongside earnings. That is what makes
-- a negative entry settle: it rides into the next payout and
-- reduces it. If the net is not positive the request is refused
-- and the negative entries stay unallocated, waiting for future
-- earnings to offset them.
--
-- Concurrency: the FOR UPDATE below locks the candidate entries
-- for the length of the transaction, and the unique index on
-- payout_allocations.ledger_entry_id is the backstop if two
-- callers somehow reach the insert together. The partial unique
-- index on payouts refuses a second open request outright.

create or replace function public.request_consultant_payout(
  p_consultant_id uuid,
  p_currency text,
  p_destination_note text default null
)
returns table (
  payout_id uuid,
  status text,
  currency text,
  requested_amount_minor integer,
  entry_count integer,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_payout public.payouts%rowtype;
  v_currency text := lower(btrim(coalesce(p_currency, '')));
  v_total integer;
  v_count integer;
  v_ids uuid[];
begin
  if v_currency !~ '^[a-z]{3}$' then
    raise exception
      'FINANCE_CURRENCY_INVALID: % is not a three-letter currency code',
      p_currency;
  end if;

  if not exists (
    select 1 from public.consultants where id = p_consultant_id
  ) then
    raise exception
      'FINANCE_CONSULTANT_NOT_FOUND: consultant % does not exist',
      p_consultant_id;
  end if;

  /* Aliased: currency and status are OUT parameters too. */
  if exists (
    select 1 from public.payouts p
     where p.consultant_id = p_consultant_id
       and p.currency = v_currency
       and p.status in ('requested', 'approved')
  ) then
    raise exception
      'FINANCE_PAYOUT_ALREADY_OPEN: consultant % already has an open % payout request',
      p_consultant_id, v_currency;
  end if;

  /*
   * The lock lives in the CTE because a locking clause cannot sit
   * on a query that aggregates. Locking first and summing the
   * locked set afterwards is also the correct order: the total
   * and the allocation below are computed from exactly the rows
   * this transaction now holds.
   */
  with locked as (
    select e.id, e.consultant_amount_minor
      from public.consultant_ledger_entries e
     where e.consultant_id = p_consultant_id
       and e.currency = v_currency
       and e.available_at is not null
       and not exists (
         select 1 from public.payout_allocations a
          where a.ledger_entry_id = e.id
       )
     for update
  )
  select array_agg(id),
         coalesce(sum(consultant_amount_minor), 0),
         count(*)
    into v_ids, v_total, v_count
    from locked;

  if v_count = 0 then
    raise exception
      'FINANCE_NO_AVAILABLE_EARNINGS: consultant % has no unallocated % earnings',
      p_consultant_id, v_currency;
  end if;

  if v_total <= 0 then
    raise exception
      'FINANCE_BALANCE_NOT_POSITIVE: the available % balance is %, which cannot be paid out',
      v_currency, v_total;
  end if;

  insert into public.payouts (
    consultant_id, status, currency, requested_amount_minor,
    destination_note
  )
  values (
    p_consultant_id, 'requested', v_currency, v_total,
    nullif(btrim(coalesce(p_destination_note, '')), '')
  )
  returning * into v_payout;

  insert into public.payout_allocations (payout_id, ledger_entry_id)
  select v_payout.id, unnest(v_ids);

  return query
  select v_payout.id, v_payout.status, v_payout.currency,
         v_payout.requested_amount_minor, v_count,
         v_payout.requested_at;
end;
$$;


-- ============================================================
-- F. decide_payout
-- ============================================================
--
-- approve, reject or cancel an open payout.
--
-- Approving reserves nothing new: the allocations made at request
-- time stay exactly as they are, which is what "approved payout
-- remains reserved" means.
--
-- Rejecting or cancelling DELETES the allocations, returning
-- those earnings to available. The payout row survives with its
-- status, its amount, its reason and its admin, so the request is
-- still auditable while the money is free again.
--
-- Reject and cancel are accepted from 'approved' as well as
-- 'requested'. Approval is not payment, and an admin who spots a
-- problem after approving must be able to stop it. A PAID payout
-- is refused in every branch: settled money never moves.

create or replace function public.decide_payout(
  p_payout_id uuid,
  p_decision text,
  p_admin_profile_id uuid,
  p_note text default null
)
returns table (
  payout_id uuid,
  status text,
  currency text,
  requested_amount_minor integer,
  released_entry_count integer,
  approved_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_payout public.payouts%rowtype;
  v_released integer := 0;
  v_now timestamptz := now();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_decision not in ('approve', 'reject', 'cancel') then
    raise exception
      'FINANCE_DECISION_INVALID: % is not approve, reject or cancel',
      p_decision;
  end if;

  if not exists (
    select 1 from public.profiles
     where id = p_admin_profile_id and role = 'admin'
  ) then
    raise exception
      'FINANCE_ADMIN_REQUIRED: profile % is not an admin',
      p_admin_profile_id;
  end if;

  select * into v_payout
    from public.payouts
   where id = p_payout_id
   for update;

  if not found then
    raise exception
      'FINANCE_PAYOUT_NOT_FOUND: payout % does not exist', p_payout_id;
  end if;

  if v_payout.status = 'paid' then
    raise exception
      'FINANCE_PAYOUT_ALREADY_PAID: payout % is paid and cannot change status',
      p_payout_id;
  end if;

  if v_payout.status not in ('requested', 'approved') then
    raise exception
      'FINANCE_PAYOUT_NOT_OPEN: payout % is %, which is already final',
      p_payout_id, v_payout.status;
  end if;

  if p_decision = 'approve' then
    if v_payout.status = 'approved' then
      raise exception
        'FINANCE_PAYOUT_NOT_OPEN: payout % is already approved',
        p_payout_id;
    end if;

    update public.payouts
       set status = 'approved',
           approved_at = v_now,
           decided_by_admin_profile_id = p_admin_profile_id,
           admin_note = coalesce(v_note, admin_note)
     where id = p_payout_id
    returning * into v_payout;
  else
    /* Aliased: payout_id is an OUT parameter too. */
    delete from public.payout_allocations a
     where a.payout_id = p_payout_id;

    get diagnostics v_released = row_count;

    if p_decision = 'reject' then
      update public.payouts
         set status = 'rejected',
             rejected_at = v_now,
             decided_by_admin_profile_id = p_admin_profile_id,
             admin_note = coalesce(v_note, admin_note)
       where id = p_payout_id
      returning * into v_payout;
    else
      update public.payouts
         set status = 'cancelled',
             cancelled_at = v_now,
             decided_by_admin_profile_id = p_admin_profile_id,
             admin_note = coalesce(v_note, admin_note)
       where id = p_payout_id
      returning * into v_payout;
    end if;
  end if;

  return query
  select v_payout.id, v_payout.status, v_payout.currency,
         v_payout.requested_amount_minor, v_released,
         v_payout.approved_at, v_payout.rejected_at,
         v_payout.cancelled_at;
end;
$$;


-- ============================================================
-- G. mark_payout_paid
-- ============================================================
--
-- Records that an approved payout was paid by hand, outside the
-- system. V1 has no Stripe Connect and no bank integration, so
-- the external reference is the only link between this row and
-- the transfer that happened; it is required for that reason.
--
-- Only an approved payout can be paid, so no payout is ever
-- settled without a recorded approval. Once paid, decide_payout
-- refuses every further transition and the allocation guard
-- refuses to release the allocations: the entries are spent
-- permanently.
--
-- The paid amount is taken from the admin rather than assumed to
-- equal the requested amount, because a manual transfer can
-- arrive net of a bank fee, and the row should say what was
-- actually sent.

create or replace function public.mark_payout_paid(
  p_payout_id uuid,
  p_paid_amount_minor integer,
  p_external_reference text,
  p_admin_profile_id uuid,
  p_paid_at timestamptz default null,
  p_note text default null
)
returns table (
  payout_id uuid,
  status text,
  currency text,
  requested_amount_minor integer,
  paid_amount_minor integer,
  paid_at timestamptz,
  external_reference text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_payout public.payouts%rowtype;
  v_reference text := nullif(
    btrim(coalesce(p_external_reference, '')), ''
  );
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_paid_amount_minor is null or p_paid_amount_minor <= 0 then
    raise exception
      'FINANCE_PAID_AMOUNT_INVALID: a paid payout must record a positive amount';
  end if;

  if v_reference is null then
    raise exception
      'FINANCE_REFERENCE_REQUIRED: a paid payout must record an external reference';
  end if;

  if not exists (
    select 1 from public.profiles
     where id = p_admin_profile_id and role = 'admin'
  ) then
    raise exception
      'FINANCE_ADMIN_REQUIRED: profile % is not an admin',
      p_admin_profile_id;
  end if;

  select * into v_payout
    from public.payouts
   where id = p_payout_id
   for update;

  if not found then
    raise exception
      'FINANCE_PAYOUT_NOT_FOUND: payout % does not exist', p_payout_id;
  end if;

  if v_payout.status = 'paid' then
    raise exception
      'FINANCE_PAYOUT_ALREADY_PAID: payout % is already paid', p_payout_id;
  end if;

  if v_payout.status <> 'approved' then
    raise exception
      'FINANCE_PAYOUT_NOT_APPROVED: payout % is %, only an approved payout may be paid',
      p_payout_id, v_payout.status;
  end if;

  update public.payouts
     set status = 'paid',
         paid_amount_minor = p_paid_amount_minor,
         paid_at = coalesce(p_paid_at, now()),
         external_reference = v_reference,
         decided_by_admin_profile_id = p_admin_profile_id,
         admin_note = coalesce(v_note, admin_note)
   where id = p_payout_id
  returning * into v_payout;

  return query
  select v_payout.id, v_payout.status, v_payout.currency,
         v_payout.requested_amount_minor, v_payout.paid_amount_minor,
         v_payout.paid_at, v_payout.external_reference;
end;
$$;


-- ============================================================
-- Grants
-- ============================================================
--
-- Every one of these moves money, and none is reachable by anon
-- or authenticated: the orchestrator calls them with the service
-- role, having already established who the caller is and whether
-- they may act.
--
-- anon and authenticated are revoked BY NAME, not only through
-- PUBLIC. Supabase issues ALTER DEFAULT PRIVILEGES ... GRANT ALL
-- ON FUNCTIONS TO anon, authenticated, so a new function is
-- executable by both the moment it is created, and revoking from
-- PUBLIC does not remove a grant held by name. Migration 030 hit
-- the same fact and revokes the same way; without these lines an
-- anon key could call release_consultation_earning or
-- reverse_ledger_entry directly.
--
-- The FINANCE_ADMIN_REQUIRED checks inside the admin functions
-- are a second line, not the first: they would still refuse a
-- caller who reached them, but reaching them is what these
-- revokes prevent.

revoke all on function
  public.record_consultation_earning(uuid)
  from public, anon, authenticated;

revoke all on function
  public.release_consultation_earning(uuid)
  from public, anon, authenticated;

revoke all on function
  public.reverse_ledger_entry(uuid, text, integer)
  from public, anon, authenticated;

revoke all on function
  public.reverse_consultation_earning(uuid, text, integer)
  from public, anon, authenticated;

revoke all on function
  public.create_ledger_adjustment(uuid, integer, text, text, uuid)
  from public, anon, authenticated;

revoke all on function
  public.request_consultant_payout(uuid, text, text)
  from public, anon, authenticated;

revoke all on function
  public.decide_payout(uuid, text, uuid, text)
  from public, anon, authenticated;

revoke all on function
  public.mark_payout_paid(uuid, integer, text, uuid, timestamptz, text)
  from public, anon, authenticated;

grant execute on function
  public.record_consultation_earning(uuid)
  to service_role;

grant execute on function
  public.release_consultation_earning(uuid)
  to service_role;

grant execute on function
  public.reverse_ledger_entry(uuid, text, integer)
  to service_role;

grant execute on function
  public.reverse_consultation_earning(uuid, text, integer)
  to service_role;

grant execute on function
  public.create_ledger_adjustment(uuid, integer, text, text, uuid)
  to service_role;

grant execute on function
  public.request_consultant_payout(uuid, text, text)
  to service_role;

grant execute on function
  public.decide_payout(uuid, text, uuid, text)
  to service_role;

grant execute on function
  public.mark_payout_paid(uuid, integer, text, uuid, timestamptz, text)
  to service_role;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_035_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from pg_proc p
--      join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in (
--         'record_consultation_earning', 'release_consultation_earning',
--         'reverse_ledger_entry', 'create_ledger_adjustment',
--         'reverse_consultation_earning',
--         'request_consultant_payout', 'decide_payout',
--         'mark_payout_paid');
--       -> 8
--
--  2. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 20 (this migration creates no table)
