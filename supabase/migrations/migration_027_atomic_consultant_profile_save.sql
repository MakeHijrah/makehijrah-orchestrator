-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 027: Atomic consultant profile save
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 008
--   "Consultant Self-Managed Booking Capability, Complete
--    Profile Submission, and Immutable Gender" (APPROVED),
--   section 17. Migration 026 deliberately deferred this
--   function until its contract was final. It now is.
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- Purpose:
-- - Provide the single transactional write path for consultant
--   profile submission. A save spans public.profiles,
--   public.consultants and public.consultant_countries, which
--   supabase-js cannot do in one request, so the transaction has
--   to live in the database.
--
-- Trust boundary:
-- - EXECUTE is granted to service_role only. anon, authenticated
--   and PUBLIC are explicitly revoked, including the EXECUTE that
--   PostgreSQL grants to PUBLIC by default.
-- - The orchestrator resolves the authenticated consultant and
--   passes p_consultant_id. The browser never calls this.
-- - The function still validates its own arguments. A trusted
--   caller is not the same as a correct caller.
--
-- search_path:
-- - Pinned to pg_catalog, public. pg_catalog first means a
--   built-in can never be shadowed by a same-named object created
--   later in public, which is the attack a SECURITY DEFINER
--   function is most exposed to.
-- - pg_temp is deliberately absent. Including it would let any
--   caller pre-create a temporary object that resolves ahead of
--   the real one.
-- - Every application table below is schema-qualified regardless,
--   so resolution never depends on the path alone.
--
-- Why the body re-enforces the gender rules:
-- - SECURITY DEFINER runs as the owner, so is_privileged_writer()
--   is true and the migration 026 trigger does not fire for
--   writes made here. The trigger protects direct client writes;
--   this function must protect itself. Both layers are required
--   and neither is redundant.
--
-- Deliberately not done:
-- - No Google OAuth validation. It needs an external read.
-- - No profile completeness rules, no booking-capability rule and
--   no active-consultant safety rule. Those are evaluated by the
--   orchestrator before this is called (Amendment 008 §8).
-- - No table, no trigger, no column change, no constraint change,
--   no RLS policy change. The data model remains 16 tables.
-- ============================================================

begin;

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
  -- (Amendment 008 §3). consultants.photo_url is never written.
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
  -- is_active, profile_id, photo_url and created_at are
  -- deliberately absent. updated_at is left to the existing
  -- trg_consultants_updated trigger rather than written here.
  update public.consultants c
     set gender                       = v_next_gender,
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
