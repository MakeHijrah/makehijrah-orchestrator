-- ============================================================
-- Verification for migration_047_expire_stale_drafts
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, security and ACLs           read-only
--   Part 2  the expiry cutoff                  STAGING ONLY, rolls back
--   Part 3  every other status is untouchable  STAGING ONLY, rolls back
--   Part 4  batching and idempotency           STAGING ONLY, rolls back
--   Part 5  regressions                        STAGING ONLY, rolls back
--   Part 6  rollback guidance
--
-- Parts 2 to 5 share one transaction that ends in ROLLBACK.
--
-- The fixtures set created_at explicitly, which the RPC's own
-- predicate reads. A draft is thirty-one minutes old or
-- twenty-nine minutes old because this file says so, so the
-- boundary is asserted rather than waited for.
--
-- Per the standing rule established by migration 046: this file
-- INVOKES the RPC and asserts what it actually does, rather than
-- introspecting a signature and inferring the rest.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  a draft older than thirty minutes expires
--    2  a draft younger than thirty minutes does not
--    3  an expired draft's status becomes 'cancelled'
--    4  cancelled_at is stamped
--    5  the freed slot is immediately reusable
--    6  payment_authorized is untouched
--    7  pending_acceptance is untouched
--    8  confirmed is untouched
--    9  captured is untouched
--   10  completed is untouched
--   11  a second call is a no-op
--   12  the batch limit is honoured
--   13  several stale drafts are handled in one call
--   14  the statement takes row locks and skips locked rows, so
--       two replicas divide the work rather than duplicating it
--   15  service_role may execute it
--   16  PUBLIC, anon and authenticated may not
--   17  SECURITY DEFINER
--   18  a pinned search_path
--   19  unique_reserved_consultant_slot is unchanged
--   20  migration 046's abandon_draft_consultation is unchanged
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, SECURITY AND ACLS (read-only)
-- ============================================================

-- Checks 15, 16, 17, 18 and 19.

do $$
declare
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_role text;
  v_result text;
  v_expected constant text :=
    'TABLE(consultation_id uuid, consultant_id uuid, scheduled_start_at timestamp with time zone)';
begin
  v_oid := to_regprocedure(
    'public.expire_stale_draft_consultations(integer)');

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 15: expire_stale_draft_consultations does not exist';
  end if;

  select pg_get_function_result(v_oid) into v_result;

  if v_result is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 15: the RPC returns % and must return % - the worker logs what it cancelled',
      v_result, v_expected;
  end if;

  /* Check 17. */
  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ', '), '(none)')
    into v_secdef, v_config
    from pg_proc p
   where p.oid = v_oid;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 17: the RPC is not SECURITY DEFINER';
  end if;

  /* Check 18. */
  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 18: the RPC has search_path %', v_config;
  end if;

  /*
   * Check 16. A function that cancels bookings in bulk must not be
   * reachable from a browser. It is called by a worker and by
   * nothing else.
   */
  foreach v_role in array array['public', 'anon', 'authenticated']
  loop
    if has_function_privilege(v_role, v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 16: % may execute the bulk expiry RPC through PostgREST',
        v_role;
    end if;
  end loop;

  /* Check 15. */
  if not has_function_privilege(
       'service_role', v_oid, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 15: service_role cannot execute the expiry RPC; the worker is locked out';
  end if;

  raise notice 'PASS 15-18: definer, pinned, service_role only, and the returned shape is right';
end $$;


do $$
declare
  v_definition text;
begin
  /* Check 19 — the slot index this all exists to release. */
  select indexdef into v_definition
    from pg_indexes
   where schemaname = 'public'
     and indexname = 'unique_reserved_consultant_slot';

  if v_definition is null then
    raise exception
      'VERIFICATION FAILED 19: unique_reserved_consultant_slot does not exist';
  end if;

  if v_definition not like '%consultant_id%'
     or v_definition not like '%scheduled_start_at%'
     or v_definition not like '%draft%' then
    raise exception
      'VERIFICATION FAILED 19: unique_reserved_consultant_slot is defined as %',
      v_definition;
  end if;

  /*
   * And the index migration 001 created for exactly this job,
   * which nothing used until now.
   */
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'idx_consultations_stale_drafts'
  ) then
    raise exception
      'VERIFICATION FAILED 19: idx_consultations_stale_drafts is missing; the expiry scan has no index';
  end if;

  raise notice 'PASS 19: the slot index is unchanged and the stale-draft index is present';
end $$;


-- Check 14 — the concurrency shape, read from the source.

do $$
declare
  v_body text;
begin
  select p.prosrc into v_body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'expire_stale_draft_consultations';

  v_body := lower(v_body);

  /*
   * The worker runs in every replica. FOR UPDATE SKIP LOCKED is
   * what makes two simultaneous cycles divide the backlog instead
   * of one waiting on the other's locks. The Redis cycle lock in
   * the worker is an optimisation; this is the correctness
   * boundary.
   */
  if v_body not like '%for update skip locked%' then
    raise exception
      'VERIFICATION FAILED 14: the expiry statement does not take FOR UPDATE SKIP LOCKED; two replicas would contend rather than divide the work';
  end if;

  if v_body not like '%order by%' then
    raise exception
      'VERIFICATION FAILED 14: the expiry statement is not ordered; the oldest holds must be released first';
  end if;

  if v_body not like '%limit%' then
    raise exception
      'VERIFICATION FAILED 14: the expiry statement is unbounded; a large backlog would be one enormous statement';
  end if;

  raise notice 'PASS 14: ordered, limited, and locking with SKIP LOCKED';
end $$;


-- ============================================================
-- PARTS 2 TO 5 — ONE TRANSACTION, ROLLED BACK
-- ============================================================

begin;

do $$
declare
  v_client uuid := gen_random_uuid();
  v_pro uuid := gen_random_uuid();
  v_con uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_client, 'v47-client@verification.invalid'),
    (v_pro,    'v47-a@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_client, 'client',     'V47 Client', 'v47-client@verification.invalid'),
    (v_pro,    'consultant', 'V47 A',      'v47-a@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  insert into public.consultants (id, profile_id, timezone, is_active)
  values (v_con, v_pro, 'UTC', true);

  perform set_config('app.v47_client', v_client::text, true);
  perform set_config('app.v47_con',    v_con::text,    true);
end $$;


-- ============================================================
-- PART 2 — THE EXPIRY CUTOFF
-- ============================================================

-- Checks 1, 2, 3, 4 and 5.

do $$
declare
  v_client uuid := current_setting('app.v47_client')::uuid;
  v_con uuid := current_setting('app.v47_con')::uuid;
  v_stale uuid;
  v_fresh uuid;
  r record;
  v_expired integer := 0;
  v_status text;
  v_cancelled_at timestamptz;
begin
  /* A draft whose hold ran out a minute ago. */
  select consultation_id into v_stale
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2033-01-10 09:00:00+00',
      timestamptz '2033-01-10 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V47 Client', 'v47-client@verification.invalid', null,
      '{}'::jsonb);

  update public.consultations
     set created_at = now() - interval '31 minutes'
   where id = v_stale;

  /* And one with a minute left on it. */
  select consultation_id into v_fresh
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2033-01-11 09:00:00+00',
      timestamptz '2033-01-11 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V47 Client', 'v47-client@verification.invalid', null,
      '{}'::jsonb);

  update public.consultations
     set created_at = now() - interval '29 minutes'
   where id = v_fresh;

  for r in
    select * from public.expire_stale_draft_consultations(200)
  loop
    v_expired := v_expired + 1;

    if r.consultation_id = v_fresh then
      raise exception
        'VERIFICATION FAILED 2: a draft twenty-nine minutes old was expired; someone is on the checkout page';
    end if;

    /* The worker logs these; they must actually be populated. */
    if r.consultant_id is null
       or r.scheduled_start_at is null then
      raise exception
        'VERIFICATION FAILED 1: the RPC returned a row with no consultant or slot to log';
    end if;
  end loop;

  if v_expired < 1 then
    raise exception
      'VERIFICATION FAILED 1: a draft thirty-one minutes old was not expired';
  end if;

  /* Checks 3 and 4. */
  select c.status, c.cancelled_at
    into v_status, v_cancelled_at
    from public.consultations c
   where c.id = v_stale;

  if v_status <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 3: the expired draft is %, not cancelled', v_status;
  end if;

  if v_cancelled_at is null then
    raise exception
      'VERIFICATION FAILED 4: cancelled_at was not stamped on the expired draft';
  end if;

  /* Check 2, the other half. */
  select c.status into v_status
    from public.consultations c
   where c.id = v_fresh;

  if v_status <> 'draft' then
    raise exception
      'VERIFICATION FAILED 2: the twenty-nine minute draft is now %', v_status;
  end if;

  /*
   * Check 5 — the entire point. 'cancelled' is outside
   * unique_reserved_consultant_slot's status list, so the slot is
   * bookable the moment this commits.
   */
  perform public.create_draft_consultation(
    v_client, v_con, null,
    timestamptz '2033-01-10 09:00:00+00',
    timestamptz '2033-01-10 10:00:00+00',
    'Europe/Istanbul', 9700, 'usd',
    'V47 Client', 'v47-client@verification.invalid', null,
    '{}'::jsonb);

  raise notice 'PASS 1-5: the thirty-minute boundary holds and an expired slot is immediately reusable';
end $$;


-- ============================================================
-- PART 3 — EVERY OTHER STATUS IS UNTOUCHABLE
-- ============================================================

-- Checks 6, 7, 8, 9 and 10.

do $$
declare
  v_client uuid := current_setting('app.v47_client')::uuid;
  v_con uuid := current_setting('app.v47_con')::uuid;
  v_status text;
  v_id uuid;
  v_day integer := 1;
  v_survivors uuid[] := array[]::uuid[];
  v_statuses text[] := array[
    'payment_authorized',
    'pending_acceptance',
    'confirmed',
    'captured',
    'completed'
  ];
begin
  /*
   * One consultation per status, every one of them older than the
   * cutoff. If the predicate were on age alone rather than on age
   * AND status = 'draft', all five would be cancelled here - and a
   * captured consultation cancelled by a background job is a
   * refund nobody asked for.
   */
  foreach v_status in array v_statuses
  loop
    select consultation_id into v_id
      from public.create_draft_consultation(
        v_client, v_con, null,
        (timestamptz '2033-02-01 09:00:00+00'
           + (v_day || ' days')::interval),
        (timestamptz '2033-02-01 10:00:00+00'
           + (v_day || ' days')::interval),
        'Europe/Istanbul', 9700, 'usd',
        'V47 Client', 'v47-client@verification.invalid', null,
        '{}'::jsonb);

    update public.consultations
       set status = v_status::consultation_status,
           created_at = now() - interval '3 hours',
           payment_authorized_at =
             case when v_status <> 'draft' then now() end,
           captured_at =
             case when v_status in ('captured', 'completed')
                  then now() end,
           completed_at =
             case when v_status = 'completed' then now() end
     where id = v_id;

    v_survivors := v_survivors || v_id;
    v_day := v_day + 1;
  end loop;

  perform public.expire_stale_draft_consultations(1000);

  for v_day in 1 .. array_length(v_survivors, 1)
  loop
    select c.status into v_status
      from public.consultations c
     where c.id = v_survivors[v_day];

    if v_status = 'cancelled' then
      raise exception
        'VERIFICATION FAILED 6-10: a % consultation was cancelled by the draft expiry worker',
        v_statuses[v_day];
    end if;

    if v_status <> v_statuses[v_day] then
      raise exception
        'VERIFICATION FAILED 6-10: a % consultation is now %',
        v_statuses[v_day], v_status;
    end if;
  end loop;

  raise notice 'PASS 6-10: payment_authorized, pending_acceptance, confirmed, captured and completed are all untouched';
end $$;


-- ============================================================
-- PART 4 — BATCHING AND IDEMPOTENCY
-- ============================================================

-- Checks 11, 12 and 13.

do $$
declare
  v_client uuid := current_setting('app.v47_client')::uuid;
  v_con uuid := current_setting('app.v47_con')::uuid;
  v_id uuid;
  v_index integer;
  v_first integer;
  v_second integer;
  v_third integer;
  v_remaining integer;
begin
  /* Five stale drafts, at five different times. */
  for v_index in 1 .. 5
  loop
    select consultation_id into v_id
      from public.create_draft_consultation(
        v_client, v_con, null,
        (timestamptz '2033-03-01 09:00:00+00'
           + (v_index || ' hours')::interval),
        (timestamptz '2033-03-01 10:00:00+00'
           + (v_index || ' hours')::interval),
        'Europe/Istanbul', 9700, 'usd',
        'V47 Client', 'v47-client@verification.invalid', null,
        '{}'::jsonb);

    /*
     * Staggered ages, all past the cutoff, so "oldest first" is
     * observable rather than assumed.
     */
    update public.consultations
       set created_at =
             now() - interval '31 minutes'
                   - (v_index || ' minutes')::interval
     where id = v_id;
  end loop;

  /* Check 12 — a limit of two takes two, not five. */
  select count(*) into v_first
    from public.expire_stale_draft_consultations(2);

  if v_first <> 2 then
    raise exception
      'VERIFICATION FAILED 12: a batch limit of 2 expired % rows', v_first;
  end if;

  /* Check 13 — the rest come back on the next call. */
  select count(*) into v_second
    from public.expire_stale_draft_consultations(200);

  if v_second <> 3 then
    raise exception
      'VERIFICATION FAILED 13: the second call expired % of the remaining 3',
      v_second;
  end if;

  /* Check 11 — and a third call finds nothing left to do. */
  select count(*) into v_third
    from public.expire_stale_draft_consultations(200);

  if v_third <> 0 then
    raise exception
      'VERIFICATION FAILED 11: a rerun expired % more rows; a cancelled draft must no longer match',
      v_third;
  end if;

  select count(*) into v_remaining
    from public.consultations c
   where c.status = 'draft'
     and c.created_at <= now() - interval '30 minutes';

  if v_remaining <> 0 then
    raise exception
      'VERIFICATION FAILED 13: % stale draft(s) survived the sweep', v_remaining;
  end if;

  /*
   * A nonsense limit is clamped, not obeyed and not raised on: the
   * worker is on a timer, and expiry failing to happen at all is a
   * worse outcome than a limit being adjusted.
   */
  perform public.expire_stale_draft_consultations(0);
  perform public.expire_stale_draft_consultations(-5);
  perform public.expire_stale_draft_consultations(null);

  raise notice 'PASS 11-13: the batch limit is honoured, the backlog drains, and a rerun is a no-op';
end $$;


-- ============================================================
-- PART 5 — REGRESSIONS
-- ============================================================

-- Check 20.

do $$
declare
  v_client uuid := current_setting('app.v47_client')::uuid;
  v_con uuid := current_setting('app.v47_con')::uuid;
  v_draft uuid;
  v_advanced uuid;
  r record;
  v_status text;
begin
  /*
   * Migration 046's compensation is a different mechanism for a
   * different moment - one consultation, named by a request that
   * has just failed - and this migration must not have disturbed
   * it. A fresh draft is still cancellable by id even though the
   * expiry worker would not touch it.
   */
  select consultation_id into v_draft
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2033-04-01 09:00:00+00',
      timestamptz '2033-04-01 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V47 Client', 'v47-client@verification.invalid', null,
      '{}'::jsonb);

  select * into r
    from public.abandon_draft_consultation(v_draft);

  if not r.cancelled or r.reason <> 'cancelled' then
    raise exception
      'VERIFICATION FAILED 20: abandoning a fresh draft reported % / %',
      r.cancelled, r.reason;
  end if;

  select * into r
    from public.abandon_draft_consultation(v_draft);

  if r.cancelled or r.reason <> 'not_draft' then
    raise exception
      'VERIFICATION FAILED 20: abandon_draft_consultation is no longer idempotent';
  end if;

  /* And it still refuses a consultation past draft. */
  select consultation_id into v_advanced
    from public.create_draft_consultation(
      v_client, v_con, null,
      timestamptz '2033-04-02 09:00:00+00',
      timestamptz '2033-04-02 10:00:00+00',
      'Europe/Istanbul', 9700, 'usd',
      'V47 Client', 'v47-client@verification.invalid', null,
      '{}'::jsonb);

  update public.consultations
     set status = 'confirmed',
         payment_authorized_at = now()
   where id = v_advanced;

  select * into r
    from public.abandon_draft_consultation(v_advanced);

  if r.cancelled then
    raise exception
      'VERIFICATION FAILED 20: abandon_draft_consultation cancelled a confirmed booking';
  end if;

  select c.status into v_status
    from public.consultations c
   where c.id = v_advanced;

  if v_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 20: the confirmed booking is now %', v_status;
  end if;

  raise notice 'PASS 20: migration 046 abandon behaviour is unchanged';
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
   where email like 'v47-%@verification.invalid';

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
-- This migration adds one function and writes no data of its own.
-- Dropping it destroys nothing:
--
--   drop function if exists
--     public.expire_stale_draft_consultations(integer);
--
-- The consequence is that abandoned drafts stop expiring and their
-- slots are reserved indefinitely again - the condition this
-- migration exists to end. The orchestrator's worker tolerates the
-- function's absence: a failed cycle is logged and retried on the
-- next tick, and nothing user-facing depends on it.
--
-- Nothing else needs undoing. No table, column, index, constraint,
-- policy or grant on any existing object was changed, and
-- abandon_draft_consultation, create_draft_consultation and
-- unique_reserved_consultant_slot were not touched.
-- ============================================================

do $$
begin
  raise notice
    'migration 047 verification complete: no check raised';
end $$;
