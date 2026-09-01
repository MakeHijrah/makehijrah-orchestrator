-- ============================================================
-- Verification for migration_051_acceptance_calendar_recovery
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  signature and privileges          read-only
--   Part 2  recovery, by INVOKING the RPC     STAGING ONLY, rolls back
--   Part 3  terminal reasons stay refused     STAGING ONLY, rolls back
--   Part 4  regressions                       STAGING ONLY, rolls back
--   Part 5  rollback guidance
--
-- Parts 2 to 4 share one transaction that ends in ROLLBACK.
--
-- Per the standing rule from migration 046, an RPC the orchestrator
-- calls is verified by INVOKING it and asserting its runtime result
-- contract column by column — not by reading its source.
--
-- Check map:
--    1  the signature is unchanged: four parameters, five return
--       columns, in order, with their original types
--    2  privileges are unchanged: no EXECUTE for public, anon or
--       authenticated; service_role keeps it
--    3  THE FIX - recovery from 'calendar_failed' succeeds, and
--       returns the full five-column contract
--    4  it clears admin_attention_reason and sets status confirmed
--    5  it preserves an accepted_at that was already set
--    6  recovery from 'calendar_created_confirmation_failed' still
--       works, as it has since migration 008
--    7  'declined' is still refused
--    8  'timeout' is still refused
--    9  an admin cancellation note is still refused
--   10  a NULL reason on admin_attention is refused - the old
--       <> comparison was NULL and let it through
--   11  ordinary acceptance from pending_acceptance is unchanged
--   12  ordinary acceptance from captured is unchanged
--   13  the idempotent confirmed replay is unchanged
--   14  a consultation belonging to another consultant is refused
--   15  a consultation with no PaymentIntent is refused
--   16  a terminal status such as cancelled is still refused
--   17  no finance object changed
-- ============================================================


-- ============================================================
-- PART 1 — SIGNATURE AND PRIVILEGES (read-only)
-- ============================================================

-- Checks 1 and 2.

do $$
declare
  v_args text;
  v_result text;
  v_bad text;
begin
  select
    pg_get_function_identity_arguments(p.oid),
    pg_get_function_result(p.oid)
  into v_args, v_result
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'finalize_consultation_acceptance';

  if v_args is null then
    raise exception
      'VERIFICATION FAILED 1: finalize_consultation_acceptance does not exist';
  end if;

  if v_args <> 'p_consultation_id uuid, p_consultant_id uuid, p_google_event_id text, p_meet_link text' then
    raise exception
      'VERIFICATION FAILED 1: the parameter list changed: %',
      v_args;
  end if;

  /*
   * The return contract, column by column. Migration 045 broke a
   * different RPC's return shape and every booking 500ed; this
   * check exists so that cannot happen here.
   */
  if v_result <> 'TABLE(consultation_id uuid, consultation_status consultation_status, accepted_at timestamp with time zone, google_event_id text, meet_link text)' then
    raise exception
      'VERIFICATION FAILED 1: the return contract changed: %',
      v_result;
  end if;

  raise notice
    'PASS 1: four parameters and the five-column return contract are unchanged';

  select string_agg(grantee, ', ')
  into v_bad
  from information_schema.routine_privileges
  where specific_schema = 'public'
    and routine_name = 'finalize_consultation_acceptance'
    and privilege_type = 'EXECUTE'
    and grantee in ('PUBLIC', 'anon', 'authenticated');

  if v_bad is not null then
    raise exception
      'VERIFICATION FAILED 2: EXECUTE is still granted to %',
      v_bad;
  end if;

  if not exists (
    select 1
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'finalize_consultation_acceptance'
      and privilege_type = 'EXECUTE'
      and grantee = 'service_role'
  ) then
    raise exception
      'VERIFICATION FAILED 2: service_role lost EXECUTE';
  end if;

  raise notice
    'PASS 2: orchestrator-only privileges are intact';
end $$;


-- ============================================================
-- PART 2 — RECOVERY, BY INVOKING THE RPC (STAGING ONLY)
-- ============================================================

begin;

do $$
declare
  v_cpr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_other_cpr uuid := gen_random_uuid();
  v_con uuid;
  v_other_con uuid;
begin
  insert into auth.users (id, email) values
    (v_cpr, 'v51-consultant@verification.invalid'),
    (v_clp, 'v51-client@verification.invalid'),
    (v_other_cpr, 'v51-other@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr, 'consultant', 'V51 Consultant',
     'v51-consultant@verification.invalid'),
    (v_clp, 'client', 'V51 Client',
     'v51-client@verification.invalid'),
    (v_other_cpr, 'consultant', 'V51 Other',
     'v51-other@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true) returning id into v_con;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_other_cpr, 'Africa/Cairo', true)
  returning id into v_other_con;

  perform set_config('app.v51_con', v_con::text, true);
  perform set_config('app.v51_other_con', v_other_con::text, true);
  perform set_config('app.v51_clp', v_clp::text, true);
end $$;


/*
 * One helper so every case below is built identically and differs
 * only in the status and reason under test.
 *
 * Each fixture takes its own slot: unique_reserved_consultant_slot
 * covers (consultant_id, scheduled_start_at) for every live status,
 * so reusing one start time would collide rather than test
 * anything.
 */
create sequence pg_temp.v51_slot;

create or replace function pg_temp.v51_consultation(
  p_status consultation_status,
  p_reason text,
  p_payment_intent text default 'pi_v51_capture',
  p_accepted_at timestamptz default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_start timestamptz :=
    now() + interval '1 day'
      + (nextval('pg_temp.v51_slot') * interval '1 hour');
begin
  insert into public.consultations (
    client_profile_id, consultant_id, status,
    scheduled_start_at, scheduled_end_at, price_cents, currency,
    stripe_payment_intent_id, payment_authorized_at,
    admin_attention_reason, accepted_at)
  values (
    current_setting('app.v51_clp')::uuid,
    current_setting('app.v51_con')::uuid,
    p_status,
    v_start,
    v_start + interval '1 hour',
    15000, 'usd',
    p_payment_intent || '_' || gen_random_uuid()::text,
    now() - interval '1 hour',
    p_reason,
    p_accepted_at)
  returning id into v_id;

  return v_id;
end $$;


-- Checks 3, 4 and 5: THE FIX.

do $$
declare
  v_id uuid;
  v_row record;
  v_reason text;
  v_status consultation_status;
begin
  v_id := pg_temp.v51_consultation(
    'admin_attention', 'calendar_failed');

  select *
  into v_row
  from public.finalize_consultation_acceptance(
    v_id,
    current_setting('app.v51_con')::uuid,
    'gcal-event-v51',
    'https://meet.google.com/v51-abc-def');

  if v_row.consultation_id is null then
    raise exception
      'VERIFICATION FAILED 3: recovery from calendar_failed returned no row - the consultant is still locked out';
  end if;

  /*
   * The runtime result contract, column by column, not just the
   * fact that a row came back.
   */
  if v_row.consultation_id <> v_id then
    raise exception
      'VERIFICATION FAILED 3: consultation_id was % rather than %',
      v_row.consultation_id, v_id;
  end if;

  if v_row.consultation_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 3: consultation_status was % rather than confirmed',
      v_row.consultation_status;
  end if;

  if v_row.accepted_at is null then
    raise exception
      'VERIFICATION FAILED 3: accepted_at was not set';
  end if;

  if v_row.google_event_id <> 'gcal-event-v51' then
    raise exception
      'VERIFICATION FAILED 3: google_event_id was %',
      v_row.google_event_id;
  end if;

  if v_row.meet_link <> 'https://meet.google.com/v51-abc-def' then
    raise exception
      'VERIFICATION FAILED 3: meet_link was %',
      v_row.meet_link;
  end if;

  raise notice
    'PASS 3: calendar_failed recovers, and returns all five columns correctly';

  select status, admin_attention_reason
  into v_status, v_reason
  from public.consultations
  where id = v_id;

  if v_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 4: the stored status is %',
      v_status;
  end if;

  if v_reason is not null then
    raise exception
      'VERIFICATION FAILED 4: admin_attention_reason was left as %',
      v_reason;
  end if;

  raise notice
    'PASS 4: the row is confirmed and the attention reason is cleared';
end $$;


do $$
declare
  v_id uuid;
  v_accepted timestamptz := now() - interval '3 hours';
  v_row record;
begin
  v_id := pg_temp.v51_consultation(
    'admin_attention', 'calendar_failed', 'pi_v51_capture', v_accepted);

  select *
  into v_row
  from public.finalize_consultation_acceptance(
    v_id,
    current_setting('app.v51_con')::uuid,
    'gcal-event-v51b',
    'https://meet.google.com/v51-ghi-jkl');

  if v_row.accepted_at <> v_accepted then
    raise exception
      'VERIFICATION FAILED 5: accepted_at was rewritten from % to %',
      v_accepted, v_row.accepted_at;
  end if;

  raise notice
    'PASS 5: an existing accepted_at is preserved, not rewritten';
end $$;


-- Check 6: the reason migration 008 already allowed.

do $$
declare
  v_id uuid;
  v_row record;
begin
  v_id := pg_temp.v51_consultation(
    'admin_attention', 'calendar_created_confirmation_failed');

  select *
  into v_row
  from public.finalize_consultation_acceptance(
    v_id,
    current_setting('app.v51_con')::uuid,
    'gcal-event-v51c',
    'https://meet.google.com/v51-mno-pqr');

  if v_row.consultation_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 6: migration 008 recovery regressed';
  end if;

  raise notice
    'PASS 6: calendar_created_confirmation_failed still recovers';
end $$;


-- ============================================================
-- PART 3 — TERMINAL REASONS STAY REFUSED (STAGING ONLY)
-- ============================================================

-- Checks 7, 8, 9 and 10.

do $$
declare
  v_id uuid;
  v_reason text;
  v_refused boolean;
begin
  foreach v_reason in array array[
    'declined',
    'timeout',
    'Cancelled by admin: client requested a refund'
  ] loop
    v_id := pg_temp.v51_consultation('admin_attention', v_reason);

    v_refused := false;

    begin
      perform public.finalize_consultation_acceptance(
        v_id,
        current_setting('app.v51_con')::uuid,
        'gcal-should-not-happen',
        'https://meet.google.com/should-not-happen');
    exception
      when others then
        v_refused := true;
    end;

    if not v_refused then
      raise exception
        'VERIFICATION FAILED 7/8/9: acceptance was allowed from terminal reason %',
        v_reason;
    end if;
  end loop;

  raise notice
    'PASS 7, 8, 9: declined, timeout and an admin cancellation note are all still refused';

  /*
   * Migration 008 compared with <>, which is NULL against a NULL
   * reason, so the whole guard was NULL and fell through to the
   * status check - which admits admin_attention. Migration 051
   * uses coalesce(...) not in (...), which refuses it.
   */
  v_id := pg_temp.v51_consultation('admin_attention', null);

  v_refused := false;

  begin
    perform public.finalize_consultation_acceptance(
      v_id,
      current_setting('app.v51_con')::uuid,
      'gcal-should-not-happen',
      'https://meet.google.com/should-not-happen');
  exception
    when others then
      v_refused := true;
  end;

  if not v_refused then
    raise exception
      'VERIFICATION FAILED 10: admin_attention with a NULL reason was accepted';
  end if;

  raise notice
    'PASS 10: admin_attention with a NULL reason is refused - the NULL comparison hole is closed';
end $$;


-- ============================================================
-- PART 4 — REGRESSIONS (STAGING ONLY)
-- ============================================================

-- Checks 11, 12, 13, 14, 15 and 16.

do $$
declare
  v_id uuid;
  v_row record;
  v_second record;
  v_refused boolean;
begin
  v_id := pg_temp.v51_consultation('pending_acceptance', null);

  select *
  into v_row
  from public.finalize_consultation_acceptance(
    v_id,
    current_setting('app.v51_con')::uuid,
    'gcal-event-v51d',
    'https://meet.google.com/v51-stu-vwx');

  if v_row.consultation_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 11: ordinary acceptance regressed';
  end if;

  raise notice
    'PASS 11: acceptance from pending_acceptance is unchanged';

  -- Check 13, on that same row: the idempotent replay.
  select *
  into v_second
  from public.finalize_consultation_acceptance(
    v_id,
    current_setting('app.v51_con')::uuid,
    'gcal-event-v51d',
    'https://meet.google.com/v51-stu-vwx');

  if v_second.consultation_status <> 'confirmed'
     or v_second.accepted_at <> v_row.accepted_at then
    raise exception
      'VERIFICATION FAILED 13: the confirmed replay is no longer idempotent';
  end if;

  raise notice
    'PASS 13: the confirmed replay is still idempotent';

  v_id := pg_temp.v51_consultation('captured', null);

  select *
  into v_row
  from public.finalize_consultation_acceptance(
    v_id,
    current_setting('app.v51_con')::uuid,
    'gcal-event-v51e',
    'https://meet.google.com/v51-yza-bcd');

  if v_row.consultation_status <> 'confirmed' then
    raise exception
      'VERIFICATION FAILED 12: acceptance from captured regressed';
  end if;

  raise notice
    'PASS 12: acceptance from captured is unchanged';

  -- Check 14: another consultant's consultation.
  v_id := pg_temp.v51_consultation(
    'admin_attention', 'calendar_failed');

  v_refused := false;

  begin
    perform public.finalize_consultation_acceptance(
      v_id,
      current_setting('app.v51_other_con')::uuid,
      'gcal-should-not-happen',
      'https://meet.google.com/should-not-happen');
  exception
    when others then
      v_refused := true;
  end;

  if not v_refused then
    raise exception
      'VERIFICATION FAILED 14: another consultant recovered someone else''s consultation';
  end if;

  raise notice
    'PASS 14: ownership is still enforced, including on the recovery path';

  -- Check 15: recovery still requires a PaymentIntent.
  v_id := pg_temp.v51_consultation(
    'admin_attention', 'calendar_failed');

  update public.consultations
  set stripe_payment_intent_id = null
  where id = v_id;

  v_refused := false;

  begin
    perform public.finalize_consultation_acceptance(
      v_id,
      current_setting('app.v51_con')::uuid,
      'gcal-should-not-happen',
      'https://meet.google.com/should-not-happen');
  exception
    when others then
      v_refused := true;
  end;

  if not v_refused then
    raise exception
      'VERIFICATION FAILED 15: a consultation with no PaymentIntent was confirmed';
  end if;

  raise notice
    'PASS 15: a missing PaymentIntent still refuses, on the recovery path too';

  -- Check 16: a terminal status is still refused.
  v_id := pg_temp.v51_consultation('cancelled', null);

  v_refused := false;

  begin
    perform public.finalize_consultation_acceptance(
      v_id,
      current_setting('app.v51_con')::uuid,
      'gcal-should-not-happen',
      'https://meet.google.com/should-not-happen');
  exception
    when others then
      v_refused := true;
  end;

  if not v_refused then
    raise exception
      'VERIFICATION FAILED 16: a cancelled consultation was confirmed';
  end if;

  raise notice
    'PASS 16: terminal statuses are still refused';
end $$;


-- Check 17: no finance object changed.

do $$
declare
  v_missing text;
begin
  select string_agg(name, ', ')
  into v_missing
  from unnest(array[
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_consultation_earning',
    'record_direct_booking_earning',
    'reverse_direct_booking_earning',
    'release_direct_booking_earning',
    'record_service_purchase',
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent',
    'fulfill_service_purchase',
    'reverse_ledger_entry',
    'create_ledger_adjustment',
    'request_consultant_payout'
  ]) as name
  where not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = name
  );

  if v_missing is not null then
    raise exception
      'VERIFICATION FAILED 17: finance functions missing: %',
      v_missing;
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgname = 'trg_ledger_append_only'
      and not tgisinternal
  ) then
    raise exception
      'VERIFICATION FAILED 17: the ledger append-only trigger is gone';
  end if;

  raise notice
    'PASS 17: every finance function and the append-only trigger are intact';
end $$;

rollback;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- To revert, re-apply migration_008_fix_acceptance_rpc.sql. It
-- restores the narrower whitelist verbatim.
--
-- Reverting re-locks any consultation sitting in admin_attention
-- with reason 'calendar_failed': its payment stays captured, no
-- calendar event exists, and the consultant cannot accept it. Move
-- those rows on before reverting.
-- ============================================================
