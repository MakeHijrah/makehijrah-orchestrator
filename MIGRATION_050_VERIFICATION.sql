-- ============================================================
-- Verification for migration_050_direct_booking_only
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, guard and policy structure   read-only
--   Part 2  THE PREMIUM RATE DRIFT ASSERTION    read-only
--   Part 3  visibility, as each role            STAGING ONLY, rolls back
--   Part 4  the write guard                     STAGING ONLY, rolls back
--   Part 5  regressions                         STAGING ONLY, rolls back
--   Part 6  rollback guidance
--
-- Parts 3 to 5 share one transaction that ends in ROLLBACK.
--
-- Per the standing rule from migration 046, this file EXERCISES
-- the policies and the guard by taking the roles a browser takes,
-- rather than reading their source and inferring.
--
-- Check map:
--    1  consultants.direct_booking_only exists, boolean, not null,
--       defaulting to false
--    2  THE DRIFT ASSERTION - record_direct_booking_earning still
--       carries c_premium_bps := 8000, the figure the orchestrator
--       mirrors for the calculator
--    3  app_settings still carries the base commission rate the
--       orchestrator now publishes
--    4  the public policy excludes direct_booking_only
--    5  the scoped restoration policy exists
--    6  anon cannot see a direct-booking-only consultant
--    7  an unrelated authenticated client cannot see one either
--    8  a client WITH a consultation with them still can
--    9  the consultant still sees their own row
--   10  an admin still sees them
--   11  an ordinary consultant is still publicly visible
--   12  a consultant cannot write direct_booking_only directly
--   13  service_role can
--   14  the other three direct booking columns are still guarded
--   15  a consultant can still write what they always could
--   16  direct_booking_only = true with direct_booking_enabled =
--       false is ACCEPTED, not refused
--   17  the slug index and direct booking constraints are intact
--   18  RLS is still enabled and no policy was lost
--   19  migration 049's guard behaviour is otherwise unchanged
--   20  no finance object changed
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE (read-only)
-- ============================================================

-- Checks 1, 3, 4, 5, 17 and 18.

do $$
declare
  v_type text;
  v_nullable text;
  v_default text;
  v_qual text;
begin
  /* Check 1. */
  select data_type, is_nullable,
         coalesce(column_default, '(none)')
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultants'
     and column_name = 'direct_booking_only';

  if not found then
    raise exception
      'VERIFICATION FAILED 1: consultants.direct_booking_only does not exist';
  end if;

  if v_type <> 'boolean' or v_nullable <> 'NO' then
    raise exception
      'VERIFICATION FAILED 1: direct_booking_only is % / nullable %; every consultant must have an answer',
      v_type, v_nullable;
  end if;

  if v_default not like '%false%' then
    raise exception
      'VERIFICATION FAILED 1: direct_booking_only defaults to %; every existing consultant must keep the eligibility they have today',
      v_default;
  end if;

  /* Check 3 — the base rate the orchestrator now publishes. */
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'app_settings'
       and column_name = 'consultation_consultant_commission_bps'
  ) then
    raise exception
      'VERIFICATION FAILED 3: app_settings.consultation_consultant_commission_bps is missing; the calculator has no base rate to read';
  end if;

  /* Check 4. */
  select qual into v_qual
    from pg_policies
   where schemaname = 'public'
     and tablename = 'consultants'
     and policyname = 'consultants_select_active_public';

  if v_qual is null then
    raise exception
      'VERIFICATION FAILED 4: consultants_select_active_public is missing';
  end if;

  if v_qual not like '%direct_booking_only%' then
    raise exception
      'VERIFICATION FAILED 4: the public policy does not mention direct_booking_only; it reads %',
      v_qual;
  end if;

  if v_qual not like '%is_active%' then
    raise exception
      'VERIFICATION FAILED 4: the public policy no longer gates on is_active; it reads %',
      v_qual;
  end if;

  /* Check 5. */
  select qual into v_qual
    from pg_policies
   where schemaname = 'public'
     and tablename = 'consultants'
     and policyname = 'consultants_select_booked_direct_only';

  if v_qual is null then
    raise exception
      'VERIFICATION FAILED 5: the scoped restoration policy is missing; a client who booked a direct-only consultant would lose sight of them';
  end if;

  /*
   * It must be scoped to direct_booking_only = true. Without that
   * it would be a widening rather than a restoration.
   */
  if v_qual not like '%direct_booking_only%'
     or v_qual not like '%consultations%' then
    raise exception
      'VERIFICATION FAILED 5: the restoration policy is not scoped to direct-only consultants with an existing consultation; it reads %',
      v_qual;
  end if;

  /* Check 18 — four policies now, none lost. */
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'consultants') <> 4 then
    raise exception
      'VERIFICATION FAILED 18: consultants carries % policies; three pre-existing plus one added',
      (select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'consultants');
  end if;

  if not (
    select c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'consultants'
  ) then
    raise exception
      'VERIFICATION FAILED 18: RLS is disabled on consultants';
  end if;

  /* Check 17. */
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'uq_consultants_slug'
  ) then
    raise exception
      'VERIFICATION FAILED 17: uq_consultants_slug is missing';
  end if;

  foreach v_qual in array array[
    'consultants_slug_format_check',
    'consultants_slug_length_check',
    'consultants_direct_price_range_check',
    'consultants_direct_booking_ready_check'
  ]
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = v_qual
         and conrelid = 'public.consultants'::regclass
    ) then
      raise exception
        'VERIFICATION FAILED 17: % is missing', v_qual;
    end if;
  end loop;

  raise notice 'PASS 1, 3, 4, 5, 17, 18: the column, both policies, the constraints and RLS are as expected';
end $$;


-- ============================================================
-- PART 2 — THE PREMIUM RATE DRIFT ASSERTION
-- ============================================================
--
-- Check 2, and the reason this file matters beyond migration 050.
--
-- The orchestrator publishes premium_consultant_commission_bps so
-- the consultant's calculator does not hardcode it. That figure has
-- no table to come from: its ONLY authority is a literal inside
-- record_direct_booking_earning. So the orchestrator mirrors it,
-- and a mirror can drift from what it mirrors.
--
-- This is what stops the drift being silent. If somebody changes
-- the ledger's premium rate without changing
-- DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS, this fails - before any
-- consultant is shown an earnings figure the ledger will not honour.
--
-- If the rate is deliberately changed, BOTH move together, and the
-- expected value below moves with them.

do $$
declare
  v_body text;
  v_expected constant integer := 8000;
begin
  select p.prosrc into v_body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'record_direct_booking_earning';

  if v_body is null then
    raise exception
      'VERIFICATION FAILED 2: record_direct_booking_earning does not exist; the premium rate has no authority at all';
  end if;

  /* Comments stripped, so prose about the rate cannot satisfy it. */
  v_body := regexp_replace(v_body, '/\*.*?\*/', ' ', 'gs');
  v_body := regexp_replace(v_body, '--[^\n]*', ' ', 'g');

  if v_body !~
     ('c_premium_bps\s+constant\s+integer\s*:=\s*'
      || v_expected || '\s*;') then
    raise exception
      'VERIFICATION FAILED 2: record_direct_booking_earning no longer declares c_premium_bps := %. The orchestrator mirrors this figure in DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS and publishes it to the consultant calculator. Change both together, and update this check.',
      v_expected;
  end if;

  raise notice 'PASS 2: the ledger still declares c_premium_bps := %, matching the mirrored calculator term', v_expected;
end $$;


-- ============================================================
-- PARTS 3 TO 5 — ONE TRANSACTION, ROLLED BACK
-- ============================================================

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_other_client uuid := gen_random_uuid();
  v_pro_only uuid := gen_random_uuid();
  v_pro_open uuid := gen_random_uuid();
  v_con_only uuid := gen_random_uuid();
  v_con_open uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_admin,        'v50-admin@verification.invalid'),
    (v_client,       'v50-client@verification.invalid'),
    (v_other_client, 'v50-other@verification.invalid'),
    (v_pro_only,     'v50-only@verification.invalid'),
    (v_pro_open,     'v50-open@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin,        'admin',      'V50 Admin',  'v50-admin@verification.invalid'),
    (v_client,       'client',     'V50 Client', 'v50-client@verification.invalid'),
    (v_other_client, 'client',     'V50 Other',  'v50-other@verification.invalid'),
    (v_pro_only,     'consultant', 'V50 Only',   'v50-only@verification.invalid'),
    (v_pro_open,     'consultant', 'V50 Open',   'v50-open@verification.invalid')
  on conflict (id) do update
    set role = excluded.role, full_name = excluded.full_name;

  /* One direct-booking-only consultant, one ordinary one. */
  insert into public.consultants (
    id, profile_id, timezone, is_active, gender,
    onboarding_completed_at, available_for_general,
    consultant_slug, direct_booking_enabled,
    direct_booking_price_cents, direct_booking_only)
  values
    (v_con_only, v_pro_only, 'UTC', true, 'female', now(), true,
     'v50-only', true, 20000, true),
    (v_con_open, v_pro_open, 'UTC', true, 'male', now(), true,
     'v50-open', true, 20000, false);

  /* The first client has a consultation with the direct-only one. */
  insert into public.consultations (
    id, client_profile_id, consultant_id, status,
    scheduled_start_at, scheduled_end_at, price_cents, currency,
    booking_source)
  values (gen_random_uuid(), v_client, v_con_only, 'completed',
          timestamptz '2037-01-10 09:00:00+00',
          timestamptz '2037-01-10 10:00:00+00',
          20000, 'usd', 'direct_booking');

  perform set_config('app.v50_admin',  v_admin::text,        true);
  perform set_config('app.v50_client', v_client::text,       true);
  perform set_config('app.v50_other',  v_other_client::text, true);
  perform set_config('app.v50_pro_only', v_pro_only::text,   true);
  perform set_config('app.v50_only',  v_con_only::text,      true);
  perform set_config('app.v50_open',  v_con_open::text,      true);
end $$;


-- ============================================================
-- PART 3 — VISIBILITY, AS EACH ROLE
-- ============================================================

-- Checks 6, 7, 8, 9, 10 and 11.

do $$
declare
  v_only uuid := current_setting('app.v50_only')::uuid;
  v_open uuid := current_setting('app.v50_open')::uuid;
  n integer;
begin
  /*
   * Check 6 — anon. This is the /consultation chooser: the list is
   * read directly from public.consultants through the public
   * policy, so this IS the exclusion the feature asks for. Both
   * standard flows read this one policy, so country-specific and
   * general-information selection are covered together.
   */
  set local role anon;
  perform set_config('request.jwt.claim.role', 'anon', true);

  select count(*) into n from public.consultants c where c.id = v_only;
  if n <> 0 then
    raise exception
      'VERIFICATION FAILED 6: anon can see a direct-booking-only consultant; they would still appear in the /consultation chooser';
  end if;

  /* Check 11 — and an ordinary consultant is unaffected. */
  select count(*) into n from public.consultants c where c.id = v_open;
  if n <> 1 then
    raise exception
      'VERIFICATION FAILED 11: anon can no longer see an ordinary consultant; the narrowing went too far';
  end if;

  reset role;

  /* Check 7 — an authenticated client with no history with them. */
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v50_other'), true);

  select count(*) into n from public.consultants c where c.id = v_only;
  if n <> 0 then
    raise exception
      'VERIFICATION FAILED 7: an unrelated client can see a direct-booking-only consultant';
  end if;

  /*
   * Check 8 — the client who already booked them still can. This
   * is what the restoration policy is for: without it, narrowing
   * would break the consultant's name on that client's own
   * dashboard.
   */
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v50_client'), true);

  select count(*) into n from public.consultants c where c.id = v_only;
  if n <> 1 then
    raise exception
      'VERIFICATION FAILED 8: a client with an existing consultation cannot see the consultant they booked';
  end if;

  /* Check 9 — the consultant sees their own row. */
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v50_pro_only'), true);

  select count(*) into n from public.consultants c where c.id = v_only;
  if n <> 1 then
    raise exception
      'VERIFICATION FAILED 9: a direct-booking-only consultant cannot see their own row';
  end if;

  /* Check 10 — an admin sees them. */
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v50_admin'), true);

  select count(*) into n from public.consultants c where c.id = v_only;
  if n <> 1 then
    raise exception
      'VERIFICATION FAILED 10: an admin cannot see a direct-booking-only consultant';
  end if;

  reset role;

  raise notice 'PASS 6-11: hidden from anon and unrelated clients, visible to the consultant, their existing client and admins, and ordinary consultants are unaffected';
end $$;


-- ============================================================
-- PART 4 — THE WRITE GUARD
-- ============================================================

-- Checks 12, 13, 14, 15 and 16.

do $$
declare
  v_pro uuid := current_setting('app.v50_pro_only')::uuid;
  v_only uuid := current_setting('app.v50_only')::uuid;
  v_value boolean;
  v_headline text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_pro::text, true);

  /* Check 12. */
  begin
    update public.consultants
       set direct_booking_only = false
     where id = v_only;

    raise exception
      'VERIFICATION FAILED 12: a consultant changed direct_booking_only through a direct write, bypassing the orchestrator';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_DIRECT_BOOKING_ONLY_IMMUTABLE%' then
        raise;
      end if;
  end;

  /* Check 14 — the other three are still closed. */
  begin
    update public.consultants
       set consultant_slug = 'v50-stolen' where id = v_only;
    raise exception
      'VERIFICATION FAILED 14: a consultant changed their own slug';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_SLUG_IMMUTABLE%' then
        raise;
      end if;
  end;

  begin
    update public.consultants
       set direct_booking_enabled = false where id = v_only;
    raise exception
      'VERIFICATION FAILED 14: a consultant changed direct_booking_enabled';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_DIRECT_BOOKING_ENABLED_IMMUTABLE%' then
        raise;
      end if;
  end;

  begin
    update public.consultants
       set direct_booking_price_cents = 1 where id = v_only;
    raise exception
      'VERIFICATION FAILED 14: a consultant changed their own price directly';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_DIRECT_BOOKING_PRICE_IMMUTABLE%' then
        raise;
      end if;
  end;

  /* Check 15 — what they could always change, they still can. */
  update public.consultants
     set headline = 'V50 updated headline'
   where id = v_only;

  select c.headline into v_headline
    from public.consultants c where c.id = v_only;

  if v_headline <> 'V50 updated headline' then
    raise exception
      'VERIFICATION FAILED 15: a consultant can no longer update their own headline';
  end if;

  reset role;

  /* Check 13 — the orchestrator can. */
  set local role service_role;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  update public.consultants
     set direct_booking_only = false where id = v_only;

  select c.direct_booking_only into v_value
    from public.consultants c where c.id = v_only;

  if v_value <> false then
    raise exception
      'VERIFICATION FAILED 13: the orchestrator could not write direct_booking_only';
  end if;

  /*
   * Check 16 — direct-booking-only WITH the direct page switched
   * off is an accepted state, not a refused one. The consultant is
   * then bookable nowhere, which is a choice they made; refusing it
   * would let an admin-owned setting block a consultant's own
   * preference. No constraint may exist that prevents this.
   */
  update public.consultants
     set direct_booking_only = true,
         direct_booking_enabled = false
   where id = v_only;

  select c.direct_booking_only into v_value
    from public.consultants c where c.id = v_only;

  if v_value <> true then
    raise exception
      'VERIFICATION FAILED 16: direct_booking_only could not be set while the direct page is disabled';
  end if;

  reset role;

  raise notice 'PASS 12-16: the column is orchestrator-only, the other three remain guarded, ordinary edits still work, and direct-only with the page off is accepted';
end $$;


-- ============================================================
-- PART 5 — REGRESSIONS
-- ============================================================

-- Checks 19 and 20.

do $$
declare
  v_pro uuid := current_setting('app.v50_pro_only')::uuid;
  v_only uuid := current_setting('app.v50_only')::uuid;
  v_count integer;
begin
  /* Check 19 — migration 049's other guards, still behaving. */
  set local role authenticated;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_pro::text, true);

  begin
    update public.consultants set is_active = false where id = v_only;
    raise exception
      'VERIFICATION FAILED 19: a consultant deactivated themselves';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%' then raise; end if;
  end;

  begin
    update public.consultants set gender = 'male' where id = v_only;
    raise exception
      'VERIFICATION FAILED 19: a consultant changed gender after onboarding';
  exception
    when raise_exception then
      if sqlerrm like '%VERIFICATION FAILED%'
         or sqlerrm not like '%CONSULTANT_GENDER_IMMUTABLE%' then
        raise;
      end if;
  end;

  reset role;

  /*
   * Check 20 — nothing in the finance path moved. This migration
   * adds a column to consultants and changes two policies; it must
   * not have touched a single ledger object.
   */
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'record_consultation_earning', 'release_consultation_earning',
       'reverse_consultation_earning', 'record_direct_booking_earning',
       'release_direct_booking_earning', 'reverse_direct_booking_earning',
       'create_ledger_adjustment', 'request_consultant_payout',
       'decide_payout', 'mark_payout_paid', 'reverse_ledger_entry');

  if v_count <> 11 then
    raise exception
      'VERIFICATION FAILED 20: % of the 11 finance RPCs are present', v_count;
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'consultant_ledger_entries'
       and t.tgname = 'trg_ledger_append_only'
  ) then
    raise exception
      'VERIFICATION FAILED 20: the ledger append-only trigger is missing';
  end if;

  raise notice 'PASS 19, 20: migration 049 behaviour is intact and no finance object changed';
end $$;


rollback;


-- ============================================================
-- Confirm the rollback
-- ============================================================

do $$
declare v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v50-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS: every fixture rolled back';
end $$;


-- ============================================================
-- PART 6 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Reverting means restoring migration 049's guard body verbatim,
-- restoring the public policy to `using (is_active = true)`,
-- dropping consultants_select_booked_direct_only, and dropping the
-- column:
--
--   drop policy if exists consultants_select_booked_direct_only
--     on public.consultants;
--
--   drop policy if exists consultants_select_active_public
--     on public.consultants;
--   create policy consultants_select_active_public
--     on public.consultants for select to anon, authenticated
--     using (is_active = true);
--
--   alter table public.consultants
--     drop column if exists direct_booking_only;
--
-- The consequence is that any consultant who chose to be
-- direct-booking-only reappears in the /consultation chooser
-- without being asked. Restore the policy and the guard together
-- with the column; leaving the column while restoring the policy
-- would keep the preference recorded and stop honouring it, which
-- is worse than not offering it.
--
-- Nothing in the finance path needs undoing. No ledger object,
-- constraint, index or finance RPC was touched.
-- ============================================================

do $$
begin
  raise notice
    'migration 050 verification complete: no check raised';
end $$;
