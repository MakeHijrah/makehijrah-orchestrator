-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 029: Normalise consultant working-hours storage
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 008, as amended by the approved
--   working-hours storage decision.
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- The regression this repairs:
-- - The approved architecture stores weekday keys numerically,
--   0 = sunday through 6 = saturday. The HTTP wire format is named
--   weekdays, which is what the frontend sends and expects back.
-- - The migration 027 and 028 RPC stored p_working_hours verbatim,
--   so a successful save wrote NAMED keys into the column. Profile
--   loading then failed against a production row shaped
--   {"sunday": [{"start": "09:00", "end": "17:00"}]}.
--
-- Where each conversion happens after this migration:
--   named -> numeric   in this RPC, on the way in
--   numeric -> named   in the orchestrator response mapper, on the
--                      way out
--
-- What this migration does:
--   A. Repairs existing rows, converting named keys to numeric.
--   B. Replaces save_consultant_profile with the identical
--      migration 028 contract, changing ONLY working-hours
--      validation and persistence.
--
-- Deliberately NOT done here:
-- - No RLS policy change. No table, column, constraint, trigger or
--   enum change. The data model remains 16 tables.
-- - No change to the avatar dual-write from migration 028.
-- - No permissive guessing. A row carrying a mix of named and
--   numeric keys, or any unrecognised key, ABORTS the migration
--   rather than being silently reinterpreted.
--
-- Idempotent. Transaction-wrapped.
-- ============================================================

begin;

-- ------------------------------------------------------------- pre-flight ----

do $$
begin
  if to_regclass('public.consultants') is null then
    raise exception 'migration 029: public.consultants not found';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'consultants'
       and column_name = 'working_hours_jsonb'
  ) then
    raise exception 'migration 029: consultants.working_hours_jsonb not found';
  end if;

  if to_regprocedure(
       'public.save_consultant_profile('
       || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)'
     ) is null then
    raise exception
      'migration 029: save_consultant_profile not found - apply migrations 027 and 028 first';
  end if;

  -- The migration 028 avatar projection must already be in place, or
  -- replacing the function here would silently revert it.
  if (
    select p.prosrc
      from pg_proc p
     where p.oid = to_regprocedure(
       'public.save_consultant_profile('
       || 'uuid,text,text,text,text,text,text,text,integer,boolean,uuid[],jsonb)')
  ) not like '%photo_url%coalesce(p_avatar_url%' then
    raise exception
      'migration 029: the installed function does not carry the migration 028 avatar projection - apply 028 first';
  end if;
end;
$$;

-- ----------------------------------------- A. repair existing rows ----
-- Abort on anything ambiguous BEFORE writing, so a mixed or
-- unrecognised row stops the migration instead of being guessed at.

do $$
declare
  v_bad integer;
  v_ids text;
begin
  -- Rows carrying a key that is neither a known weekday name nor a
  -- known numeric key.
  select count(*), coalesce(string_agg(distinct id::text, ', '), '')
    into v_bad, v_ids
    from (
      select c.id
        from public.consultants c,
             lateral jsonb_object_keys(c.working_hours_jsonb) as k
       where c.working_hours_jsonb is not null
         and jsonb_typeof(c.working_hours_jsonb) = 'object'
         and k not in ('sunday','monday','tuesday','wednesday',
                       'thursday','friday','saturday',
                       '0','1','2','3','4','5','6')
    ) as bad;

  if v_bad > 0 then
    raise exception
      'migration 029: % consultant row(s) contain an unrecognised weekday key and were not converted: %',
      v_bad, v_ids;
  end if;

  -- Rows mixing named and numeric keys. Neither format is safe to
  -- assume, so this is a hard stop.
  select count(*), coalesce(string_agg(distinct id::text, ', '), '')
    into v_bad, v_ids
    from (
      select c.id
        from public.consultants c
       where c.working_hours_jsonb is not null
         and jsonb_typeof(c.working_hours_jsonb) = 'object'
         and exists (
           select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
            where k in ('sunday','monday','tuesday','wednesday',
                        'thursday','friday','saturday')
         )
         and exists (
           select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
            where k in ('0','1','2','3','4','5','6')
         )
    ) as mixed;

  if v_bad > 0 then
    raise exception
      'migration 029: % consultant row(s) mix named and numeric weekday keys and were not converted: %',
      v_bad, v_ids;
  end if;
end;
$$;

-- Convert named-keyed rows. Numeric-only rows do not match the
-- EXISTS predicate and are left byte-identical. Empty objects and
-- nulls likewise never match, so both survive untouched.
--
-- Each day's interval array is carried across by reference, so
-- ordering and every start/end value are preserved exactly.

update public.consultants c
set working_hours_jsonb = (
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
             c.working_hours_jsonb -> k
           ),
           '{}'::jsonb
         )
    from jsonb_object_keys(c.working_hours_jsonb) as k
)
where c.working_hours_jsonb is not null
  and jsonb_typeof(c.working_hours_jsonb) = 'object'
  and exists (
    select 1 from jsonb_object_keys(c.working_hours_jsonb) as k
     where k in ('sunday','monday','tuesday','wednesday',
                 'thursday','friday','saturday')
  );

-- --------------------------------------------- B. RPC replacement ----
-- Identical to migration 028 in every respect - signature, modes,
-- avatar dual-write, gender rules, marker rules, country handling,
-- null-preserve semantics, ownership resolution, FOR UPDATE
-- locking, atomic rollback, exception markers, SECURITY DEFINER,
-- search_path, grants and returned columns - except that working
-- hours are now validated as named and stored as numeric.

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
  -- (migration 028). It is written from the SAME argument in the
  -- SAME transaction as the authoritative field above, so the two
  -- can never diverge through this function. The identical
  -- COALESCE means a null argument preserves BOTH values, and a
  -- non-null argument sets BOTH to it.
  --
  -- The projection exists because public, client and anon surfaces
  -- may read public.consultants but not public.profiles, and this
  -- migration does not widen profiles visibility to fix that.
  --
  -- working_hours_jsonb stores v_working_hours, the numeric-keyed
  -- conversion built in section 6b - never the named argument.
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
-- Read-only. Run after applying. See MIGRATION_029_VERIFICATION.sql
-- for the full self-contained suite.
--
--  1. select count(*) from public.consultants c,
--          lateral jsonb_object_keys(c.working_hours_jsonb) as k
--      where c.working_hours_jsonb is not null
--        and k not in ('0','1','2','3','4','5','6');
--       -> 0   (no named or unrecognised key remains in storage)
--
--  2. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
