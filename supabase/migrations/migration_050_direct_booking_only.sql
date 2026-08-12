-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 050: Direct-booking-only consultants
-- ============================================================
--
-- Classification:
-- - Additive. One column, one guard extension, one policy narrowed
--   and one narrowly-scoped policy added. No new table, no new
--   status, no new function, and NOTHING in the finance path: no
--   ledger row, split, snapshot, payout or refund behaviour is
--   touched by this migration.
--
-- WHAT THIS ENABLES:
--
-- A consultant may say "I only want direct bookings". They then
-- disappear from the ordinary /consultation chooser while staying
-- fully bookable through their own direct link, at their own price,
-- under exactly the commission rules they had before.
--
-- WHY IT IS A NEW COLUMN AND NOT ONE OF THE THREE THAT ALREADY
-- LOOK LIKE IT:
-- - is_active is an ADMINISTRATIVE decision about whether the
--   consultant works here at all.
-- - available_for_general is about ONE of the two standard flows -
--   general-information consultations - and says nothing about
--   country-specific ones.
-- - direct_booking_enabled is about whether the consultant's own
--   page is live, which is an admin decision (Amendment 013).
-- None of them means "keep me out of the platform's own chooser",
-- and overloading any of them would make two different intents
-- share one switch.
--
-- WHY THE ENFORCEMENT IS AN RLS POLICY:
--
-- There is no orchestrator endpoint that lists consultants for
-- /consultation. That list is the frontend reading public.consultants
-- directly through consultants_select_active_public. A filter in
-- orchestrator code cannot remove a consultant from a list the
-- orchestrator does not produce, so the exclusion has to live where
-- the read actually happens.
--
-- Narrowing that one policy covers BOTH standard paths at once -
-- country-specific and general-information selection read the same
-- policy - and does so regardless of country assignment,
-- available_for_general, headline, bio or price.
--
-- The direct booking page is unaffected: loadPublicConsultantBySlug
-- runs as the service role and bypasses RLS entirely.
--
-- THE SECOND POLICY IS A RESTORATION, NOT A WIDENING:
-- Narrowing the public policy would also hide the consultant from a
-- CLIENT WHO HAS ALREADY BOOKED THEM, breaking the consultant's
-- name on that client's own dashboard. The second policy gives that
-- back and nothing else: it is scoped to direct_booking_only = true
-- and requires an existing consultation between the two parties, so
-- it restores exactly what the narrowing removed.
--
-- Rerun safety:
-- - Idempotent. ADD COLUMN IF NOT EXISTS, policies dropped before
--   being created, and the guard is CREATE OR REPLACE at a fixed
--   signature.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.consultants') is null then
    raise exception
      'migration 050: consultants not found - migration 001 must be applied first';
  end if;

  if to_regprocedure(
       'public.guard_consultants_columns()'
     ) is null then
    raise exception
      'migration 050: guard_consultants_columns not found - migrations 001 and 049 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'consultants'
       and column_name = 'direct_booking_enabled'
  ) then
    raise exception
      'migration 050: consultants.direct_booking_enabled not found - migration 045 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. The preference
-- ============================================================
--
-- Defaults to false, so every consultant who exists today keeps
-- exactly the eligibility they have today. Nothing is backfilled
-- and nothing changes until a consultant asks for it.
--
-- No constraint tying it to direct_booking_enabled. A consultant
-- may set this while their direct page is off - they are then
-- bookable nowhere, which is a state they chose and which the
-- frontend warns about. Refusing it here would mean a consultant
-- could be blocked from their own preference by a setting only an
-- administrator controls.

alter table public.consultants
  add column if not exists direct_booking_only boolean
    not null default false;

comment on column public.consultants.direct_booking_only is
  'Migration 050, Amendment 014. Consultant-managed. When true the '
  'consultant is excluded from the ordinary /consultation chooser - '
  'both country-specific and general-information selection - and '
  'remains bookable only through their own direct link. Deliberately '
  'distinct from is_active (admin: do they work here), '
  'available_for_general (which standard flow) and '
  'direct_booking_enabled (admin: is the direct page live). Written '
  'only through the orchestrator; see the guard below.';


-- ============================================================
-- B. Public visibility
-- ============================================================
--
-- The one read that /consultation actually performs.

drop policy if exists consultants_select_active_public
  on public.consultants;

create policy consultants_select_active_public
  on public.consultants
  for select
  to anon, authenticated
  using (
    is_active = true
    and direct_booking_only = false
  );

/*
 * And the restoration. Scoped to direct_booking_only = true and to
 * a client who already holds a consultation with this consultant,
 * so it returns exactly the visibility the narrowing above took
 * away and grants nothing that was not already granted.
 *
 * Without it, a client who booked a consultant before that
 * consultant went direct-only would stop being able to see whose
 * consultation it is.
 */
drop policy if exists consultants_select_booked_direct_only
  on public.consultants;

create policy consultants_select_booked_direct_only
  on public.consultants
  for select
  to authenticated
  using (
    is_active = true
    and direct_booking_only = true
    and exists (
      select 1
        from public.consultations c
       where c.consultant_id = consultants.id
         and c.client_profile_id = auth.uid()
    )
  );


-- ============================================================
-- C. guard_consultants_columns, extended
-- ============================================================
--
-- Migration 049's body with one addition at the end. Everything
-- before the marked block is unchanged.
--
-- direct_booking_only is CONSULTANT-managed, and it is guarded
-- anyway - for the same reason direct_booking_price_cents is, which
-- is also consultant-managed. The rules that govern it live in the
-- orchestrator, and a browser writing the column directly would
-- bypass them. It also keeps one rule for all four direct booking
-- columns rather than three guarded and one not, which is the kind
-- of distinction nobody remembers six months later.

create or replace function public.guard_consultants_columns()
returns trigger
language plpgsql
as $$
begin
  /*
   * Privileged writers (service_role and postgres) retain full
   * control over every column. That is what keeps the orchestrator
   * working: it holds the service role, and it is the only thing
   * that may write these columns.
   */
  if not public.is_privileged_writer() then
    /*
     * Activation remains an administrative decision. A consultant
     * may not activate or deactivate their own profile.
     */
    if new.is_active is distinct from old.is_active then
      raise exception
        'consultants.is_active may not be changed by clients';
    end if;

    /*
     * Row ownership may never be reassigned by a client, otherwise
     * a consultant could point their row at another profile.
     */
    if new.profile_id is distinct from old.profile_id then
      raise exception
        'consultants.profile_id may not be changed by clients';
    end if;

    /*
     * The onboarding marker is client-immutable in both
     * directions. A consultant who could clear it would reopen
     * their own gender, and a consultant who could set it would
     * lock gender while skipping the completeness rules that
     * setting it is supposed to represent.
     */
    if new.onboarding_completed_at
       is distinct from old.onboarding_completed_at then
      raise exception
        'CONSULTANT_ONBOARDING_MARKER_IMMUTABLE: consultants.onboarding_completed_at may not be changed by clients';
    end if;

    /*
     * Gender is chosen once, during onboarding, and never
     * changes afterwards. This covers changing it and clearing
     * it, because IS DISTINCT FROM treats null as a value.
     */
    if old.onboarding_completed_at is not null
       and new.gender is distinct from old.gender then
      raise exception
        'CONSULTANT_GENDER_IMMUTABLE: consultants.gender may not be changed after onboarding completion';
    end if;

    /* ---- migration 049 ---- */

    /*
     * THE BOOKING LINK. A consultant slug is a ROOT url in the
     * platform's own namespace, the reserved set that protects it
     * lives in the orchestrator, and the link is admin-managed.
     */
    if new.consultant_slug
       is distinct from old.consultant_slug then
      raise exception
        'CONSULTANT_SLUG_IMMUTABLE: consultants.consultant_slug may not be changed by clients';
    end if;

    /*
     * WHETHER THE PAGE IS LIVE. Publishing a page under the
     * platform's domain is an administrative decision, and the
     * preconditions for it are enforced in the orchestrator.
     */
    if new.direct_booking_enabled
       is distinct from old.direct_booking_enabled then
      raise exception
        'CONSULTANT_DIRECT_BOOKING_ENABLED_IMMUTABLE: consultants.direct_booking_enabled may not be changed by clients';
    end if;

    /*
     * WHAT THE PAGE CHARGES. The floor - at least the platform's
     * current consultation price - is enforced at save time by the
     * orchestrator and deliberately is not a constraint, which
     * makes a direct write the only way around it.
     */
    if new.direct_booking_price_cents
       is distinct from old.direct_booking_price_cents then
      raise exception
        'CONSULTANT_DIRECT_BOOKING_PRICE_IMMUTABLE: consultants.direct_booking_price_cents may not be changed by clients';
    end if;

    /* ---- migration 050 addition ---- */

    /*
     * WHETHER THEY APPEAR IN THE PLATFORM'S OWN CHOOSER.
     *
     * Consultant-managed, through the authenticated orchestrator
     * endpoint. Guarded here for the same reason the price is:
     * the rules around it are the orchestrator's, and this is the
     * one place a browser could set it without passing through
     * them. Reading it stays open - a consultant must be able to
     * see their own preference.
     */
    if new.direct_booking_only
       is distinct from old.direct_booking_only then
      raise exception
        'CONSULTANT_DIRECT_BOOKING_ONLY_IMMUTABLE: consultants.direct_booking_only may not be changed by clients';
    end if;

    /* ---- end migration 050 addition ---- */

    /*
     * available_for_general remains unguarded. Consultants control
     * their own general availability, still confined to their own
     * row by the RLS policy.
     */
  end if;

  return new;
end;
$$;

comment on function public.guard_consultants_columns() is
  'Migration 001, extended by 021, 026, 049 and 050. Closes the '
  'columns a browser must not write directly: is_active, '
  'profile_id, onboarding_completed_at, gender after onboarding, '
  'and the four direct booking settings - consultant_slug, '
  'direct_booking_enabled, direct_booking_price_cents and '
  'direct_booking_only. Every rule governing those four lives in '
  'the orchestrator, so a direct PostgREST write would bypass all '
  'of them. Privileged writers are unaffected; SELECT is '
  'unaffected.';

commit;
