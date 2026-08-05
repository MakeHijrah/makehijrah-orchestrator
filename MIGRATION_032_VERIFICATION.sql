-- ============================================================
-- Verification for migration_032_persist_consultant_decline_reason
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function identity, shape and grants   read-only
--   Part 2  decline behaviour                     STAGING ONLY, rolls back
--   Part 3  scope inspection                      read-only
--   Part 4  rollback guidance
--
-- Part 2 creates every fixture it needs inside a transaction and
-- rolls it back. It reads no business record.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths.
--
-- Check map:
--    1  the column exists, nullable, no default          Part 2
--    2  a decline stores the supplied reason             Part 2
--    3  a blank or whitespace-only reason stores null    Part 2
--    4  a null reason stores null                        Part 2
--    5  admin_attention_reason still becomes 'declined'  Part 2
--    6  status, declined_at and the returned row are
--       unchanged from migration 011                     Part 2
--    7  a failed decline rolls back                      Part 2
--    8  an unrelated consultation is untouched           Part 2
--    9  the idempotent replay branch is preserved and
--       does not overwrite a recorded reason             Part 2
--   10  signature, argument names and result unchanged   Part 1
--   11  SECURITY DEFINER and search_path unchanged       Part 1
--   12  PUBLIC and anon lack EXECUTE, service_role holds
--       it                                               Part 1
--   13  table count remains 16, RLS untouched            Part 3
--   14  fixtures roll back, asserted not assumed         Part 2
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION IDENTITY, SHAPE AND GRANTS (read-only)
-- ============================================================

-- Checks 10 and 11.
--
-- Migration 032 must not have modernised anything it was not asked
-- to. search_path is pinned to migration 011's ORIGINAL `public`
-- value rather than the hardened pg_catalog, public form used from
-- migration 027 onward, precisely so an accidental change is
-- caught here rather than shipped as a side effect.

do $$
declare
  v_oid       oid;
  v_overloads integer;
  v_args      text;
  v_result    text;
  v_secdef    boolean;
  v_config    text;
  v_expected  text :=
    'p_consultation_id uuid, p_consultant_id uuid, p_decline_reason text';
begin
  v_oid := to_regprocedure(
    'public.finalize_consultation_decline(uuid,uuid,text)'
  );

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 10: finalize_consultation_decline(uuid,uuid,text) does not exist';
  end if;

  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'finalize_consultation_decline';

  if v_overloads <> 1 then
    raise exception
      'VERIFICATION FAILED 10: expected exactly one overload, found %', v_overloads;
  end if;

  select pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid),
         p.prosecdef,
         coalesce(array_to_string(p.proconfig, ' | '), '(none)')
    into v_args, v_result, v_secdef, v_config
    from pg_proc p
   where p.oid = v_oid;

  /*
   * pg_get_function_identity_arguments returns NAME-qualified
   * arguments, so this pins the argument names as well as the
   * types. The orchestrator calls this RPC with named parameters
   * (p_consultation_id, p_consultant_id, p_decline_reason), so a
   * renamed argument would break the caller even though the type
   * list still matched.
   */
  if v_args is distinct from v_expected then
    raise exception
      'VERIFICATION FAILED 10: argument names or types changed. Found: %', v_args;
  end if;

  -- The returned columns are part of the contract and unchanged:
  -- consultant_decline_reason is stored, NOT returned.
  if v_result is distinct from
     'TABLE(consultation_id uuid, consultation_status consultation_status, declined_at timestamp with time zone, admin_attention_reason text)' then
    raise exception
      'VERIFICATION FAILED 10: result signature changed. Found: %', v_result;
  end if;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 11: the function is no longer SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=public' then
    raise exception
      'VERIFICATION FAILED 11: search_path is %, expected migration 011''s search_path=public', v_config;
  end if;

  raise notice
    'PASS 10: signature, argument names and returned columns unchanged';
  raise notice
    'PASS 11: SECURITY DEFINER and migration 011 search_path preserved';
end $$;


-- The installed body must store the reason and must still carry
-- every migration 011 guard.

do $$
declare v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure(
     'public.finalize_consultation_decline(uuid,uuid,text)');

  if v_src not like '%consultant_decline_reason%' then
    raise exception
      'VERIFICATION FAILED 2: the installed function does not store the decline reason';
  end if;

  if v_src not like '%for update%' then
    raise exception
      'VERIFICATION FAILED 6: the FOR UPDATE race protection is missing';
  end if;

  if v_src not like '%pending_acceptance%'
     or v_src not like '%authorization_cancelled%' then
    raise exception
      'VERIFICATION FAILED 6: the status transition guard changed';
  end if;

  if v_src not like '%Consultation has no Stripe PaymentIntent%' then
    raise exception
      'VERIFICATION FAILED 6: the PaymentIntent precondition is missing';
  end if;

  if v_src not like '%Consultation is not assigned to this consultant%' then
    raise exception
      'VERIFICATION FAILED 6: the consultant ownership check is missing';
  end if;

  raise notice
    'PASS 6: the reason is stored and every migration 011 guard is intact';
end $$;


-- Check 12: execution rights.
--
-- proacl is inspected directly because PUBLIC is not an ordinary
-- role: it appears as grantee OID 0 and cannot be named in a
-- has_*_privilege call. A null proacl means PostgreSQL defaults
-- are in force, which for a function INCLUDES execute to PUBLIC.

do $$
declare
  v_acl     aclitem[];
  v_public  boolean;
  v_anon    boolean;
  v_service boolean;
begin
  select coalesce(p.proacl, acldefault('f', p.proowner))
    into v_acl
    from pg_proc p
   where p.oid = to_regprocedure(
     'public.finalize_consultation_decline(uuid,uuid,text)');

  select
    bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('anon')::oid         and a.privilege_type = 'EXECUTE'),
    bool_or(a.grantee = to_regrole('service_role')::oid and a.privilege_type = 'EXECUTE')
    into v_public, v_anon, v_service
    from aclexplode(v_acl) as a;

  if coalesce(v_public, false) then
    raise exception 'VERIFICATION FAILED 12: PUBLIC holds EXECUTE';
  end if;

  if coalesce(v_anon, false) then
    raise exception 'VERIFICATION FAILED 12: anon holds EXECUTE';
  end if;

  if not coalesce(v_service, false) then
    raise exception 'VERIFICATION FAILED 12: service_role lacks EXECUTE';
  end if;

  raise notice 'PASS 12: PUBLIC no, anon no, service_role yes';
end $$;


-- ============================================================
-- PART 2 — DECLINE BEHAVIOUR (STAGING ONLY, SELF-CONTAINED)
-- ============================================================

begin;

-- Check 1: the column exists, is nullable, and has no default.

do $$
declare
  v_nullable text;
  v_default  text;
  v_type     text;
begin
  select is_nullable, column_default, data_type
    into v_nullable, v_default, v_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'consultations'
     and column_name  = 'consultant_decline_reason';

  if not found then
    raise exception
      'VERIFICATION FAILED 1: consultations.consultant_decline_reason does not exist';
  end if;

  if v_type <> 'text' then
    raise exception 'VERIFICATION FAILED 1: the column is %, expected text', v_type;
  end if;

  if v_nullable <> 'YES' then
    raise exception 'VERIFICATION FAILED 1: the column is NOT NULL';
  end if;

  if v_default is not null then
    raise exception
      'VERIFICATION FAILED 1: the column has default %, expected none', v_default;
  end if;

  raise notice 'PASS 1: consultant_decline_reason exists as nullable text with no default';
end $$;


-- Fixtures. Four declinable consultations for one consultant, plus
-- one belonging to a second consultant that no call below touches.

do $$
declare
  v_cpr  uuid := gen_random_uuid();
  v_opr  uuid := gen_random_uuid();
  v_clpr uuid := gen_random_uuid();
  v_con  uuid;
  v_oth  uuid;
  v_cid  uuid;
  v_a    uuid;
  v_b    uuid;
  v_c    uuid;
  v_d    uuid;
  v_e    uuid;
  v_u    uuid;
begin
  insert into auth.users (id, email) values
    (v_cpr,  'v32-consultant@verification.invalid'),
    (v_opr,  'v32-other@verification.invalid'),
    (v_clpr, 'v32-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_cpr,  'consultant', 'V32 Consultant', 'v32-consultant@verification.invalid'),
    (v_opr,  'consultant', 'V32 Other',      'v32-other@verification.invalid'),
    (v_clpr, 'client',     'V32 Client',     'v32-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone)
  values (v_cpr, 'Africa/Cairo') returning id into v_con;

  insert into public.consultants (profile_id, timezone)
  values (v_opr, 'Africa/Cairo') returning id into v_oth;

  insert into public.countries (name, iso_code, is_active)
  values ('ZZ V32 Country', 'QW5', true) returning id into v_cid;

  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status, price_cents,
     scheduled_start_at, scheduled_end_at, stripe_payment_intent_id)
  values
    (v_clpr, v_con, v_cid, 'pending_acceptance', 15000,
     now() + interval '3 days', now() + interval '3 days 1 hour', 'pi_v32_a'),
    (v_clpr, v_con, v_cid, 'pending_acceptance', 15000,
     now() + interval '4 days', now() + interval '4 days 1 hour', 'pi_v32_b'),
    (v_clpr, v_con, v_cid, 'pending_acceptance', 15000,
     now() + interval '5 days', now() + interval '5 days 1 hour', 'pi_v32_c'),
    (v_clpr, v_con, v_cid, 'pending_acceptance', 15000,
     now() + interval '6 days', now() + interval '6 days 1 hour', 'pi_v32_d'),
    (v_clpr, v_oth, v_cid, 'pending_acceptance', 15000,
     now() + interval '7 days', now() + interval '7 days 1 hour', 'pi_v32_e');

  select id into v_a from public.consultations where stripe_payment_intent_id = 'pi_v32_a';
  select id into v_b from public.consultations where stripe_payment_intent_id = 'pi_v32_b';
  select id into v_c from public.consultations where stripe_payment_intent_id = 'pi_v32_c';
  select id into v_d from public.consultations where stripe_payment_intent_id = 'pi_v32_d';
  select id into v_e from public.consultations where stripe_payment_intent_id = 'pi_v32_e';

  -- A consultation with no PaymentIntent, used for the failure path.
  insert into public.consultations
    (client_profile_id, consultant_id, country_id, status, price_cents,
     scheduled_start_at, scheduled_end_at, stripe_payment_intent_id)
  values
    (v_clpr, v_con, v_cid, 'pending_acceptance', 15000,
     now() + interval '8 days', now() + interval '8 days 1 hour', null)
  returning id into v_u;

  perform set_config('app.v32_con', v_con::text, true);
  perform set_config('app.v32_oth', v_oth::text, true);
  perform set_config('app.v32_a',   v_a::text,   true);
  perform set_config('app.v32_b',   v_b::text,   true);
  perform set_config('app.v32_c',   v_c::text,   true);
  perform set_config('app.v32_d',   v_d::text,   true);
  perform set_config('app.v32_e',   v_e::text,   true);
  perform set_config('app.v32_u',   v_u::text,   true);

  raise notice 'FIXTURES CREATED';
end $$;


-- Checks 2, 5, 6: a decline stores the supplied reason, and every
-- other field behaves exactly as migration 011 left it.

do $$
declare
  v_id     uuid := current_setting('app.v32_a')::uuid;
  v_con    uuid := current_setting('app.v32_con')::uuid;
  v_ret    record;
  v_row    record;
begin
  select * into v_ret
    from public.finalize_consultation_decline(
      v_id, v_con, 'The requested time no longer works for me.');

  select status, declined_at, admin_attention_reason, consultant_decline_reason
    into v_row
    from public.consultations
   where id = v_id;

  -- Check 2.
  if v_row.consultant_decline_reason is distinct from
     'The requested time no longer works for me.' then
    raise exception
      'VERIFICATION FAILED 2: stored reason is %',
      coalesce(v_row.consultant_decline_reason, '(null)');
  end if;

  -- Check 5.
  if v_row.admin_attention_reason is distinct from 'declined' then
    raise exception
      'VERIFICATION FAILED 5: admin_attention_reason is %',
      coalesce(v_row.admin_attention_reason, '(null)');
  end if;

  -- Check 6: status, timestamp and the returned row are unchanged
  -- behaviour from migration 011.
  if v_row.status::text is distinct from 'admin_attention' then
    raise exception
      'VERIFICATION FAILED 6: status is %', v_row.status;
  end if;

  if v_row.declined_at is null then
    raise exception 'VERIFICATION FAILED 6: declined_at was not set';
  end if;

  if v_ret.consultation_id is distinct from v_id
     or v_ret.consultation_status::text is distinct from 'admin_attention'
     or v_ret.declined_at is distinct from v_row.declined_at
     or v_ret.admin_attention_reason is distinct from 'declined' then
    raise exception
      'VERIFICATION FAILED 6: the returned row changed: %', v_ret;
  end if;

  raise notice 'PASS 2: the supplied reason was stored verbatim';
  raise notice 'PASS 5: admin_attention_reason is still ''declined''';
  raise notice 'PASS 6: status, declined_at and the returned row are unchanged';
end $$;


-- Check 3: a blank or whitespace-only reason stores null, not ''.
--
-- Both forms are asserted. An empty string would be
-- indistinguishable from a reason of zero length when read back.

do $$
declare
  v_b   uuid := current_setting('app.v32_b')::uuid;
  v_c   uuid := current_setting('app.v32_c')::uuid;
  v_con uuid := current_setting('app.v32_con')::uuid;
  v_got text;
begin
  perform public.finalize_consultation_decline(v_b, v_con, '');

  select consultant_decline_reason into v_got
    from public.consultations where id = v_b;

  if v_got is not null then
    raise exception
      'VERIFICATION FAILED 3: an empty string stored "%" instead of null', v_got;
  end if;

  perform public.finalize_consultation_decline(v_c, v_con, '   ');

  select consultant_decline_reason into v_got
    from public.consultations where id = v_c;

  if v_got is not null then
    raise exception
      'VERIFICATION FAILED 3: a whitespace-only reason stored "%" instead of null', v_got;
  end if;

  raise notice 'PASS 3: blank and whitespace-only reasons store null';
end $$;


-- Check 4: a null reason stores null, and the decline still works.

do $$
declare
  v_d   uuid := current_setting('app.v32_d')::uuid;
  v_con uuid := current_setting('app.v32_con')::uuid;
  v_row record;
begin
  perform public.finalize_consultation_decline(v_d, v_con, null);

  select status, admin_attention_reason, consultant_decline_reason
    into v_row
    from public.consultations where id = v_d;

  if v_row.consultant_decline_reason is not null then
    raise exception
      'VERIFICATION FAILED 4: a null reason stored "%"', v_row.consultant_decline_reason;
  end if;

  if v_row.status::text is distinct from 'admin_attention'
     or v_row.admin_attention_reason is distinct from 'declined' then
    raise exception
      'VERIFICATION FAILED 4: a null reason disturbed the decline (status %, reason %)',
      v_row.status, coalesce(v_row.admin_attention_reason, '(null)');
  end if;

  raise notice 'PASS 4: a null reason stores null and the decline still completes';
end $$;


-- Check 9: the idempotent replay branch is preserved, and a replay
-- does not overwrite the reason recorded by the first decline.
--
-- This matters because the replay branch returns BEFORE the
-- UPDATE. If it were ever reordered, a retried webhook carrying no
-- reason would silently erase the one the consultant gave.

do $$
declare
  v_id  uuid := current_setting('app.v32_a')::uuid;
  v_con uuid := current_setting('app.v32_con')::uuid;
  v_before record;
  v_after  record;
  v_ret    record;
begin
  select status, declined_at, admin_attention_reason, consultant_decline_reason
    into v_before
    from public.consultations where id = v_id;

  -- Replay with NO reason at all.
  select * into v_ret
    from public.finalize_consultation_decline(v_id, v_con, null);

  select status, declined_at, admin_attention_reason, consultant_decline_reason
    into v_after
    from public.consultations where id = v_id;

  if v_after.consultant_decline_reason is distinct from v_before.consultant_decline_reason then
    raise exception
      'VERIFICATION FAILED 9: a replay overwrote the reason: % -> %',
      coalesce(v_before.consultant_decline_reason, '(null)'),
      coalesce(v_after.consultant_decline_reason, '(null)');
  end if;

  if v_after.declined_at is distinct from v_before.declined_at then
    raise exception
      'VERIFICATION FAILED 9: a replay moved declined_at';
  end if;

  if v_ret.admin_attention_reason is distinct from 'declined' then
    raise exception
      'VERIFICATION FAILED 9: a replay returned admin_attention_reason %',
      coalesce(v_ret.admin_attention_reason, '(null)');
  end if;

  raise notice
    'PASS 9: the replay branch is preserved and does not overwrite a recorded reason';
end $$;


-- Check 7: a failed decline rolls back, storing no reason.
--
-- Three distinct failure paths are exercised, each with a reason
-- supplied. None may leave that reason behind.

do $$
declare
  v_u    uuid := current_setting('app.v32_u')::uuid;
  v_e    uuid := current_setting('app.v32_e')::uuid;
  v_con  uuid := current_setting('app.v32_con')::uuid;
  v_row  record;
  v_ok   boolean;
begin
  -- 7a. No Stripe PaymentIntent.
  v_ok := false;
  begin
    perform public.finalize_consultation_decline(
      v_u, v_con, 'This reason must not persist.');
  exception when others then
    if sqlerrm like '%no Stripe PaymentIntent%' then v_ok := true; else raise; end if;
  end;

  if not v_ok then
    raise exception 'VERIFICATION FAILED 7: a consultation with no PaymentIntent was declined';
  end if;

  select status, declined_at, admin_attention_reason, consultant_decline_reason
    into v_row from public.consultations where id = v_u;

  if v_row.consultant_decline_reason is not null then
    raise exception
      'VERIFICATION FAILED 7: a failed decline stored the reason "%"',
      v_row.consultant_decline_reason;
  end if;

  if v_row.status::text is distinct from 'pending_acceptance'
     or v_row.declined_at is not null
     or v_row.admin_attention_reason is not null then
    raise exception
      'VERIFICATION FAILED 7: a failed decline mutated the consultation';
  end if;

  raise notice 'PASS 7a: a missing PaymentIntent stores no reason and mutates nothing';

  -- 7b. Wrong consultant. The reason must not reach another
  -- consultant's consultation.
  v_ok := false;
  begin
    perform public.finalize_consultation_decline(
      v_e, v_con, 'This reason must not persist either.');
  exception when others then
    if sqlerrm like '%not assigned to this consultant%' then v_ok := true; else raise; end if;
  end;

  if not v_ok then
    raise exception 'VERIFICATION FAILED 7: the wrong consultant declined a consultation';
  end if;

  select status, consultant_decline_reason
    into v_row from public.consultations where id = v_e;

  if v_row.consultant_decline_reason is not null then
    raise exception
      'VERIFICATION FAILED 7: an unauthorised decline stored the reason "%"',
      v_row.consultant_decline_reason;
  end if;

  raise notice 'PASS 7b: an unauthorised decline stores no reason';

  -- 7c. An unknown consultation id.
  v_ok := false;
  begin
    perform public.finalize_consultation_decline(
      gen_random_uuid(), v_con, 'Nor this one.');
  exception when others then
    if sqlerrm like '%Consultation not found%' then v_ok := true; else raise; end if;
  end;

  if not v_ok then
    raise exception 'VERIFICATION FAILED 7: an unknown consultation was declined';
  end if;

  raise notice 'PASS 7c: an unknown consultation id is rejected';
end $$;


-- Check 8: the second consultant's consultation is exactly as
-- created. It survived a decline attempt in 7b, so this proves
-- isolation rather than mere absence of traffic.

do $$
declare
  v_e   uuid := current_setting('app.v32_e')::uuid;
  v_row record;
begin
  select status, declined_at, admin_attention_reason, consultant_decline_reason
    into v_row from public.consultations where id = v_e;

  if v_row.status::text is distinct from 'pending_acceptance'
     or v_row.declined_at is not null
     or v_row.admin_attention_reason is not null
     or v_row.consultant_decline_reason is not null then
    raise exception
      'VERIFICATION FAILED 8: the unrelated consultation changed (status %, declined_at %, attention %, reason %)',
      v_row.status, v_row.declined_at,
      coalesce(v_row.admin_attention_reason, '(null)'),
      coalesce(v_row.consultant_decline_reason, '(null)');
  end if;

  raise notice 'PASS 8: an unrelated consultation remains untouched';
end $$;

rollback;


-- Check 14: the rollback is asserted, not assumed.

do $$
declare
  v_consultations integer;
  v_profiles      integer;
  v_countries     integer;
begin
  select count(*) into v_consultations
    from public.consultations
   where stripe_payment_intent_id like 'pi_v32_%';

  select count(*) into v_profiles
    from public.profiles
   where email like 'v32-%@verification.invalid';

  select count(*) into v_countries
    from public.countries where iso_code = 'QW5';

  if v_consultations <> 0 then
    raise exception
      'VERIFICATION FAILED 14: % verification consultation(s) survived', v_consultations;
  end if;

  if v_profiles <> 0 then
    raise exception
      'VERIFICATION FAILED 14: % verification profile(s) survived', v_profiles;
  end if;

  if v_countries <> 0 then
    raise exception
      'VERIFICATION FAILED 14: % verification country row(s) survived', v_countries;
  end if;

  raise notice 'PASS 14: no verification fixture survived';
end $$;


-- ============================================================
-- PART 3 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 13: no table added, consultation statuses unchanged, RLS
-- untouched.

do $$
declare
  v_tables   integer;
  v_statuses text;
  v_policies text;
  v_rls      boolean;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  if v_tables <> 16 then
    raise exception
      'VERIFICATION FAILED 13: expected 16 tables, found %', v_tables;
  end if;

  /*
   * The status enum is pinned. Migration 032 stores a string; it
   * has no business adding, removing or reordering a status.
   */
  select string_agg(e.enumlabel, ', ' order by e.enumsortorder)
    into v_statuses
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
   where t.typname = 'consultation_status'
     and t.typnamespace = 'public'::regnamespace;

  if v_statuses is distinct from
     'draft, payment_authorized, pending_acceptance, confirmed, declined, admin_attention, completed, cancelled, authorization_cancelled, captured, refunded' then
    raise exception
      'VERIFICATION FAILED 13: consultation_status labels are now: %', v_statuses;
  end if;

  select string_agg(policyname, ', ' order by policyname)
    into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'consultations';

  if v_policies is distinct from 'consultations_select_roles' then
    raise exception
      'VERIFICATION FAILED 13: consultations policies are now: %', v_policies;
  end if;

  select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'consultations';

  if not v_rls then
    raise exception
      'VERIFICATION FAILED 13: row level security is disabled on public.consultations';
  end if;

  -- No policy was rewritten to mention the new column.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') like '%consultant_decline_reason%'
         or coalesce(with_check, '') like '%consultant_decline_reason%')
  ) then
    raise exception
      'VERIFICATION FAILED 13: a policy expression references consultant_decline_reason';
  end if;

  raise notice
    'PASS 13: 16 tables, consultation statuses unchanged, consultations RLS unchanged';
end $$;


do $$
begin
  raise notice 'ALL CHECKS 1-14 COMPLETE - no exception raised';
end $$;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
-- To reverse migration 032:
--
--   1. Re-apply migration 011 verbatim. That restores the previous
--      finalize_consultation_decline body, which accepts
--      p_decline_reason and discards it. Signature, grants and
--      search_path are identical, so nothing else moves.
--
--   2. Optionally drop the column:
--
--        alter table public.consultations
--          drop column consultant_decline_reason;
--
--      Dropping DESTROYS every reason recorded since the migration
--      was applied; there is no other copy, because nothing else
--      writes this column. Prefer step 1 alone, which stops new
--      writes while preserving what was captured.
--
-- Reversing needs no data restore for any other column: migration
-- 032 writes exactly one field and changes no status, timestamp,
-- refund, notification or RLS behaviour.
