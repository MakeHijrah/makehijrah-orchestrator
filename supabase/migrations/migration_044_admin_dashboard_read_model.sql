-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 044: Admin dashboard read model
-- ============================================================
--
-- Classification:
-- - Read model only. Two SECURITY DEFINER functions. No table, no
--   column, no index, no policy, no grant on any existing object,
--   no write path of any kind, and no change to
--   get_admin_finance_kpis.
--
-- The problem this solves:
-- - /admin needs to answer two questions — "how is the business
--   performing" and "what needs my attention" — and today it can
--   only answer them by pulling rows into a browser and adding
--   them up. PostgREST aggregates are disabled precisely so that
--   cannot happen quietly, so the aggregation has to live here.
-- - get_admin_finance_kpis (migration 038) already totals the
--   ledger per currency, but it has no SOURCE dimension, so it
--   cannot separate consultation revenue from service purchase
--   revenue from direct-booking revenue. It is deliberately left
--   alone: its column list is asserted exactly by its own
--   verification, and its contract is the finance page's.
--
-- What this migration adds:
--   A. get_admin_revenue_by_source()      the money, split
--   B. get_admin_dashboard_operations()   the counts and alerts
--   C. Privileges.
--
-- RECORDED REVENUE, AND WHAT IT IS NOT
--
-- Part A aggregates consultant_ledger_entries and nothing else.
-- That makes it the same figure, by the same arithmetic, as the
-- finance page — but it is NOT every dollar Stripe collected, and
-- the difference is not rounding.
--
-- An unattributed service purchase — one with no consultant to
-- credit, or a service with no commission rate — creates a
-- service_purchases row and NO ledger entry (migration 040). Its
-- gross is real money and it is absent from every figure part A
-- returns.
--
-- The honest response is to name the metric for what it is and to
-- surface the gap beside it, which is why part B reports
-- unattributed purchase gross per currency as an ALERT. Mixing
-- service_purchases.gross_amount_minor into part A would produce a
-- larger, rounder number that double-counts every attributed sale
-- and reconciles to nothing.
--
--   The UI must label this "Recorded Revenue", never "Revenue".
--
-- Deliberately NOT done here:
-- - No FX and no cross-currency total anywhere. Every money figure
--   is grouped by currency, and a deployment selling in two
--   currencies gets two sets of figures rather than one wrong one.
-- - No now(). Both functions take explicit bounds, so the same
--   arguments always produce the same answer and a test can assert
--   an exact figure rather than a moving one. The month-boundary
--   arithmetic belongs to the caller.
-- - No orchestrator endpoint. These are read directly by an
--   admin's Supabase client, exactly as get_admin_finance_kpis is.
-- - No alert that is not unambiguously an error under current
--   business rules. An inactive consultant, a service with no
--   commission rate, a consultant without Google or without
--   working hours and a long-open service request are all normal
--   states in this system, so none of them appears here.
--
-- Rerun safety:
-- - Idempotent. Both functions are CREATE OR REPLACE at fixed
--   signatures and REVOKE/GRANT are declarative.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
declare
  v_name text;
  v_missing text[] := '{}';
begin
  foreach v_name in array array[
    'public.consultant_ledger_entries',
    'public.consultant_balances',
    'public.payouts',
    'public.service_purchases',
    'public.consultations',
    'public.consultants'
  ]
  loop
    if to_regclass(v_name) is null then
      v_missing := v_missing || v_name;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'migration 044: missing prerequisite relation(s): % - migrations 001, 034 and 040 must be applied first',
      array_to_string(v_missing, ', ');
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception
      'migration 044: public.is_admin() not found - migration 002 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'service_purchases'
       and column_name = 'refunded_amount_minor'
  ) then
    raise exception
      'migration 044: service_purchases.refunded_amount_minor not found - migration 040 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. get_admin_revenue_by_source
-- ============================================================
--
-- Recorded revenue for two periods at once, split by currency and
-- by where the money came from.
--
-- Both periods in one call rather than two, because the dashboard
-- always wants them together and a single round trip is the whole
-- point of a read model. `period` labels each row 'current' or
-- 'comparison'; the caller decides what those periods mean.
--
-- EVERY source_type is returned, including 'manual' — admin
-- adjustments are real ledger movements, and omitting them would
-- break the property that makes this safe to display:
--
--     the sum of the source rows for a currency IS the recorded
--     total for that currency
--
-- so a scoped KPI is a SUBSET of the total rather than a second
-- figure computed a second way. Nothing can double-count, because
-- there is only one computation.
--
-- 'direct_booking' returns no rows today because no such entry
-- exists yet. That is correct and forward-compatible: migration
-- 034 admitted the source type before the feature was built, so
-- the day direct booking ships this starts reporting it with no
-- change here.
--
-- The three money columns are NET — they include reversals, which
-- are negative by constraint, and adjustments. reversals_minor
-- breaks out the reversal component OF those sums; it is not a
-- further deduction to apply. Identical to migration 038's
-- convention, so the dashboard and the finance page cannot
-- disagree.

create or replace function public.get_admin_revenue_by_source(
  p_current_from timestamptz,
  p_current_to timestamptz,
  p_compare_from timestamptz,
  p_compare_to timestamptz
)
returns table (
  period text,
  currency text,
  source_type text,
  gross_revenue_minor bigint,
  platform_revenue_minor bigint,
  consultant_earnings_minor bigint,
  reversals_minor bigint,
  entry_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  /*
   * Who is asking, before the arguments are looked at, so a
   * non-admin learns nothing about the parameter shape from the
   * error they get back. 42501 renders as HTTP 403 through
   * PostgREST.
   */
  if not public.is_admin() then
    raise exception
      'get_admin_revenue_by_source: administrator access required'
      using errcode = '42501';
  end if;

  if p_current_from is null or p_current_to is null
     or p_compare_from is null or p_compare_to is null then
    raise exception
      'get_admin_revenue_by_source: all four period bounds are required'
      using errcode = '22004';
  end if;

  if p_current_from >= p_current_to
     or p_compare_from >= p_compare_to then
    raise exception
      'get_admin_revenue_by_source: each period must start before it ends'
      using errcode = '22023';
  end if;

  return query
  with periods (period, from_at, to_at) as (
    values
      ('current'::text, p_current_from, p_current_to),
      ('comparison'::text, p_compare_from, p_compare_to)
  )
  select
    p.period,
    e.currency,
    e.source_type,

    coalesce(sum(e.gross_amount_minor), 0)::bigint,
    coalesce(sum(e.platform_amount_minor), 0)::bigint,
    coalesce(sum(e.consultant_amount_minor), 0)::bigint,

    coalesce(
      sum(e.gross_amount_minor)
        filter (where e.entry_type = 'reversal'),
      0
    )::bigint,

    count(*)::bigint

  from periods p
  join public.consultant_ledger_entries e
    on e.created_at >= p.from_at
   and e.created_at < p.to_at

  group by p.period, e.currency, e.source_type
  order by p.period, e.currency, e.source_type;
end;
$$;

comment on function public.get_admin_revenue_by_source(
  timestamptz, timestamptz, timestamptz, timestamptz) is
  'Migration 044. RECORDED revenue for a current and a comparison '
  'period, grouped by currency and ledger source_type. Aggregates '
  'consultant_ledger_entries ONLY, so it excludes unattributed '
  'service purchases, which create no ledger entry - the UI must '
  'label this "Recorded Revenue", never "Revenue", and '
  'get_admin_dashboard_operations reports the unattributed gross '
  'separately. Every source type is returned so the source rows '
  'sum to the recorded total and a scoped KPI is a subset rather '
  'than a second computation. Never sums across currencies and '
  'performs no FX. Admin only; returns no ledger row and takes no '
  'filter beyond the four period bounds.';


-- ============================================================
-- B. get_admin_dashboard_operations
-- ============================================================
--
-- Everything on the dashboard that is not recorded revenue: the
-- counts, the two point-in-time balances, and the five alerts.
--
-- One row, so the dashboard makes one call. The per-currency
-- figures are jsonb arrays of {currency, amount_minor} rather than
-- extra rows, because they are genuinely per-currency and folding
-- them into the row shape would either force a cross-currency
-- total or multiply the row count for no gain. They are ordered by
-- currency and default to '[]' rather than null, so a caller never
-- has to defend against a missing array.
--
-- The two balances are deliberately NOT period-scoped. What is
-- owed right now is a balance, not a flow; scoping it to a month
-- would produce a figure that means nothing.
--
-- Only the five alert categories that are unambiguously errors
-- appear. An inactive consultant, a service without a commission
-- rate, a consultant without Google or without working hours and
-- an old service request are all legitimate states here, so none
-- of them is reported as something needing attention.

create or replace function public.get_admin_dashboard_operations(
  p_current_from timestamptz,
  p_current_to timestamptz,
  p_compare_from timestamptz,
  p_compare_to timestamptz
)
returns table (
  /* Bookings created in each period, drafts excluded. */
  consultations_current bigint,
  consultations_comparison bigint,

  active_consultants bigint,
  new_consultants_current bigint,

  /* Point in time, per currency. */
  pending_payouts_by_currency jsonb,
  available_earnings_by_currency jsonb,

  /* Alert 1 - consultations needing attention. */
  attention_consultations_count bigint,
  attention_consultations_oldest timestamptz,

  /* Alert 2 - pending payout requests. Amounts are the same
     figure as pending_payouts_by_currency above. */
  pending_payouts_count bigint,
  pending_payouts_oldest timestamptz,

  /* Alert 3 - paid but not yet fulfilled. */
  unfulfilled_purchases_count bigint,
  unfulfilled_purchases_oldest timestamptz,

  /* Alert 4 - revenue nobody is credited for, and therefore
     absent from recorded revenue. */
  unattributed_purchases_count bigint,
  unattributed_purchases_oldest timestamptz,
  unattributed_purchases_by_currency jsonb,

  /* Alert 5 - partially refunded. */
  partially_refunded_count bigint,
  partially_refunded_oldest timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_admin() then
    raise exception
      'get_admin_dashboard_operations: administrator access required'
      using errcode = '42501';
  end if;

  if p_current_from is null or p_current_to is null
     or p_compare_from is null or p_compare_to is null then
    raise exception
      'get_admin_dashboard_operations: all four period bounds are required'
      using errcode = '22004';
  end if;

  if p_current_from >= p_current_to
     or p_compare_from >= p_compare_to then
    raise exception
      'get_admin_dashboard_operations: each period must start before it ends'
      using errcode = '22023';
  end if;

  return query
  select
    /*
     * Bookings CREATED in the period, not consultations completed
     * in it. A draft is an abandoned thirty-minute hold rather
     * than a booking, so it is excluded; nothing else is.
     */
    (select count(*)::bigint
       from public.consultations c
      where c.created_at >= p_current_from
        and c.created_at < p_current_to
        and c.status <> 'draft'),

    (select count(*)::bigint
       from public.consultations c
      where c.created_at >= p_compare_from
        and c.created_at < p_compare_to
        and c.status <> 'draft'),

    (select count(*)::bigint
       from public.consultants c
      where c.is_active),

    (select count(*)::bigint
       from public.consultants c
      where c.created_at >= p_current_from
        and c.created_at < p_current_to),

    /*
     * What is reserved against open payout requests, per currency.
     * 'requested' and 'approved' are the two open states; a paid,
     * rejected or cancelled payout is no longer a liability.
     */
    (select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'currency', t.currency,
                  'amount_minor', t.amount_minor
                )
                order by t.currency
              ),
              '[]'::jsonb)
       from (
         select p.currency,
                sum(p.requested_amount_minor)::bigint
                  as amount_minor
           from public.payouts p
          where p.status in ('requested', 'approved')
          group by p.currency
       ) t),

    /*
     * What consultants could withdraw right now, per currency.
     * Read from consultant_balances so there is one definition of
     * "available" rather than a second one here. The view is
     * security_invoker, and inside this SECURITY DEFINER function
     * the invoker is the owner - so it sees every consultant.
     */
    (select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'currency', t.currency,
                  'amount_minor', t.amount_minor
                )
                order by t.currency
              ),
              '[]'::jsonb)
       from (
         select b.currency,
                sum(b.available_minor)::bigint as amount_minor
           from public.consultant_balances b
          group by b.currency
       ) t),

    /*
     * Alert 1. updated_at rather than created_at: what matters is
     * how long it has been WAITING, and a consultation enters
     * admin_attention long after it was created.
     */
    (select count(*)::bigint
       from public.consultations c
      where c.status = 'admin_attention'),

    (select min(c.updated_at)
       from public.consultations c
      where c.status = 'admin_attention'),

    -- Alert 2.
    (select count(*)::bigint
       from public.payouts p
      where p.status in ('requested', 'approved')),

    (select min(p.requested_at)
       from public.payouts p
      where p.status in ('requested', 'approved')),

    /*
     * Alert 3. 'paid' is precisely "money taken, nothing released
     * to the consultant yet" - fulfilment is what makes the
     * earning available, so this is the queue for that action.
     */
    (select count(*)::bigint
       from public.service_purchases sp
      where sp.status = 'paid'),

    (select min(sp.purchased_at)
       from public.service_purchases sp
      where sp.status = 'paid'),

    /*
     * Alert 4. The gap in recorded revenue, made visible. These
     * purchases created no ledger entry, so their gross appears in
     * no figure part A returns.
     */
    (select count(*)::bigint
       from public.service_purchases sp
      where sp.attributed_consultant_id is null),

    (select min(sp.purchased_at)
       from public.service_purchases sp
      where sp.attributed_consultant_id is null),

    (select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'currency', t.currency,
                  'amount_minor', t.amount_minor
                )
                order by t.currency
              ),
              '[]'::jsonb)
       from (
         select sp.currency,
                sum(sp.gross_amount_minor)::bigint as amount_minor
           from public.service_purchases sp
          where sp.attributed_consultant_id is null
          group by sp.currency
       ) t),

    /*
     * Alert 5. updated_at, not refunded_at: refunded_at is set
     * only when a purchase becomes fully refunded, so a partially
     * refunded row has none. updated_at moves on each refund, so
     * the minimum is the partial refund that has sat longest.
     */
    (select count(*)::bigint
       from public.service_purchases sp
      where sp.refunded_amount_minor > 0
        and sp.refunded_amount_minor < sp.gross_amount_minor),

    (select min(sp.updated_at)
       from public.service_purchases sp
      where sp.refunded_amount_minor > 0
        and sp.refunded_amount_minor < sp.gross_amount_minor);
end;
$$;

comment on function public.get_admin_dashboard_operations(
  timestamptz, timestamptz, timestamptz, timestamptz) is
  'Migration 044. The non-revenue half of the admin dashboard in '
  'one row: booking counts for two periods (drafts excluded), '
  'active and new consultant counts, pending payout liability and '
  'available consultant earnings per currency, and five alert '
  'categories with counts and ages. Per-currency figures are jsonb '
  'arrays of {currency, amount_minor}, ordered and defaulting to '
  '[] - never combined and never converted. Reports the '
  'unattributed service purchase gross that recorded revenue '
  'cannot include. Admin only; returns no row of any underlying '
  'table.';


-- ============================================================
-- C. Privileges
-- ============================================================
--
-- Migration 038's model, applied unchanged. CREATE FUNCTION grants
-- EXECUTE to PUBLIC and Supabase's default privileges grant it to
-- anon, authenticated and service_role, so every role is named
-- rather than assumed.
--
-- authenticated IS granted, because the caller is an
-- administrator's browser reading through the Supabase client -
-- the same path get_admin_finance_kpis already uses. It is safe
-- for the same reason: the grant is the door, is_admin() inside is
-- the lock, and a client or consultant key that reaches the door
-- is refused inside.
--
-- anon is revoked by name as well as through PUBLIC, so migration
-- 036's assertion that is_admin() is the only function an anon key
-- may execute continues to hold.
--
-- service_role is revoked. It bypasses RLS but carries no JWT, so
-- is_admin() is false for it and the call would be refused inside
-- anyway; revoking states that at the ACL instead of leaving a
-- grant that only fails at runtime.

do $$
declare
  v_fn regprocedure;
  v_names text[] := array[
    'get_admin_revenue_by_source',
    'get_admin_dashboard_operations'
  ];
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    execute format(
      'revoke all on function %s from public, anon, service_role',
      v_fn
    );

    execute format(
      'grant execute on function %s to authenticated', v_fn
    );
  end loop;
end;
$$;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_044_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname in (
--          'get_admin_revenue_by_source',
--          'get_admin_dashboard_operations');
--       -> 2
--
--  2. select has_function_privilege('anon',
--       'public.get_admin_revenue_by_source(timestamptz, timestamptz, timestamptz, timestamptz)',
--       'EXECUTE');
--       -> false
--
--  3. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 21  (unchanged; this migration adds no table)
