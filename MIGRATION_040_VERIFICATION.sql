-- ============================================================
-- Verification for migration_040_service_purchase_finance
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  schema, constraints, indexes, ACLs   read-only
--   Part 2  one-time purchase and commission     STAGING ONLY, rolls back
--   Part 3  fulfilment and availability          STAGING ONLY, rolls back
--   Part 4  recurring                            STAGING ONLY, rolls back
--   Part 5  refunds                              STAGING ONLY, rolls back
--   Part 6  access control and regressions       STAGING ONLY, rolls back
--   Part 7  rollback guidance
--
-- Parts 2 to 6 share one transaction that ends in ROLLBACK and
-- create every fixture they need.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  the two columns exist with the right types and default
--    2  the refund bound and both subscription indexes exist
--    3  all four RPCs exist exactly once, are SECURITY DEFINER,
--       pinned, and executable only by service_role
--    4  a one-time payment creates exactly one purchase
--    5  commission math is exact on gross
--    6  an odd minor unit rounds to the consultant, and
--       consultant + platform = gross still holds
--    7  a null commission rate creates no ledger entry
--    8  a zero commission rate creates no ledger entry
--    9  the consultant is resolved from the sent recommendation
--   10  a spoofed consultant cannot be supplied: the function
--       takes no consultant parameter, and a forged client
--       candidate yields an unattributed purchase
--   11  payment creates the earning PENDING, not available
--   12  fulfilment releases it
--   13  a second fulfilment is an idempotent no-op
--   14  a redelivered Stripe event creates no second purchase
--       and no second earning
--   15  an initial subscription invoice creates sequence 1
--   16  a renewal invoice creates a DISTINCT purchase at
--       sequence 2 with its own earning
--   17  sequence allocation is serialised, and the unique index
--       refuses a duplicate even if the lock were bypassed
--   18  a full refund before fulfilment leaves nothing available
--   19  a full refund after fulfilment removes the available
--       balance
--   20  a partial refund is proportional and keeps the status
--   21  over-refund is refused, at the purchase and the ledger
--   22  refunding a paid-out earning is allowed and the balance
--       goes negative
--   23  currencies stay separate through purchase and balance
--   24  a purchase with no Stripe identifier is refused
--   25  completing the service_request alone releases nothing
--   26  fulfilling the purchase does not touch the
--       service_request
--   27  a client can read no service purchase
--   28  a consultant reads only purchases attributed to them
--   29  an admin reads every purchase
--   30  anon is denied at the privilege layer
--   31  migrations 034, 038 and 039 protections are intact
-- ============================================================


-- ============================================================
-- PART 1 — SCHEMA, CONSTRAINTS, INDEXES, ACLS (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_type text;
  v_notnull boolean;
  v_default text;
begin
  select data_type into v_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'service_purchases'
     and column_name = 'stripe_subscription_id';

  if v_type is distinct from 'text' then
    raise exception
      'VERIFICATION FAILED 1: stripe_subscription_id is [%], expected text',
      coalesce(v_type, '(absent)');
  end if;

  select data_type, is_nullable = 'NO', column_default
    into v_type, v_notnull, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'service_purchases'
     and column_name = 'refunded_amount_minor';

  if v_type is distinct from 'integer' then
    raise exception
      'VERIFICATION FAILED 1: refunded_amount_minor is [%], expected integer',
      coalesce(v_type, '(absent)');
  end if;

  if not v_notnull or v_default not like '0%' then
    raise exception
      'VERIFICATION FAILED 1: refunded_amount_minor must be NOT NULL DEFAULT 0; found notnull=%, default=%',
      v_notnull, coalesce(v_default, '(none)');
  end if;

  raise notice
    'PASS 1: stripe_subscription_id text and refunded_amount_minor integer not null default 0';
end $$;


-- Check 2.

do $$
declare
  v_def text;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.service_purchases'::regclass
       and conname = 'service_purchases_refunded_amount_check'
       and contype = 'c'
  ) then
    raise exception
      'VERIFICATION FAILED 2: service_purchases_refunded_amount_check is missing';
  end if;

  select indexdef into v_def
    from pg_indexes
   where schemaname = 'public'
     and indexname = 'uq_service_purchases_subscription_period';

  if v_def is null then
    raise exception
      'VERIFICATION FAILED 2: uq_service_purchases_subscription_period is missing; two renewals could share a period';
  end if;

  if v_def not like 'CREATE UNIQUE INDEX%'
     or v_def not like '%stripe_subscription_id%'
     or v_def not like '%billing_period_sequence%'
     or v_def not like '%WHERE%' then
    raise exception
      'VERIFICATION FAILED 2: the subscription period index is not a unique partial index on both columns: %',
      v_def;
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'idx_service_purchases_subscription'
  ) then
    raise exception
      'VERIFICATION FAILED 2: idx_service_purchases_subscription is missing';
  end if;

  raise notice
    'PASS 2: the refund bound and both subscription indexes are present';
end $$;


-- Check 3.

do $$
declare
  v_signature text;
  v_oid oid;
  v_secdef boolean;
  v_config text;
  v_overloads integer;
  v_signatures text[] := array[
    'public.record_service_purchase(integer, text, text, uuid, uuid, text, text, text, text, text, text)',
    'public.fulfill_service_purchase(uuid, uuid)',
    'public.reverse_service_purchase_earning(uuid, text, integer)',
    'public.reverse_service_purchase_for_payment_intent(text, text, integer)'
  ];
begin
  foreach v_signature in array v_signatures
  loop
    v_oid := to_regprocedure(v_signature);

    if v_oid is null then
      raise exception
        'VERIFICATION FAILED 3: % does not exist', v_signature;
    end if;

    select p.prosecdef,
           coalesce(array_to_string(p.proconfig, ', '), '(none)')
      into v_secdef, v_config
      from pg_proc p where p.oid = v_oid;

    if not v_secdef then
      raise exception
        'VERIFICATION FAILED 3: % is not SECURITY DEFINER', v_signature;
    end if;

    if v_config is distinct from 'search_path=pg_catalog, public' then
      raise exception
        'VERIFICATION FAILED 3: % has search_path %', v_signature, v_config;
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 3: % is client-callable; an anon key could record a purchase and release money',
        v_signature;
    end if;

    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 3: service_role cannot execute %', v_signature;
    end if;
  end loop;

  /*
   * Exactly one of each. record_service_purchase gained an
   * argument during development, and CREATE OR REPLACE would have
   * left the older form behind as an overload rather than
   * replacing it — which is why the migration drops it by name.
   */
  foreach v_signature in array array[
    'record_service_purchase',
    'fulfill_service_purchase',
    'reverse_service_purchase_earning',
    'reverse_service_purchase_for_payment_intent'
  ]
  loop
    select count(*) into v_overloads
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_signature;

    if v_overloads <> 1 then
      raise exception
        'VERIFICATION FAILED 3: % has % overload(s), expected exactly 1',
        v_signature, v_overloads;
    end if;
  end loop;

  raise notice
    'PASS 3: all four RPCs exist exactly once, SECURITY DEFINER, pinned, service_role only';
end $$;


-- Check 10, first half — the parameter surface.
--
-- The strongest statement this migration makes: attribution
-- cannot be supplied because there is no parameter to supply it
-- through. Asserted at the catalogue rather than by trying values.

do $$
declare
  v_args text;
begin
  select coalesce(string_agg(
           p.proargnames[t.ord], ', ' order by t.ord), '(none)')
    into v_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral generate_subscripts(p.proargtypes, 1) as t(ord)
   where n.nspname = 'public'
     and p.proname = 'record_service_purchase';

  if v_args ~ '(consultant|commission|attributed)' then
    raise exception
      'VERIFICATION FAILED 10: record_service_purchase accepts [%]; a caller could name a consultant or a rate',
      v_args;
  end if;

  raise notice
    'PASS 10a: record_service_purchase takes no consultant and no commission parameter';
end $$;


-- ============================================================
-- PART 2 — ONE-TIME PURCHASE AND COMMISSION (rolls back)
-- ============================================================

begin;

do $$
declare
  v_admin uuid := gen_random_uuid();
  v_cpr uuid := gen_random_uuid();
  v_opr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_olp uuid := gen_random_uuid();
  v_con uuid;
  v_oth uuid;
  v_consultation uuid;
  v_consultation_2 uuid;
  v_other_consultation uuid;
  v_svc uuid;
  v_svc_null uuid;
  v_svc_zero uuid;
  v_svc_eur uuid;
  v_svc_sub uuid;
  v_request uuid;
begin
  insert into auth.users (id, email) values
    (v_admin, 'v40-admin@verification.invalid'),
    (v_cpr, 'v40-consultant@verification.invalid'),
    (v_opr, 'v40-other-consultant@verification.invalid'),
    (v_clp, 'v40-client@verification.invalid'),
    (v_olp, 'v40-other-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_admin, 'admin', 'V40 Admin', 'v40-admin@verification.invalid'),
    (v_cpr, 'consultant', 'V40 Consultant',
     'v40-consultant@verification.invalid'),
    (v_opr, 'consultant', 'V40 Other Consultant',
     'v40-other-consultant@verification.invalid'),
    (v_clp, 'client', 'V40 Client',
     'v40-client@verification.invalid'),
    (v_olp, 'client', 'V40 Other Client',
     'v40-other-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true) returning id into v_con;
  insert into public.consultants (profile_id, timezone, is_active)
  values (v_opr, 'Africa/Cairo', true) returning id into v_oth;

  insert into public.consultations (
    client_profile_id,
    consultant_id,
    scheduled_start_at,
    scheduled_end_at,
    price_cents)
  values (
    v_clp,
    v_con,
    now() + interval '1 day',
    now() + interval '1 day 1 hour',
    15000)
  returning id into v_consultation;

  insert into public.consultations (
    client_profile_id,
    consultant_id,
    scheduled_start_at,
    scheduled_end_at,
    price_cents)
  values (
    v_clp,
    v_con,
    now() + interval '1 day 2 hours',
    now() + interval '1 day 3 hours',
    15000)
  returning id into v_consultation_2;

  insert into public.consultations (
    client_profile_id,
    consultant_id,
    scheduled_start_at,
    scheduled_end_at,
    price_cents)
  values (
    v_olp,
    v_oth,
    now() + interval '2 days',
    now() + interval '2 days 1 hour',
    15000)
  returning id into v_other_consultation;

  /* 4500 bps on an odd gross, to exercise the rounding rule. */
  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, stripe_payment_link_id, is_active)
  values ('V40 Visa Pack', 'one_time', 9999, 'usd',
          4500, 'plink_v40_onetime', true)
  returning id into v_svc;

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V40 No Rate', 'one_time', 5000, 'usd', null, true)
  returning id into v_svc_null;

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V40 Zero Rate', 'one_time', 5000, 'usd', 0, true)
  returning id into v_svc_zero;

  insert into public.services (
    name, billing_type, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V40 Euro Service', 'one_time', 8000, 'eur', 2500, true)
  returning id into v_svc_eur;

  insert into public.services (
    name, billing_type, recurring_interval, price_cents, currency,
    consultant_commission_bps, is_active)
  values ('V40 Retainer', 'recurring', 'month', 20000, 'usd',
          3000, true)
  returning id into v_svc_sub;

  /* Every service recommended to our client, and sent.
     The schema enforces a maximum of 3 recommendations per consultation,
     so split the five service fixtures across two consultations for the
     same client and consultant. */
  insert into public.service_recommendations (
    consultation_id, service_id, recommended_by_consultant_id,
    status, sent_by_admin_id, sent_at)
  select v_consultation, s, v_con, 'sent', v_admin, now()
    from unnest(array[
      v_svc, v_svc_null, v_svc_zero]) as s;

  insert into public.service_recommendations (
    consultation_id, service_id, recommended_by_consultant_id,
    status, sent_by_admin_id, sent_at)
  select v_consultation_2, s, v_con, 'sent', v_admin, now()
    from unnest(array[
      v_svc_eur, v_svc_sub]) as s;

  /* The other consultant recommended the SAME service to the
     other client. Attribution must not cross between them. */
  insert into public.service_recommendations (
    consultation_id, service_id, recommended_by_consultant_id,
    status, sent_by_admin_id, sent_at)
  values (v_other_consultation, v_svc, v_oth, 'sent', v_admin, now());

  insert into public.service_requests (
    client_profile_id, service_id, consultation_id, status)
  values (v_clp, v_svc, v_consultation, 'active')
  returning id into v_request;

  perform set_config('app.v40_admin', v_admin::text, true);
  perform set_config('app.v40_cpr', v_cpr::text, true);
  perform set_config('app.v40_opr', v_opr::text, true);
  perform set_config('app.v40_clp', v_clp::text, true);
  perform set_config('app.v40_olp', v_olp::text, true);
  perform set_config('app.v40_con', v_con::text, true);
  perform set_config('app.v40_oth', v_oth::text, true);
  perform set_config('app.v40_svc', v_svc::text, true);
  perform set_config('app.v40_svc_null', v_svc_null::text, true);
  perform set_config('app.v40_svc_zero', v_svc_zero::text, true);
  perform set_config('app.v40_svc_eur', v_svc_eur::text, true);
  perform set_config('app.v40_svc_sub', v_svc_sub::text, true);
  perform set_config('app.v40_request', v_request::text, true);
  perform set_config('app.v40_consultation', v_consultation::text, true);
end $$;


-- Checks 4, 5, 6, 9, 11 and 14.

do $$
declare
  r record;
  v_again record;
  v_purchases integer;
  v_entries integer;
  v_available bigint;
  v_pending bigint;
begin
  select * into r
    from public.record_service_purchase(
      p_gross_amount_minor := 9999,
      p_currency := 'usd',
      p_stripe_mode := 'test',
      p_service_id := current_setting('app.v40_svc')::uuid,
      p_client_profile_id := current_setting('app.v40_clp')::uuid,
      p_stripe_checkout_session_id := 'cs_v40_one',
      p_stripe_payment_intent_id := 'pi_v40_one');

  /* Check 4. */
  if not r.created or r.purchase_id is null then
    raise exception
      'VERIFICATION FAILED 4: the purchase was not created';
  end if;

  if r.status <> 'paid' or r.billing_type <> 'one_time'
     or r.billing_period_sequence <> 1 then
    raise exception
      'VERIFICATION FAILED 4: purchase recorded as % / % / seq %',
      r.status, r.billing_type, r.billing_period_sequence;
  end if;

  /* Check 9 — the consultant came from the sent recommendation,
     and specifically NOT from the other consultant who recommended
     the same service to a different client. */
  if r.attributed_consultant_id
     is distinct from current_setting('app.v40_con')::uuid then
    raise exception
      'VERIFICATION FAILED 9: attributed to % instead of the recommending consultant',
      r.attributed_consultant_id;
  end if;

  if r.consultation_id
     is distinct from current_setting('app.v40_consultation')::uuid
     or r.service_request_id
        is distinct from current_setting('app.v40_request')::uuid then
    raise exception
      'VERIFICATION FAILED 9: consultation/request context was not resolved (% / %)',
      r.consultation_id, r.service_request_id;
  end if;

  /* Checks 5 and 6 — round(9999 * 4500 / 10000) = 4499.55 -> 4500,
     and the platform takes the remainder so the identity holds. */
  if r.commission_bps <> 4500
     or r.consultant_amount_minor <> 4500
     or r.platform_amount_minor <> 5499 then
    raise exception
      'VERIFICATION FAILED 5/6: split was bps %, consultant %, platform %; expected 4500 / 4500 / 5499',
      r.commission_bps, r.consultant_amount_minor,
      r.platform_amount_minor;
  end if;

  if r.consultant_amount_minor + r.platform_amount_minor
     <> r.gross_amount_minor then
    raise exception
      'VERIFICATION FAILED 6: % + % <> %',
      r.consultant_amount_minor, r.platform_amount_minor,
      r.gross_amount_minor;
  end if;

  /* Check 11 — pending, not available. */
  select pending_minor, available_minor
    into v_pending, v_available
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_pending <> 4500 or v_available <> 0 then
    raise exception
      'VERIFICATION FAILED 11: pending %, available %; a payment alone must not make an earning available',
      v_pending, v_available;
  end if;

  if (select available_at from public.consultant_ledger_entries
       where id = r.entry_id) is not null then
    raise exception
      'VERIFICATION FAILED 11: the earning was created already available';
  end if;

  /* Check 14 — the same webhook delivered twice. */
  select * into v_again
    from public.record_service_purchase(
      p_gross_amount_minor := 9999,
      p_currency := 'usd',
      p_stripe_mode := 'test',
      p_service_id := current_setting('app.v40_svc')::uuid,
      p_client_profile_id := current_setting('app.v40_clp')::uuid,
      p_stripe_checkout_session_id := 'cs_v40_one',
      p_stripe_payment_intent_id := 'pi_v40_one');

  if v_again.created or v_again.earning_created then
    raise exception
      'VERIFICATION FAILED 14: a redelivered event reported created=% earning_created=%',
      v_again.created, v_again.earning_created;
  end if;

  if v_again.purchase_id <> r.purchase_id then
    raise exception
      'VERIFICATION FAILED 14: redelivery returned a different purchase';
  end if;

  select count(*) into v_purchases
    from public.service_purchases
   where stripe_checkout_session_id = 'cs_v40_one';

  select count(*) into v_entries
    from public.consultant_ledger_entries
   where source_type = 'service_purchase'
     and source_id = r.purchase_id
     and entry_type = 'earning';

  if v_purchases <> 1 or v_entries <> 1 then
    raise exception
      'VERIFICATION FAILED 14: % purchase(s) and % earning(s) after redelivery, expected 1 and 1',
      v_purchases, v_entries;
  end if;

  perform set_config('app.v40_purchase', r.purchase_id::text, true);
  perform set_config('app.v40_entry', r.entry_id::text, true);

  raise notice
    'PASS 4, 5, 6, 9, 11 and 14: one purchase, exact split with the odd unit to the consultant, attribution from the sent recommendation, earning pending, redelivery a no-op';
end $$;


-- Checks 7 and 8 — no rate, and a zero rate.

do $$
declare
  r record;
  v_entries integer;
begin
  select * into r
    from public.record_service_purchase(
      5000, 'usd', 'test',
      current_setting('app.v40_svc_null')::uuid,
      current_setting('app.v40_clp')::uuid,
      null, 'cs_v40_null', 'pi_v40_null');

  if not r.created then
    raise exception
      'VERIFICATION FAILED 7: the purchase was not recorded for an unrated service';
  end if;

  if r.attributed_consultant_id is null then
    raise exception
      'VERIFICATION FAILED 7: attribution was dropped along with the commission';
  end if;

  if r.entry_id is not null or r.earning_created then
    raise exception
      'VERIFICATION FAILED 7: a null commission rate created a ledger entry';
  end if;

  select * into r
    from public.record_service_purchase(
      5000, 'usd', 'test',
      current_setting('app.v40_svc_zero')::uuid,
      current_setting('app.v40_clp')::uuid,
      null, 'cs_v40_zero', 'pi_v40_zero');

  if not r.created or r.attributed_consultant_id is null then
    raise exception
      'VERIFICATION FAILED 8: the zero-rate purchase was not recorded with its attribution';
  end if;

  if r.entry_id is not null or r.earning_created then
    raise exception
      'VERIFICATION FAILED 8: a zero commission rate created a ledger entry';
  end if;

  select count(*) into v_entries
    from public.consultant_ledger_entries
   where source_type = 'service_purchase'
     and entry_type = 'earning'
     and gross_amount_minor = 5000;

  if v_entries <> 0 then
    raise exception
      'VERIFICATION FAILED 7/8: % zero-value earning(s) exist', v_entries;
  end if;

  raise notice
    'PASS 7 and 8: a null and a zero rate both record the purchase with its attribution and create no ledger entry';
end $$;


-- Check 10, second half — a forged client candidate.
--
-- The only identity a caller can influence is the client. Pointing
-- it at a consultant profile, an admin profile or a stranger must
-- never attribute an earning: an unresolved client means an
-- unattributed purchase, and revenue that is recorded rather than
-- lost.

do $$
declare
  r record;
begin
  select * into r
    from public.record_service_purchase(
      9999, 'usd', 'test',
      current_setting('app.v40_svc')::uuid,
      /* a consultant's profile id, not a client's */
      current_setting('app.v40_cpr')::uuid,
      null, 'cs_v40_forged', 'pi_v40_forged');

  if r.client_profile_id is not null
     or r.attributed_consultant_id is not null then
    raise exception
      'VERIFICATION FAILED 10: a forged client candidate produced client % and consultant %',
      r.client_profile_id, r.attributed_consultant_id;
  end if;

  if r.entry_id is not null then
    raise exception
      'VERIFICATION FAILED 10: an unattributed purchase created an earning';
  end if;

  if not r.created then
    raise exception
      'VERIFICATION FAILED 10: unattributed revenue was discarded instead of recorded';
  end if;

  /* And the other client's own recommendation is not borrowed. */
  select * into r
    from public.record_service_purchase(
      9999, 'usd', 'test',
      current_setting('app.v40_svc')::uuid,
      current_setting('app.v40_olp')::uuid,
      null, 'cs_v40_other', 'pi_v40_other');

  if r.attributed_consultant_id
     is distinct from current_setting('app.v40_oth')::uuid then
    raise exception
      'VERIFICATION FAILED 10: the other client''s purchase attributed to %, expected their own recommending consultant',
      r.attributed_consultant_id;
  end if;

  raise notice
    'PASS 10b: a forged client yields an unattributed but recorded purchase, and attribution never crosses clients';
end $$;


-- Check 23 — currencies stay apart.

do $$
declare
  r record;
  v_rows integer;
begin
  select * into r
    from public.record_service_purchase(
      8000, 'eur', 'test',
      current_setting('app.v40_svc_eur')::uuid,
      current_setting('app.v40_clp')::uuid,
      null, 'cs_v40_eur', 'pi_v40_eur');

  if r.currency <> 'eur' or r.consultant_amount_minor <> 2000 then
    raise exception
      'VERIFICATION FAILED 23: eur purchase recorded as % %, expected eur 2000',
      r.currency, r.consultant_amount_minor;
  end if;

  select count(*) into v_rows
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid;

  if v_rows <> 2 then
    raise exception
      'VERIFICATION FAILED 23: % balance row(s) for the consultant, expected one per currency',
      v_rows;
  end if;

  raise notice
    'PASS 23: usd and eur purchases produce separate balances, never combined';
end $$;


-- Check 24 — a payment with nothing to identify it.

do $$
begin
  begin
    perform 1 from public.record_service_purchase(
      5000, 'usd', 'test',
      current_setting('app.v40_svc')::uuid,
      current_setting('app.v40_clp')::uuid);
    raise exception
      'VERIFICATION FAILED 24: a purchase with no Stripe identifier was recorded';
  exception when raise_exception then
    if sqlerrm not like '%FINANCE_STRIPE_REFERENCE_REQUIRED%' then
      raise;
    end if;
  end;

  raise notice
    'PASS 24: a purchase carrying no Stripe identifier is refused, so nothing unanchored can be written';
end $$;


-- ============================================================
-- PART 3 — FULFILMENT AND AVAILABILITY (rolls back)
-- ============================================================

-- Checks 12, 13, 25 and 26.

do $$
declare
  r record;
  v_pending bigint;
  v_available bigint;
  v_request_status text;
begin
  /* Check 25 — the operational status alone. */
  update public.service_requests
     set status = 'completed'
   where id = current_setting('app.v40_request')::uuid;

  select pending_minor, available_minor
    into v_pending, v_available
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_available <> 0 then
    raise exception
      'VERIFICATION FAILED 25: completing the service_request released % to available; the workflow record must not move money',
      v_available;
  end if;

  /* Check 12. */
  select * into r
    from public.fulfill_service_purchase(
      current_setting('app.v40_purchase')::uuid,
      current_setting('app.v40_admin')::uuid);

  if not r.released or r.reason <> 'released'
     or r.status <> 'fulfilled' or r.fulfilled_at is null then
    raise exception
      'VERIFICATION FAILED 12: fulfilment reported released=% reason=% status=%',
      r.released, r.reason, r.status;
  end if;

  select pending_minor, available_minor
    into v_pending, v_available
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_available <> 4500 or v_pending <> 0 then
    raise exception
      'VERIFICATION FAILED 12: after fulfilment pending %, available %; expected 0 and 4500',
      v_pending, v_available;
  end if;

  /* Check 13 — the double click. */
  select * into r
    from public.fulfill_service_purchase(
      current_setting('app.v40_purchase')::uuid,
      current_setting('app.v40_admin')::uuid);

  if r.released or r.reason <> 'already_fulfilled' then
    raise exception
      'VERIFICATION FAILED 13: a second fulfilment reported released=% reason=%',
      r.released, r.reason;
  end if;

  select available_minor into v_available
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_available <> 4500 then
    raise exception
      'VERIFICATION FAILED 13: a second fulfilment changed the balance to %',
      v_available;
  end if;

  /* Check 26 — the workflow record is untouched by finance. */
  select status::text into v_request_status
    from public.service_requests
   where id = current_setting('app.v40_request')::uuid;

  if v_request_status <> 'completed' then
    raise exception
      'VERIFICATION FAILED 26: fulfilling the purchase changed the service_request to %',
      v_request_status;
  end if;

  raise notice
    'PASS 12, 13, 25 and 26: only purchase fulfilment releases the earning, it is idempotent, and the operational record moves independently in both directions';
end $$;


-- ============================================================
-- PART 4 — RECURRING (rolls back)
-- ============================================================

-- Checks 15, 16 and 17.

do $$
declare
  r1 record;
  r2 record;
  v_entries integer;
  v_duplicate boolean := false;
  v_source text;
begin
  /* Check 15 — the initial subscription invoice. */
  select * into r1
    from public.record_service_purchase(
      p_gross_amount_minor := 20000,
      p_currency := 'usd',
      p_stripe_mode := 'test',
      p_service_id := current_setting('app.v40_svc_sub')::uuid,
      p_client_profile_id := current_setting('app.v40_clp')::uuid,
      p_stripe_invoice_id := 'in_v40_1',
      p_stripe_subscription_id := 'sub_v40',
      p_stripe_payment_intent_id := 'pi_v40_sub1');

  if not r1.created or r1.billing_period_sequence <> 1
     or r1.billing_type <> 'recurring'
     or r1.recurring_interval <> 'month' then
    raise exception
      'VERIFICATION FAILED 15: initial invoice recorded as seq % / % / %',
      r1.billing_period_sequence, r1.billing_type,
      r1.recurring_interval;
  end if;

  if r1.consultant_amount_minor <> 6000 then
    raise exception
      'VERIFICATION FAILED 15: initial invoice earned %, expected 6000 (3000 bps of 20000)',
      r1.consultant_amount_minor;
  end if;

  /* Check 16 — the renewal. A DISTINCT row, a DISTINCT earning. */
  select * into r2
    from public.record_service_purchase(
      p_gross_amount_minor := 20000,
      p_currency := 'usd',
      p_stripe_mode := 'test',
      p_service_id := current_setting('app.v40_svc_sub')::uuid,
      p_client_profile_id := current_setting('app.v40_clp')::uuid,
      p_stripe_invoice_id := 'in_v40_2',
      p_stripe_subscription_id := 'sub_v40',
      p_stripe_payment_intent_id := 'pi_v40_sub2');

  if not r2.created or r2.billing_period_sequence <> 2 then
    raise exception
      'VERIFICATION FAILED 16: the renewal recorded seq %, expected 2',
      r2.billing_period_sequence;
  end if;

  if r2.purchase_id = r1.purchase_id then
    raise exception
      'VERIFICATION FAILED 16: the renewal overwrote the original purchase row';
  end if;

  if r2.entry_id = r1.entry_id or r2.entry_id is null then
    raise exception
      'VERIFICATION FAILED 16: the renewal did not create its own earning';
  end if;

  if r2.consultant_amount_minor <> 6000 then
    raise exception
      'VERIFICATION FAILED 16: the renewal earned %, expected 6000 — commission is earned on every renewal',
      r2.consultant_amount_minor;
  end if;

  select count(*) into v_entries
    from public.consultant_ledger_entries
   where entry_type = 'earning'
     and source_type = 'service_purchase'
     and source_id in (r1.purchase_id, r2.purchase_id);

  if v_entries <> 2 then
    raise exception
      'VERIFICATION FAILED 16: % earnings across two periods, expected 2',
      v_entries;
  end if;

  /* Check 17 — serialisation, and the index that backs it up.
     The advisory lock is asserted in the function source; the
     index is asserted by trying to defeat it. */
  select p.prosrc into v_source
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'record_service_purchase';

  if v_source not like '%pg_advisory_xact_lock%' then
    raise exception
      'VERIFICATION FAILED 17: record_service_purchase does not take an advisory lock before allocating a sequence';
  end if;

  begin
    insert into public.service_purchases (
      service_id, client_profile_id, gross_amount_minor, currency,
      billing_type, recurring_interval, billing_period_sequence,
      status, stripe_mode, stripe_subscription_id, stripe_invoice_id)
    values (
      current_setting('app.v40_svc_sub')::uuid,
      current_setting('app.v40_clp')::uuid, 20000, 'usd',
      'recurring', 'month', 2, 'paid', 'test', 'sub_v40', 'in_v40_dupe');
    raise exception
      'VERIFICATION FAILED 17: a second purchase claimed period 2 of the same subscription';
  exception when unique_violation then
    v_duplicate := true;
  end;

  if not v_duplicate then
    raise exception
      'VERIFICATION FAILED 17: the subscription period index did not refuse a duplicate';
  end if;

  perform set_config('app.v40_sub_purchase', r1.purchase_id::text, true);

  raise notice
    'PASS 15, 16 and 17: the initial invoice and the renewal are distinct purchases at sequences 1 and 2, each with its own earning; allocation is lock-serialised and index-backed';
end $$;


-- ============================================================
-- PART 5 — REFUNDS (rolls back)
-- ============================================================

-- Checks 18, 19, 20, 21 and 22.

do $$
declare
  r record;
  v_before bigint;
  v_after bigint;
  v_pending bigint;
  v_original record;
  v_refused integer := 0;
  v_purchase uuid;
begin
  /* Check 18 — a full refund of a PENDING earning. The reversal
     must inherit the pending state, or a refund would create
     available money out of nothing. */
  select purchase_id into v_purchase
    from public.record_service_purchase(
      12000, 'usd', 'test',
      current_setting('app.v40_svc')::uuid,
      current_setting('app.v40_clp')::uuid,
      null, 'cs_v40_prefund', 'pi_v40_prefund');

  select available_minor into v_before
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  select * into r
    from public.reverse_service_purchase_earning(
      v_purchase, 'refund before fulfilment');

  if not r.reversed or r.status <> 'refunded'
     or r.refunded_amount_minor <> 12000 then
    raise exception
      'VERIFICATION FAILED 18: reversed=% status=% refunded=%',
      r.reversed, r.status, r.refunded_amount_minor;
  end if;

  select available_minor, pending_minor into v_after, v_pending
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_after <> v_before then
    raise exception
      'VERIFICATION FAILED 18: available moved from % to % on a refund of a pending earning',
      v_before, v_after;
  end if;

  if (select available_at from public.consultant_ledger_entries
       where reverses_entry_id = r.entry_id) is not null then
    raise exception
      'VERIFICATION FAILED 18: the reversal of a pending earning was created available';
  end if;

  /* Check 20 — a partial refund of the fulfilled purchase.
     round(4000 * 4500 / 10000) = 1800. */
  select * into r
    from public.reverse_service_purchase_earning(
      current_setting('app.v40_purchase')::uuid,
      'partial refund', 4000);

  if r.refunded_amount_minor <> 4000
     or r.status <> 'fulfilled'
     or r.consultant_amount_minor <> -1800 then
    raise exception
      'VERIFICATION FAILED 20: partial refund recorded % refunded, status %, consultant %',
      r.refunded_amount_minor, r.status, r.consultant_amount_minor;
  end if;

  select available_minor into v_after
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_after <> 2700 then
    raise exception
      'VERIFICATION FAILED 20: available is % after a partial refund, expected 2700',
      v_after;
  end if;

  /* Check 21 — over-refund, from both directions. */
  begin
    perform 1 from public.reverse_service_purchase_earning(
      current_setting('app.v40_purchase')::uuid, 'too much', 99999);
    raise exception
      'VERIFICATION FAILED 21: an over-refund was accepted';
  exception when raise_exception then
    if sqlerrm not like '%FINANCE_REFUND_EXCEEDS_PURCHASE%' then
      raise;
    end if;
    v_refused := v_refused + 1;
  end;

  begin
    perform 1 from public.reverse_service_purchase_earning(
      current_setting('app.v40_purchase')::uuid, 'negative', -100);
    raise exception
      'VERIFICATION FAILED 21: a negative refund was accepted';
  exception when raise_exception then
    if sqlerrm not like '%FINANCE_REVERSAL_AMOUNT_INVALID%' then
      raise;
    end if;
    v_refused := v_refused + 1;
  end;

  if v_refused <> 2 then
    raise exception
      'VERIFICATION FAILED 21: only % of 2 invalid refunds were refused',
      v_refused;
  end if;

  /* Check 19 — the remainder, after fulfilment. */
  select * into r
    from public.reverse_service_purchase_earning(
      current_setting('app.v40_purchase')::uuid, 'remainder');

  if r.refunded_amount_minor <> 9999 or r.status <> 'refunded' then
    raise exception
      'VERIFICATION FAILED 19: after the remainder, refunded % status %',
      r.refunded_amount_minor, r.status;
  end if;

  if (select refunded_at from public.service_purchases
       where id = current_setting('app.v40_purchase')::uuid) is null then
    raise exception
      'VERIFICATION FAILED 19: a fully refunded purchase carries no refunded_at';
  end if;

  /* The original earning is untouched, which is the invariant
     every one of these refunds rests on. */
  select * into v_original
    from public.consultant_ledger_entries
   where id = current_setting('app.v40_entry')::uuid;

  if v_original.consultant_amount_minor <> 4500
     or v_original.gross_amount_minor <> 9999
     or v_original.entry_type <> 'earning' then
    raise exception
      'VERIFICATION FAILED 19: the original earning was mutated to % / %',
      v_original.gross_amount_minor, v_original.consultant_amount_minor;
  end if;

  /* A redelivered refund is a no-op, not a failure. */
  select * into r
    from public.reverse_service_purchase_earning(
      current_setting('app.v40_purchase')::uuid, 'redelivered');

  if r.reversed or r.reason <> 'already_refunded' then
    raise exception
      'VERIFICATION FAILED 21: a redelivered refund reported reversed=% reason=%',
      r.reversed, r.reason;
  end if;

  raise notice
    'PASS 18, 19, 20 and 21: a pending refund creates no available money, a partial refund is proportional and keeps its status, over-refund and negative refunds are refused, the original earning is never mutated, and redelivery is a no-op';
end $$;


-- Check 22 — refunding an earning that was already paid out.

do $$
declare
  v_payout uuid;
  v_available bigint;
  v_lifetime bigint;
  r record;
begin
  /* Pay out the renewal earning, then refund that period. */
  /* First fulfil this subscription period so its earning is genuinely
     available. The payout allocation trigger correctly refuses pending
     ledger entries, so availability must precede allocation. */
  perform public.fulfill_service_purchase(
    current_setting('app.v40_sub_purchase')::uuid,
    current_setting('app.v40_admin')::uuid);

  if (
    select available_at is null
      from public.consultant_ledger_entries
     where source_id = current_setting('app.v40_sub_purchase')::uuid
       and entry_type = 'earning'
     limit 1
  ) then
    raise exception
      'VERIFICATION FAILED 22: subscription earning was not available before payout allocation';
  end if;

  /* Build the payout through the legal lifecycle:
     available earning -> requested payout -> allocation -> approved -> paid. */
  insert into public.payouts (
    consultant_id,
    status,
    currency,
    requested_amount_minor,
    destination_note,
    requested_at)
  values (
    current_setting('app.v40_con')::uuid,
    'requested',
    'usd',
    6000,
    'Wise | v40-consultant@verification.invalid',
    now() - interval '3 minutes')
  returning id into v_payout;

  insert into public.payout_allocations (payout_id, ledger_entry_id)
  select v_payout, e.id
    from public.consultant_ledger_entries e
   where e.source_id = current_setting('app.v40_sub_purchase')::uuid
     and e.entry_type = 'earning';

  update public.payouts
     set status = 'approved',
         approved_at = now() - interval '2 minutes',
         decided_by_admin_profile_id =
           current_setting('app.v40_admin')::uuid,
         admin_note = 'migration 040 verification fixture'
   where id = v_payout;

  update public.payouts
     set status = 'paid',
         paid_amount_minor = 6000,
         external_reference = 'V40-PAID-REF-001',
         paid_at = now() - interval '1 minute'
   where id = v_payout;

  select * into r
    from public.reverse_service_purchase_earning(
      current_setting('app.v40_sub_purchase')::uuid,
      'refund after payout');

  if not r.reversed then
    raise exception
      'VERIFICATION FAILED 22: a paid-out earning could not be reversed';
  end if;

  select available_minor, lifetime_minor
    into v_available, v_lifetime
    from public.consultant_balances
   where consultant_id = current_setting('app.v40_con')::uuid
     and currency = 'usd';

  if v_available >= 0 then
    raise exception
      'VERIFICATION FAILED 22: available is %, expected a negative balance after refunding a paid-out earning',
      v_available;
  end if;

  raise notice
    'PASS 22: refunding a paid-out earning is permitted and drives the balance negative (% available), which future earnings offset',
    v_available;
end $$;


-- ============================================================
-- PART 6 — ACCESS CONTROL AND REGRESSIONS (rolls back)
-- ============================================================

-- Checks 27, 28, 29 and 30.

do $$
declare
  v_client integer;
  v_consultant integer;
  v_other integer;
  v_admin integer;
  v_anon_denied boolean := false;
begin
  set local role authenticated;

  perform set_config('request.jwt.claim.sub',
    current_setting('app.v40_clp'), true);
  select count(*) into v_client from public.service_purchases;

  perform set_config('request.jwt.claim.sub',
    current_setting('app.v40_cpr'), true);
  select count(*) into v_consultant from public.service_purchases;

  perform set_config('request.jwt.claim.sub',
    current_setting('app.v40_opr'), true);
  select count(*) into v_other from public.service_purchases;

  perform set_config('request.jwt.claim.sub',
    current_setting('app.v40_admin'), true);
  select count(*) into v_admin from public.service_purchases;

  reset role;

  /* Check 27 — a client sees no finance record, not even of
     their own purchase. Structural: no policy names
     client_profile_id. */
  if v_client <> 0 then
    raise exception
      'VERIFICATION FAILED 27: a client sees % service purchase(s)', v_client;
  end if;

  /* Check 28 — the consultant sees exactly what is attributed to
     them, and the other consultant sees only theirs. */
  if v_consultant = 0 or v_consultant >= v_admin then
    raise exception
      'VERIFICATION FAILED 28: the consultant sees % of % purchases; expected some but not all',
      v_consultant, v_admin;
  end if;

  if v_other <> 1 then
    raise exception
      'VERIFICATION FAILED 28: the other consultant sees % purchases, expected only their own 1',
      v_other;
  end if;

  /* Check 29. */
  if v_admin < 8 then
    raise exception
      'VERIFICATION FAILED 29: the admin sees only % purchases', v_admin;
  end if;

  /* Check 30. */
  set local role anon;
  begin
    perform 1 from public.service_purchases;
  exception when insufficient_privilege then
    v_anon_denied := true;
  end;
  reset role;

  if not v_anon_denied then
    raise exception
      'VERIFICATION FAILED 30: anon could read service_purchases';
  end if;

  raise notice
    'PASS 27, 28, 29 and 30: client none, consultant only their own (%), admin all (%), anon refused at the privilege layer',
    v_consultant, v_admin;
end $$;


-- Check 31 — migrations 034, 038 and 039 are intact.

do $$
declare
  v_blocked integer := 0;
  v_writes integer;
  v_fn regprocedure;
  v_names text[] := array[
    'record_consultation_earning', 'release_consultation_earning',
    'reverse_ledger_entry', 'reverse_consultation_earning',
    'create_ledger_adjustment', 'request_consultant_payout',
    'decide_payout', 'mark_payout_paid'
  ];
begin
  /* 034 — the ledger is still append-only. */
  begin
    update public.consultant_ledger_entries
       set gross_amount_minor = 1
     where id = current_setting('app.v40_entry')::uuid;
    raise exception
      'VERIFICATION FAILED 31: a ledger amount was updated';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
    v_blocked := v_blocked + 1;
  end;

  begin
    delete from public.consultant_ledger_entries
     where id = current_setting('app.v40_entry')::uuid;
    raise exception
      'VERIFICATION FAILED 31: a ledger entry was deleted';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
    v_blocked := v_blocked + 1;
  end;

  if v_blocked <> 2 then
    raise exception
      'VERIFICATION FAILED 31: only % of 2 ledger mutations were blocked',
      v_blocked;
  end if;

  /* 034 — service_purchases still has no write policy, so this
     migration's RPCs are the only way a purchase is written. */
  select count(*) into v_writes
    from pg_policies
   where schemaname = 'public'
     and tablename = 'service_purchases'
     and cmd <> 'SELECT';

  if v_writes <> 0 then
    raise exception
      'VERIFICATION FAILED 31: % write policy/policies appeared on service_purchases',
      v_writes;
  end if;

  if has_table_privilege(
       'authenticated', 'public.service_purchases', 'INSERT')
     or has_table_privilege(
       'authenticated', 'public.service_purchases', 'UPDATE') then
    raise exception
      'VERIFICATION FAILED 31: authenticated gained a write on service_purchases';
  end if;

  /* 035 and 036 — the pre-existing finance RPCs are untouched. */
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(v_names)
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 31: % became client-callable', v_fn;
    end if;
  end loop;

  /* 038 and 039 still exist and are still shaped as they were. */
  if to_regprocedure(
       'public.get_admin_finance_kpis(timestamptz, timestamptz)'
     ) is null then
    raise exception
      'VERIFICATION FAILED 31: migration 038''s get_admin_finance_kpis disappeared';
  end if;

  if to_regclass('public.consultant_payout_settings') is null then
    raise exception
      'VERIFICATION FAILED 31: migration 039''s consultant_payout_settings disappeared';
  end if;

  if has_table_privilege(
       'anon', 'public.consultant_payout_settings', 'SELECT') then
    raise exception
      'VERIFICATION FAILED 31: anon gained access to consultant_payout_settings';
  end if;

  raise notice
    'PASS 31: the ledger is still append-only, service_purchases still has no write path, and migrations 035-039 are unchanged';
end $$;

rollback;


-- Fixtures rolled back.

do $$
declare
  v_left integer;
  v_purchases integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v40-%@verification.invalid';

  select count(*) into v_purchases
    from public.service_purchases
   where stripe_checkout_session_id like 'cs_v40_%'
      or stripe_invoice_id like 'in_v40_%';

  if v_left <> 0 or v_purchases <> 0 then
    raise exception
      'VERIFICATION FAILED: % profile(s) and % purchase(s) survived the rollback',
      v_left, v_purchases;
  end if;

  raise notice 'PASS: every fixture rolled back';
end $$;


-- ============================================================
-- PART 7 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Rolling this back stops service purchases being reconciled into
-- the database. Purchases already recorded stay recorded, and
-- their ledger entries stay in the ledger — nothing here rewrites
-- either — but new payments would once again exist only in
-- Stripe, and consultants would stop earning on services.
--
--   -- 1. the RPCs. Drop the orchestrator's calls first, or its
--   --    webhook will 500 on every service payment.
--   drop function if exists
--     public.reverse_service_purchase_earning(uuid, text, integer);
--   drop function if exists
--     public.fulfill_service_purchase(uuid, uuid);
--   drop function if exists public.record_service_purchase(
--     integer, text, text, uuid, uuid, text, text, text, text, text);
--
--   -- 2. the indexes and the constraint.
--   drop index if exists public.uq_service_purchases_subscription_period;
--   drop index if exists public.idx_service_purchases_subscription;
--   alter table public.service_purchases
--     drop constraint if exists service_purchases_refunded_amount_check;
--
--   -- 3. the columns. This DESTROYS the record of which
--   --    subscription a purchase belonged to and how much of it
--   --    was refunded. Export both before dropping.
--   alter table public.service_purchases
--     drop column if exists stripe_subscription_id,
--     drop column if exists refunded_amount_minor;
--
-- reverse_ledger_entry, the ledger, the balances view, the payout
-- flow and every migration 034-039 object are untouched by this
-- migration and need no part in undoing it.
-- ============================================================

do $$
begin
  raise notice
    'migration 040 verification complete: no check raised';
end $$;