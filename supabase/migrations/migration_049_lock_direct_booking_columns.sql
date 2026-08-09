-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 049: Lock the direct booking columns
-- ============================================================
--
-- Classification:
-- - Security hardening. One function replaced. No table, no
--   column, no index, no constraint, no policy, no grant, no RLS
--   change, and nothing to do with finance.
--
-- WHAT THIS CLOSES:
--
-- Amendment 011 added consultant_slug, direct_booking_enabled and
-- direct_booking_price_cents to public.consultants, and put the
-- rules that govern them in the orchestrator: the reserved-slug
-- set, the "at least the platform price" floor, the "a page needs
-- a slug and a price before it goes live" precondition, and now
-- (Amendment 012) the rule that a slug is admin-managed.
--
-- None of that was enforced against a DIRECT write. consultants
-- already carries an UPDATE policy for the owning consultant -
-- consultants_update_own_or_admin, from migration 002 - so a
-- consultant holding their own JWT could reach PostgREST and set
-- any of the three columns themselves, bypassing every rule above.
-- They could take a slug the orchestrator would have refused, or
-- price a booking below the platform's own consultation.
--
-- The column guard is the right instrument because it is the one
-- already in use for exactly this: is_active, profile_id,
-- onboarding_completed_at and gender are all closed this way, on
-- the same trigger, by the same helper.
--
-- WHAT IS NOT DONE HERE, and deliberately:
-- - No slug VALIDATION is added in SQL. The database keeps what it
--   already owns - the format CHECK, the length CHECK and the
--   unique index - and the reserved set stays in the orchestrator,
--   because it is a fact about the frontend's routing table rather
--   than about the schema. Now that sanctioned writes are forced
--   through the orchestrator, that split is complete rather than
--   merely intended.
-- - No RLS policy is added, removed or narrowed. Consultants keep
--   the SELECT they have always had, including on these three
--   columns: a consultant must be able to read and copy their own
--   booking link.
-- - No second trigger. The migration 001 trg_guard_consultants
--   binding is reused, so there is no trigger-ordering ambiguity.
--
-- The guard is written out in full because CREATE OR REPLACE
-- demands it. Everything before the new block is migration 026's
-- body, unchanged.
--
-- Rerun safety:
-- - Idempotent. CREATE OR REPLACE at a fixed signature, no DDL on
--   any table, and no grant.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regprocedure(
       'public.is_privileged_writer()'
     ) is null then
    raise exception
      'migration 049: is_privileged_writer not found - migration 001 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'consultants'
       and column_name = 'consultant_slug'
  ) then
    raise exception
      'migration 049: consultants.consultant_slug not found - migration 045 must be applied first';
  end if;

  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'consultants'
       and t.tgname = 'trg_guard_consultants'
  ) then
    raise exception
      'migration 049: trg_guard_consultants not found - migration 001 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. guard_consultants_columns, extended
-- ============================================================

create or replace function public.guard_consultants_columns()
returns trigger
language plpgsql
as $$
begin
  /*
   * Privileged writers (service_role and postgres) retain full
   * control over every column. That is what keeps the orchestrator
   * working: it holds the service role, and it is the only thing
   * that may write these columns after this migration.
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
     *
     * The condition keys on OLD.onboarding_completed_at, never on
     * is_active, so deactivating a consultant does not reopen
     * gender (Amendment 008 section 5.4).
     *
     * Before completion the marker is null and this branch does
     * not fire, which is what allows gender selection during
     * onboarding.
     */
    if old.onboarding_completed_at is not null
       and new.gender is distinct from old.gender then
      raise exception
        'CONSULTANT_GENDER_IMMUTABLE: consultants.gender may not be changed after onboarding completion';
    end if;

    /* ---- migration 049 additions start here ---- */

    /*
     * THE BOOKING LINK. Amendment 012.
     *
     * A consultant slug is a ROOT url, in the same namespace as
     * every top-level route the platform owns, and the reserved
     * set that protects that namespace lives in the orchestrator.
     * A direct write here would bypass it entirely - a consultant
     * could take /dashboard, or a name the frontend is about to
     * route to.
     *
     * It is also admin-managed now. Even a slug that passed every
     * rule would be a consultant renaming their own public link,
     * which breaks every card, signature and post already carrying
     * it. Generated at activation, changed only by an
     * administrator through the orchestrator.
     *
     * Reading it remains open. A consultant must be able to see
     * and copy their own booking link; this closes writes only.
     */
    if new.consultant_slug
       is distinct from old.consultant_slug then
      raise exception
        'CONSULTANT_SLUG_IMMUTABLE: consultants.consultant_slug may not be changed by clients';
    end if;

    /*
     * WHETHER THE PAGE IS LIVE.
     *
     * Publishing is not a single boolean in practice. The
     * orchestrator refuses to publish a consultant who is not
     * active, or who has no slug, or who has no price - and the
     * consultants_direct_booking_ready_check constraint only
     * covers the last two. A direct write could switch on a page
     * for a consultant an administrator had deliberately not
     * activated.
     *
     * The sanctioned path is PATCH /api/consultant/direct-booking,
     * which a consultant still owns. This closes the bypass, not
     * the capability.
     */
    if new.direct_booking_enabled
       is distinct from old.direct_booking_enabled then
      raise exception
        'CONSULTANT_DIRECT_BOOKING_ENABLED_IMMUTABLE: consultants.direct_booking_enabled may not be changed by clients';
    end if;

    /*
     * WHAT THE PAGE CHARGES.
     *
     * The floor - at least the platform's current consultation
     * price - is enforced at save time by the orchestrator and is
     * deliberately NOT a constraint, because the platform default
     * may later rise above a stored price and a constraint would
     * then invalidate an untouched row. That makes the
     * orchestrator the only thing enforcing it, and a direct write
     * the only way around it: a consultant could price their page
     * below the platform's own consultation and undercut it
     * through a page the platform hosts.
     *
     * Again the capability is untouched. The same endpoint still
     * sets it, through the same rule.
     */
    if new.direct_booking_price_cents
       is distinct from old.direct_booking_price_cents then
      raise exception
        'CONSULTANT_DIRECT_BOOKING_PRICE_IMMUTABLE: consultants.direct_booking_price_cents may not be changed by clients';
    end if;

    /* ---- migration 049 additions end here ---- */

    /*
     * available_for_general remains unguarded. Consultants
     * control their own general availability, still confined to
     * their own row by the RLS policy. Amendment 008 does not
     * change this; the later direct-write lockdown migration
     * moves it behind the orchestrator endpoint.
     */
  end if;

  return new;
end;
$$;

comment on function public.guard_consultants_columns() is
  'Migration 001, extended by 021, 026 and 049. Closes the columns '
  'a browser must not write directly: is_active, profile_id, '
  'onboarding_completed_at, gender after onboarding, and - from '
  'migration 049 - consultant_slug, direct_booking_enabled and '
  'direct_booking_price_cents. Every rule governing those three '
  'lives in the orchestrator (the reserved-slug set, the price '
  'floor, the publish preconditions, and admin-only slug '
  'management), so a direct PostgREST write would bypass all of '
  'them. Privileged writers are unaffected; SELECT is unaffected.';

commit;
