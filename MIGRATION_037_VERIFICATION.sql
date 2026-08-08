-- ============================================================
-- Verification for migration_037_finance_references
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, backfill and grants        read-only
--   Part 2  generation and forgery            STAGING ONLY, rolls back
--   Part 3  immutability and uniqueness       STAGING ONLY, rolls back
--   Part 4  existing finance behaviour        STAGING ONLY, rolls back
--   Part 5  rollback guidance
--
-- Parts 2 to 4 share one transaction that ends in ROLLBACK.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  both columns exist; payouts.payout_reference is NOT
--       NULL and both sequences exist                      Part 1
--    2  every existing payout carries a well-formed
--       reference: the backfill left nothing behind        Part 1
--    3  every adjustment carries one and nothing else
--       does                                               Part 1
--    4  the four replaced RPCs are still service_role only
--       — migration 036 was not undone by the DROP          Part 1
--    5  a new payout and a new adjustment each generate a
--       fresh reference through the RPCs                   Part 2
--    6  a caller-supplied reference is overwritten, not
--       honoured                                           Part 2
--    7  an earning and a reversal never acquire one        Part 2
--    8  a payout reference cannot be changed, while
--       unrelated columns still update                     Part 3
--    9  an adjustment reference cannot be changed          Part 3
--   10  duplicates are impossible                          Part 3
--   11  the earning, payout, approval and payment path
--       still behaves exactly as migration 035 left it     Part 4
--   12  fixtures roll back, asserted not assumed           Part 4
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, BACKFILL AND GRANTS (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_nullable text;
  v_type text;
begin
  select is_nullable, data_type into v_nullable, v_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'payouts'
     and column_name = 'payout_reference';

  if v_type is null then
    raise exception
      'VERIFICATION FAILED 1: payouts.payout_reference does not exist';
  end if;

  if v_type <> 'text' then
    raise exception
      'VERIFICATION FAILED 1: payout_reference is %, expected text',
      v_type;
  end if;

  if v_nullable <> 'NO' then
    raise exception
      'VERIFICATION FAILED 1: payout_reference is nullable; every payout must carry one';
  end if;

  select data_type into v_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'consultant_ledger_entries'
     and column_name = 'adjustment_reference';

  if v_type is null then
    raise exception
      'VERIFICATION FAILED 1: consultant_ledger_entries.adjustment_reference does not exist';
  end if;

  if to_regclass('public.payout_reference_seq') is null
     or to_regclass(
          'public.ledger_adjustment_reference_seq') is null then
    raise exception
      'VERIFICATION FAILED 1: a reference sequence is missing';
  end if;

  raise notice 'PASS 1: both columns and both sequences exist';
end $$;


-- Checks 2 and 3.
--
-- The backfill is the part that cannot be re-run into place
-- later: a row that escaped it would be a payout an admin cannot
-- name. These count rather than sample.

do $$
declare
  v_payouts integer;
  v_bad_payouts integer;
  v_adjustments integer;
  v_missing integer;
  v_stray integer;
begin
  select count(*) into v_payouts from public.payouts;

  select count(*) into v_bad_payouts
    from public.payouts
   where payout_reference !~ '^PAY-[0-9]{4}-[0-9]{6,}$';

  if v_bad_payouts <> 0 then
    raise exception
      'VERIFICATION FAILED 2: % payout(s) carry a malformed reference',
      v_bad_payouts;
  end if;

  select count(*) into v_adjustments
    from public.consultant_ledger_entries
   where entry_type = 'adjustment';

  select count(*) into v_missing
    from public.consultant_ledger_entries
   where entry_type = 'adjustment'
     and (adjustment_reference is null
          or adjustment_reference !~ '^ADJ-[0-9]{4}-[0-9]{6,}$');

  if v_missing <> 0 then
    raise exception
      'VERIFICATION FAILED 3: % adjustment(s) have no usable reference',
      v_missing;
  end if;

  select count(*) into v_stray
    from public.consultant_ledger_entries
   where entry_type <> 'adjustment'
     and adjustment_reference is not null;

  if v_stray <> 0 then
    raise exception
      'VERIFICATION FAILED 3: % non-adjustment entr(ies) carry an adjustment reference',
      v_stray;
  end if;

  raise notice
    'PASS 2 and 3: % payout(s) and % adjustment(s) referenced, nothing stray',
    v_payouts, v_adjustments;
end $$;


-- Check 4.
--
-- The four RPCs were dropped and recreated, and a dropped
-- function takes its ACL with it. Supabase's default privileges
-- would then hand EXECUTE straight back to anon and
-- authenticated, silently undoing migration 036 for exactly the
-- functions that move money.

do $$
declare
  v_name text;
  v_signatures text[] := array[
    'create_ledger_adjustment(uuid, integer, text, text, uuid)',
    'request_consultant_payout(uuid, text, text)',
    'decide_payout(uuid, text, uuid, text)',
    'mark_payout_paid(uuid, integer, text, uuid, timestamptz, text)',
    'build_finance_reference(text, integer, bigint)'
  ];
begin
  foreach v_name in array v_signatures
  loop
    if has_function_privilege(
         'anon', 'public.' || v_name, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 4: anon can execute public.%; migration 036 was undone',
        v_name;
    end if;

    if has_function_privilege(
         'authenticated', 'public.' || v_name, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 4: authenticated can execute public.%',
        v_name;
    end if;
  end loop;

  /* build_finance_reference is a formatter, not an RPC. */
  foreach v_name in array v_signatures[1:4]
  loop
    if not has_function_privilege(
         'service_role', 'public.' || v_name, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 4: service_role LOST public.%', v_name;
    end if;
  end loop;

  raise notice
    'PASS 4: the replaced RPCs are still service_role only';
end $$;


-- ============================================================
-- PART 2 — GENERATION AND FORGERY (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_cpr uuid := gen_random_uuid();
  v_apr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con uuid;
  v_country uuid;
  v_consultation uuid;
  v_entry uuid;
  v_ref text;
  v_second text;
  v_payout uuid;
  v_payout_ref text;
begin
  insert into auth.users (id, email) values
    (v_cpr, 'v37-consultant@verification.invalid'),
    (v_apr, 'v37-admin@verification.invalid'),
    (v_clp, 'v37-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr, 'consultant', 'V37 Consultant',
     'v37-consultant@verification.invalid'),
    (v_apr, 'admin', 'V37 Admin',
     'v37-admin@verification.invalid'),
    (v_clp, 'client', 'V37 Client',
     'v37-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone)
  values (v_cpr, 'Africa/Cairo') returning id into v_con;

  insert into public.countries (name, iso_code)
  values ('ZZ V37 Country', 'XZ') returning id into v_country;

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status,
     price_cents, currency, scheduled_start_at, scheduled_end_at,
     captured_at, completed_at)
  values (v_clp, v_con, v_country, 'completed', 15000, 'usd',
    now() - interval '4 hours', now() - interval '3 hours',
    now(), now())
  returning id into v_consultation;

  perform set_config('app.v37_con', v_con::text, true);
  perform set_config('app.v37_admin', v_apr::text, true);
  perform set_config(
    'app.v37_consultation', v_consultation::text, true);

  -- ---------------------------------------------------------
  -- Check 5 — the RPCs generate and return a reference.
  -- ---------------------------------------------------------
  select entry_id, adjustment_reference into v_entry, v_ref
    from public.create_ledger_adjustment(
      v_con, 2500, 'usd', 'verification credit', v_apr);

  if v_ref is null
     or v_ref !~ '^ADJ-[0-9]{4}-[0-9]{6,}$' then
    raise exception
      'VERIFICATION FAILED 5: create_ledger_adjustment returned %',
      coalesce(v_ref, '<null>');
  end if;

  if v_ref !~ ('^ADJ-' || extract(year from now())::text || '-') then
    raise exception
      'VERIFICATION FAILED 5: % does not carry the current year',
      v_ref;
  end if;

  perform set_config('app.v37_entry', v_entry::text, true);
  perform set_config('app.v37_ref', v_ref, true);

  /* A second adjustment must not repeat the first. */
  select adjustment_reference into v_second
    from public.create_ledger_adjustment(
      v_con, 100, 'usd', 'second credit', v_apr);

  if v_second = v_ref then
    raise exception
      'VERIFICATION FAILED 5: two adjustments share the reference %',
      v_ref;
  end if;

  -- ---------------------------------------------------------
  -- Check 6 — a supplied reference is overwritten. This is what
  -- makes "not client-supplied" a property rather than a hope.
  -- ---------------------------------------------------------
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, gross_amount_minor,
    consultant_amount_minor, platform_amount_minor,
    commission_basis, currency, available_at,
    created_by_admin_profile_id, memo, adjustment_reference)
  values (v_con, 'adjustment', 'manual', 50, 50, 0, 'manual',
    'usd', now(), v_apr, 'forged', 'ADJ-1999-000001')
  returning adjustment_reference into v_second;

  if v_second = 'ADJ-1999-000001' then
    raise exception
      'VERIFICATION FAILED 6: a caller-supplied adjustment reference was honoured';
  end if;

  -- ---------------------------------------------------------
  -- Check 7 — earnings and reversals never carry one.
  -- ---------------------------------------------------------
  perform public.record_consultation_earning(v_consultation);
  perform public.release_consultation_earning(v_consultation);

  perform public.reverse_ledger_entry(
    (select id from public.consultant_ledger_entries
      where entry_type = 'earning'
        and source_id = v_consultation),
    'verification refund', 100);

  if exists (
    select 1 from public.consultant_ledger_entries
     where entry_type <> 'adjustment'
       and adjustment_reference is not null
  ) then
    raise exception
      'VERIFICATION FAILED 7: an earning or reversal acquired a reference';
  end if;

  -- A payout, for parts 3 and 4.
  select payout_id, payout_reference into v_payout, v_payout_ref
    from public.request_consultant_payout(
      v_con, 'usd', 'Wise account');

  if v_payout_ref is null
     or v_payout_ref !~ '^PAY-[0-9]{4}-[0-9]{6,}$' then
    raise exception
      'VERIFICATION FAILED 5: request_consultant_payout returned %',
      coalesce(v_payout_ref, '<null>');
  end if;

  perform set_config('app.v37_payout', v_payout::text, true);
  perform set_config('app.v37_payout_ref', v_payout_ref, true);

  raise notice
    'PASS 5, 6 and 7: references generate, resist forgery and stay off other entry types';
end $$;


-- ============================================================
-- PART 3 — IMMUTABILITY AND UNIQUENESS (same transaction)
-- ============================================================

do $$
declare
  v_payout uuid := current_setting('app.v37_payout')::uuid;
  v_payout_ref text := current_setting('app.v37_payout_ref');
  v_entry uuid := current_setting('app.v37_entry')::uuid;
  v_ref text := current_setting('app.v37_ref');
  v_now text;
begin
  -- Check 8
  begin
    update public.payouts
       set payout_reference = 'PAY-2026-999999'
     where id = v_payout;
    raise exception
      'VERIFICATION FAILED 8: a payout reference was changed';
  exception when raise_exception then
    if sqlerrm not like '%reference is immutable%' then raise; end if;
  end;

  select payout_reference into v_now
    from public.payouts where id = v_payout;

  if v_now <> v_payout_ref then
    raise exception
      'VERIFICATION FAILED 8: the reference moved from % to %',
      v_payout_ref, v_now;
  end if;

  /* An unrelated column must still be updatable. */
  update public.payouts
     set admin_note = 'still updatable' where id = v_payout;

  -- Check 9
  begin
    update public.consultant_ledger_entries
       set adjustment_reference = 'ADJ-2026-999999'
     where id = v_entry;
    raise exception
      'VERIFICATION FAILED 9: an adjustment reference was changed';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  select adjustment_reference into v_now
    from public.consultant_ledger_entries where id = v_entry;

  if v_now <> v_ref then
    raise exception
      'VERIFICATION FAILED 9: the reference moved from % to %',
      v_ref, v_now;
  end if;

  -- Check 10
  if exists (
    select payout_reference
      from public.payouts
     group by payout_reference having count(*) > 1
  ) then
    raise exception
      'VERIFICATION FAILED 10: duplicate payout references exist';
  end if;

  if exists (
    select adjustment_reference
      from public.consultant_ledger_entries
     where adjustment_reference is not null
     group by adjustment_reference having count(*) > 1
  ) then
    raise exception
      'VERIFICATION FAILED 10: duplicate adjustment references exist';
  end if;

  if to_regclass('public.uq_payouts_reference') is null
     or to_regclass(
          'public.uq_ledger_adjustment_reference') is null then
    raise exception
      'VERIFICATION FAILED 10: a uniqueness index is missing';
  end if;

  raise notice
    'PASS 8, 9 and 10: references are immutable and unique';
end $$;


-- ============================================================
-- PART 4 — EXISTING FINANCE BEHAVIOUR (same transaction)
-- ============================================================
--
-- Migration 037 replaced four RPC bodies. This walks the same
-- path migration 035's suite walks, to prove that adding a
-- returned column changed nothing about what they do.

do $$
declare
  v_payout uuid := current_setting('app.v37_payout')::uuid;
  v_admin uuid := current_setting('app.v37_admin')::uuid;
  v_con uuid := current_setting('app.v37_con')::uuid;
  v_status text;
  v_ref text;
  v_released integer;
  v_amount integer;
begin
  -- Check 11
  select status, payout_reference, released_entry_count
    into v_status, v_ref, v_released
    from public.decide_payout(
      v_payout, 'approve', v_admin, 'verification');

  if v_status <> 'approved' or v_released <> 0 then
    raise exception
      'VERIFICATION FAILED 11: approve returned %/%', v_status, v_released;
  end if;

  if v_ref <> current_setting('app.v37_payout_ref') then
    raise exception
      'VERIFICATION FAILED 11: decide_payout returned reference %', v_ref;
  end if;

  select available_minor into v_amount
    from public.consultant_balances
   where consultant_id = v_con and currency = 'usd';

  if v_amount <> 0 then
    raise exception
      'VERIFICATION FAILED 11: an approved payout freed %', v_amount;
  end if;

  select status, payout_reference into v_status, v_ref
    from public.mark_payout_paid(
      v_payout, 2600, 'WISE-V37', v_admin, now(), 'paid');

  if v_status <> 'paid' then
    raise exception
      'VERIFICATION FAILED 11: status after payment is %', v_status;
  end if;

  if v_ref <> current_setting('app.v37_payout_ref') then
    raise exception
      'VERIFICATION FAILED 11: mark_payout_paid returned reference %', v_ref;
  end if;

  begin
    perform public.decide_payout(v_payout, 'cancel', v_admin);
    raise exception
      'VERIFICATION FAILED 11: a paid payout was cancelled';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_PAYOUT_ALREADY_PAID%' then raise; end if;
  end;

  begin
    perform public.create_ledger_adjustment(
      v_con, 500, 'usd', '   ', v_admin);
    raise exception
      'VERIFICATION FAILED 11: a blank memo was accepted';
  exception when raise_exception then
    if sqlerrm not like 'FINANCE_REASON_REQUIRED%' then raise; end if;
  end;

  raise notice
    'PASS 11: the earning, payout, approval and payment path is unchanged';
end $$;

rollback;


-- Check 12 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v37-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 12: % verification profile(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS 12: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 037 is additive apart from four function bodies.
-- Nothing depends on the references yet beyond display, so the
-- migration can be left in place and ignored, which is the
-- preferred response to a problem with it.
--
-- To reverse it:
--
--   drop trigger if exists trg_payouts_reference on public.payouts;
--   drop trigger if exists trg_ledger_adjustment_reference
--     on public.consultant_ledger_entries;
--   drop function if exists public.assign_payout_reference();
--   drop function if exists public.assign_adjustment_reference();
--   alter table public.payouts
--     drop column if exists payout_reference;
--   alter table public.consultant_ledger_entries
--     drop column if exists adjustment_reference;
--   drop sequence if exists public.payout_reference_seq;
--   drop sequence if exists public.ledger_adjustment_reference_seq;
--   drop function if exists public.build_finance_reference(
--     text, integer, bigint);
--
-- Then REAPPLY migration 035 to restore the four RPCs to their
-- pre-037 return shapes, and REAPPLY migration 036 afterwards —
-- migration 035 alone leaves the recreated functions holding
-- Supabase's default grants to anon and authenticated.
--
-- Dropping the columns destroys every reference ever shown to a
-- consultant or quoted in a support conversation. Export them
-- first if any have been used:
--
--   select payout_reference, requested_amount_minor, requested_at
--     from public.payouts order by requested_at;
--
-- Note that a re-run of migration 037 after a rollback renumbers
-- from 1 only if the sequences were dropped too. If they were
-- kept, numbering continues, and no previously issued reference
-- is ever reused.
-- ============================================================

do $$
begin
  raise notice
    'migration 037 verification complete: no check raised';
end $$;
