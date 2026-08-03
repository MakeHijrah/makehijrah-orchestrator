-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 026: Consultant onboarding marker and gender lock
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 008
--   "Consultant Self-Managed Booking Capability, Complete
--    Profile Submission, and Immutable Gender" (APPROVED).
--   This migration implements section 16 of that amendment and
--   nothing beyond it.
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- Purpose:
-- - Add consultants.onboarding_completed_at, the persisted
--   onboarding-completion marker (Amendment 008 section 4).
-- - Backfill it for consultants that are active when this
--   migration runs, who are treated as previously onboarded.
-- - Extend public.guard_consultants_columns so that, for
--   non-privileged writers, the marker cannot be changed and
--   gender cannot be changed or cleared once the marker is set.
--
-- Deliberately staged:
-- - This migration does NOT block direct client writes to the
--   other consultant-editable columns (headline, bio, timezone,
--   working_hours_jsonb, minimum_booking_notice_hours,
--   available_for_general). The deployed frontend still writes
--   them directly, and the orchestrator profile endpoint does not
--   exist yet. Blocking them now would break the live profile
--   page during the deployment gap.
--
--   Amendment 008 section 11.2 authorises a second migration,
--   applied immediately before the new frontend ships, to close
--   those columns once the endpoint is the only writer.
--
-- - The gender lock DOES take effect now. That is intended
--   (Amendment 008 sections 4.6 and 11.3). The guard compares old
--   and new values, so a profile page resubmitting an unchanged
--   gender is unaffected; only an actual change is rejected.
--
-- Deliberately not done:
-- - No table is created. The data model remains exactly 16
--   tables.
-- - No RLS policy is added, removed or widened.
-- - No constraint is added or altered. consultants_gender_check
--   from migration 018 is untouched.
-- - No column is dropped or retyped. consultants.photo_url is
--   retained for backward compatibility (Amendment 008 3.2).
-- - No second trigger is created. The existing
--   trg_guard_consultants binding from migration 001 is reused,
--   so there is no trigger-ordering ambiguity.
-- - public.save_consultant_profile is NOT created here. Its
--   contract is not final and Amendment 008 section 17.4 forbids
--   shipping a half-secure security-definer function.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Onboarding completion marker
-- ------------------------------------------------------------
--
-- Nullable with no default. A null marker means onboarding has
-- not been completed, which is the correct state for every
-- consultant who has not yet submitted a complete profile.
--
-- This is deliberately NOT is_active. Activation is an
-- administrative decision; onboarding completion is a consultant
-- action. Conflating them is what would make deactivation reopen
-- gender (Amendment 008 section 4.3).

alter table public.consultants
  add column if not exists onboarding_completed_at timestamptz;

-- ------------------------------------------------------------
-- 2. Preflight: every active consultant has a usable gender
-- ------------------------------------------------------------
--
-- The backfill in section 3 locks gender permanently for every
-- consultant it marks. Marking a consultant whose gender is null
-- or otherwise unusable would lock them into an invalid value
-- that no application path can then correct, and the only way out
-- would be a direct service-role write.
--
-- So this aborts the whole transaction instead. Nothing is
-- repaired, inferred or assigned here: a missing gender is a data
-- question for an administrator, not something a migration may
-- guess.
--
-- IS DISTINCT FROM is used rather than <> or NOT IN so that a
-- null gender is counted rather than silently dropping out of the
-- predicate.
--
-- On abort the column addition in section 1 rolls back with
-- everything else, so a failed run leaves the schema untouched.

do $$
declare
  v_invalid_count integer;
begin
  select count(*)
    into v_invalid_count
    from public.consultants
   where is_active = true
     and gender is distinct from 'male'
     and gender is distinct from 'female';

  if v_invalid_count > 0 then
    raise exception
      'MIGRATION_026_ACTIVE_CONSULTANT_GENDER_INVALID: % active consultant(s) have a gender that is not exactly male or female. Resolve each one before applying migration 026. No row has been modified.',
      v_invalid_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. Backfill: active consultants only
-- ------------------------------------------------------------
--
-- A consultant who is already active was activated by an
-- administrator against the previous requirements, so they are
-- treated as previously onboarded: their gender locks
-- immediately and they use the normal update mode rather than
-- repeating onboarding (Amendment 008 sections 4.4 and 4.6).
--
-- Inactive consultants are NOT backfilled (section 4.5). They
-- complete onboarding through the new flow and choose gender at
-- that point.
--
-- Ordering note: this runs BEFORE the guard is replaced, so the
-- backfill is evaluated entirely under the migration-021 guard
-- semantics. The migration also runs as a privileged writer, so
-- is_privileged_writer() would exempt it either way. Doing it in
-- this order removes any dependence on that.
--
-- Execution model: this migration runs ONCE, through the
-- migration ledger. ADD COLUMN IF NOT EXISTS and the null
-- predicate exist for technical retry safety during a deployment
-- recovery - an interrupted or repeated apply must not fail or
-- double-write - and for nothing else.
--
-- It is NOT a recurring backfill. A consultant who completes
-- onboarding after this migration is marked only by the new
-- profile-submission workflow. Re-running this migration to mark
-- consultants activated later is not a supported operation and
-- would set the marker without the completeness validation the
-- marker is supposed to represent.
--
-- Side effect, disclosed: consultants also carries
-- trg_consultants_updated, so backfilled rows have updated_at
-- refreshed. No other column changes.

update public.consultants
   set onboarding_completed_at = now()
 where is_active = true
   and onboarding_completed_at is null;

-- ------------------------------------------------------------
-- 4. Extended consultant column guard
-- ------------------------------------------------------------
--
-- The function is replaced in place rather than supplemented by
-- a second trigger, so all consultant column protection stays in
-- one readable place with one evaluation order.
--
-- The existing is_active and profile_id protections are
-- preserved exactly, including their message text. Do not alter
-- them here.
--
-- is_privileged_writer() is unchanged and still exempts
-- service_role, postgres and supabase_admin. That exemption is
-- the controlled correction path of Amendment 008 section 5.6.
-- It is deliberately not reachable through any application
-- route, and the orchestrator is bound by application code and
-- tests rather than by this trigger.
--
-- Exception messages begin with a stable uppercase marker so
-- application code can map them to the API error codes in
-- Amendment 008 section 14.2 without parsing prose. Raw
-- PostgreSQL text is never forwarded to a client.

create or replace function public.guard_consultants_columns()
returns trigger
language plpgsql
as $$
begin
  /*
   * Privileged writers (service_role and postgres) retain full
   * control over every column.
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

commit;
