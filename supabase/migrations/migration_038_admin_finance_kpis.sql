-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 038: Admin finance KPI read model
-- ============================================================
--
-- Classification:
-- - Read model only. One SECURITY DEFINER function and one index.
--   No ledger logic, no commission logic, no payout logic, no
--   policy change, no column change, no table.
--
-- The problem this solves:
-- - PostgREST aggregate functions are disabled, so an admin
--   finance screen asking "what did we earn between these two
--   dates" has no way to sum server-side. The alternative it
--   would otherwise fall back on is downloading up to 5,000
--   consultant_ledger_entries rows into a browser and adding
--   them up in JavaScript. That is wrong three times over: it
--   ships every consultant's individual earning, every
--   commission rate and every memo to the client, it silently
--   truncates at whatever page size PostgREST returns, and it
--   invites a browser to add two currencies together.
-- - Enabling aggregates globally would fix the arithmetic and
--   make the other two worse, so it is not done. The totals are
--   computed in the database and only the totals cross the wire.
--
-- What this migration does:
--   A. idx_ledger_created_at, so a period scan is an index range
--      rather than a sequential read of the whole ledger.
--   B. public.get_admin_finance_kpis(timestamptz, timestamptz),
--      which returns one row per currency of period totals.
--   C. Privileges: PUBLIC, anon and service_role revoked;
--      authenticated granted, because the caller is an admin's
--      browser and the function decides for itself whether that
--      admin is real.
--
-- Why SECURITY DEFINER with an is_admin() check inside, rather
-- than a security_invoker view:
-- - A security_invoker view would be filtered by
--   ledger_select_own_or_admin, so a consultant calling it would
--   get their own totals rather than nothing. Consultant-facing
--   figures already have a home (public.consultant_balances) and
--   this is an admin instrument; a read model that quietly
--   returns a different answer per caller is the kind of thing
--   that ends up on the wrong screen.
-- - SECURITY DEFINER bypasses the ledger RLS deliberately, which
--   is the only way to total rows belonging to every consultant
--   in one query. Bypassing RLS is safe here precisely because
--   the function has no row-returning path: it aggregates before
--   it returns, so there is no argument and no combination of
--   arguments that yields a ledger row, a consultant id, a
--   commission rate, a memo or a source id.
--
-- The parameter surface is deliberately two timestamps and
-- nothing else. No consultant filter, no entry-type filter, no
-- ORDER BY, no LIMIT, no text predicate, no column list — there
-- is nothing a caller can pass that changes which columns are
-- read or how the rows are grouped, so there is no injection
-- surface and no way to narrow the aggregate down until it
-- identifies a single consultant's single entry.
--
-- What the seven returned columns mean, exactly:
--
--   currency                    lowercase ISO 4217, one row each.
--                               Never summed across currencies;
--                               there is no FX conversion in this
--                               system and none is invented here.
--
--   gross_revenue_minor         sum of gross_amount_minor over
--   platform_revenue_minor      sum of platform_amount_minor
--   consultant_earnings_minor   sum of consultant_amount_minor
--
--     ...over EVERY entry in the period, whatever its type. They
--     are therefore NET: a reversal carries negative amounts by
--     constraint (ledger_sign_check) and so reduces all three,
--     and an admin adjustment moves them by its own signed
--     amount. This is the choice a period KPI wants — "what did
--     this month actually produce" — and it has one property no
--     earnings-only reading has: because
--
--         consultant_amount_minor + platform_amount_minor
--           = gross_amount_minor
--
--     holds on every row, it holds on the totals too. A screen
--     showing all three can never display a set of figures that
--     do not add up.
--
--   reversals_minor             sum of gross_amount_minor over
--                               reversal entries only. Zero or
--                               negative. This is a COMPONENT of
--                               gross_revenue_minor above, broken
--                               out so a refunds tile does not
--                               need a second query — not an
--                               additional deduction to apply.
--
--   adjustments_minor           the same for adjustment entries.
--                               Either sign.
--
--   ledger_entry_count          rows in the period, all types.
--                               An audit figure: it says how many
--                               facts the totals rest on, which
--                               is what tells an admin whether a
--                               zero means "nothing happened" or
--                               "something is wrong".
--
--   With those two components exposed, the earnings-only reading
--   is exact arithmetic on the client rather than a second call:
--
--     earnings gross = gross_revenue_minor
--                      - reversals_minor - adjustments_minor
--
-- Period semantics: HALF-OPEN, [p_from, p_to).
-- - created_at >= p_from and created_at < p_to. Consecutive
--   periods therefore tile exactly — a row at midnight belongs to
--   the month that starts, not to both.
-- - created_at is the period column, not available_at. This
--   answers "what did the platform earn in this window", which is
--   a question about when the money was transacted. When an
--   earning becomes withdrawable is a different question and is
--   already answered, point in time, by consultant_balances.
--
-- Deliberately NOT done here:
-- - No available / reserved / pending totals. Those are
--   point-in-time balances, they already exist on
--   public.consultant_balances, and a second implementation of
--   them is a second thing to disagree with the first. A period
--   sum and a current balance are not the same figure and must
--   not be produced by the same function.
-- - No FX conversion, no reporting currency, no cross-currency
--   total.
-- - No per-consultant breakdown. That is a different read model
--   with a different disclosure profile; it is not needed for
--   period KPIs and is not added speculatively.
-- - No change to consultant_ledger_entries beyond adding an
--   index: no column, no constraint, no trigger, no policy.
-- - No grant to service_role, and no orchestrator endpoint. The
--   function authorises the JWT it is called under, and the
--   service role carries no JWT, so an orchestrator call would
--   be denied. If a server-side caller is ever needed it gets
--   its own explicitly authorised wrapper rather than a hole
--   in this one.
-- - PostgREST aggregates stay disabled. Nothing here enables,
--   requests or depends on them.
--
-- Rerun safety:
-- - Idempotent. The index uses IF NOT EXISTS, the function is
--   CREATE OR REPLACE at a fixed signature so a re-run cannot
--   leave an overload behind, and REVOKE/GRANT are declarative.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----
--
-- Each of these is used below. Failing here by name beats failing
-- later inside a function body.

do $$
begin
  if to_regclass('public.consultant_ledger_entries') is null then
    raise exception
      'migration 038: public.consultant_ledger_entries not found - migration 034 must be applied first';
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception
      'migration 038: public.is_admin() not found - migration 002 must be applied first';
  end if;

  if to_regclass('public.consultant_balances') is null then
    raise exception
      'migration 038: public.consultant_balances not found - migration 034 must be applied first';
  end if;
end;
$$;


-- ============================================================
-- A. The period index
-- ============================================================
--
-- Every read this migration adds is bounded by created_at, and
-- the ledger has no index on it: migration 034 indexed the
-- consultant, the availability flag and the reversal link, all of
-- which serve per-consultant questions. A finance period is a
-- range over the whole table, so it gets its own.
--
-- Not a partial index and not a composite with currency. The
-- range is the selective part; currency has a handful of distinct
-- values and grouping them after the range scan is cheaper than
-- carrying them in the key.

create index if not exists idx_ledger_created_at
  on public.consultant_ledger_entries (created_at);


-- ============================================================
-- B. get_admin_finance_kpis
-- ============================================================

create or replace function public.get_admin_finance_kpis(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  currency text,
  gross_revenue_minor bigint,
  platform_revenue_minor bigint,
  consultant_earnings_minor bigint,
  reversals_minor bigint,
  adjustments_minor bigint,
  ledger_entry_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  /*
   * 1. Who is asking.
   *
   *    First, before the arguments are even looked at, so a
   *    non-admin learns nothing about the shape of the parameters
   *    from the error they get back. is_admin() reads the JWT
   *    through auth.uid() and resolves the caller's own profile
   *    row; there is no parameter here through which a caller
   *    could name themselves, so identity cannot be supplied,
   *    only proved.
   *
   *    A consultant and a client both fail this check. Neither
   *    has any business with platform-wide revenue, and the
   *    consultant's own figures are on consultant_balances.
   *
   *    42501 is insufficient_privilege: PostgREST renders it as
   *    403, which is what an admin-only surface should return.
   */
  if not public.is_admin() then
    raise exception
      'get_admin_finance_kpis: administrator access required'
      using errcode = '42501';
  end if;

  /*
   * 2. The two arguments.
   *
   *    Null is rejected rather than treated as unbounded. An
   *    accidental null from a client would otherwise silently
   *    total the entire ledger and present it as a month.
   */
  if p_from is null or p_to is null then
    raise exception
      'get_admin_finance_kpis: p_from and p_to are both required'
      using errcode = '22004';
  end if;

  if p_from >= p_to then
    raise exception
      'get_admin_finance_kpis: p_from (%) must be earlier than p_to (%)',
      p_from, p_to
      using errcode = '22023';
  end if;

  /*
   * 3. The totals.
   *
   *    One pass over the period, grouped by currency and by
   *    nothing else. sum() over an integer column returns bigint,
   *    so a period cannot overflow the way an int4 sum would.
   *
   *    Every figure is coalesced to zero for the same reason the
   *    balance view does it: a FILTER that matches no row sums to
   *    null, and a null total would have to be defended against
   *    by every caller. A currency that saw earnings but no
   *    refunds reports reversals_minor = 0, not null.
   *
   *    A period with no entries at all produces NO ROWS. There is
   *    no fixed list of currencies to zero-fill against and
   *    inventing one would mean asserting which currencies the
   *    platform trades in. An empty result is the honest and safe
   *    answer, and a caller renders it as zeros.
   */
  return query
  select
    e.currency,

    coalesce(sum(e.gross_amount_minor), 0)::bigint,
    coalesce(sum(e.platform_amount_minor), 0)::bigint,
    coalesce(sum(e.consultant_amount_minor), 0)::bigint,

    coalesce(
      sum(e.gross_amount_minor)
        filter (where e.entry_type = 'reversal'),
      0
    )::bigint,

    coalesce(
      sum(e.gross_amount_minor)
        filter (where e.entry_type = 'adjustment'),
      0
    )::bigint,

    count(*)::bigint

  from public.consultant_ledger_entries e
  where e.created_at >= p_from
    and e.created_at < p_to
  group by e.currency
  order by e.currency;
end;
$$;

comment on function public.get_admin_finance_kpis(
  timestamptz, timestamptz) is
  'Migration 038. Admin finance KPI read model. Returns one row '
  'per currency of totals over consultant_ledger_entries with '
  'created_at in the half-open period [p_from, p_to). Admin only: '
  'raises insufficient_privilege unless is_admin() holds for the '
  'calling JWT, so a consultant and a client both get nothing. '
  'gross_revenue_minor, platform_revenue_minor and '
  'consultant_earnings_minor are NET — they include reversals, '
  'which are negative by constraint, and adjustments — and '
  'reversals_minor and adjustments_minor break out those two '
  'components of the same sums. Never sums across currencies and '
  'performs no FX conversion. Returns no ledger row, no '
  'consultant id, no commission rate and no memo, and takes no '
  'filter parameter through which one could be reached. Point-in-'
  'time available, reserved and pending earnings are deliberately '
  'NOT here; they live on public.consultant_balances.';


-- ============================================================
-- C. Privileges
-- ============================================================
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC, and Supabase issues
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon,
-- authenticated, service_role. A grant held by name survives a
-- REVOKE aimed at PUBLIC, which is the bug migration 036 exists
-- to correct, so every role is named here rather than assumed.
--
-- authenticated IS granted, and that is the deliberate exception
-- to migration 036's rule that an RPC is service_role only. The
-- caller is an administrator's browser reading through the
-- Supabase client, which is how every other admin read in this
-- system already works (API_CONTRACT §4). The grant is safe
-- because the function does not trust the role it was called
-- under: authenticated is the door, is_admin() is the lock, and a
-- consultant or client key that reaches the door is refused
-- inside.
--
-- anon is revoked by name as well as through PUBLIC, so
-- migration 036's assertion — that is_admin() is the only
-- function an anon key may execute — continues to hold.
--
-- service_role is revoked deliberately. It bypasses RLS but
-- carries no JWT, so is_admin() is false for it and the call
-- would be refused inside anyway; revoking states that intent at
-- the ACL instead of leaving a grant that only fails at runtime.

revoke all on function public.get_admin_finance_kpis(
  timestamptz, timestamptz) from public;
revoke all on function public.get_admin_finance_kpis(
  timestamptz, timestamptz) from anon;
revoke all on function public.get_admin_finance_kpis(
  timestamptz, timestamptz) from service_role;

grant execute on function public.get_admin_finance_kpis(
  timestamptz, timestamptz) to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_038_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public'
--        and p.proname = 'get_admin_finance_kpis';
--       -> 1
--
--  2. select has_function_privilege(
--       'authenticated',
--       'public.get_admin_finance_kpis(timestamptz, timestamptz)',
--       'EXECUTE');
--       -> true
--
--  3. select has_function_privilege(
--       'anon',
--       'public.get_admin_finance_kpis(timestamptz, timestamptz)',
--       'EXECUTE');
--       -> false
--
--  4. select count(*) from pg_indexes
--      where schemaname = 'public'
--        and indexname = 'idx_ledger_created_at';
--       -> 1
--
--  5. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 20  (unchanged; this migration adds no table)
