-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 039: Consultant payout method setting
-- ============================================================
--
-- Classification:
-- - Phase 1 finance gap. One private table, its RLS, and the
--   payout request RPC replaced so it snapshots the destination
--   itself. No commission change, no ledger change, no payout
--   status rule change, no Stripe Connect, no PayPal or Wise API.
--
-- The problem this solves:
-- - V1 pays consultants BY HAND. An admin opens PayPal or Wise
--   and sends the money. Until now the system never recorded
--   where to send it: payouts.destination_note existed and the
--   only thing that could fill it was a free-text field on the
--   payout request, typed by the consultant, every single time.
--   That is a re-typed email address on every withdrawal and an
--   admin trusting whatever arrived in it.
--
-- What this migration does:
--   A. public.consultant_payout_settings, one private row per
--      consultant: which manual service to pay them through, and
--      the email to send it to.
--   B. Vocabulary, presence and shape constraints.
--   C. Normalisation and updated_at triggers.
--   D. RLS and grants.
--   E. build_payout_destination_note(), the single formatter.
--   F. request_consultant_payout() replaced: it now LOADS the
--      saved setting, REFUSES when there is none, and writes the
--      snapshot itself.
--   G. Migration 036's privileges re-applied to the replaced
--      function.
--
-- Why a separate table rather than columns on consultants:
-- - public.consultants is the booking projection. Every client
--   and every anonymous visitor reads active consultant rows to
--   choose who to book, so a column added there is a column the
--   world can see unless a column privilege is maintained to say
--   otherwise. Migration 034 already had to do exactly that
--   surgery for services.consultant_commission_bps, and its own
--   comment records that the arrangement fails closed only for as
--   long as every future migration remembers it.
-- - A payout email is not booking data. It is private banking
--   detail that belongs to one consultant and one admin, and a
--   table whose every row is private by default cannot leak it by
--   forgetting a grant. The consultant projection therefore has
--   no payout column to expose, which is a stronger statement
--   than a column that is currently hidden.
--
-- Why the destination is snapshotted by the DATABASE, not passed
-- in by the caller:
-- - A payout's destination has to survive the consultant later
--   changing their email. If payout history read through to the
--   current setting, correcting a typo would silently rewrite
--   where every past payout claims to have been sent, and the
--   admin's record of a transfer they already made would change
--   under them. So the destination is copied onto the payout row
--   at request time and never read back from the setting.
-- - It is built inside the RPC rather than accepted as an
--   argument for the same reason the amount is summed inside the
--   RPC rather than accepted as an argument (migration 035 part
--   E): a value the caller cannot supply is a value the caller
--   cannot get wrong or forge. p_destination_note is therefore
--   REMOVED from the signature, not merely ignored — an argument
--   that still exists is an argument a later edit can start
--   trusting again.
--
-- Deliberately NOT done here:
-- - No bank account number, IBAN, SWIFT, sort code, Wise
--   recipient id or PayPal merchant id. V1 needs an email and a
--   service name, and every additional field is regulated data
--   this platform would then be storing for no current purpose.
-- - No Stripe Connect, no PayPal API, no Wise API, no automation.
--   An admin still pays by hand and still records the result
--   through mark_payout_paid, which this migration does not touch.
-- - No DELETE policy. Clearing a payout method is an UPDATE to
--   null; there is no product reason to destroy the row, and
--   keeping it preserves created_at.
-- - No admin write path. An admin READS a consultant's payout
--   setting so they know where to send the money; changing where
--   another person gets paid is not an administrative convenience.
-- - No change to mark_payout_paid, decide_payout, any ledger
--   function, any commission rate, or any existing policy on any
--   existing table.
--
-- Rerun safety:
-- - Idempotent. CREATE TABLE IF NOT EXISTS, every constraint
--   dropped before it is added, triggers dropped before creation,
--   functions CREATE OR REPLACE, policies dropped before
--   creation, and REVOKE/GRANT are declarative. Part F's DROP
--   FUNCTION names the OLD three-argument signature, so a re-run
--   after the new one exists finds nothing to drop and proceeds.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.consultants') is null
     or to_regclass('public.payouts') is null then
    raise exception
      'migration 039: consultants or payouts not found - migrations 001 and 034 must be applied first';
  end if;

  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.my_consultant_id()') is null then
    raise exception
      'migration 039: RLS helpers not found - migration 002 must be applied first';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'migration 039: public.set_updated_at() not found - migration 001 must be applied first';
  end if;

  if to_regprocedure(
       'public.request_consultant_payout(uuid, text, text)'
     ) is null
     and to_regprocedure(
       'public.request_consultant_payout(uuid, text)'
     ) is null then
    raise exception
      'migration 039: request_consultant_payout not found - migrations 035 and 037 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. consultant_payout_settings
-- ============================================================
--
-- One row per consultant, keyed BY the consultant. Not a
-- surrogate id: a consultant has exactly one payout destination
-- in V1, and making that the primary key means "two payout
-- methods for one consultant" is unrepresentable rather than
-- merely unexpected. It also makes the row trivially upsertable
-- from the profile screen without a lookup first.
--
-- ON DELETE CASCADE because this row has no meaning without its
-- consultant, and leaving an orphaned payout email behind would
-- be retaining personal data with nothing left to justify it. The
-- payouts that referenced it keep their own snapshot, so nothing
-- historical is lost when the setting goes.

create table if not exists public.consultant_payout_settings (
  consultant_id uuid primary key
    references public.consultants(id) on delete cascade,

  /*
   * Null until the consultant chooses. Null is the honest
   * representation of "not configured yet" and is what the payout
   * request refuses on; a default of 'paypal' would claim a
   * decision nobody made.
   */
  payout_method text,
  payout_email text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.consultant_payout_settings is
  'Migration 039. Private, one row per consultant: how MakeHijrah '
  'manually pays them (PayPal or Wise) and the email to send it '
  'to. Readable by that consultant and by an admin, by nobody '
  'else, under any policy. Deliberately NOT on public.consultants, '
  'which every client and anonymous visitor reads. V1 payouts are '
  'manual; there is no Stripe Connect, no PayPal API and no Wise '
  'API anywhere in this system.';

comment on column
  public.consultant_payout_settings.payout_method is
  'Migration 039. ''paypal'' or ''wise'', or null when the '
  'consultant has not chosen yet. Snapshotted onto '
  'payouts.destination_note at request time, so a later change '
  'never rewrites an existing payout.';

comment on column
  public.consultant_payout_settings.payout_email is
  'Migration 039. The address the manual payment is sent to. '
  'Required whenever payout_method is set. Never exposed to a '
  'client, an anonymous visitor or another consultant.';


-- ============================================================
-- B. Constraints
-- ============================================================

alter table public.consultant_payout_settings
  drop constraint if exists payout_settings_method_check;
alter table public.consultant_payout_settings
  add constraint payout_settings_method_check
  check (payout_method is null
         or payout_method in ('paypal', 'wise'));

/*
 * The rule that makes "configured" a single question with a
 * single answer: a method without somewhere to send the money is
 * not a payout method. Written so a blank string fails too —
 * btrim(...) <> '' — because '' is the value a form submits when
 * the user clears a field, and a check that only tested NOT NULL
 * would accept it.
 *
 * The converse is deliberately permitted: an email with no method
 * chosen is a half-finished form, and refusing it would stop a
 * consultant saving their address before deciding between the two
 * services. The payout request refuses it, which is the point at
 * which incompleteness actually matters.
 */
alter table public.consultant_payout_settings
  drop constraint if exists payout_settings_email_presence_check;
alter table public.consultant_payout_settings
  add constraint payout_settings_email_presence_check
  check (
    payout_method is null
    or (payout_email is not null
        and btrim(payout_email) <> '')
  );

/*
 * Shape, not validity. Nothing here can prove an address is
 * deliverable — only sending to it can — so this rejects the
 * things that are certainly wrong (no @, whitespace inside,
 * absurd length) and lets the admin's own eyes do the rest at
 * payment time. A stricter regex would reject valid addresses and
 * buy nothing, because the failure mode this guards against is a
 * typo, and a typo passes any regex.
 */
alter table public.consultant_payout_settings
  drop constraint if exists payout_settings_email_shape_check;
alter table public.consultant_payout_settings
  add constraint payout_settings_email_shape_check
  check (
    payout_email is null
    or (
      payout_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and length(payout_email) <= 320
    )
  );


-- ============================================================
-- C. Normalisation and updated_at
-- ============================================================
--
-- A form submits '  Me@Example.com  ' and '' more often than it
-- submits clean input, so the trimming happens once here rather
-- than in every caller. Two rules, both conservative:
--
--   * whitespace is stripped and an empty result becomes null,
--     so "cleared the field" and "never filled it in" are the
--     same state rather than two states that behave differently;
--   * the method is lowercased so 'PayPal' from a select box
--     satisfies the vocabulary check instead of failing it.
--
-- The address itself is NOT lowercased. The local part of an
-- email address is case-sensitive by specification, and this
-- value is going to be typed into a payment form by a human; it
-- is stored as the consultant wrote it.

create or replace function
  public.normalize_consultant_payout_settings()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.payout_method :=
    nullif(btrim(lower(coalesce(new.payout_method, ''))), '');

  new.payout_email :=
    nullif(btrim(coalesce(new.payout_email, '')), '');

  return new;
end;
$$;

revoke all
on function public.normalize_consultant_payout_settings()
from public, anon, authenticated;

drop trigger if exists trg_payout_settings_normalize
  on public.consultant_payout_settings;

create trigger trg_payout_settings_normalize
  before insert or update on public.consultant_payout_settings
  for each row
  execute function
    public.normalize_consultant_payout_settings();

drop trigger if exists set_payout_settings_updated_at
  on public.consultant_payout_settings;

create trigger set_payout_settings_updated_at
  before update on public.consultant_payout_settings
  for each row execute function public.set_updated_at();


-- ============================================================
-- D. RLS and grants
-- ============================================================
--
--   consultant  reads, creates and updates their OWN row
--   admin       reads every row
--   client      nothing
--   anon        nothing
--
-- Every policy identifies the consultant through
-- my_consultant_id(), which resolves auth.uid() to a consultant
-- row. A consultant_id in the request body is therefore never
-- consulted: the INSERT policy's WITH CHECK compares the row
-- being written against the caller's own consultant id, so
-- writing a row for somebody else fails the check rather than
-- depending on the client having sent the right value.
--
-- my_consultant_id() returns null for a client and for an admin
-- who is not also a consultant, and `consultant_id = null` is
-- null, which is not true — so a client is excluded by the same
-- expression that scopes a consultant, with no separate clause to
-- get wrong.
--
-- No DELETE policy and no delete grant. Clearing a method is an
-- UPDATE to null.
--
-- No admin write policy. An admin can see where a consultant is
-- paid; changing it is the consultant's own act.

alter table public.consultant_payout_settings
  enable row level security;

drop policy if exists payout_settings_select_own_or_admin
  on public.consultant_payout_settings;
create policy payout_settings_select_own_or_admin
  on public.consultant_payout_settings
  for select to authenticated
  using (
    consultant_id = public.my_consultant_id()
    or public.is_admin()
  );

drop policy if exists payout_settings_insert_own
  on public.consultant_payout_settings;
create policy payout_settings_insert_own
  on public.consultant_payout_settings
  for insert to authenticated
  with check (consultant_id = public.my_consultant_id());

drop policy if exists payout_settings_update_own
  on public.consultant_payout_settings;
create policy payout_settings_update_own
  on public.consultant_payout_settings
  for update to authenticated
  using (consultant_id = public.my_consultant_id())
  with check (consultant_id = public.my_consultant_id());

/*
 * Supabase's default privileges grant everything on a new public
 * table to anon and authenticated, so what a finance table may do
 * has to be stated rather than assumed. anon loses the table
 * outright — it holds no privilege, so an anonymous key cannot
 * reach it even to be filtered by a policy.
 */
revoke all on public.consultant_payout_settings from anon;
revoke all on public.consultant_payout_settings from authenticated;

grant select, insert, update
  on public.consultant_payout_settings to authenticated;


-- ============================================================
-- E. The destination formatter
-- ============================================================
--
-- One place where the shape of a snapshot is decided, so the RPC
-- and anything that later needs to render or re-derive one cannot
-- disagree about it. Same reasoning as migration 037's
-- build_finance_reference().
--
-- The format is deliberately human-first: an admin reads it,
-- opens PayPal or Wise, and pays. It is a display string and
-- nothing parses it back apart, which is why the service name is
-- spelled the way the service spells itself.
--
--   PayPal | consultant@example.com
--   Wise | consultant@example.com
--
-- Returns NULL for anything that is not a complete, known
-- destination, which is what makes "is this consultant payable"
-- a single expression rather than a chain of checks.

create or replace function public.build_payout_destination_note(
  p_method text,
  p_email text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
           when btrim(coalesce(p_email, '')) = '' then null
           when lower(btrim(coalesce(p_method, ''))) = 'paypal'
             then 'PayPal | ' || btrim(p_email)
           when lower(btrim(coalesce(p_method, ''))) = 'wise'
             then 'Wise | ' || btrim(p_email)
           else null
         end;
$$;

comment on function public.build_payout_destination_note(
  text, text) is
  'Migration 039. Formats a manual payout destination as '
  '"PayPal | email" or "Wise | email". Returns null for an unknown '
  'method or a blank address, so a single null test answers '
  '"is this consultant payable". Display only; nothing parses it '
  'back apart.';

revoke all on function public.build_payout_destination_note(
  text, text) from public, anon, authenticated;
grant execute on function public.build_payout_destination_note(
  text, text) to service_role;


-- ============================================================
-- F. request_consultant_payout, replaced
-- ============================================================
--
-- Unchanged from migration 037: the currency check, the consultant
-- check, the one-open-request-per-currency rule, the FOR UPDATE
-- scan that reserves every unallocated available entry, the
-- server-side sum, the non-positive balance refusal, the
-- allocation insert and the returned row.
--
-- Changed: the destination. p_destination_note is gone from the
-- signature and the note is built from the consultant's saved
-- setting, which must exist. A consultant with no payout method
-- is refused with FINANCE_PAYOUT_METHOD_MISSING before any row is
-- locked, so a misconfigured account cannot half-create a
-- reservation.
--
-- The check sits immediately after "does this consultant exist",
-- ahead of the balance work, because it answers the first
-- question a payout has to answer: where is this money going.

drop function if exists public.request_consultant_payout(
  uuid, text, text);

create or replace function public.request_consultant_payout(
  p_consultant_id uuid,
  p_currency text
)
returns table (
  payout_id uuid,
  payout_reference text,
  status text,
  currency text,
  requested_amount_minor integer,
  entry_count integer,
  requested_at timestamptz,
  destination_note text
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
  v_settings public.consultant_payout_settings%rowtype;
  v_note text;
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

  /*
   * Where the money goes.
   *
   * Read as the definer, so the consultant's own RLS is not in
   * play and the answer is the same whoever triggered the
   * request. A missing row and a row with an incomplete setting
   * are the same failure and get the same marker: from the
   * consultant's point of view both mean "finish your payout
   * method", and splitting them would only give the UI two
   * messages to keep in step.
   */
  select * into v_settings
    from public.consultant_payout_settings
   where consultant_id = p_consultant_id;

  v_note := public.build_payout_destination_note(
    v_settings.payout_method,
    v_settings.payout_email
  );

  if v_note is null then
    raise exception
      'FINANCE_PAYOUT_METHOD_MISSING: consultant % has no complete payout method configured',
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

  /*
   * The snapshot. v_note is a value copied onto this row now; the
   * settings row is never consulted again for this payout, so the
   * consultant may change their address a minute later and this
   * payout still records where the money was actually sent.
   */
  insert into public.payouts (
    consultant_id, status, currency, requested_amount_minor,
    destination_note
  )
  values (
    p_consultant_id, 'requested', v_currency, v_total, v_note
  )
  returning * into v_payout;

  insert into public.payout_allocations (payout_id, ledger_entry_id)
  select v_payout.id, unnest(v_ids);

  return query
  select v_payout.id, v_payout.payout_reference, v_payout.status,
         v_payout.currency, v_payout.requested_amount_minor,
         v_count, v_payout.requested_at, v_payout.destination_note;
end;
$$;

comment on function public.request_consultant_payout(uuid, text) is
  'Migration 039 (was migration 035, 037). Reserves every '
  'unallocated available earning in one currency and opens a '
  'payout request for their sum. Takes no amount and no '
  'destination: the amount is summed from the ledger and the '
  'destination is built from the consultant''s saved payout '
  'setting, so neither can be supplied or forged by a caller. '
  'Refuses with FINANCE_PAYOUT_METHOD_MISSING when no complete '
  'payout method is configured. The destination is SNAPSHOTTED '
  'onto payouts.destination_note and never read back from the '
  'setting, so changing the setting later cannot rewrite payout '
  'history.';


-- ============================================================
-- G. Privileges on the replaced function
-- ============================================================
--
-- Mandatory, not decorative. A dropped and recreated function
-- loses its ACL, and Supabase's default privileges hand EXECUTE
-- straight back to anon and authenticated — which for this
-- function would mean an anonymous key could open a payout
-- request for any consultant id it guessed. Migration 037's part
-- G exists for the same reason.

revoke all on function public.request_consultant_payout(uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_consultant_payout(uuid, text)
  to service_role;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_039_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 21
--
--  2. select count(*) from pg_policies
--      where schemaname = 'public'
--        and tablename = 'consultant_payout_settings';
--       -> 3  (select, insert, update)
--
--  3. select has_table_privilege(
--       'anon', 'public.consultant_payout_settings', 'SELECT');
--       -> false
--
--  4. select to_regprocedure(
--       'public.request_consultant_payout(uuid, text, text)');
--       -> null   (the old three-argument form is gone)
--
--  5. select public.build_payout_destination_note(
--       'paypal', 'consultant@example.com');
--       -> PayPal | consultant@example.com
