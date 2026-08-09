-- ============================================================
-- Verification for migration_049_lock_direct_booking_columns
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape and schema protections        read-only
--   Part 2  the guard, as a consultant          STAGING ONLY, rolls back
--   Part 3  the guard, as the orchestrator      STAGING ONLY, rolls back
--   Part 4  nothing else moved                  read-only
--   Part 5  rollback guidance
--
-- Parts 2 and 3 share one transaction that ends in ROLLBACK.
--
-- Per the standing rule from migration 046, this file EXERCISES
-- the guard rather than reading its source: it takes the
-- authenticated role, sets a JWT subject, and attempts the writes
-- a consultant's own browser could attempt against PostgREST.
-- Reading the function body would prove only that somebody typed
-- the right words.
--
-- Check map:
--    1  the guard function and its trigger binding exist
--    2  an authenticated consultant cannot change their own
--       consultant_slug
--    3  ... nor their own direct_booking_enabled
--    4  ... nor their own direct_booking_price_cents
--    5  a consultant CAN still change what they always could
--    6  a consultant can still SELECT their own row, including all
--       three locked columns
--    7  service_role can change consultant_slug
--    8  service_role can change direct_booking_enabled
--    9  service_role can change direct_booking_price_cents
--   10  the whole orchestrator write - all three at once - works
--   11  the unique slug index still exists
--   12  the slug format and length constraints still exist
--   13  RLS is still enabled on consultants
--   14  anon gained no write access
--   15  no policy was added, removed or rewritten
--   16  the earlier guarded columns still behave as before
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE AND SCHEMA PROTECTIONS (read-only)
-- ============================================================

-- Checks 1, 11, 12 and 13.

do $$
declare
  v_definition text;
  v_count integer;
begin
  /* Check 1. */
  if to_regprocedure(
       'public.guard_consultants_columns()'
     ) is null then
    raise exception
      'VERIFICATION FAILED 1: guard_consultants_columns does not exist';
  end if;

  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'consultants'
       and t.tgname = 'trg_guard_consultants'
       and not t.tgisinternal
  ) then
    raise exception
      'VERIFICATION FAILED 1: trg_guard_consultants is not bound to consultants';
  end if;

  /*
   * And exactly one binding. A second trigger doing the same job
   * would make ordering matter, which migration 026 avoided on
   * purpose.
   */
  select count(*) into v_count
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'consultants'
     and not t.tgisinternal
     and t.tgname like '%guard%';

  if v_count <> 1 then
    raise exception
      'VERIFICATION FAILED 1: % guard trigger(s) on consultants; there must be exactly one',
      v_count;
  end if;

  /*
   * Check 11. The database still owns uniqueness. Migration 049
   * adds no SQL slug validation and removes none.
   */
  select indexdef into v_definition
    from pg_indexes
   where schemaname = 'public'
     and indexname = 'uq_consultants_slug';

  if v_definition is null then
    raise exception
      'VERIFICATION FAILED 11: uq_consultants_slug is missing; nothing arbitrates two consultants claiming one link';
  end if;

  if v_definition not like '%UNIQUE%'
     or v_definition not like '%consultant_slug%' then
    raise exception
      'VERIFICATION FAILED 11: uq_consultants_slug is defined as %',
      v_definition;
  end if;

  /* Check 12. Format and length remain the database's. */
  foreach v_definition in array array[
    'consultants_slug_format_check',
    'consultants_slug_length_check',
    'consultants_direct_price_range_check',
    'consultants_direct_booking_ready_check'
  ]
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = v_definition
         and conrelid = 'public.consultants'::regclass
    ) then
      raise exception
        'VERIFICATION FAILED 12: % is missing', v_definition;
    end if;
  end loop;

  /* Check 13. */
  if not (
    select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'consultants'
  ) then
    raise exception
      'VERIFICATION FAILED 13: RLS is disabled on consultants';
  end if;

  raise notice 'PASS 1, 11, 12, 13: one guard trigger, the slug index and constraints intact, RLS enabled';
end $$;


-- Checks 14 and 15 — the policy set is exactly what it was.

do $$
declare
  v_count integer;
  v_policy text;
  v_expected constant text[] := array[
    'consultants_select_active_public',
    'consultants_select_own_or_admin',
    'consultants_update_own_or_admin'
  ];
begin
  select count(*) into v_count
    from pg_policies
   where schemaname = 'public' and tablename = 'consultants';

  if v_count <> array_length(v_expected, 1) then
    raise exception
      'VERIFICATION FAILED 15: consultants carries % policies; migration 049 adds none and expects %',
      v_count, array_length(v_expected, 1);
  end if;

  foreach v_policy in array v_expected
  loop
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public'
         and tablename = 'consultants'
         and policyname = v_policy
    ) then
      raise exception
        'VERIFICATION FAILED 15: policy % is missing', v_policy;
    end if;
  end loop;

  /*
   * Check 14. anon reads active consultants and writes nothing.
   * The lockdown is a column guard, not a new door, so anon's
   * reach must be exactly what it was.
   */
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'consultants'
       and 'anon' = any(roles)
       and cmd <> 'SELECT'
  ) then
    raise exception
      'VERIFICATION FAILED 14: anon holds a non-SELECT policy on consultants';
  end if;

  raise notice 'PASS 14, 15: the three pre-existing policies, unchanged, and anon still reads only';
end $$;


-- ============================================================
-- PARTS 2 AND 3 — ONE TRANSACTION, ROLLED BACK
-- ============================================================

begin;

do $$
declare
  v_pro uuid := gen_random_uuid();
  v_other_pro uuid := gen_random_uuid();
  v_con uuid := gen_random_uuid();
  v_other_con uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_pro,       'v49-a@verification.invalid'),
    (v_other_pro, 'v49-b@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_pro,       'consultant', 'V49 A', 'v49-a@verification.invalid'),
    (v_other_pro, 'consultant', 'V49 B', 'v49-b@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  insert into public.consultants (
    id, profile_id, timezone, is_active, headline, bio,
    available_for_general, onboarding_completed_at,
    consultant_slug, direct_booking_enabled,
    direct_booking_price_cents)
  values
    (v_con, v_pro, 'UTC', true, 'Original headline',
     'Original bio', false, now(),
     'v49-aisha', true, 20000),
    (v_other_con, v_other_pro, 'UTC', true, 'Other', 'Other',
     false, now(), 'v49-yusuf', false, null);

  perform set_config('app.v49_pro', v_pro::text, true);
  perform set_config('app.v49_con', v_con::text, true);
  perform set_config('app.v49_other_con', v_other_con::text, true);
end $$;


-- ============================================================
-- PART 2 — THE GUARD, AS A CONSULTANT
-- ============================================================

-- Checks 2, 3, 4, 5, 6 and 16.

do $$
declare
  v_pro uuid := current_setting('app.v49_pro')::uuid;
  v_con uuid := current_setting('app.v49_con')::uuid;
  v_slug text;
  v_enabled boolean;
  v_price integer;
  v_headline text;
  v_visible integer;
begin
  /*
   * Become the consultant, exactly as PostgREST does with their
   * own JWT: the authenticated role, with their profile id as the
   * subject. Their own UPDATE policy applies, and so does the
   * column guard.
   */
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_pro::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  /*
   * Check 6, first: reading is untouched. A consultant must be
   * able to see and copy their own booking link - the lockdown is
   * on writes only.
   */
  select count(*) into v_visible
    from public.consultants c
   where c.id = v_con
     and c.consultant_slug is not null
     and c.direct_booking_price_cents is not null;

  if v_visible <> 1 then
    raise exception
      'VERIFICATION FAILED 6: a consultant can no longer read their own booking columns';
  end if;

  /* Check 2 — the booking link. */
  begin
    update public.consultants
       set consultant_slug = 'v49-stolen'
     where id = v_con;

    raise exception
      'VERIFICATION FAILED 2: a consultant changed their own consultant_slug through a direct write, bypassing the reserved set and admin management';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_SLUG_IMMUTABLE%' then
        raise;
      end if;
  end;

  /* And clearing it is a change too. */
  begin
    update public.consultants
       set consultant_slug = null
     where id = v_con;

    raise exception
      'VERIFICATION FAILED 2: a consultant cleared their own consultant_slug';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_SLUG_IMMUTABLE%' then
        raise;
      end if;
  end;

  /* Check 3 — whether the page is live. */
  begin
    update public.consultants
       set direct_booking_enabled = false
     where id = v_con;

    raise exception
      'VERIFICATION FAILED 3: a consultant changed direct_booking_enabled through a direct write, bypassing the publish preconditions';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_DIRECT_BOOKING_ENABLED_IMMUTABLE%' then
        raise;
      end if;
  end;

  /*
   * Check 4 — the price. This is the one with money attached: the
   * "at least the platform price" floor is enforced only by the
   * orchestrator, so a direct write was a way to undercut the
   * platform's own consultation through a page it hosts.
   */
  begin
    update public.consultants
       set direct_booking_price_cents = 1
     where id = v_con;

    raise exception
      'VERIFICATION FAILED 4: a consultant priced their own booking page through a direct write, below the platform floor';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_DIRECT_BOOKING_PRICE_IMMUTABLE%' then
        raise;
      end if;
  end;

  /*
   * Check 5 — what a consultant could always change, they still
   * can. This migration closes three columns; it does not turn the
   * row read-only.
   */
  update public.consultants
     set headline = 'Updated headline',
         bio = 'Updated bio',
         available_for_general = true
   where id = v_con;

  select c.headline into v_headline
    from public.consultants c where c.id = v_con;

  if v_headline <> 'Updated headline' then
    raise exception
      'VERIFICATION FAILED 5: a consultant can no longer update their own headline';
  end if;

  /*
   * Check 16 — and the columns closed before this migration are
   * still closed.
   */
  begin
    update public.consultants
       set is_active = false where id = v_con;

    raise exception
      'VERIFICATION FAILED 16: a consultant deactivated themselves';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%' then
        raise;
      end if;
  end;

  begin
    update public.consultants
       set gender = 'male' where id = v_con;

    raise exception
      'VERIFICATION FAILED 16: a consultant changed gender after onboarding completion';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_GENDER_IMMUTABLE%' then
        raise;
      end if;
  end;

  reset role;

  /* Nothing the guard refused actually landed. */
  select c.consultant_slug,
         c.direct_booking_enabled,
         c.direct_booking_price_cents
    into v_slug, v_enabled, v_price
    from public.consultants c where c.id = v_con;

  if v_slug <> 'v49-aisha'
     or v_enabled <> true
     or v_price <> 20000 then
    raise exception
      'VERIFICATION FAILED 2-4: the booking columns now read % / % / %',
      v_slug, v_enabled, v_price;
  end if;

  raise notice 'PASS 2-6, 16: a consultant reads all three columns and can write none of them, and everything else is as it was';
end $$;


-- ============================================================
-- PART 3 — THE GUARD, AS THE ORCHESTRATOR
-- ============================================================

-- Checks 7, 8, 9 and 10.

do $$
declare
  v_con uuid := current_setting('app.v49_con')::uuid;
  v_slug text;
  v_enabled boolean;
  v_price integer;
begin
  /*
   * The orchestrator holds the service role. Every sanctioned
   * write - the generator at activation, the admin slug endpoint,
   * the consultant's own price and enabled settings - arrives this
   * way, so if this is blocked the feature is dead.
   */
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  /* Check 7. */
  update public.consultants
     set consultant_slug = 'v49-renamed-by-admin'
   where id = v_con;

  /* Check 8. */
  update public.consultants
     set direct_booking_enabled = false
   where id = v_con;

  /* Check 9. */
  update public.consultants
     set direct_booking_price_cents = 25000
   where id = v_con;

  /*
   * Check 10 — and all three at once, which is the shape
   * saveDirectBookingSettings actually writes.
   */
  update public.consultants
     set consultant_slug = 'v49-final',
         direct_booking_enabled = true,
         direct_booking_price_cents = 30000
   where id = v_con;

  reset role;

  select c.consultant_slug,
         c.direct_booking_enabled,
         c.direct_booking_price_cents
    into v_slug, v_enabled, v_price
    from public.consultants c where c.id = v_con;

  if v_slug <> 'v49-final'
     or v_enabled <> true
     or v_price <> 30000 then
    raise exception
      'VERIFICATION FAILED 7-10: the orchestrator write produced % / % / %',
      v_slug, v_enabled, v_price;
  end if;

  /* The unique index is still the referee, privileged or not. */
  begin
    set local role service_role;

    update public.consultants
       set consultant_slug = 'v49-final'
     where id = current_setting('app.v49_other_con')::uuid;

    reset role;

    raise exception
      'VERIFICATION FAILED 11: two consultants now hold one booking link';
  exception
    when unique_violation then
      reset role;
  end;

  raise notice 'PASS 7-10: the orchestrator writes all three columns, and the unique index still arbitrates';
end $$;


rollback;


-- ============================================================
-- Confirm the rollback
-- ============================================================

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v49-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification profile(s) survived the rollback',
      v_left;
  end if;

  select count(*) into v_left
    from public.consultants
   where consultant_slug like 'v49-%';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification slug(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- This migration replaces one trigger function and writes no data.
-- Reverting it means restoring migration 026's body verbatim -
-- everything above the "migration 049 additions" block.
--
-- The consequence is that a consultant holding their own JWT can
-- again write consultant_slug, direct_booking_enabled and
-- direct_booking_price_cents directly through PostgREST, bypassing
-- the reserved-slug set, the price floor, the publish
-- preconditions and admin-only slug management. Every rule
-- governing those three columns lives in the orchestrator, so
-- reverting this does not relax them - it makes them optional.
--
-- Nothing else needs undoing. No table, column, index, constraint,
-- policy or grant was changed, and no slug validation was added to
-- SQL that would have to be removed.
-- ============================================================

do $$
begin
  raise notice
    'migration 049 verification complete: no check raised';
end $$;
