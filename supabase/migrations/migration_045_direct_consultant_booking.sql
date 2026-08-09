-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 045: Direct consultant booking
-- ============================================================
--
-- Classification:
-- - Phase 3. Three columns on consultants, one on consultations,
--   three finance RPCs, and one replaced draft RPC. No new table.
--   No change to commission rules for standard consultations, to
--   service purchase finance, or to any existing policy or grant.
--   record_consultation_earning is replaced verbatim apart from
--   one guard; see part G.
--
-- What this enables:
-- - A consultant publishes a personal booking page at a root URL
--   and sets their own price. A booking through it is still an
--   ordinary consultation — same table, same statuses, same
--   payment flow, same double-booking protection — distinguished
--   only by consultations.booking_source.
--
-- What this migration does:
--   A. consultants.consultant_slug / direct_booking_enabled /
--      direct_booking_price_cents, with their constraints.
--   B. consultations.booking_source, defaulting to 'standard'.
--   C. create_draft_consultation, replaced to carry the source.
--   D. record_direct_booking_earning()
--   E. release_direct_booking_earning()
--   F. reverse_direct_booking_earning()   CUMULATIVE
--   G. record_consultation_earning, guarded so a direct
--      booking cannot also earn through the standard path.
--   H. Privileges.
--
-- NO SECOND BOOKING SYSTEM. There is no direct_consultations
-- table and no parallel payment record. A direct booking is a
-- consultation with a different source and a different price, and
-- everything downstream — checkout, capture, completion, refund,
-- admin cancel, the 48-hour timeout — continues to treat it as
-- one.
--
-- THE TWO-COMPONENT SPLIT, and why it is two rows:
-- - The locked rule is that the standard-price portion of a direct
--   booking splits 50/50 as any consultation does, and only the
--   PREMIUM above it splits 80/20 in the consultant's favour.
-- - Migration 034 anticipated this: source_component already
--   admits 'standard' and 'premium', ledger_component_scope_check
--   already permits them for direct_booking alone, and
--   ledger_basis_alignment_check already names the two direct
--   booking bases. Its own comment says a direct booking is "two
--   rows, each with its own flat rate, so every row satisfies one
--   simple statement rather than needing a nested breakdown".
--   This migration is the first thing to use any of it.
--
-- SLUG AUTHORITY IS SPLIT, DELIBERATELY:
-- - The database owns FORMAT and UNIQUENESS, because those are
--   properties of the value and belong where the value lives.
-- - The orchestrator owns the RESERVED set, because that list is a
--   fact about the frontend's routing table — it changes when a
--   route is added, not when the schema changes, and encoding it
--   here would guarantee the two drift apart. There is no
--   reserved_slugs table for the same reason.
--
-- Rerun safety:
-- - Idempotent. Columns use ADD COLUMN IF NOT EXISTS, constraints
--   and indexes are dropped before being added, functions are
--   CREATE OR REPLACE at fixed signatures, the replaced draft RPC
--   drops its old signature by name, and REVOKE/GRANT are
--   declarative.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.consultants') is null
     or to_regclass('public.consultations') is null
     or to_regclass('public.consultant_ledger_entries') is null then
    raise exception
      'migration 045: core tables not found - migrations 001 and 034 must be applied first';
  end if;

  if to_regprocedure(
       'public.reverse_ledger_entry(uuid, text, integer)'
     ) is null then
    raise exception
      'migration 045: reverse_ledger_entry not found - migration 035 must be applied first';
  end if;

  /*
   * Either signature is acceptable: the 12-argument one migration
   * 005 leaves behind, or the 13-argument one this migration
   * replaces it with. Demanding only the former would make this
   * migration refuse to run a second time against a database it
   * had already migrated, which is exactly the case rerun safety
   * exists to cover.
   */
  if to_regprocedure(
       'public.create_draft_consultation(uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text, text, text, text, jsonb)'
     ) is null
     and to_regprocedure(
       'public.create_draft_consultation(uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text, text, text, text, jsonb, text)'
     ) is null then
    raise exception
      'migration 045: create_draft_consultation not found at any known signature - migration 005 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'app_settings'
       and column_name = 'consultation_consultant_commission_bps'
  ) then
    raise exception
      'migration 045: app_settings.consultation_consultant_commission_bps not found - migration 034 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. consultants: the booking page
-- ============================================================

alter table public.consultants
  add column if not exists consultant_slug text;

alter table public.consultants
  add column if not exists direct_booking_enabled boolean
    not null default false;

alter table public.consultants
  add column if not exists direct_booking_price_cents integer;

/*
 * Format. Lowercase, URL-safe, 3 to 60 characters, no leading or
 * trailing hyphen and no doubled hyphen — so a normalised slug is
 * the only shape that can be stored, and the value in the column
 * is always exactly what appears in the URL.
 *
 * The RESERVED set is not here. It is a fact about the frontend's
 * routing table and lives in the orchestrator; see the header.
 */
alter table public.consultants
  drop constraint if exists consultants_slug_format_check;
alter table public.consultants
  add constraint consultants_slug_format_check
  check (
    consultant_slug is null
    or consultant_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );

alter table public.consultants
  drop constraint if exists consultants_slug_length_check;
alter table public.consultants
  add constraint consultants_slug_length_check
  check (
    consultant_slug is null
    or length(consultant_slug) between 3 and 60
  );

/*
 * A sensible bound on the configured price. The floor is the same
 * order as a real consultation, not zero: a direct booking priced
 * at nothing would produce a zero-gross earning that
 * ledger_sign_check would reject anyway, so refusing it here says
 * so honestly rather than failing later inside a webhook.
 *
 * The ceiling is 1,000,000 minor units. Far above any plausible
 * consultation and far below the integer column's limit, so a
 * mistyped price is caught at save time.
 *
 * NOTE that this is not the "at least the platform default" rule.
 * That rule is checked by the orchestrator AT SAVE TIME against
 * the current default, and it deliberately is NOT a constraint:
 * the platform default may later rise above a stored price, and a
 * constraint would then make an untouched row invalid and block
 * every unrelated update to it. The effective price rule in part D
 * is what keeps that safe.
 */
alter table public.consultants
  drop constraint if exists consultants_direct_price_range_check;
alter table public.consultants
  add constraint consultants_direct_price_range_check
  check (
    direct_booking_price_cents is null
    or direct_booking_price_cents between 100 and 1000000
  );

/*
 * Publishing requires both a slug and a price. A page cannot be
 * live without a URL to live at or a price to charge, and making
 * that a constraint means the invalid combination cannot exist
 * even briefly.
 */
alter table public.consultants
  drop constraint if exists consultants_direct_booking_ready_check;
alter table public.consultants
  add constraint consultants_direct_booking_ready_check
  check (
    direct_booking_enabled = false
    or (consultant_slug is not null
        and direct_booking_price_cents is not null)
  );

/*
 * Uniqueness, on non-null values only, so any number of
 * consultants may have no slug while a published one is
 * unambiguous.
 */
create unique index if not exists uq_consultants_slug
  on public.consultants (consultant_slug)
  where consultant_slug is not null;

comment on column public.consultants.consultant_slug is
  'Migration 045. The consultant''s personal booking page path, at '
  'the application root. Lowercase, URL-safe, 3-60 characters, '
  'unique when set. The database owns format and uniqueness; the '
  'RESERVED set is a fact about the frontend routing table and is '
  'enforced by the orchestrator, which is why there is no '
  'reserved_slugs table.';

comment on column public.consultants.direct_booking_enabled is
  'Migration 045. Whether the booking page is live. Requires a '
  'slug and a price by constraint, so it cannot be true without '
  'somewhere to live and something to charge.';

comment on column public.consultants.direct_booking_price_cents is
  'Migration 045. The consultant''s own price, in minor units. The '
  'price actually charged is max(this, '
  'app_settings.consultation_price_cents) computed at read and at '
  'draft time - see the effective price rule - so a later rise in '
  'the platform default never leaves a stale lower price on the '
  'page. Deliberately NOT constrained against the platform '
  'default: that would make an untouched row invalid the moment '
  'the default rose.';


-- ============================================================
-- B. consultations: where the booking came from
-- ============================================================
--
-- NOT NULL DEFAULT 'standard', so every existing consultation
-- backfills to 'standard' in the same statement that adds the
-- column, and nothing has to be repaired afterwards.

alter table public.consultations
  add column if not exists booking_source text
    not null default 'standard';

alter table public.consultations
  drop constraint if exists consultations_booking_source_check;
alter table public.consultations
  add constraint consultations_booking_source_check
  check (booking_source in ('standard', 'direct_booking'));

comment on column public.consultations.booking_source is
  'Migration 045. ''standard'' for the generic booking flow, '
  '''direct_booking'' for a consultant''s own page. Set by '
  'create_draft_consultation from a server-resolved slug and never '
  'from a request body. Decides which earning RPC the capture and '
  'completion paths call; everything else about the consultation '
  'is identical.';

create index if not exists idx_consultations_booking_source
  on public.consultations (booking_source)
  where booking_source = 'direct_booking';


-- ============================================================
-- C. create_draft_consultation, carrying the source
-- ============================================================
--
-- The old twelve-argument signature is dropped rather than
-- overloaded: two functions of the same name differing only by a
-- defaulted trailing argument is a call that resolves by luck.
--
-- p_booking_source defaults to 'standard', so the generic booking
-- path is byte-for-byte unchanged in behaviour and its caller need
-- not pass anything new.
--
-- The price still arrives as an argument, exactly as before. The
-- orchestrator resolves it — from app_settings for a standard
-- booking, from the effective price rule for a direct one — and
-- the client never submits it. That has been true since migration
-- 025 and is not relaxed here.

drop function if exists public.create_draft_consultation(
  uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text,
  text, text, text, jsonb);

create or replace function public.create_draft_consultation(
  p_client_profile_id uuid,
  p_consultant_id uuid,
  p_country_id uuid,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at timestamptz,
  p_client_timezone text,
  p_price_cents integer,
  p_currency text,
  p_full_name text,
  p_email text,
  p_phone_whatsapp text,
  p_answers_jsonb jsonb,
  p_booking_source text default 'standard'
)
returns table (
  consultation_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consultation_id uuid;
  v_created_at timestamptz;
  v_source text := coalesce(
    nullif(btrim(lower(p_booking_source)), ''), 'standard');
begin
  if v_source not in ('standard', 'direct_booking') then
    raise exception
      'BOOKING_SOURCE_INVALID: % is not a supported booking source',
      p_booking_source;
  end if;

  /*
   * The overlap guard, unchanged from migration 005. A direct
   * booking competes for the same slots as a generic one, so it
   * runs through exactly the same protection rather than a
   * parallel one.
   */
  if exists (
    select 1
      from public.consultations c
     where c.consultant_id = p_consultant_id
       and c.status not in (
         'cancelled', 'declined', 'authorization_cancelled')
       and c.scheduled_start_at < p_scheduled_end_at
       and c.scheduled_end_at > p_scheduled_start_at
  ) then
    raise exception
      'SLOT_TAKEN: consultant % already has a consultation overlapping % to %',
      p_consultant_id, p_scheduled_start_at, p_scheduled_end_at;
  end if;

  insert into public.consultations (
    client_profile_id,
    consultant_id,
    country_id,
    status,
    scheduled_start_at,
    scheduled_end_at,
    client_timezone,
    price_cents,
    currency,
    booking_source
  )
  values (
    p_client_profile_id,
    p_consultant_id,
    p_country_id,
    'draft',
    p_scheduled_start_at,
    p_scheduled_end_at,
    p_client_timezone,
    p_price_cents,
    p_currency,
    v_source
  )
  returning id, consultations.created_at
  into v_consultation_id, v_created_at;

  insert into public.consultation_intake (
    consultation_id, full_name, email, phone_whatsapp,
    answers_jsonb
  )
  values (
    v_consultation_id, p_full_name, p_email, p_phone_whatsapp,
    coalesce(p_answers_jsonb, '{}'::jsonb)
  );

  return query
  select v_consultation_id, v_created_at;
end;
$$;

comment on function public.create_draft_consultation(
  uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text,
  text, text, text, jsonb, text) is
  'Migration 045 (was migration 005). Unchanged except that it now '
  'records booking_source, defaulting to ''standard'' so the '
  'generic flow is unaffected. The consultant, the price and the '
  'source are all resolved by the orchestrator - for a direct '
  'booking from the slug, never from a request body.';


-- ============================================================
-- D. record_direct_booking_earning
-- ============================================================
--
-- THE EFFECTIVE PRICE RULE, and why it is not the stored price:
--
--   effective = max(consultant price, platform default)
--
-- A consultant sets 20000 while the default is 15000. Months
-- later the platform raises its default to 25000. The consultant's
-- stored 20000 is now BELOW the platform's own price. Charging it
-- would undercut the platform; refusing the row would break an
-- untouched consultant's page.
--
-- The rule resolves it in one expression, applied identically at
-- three places — the public page, draft creation, and here — so
-- what is displayed, what is charged and what is split can never
-- diverge. This function never re-derives the price from the
-- consultant's settings: it uses consultations.price_cents, the
-- amount actually charged, which is what makes the ledger agree
-- with Stripe.
--
-- THE SPLIT, in two rows:
--
--   standard component  gross = min(price, platform default)
--                       consultant at the standard consultation
--                       rate from app_settings (5000 bps today)
--
--   premium component   gross = price - standard gross
--                       consultant at 8000 bps
--                       written ONLY when that gross is positive
--
-- least() rather than a bare subtraction is what handles the
-- inverted case above: if the default has risen past the price,
-- the standard component takes the whole amount and there is no
-- premium row at all, rather than a negative one.
--
-- Rounding follows the ledger's existing rule exactly: the
-- consultant's share is round(gross * bps / 10000) through
-- numeric, and the platform takes the remainder by SUBTRACTION.
-- Both sides are never rounded independently, so
-- consultant + platform = gross holds on every row and
-- ledger_amount_identity_check cannot fail.

create or replace function public.record_direct_booking_earning(
  p_consultation_id uuid
)
returns table (
  consultation_id uuid,
  created boolean,
  standard_entry_id uuid,
  standard_gross_minor integer,
  standard_consultant_minor integer,
  standard_platform_minor integer,
  premium_entry_id uuid,
  premium_gross_minor integer,
  premium_consultant_minor integer,
  premium_platform_minor integer,
  currency text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  /*
   * The locked premium rate. 80/20 in the consultant's favour on
   * everything above the platform's own price - the incentive
   * that makes a direct booking worth publishing.
   */
  c_premium_bps constant integer := 8000;

  v_consultation public.consultations%rowtype;
  v_standard public.consultant_ledger_entries%rowtype;
  v_premium public.consultant_ledger_entries%rowtype;
  v_base integer;
  v_standard_bps integer;
  v_standard_gross integer;
  v_premium_gross integer;
  v_standard_consultant integer;
  v_standard_platform integer;
  v_premium_consultant integer;
  v_premium_platform integer;
  v_created boolean := false;
  v_currency text;
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

  if v_consultation.booking_source <> 'direct_booking' then
    raise exception
      'FINANCE_NOT_DIRECT_BOOKING: consultation % is a % booking',
      p_consultation_id, v_consultation.booking_source;
  end if;

  v_currency := lower(v_consultation.currency);

  /*
   * Read back first, so a repeat call on an already-credited
   * consultation is a no-op even if the consultation has since
   * been refunded. Same order as record_consultation_earning.
   */
  select * into v_standard
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'direct_booking'
     and source_id = p_consultation_id
     and source_component = 'standard';

  select * into v_premium
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'direct_booking'
     and source_id = p_consultation_id
     and source_component = 'premium';

  if v_standard.id is not null then
    return query
    select p_consultation_id, false,
           v_standard.id, v_standard.gross_amount_minor,
           v_standard.consultant_amount_minor,
           v_standard.platform_amount_minor,
           v_premium.id, v_premium.gross_amount_minor,
           v_premium.consultant_amount_minor,
           v_premium.platform_amount_minor,
           v_standard.currency;
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

  select consultation_price_cents,
         consultation_consultant_commission_bps
    into v_base, v_standard_bps
    from public.app_settings
   limit 1;

  if v_base is null or v_standard_bps is null then
    raise exception
      'FINANCE_SETTINGS_MISSING: app_settings carries no consultation price or commission rate';
  end if;

  /* least() is what makes an inverted default safe. */
  v_standard_gross := least(v_consultation.price_cents, v_base);
  v_premium_gross := v_consultation.price_cents - v_standard_gross;

  v_standard_consultant := round(
    v_standard_gross::numeric * v_standard_bps / 10000
  )::integer;
  v_standard_platform :=
    v_standard_gross - v_standard_consultant;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    source_component, gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at
  )
  values (
    v_consultation.consultant_id, 'earning', 'direct_booking',
    p_consultation_id, 'standard', v_standard_gross,
    v_standard_consultant, v_standard_platform, v_standard_bps,
    'direct_booking_standard', v_currency, null
  )
  on conflict do nothing
  returning * into v_standard;

  if v_standard.id is null then
    /* Lost race: another transaction wrote it first. Read theirs. */
    select * into v_standard
      from public.consultant_ledger_entries
     where entry_type = 'earning'
       and source_type = 'direct_booking'
       and source_id = p_consultation_id
       and source_component = 'standard';
  else
    v_created := true;
  end if;

  /*
   * The premium row exists only when there is a premium. A
   * zero-gross earning is refused by ledger_sign_check anyway, and
   * it would record no financial fact - a direct booking priced at
   * exactly the platform default is simply a standard split.
   */
  if v_premium_gross > 0 then
    v_premium_consultant := round(
      v_premium_gross::numeric * c_premium_bps / 10000
    )::integer;
    v_premium_platform :=
      v_premium_gross - v_premium_consultant;

    insert into public.consultant_ledger_entries (
      consultant_id, entry_type, source_type, source_id,
      source_component, gross_amount_minor,
      consultant_amount_minor, platform_amount_minor,
      commission_bps, commission_basis, currency, available_at
    )
    values (
      v_consultation.consultant_id, 'earning', 'direct_booking',
      p_consultation_id, 'premium', v_premium_gross,
      v_premium_consultant, v_premium_platform, c_premium_bps,
      'direct_booking_premium', v_currency, null
    )
    on conflict do nothing
    returning * into v_premium;

    if v_premium.id is null then
      select * into v_premium
        from public.consultant_ledger_entries
       where entry_type = 'earning'
         and source_type = 'direct_booking'
         and source_id = p_consultation_id
         and source_component = 'premium';
    end if;
  end if;

  return query
  select p_consultation_id, v_created,
         v_standard.id, v_standard.gross_amount_minor,
         v_standard.consultant_amount_minor,
         v_standard.platform_amount_minor,
         v_premium.id, v_premium.gross_amount_minor,
         v_premium.consultant_amount_minor,
         v_premium.platform_amount_minor,
         v_standard.currency;
end;
$$;

comment on function public.record_direct_booking_earning(uuid) is
  'Migration 045. Records the two-component earning for a captured '
  'direct booking: the standard-price portion at the platform''s '
  'consultation rate, and the premium above it at 8000 bps. The '
  'premium row is written only when the premium is positive, so a '
  'direct booking priced at the platform default is simply a '
  'standard split. Idempotent through '
  'uq_ledger_one_earning_per_source. Refuses a consultation that '
  'is not a direct booking or has no captured payment.';


-- ============================================================
-- E. release_direct_booking_earning
-- ============================================================
--
-- Both components together, always. They are two rows describing
-- one payment, and a state in which a consultant can withdraw
-- their standard share but not their premium share would be an
-- accident of implementation rather than a rule anybody chose.
--
-- Same preconditions as a standard consultation: captured AND
-- completed. Called from both sides of that race, so whichever
-- happens second does the release and the first is a no-op.

create or replace function public.release_direct_booking_earning(
  p_consultation_id uuid
)
returns table (
  consultation_id uuid,
  released boolean,
  reason text,
  released_count integer,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consultation public.consultations%rowtype;
  v_now timestamptz := now();
  v_released integer := 0;
  v_pending integer;
  v_total integer;
begin
  select * into v_consultation
    from public.consultations
   where id = p_consultation_id
   for update;

  if not found then
    raise exception
      'FINANCE_CONSULTATION_NOT_FOUND: consultation % does not exist',
      p_consultation_id;
  end if;

  if v_consultation.booking_source <> 'direct_booking' then
    raise exception
      'FINANCE_NOT_DIRECT_BOOKING: consultation % is a % booking',
      p_consultation_id, v_consultation.booking_source;
  end if;

  select count(*) into v_total
    from public.consultant_ledger_entries e
   where e.entry_type = 'earning'
     and e.source_type = 'direct_booking'
     and e.source_id = p_consultation_id;

  if v_total = 0 then
    return query
    select p_consultation_id, false, 'no_entry'::text, 0,
           null::timestamptz;
    return;
  end if;

  if v_consultation.captured_at is null then
    return query
    select p_consultation_id, false, 'not_captured'::text, 0,
           null::timestamptz;
    return;
  end if;

  if v_consultation.completed_at is null then
    return query
    select p_consultation_id, false, 'not_completed'::text, 0,
           null::timestamptz;
    return;
  end if;

  /*
   * Aliased throughout. `available_at` is an OUT parameter of this
   * function as well as a column, and an unqualified reference is
   * ambiguous — plpgsql resolves it to the variable and the query
   * fails to compile.
   */
  select count(*) into v_pending
    from public.consultant_ledger_entries e
   where e.entry_type = 'earning'
     and e.source_type = 'direct_booking'
     and e.source_id = p_consultation_id
     and e.available_at is null;

  if v_pending = 0 then
    return query
    select p_consultation_id, false, 'already_available'::text, 0,
           (select max(e.available_at)
              from public.consultant_ledger_entries e
             where e.entry_type = 'earning'
               and e.source_type = 'direct_booking'
               and e.source_id = p_consultation_id);
    return;
  end if;

  /*
   * The one mutation trg_ledger_append_only permits: available_at
   * advancing once from null. Both components take the same
   * timestamp, so they are indistinguishable in the balance view.
   */
  update public.consultant_ledger_entries e
     set available_at = v_now
   where e.entry_type = 'earning'
     and e.source_type = 'direct_booking'
     and e.source_id = p_consultation_id
     and e.available_at is null;

  get diagnostics v_released = row_count;

  return query
  select p_consultation_id, true, 'released'::text, v_released,
         v_now;
end;
$$;

comment on function public.release_direct_booking_earning(uuid) is
  'Migration 045. Releases every direct booking earning component '
  'for a consultation once it is both captured and completed - '
  'standard and premium together, never one without the other. '
  'Idempotent: a second call reports already_available and changes '
  'nothing. Called from both the capture and the completion paths, '
  'so whichever runs second does the release.';


-- ============================================================
-- F. reverse_direct_booking_earning
-- ============================================================
--
-- CUMULATIVE, in the sense migration 043 established:
-- p_refunded_total_minor is what Stripe says has been refunded in
-- TOTAL against this consultation, not the amount of one refund.
--
-- Migration 040 got this wrong for service purchases by treating
-- the figure as a delta, and the cost was real: a second partial
-- refund over-reversed a consultant's ledger by the first refund's
-- amount. That mistake is not repeated here. The delta is computed
-- inside, per component, against what has already been reversed.
--
-- SPLITTING A CUMULATIVE TARGET ACROSS TWO COMPONENTS:
--
--   standard_target = round(total * standard_gross / total_gross)
--   premium_target  = total - standard_target
--
-- The premium target is the REMAINDER, never a second rounding.
-- That is what guarantees the property that matters:
--
--   standard_target + premium_target = refunded_total, exactly
--
-- Rounding both independently could leave the two targets summing
-- to one minor unit more or less than the customer was actually
-- refunded, and that unit would come from or go to a consultant
-- who had nothing to do with it.
--
-- Each component is then compared against its OWN prior
-- reversals, so a redelivered event applies nothing, a second
-- partial applies only its difference, and partial-then-full
-- completes exactly.

create or replace function public.reverse_direct_booking_earning(
  p_consultation_id uuid,
  p_reason text default 'Stripe refund processed by webhook',
  p_refunded_total_minor integer default null
)
returns table (
  consultation_id uuid,
  reversed boolean,
  reason text,
  refunded_total_minor integer,
  standard_delta_minor integer,
  premium_delta_minor integer,
  applied_delta_minor integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consultation public.consultations%rowtype;
  v_standard public.consultant_ledger_entries%rowtype;
  v_premium public.consultant_ledger_entries%rowtype;
  v_total_gross integer;
  v_target integer;
  v_standard_target integer;
  v_premium_target integer;
  v_standard_done integer;
  v_premium_done integer;
  v_standard_delta integer := 0;
  v_premium_delta integer := 0;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception
      'FINANCE_REASON_REQUIRED: a reversal must state a reason';
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
   * The same guard record and release carry. It is what makes the
   * orchestrator's dispatch a single rule - try the direct RPC,
   * fall back to the standard one on FINANCE_NOT_DIRECT_BOOKING -
   * rather than three rules that could disagree. Without it this
   * function would answer 'no_entry' for a standard consultation,
   * which is indistinguishable from a direct booking refunded
   * before capture.
   */
  if v_consultation.booking_source <> 'direct_booking' then
    raise exception
      'FINANCE_NOT_DIRECT_BOOKING: consultation % is a % booking',
      p_consultation_id, v_consultation.booking_source;
  end if;

  select * into v_standard
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'direct_booking'
     and source_id = p_consultation_id
     and source_component = 'standard';

  select * into v_premium
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'direct_booking'
     and source_id = p_consultation_id
     and source_component = 'premium';

  /*
   * Nothing earned. An ordinary outcome, not a failure: a refund
   * before capture, or a consultation that never produced an
   * earning. Raising would make the webhook return non-2xx and
   * Stripe would redeliver.
   */
  if v_standard.id is null then
    return query
    select p_consultation_id, false, 'no_entry'::text,
           null::integer, 0, 0, 0;
    return;
  end if;

  v_total_gross :=
    v_standard.gross_amount_minor
    + coalesce(v_premium.gross_amount_minor, 0);

  v_target := coalesce(p_refunded_total_minor, v_total_gross);

  if v_target < 0 then
    raise exception
      'FINANCE_REVERSAL_AMOUNT_INVALID: a refunded total may not be negative';
  end if;

  if v_target > v_total_gross then
    raise exception
      'FINANCE_REFUND_EXCEEDS_CONSULTATION: a refunded total of % exceeds the % earned on consultation %',
      v_target, v_total_gross, p_consultation_id;
  end if;

  /* The split. The premium takes the remainder, never a second
     rounding, so the two targets sum to the total exactly. */
  v_standard_target := round(
    v_target::numeric * v_standard.gross_amount_minor
      / v_total_gross
  )::integer;

  v_premium_target := v_target - v_standard_target;

  /* What each component has already had reversed. */
  select coalesce(sum(-r.gross_amount_minor), 0)
    into v_standard_done
    from public.consultant_ledger_entries r
   where r.entry_type = 'reversal'
     and r.reverses_entry_id = v_standard.id;

  v_premium_done := 0;

  if v_premium.id is not null then
    select coalesce(sum(-r.gross_amount_minor), 0)
      into v_premium_done
      from public.consultant_ledger_entries r
     where r.entry_type = 'reversal'
       and r.reverses_entry_id = v_premium.id;
  end if;

  v_standard_delta := v_standard_target - v_standard_done;
  v_premium_delta := v_premium_target - v_premium_done;

  /*
   * A delta of zero or less means this total has already been
   * applied, or an older total arrived late. Either way nothing
   * happens to that component. Both at zero is the idempotent
   * no-op that makes a redelivered webhook safe.
   */
  if v_standard_delta <= 0 and v_premium_delta <= 0 then
    return query
    select p_consultation_id, false,
           case
             when v_standard_done + v_premium_done >= v_total_gross
               then 'already_refunded'::text
             else 'no_change'::text
           end,
           v_target, 0, 0, 0;
    return;
  end if;

  if v_standard_delta > 0 then
    perform public.reverse_ledger_entry(
      v_standard.id, p_reason, v_standard_delta);
  else
    v_standard_delta := 0;
  end if;

  if v_premium_delta > 0 and v_premium.id is not null then
    perform public.reverse_ledger_entry(
      v_premium.id, p_reason, v_premium_delta);
  else
    v_premium_delta := 0;
  end if;

  return query
  select p_consultation_id, true, 'reversed'::text, v_target,
         v_standard_delta, v_premium_delta,
         v_standard_delta + v_premium_delta;
end;
$$;

comment on function public.reverse_direct_booking_earning(
  uuid, text, integer) is
  'Migration 045. Applies a CUMULATIVE refund total to a direct '
  'booking, splitting it across the standard and premium '
  'components in proportion to their gross - the premium takes the '
  'remainder rather than a second rounding, so the component '
  'reversals sum to the refund exactly. Each component is compared '
  'against its own prior reversals, so a redelivered event applies '
  'nothing, a second partial applies only its difference, and '
  'partial-then-full completes. Migration 043 semantics; the delta '
  'interpretation that over-reversed consultant ledgers is not '
  'repeated here.';


-- ============================================================
-- G. record_consultation_earning, guarded
-- ============================================================
--
-- Verbatim from migration 035 apart from ONE added guard. The
-- arithmetic, the ordering, the lost-race handling and the
-- returned shape are untouched, and a standard consultation
-- behaves exactly as it did before this migration.
--
-- WHY THE GUARD EXISTS, and why it is not optional:
--
-- Before this migration every consultation was a standard one, so
-- this function could take any consultation id and be right. Now
-- it cannot. Handed a direct booking it would cheerfully write a
-- 'consultation' earning at a flat 50/50 across the WHOLE price -
-- the consultant would lose the premium they published the page
-- for - and the ledger's unique index would not stop it, because
-- that index is per source_type and the direct booking's two
-- 'direct_booking' rows occupy different keys entirely. The result
-- is two earnings for one payment.
--
-- That is precisely the "parallel payment record" this feature is
-- not allowed to create, and the cost of preventing it is six
-- lines. The guard is defence in depth: the orchestrator already
-- dispatches on booking_source, and this makes the wrong call
-- impossible rather than merely unmade.
--
-- The reverse and release siblings need no such guard. Both look
-- up an existing 'consultation' earning and find none for a direct
-- booking, so both are already no-ops. Only this function WRITES.

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

  /* ---- migration 045: the only addition ---- */
  if v_consultation.booking_source <> 'standard' then
    raise exception
      'FINANCE_NOT_STANDARD_BOOKING: consultation % is a % booking and earns through its own path',
      p_consultation_id, v_consultation.booking_source;
  end if;
  /* ---- end addition ---- */

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

comment on function public.record_consultation_earning(uuid) is
  'Migration 035, guarded by migration 045. Records the 50/50 '
  'earning for a captured STANDARD consultation. A direct booking '
  'is refused with FINANCE_NOT_STANDARD_BOOKING: it earns two '
  'components through record_direct_booking_earning, and recording '
  'it here as well would be two earnings for one payment.';


-- ============================================================
-- H. Privileges
-- ============================================================
--
-- Migration 036's rule. These are orchestrator-only RPCs behind
-- HTTP endpoints that do the authorisation, and create_draft_
-- consultation was dropped and recreated, so it lost its ACL and
-- Supabase's default privileges would hand EXECUTE straight back
-- to anon and authenticated.

do $$
declare
  v_fn regprocedure;
  v_names text[] := array[
    'create_draft_consultation',
    'record_direct_booking_earning',
    'release_direct_booking_earning',
    'reverse_direct_booking_earning'
  ];
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_fn
    );

    execute format(
      'grant execute on function %s to service_role', v_fn
    );
  end loop;
end;
$$;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_045_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from information_schema.columns
--      where table_schema = 'public' and table_name = 'consultants'
--        and column_name in (
--          'consultant_slug', 'direct_booking_enabled',
--          'direct_booking_price_cents');
--       -> 3
--
--  2. select count(*) from public.consultations
--      where booking_source <> 'standard';
--       -> 0  (immediately after applying)
--
--  3. select has_function_privilege('anon',
--       'public.record_direct_booking_earning(uuid)', 'EXECUTE');
--       -> false
--
--  4. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 21  (unchanged; this migration adds no table)
