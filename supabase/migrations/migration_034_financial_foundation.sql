-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 034: Financial foundation
-- ============================================================
--
-- Classification:
-- - Phase 1 of the approved Finance, Payouts & Direct Booking
--   build plan. Database foundation only.
--
-- What this migration does:
--   A. public.consultant_ledger_entries  append-only ledger
--   B. public.payouts                    payout requests
--   C. public.payout_allocations         earning -> payout link
--   D. public.service_purchases          service payment record
--   E. services.consultant_commission_bps, hidden from clients
--   F. app_settings consultation commission configuration
--   G. RLS, grants and the derived balance view
--
-- The locked business rules this encodes:
-- - Commission is always computed on the GROSS amount charged.
--   Stripe fees never reduce a consultant's share.
-- - Standard consultation: 50/50.
-- - Direct booking: the standard-price portion is 50/50, the
--   premium above standard price is 80/20 in the consultant's
--   favour. Direct booking is not integrated yet; the ledger
--   carries the shape so no schema change is needed when it is.
-- - Each service carries its own commission rate, and a recurring
--   service earns commission on every successful renewal.
-- - A consultation earning becomes available only once the
--   consultation is completed AND the payment is captured. A
--   service earning becomes available at its fulfillment point.
--   There is no cooling-off period.
-- - Balances are per currency. No FX conversion anywhere.
-- - A negative balance after a post-payout reversal is legal and
--   is offset by future earnings.
--
-- Deliberately NOT done here:
-- - No RPC. The write paths (record an earning, stamp it
--   available, reverse it, request and decide a payout) are the
--   next migration. This one is the foundation they will be
--   built against, and it enforces its invariants with
--   constraints and triggers rather than trusting a caller.
-- - No webhook change, no orchestrator change, no UI.
-- - No stored balance anywhere. Every balance is derived; see
--   public.consultant_balances at the end of this file.
-- - No currency conversion, no FX rate table, no journal/account
--   double-entry abstraction. A ledger row records who earned
--   what, from which event, under which rate.
-- - No policy on any existing table is added, dropped or
--   rewritten. The only change to an existing table's privileges
--   is the column-level SELECT narrowing on public.services in
--   part E, which is required to keep a commission rate away
--   from the client who pays it.
--
-- Rerun safety:
-- - Idempotent throughout. Tables use CREATE TABLE IF NOT
--   EXISTS, every constraint is dropped before it is added,
--   indexes use IF NOT EXISTS, functions are CREATE OR REPLACE
--   and triggers are dropped before creation.
-- ============================================================

begin;

-- Preconditions. Each of these is referenced below; failing here
-- with a name is better than failing later with a syntax error.
do $$
declare
  v_missing text;
begin
  select string_agg(t, ', ')
    into v_missing
    from unnest(array[
      'public.profiles',
      'public.consultants',
      'public.consultations',
      'public.services',
      'public.service_requests',
      'public.app_settings'
    ]) as t
   where to_regclass(t) is null;

  if v_missing is not null then
    raise exception
      'migration 034: missing prerequisite table(s): %', v_missing;
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'migration 034: public.set_updated_at() not found - migration 001 must be applied first';
  end if;

  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.my_consultant_id()') is null then
    raise exception
      'migration 034: RLS helpers not found - migration 002 must be applied first';
  end if;

  -- The balance view is created with security_invoker so that the
  -- RLS on the ledger decides what each caller sees. That option
  -- arrived in PostgreSQL 15.
  if current_setting('server_version_num')::integer < 150000 then
    raise exception
      'migration 034: PostgreSQL 15 or later is required for security_invoker views (found %)',
      current_setting('server_version');
  end if;
end;
$$;


-- ============================================================
-- A. consultant_ledger_entries
-- ============================================================
--
-- One row per financial event affecting one consultant. This is
-- the only table in the system that no client can read under any
-- policy, which is why the commission snapshot lives here rather
-- than on consultations or services: a client can read their own
-- consultation row and every active service row, and the
-- platform's margin is not theirs to see.
--
-- Append-only. A row's amounts, attribution and rate never
-- change and no row is ever deleted. The single exception is
-- available_at, which advances once from null to a timestamp and
-- can never be moved again; trg_ledger_append_only enforces
-- exactly that, with no exemption for the service role.
--
-- Money is stored in the minor unit of `currency`, as a signed
-- integer. There are three money columns and they are an
-- identity, not three opinions:
--
--   consultant_amount_minor + platform_amount_minor
--     = gross_amount_minor
--
-- consultant_amount_minor is the only one that moves a balance.
-- The other two are kept so a historical row can still answer
-- "what was charged, and what did the platform keep" without
-- consulting Stripe or recomputing anything.

create table if not exists public.consultant_ledger_entries (
  id uuid primary key default gen_random_uuid(),

  consultant_id uuid not null
    references public.consultants(id),

  entry_type text not null,
  source_type text not null,
  source_id uuid,

  /*
   * A direct booking splits into two earnings against one
   * booking: the standard-price portion at 50/50 and the premium
   * above it at 80/20. Each is its own row carrying its own flat
   * rate, so every row in this table satisfies one simple
   * statement — consultant_amount_minor is commission_bps of
   * gross_amount_minor — and no row needs a nested breakdown to
   * be understood. 'full' is every other source type.
   */
  source_component text not null default 'full',

  gross_amount_minor integer not null,
  consultant_amount_minor integer not null,
  platform_amount_minor integer not null,

  /* Basis points: 5000 = 50.00%. Integer, so no float rounding. */
  commission_bps integer,
  commission_basis text not null,

  currency text not null,

  /*
   * Null means earned but not yet withdrawable. Set once, at the
   * moment the locked rule for this source type is satisfied:
   * completion AND capture for a consultation, the fulfillment
   * point for a service purchase. Never cleared, never moved.
   */
  available_at timestamptz,

  reverses_entry_id uuid
    references public.consultant_ledger_entries(id),

  created_by_admin_profile_id uuid
    references public.profiles(id),

  memo text,

  created_at timestamptz not null default now()
);

comment on table public.consultant_ledger_entries is
  'Phase 1 finance. Append-only ledger of consultant earnings, '
  'reversals and admin adjustments. Amounts are signed integers '
  'in the minor unit of currency. Rows are never deleted and '
  'never edited except for the one-way available_at stamp.';

-- ---------------------------------------------------- vocabularies ----

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_entry_type_check;
alter table public.consultant_ledger_entries
  add constraint ledger_entry_type_check
  check (entry_type in ('earning', 'reversal', 'adjustment'));

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_source_type_check;
alter table public.consultant_ledger_entries
  add constraint ledger_source_type_check
  check (
    source_type in (
      'consultation',
      'service_purchase',
      'direct_booking',
      'manual'
    )
  );

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_source_component_check;
alter table public.consultant_ledger_entries
  add constraint ledger_source_component_check
  check (source_component in ('full', 'standard', 'premium'));

/*
 * Only a direct booking splits. Anything else that arrived
 * carrying 'standard' or 'premium' would be a bug in the caller
 * and would quietly defeat the duplicate-earning index below,
 * which keys on the component.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_component_scope_check;
alter table public.consultant_ledger_entries
  add constraint ledger_component_scope_check
  check (
    source_component = 'full'
    or source_type = 'direct_booking'
  );

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_commission_basis_check;
alter table public.consultant_ledger_entries
  add constraint ledger_commission_basis_check
  check (
    commission_basis in (
      'standard_50_50',
      'service_rate',
      'direct_booking_standard',
      'direct_booking_premium',
      'manual'
    )
  );

/*
 * The basis has to agree with the source it claims to come from.
 * Without this a service purchase could be recorded as
 * 'standard_50_50' and the row would read as a consultation
 * forever.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_basis_alignment_check;
alter table public.consultant_ledger_entries
  add constraint ledger_basis_alignment_check
  check (
    (source_type = 'consultation'
      and commission_basis = 'standard_50_50')
    or (source_type = 'service_purchase'
      and commission_basis = 'service_rate')
    or (source_type = 'direct_booking'
      and commission_basis in (
        'direct_booking_standard',
        'direct_booking_premium'
      ))
    or (source_type = 'manual'
      and commission_basis = 'manual')
  );

/*
 * The component and the basis describe the same split from two
 * directions, so they must not disagree.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_component_basis_check;
alter table public.consultant_ledger_entries
  add constraint ledger_component_basis_check
  check (
    source_type <> 'direct_booking'
    or (source_component = 'standard'
        and commission_basis = 'direct_booking_standard')
    or (source_component = 'premium'
        and commission_basis = 'direct_booking_premium')
  );

-- ---------------------------------------------------------- money ----

/*
 * ISO 4217 alpha-3, lowercase, matching consultations and
 * services. The pattern rejects padding and case drift, which is
 * what makes a per-currency balance safe to group by.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_currency_format_check;
alter table public.consultant_ledger_entries
  add constraint ledger_currency_format_check
  check (currency ~ '^[a-z]{3}$');

/*
 * The identity. Every row states a complete split of what was
 * charged; nothing is unaccounted for. It holds for reversals
 * too, because a reversal negates all three columns together.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_amount_identity_check;
alter table public.consultant_ledger_entries
  add constraint ledger_amount_identity_check
  check (
    consultant_amount_minor + platform_amount_minor
      = gross_amount_minor
  );

/*
 * Sign is what the entry type MEANS, so it is enforced rather
 * than assumed. An earning that arrived negative, or a reversal
 * that arrived positive, would silently invert a balance.
 *
 * A zero-amount entry is rejected in all three cases: it records
 * no financial fact and would only add noise to an audit.
 *
 * Rounding is the orchestrator's business — the rule for
 * splitting an odd minor unit is a decision, not a constraint —
 * so this deliberately does not assert
 * consultant_amount_minor = gross * bps / 10000.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_sign_check;
alter table public.consultant_ledger_entries
  add constraint ledger_sign_check
  check (
    (entry_type = 'earning'
      and gross_amount_minor > 0
      and consultant_amount_minor > 0)
    or (entry_type = 'reversal'
      and gross_amount_minor < 0
      and consultant_amount_minor < 0)
    or (entry_type = 'adjustment'
      and consultant_amount_minor <> 0)
  );

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_commission_bps_range_check;
alter table public.consultant_ledger_entries
  add constraint ledger_commission_bps_range_check
  check (
    commission_bps is null
    or commission_bps between 0 and 10000
  );

/*
 * An earning and its reversal are both derived from a rate, so
 * both must carry the rate they were derived from. An admin
 * adjustment is a flat correction and has no rate.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_commission_bps_presence_check;
alter table public.consultant_ledger_entries
  add constraint ledger_commission_bps_presence_check
  check (
    (entry_type = 'adjustment' and commission_bps is null)
    or (entry_type <> 'adjustment' and commission_bps is not null)
  );

-- ------------------------------------------------- provenance ----

/*
 * Every entry except a manual adjustment points at the event it
 * came from. A manual entry must not carry a source id, because
 * there is no row it could honestly refer to.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_source_id_presence_check;
alter table public.consultant_ledger_entries
  add constraint ledger_source_id_presence_check
  check (
    (source_type = 'manual' and source_id is null)
    or (source_type <> 'manual' and source_id is not null)
  );

/*
 * A reversal names what it reverses. An earning reverses
 * nothing. An adjustment may name an entry it corrects, or none.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_reversal_link_check;
alter table public.consultant_ledger_entries
  add constraint ledger_reversal_link_check
  check (
    (entry_type = 'reversal' and reverses_entry_id is not null)
    or (entry_type = 'adjustment')
    or (entry_type = 'earning' and reverses_entry_id is null)
  );

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_no_self_reference_check;
alter table public.consultant_ledger_entries
  add constraint ledger_no_self_reference_check
  check (
    reverses_entry_id is null
    or reverses_entry_id <> id
  );

/*
 * An admin adjustment is the one entry a human authors freely,
 * so it is the one entry that must say who made it and why.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_adjustment_attribution_check;
alter table public.consultant_ledger_entries
  add constraint ledger_adjustment_attribution_check
  check (
    entry_type <> 'adjustment'
    or (
      created_by_admin_profile_id is not null
      and memo is not null
      and btrim(memo) <> ''
    )
  );

-- --------------------------------------------------------- indexes ----

/*
 * Duplicate-earning guard. One earning per source event per
 * component: a replayed webhook, a double-submitted completion
 * or a retried renewal cannot credit the same money twice.
 *
 * Reversals and adjustments are excluded, because a source event
 * may legitimately be reversed or corrected more than once
 * (a partial refund followed by the remainder, for instance).
 */
create unique index if not exists
  uq_ledger_one_earning_per_source
  on public.consultant_ledger_entries (
    source_type, source_id, source_component
  )
  where entry_type = 'earning';

create index if not exists idx_ledger_consultant_currency
  on public.consultant_ledger_entries (consultant_id, currency);

create index if not exists idx_ledger_unavailable
  on public.consultant_ledger_entries (consultant_id)
  where available_at is null;

create index if not exists idx_ledger_reverses
  on public.consultant_ledger_entries (reverses_entry_id)
  where reverses_entry_id is not null;

-- ----------------------------------------------------- append-only ----
--
-- This is what makes the word "ledger" true. A financial record
-- that can be edited is a note.
--
-- Deliberately NOT exempting is_privileged_writer(): the
-- orchestrator is bound by this too. A wrong amount is corrected
-- by inserting an adjustment, which leaves both the error and
-- the correction visible, and a refund is recorded by inserting
-- a reversal. Neither ever touches the original row.
--
-- The single permitted update is available_at advancing from
-- null to a value. Every other column must be identical, which
-- is checked column by column rather than by comparing whole
-- rows, so the error names the column that moved.

create or replace function public.enforce_ledger_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'consultant_ledger_entries is append-only: entry % may not be deleted. Insert a reversal or adjustment instead.',
      old.id;
  end if;

  if new.id is distinct from old.id
     or new.consultant_id is distinct from old.consultant_id
     or new.entry_type is distinct from old.entry_type
     or new.source_type is distinct from old.source_type
     or new.source_id is distinct from old.source_id
     or new.source_component is distinct from old.source_component
     or new.gross_amount_minor
          is distinct from old.gross_amount_minor
     or new.consultant_amount_minor
          is distinct from old.consultant_amount_minor
     or new.platform_amount_minor
          is distinct from old.platform_amount_minor
     or new.commission_bps is distinct from old.commission_bps
     or new.commission_basis is distinct from old.commission_basis
     or new.currency is distinct from old.currency
     or new.reverses_entry_id
          is distinct from old.reverses_entry_id
     or new.created_by_admin_profile_id
          is distinct from old.created_by_admin_profile_id
     or new.memo is distinct from old.memo
     or new.created_at is distinct from old.created_at then
    raise exception
      'consultant_ledger_entries is append-only: entry % may not be modified. Only available_at may advance.',
      old.id;
  end if;

  if old.available_at is not null
     and new.available_at is distinct from old.available_at then
    raise exception
      'entry % is already available since %; availability may not be moved or cleared.',
      old.id, old.available_at;
  end if;

  if new.available_at is null then
    raise exception
      'entry % may not have its availability cleared.', old.id;
  end if;

  return new;
end;
$$;

revoke all
on function public.enforce_ledger_append_only()
from public;

drop trigger if exists trg_ledger_append_only
  on public.consultant_ledger_entries;

create trigger trg_ledger_append_only
  before update or delete on public.consultant_ledger_entries
  for each row
  execute function public.enforce_ledger_append_only();


-- ============================================================
-- B. payouts
-- ============================================================
--
-- One row per payout request. The only mutable table of the four
-- and the only place a status moves, because a request genuinely
-- has a lifecycle:
--
--   requested -> approved -> paid
--   requested -> rejected            (admin refuses)
--   requested -> cancelled           (consultant withdraws)
--   approved  -> rejected|cancelled  (before the money moves)
--
-- V1 pays by hand, outside the system. external_reference and
-- destination_note are what tie this row to that act: a free-text
-- snapshot of where the money was sent, captured per request
-- rather than stored on the consultant, so a later change of bank
-- details cannot rewrite what an old payout says.

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),

  consultant_id uuid not null
    references public.consultants(id),

  status text not null default 'requested',

  currency text not null,

  requested_amount_minor integer not null,
  paid_amount_minor integer,

  destination_note text,
  external_reference text,
  admin_note text,

  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  paid_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,

  decided_by_admin_profile_id uuid
    references public.profiles(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.payouts is
  'Phase 1 finance. One consultant payout request. V1 payouts are '
  'paid manually by an admin; no Stripe Connect and no automatic '
  'bank transfer. Balances and payouts are per currency with no '
  'FX conversion.';

alter table public.payouts
  drop constraint if exists payouts_status_check;
alter table public.payouts
  add constraint payouts_status_check
  check (
    status in (
      'requested',
      'approved',
      'paid',
      'rejected',
      'cancelled'
    )
  );

alter table public.payouts
  drop constraint if exists payouts_currency_format_check;
alter table public.payouts
  add constraint payouts_currency_format_check
  check (currency ~ '^[a-z]{3}$');

alter table public.payouts
  drop constraint if exists payouts_requested_amount_check;
alter table public.payouts
  add constraint payouts_requested_amount_check
  check (requested_amount_minor > 0);

/*
 * State validity. Each terminal status carries the evidence that
 * it happened, so a row can never claim an outcome it has no
 * record of. Both directions are constrained: a paid row must
 * have an amount and a payer, and an unpaid row must not have a
 * paid amount sitting on it.
 */
alter table public.payouts
  drop constraint if exists payouts_paid_shape_check;
alter table public.payouts
  add constraint payouts_paid_shape_check
  check (
    (status = 'paid'
      and paid_amount_minor is not null
      and paid_amount_minor > 0
      and paid_at is not null
      and approved_at is not null
      and decided_by_admin_profile_id is not null)
    or (status <> 'paid' and paid_amount_minor is null)
  );

alter table public.payouts
  drop constraint if exists payouts_approved_shape_check;
alter table public.payouts
  add constraint payouts_approved_shape_check
  check (
    status not in ('approved', 'paid')
    or (approved_at is not null
        and decided_by_admin_profile_id is not null)
  );

alter table public.payouts
  drop constraint if exists payouts_rejected_shape_check;
alter table public.payouts
  add constraint payouts_rejected_shape_check
  check (
    status <> 'rejected'
    or (rejected_at is not null
        and decided_by_admin_profile_id is not null)
  );

alter table public.payouts
  drop constraint if exists payouts_cancelled_shape_check;
alter table public.payouts
  add constraint payouts_cancelled_shape_check
  check (
    status <> 'cancelled'
    or cancelled_at is not null
  );

/*
 * A request that is still open holds earnings reserved. Two open
 * requests in the same currency would reserve overlapping sets
 * and make "what can I withdraw" unanswerable, so the database
 * permits exactly one at a time per consultant per currency.
 * Closed requests are unconstrained, so a consultant may request
 * again as soon as the last one is settled.
 */
create unique index if not exists uq_payouts_one_open_per_currency
  on public.payouts (consultant_id, currency)
  where status in ('requested', 'approved');

create index if not exists idx_payouts_consultant
  on public.payouts (consultant_id, requested_at desc);

create index if not exists idx_payouts_open
  on public.payouts (status, requested_at)
  where status in ('requested', 'approved');

drop trigger if exists set_payouts_updated_at on public.payouts;
create trigger set_payouts_updated_at
  before update on public.payouts
  for each row execute function public.set_updated_at();


-- ============================================================
-- C. payout_allocations
-- ============================================================
--
-- Which ledger entries a payout covers.
--
-- The unique constraint on ledger_entry_id is the whole point of
-- the table: an earning can belong to at most one payout, and
-- that is guaranteed by the database rather than by application
-- care. Two concurrent requests cannot both claim the same
-- entry — the second fails on the index.
--
-- Releasing a reservation (a rejected or cancelled payout)
-- deletes these rows. The payout row survives with its status,
-- its amount and its reason, so the audit trail of the request
-- is intact while the earnings return to available. Deleting an
-- allocation belonging to a PAID payout is refused outright.

create table if not exists public.payout_allocations (
  payout_id uuid not null
    references public.payouts(id) on delete restrict,

  ledger_entry_id uuid not null
    references public.consultant_ledger_entries(id)
    on delete restrict,

  created_at timestamptz not null default now(),

  primary key (payout_id, ledger_entry_id)
);

comment on table public.payout_allocations is
  'Phase 1 finance. Links a ledger entry to the payout that pays '
  'it. The unique index on ledger_entry_id is what makes '
  'double-payment impossible.';

create unique index if not exists uq_payout_allocation_entry
  on public.payout_allocations (ledger_entry_id);

create index if not exists idx_payout_allocations_payout
  on public.payout_allocations (payout_id);

/*
 * Cross-table rules that no CHECK constraint can express.
 *
 * An allocation is only coherent when the entry and the payout
 * agree about who is being paid and in what currency, when the
 * entry is actually available, and when the payout is still open.
 * Getting any of these wrong pays the wrong person, pays money
 * that was not yet earned, or edits a settled payout.
 */
create or replace function public.enforce_payout_allocation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_payout public.payouts%rowtype;
  v_entry public.consultant_ledger_entries%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into v_payout
      from public.payouts
     where id = old.payout_id;

    if found and v_payout.status = 'paid' then
      raise exception
        'payout % is already paid; its allocations may not be released.',
        old.payout_id;
    end if;

    return old;
  end if;

  select * into v_payout
    from public.payouts
   where id = new.payout_id
   for update;

  if not found then
    raise exception 'payout % not found', new.payout_id;
  end if;

  if v_payout.status not in ('requested', 'approved') then
    raise exception
      'payout % is %; earnings may only be allocated to an open request.',
      v_payout.id, v_payout.status;
  end if;

  select * into v_entry
    from public.consultant_ledger_entries
   where id = new.ledger_entry_id
   for update;

  if not found then
    raise exception
      'ledger entry % not found', new.ledger_entry_id;
  end if;

  if v_entry.consultant_id <> v_payout.consultant_id then
    raise exception
      'ledger entry % belongs to a different consultant than payout %',
      v_entry.id, v_payout.id;
  end if;

  if v_entry.currency <> v_payout.currency then
    raise exception
      'ledger entry % is in %, payout % is in %; balances are not converted.',
      v_entry.id, v_entry.currency, v_payout.id, v_payout.currency;
  end if;

  if v_entry.available_at is null then
    raise exception
      'ledger entry % is not available yet and may not be paid out.',
      v_entry.id;
  end if;

  return new;
end;
$$;

revoke all
on function public.enforce_payout_allocation()
from public;

drop trigger if exists trg_payout_allocation_guard
  on public.payout_allocations;

create trigger trg_payout_allocation_guard
  before insert or delete on public.payout_allocations
  for each row
  execute function public.enforce_payout_allocation();


-- ============================================================
-- D. service_purchases
-- ============================================================
--
-- The financial record of a service being paid for.
--
-- Deliberately NOT service_requests. That table stays what it
-- is: the operational record of a request being worked. This one
-- records money — what was charged, in what currency, against
-- which Stripe object, who is credited for it, and when it
-- reached the fulfillment point that makes the commission
-- withdrawable. A purchase MAY reference a service_request, and
-- for a recurring service several purchases reference the same
-- one, which is exactly why the two cannot be the same row.
--
-- A recurring service earns commission on every successful
-- renewal, so each renewal is its own purchase row, distinguished
-- by billing_period_sequence and by its own Stripe invoice.

create table if not exists public.service_purchases (
  id uuid primary key default gen_random_uuid(),

  service_id uuid not null
    references public.services(id),

  /* Operational link. Null when a purchase has no request row. */
  service_request_id uuid
    references public.service_requests(id),

  /* Attribution context: which consultation led to this sale. */
  consultation_id uuid
    references public.consultations(id),

  client_profile_id uuid
    references public.profiles(id),

  /* Who earns the commission. Null when nobody is credited. */
  attributed_consultant_id uuid
    references public.consultants(id),

  gross_amount_minor integer not null,
  currency text not null,

  billing_type text not null,
  recurring_interval text,
  billing_period_sequence integer not null default 1,

  status text not null default 'paid',

  stripe_mode text,
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  stripe_invoice_id text,

  purchased_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  refunded_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.service_purchases is
  'Phase 1 finance. One paid-for service purchase, including each '
  'renewal of a recurring service. Distinct from service_requests, '
  'which remains the operational fulfillment record and which a '
  'purchase may reference.';

alter table public.service_purchases
  drop constraint if exists service_purchases_currency_format_check;
alter table public.service_purchases
  add constraint service_purchases_currency_format_check
  check (currency ~ '^[a-z]{3}$');

/*
 * Commission is calculated on the gross amount charged, so the
 * gross has to be a real amount. A free service produces no
 * commission and therefore no purchase row.
 */
alter table public.service_purchases
  drop constraint if exists service_purchases_gross_amount_check;
alter table public.service_purchases
  add constraint service_purchases_gross_amount_check
  check (gross_amount_minor > 0);

alter table public.service_purchases
  drop constraint if exists service_purchases_status_check;
alter table public.service_purchases
  add constraint service_purchases_status_check
  check (
    status in ('paid', 'fulfilled', 'refunded', 'cancelled')
  );

alter table public.service_purchases
  drop constraint if exists service_purchases_stripe_mode_check;
alter table public.service_purchases
  add constraint service_purchases_stripe_mode_check
  check (stripe_mode is null or stripe_mode in ('test', 'live'));

/*
 * Mirrors the billing shape rule migration 022 put on services,
 * including its IS NULL guards: a CHECK admits a row whose
 * expression evaluates to NULL, so every branch has to resolve
 * to a concrete boolean.
 */
alter table public.service_purchases
  drop constraint if exists service_purchases_billing_shape_check;
alter table public.service_purchases
  add constraint service_purchases_billing_shape_check
  check (
    (billing_type = 'one_time'
      and recurring_interval is null
      and billing_period_sequence = 1)
    or (billing_type = 'recurring'
      and recurring_interval is not null
      and recurring_interval in ('month', 'year')
      and billing_period_sequence >= 1)
  );

alter table public.service_purchases
  drop constraint if exists service_purchases_fulfilled_shape_check;
alter table public.service_purchases
  add constraint service_purchases_fulfilled_shape_check
  check (
    (status = 'fulfilled' and fulfilled_at is not null)
    or status <> 'fulfilled'
  );

alter table public.service_purchases
  drop constraint if exists service_purchases_refunded_shape_check;
alter table public.service_purchases
  add constraint service_purchases_refunded_shape_check
  check (
    (status = 'refunded' and refunded_at is not null)
    or status <> 'refunded'
  );

/*
 * Stripe identifiers are the idempotency anchors. A redelivered
 * webhook carrying the same PaymentIntent or the same invoice
 * cannot create a second purchase, which is the first half of
 * "no duplicate earning"; the ledger's own unique index is the
 * second.
 */
create unique index if not exists uq_service_purchases_payment_intent
  on public.service_purchases (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create unique index if not exists uq_service_purchases_invoice
  on public.service_purchases (stripe_invoice_id)
  where stripe_invoice_id is not null;

create unique index if not exists uq_service_purchases_checkout_session
  on public.service_purchases (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

/*
 * One purchase per billing period of a given request, so a
 * renewal recorded twice by hand is rejected the same way a
 * replayed webhook is.
 */
create unique index if not exists uq_service_purchases_request_period
  on public.service_purchases (
    service_request_id, billing_period_sequence
  )
  where service_request_id is not null;

create index if not exists idx_service_purchases_consultant
  on public.service_purchases (attributed_consultant_id, purchased_at desc);

create index if not exists idx_service_purchases_service
  on public.service_purchases (service_id, purchased_at desc);

drop trigger if exists set_service_purchases_updated_at
  on public.service_purchases;
create trigger set_service_purchases_updated_at
  before update on public.service_purchases
  for each row execute function public.set_updated_at();


-- ============================================================
-- E. services.consultant_commission_bps
-- ============================================================
--
-- The per-service consultant commission rate, in basis points on
-- the gross amount charged.
--
-- Nullable with no default: an existing service has no agreed
-- rate, and null says so rather than inventing 0% or 50%. A
-- service with a null rate earns no commission until an admin
-- sets one.

alter table public.services
  add column if not exists consultant_commission_bps integer;

alter table public.services
  drop constraint if exists services_commission_bps_check;
alter table public.services
  add constraint services_commission_bps_check
  check (
    consultant_commission_bps is null
    or consultant_commission_bps between 0 and 10000
  );

comment on column public.services.consultant_commission_bps is
  'Migration 034. Consultant commission for this service, in '
  'basis points of the gross amount charged (5000 = 50.00%). '
  'Snapshotted onto the ledger entry at purchase, so a later '
  'change never rewrites an existing earning. Deliberately '
  'excluded from the SELECT grant held by anon and authenticated.';

/*
 * Hiding the rate from the client who pays it.
 *
 * services_select_active (migration 002) is readable by every
 * authenticated user, so a client can read any active service
 * row. RLS filters rows, not columns, so the only mechanism that
 * keeps this column away from them is the column privilege
 * itself — and a table-level SELECT grant overrides any
 * column-level revoke, so the table grant has to go first and be
 * replaced by an explicit column list.
 *
 * The list is computed rather than typed out, so the intent
 * survives: adding a column later leaves it ungranted, which
 * fails closed. A future migration that adds a client-visible
 * column to services must grant it explicitly.
 *
 * INSERT, UPDATE and DELETE are untouched here. Migration 022
 * already revoked all three from authenticated and dropped the
 * admin write policies: the service catalog is written only by
 * the orchestrator, which uses the service role and bypasses
 * both RLS and column privileges.
 */
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_columns
    from pg_attribute
   where attrelid = 'public.services'::regclass
     and attnum > 0
     and not attisdropped
     and attname <> 'consultant_commission_bps';

  if v_columns is null then
    raise exception
      'migration 034: could not resolve the public.services column list';
  end if;

  execute
    'revoke select on public.services from anon, authenticated';

  execute format(
    'grant select (%s) on public.services to anon, authenticated',
    v_columns
  );
end;
$$;


-- ============================================================
-- F. app_settings consultation commission
-- ============================================================
--
-- The standard consultation split, 50/50, expressed as the
-- consultant's share in basis points. It is configuration rather
-- than a constant because it is the value snapshotted onto each
-- new consultation earning; changing it moves future earnings
-- only, and never touches a row already written.
--
-- NOT NULL with a default of 5000 so the single existing
-- app_settings row is correct the moment this migration applies.
--
-- app_settings has RLS enabled with zero policies and all
-- privileges revoked from anon and authenticated (migration 025),
-- so this value is orchestrator-only without any further work.

alter table public.app_settings
  add column if not exists
    consultation_consultant_commission_bps integer
    not null default 5000;

alter table public.app_settings
  drop constraint if exists app_settings_consultation_commission_check;
alter table public.app_settings
  add constraint app_settings_consultation_commission_check
  check (
    consultation_consultant_commission_bps between 0 and 10000
  );

comment on column
  public.app_settings.consultation_consultant_commission_bps is
  'Migration 034. Consultant share of a standard consultation, in '
  'basis points of the gross price (5000 = 50.00%, the locked '
  'Phase 1 rule). Snapshotted onto each ledger entry at booking; '
  'changing it affects future earnings only.';


-- ============================================================
-- G. RLS, grants and the balance view
-- ============================================================
--
-- The access rule for all four tables is the same:
--
--   consultant  reads their own finance records
--   admin       reads everything
--   client      reads nothing, under any policy
--   writes      service role only
--
-- The client's exclusion is structural rather than filtered: no
-- policy on any of these tables names client_profile_id, so
-- there is no clause to loosen by accident later. That is also
-- why service_purchases.client_profile_id exists but grants its
-- subject nothing — it is attribution data, not an access key.

alter table public.consultant_ledger_entries
  enable row level security;
alter table public.payouts enable row level security;
alter table public.payout_allocations enable row level security;
alter table public.service_purchases enable row level security;

/*
 * A policy's subquery is evaluated as the calling user, so
 * reading payouts from inside the payout_allocations policy
 * would apply the payouts policy in turn. This helper is
 * SECURITY DEFINER for the same reason is_consultation_participant
 * (migration 002) is, and follows its shape.
 */
create or replace function public.can_view_payout(p_payout_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.payouts p
    where p.id = p_payout_id
      and (
        p.consultant_id = public.my_consultant_id()
        or public.is_admin()
      )
  );
$$;

revoke all on function public.can_view_payout(uuid) from public;
grant execute on function public.can_view_payout(uuid)
  to authenticated;

-- ------------------------------------------------------ policies ----

drop policy if exists ledger_select_own_or_admin
  on public.consultant_ledger_entries;
create policy ledger_select_own_or_admin
  on public.consultant_ledger_entries
  for select to authenticated
  using (
    consultant_id = public.my_consultant_id()
    or public.is_admin()
  );
-- No insert/update/delete policy: orchestrator (service role) only.

drop policy if exists payouts_select_own_or_admin on public.payouts;
create policy payouts_select_own_or_admin
  on public.payouts
  for select to authenticated
  using (
    consultant_id = public.my_consultant_id()
    or public.is_admin()
  );
-- No write policy: a consultant requests a payout through the
-- orchestrator, which is what reserves the earnings atomically.

drop policy if exists payout_allocations_select_own_or_admin
  on public.payout_allocations;
create policy payout_allocations_select_own_or_admin
  on public.payout_allocations
  for select to authenticated
  using (public.can_view_payout(payout_id));

drop policy if exists service_purchases_select_own_or_admin
  on public.service_purchases;
create policy service_purchases_select_own_or_admin
  on public.service_purchases
  for select to authenticated
  using (
    attributed_consultant_id = public.my_consultant_id()
    or public.is_admin()
  );
-- Deliberately no clause for client_profile_id: a client sees no
-- finance record, including their own purchase.

-- -------------------------------------------------------- grants ----
--
-- Supabase's default privileges grant everything on a new public
-- table to anon and authenticated, so the grants a finance table
-- needs have to be stated rather than assumed. anon loses all
-- four tables outright; authenticated keeps SELECT, which the
-- policies above then filter, and loses every write.

revoke all on public.consultant_ledger_entries from anon;
revoke all on public.payouts from anon;
revoke all on public.payout_allocations from anon;
revoke all on public.service_purchases from anon;

revoke insert, update, delete, truncate
  on public.consultant_ledger_entries from authenticated;
revoke insert, update, delete, truncate
  on public.payouts from authenticated;
revoke insert, update, delete, truncate
  on public.payout_allocations from authenticated;
revoke insert, update, delete, truncate
  on public.service_purchases from authenticated;

grant select on public.consultant_ledger_entries to authenticated;
grant select on public.payouts to authenticated;
grant select on public.payout_allocations to authenticated;
grant select on public.service_purchases to authenticated;

-- --------------------------------------------------------- view ----
--
-- No balance is stored. Every figure below is derived from the
-- ledger and the allocations, so there is no cached total that
-- can drift from the rows that justify it.
--
--   pending    earned, not yet available
--   available  available and not claimed by an open or paid payout
--   reserved   claimed by a requested or approved payout
--   paid       claimed by a paid payout
--   lifetime   everything, whatever its state
--
-- Grouped by currency, never summed across currencies: there is
-- no FX conversion anywhere in this system.
--
-- available is defined as "not claimed by a live payout" rather
-- than "has no allocation row", so an allocation left behind on a
-- cancelled or rejected payout cannot hide an earning that is in
-- fact withdrawable.
--
-- security_invoker means the ledger's RLS decides what the caller
-- sees: a consultant sees one row per currency of their own, an
-- admin sees every consultant, a client sees nothing.

create or replace view public.consultant_balances
with (security_invoker = on) as
select
  e.consultant_id,
  e.currency,

  /*
   * Every figure is coalesced to zero. A FILTER that matches no
   * row sums to null, and a null balance would have to be
   * defended against by every caller; zero is both the correct
   * answer and the one nobody has to check for.
   */
  coalesce(
    sum(e.consultant_amount_minor)
      filter (where e.available_at is null),
    0
  ) as pending_minor,

  coalesce(
    sum(e.consultant_amount_minor)
      filter (
        where e.available_at is not null
          and p.status is distinct from 'requested'
          and p.status is distinct from 'approved'
          and p.status is distinct from 'paid'
      ),
    0
  ) as available_minor,

  coalesce(
    sum(e.consultant_amount_minor)
      filter (where p.status in ('requested', 'approved')),
    0
  ) as reserved_minor,

  coalesce(
    sum(e.consultant_amount_minor)
      filter (where p.status = 'paid'),
    0
  ) as paid_minor,

  coalesce(sum(e.consultant_amount_minor), 0) as lifetime_minor

from public.consultant_ledger_entries e
left join public.payout_allocations a
  on a.ledger_entry_id = e.id
left join public.payouts p
  on p.id = a.payout_id
group by e.consultant_id, e.currency;

comment on view public.consultant_balances is
  'Phase 1 finance. Derived per-consultant, per-currency balances. '
  'Nothing here is stored; every figure is a sum over '
  'consultant_ledger_entries. security_invoker, so the ledger RLS '
  'decides visibility.';

revoke all on public.consultant_balances from anon;
grant select on public.consultant_balances to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_034_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 20
--
--  2. select count(*) from pg_policies
--      where schemaname = 'public'
--        and tablename in (
--          'consultant_ledger_entries', 'payouts',
--          'payout_allocations', 'service_purchases');
--       -> 4, all SELECT
--
--  3. select has_column_privilege(
--       'authenticated', 'public.services',
--       'consultant_commission_bps', 'SELECT');
--       -> false
--
--  4. select consultation_consultant_commission_bps
--       from public.app_settings;
--       -> 5000
