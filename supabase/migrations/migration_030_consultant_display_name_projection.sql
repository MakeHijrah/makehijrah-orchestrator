-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 030: Consultant display-name public projection
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 008, as amended by the approved
--   display-name projection decision.
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- The problem this solves:
-- - The public booking flow renders "{consultant name} - {headline}".
--   headline already lives on public.consultants. The name does
--   not: profiles.full_name is authoritative, and no public,
--   client or anon surface may read public.profiles.
-- - The alternative - widening profiles SELECT - would expose
--   email, phone_whatsapp and every other private column in order
--   to reach one public field. That is not done here and is not
--   authorised.
--
-- The approved architecture:
-- - public.profiles.full_name          AUTHORITATIVE
-- - public.consultants.display_name    PUBLIC PROJECTION
--
-- This mirrors migration 028 exactly, which established the same
-- relationship for profiles.avatar_url -> consultants.photo_url.
-- The projection is denormalised on purpose and is maintained
-- exclusively by the service-role RPC below, in the same
-- transaction as the authoritative write. Nothing else writes it.
--
-- What this migration does:
--   A. Adds public.consultants.display_name.
--   B. Backfills it from profiles.full_name.
--   C. Replaces save_consultant_profile with the identical
--      migration 029 contract, changing ONLY full-name projection.
--
-- Deliberately NOT done here:
-- - No RLS policy change of any kind. profiles SELECT is untouched
--   and no private profiles column becomes reachable.
-- - No other profiles column is copied onto consultants. Only the
--   public-safe display name is projected: not email, not
--   phone_whatsapp, not profile metadata.
-- - No change to avatar behaviour (migration 028) or working-hours
--   behaviour (migration 029). Both are carried through verbatim.
-- - No table, trigger or enum change. The data model remains
--   16 tables.
-- - No blank-name rule is invented here. See section A2.
--
-- Idempotent: safe to run more than once.
-- ============================================================

begin;

-- ------------------------------------------- A. Projection column ----
--
-- Nullable with no default on purpose. A consultant whose
-- authoritative profiles.full_name is null has no name to project,
-- and null is the honest representation of that. It is NOT
-- defaulted to an empty string, which would be indistinguishable
-- from a real name of zero length.

alter table public.consultants
  add column if not exists display_name text;

comment on column public.consultants.display_name is
  'Public projection of the authoritative public.profiles.full_name. '
  'Maintained only by public.save_consultant_profile, in the same '
  'transaction as the authoritative write. Readable by public, client '
  'and admin consultant surfaces that may not read public.profiles. '
  'Never write this column directly.';

-- ------------------------------------------------ A2. Blank names ----
--
-- No CHECK constraint and no empty-string coercion is added here.
--
-- Application validation already rejects blank and whitespace-only
-- names before the RPC is ever called: both entry points parse
-- full_name as a trimmed string of minimum length 1
-- (consultant-profile.schema.ts and invite.schema.ts). That
-- behaviour is preserved, not replaced.
--
-- The RPC itself does not reject an empty string, and this
-- migration does not silently invent that rule. Doing so would
-- change the accepted input surface of a released function under
-- cover of a projection change. The gap is reported separately.

-- ---------------------------------------------------- B. Backfill ----
--
-- Copies the authoritative name onto the projection for every
-- consultant that has one. Rows whose authoritative name is null
-- are left null rather than blanked.
--
-- IS DISTINCT FROM makes the statement idempotent and null-safe: a
-- second run updates zero rows, and it never rewrites a row that
-- already agrees.

update public.consultants c
   set display_name = p.full_name
  from public.profiles p
 where p.id = c.profile_id
   and p.full_name is not null
   and c.display_name is distinct from p.full_name;

-- --------------------------------------------- C. RPC replacement ----
-- Identical to migration 029 in every respect - signature,
-- parameter names, modes, avatar dual-write, working-hours
-- named-to-numeric conversion, gender rules, onboarding marker,
-- country handling, null-preserve semantics, ownership resolution,
-- FOR UPDATE locking, atomic rollback, exception markers,
-- SECURITY DEFINER, search_path, grants and returned columns -
-- except that profiles.full_name now also projects onto
-- consultants.display_name.

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
  v_working_hours     jsonb;
  v_named_keys        integer;
  v_numeric_keys      integer;
  v_total_keys        integer;
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
  -- 6b. Working hours: named input, numeric storage
  -- --------------------------------------------------------
  --
  -- The HTTP wire format is named weekdays; storage is numeric
  -- keys 0-6 with 0 = sunday. Migrations 027 and 028 stored the
  -- argument verbatim, which put named keys in the column and broke
  -- profile loading. This function is now the conversion point.
  --
  -- A null argument preserves the stored value untouched, exactly
  -- as every other field does.
  --
  -- Validation is strict and refuses to guess. Numeric input is
  -- rejected rather than passed through, because accepting both
  -- would leave two callers disagreeing about the wire format and
  -- reintroduce the ambiguity this migration exists to remove.
  v_working_hours := null;

  if p_working_hours is not null then
    if jsonb_typeof(p_working_hours) <> 'object' then
      raise exception
        'CONSULTANT_WORKING_HOURS_FORMAT_INVALID: working hours must be a JSON object keyed by weekday name';
    end if;

    select
      count(*) filter (
        where k in ('sunday','monday','tuesday','wednesday',
                    'thursday','friday','saturday')
      ),
      count(*) filter (where k in ('0','1','2','3','4','5','6')),
      count(*)
      into v_named_keys, v_numeric_keys, v_total_keys
      from jsonb_object_keys(p_working_hours) as k;

    if v_numeric_keys > 0 then
      raise exception
        'CONSULTANT_WORKING_HOURS_FORMAT_INVALID: working hours must use named weekday keys, not numeric keys';
    end if;

    if v_named_keys <> v_total_keys then
      raise exception
        'CONSULTANT_WORKING_HOURS_FORMAT_INVALID: working hours contain an unrecognised weekday key';
    end if;

    /*
     * Deterministic reconstruction. Each day's interval array is
     * carried across by reference, so ordering and every start/end
     * value are preserved exactly. Absent weekdays stay absent.
     */
    select coalesce(
             jsonb_object_agg(
               case k
                 when 'sunday'    then '0'
                 when 'monday'    then '1'
                 when 'tuesday'   then '2'
                 when 'wednesday' then '3'
                 when 'thursday'  then '4'
                 when 'friday'    then '5'
                 when 'saturday'  then '6'
               end,
               p_working_hours -> k
             ),
             '{}'::jsonb
           )
      into v_working_hours
      from jsonb_object_keys(p_working_hours) as k;
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
  -- (migration 028) and display_name is the public projection of
  -- profiles.full_name (migration 030). Each is written from the
  -- SAME argument in the SAME transaction as its authoritative
  -- field above, so a projection can never diverge from its source
  -- through this function. The identical COALESCE means a null
  -- argument preserves BOTH values, and a non-null argument sets
  -- BOTH to it. Null is never turned into an empty string.
  --
  -- The projections exist because public, client and anon surfaces
  -- may read public.consultants but not public.profiles, and this
  -- migration does not widen profiles visibility to fix that. Only
  -- the two public-safe fields are projected: no email, no
  -- phone_whatsapp, no other profiles column is copied.
  --
  -- working_hours_jsonb stores v_working_hours, the numeric-keyed
  -- conversion built in section 6b - never the named argument.
  update public.consultants c
     set photo_url                    = coalesce(p_avatar_url, c.photo_url),
         display_name                 = coalesce(p_full_name, c.display_name),
         gender                       = v_next_gender,
         headline                     = coalesce(p_headline, c.headline),
         bio                          = coalesce(p_bio, c.bio),
         timezone                     = coalesce(p_timezone, c.timezone),
         minimum_booking_notice_hours = coalesce(p_minimum_booking_notice_hours,
                                                 c.minimum_booking_notice_hours),
         available_for_general        = coalesce(p_available_for_general,
                                                 c.available_for_general),
         working_hours_jsonb          = coalesce(v_working_hours, c.working_hours_jsonb),
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
-- Read-only. Run after applying. See MIGRATION_030_VERIFICATION.sql
-- for the full self-contained suite.
--
--  1. select count(*) as missing_projection
--       from public.consultants c
--       join public.profiles p on p.id = c.profile_id
--      where p.full_name is not null
--        and c.display_name is distinct from p.full_name;
--       -> 0
--
--  2. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
