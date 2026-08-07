-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 037: Human-readable finance references
-- ============================================================
--
-- Classification:
-- - Phase 1 finance completion. Adds two display identifiers.
--   No payout logic, no commission logic, no policy change.
--
-- What this migration does:
--   A. Two sequences, one per reference kind.
--   B. payouts.payout_reference                 PAY-YYYY-NNNNNN
--      consultant_ledger_entries.adjustment_reference
--                                               ADJ-YYYY-NNNNNN
--   C. build_finance_reference(), the single formatter.
--   D. Backfills every existing row.
--   E. Uniqueness, and the rule that only an adjustment carries
--      an adjustment reference.
--   F. Assignment and immutability triggers.
--   G. Replaces the four RPCs that create these rows so they
--      return the reference they generated.
--
-- Numbering: GLOBAL AND MONOTONIC, NOT RESET EACH YEAR.
-- - The year in the string is the year the row was created; the
--   number keeps counting across years, so 2026 might end at
--   PAY-2026-000482 and 2027 open at PAY-2027-000483.
-- - This is a deliberate choice, stated here so it is visible
--   rather than discovered. A per-year restart needs either a
--   counter table or a sequence reset every January, and both
--   are more machinery than a display identifier justifies. The
--   stated requirements — stable, unique, server-side, immutable,
--   safe to display — are all met either way.
-- - A sequence also never rolls back, so a transaction that
--   fails cannot hand its number to the next row. References gap
--   rather than repeat, which for an identifier is the correct
--   trade.
-- - lpad pads to six digits and does not truncate: the
--   1,000,000th reference renders as PAY-YYYY-1000000 rather
--   than colliding.
--
-- Deliberately NOT done here:
-- - No change to any amount, split, allocation, payout status
--   rule or commission rate.
-- - No new table.
-- - No client input anywhere. Both triggers OVERWRITE whatever
--   was supplied on insert, so a caller cannot choose or guess a
--   reference into existence.
-- - No RLS or grant change beyond re-applying migration 036's
--   revokes to the four replaced functions, which is mandatory:
--   a dropped and recreated function loses its ACL and Supabase's
--   default privileges hand EXECUTE straight back to anon and
--   authenticated.
--
-- Rerun safety:
-- - Idempotent. Columns and sequences use IF NOT EXISTS, the
--   backfill is guarded on the column being null, constraints are
--   dropped before being added, and the setval calls take the
--   larger of the current value and the backfilled maximum.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.payouts') is null
     or to_regclass('public.consultant_ledger_entries') is null then
    raise exception
      'migration 037: finance tables not found - migration 034 must be applied first';
  end if;

  if to_regprocedure(
       'public.request_consultant_payout(uuid, text, text)'
     ) is null then
    raise exception
      'migration 037: finance RPCs not found - migration 035 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. Sequences
-- ============================================================
--
-- One per kind, so a payout and an adjustment created in the
-- same second cannot contend for the same number, and so the two
-- series read independently.

create sequence if not exists public.payout_reference_seq
  as bigint start with 1 minvalue 1 no cycle;

create sequence if not exists
  public.ledger_adjustment_reference_seq
  as bigint start with 1 minvalue 1 no cycle;


-- ============================================================
-- B. Columns
-- ============================================================
--
-- Nullable at first because the backfill has to run before the
-- constraints can hold. Both end up governed by the constraints
-- in part E and assigned by the triggers in part F.

alter table public.payouts
  add column if not exists payout_reference text;

alter table public.consultant_ledger_entries
  add column if not exists adjustment_reference text;

comment on column public.payouts.payout_reference is
  'Migration 037. Human-readable payout identifier, '
  'PAY-YYYY-NNNNNN. Generated server-side on insert, immutable '
  'afterwards, never supplied by a caller. Safe to show to a '
  'consultant or an admin.';

comment on column
  public.consultant_ledger_entries.adjustment_reference is
  'Migration 037. Human-readable identifier for an admin '
  'adjustment, ADJ-YYYY-NNNNNN. Non-null on adjustment entries '
  'and null on every other entry type, by constraint. Generated '
  'server-side on insert and immutable afterwards.';


-- ============================================================
-- C. The formatter
-- ============================================================
--
-- One place where the shape of a reference is decided, so the
-- assignment triggers and the backfill cannot drift apart.

create or replace function public.build_finance_reference(
  p_prefix text,
  p_year integer,
  p_number bigint
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select p_prefix || '-' || p_year::text || '-'
         || lpad(p_number::text, 6, '0');
$$;

comment on function public.build_finance_reference(
  text, integer, bigint) is
  'Migration 037. Formats a finance reference as '
  'PREFIX-YYYY-NNNNNN. The number is zero-padded to six digits '
  'and never truncated.';


-- ============================================================
-- D. Backfill
-- ============================================================
--
-- Existing rows are numbered in creation order, so the sequence
-- of references matches the sequence of events. Each row takes
-- the year it was actually created in, not the year this
-- migration runs.
--
-- The ledger backfill has to disable trg_ledger_append_only for
-- the length of one statement. That trigger refuses every UPDATE
-- except the available_at stamp, and it is doing its job: this is
-- the one write that legitimately needs to go around it, adding a
-- column that did not exist when the row was written. It is
-- re-enabled immediately, inside the same transaction, and the
-- statement touches nothing but the new column on rows where it
-- is null.

do $$
declare
  v_row record;
  v_next bigint;
begin
  for v_row in
    select id, requested_at
      from public.payouts
     where payout_reference is null
     order by requested_at, id
  loop
    v_next := nextval('public.payout_reference_seq');

    update public.payouts
       set payout_reference = public.build_finance_reference(
             'PAY',
             extract(year from v_row.requested_at)::integer,
             v_next
           )
     where id = v_row.id;
  end loop;
end;
$$;

do $$
declare
  v_row record;
  v_next bigint;
  v_pending integer;
begin
  select count(*) into v_pending
    from public.consultant_ledger_entries
   where entry_type = 'adjustment'
     and adjustment_reference is null;

  if v_pending = 0 then
    return;
  end if;

  alter table public.consultant_ledger_entries
    disable trigger trg_ledger_append_only;

  for v_row in
    select id, created_at
      from public.consultant_ledger_entries
     where entry_type = 'adjustment'
       and adjustment_reference is null
     order by created_at, id
  loop
    v_next := nextval(
      'public.ledger_adjustment_reference_seq'
    );

    update public.consultant_ledger_entries
       set adjustment_reference =
             public.build_finance_reference(
               'ADJ',
               extract(year from v_row.created_at)::integer,
               v_next
             )
     where id = v_row.id;
  end loop;

  alter table public.consultant_ledger_entries
    enable trigger trg_ledger_append_only;
end;
$$;


-- ============================================================
-- E. Uniqueness and scope
-- ============================================================

create unique index if not exists uq_payouts_reference
  on public.payouts (payout_reference);

create unique index if not exists uq_ledger_adjustment_reference
  on public.consultant_ledger_entries (adjustment_reference)
  where adjustment_reference is not null;

/*
 * An adjustment always has a reference and nothing else ever
 * does. Written as a biconditional rather than as "adjustments
 * must have one", so an earning that somehow acquired a
 * reference is rejected too.
 */
alter table public.consultant_ledger_entries
  drop constraint if exists ledger_adjustment_reference_scope_check;
alter table public.consultant_ledger_entries
  add constraint ledger_adjustment_reference_scope_check
  check (
    (entry_type = 'adjustment'
      and adjustment_reference is not null)
    or (entry_type <> 'adjustment'
      and adjustment_reference is null)
  );

/*
 * Shape, so a hand-written value cannot masquerade as a
 * generated one. Six digits or more, never fewer.
 */
alter table public.payouts
  drop constraint if exists payouts_reference_format_check;
alter table public.payouts
  add constraint payouts_reference_format_check
  check (
    payout_reference is null
    or payout_reference ~ '^PAY-[0-9]{4}-[0-9]{6,}$'
  );

alter table public.consultant_ledger_entries
  drop constraint if exists ledger_adjustment_reference_format_check;
alter table public.consultant_ledger_entries
  add constraint ledger_adjustment_reference_format_check
  check (
    adjustment_reference is null
    or adjustment_reference ~ '^ADJ-[0-9]{4}-[0-9]{6,}$'
  );

-- Every payout must carry one from here on.
alter table public.payouts
  alter column payout_reference set not null;


-- ============================================================
-- F. Assignment and immutability
-- ============================================================
--
-- Both assignment triggers overwrite unconditionally. That is
-- what makes "not client-supplied" true rather than merely
-- intended: there is no branch in which a value that arrived
-- from outside survives.

create or replace function public.assign_payout_reference()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    new.payout_reference := public.build_finance_reference(
      'PAY',
      extract(year from coalesce(new.requested_at, now()))::integer,
      nextval('public.payout_reference_seq')
    );

    return new;
  end if;

  if new.payout_reference
       is distinct from old.payout_reference then
    raise exception
      'payout % reference is immutable: % may not become %',
      old.id, old.payout_reference, new.payout_reference;
  end if;

  return new;
end;
$$;

revoke all on function public.assign_payout_reference()
  from public, anon, authenticated;

drop trigger if exists trg_payouts_reference on public.payouts;

create trigger trg_payouts_reference
  before insert or update on public.payouts
  for each row
  execute function public.assign_payout_reference();

/*
 * The ledger needs no immutability trigger of its own:
 * trg_ledger_append_only already refuses every UPDATE except the
 * available_at stamp. It is replaced below so the new column is
 * inside that refusal rather than outside it.
 */
create or replace function public.assign_adjustment_reference()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.entry_type = 'adjustment' then
    new.adjustment_reference := public.build_finance_reference(
      'ADJ',
      extract(year from coalesce(new.created_at, now()))::integer,
      nextval('public.ledger_adjustment_reference_seq')
    );
  else
    /* Earnings and reversals never carry one. */
    new.adjustment_reference := null;
  end if;

  return new;
end;
$$;

revoke all on function public.assign_adjustment_reference()
  from public, anon, authenticated;

drop trigger if exists trg_ledger_adjustment_reference
  on public.consultant_ledger_entries;

create trigger trg_ledger_adjustment_reference
  before insert on public.consultant_ledger_entries
  for each row
  execute function public.assign_adjustment_reference();


-- ------------------------------------------ append-only, updated ----
--
-- Identical to migration 034's function with one column added to
-- the comparison. Without this, adjustment_reference would be the
-- single column on an append-only table that an UPDATE could
-- quietly change.

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
     or new.adjustment_reference
          is distinct from old.adjustment_reference
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

revoke all on function public.enforce_ledger_append_only()
  from public, anon, authenticated;


-- ============================================================
-- G. RPCs that now return the reference they generated
-- ============================================================
--
-- A display identifier the API cannot return is not a display
-- identifier. These four create the rows that carry one, so each
-- returns it rather than making the caller read it back.
--
-- DROP before CREATE: PostgreSQL will not change the return type
-- of an existing function, and adding a column to RETURNS TABLE
-- is a return-type change.
--
-- Every one is re-revoked afterwards. A dropped function takes
-- its ACL with it, and Supabase's default privileges grant
-- EXECUTE to anon and authenticated on whatever is created next —
-- so without the revokes below, this migration would silently
-- undo migration 036 for these four functions. Bodies are
-- otherwise unchanged from migration 035.

drop function if exists public.create_ledger_adjustment(
  uuid, integer, text, text, uuid);

create or replace function public.create_ledger_adjustment(
  p_consultant_id uuid,
  p_amount_minor integer,
  p_currency text,
  p_memo text,
  p_admin_profile_id uuid
)
returns table (
  entry_id uuid,
  adjustment_reference text,
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
  select v_entry.id, v_entry.adjustment_reference,
         v_entry.consultant_id,
         v_entry.consultant_amount_minor, v_entry.currency,
         v_entry.memo, v_entry.available_at, v_entry.created_at;
end;
$$;


drop function if exists public.request_consultant_payout(
  uuid, text, text);

create or replace function public.request_consultant_payout(
  p_consultant_id uuid,
  p_currency text,
  p_destination_note text default null
)
returns table (
  payout_id uuid,
  payout_reference text,
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
  select v_payout.id, v_payout.payout_reference, v_payout.status,
         v_payout.currency, v_payout.requested_amount_minor,
         v_count, v_payout.requested_at;
end;
$$;


drop function if exists public.decide_payout(
  uuid, text, uuid, text);

create or replace function public.decide_payout(
  p_payout_id uuid,
  p_decision text,
  p_admin_profile_id uuid,
  p_note text default null
)
returns table (
  payout_id uuid,
  payout_reference text,
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
  select v_payout.id, v_payout.payout_reference, v_payout.status,
         v_payout.currency, v_payout.requested_amount_minor,
         v_released, v_payout.approved_at, v_payout.rejected_at,
         v_payout.cancelled_at;
end;
$$;


drop function if exists public.mark_payout_paid(
  uuid, integer, text, uuid, timestamptz, text);

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
  payout_reference text,
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
  select v_payout.id, v_payout.payout_reference, v_payout.status,
         v_payout.currency, v_payout.requested_amount_minor,
         v_payout.paid_amount_minor, v_payout.paid_at,
         v_payout.external_reference;
end;
$$;


-- --------------------------------------- migration 036 re-applied ----
--
-- Mandatory, not decorative. See the note above part G.

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
  public.mark_payout_paid(
    uuid, integer, text, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function
  public.build_finance_reference(text, integer, bigint)
  from public, anon, authenticated;

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
  public.mark_payout_paid(
    uuid, integer, text, uuid, timestamptz, text)
  to service_role;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_037_VERIFICATION.sql for the full self-contained suite.
--
--  1. select payout_reference from public.payouts
--      order by requested_at limit 3;
--       -> PAY-YYYY-NNNNNN
--
--  2. select count(*) from public.consultant_ledger_entries
--      where entry_type = 'adjustment'
--        and adjustment_reference is null;
--       -> 0
--
--  3. select count(*) from pg_proc p
--      join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and has_function_privilege('anon', p.oid, 'EXECUTE')
--       and p.proname <> 'is_admin';
--       -> 0  (migration 036 still holds)
