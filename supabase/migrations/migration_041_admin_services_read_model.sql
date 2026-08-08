-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 041: Admin services read model
-- ============================================================
--
-- Classification:
-- - Read model only. One admin-scoped view. No change to any
--   grant on public.services, no policy change, no column change,
--   no table, no RPC behaviour change.
--
-- The problem this solves:
-- - The Admin Services page selects services.consultant_commission_bps
--   and gets 403 Forbidden.
-- - That is correct behaviour, not a bug in the page. Migration
--   034 part E revoked the table-level SELECT on public.services
--   from anon and authenticated and replaced it with a COLUMN
--   list that deliberately omits consultant_commission_bps,
--   because services_select_active (migration 002) is readable by
--   every authenticated user and RLS filters rows, not columns.
--   Without that surgery, every client who can read a service
--   could read the platform's margin on it.
-- - The reason it now bites an admin is the shape of Supabase
--   auth: there is exactly ONE logged-in database role. An
--   administrator is an `authenticated` user distinguished only
--   by profiles.role, which RLS can see through is_admin() and
--   which a column privilege cannot see at all. There is no
--   GRANT that says "this column, but only for admins".
--
-- Why this is NOT fixed by granting the column:
-- - `grant select (consultant_commission_bps) on public.services
--    to authenticated` would hand the platform's margin on every
--   service to every client and every consultant, because they
--   hold the same role. It would silently undo migration 034
--   part E and there would be nothing left enforcing the rule.
--
-- What this migration does instead:
--   A. public.admin_services — the admin projection of the
--      service catalog, including the commission rate, readable
--      only by an administrator.
--
-- How the view can read a column its callers cannot:
-- - It is an ordinary view, so it executes as its OWNER rather
--   than as the caller. That is the same mechanism a SECURITY
--   DEFINER function uses, and the same reason migration 038's
--   get_admin_finance_kpis can aggregate a ledger the caller
--   cannot read.
-- - Deliberately NOT security_invoker. A security_invoker view
--   would apply the caller's own column privileges and fail with
--   exactly the 403 this migration exists to fix. Migration 034's
--   consultant_balances IS security_invoker, and that difference
--   is intentional: there the ledger's RLS is the access rule and
--   must be honoured per caller; here the access rule is "are you
--   an administrator", and it is stated once, below.
-- - security_barrier is on. Without it PostgreSQL may push a
--   caller-supplied predicate below the is_admin() filter, and a
--   deliberately leaky operator or function in a WHERE clause
--   could then observe values from rows the caller should never
--   have reached. With a view acting as a privacy boundary that
--   is not a theoretical concern, so the barrier is set.
--
-- Deliberately NOT done here:
-- - NO change to public.services: not its grants, not its column
--   list, not its policies. Every public and client selector
--   reads exactly what it read yesterday, and
--   has_column_privilege('authenticated', ...,
--   'consultant_commission_bps', 'SELECT') stays FALSE — which
--   migration 034's own verification asserts.
-- - No grant to anon. An anonymous key holds nothing on this
--   view, so it cannot reach it even to be filtered.
-- - No write path. The catalog is still written only through the
--   admin endpoints of Amendment 004, which use the service role.
-- - No new column and no new information. Everything here is
--   already visible to an administrator through the orchestrator's
--   admin service endpoints; this is the same projection, reachable
--   by the direct Supabase read the admin catalog page uses.
--
-- Rerun safety:
-- - Idempotent. CREATE OR REPLACE VIEW at a fixed column list,
--   and REVOKE/GRANT are declarative.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.services') is null then
    raise exception
      'migration 041: public.services not found - migration 001 must be applied first';
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception
      'migration 041: public.is_admin() not found - migration 002 must be applied first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'services'
       and column_name = 'consultant_commission_bps'
  ) then
    raise exception
      'migration 041: services.consultant_commission_bps not found - migration 034 must be applied first';
  end if;

  /*
   * The precondition this whole migration rests on. If the column
   * were already readable by authenticated then migration 034
   * part E has been undone somewhere, and adding an admin-only
   * view would paper over a much larger hole rather than fix
   * anything.
   */
  if has_column_privilege(
       'authenticated', 'public.services',
       'consultant_commission_bps', 'SELECT') then
    raise exception
      'migration 041: authenticated can already SELECT services.consultant_commission_bps - migration 034 part E has been undone and must be restored first';
  end if;
end;
$$;


-- ============================================================
-- A. admin_services
-- ============================================================
--
-- The columns are listed explicitly rather than taken with *,
-- for the same reason migration 034 computed its grant list: a
-- column added to services later must be exposed by a deliberate
-- edit here, not by inheriting a wildcard. This projection fails
-- closed.
--
-- The list matches SERVICE_COLUMNS in the orchestrator's admin
-- service repository, plus consultant_commission_bps. Nothing in
-- it is new information for an administrator — the same fields
-- come back from POST and PATCH /api/admin/services already.
--
-- The Stripe identifiers are included because they are already
-- granted to authenticated on the base table by migration 034's
-- column list; this view neither widens nor narrows them.
--
-- `where public.is_admin()` is the entire access rule, and it is
-- a whole-view predicate rather than a per-row one: a non-admin
-- gets zero rows, never a filtered subset. is_admin() resolves
-- auth.uid() to the caller's own profile, so the fact that the
-- view body runs as its owner does not change WHO is being asked
-- about — the JWT claim it reads belongs to the caller either way.
--
-- Inactive services are included on purpose. An administrator
-- managing a catalog needs to see what they have deactivated;
-- services_select_active exists to hide those from clients, and
-- clients cannot reach this view at all.

create or replace view public.admin_services
with (security_barrier = true) as
select
  s.id,
  s.name,
  s.description,
  s.price_display,
  s.is_active,
  s.sort_order,
  s.created_at,
  s.updated_at,
  s.billing_type,
  s.recurring_interval,
  s.price_cents,
  s.currency,
  s.stripe_product_id,
  s.stripe_price_id,
  s.stripe_payment_link_id,
  s.stripe_payment_link_url,
  s.consultant_commission_bps
from public.services s
where public.is_admin();

comment on view public.admin_services is
  'Migration 041. The administrator projection of the service '
  'catalog, including consultant_commission_bps, which the base '
  'table deliberately withholds from every authenticated caller '
  '(migration 034 part E). Readable only by an administrator: the '
  'view is owner-executed and its entire body is gated on '
  'is_admin(), so a client or consultant reading it gets zero '
  'rows and anon holds no privilege on it at all. Includes '
  'inactive services, which an administrator managing a catalog '
  'needs and a client must never see. Read-only; the catalog is '
  'still written exclusively through the admin endpoints of '
  'Amendment 004.';


-- ============================================================
-- B. Privileges
-- ============================================================
--
-- Supabase's default privileges grant everything on a new object
-- in the public schema to anon, authenticated and service_role, so
-- what this view may do is stated rather than assumed. anon is
-- revoked by name as well as through PUBLIC.
--
-- authenticated is granted SELECT, and that grant is safe for the
-- reason the whole design turns on: the grant is the door,
-- is_admin() inside the view is the lock. A client key that
-- reaches the door reads nothing.
--
-- service_role is deliberately NOT granted. It bypasses RLS but
-- carries no JWT, so is_admin() is false for it and the view
-- would return nothing anyway; the orchestrator reads
-- public.services directly with the service role, which is
-- unaffected by any of this.

-- authenticated is revoked FIRST and then granted SELECT alone.
-- Not a formality: this view is a simple view over one table with
-- a WHERE clause, which makes it AUTO-UPDATABLE, and the default
-- privileges hand out INSERT, UPDATE and DELETE along with
-- everything else. Left as issued, an administrator — and the
-- view runs as its owner, so RLS would not stop them — could
-- write to public.services straight through it, bypassing the
-- admin catalog endpoints that Amendment 004 made the only way
-- the catalog is mutated. Revoking and re-granting narrowly is
-- what keeps this a read model.

revoke all on public.admin_services from public;
revoke all on public.admin_services from anon;
revoke all on public.admin_services from authenticated;
revoke all on public.admin_services from service_role;

grant select on public.admin_services to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_041_VERIFICATION.sql for the full self-contained suite.
--
--  1. select has_column_privilege(
--       'authenticated', 'public.services',
--       'consultant_commission_bps', 'SELECT');
--       -> false   (unchanged; the base table is untouched)
--
--  2. select has_table_privilege(
--       'authenticated', 'public.admin_services', 'SELECT');
--       -> true
--
--  3. select has_table_privilege(
--       'anon', 'public.admin_services', 'SELECT');
--       -> false
--
--  4. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 21  (unchanged; this migration adds no table)
