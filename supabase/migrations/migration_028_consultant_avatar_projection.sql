-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 028: Consultant avatar source and public projection
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 008, as amended by the approved avatar
--   architecture decision.
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- The problem this solves:
-- - profiles.avatar_url is the authoritative photograph, but no
--   public, client or anon surface may read public.profiles. Those
--   surfaces may read public.consultants. Migration 027 therefore
--   left the authoritative avatar invisible to exactly the people
--   a consultant photograph exists for.
-- - The alternative - widening profiles SELECT - would expose
--   email, phone_whatsapp and every other private column to reach
--   one public field. That is not done here and is not authorised.
--
-- The approved architecture:
-- - public.profiles.avatar_url        AUTHORITATIVE
-- - public.consultants.photo_url      PUBLIC PROJECTION
--
-- The projection is denormalised on purpose and is maintained
-- exclusively by the service-role RPC below, in the same
-- transaction as the authoritative write. Nothing else writes it.
--
-- What this migration does:
--   A. Backfills profiles.avatar_url from the legacy
--      consultants.photo_url, but only where the authoritative
--      field is null. An existing authoritative value always wins.
--   B. Synchronises consultants.photo_url from the authoritative
--      field wherever they disagree and the authoritative value is
--      non-null.
--   C. Replaces save_consultant_profile with the identical
--      migration 027 contract, changing ONLY avatar persistence.
--
-- Deliberately NOT done here:
-- - No RLS policy change of any kind. profiles SELECT is untouched
--   and no private profiles column becomes reachable.
-- - No table, column, constraint, trigger or enum change. The data
--   model remains 16 tables.
-- - No clearing of consultants.photo_url when the authoritative
--   field is null. A legacy photo is never destroyed by this
--   migration.
--
-- Idempotent. Transaction-wrapped.
-- ============================================================

begin;

-- ------------------------------------------------------------- pre-flight ----
-- Fail before changing anything if a dependency is missing, so the
-- transaction rolls back and the live state is untouched.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'migration 028: public.profiles not found';
  end if;

  if to_regclass('public.consultants') is null then
    raise exception 'migration 028: public.consultants not found';
  end if;

  if to_regprocedure(
       'public.save_consultant_profile('
       || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
     ) is null then
    raise exception
      'migration 028: save_consultant_profile not found - apply migration 027 first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'consultants'
       and column_name = 'photo_url'
  ) then
    raise exception 'migration 028: public.consultants.photo_url not found';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profiles'
       and column_name = 'avatar_url'
  ) then
    raise exception 'migration 028: public.profiles.avatar_url not found';
  end if;
end;
$$;

-- ------------------------------------------------ A. legacy backfill ----
-- Adopt the legacy consultant photo as the authoritative avatar, but
-- ONLY where there is no authoritative value to lose.
--
-- The p.avatar_url is null predicate is the whole safety property: an
-- existing authoritative value is never overwritten, and a re-run
-- touches nothing because the predicate no longer matches.

update public.profiles p
set avatar_url = c.photo_url
from public.consultants c
where c.profile_id = p.id
  and p.avatar_url is null
  and c.photo_url is not null;

-- -------------------------------------- B. projection synchronisation ----
-- Bring the public projection into line with the authoritative field.
--
-- Runs AFTER the backfill, so a consultant whose only photograph was
-- the legacy one keeps it in both places.
--
-- is distinct from, not <>, so a null projection beside a non-null
-- authoritative value is corrected rather than skipped by
-- three-valued logic.
--
-- Deliberately does NOT clear photo_url when avatar_url is null: a
-- consultant with a legacy photo and no authoritative value keeps
-- the legacy photo visible until they save a new one.

update public.consultants c
set photo_url = p.avatar_url
from public.profiles p
where p.id = c.profile_id
  and p.avatar_url is not null
  and c.photo_url is distinct from p.avatar_url;

-- --------------------------------------------- C. RPC replacement ----
-- Identical to migration 027 in every respect - signature, modes,
-- gender rules, marker rules, country handling, null-preserve
-- semantics, ownership resolution, FOR UPDATE locking, atomic
-- rollback, exception markers, SECURITY DEFINER, search_path and
-- grants - except that section 8 now also writes the public
-- projection from the same argument.

create or replace function public.save_consultant_profile(
  p_consultant_id                 uuid,
  p_mode                          text,
  p_full_name                     text,
  p_avatar_url                    text,
  p_gender                        text,
  p_headline                      text,
  p_bio                           text,
  p_timezone                      text,
  p_minimum_booking_notice_hours  integer,
  p_available_for_general         boolean,
  p_country_ids                   uuid[],
  p_working_hours                 jsonb
)
returns table (
  consultant_id            uuid,
  onboarding_completed_at  timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_profile_id        uuid;
  v_current_gender    text;
  v_current_marker    timestamptz;
  v_next_gender       text;
  v_next_marker       timestamptz;
  v_country_ids       uuid[];
  v_invalid_countries integer;
begin
  /*
   * Every column reference below is table-qualified on purpose.
   * The RETURNS TABLE clause creates OUT parameters named
   * consultant_id and onboarding_completed_at, which would
   * otherwise shadow the identically named columns on
   * consultant_countries and consultants and silently change
   * what a predicate means.
   */

  -- --------------------------------------------------------
  -- 1. Mode
  -- --------------------------------------------------------
  if p_mode is null
     or p_mode not in ('draft', 'submit', 'update') then
    raise exception
      'CONSULTANT_PROFILE_MODE_INVALID: mode must be draft, submit or update';
  end if;

  -- --------------------------------------------------------
  -- 2. Ownership
  -- --------------------------------------------------------
  --
  -- FOR UPDATE locks the consultant row for the life of the
  -- transaction, so two concurrent saves for the same consultant
  -- serialise rather than interleaving their country replacement.
  select c.profile_id,
         c.gender,
         c.onboarding_completed_at
    into v_profile_id,
         v_current_gender,
         v_current_marker
    from public.consultants c
   where c.id = p_consultant_id
   for update;

  if not found then
    raise exception
      'CONSULTANT_PROFILE_NOT_FOUND: consultant % does not exist', p_consultant_id;
  end if;

  -- --------------------------------------------------------
  -- 3. Mode against onboarding state
  -- --------------------------------------------------------
  if p_mode in ('draft', 'submit')
     and v_current_marker is not null then
    raise exception
      'CONSULTANT_ONBOARDING_ALREADY_COMPLETED: consultant % completed onboarding at %',
      p_consultant_id, v_current_marker;
  end if;

  if p_mode = 'update'
     and v_current_marker is null then
    raise exception
      'CONSULTANT_ONBOARDING_INCOMPLETE: consultant % has not completed onboarding', p_consultant_id;
  end if;

  -- --------------------------------------------------------
  -- 4. Gender
  -- --------------------------------------------------------
  v_next_gender := v_current_gender;

  if p_mode = 'submit' then
    /*
     * Submission is the one moment gender is chosen, so it is
     * required and must be exact.
     */
    if p_gender is null
       or p_gender not in ('male', 'female') then
      raise exception
        'CONSULTANT_GENDER_INVALID: gender must be male or female to submit onboarding';
    end if;

    v_next_gender := p_gender;

  elsif p_mode = 'draft' then
    /*
     * Optional before completion. A null argument preserves
     * whatever is stored; a supplied value must still be valid.
     */
    if p_gender is not null then
      if p_gender not in ('male', 'female') then
        raise exception
          'CONSULTANT_GENDER_INVALID: gender must be male or female';
      end if;

      v_next_gender := p_gender;
    end if;

  else
    /*
     * update. Gender is immutable. A null argument is ignored,
     * and a value equal to the stored one is tolerated so a
     * frontend that still round-trips the field during rollout
     * does not fail. Anything else - including an attempt to
     * clear it by sending a different value - is rejected.
     *
     * This keys on the marker, never on is_active, so a
     * deactivated consultant is still locked.
     */
    if p_gender is not null
       and p_gender is distinct from v_current_gender then
      raise exception
        'CONSULTANT_GENDER_IMMUTABLE: consultant gender cannot be changed after onboarding is completed';
    end if;
  end if;

  -- --------------------------------------------------------
  -- 5. Onboarding marker
  -- --------------------------------------------------------
  --
  -- Set exactly once, on a successful submit. Never cleared,
  -- never overwritten, never touched by draft or update.
  v_next_marker := v_current_marker;

  if p_mode = 'submit' then
    v_next_marker := now();
  end if;

  -- --------------------------------------------------------
  -- 6. Country assignments
  -- --------------------------------------------------------
  --
  -- A null argument means "leave assignments alone". An empty
  -- array is an instruction, not an omission: it removes every
  -- assignment. The two are distinguished by IS NULL, never by
  -- array_length, because array_length of an empty array is null
  -- and would conflate them.
  if p_country_ids is not null then
    select array_agg(distinct t.country_id)
      into v_country_ids
      from unnest(p_country_ids) as t(country_id);

    /*
     * v_country_ids is null when the input array was empty.
     * Duplicates collapse here, so repeated identifiers can never
     * reach the insert and can never raise a duplicate key.
     */
    if v_country_ids is not null then
      select count(*)
        into v_invalid_countries
        from unnest(v_country_ids) as t(country_id)
        left join public.countries co
               on co.id = t.country_id
       where co.id is null
          or co.is_active is not true;

      if v_invalid_countries > 0 then
        raise exception
          'CONSULTANT_COUNTRY_INVALID: % supplied country identifier(s) do not exist or are not active',
          v_invalid_countries;
      end if;
    end if;

    /*
     * Scoped to this consultant only. No other consultant's
     * assignments are readable or writable from here.
     */
    delete from public.consultant_countries cc
     where cc.consultant_id = p_consultant_id;

    if v_country_ids is not null then
      insert into public.consultant_countries (consultant_id, country_id)
      select p_consultant_id, t.country_id
        from unnest(v_country_ids) as t(country_id);
    end if;
  end if;

  -- --------------------------------------------------------
  -- 7. Authoritative profile fields
  -- --------------------------------------------------------
  --
  -- profiles.avatar_url is the authoritative photograph
  -- (Amendment 008 §3).
  --
  -- COALESCE gives the null-preserve semantics: a null argument
  -- keeps the stored value. Null is never converted into an empty
  -- string; an empty string may only arrive as an explicit
  -- argument the application chose to send.
  update public.profiles pr
     set full_name  = coalesce(p_full_name,  pr.full_name),
         avatar_url = coalesce(p_avatar_url, pr.avatar_url)
   where pr.id = v_profile_id;

  -- --------------------------------------------------------
  -- 8. Consultant fields
  -- --------------------------------------------------------
  --
  -- is_active, profile_id and created_at are deliberately absent.
  -- updated_at is left to the existing trg_consultants_updated
  -- trigger rather than written here.
  --
  -- photo_url is the public projection of profiles.avatar_url
  -- (migration 028). It is written from the SAME argument in the
  -- SAME transaction as the authoritative field above, so the two
  -- can never diverge through this function. The identical
  -- COALESCE means a null argument preserves BOTH values, and a
  -- non-null argument sets BOTH to it.
  --
  -- The projection exists because public, client and anon surfaces
  -- may read public.consultants but not public.profiles, and this
  -- migration does not widen profiles visibility to fix that.
  update public.consultants c
     set photo_url                    = coalesce(p_avatar_url, c.photo_url),
         gender                       = v_next_gender,
         headline                     = coalesce(p_headline, c.headline),
         bio                          = coalesce(p_bio, c.bio),
         timezone                     = coalesce(p_timezone, c.timezone),
         minimum_booking_notice_hours = coalesce(p_minimum_booking_notice_hours,
                                                 c.minimum_booking_notice_hours),
         available_for_general        = coalesce(p_available_for_general,
                                                 c.available_for_general),
         working_hours_jsonb          = coalesce(p_working_hours, c.working_hours_jsonb),
         onboarding_completed_at      = v_next_marker
   where c.id = p_consultant_id;

  -- --------------------------------------------------------
  -- 9. Result
  -- --------------------------------------------------------
  --
  -- Exactly one row. No exception is caught anywhere in this
  -- function: any failure propagates and rolls back every change
  -- made above, which is the whole reason the work is here rather
  -- than in sequential client calls.
  return query
  select p_consultant_id, v_next_marker;
end;
$$;

-- ------------------------------------------------------------
-- Execution rights
-- ------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on a new
-- function, so revoking from PUBLIC is required and not
-- cosmetic. anon and authenticated are revoked explicitly as
-- well, so the intent survives a future default change.

revoke all on function public.save_consultant_profile(
  uuid, text, text, text, text, text, text, text,
  integer, boolean, uuid[], jsonb
) from public;

revoke all on function public.save_consultant_profile(
  uuid, text, text, text, text, text, text, text,
  integer, boolean, uuid[], jsonb
) from anon;

revoke all on function public.save_consultant_profile(
  uuid, text, text, text, text, text, text, text,
  integer, boolean, uuid[], jsonb
) from authenticated;

grant execute on function public.save_consultant_profile(
  uuid, text, text, text, text, text, text, text,
  integer, boolean, uuid[], jsonb
) to service_role;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See MIGRATION_028_VERIFICATION.sql
-- for the full self-contained suite.
--
--  1. select count(*) from public.profiles p
--       join public.consultants c on c.profile_id = p.id
--      where p.avatar_url is null and c.photo_url is not null;
--       -> 0   (backfill left no adoptable legacy photo behind)
--
--  2. select count(*) from public.consultants c
--       join public.profiles p on p.id = c.profile_id
--      where p.avatar_url is not null
--        and c.photo_url is distinct from p.avatar_url;
--       -> 0   (projection is synchronised)
--
--  3. select count(*) from pg_policies
--      where schemaname = 'public' and tablename = 'profiles';
--       -> unchanged from before this migration
--
--  4. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
