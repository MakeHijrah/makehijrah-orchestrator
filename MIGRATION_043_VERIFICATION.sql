-- ============================================================
-- Verification for migration_043_service_refund_cumulative
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  the signature changed             read-only
--   Part 2  cumulative arithmetic             STAGING ONLY, rolls back
--   Part 3  the properties migration 040 got
--           right, still right                STAGING ONLY, rolls back
--   Part 4  regressions                       read-only
--   Part 5  rollback guidance
--
-- Parts 2 and 3 share one transaction that ends in ROLLBACK.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Three of these checks — 3, 5 and 6 — FAIL against migration 040
-- and pass against 043. They are the reason this migration exists,
-- so they are written to describe the money rather than the code:
-- what a consultant is owed after a sequence of real refunds.
--
-- Check map:
--    1  the cumulative parameter exists and the delta parameter
--       is gone, with exactly one function of each name
--    2  a first partial refund applies in full
--    3  a DUPLICATE partial delivery is an exact no-op
--    4  a larger cumulative total applies only the difference
--    5  three partials accumulate to the right total and reverse
--       exactly the right amount
--    6  partial then full completes to the gross and moves the
--       status, reversing only what remained
--    7  a target above the gross is refused
--    8  a single full refund still works
--    9  a duplicate FULL delivery still no-ops
--   10  refund after fulfilment reverses an AVAILABLE earning
--   11  refunding a paid-out earning drives the balance negative
--   12  an unattributed purchase records its refund with no
--       ledger entry
--   13  both functions are SECURITY DEFINER, pinned, and
--       service_role only
--   14  migrations 034 and 038-042 are intact
-- ============================================================


-- ============================================================
-- PART 1 — THE SIGNATURE CHANGED (read-only)
-- ============================================================

-- Check 1.
--
-- The rename is the safety mechanism, not cosmetics: the types are
-- identical, so without it a positional caller would silently pass
-- a delta where a total is now expected.

do $$
declare
  v_name text;
  v_args text;
  v_count integer;
begin
  foreach v_name in array array[
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent'
  ]
  loop
    select count(*) into v_count
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;

    if v_count <> 1 then
      raise exception
        'VERIFICATION FAILED 1: % has % definition(s), expected exactly 1 — a leftover overload would let a stale caller keep delta semantics',
        v_name, v_count;
    end if;

    select array_to_string(p.proargnames, ', ')
      into v_args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;

    if v_args not like '%p_refunded_total_minor%' then
      raise exception
        'VERIFICATION FAILED 1: % takes [%]; the cumulative parameter is missing',
        v_name, v_args;
    end if;

    if v_args like '%p_gross_amount_minor%' then
      raise exception
        'VERIFICATION FAILED 1: % still takes p_gross_amount_minor; the delta interpretation survives',
        v_name;
    end if;
  end loop;

  raise notice
    'PASS 1: both functions take p_refunded_total_minor, the delta parameter is gone, and neither has an overload';
end $$;


-- ============================================================
-- PART 2 — CUMULATIVE ARITHMETIC (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_cpr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con uuid;
  v_consultation uuid;
  v_svc uuid;
begin
  insert into auth.users (id, email) values
    (v_cpr, 'v43-consultant@verification.invalid'),
    (v_clp, 'v43-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr, 'consultant', 'V43 Consultant',
     'v43-consultant@verification.invalid'),
    (v_clp, 'client', 'V43 Client',
     'v43-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true) returning id into v_con;

  insert into public.consultations (client_profile_id, consultant_id)
  values (v_clp, v_con) returning id into v_consultation;

  /* 5000 bps keeps the arithmetic legible: half of every refund. */
  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V43 Service', 'one_time', 10000, 'usd', 5000, true)
  returning id into v_svc;

  perform set_config('app.v43_con', v_con::text, true);
  perform set_config('app.v43_clp', v_clp::text, true);
  perform set_config('app.v43_svc', v_svc::text, true);
  perform set_config('app.v43_consultation', v_consultation::text, true);
end $$;


/*
 * A purchase plus its earning, built the way record_service_purchase
 * builds them, so each check below starts from a clean 10000 / 5000
 * position.
 */
create or replace function pg_temp.v43_new_purchase(
  p_suffix text
)
returns uuid
language plpgsql
as $$
declare
  v_purchase uuid;
begin
  insert into public.service_purchases (
    service_id, consultation_id, client_profile_id,
    attributed_consultant_id, gross_amount_minor, currency,
    billing_type, billing_period_sequence, status, stripe_mode,
    stripe_payment_intent_id)
  values (
    current_setting('app.v43_svc')::uuid,
    current_setting('app.v43_consultation')::uuid,
    current_setting('app.v43_clp')::uuid,
    current_setting('app.v43_con')::uuid,
    10000, 'usd', 'one_time', 1, 'paid', 'test',
    'pi_v43_' || p_suffix)
  returning id into v_purchase;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at)
  values (
    current_setting('app.v43_con')::uuid, 'earning',
    'service_purchase', v_purchase, 10000, 5000, 5000, 5000,
    'service_rate', 'usd', null);

  return v_purchase;
end;
$$;


/* The consultant's net position on one purchase, from the ledger. */
create or replace function pg_temp.v43_net(p_purchase uuid)
returns integer
language sql
as $$
  select coalesce(sum(consultant_amount_minor), 0)::integer
    from public.consultant_ledger_entries
   where source_type = 'service_purchase'
     and source_id = p_purchase;
$$;


-- Checks 2 and 3 — a first partial, then the SAME event again.

do $$
declare
  v_purchase uuid := pg_temp.v43_new_purchase('dup');
  r record;
begin
  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'stripe refund', 3000);

  if r.refunded_amount_minor <> 3000
     or r.applied_delta_minor <> 3000
     or r.status <> 'paid' then
    raise exception
      'VERIFICATION FAILED 2: first partial recorded % refunded, delta %, status %; expected 3000 / 3000 / paid',
      r.refunded_amount_minor, r.applied_delta_minor, r.status;
  end if;

  if pg_temp.v43_net(v_purchase) <> 3500 then
    raise exception
      'VERIFICATION FAILED 2: consultant net is % after a 3000 refund, expected 3500 (5000 - 1500)',
      pg_temp.v43_net(v_purchase);
  end if;

  /*
   * The same webhook delivered twice. Under migration 040 this
   * added 3000 again and reversed another 1500.
   */
  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'stripe refund', 3000);

  if r.reversed or r.applied_delta_minor <> 0
     or r.reason <> 'no_change' then
    raise exception
      'VERIFICATION FAILED 3: a duplicate delivery reported reversed=% delta=% reason=%',
      r.reversed, r.applied_delta_minor, r.reason;
  end if;

  if r.refunded_amount_minor <> 3000 then
    raise exception
      'VERIFICATION FAILED 3: a duplicate delivery moved the refunded total to %',
      r.refunded_amount_minor;
  end if;

  if pg_temp.v43_net(v_purchase) <> 3500 then
    raise exception
      'VERIFICATION FAILED 3: a duplicate delivery changed the consultant net to %, expected 3500',
      pg_temp.v43_net(v_purchase);
  end if;

  raise notice
    'PASS 2 and 3: a first partial applies in full, and redelivering the same total is an exact no-op';
end $$;


-- Checks 4 and 5 — a second and third partial.

do $$
declare
  v_purchase uuid := pg_temp.v43_new_purchase('multi');
  r record;
begin
  perform public.reverse_service_purchase_earning(
    v_purchase, 'refund one', 3000);

  /* Stripe now reports 5000 cumulative, i.e. a further 2000. */
  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'refund two', 5000);

  if r.applied_delta_minor <> 2000 then
    raise exception
      'VERIFICATION FAILED 4: the second partial applied a delta of %, expected 2000 — a cumulative total must not be added to a running one',
      r.applied_delta_minor;
  end if;

  if r.refunded_amount_minor <> 5000 or r.status <> 'paid' then
    raise exception
      'VERIFICATION FAILED 4: after two partials refunded is %, status %; expected 5000 / paid',
      r.refunded_amount_minor, r.status;
  end if;

  if r.consultant_amount_minor <> -1000 then
    raise exception
      'VERIFICATION FAILED 4: the second reversal took % from the consultant, expected -1000 (half of 2000)',
      r.consultant_amount_minor;
  end if;

  /* A third, to 8000 cumulative. */
  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'refund three', 8000);

  if r.applied_delta_minor <> 3000
     or r.refunded_amount_minor <> 8000 then
    raise exception
      'VERIFICATION FAILED 5: the third partial applied % to reach %, expected 3000 to reach 8000',
      r.applied_delta_minor, r.refunded_amount_minor;
  end if;

  /* 5000 earned, 8000 of 10000 refunded -> 4000 reversed. */
  if pg_temp.v43_net(v_purchase) <> 1000 then
    raise exception
      'VERIFICATION FAILED 5: after 8000 of 10000 refunded the consultant net is %, expected 1000',
      pg_temp.v43_net(v_purchase);
  end if;

  raise notice
    'PASS 4 and 5: successive cumulative totals apply only their difference, and three partials leave the consultant owed exactly the unrefunded share';
end $$;


-- Check 6 — partial, then the full gross.

do $$
declare
  v_purchase uuid := pg_temp.v43_new_purchase('thenfull');
  r record;
begin
  perform public.reverse_service_purchase_earning(
    v_purchase, 'partial', 3000);

  /*
   * Under migration 040 this raised FINANCE_REFUND_EXCEEDS_PURCHASE
   * and the reversal was silently dropped by the webhook wrapper.
   */
  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'the rest', 10000);

  if r.applied_delta_minor <> 7000 then
    raise exception
      'VERIFICATION FAILED 6: completing the refund applied %, expected 7000',
      r.applied_delta_minor;
  end if;

  if r.refunded_amount_minor <> 10000
     or r.status <> 'refunded' then
    raise exception
      'VERIFICATION FAILED 6: after the full refund refunded is %, status %; expected 10000 / refunded',
      r.refunded_amount_minor, r.status;
  end if;

  if (select refunded_at from public.service_purchases
       where id = v_purchase) is null then
    raise exception
      'VERIFICATION FAILED 6: a fully refunded purchase carries no refunded_at';
  end if;

  if pg_temp.v43_net(v_purchase) <> 0 then
    raise exception
      'VERIFICATION FAILED 6: after a complete refund the consultant net is %, expected 0',
      pg_temp.v43_net(v_purchase);
  end if;

  raise notice
    'PASS 6: partial then full completes to the gross, reverses only what remained, and leaves the consultant owed nothing';
end $$;


-- Check 7 — a target above the gross.

do $$
declare
  v_purchase uuid := pg_temp.v43_new_purchase('over');
  v_refused boolean := false;
begin
  begin
    perform public.reverse_service_purchase_earning(
      v_purchase, 'impossible', 10001);
    raise exception
      'VERIFICATION FAILED 7: a refunded total above the gross was accepted';
  exception when raise_exception then
    if sqlerrm not like '%FINANCE_REFUND_EXCEEDS_PURCHASE%' then
      raise;
    end if;
    v_refused := true;
  end;

  if not v_refused then
    raise exception
      'VERIFICATION FAILED 7: the gross bound is not enforced';
  end if;

  if (select refunded_amount_minor from public.service_purchases
       where id = v_purchase) <> 0 then
    raise exception
      'VERIFICATION FAILED 7: a refused total still moved the refunded amount';
  end if;

  raise notice
    'PASS 7: a total above the gross is refused rather than clamped, and changes nothing';
end $$;


-- Checks 8 and 9 — the cases migration 040 already got right.

do $$
declare
  v_purchase uuid := pg_temp.v43_new_purchase('full');
  r record;
begin
  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'full refund', 10000);

  if r.refunded_amount_minor <> 10000
     or r.status <> 'refunded'
     or r.applied_delta_minor <> 10000 then
    raise exception
      'VERIFICATION FAILED 8: a single full refund recorded % / % / delta %',
      r.refunded_amount_minor, r.status, r.applied_delta_minor;
  end if;

  if pg_temp.v43_net(v_purchase) <> 0 then
    raise exception
      'VERIFICATION FAILED 8: the consultant net after a full refund is %, expected 0',
      pg_temp.v43_net(v_purchase);
  end if;

  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'redelivered', 10000);

  if r.reversed or r.reason <> 'already_refunded'
     or r.applied_delta_minor <> 0 then
    raise exception
      'VERIFICATION FAILED 9: a redelivered full refund reported reversed=% reason=% delta=%',
      r.reversed, r.reason, r.applied_delta_minor;
  end if;

  if pg_temp.v43_net(v_purchase) <> 0 then
    raise exception
      'VERIFICATION FAILED 9: a redelivered full refund changed the consultant net to %',
      pg_temp.v43_net(v_purchase);
  end if;

  raise notice
    'PASS 8 and 9: a single full refund still works and a redelivery of it still no-ops';
end $$;


-- ============================================================
-- PART 3 — THE PROPERTIES THAT MUST NOT REGRESS (rolls back)
-- ============================================================

-- Checks 10 and 11.

do $$
declare
  v_purchase uuid := pg_temp.v43_new_purchase('avail');
  v_entry uuid;
  v_payout uuid;
  v_available bigint;
  r record;
begin
  /* Fulfilment: the earning becomes available. */
  update public.consultant_ledger_entries
     set available_at = now()
   where source_id = v_purchase
     and entry_type = 'earning'
  returning id into v_entry;

  update public.service_purchases
     set status = 'fulfilled', fulfilled_at = now()
   where id = v_purchase;

  select available_minor into v_available
    from public.consultant_balances
   where consultant_id = current_setting('app.v43_con')::uuid
     and currency = 'usd';

  if v_available < 5000 then
    raise exception
      'VERIFICATION FAILED 10: available is % before the refund, expected at least 5000',
      v_available;
  end if;

  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'refund after fulfilment', 4000);

  if r.applied_delta_minor <> 4000 then
    raise exception
      'VERIFICATION FAILED 10: the refund applied %, expected 4000',
      r.applied_delta_minor;
  end if;

  /* An available earning reversed produces an available reversal. */
  if (select available_at
        from public.consultant_ledger_entries
       where reverses_entry_id = v_entry) is null then
    raise exception
      'VERIFICATION FAILED 10: reversing an AVAILABLE earning produced a pending reversal, so the balance would not fall';
  end if;

  if r.status <> 'fulfilled' then
    raise exception
      'VERIFICATION FAILED 10: a partial refund moved the status to %, expected it to stay fulfilled',
      r.status;
  end if;

  /* Check 11 — pay it out, then refund the rest. */
  insert into public.payouts (
    consultant_id, status, currency, requested_amount_minor)
  values (current_setting('app.v43_con')::uuid, 'paid', 'usd', 3000)
  returning id into v_payout;

  insert into public.payout_allocations (payout_id, ledger_entry_id)
  values (v_payout, v_entry);

  perform public.reverse_service_purchase_earning(
    v_purchase, 'refund the rest', 10000);

  select available_minor into v_available
    from public.consultant_balances
   where consultant_id = current_setting('app.v43_con')::uuid
     and currency = 'usd';

  if v_available >= 0 then
    raise exception
      'VERIFICATION FAILED 11: available is % after refunding a paid-out earning, expected negative',
      v_available;
  end if;

  raise notice
    'PASS 10 and 11: refunding an available earning removes it from the balance, and refunding a paid-out one is permitted and goes negative (% available)',
    v_available;
end $$;


-- Check 12 — a purchase nobody is credited for.

do $$
declare
  v_purchase uuid;
  r record;
begin
  insert into public.service_purchases (
    service_id, client_profile_id, gross_amount_minor, currency,
    billing_type, billing_period_sequence, status, stripe_mode,
    stripe_payment_intent_id)
  values (
    current_setting('app.v43_svc')::uuid,
    current_setting('app.v43_clp')::uuid,
    7000, 'usd', 'one_time', 1, 'paid', 'test', 'pi_v43_unattr')
  returning id into v_purchase;

  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'refund an unattributed sale', 7000);

  if r.reversed or r.reason <> 'no_entry' then
    raise exception
      'VERIFICATION FAILED 12: an unattributed refund reported reversed=% reason=%',
      r.reversed, r.reason;
  end if;

  if r.refunded_amount_minor <> 7000 or r.status <> 'refunded' then
    raise exception
      'VERIFICATION FAILED 12: the refund was not recorded on the purchase: % / %',
      r.refunded_amount_minor, r.status;
  end if;

  if exists (
    select 1 from public.consultant_ledger_entries
     where source_id = v_purchase
  ) then
    raise exception
      'VERIFICATION FAILED 12: a ledger entry was created for a purchase nobody is credited for';
  end if;

  raise notice
    'PASS 12: an unattributed purchase records its refund and creates no ledger entry';
end $$;

rollback;


-- ============================================================
-- PART 4 — REGRESSIONS (read-only)
-- ============================================================

-- Checks 13 and 14.

do $$
declare
  v_signature text;
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_fn regprocedure;
  v_untouched text[] := array[
    'record_service_purchase',
    'fulfill_service_purchase',
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_ledger_entry',
    'reverse_consultation_earning',
    'create_ledger_adjustment',
    'request_consultant_payout',
    'decide_payout',
    'mark_payout_paid'
  ];
  v_tables integer;
begin
  foreach v_signature in array array[
    'public.reverse_service_purchase_earning(uuid, text, integer)',
    'public.reverse_service_purchase_for_payment_intent(text, text, integer)'
  ]
  loop
    v_oid := to_regprocedure(v_signature);

    if v_oid is null then
      raise exception
        'VERIFICATION FAILED 13: % does not exist', v_signature;
    end if;

    select p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(none)')
      into v_secdef, v_config
      from pg_proc p where p.oid = v_oid;

    if not v_secdef then
      raise exception
        'VERIFICATION FAILED 13: % is not SECURITY DEFINER', v_signature;
    end if;

    if v_config is distinct from 'search_path=pg_catalog, public' then
      raise exception
        'VERIFICATION FAILED 13: % has search_path %', v_signature, v_config;
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 13: % is client-callable; a recreated function loses its ACL and Supabase grants it straight back',
        v_signature;
    end if;

    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 13: service_role cannot execute %', v_signature;
    end if;
  end loop;

  /* Check 14 — nothing else moved. */
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(v_untouched)
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE')
       or has_function_privilege(
            'authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 14: % became client-callable', v_fn;
    end if;
  end loop;

  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE';

  if v_tables <> 21 then
    raise exception
      'VERIFICATION FAILED 14: % base tables in public, expected 21; this migration adds none',
      v_tables;
  end if;

  if to_regprocedure(
       'public.get_admin_finance_kpis(timestamptz, timestamptz)'
     ) is null
     or to_regclass('public.consultant_payout_settings') is null
     or to_regclass('public.consultant_balances') is null
     or to_regclass('public.admin_services') is null then
    raise exception
      'VERIFICATION FAILED 14: an object from migrations 034, 038, 039 or 041 disappeared';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'services'
       and column_name = 'post_purchase_instructions_html'
  ) then
    raise exception
      'VERIFICATION FAILED 14: migration 042''s column disappeared';
  end if;

  raise notice
    'PASS 13 and 14: both functions are SECURITY DEFINER, pinned and service_role only; migrations 034 and 038-042 are intact';
end $$;


-- Fixtures rolled back.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v43-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Rolling this back RESTORES A KNOWN ACCOUNTING BUG. Migration
-- 040's functions treat the amount as a delta, and Stripe's
-- charge.amount_refunded is cumulative, so multiple partial
-- refunds over-reverse a consultant's ledger and partial-then-full
-- silently records nothing. Do not roll back to fix an unrelated
-- problem.
--
-- If it must be done, restore migration 040 parts E and E2
-- verbatim, then re-apply their privileges:
--
--   drop function if exists
--     public.reverse_service_purchase_for_payment_intent(
--       text, text, integer);
--   drop function if exists
--     public.reverse_service_purchase_earning(uuid, text, integer);
--   -- then paste migration 040 parts E and E2, and:
--   revoke all on function … from public, anon, authenticated;
--   grant execute on function … to service_role;
--
-- The orchestrator must be rolled back with it: it passes a
-- cumulative total to a named parameter that would no longer
-- exist, so every refund webhook would fail loudly — which is the
-- intended behaviour of the rename, and the reason it is safe to
-- do in either direction.
--
-- Refunds already recorded are unaffected. This migration writes
-- no data of its own and changes no table, column, index,
-- constraint, policy or grant.
-- ============================================================

do $$
begin
  raise notice
    'migration 043 verification complete: no check raised';
end $$;
