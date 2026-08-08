-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 042: Service post-purchase instructions
-- ============================================================
--
-- Classification:
-- - One private column and one view column. No policy change, no
--   grant change on public.services, no commission change, no
--   change to service_purchases or to anything that touches money.
--
-- The problem this solves:
-- - A client who buys a consultant-recommended service is
--   redirected to the dashboard and told nothing. There is nowhere
--   in this system for an admin to write "here is how you actually
--   use the thing you just paid for", so the delivery step happens
--   out of band or not at all.
--
-- What this migration does:
--   A. services.post_purchase_instructions_html, private.
--   B. public.admin_services gains the same column.
--
-- Why the column is PRIVATE, and why that needs no work:
-- - The content is delivery material: onboarding steps, download
--   URLs, booking URLs, contact routes. It is what somebody paid
--   for, so it must not be readable merely because the service
--   itself is listed publicly.
-- - Migration 034 part E replaced the table-level SELECT on
--   public.services with a COMPUTED COLUMN LIST, and its own
--   comment records the consequence: "adding a column later leaves
--   it ungranted, which fails closed. A future migration that adds
--   a client-visible column to services must grant it explicitly."
--   This is the first column to rely on that deliberately. Nothing
--   is revoked here because nothing was ever granted — but the
--   verification asserts it rather than trusting the reasoning.
-- - So public.services now has TWO private columns:
--     consultant_commission_bps        (migration 034)
--     post_purchase_instructions_html  (this migration)
--   Both are reachable by an administrator through
--   public.admin_services and by nobody else.
--
-- Where the sanitization lives, and why not here:
-- - The stored value is sanitized HTML, produced by the
--   orchestrator's single allowlist (src/lib/html-sanitizer.ts) on
--   the admin write path and applied AGAIN on the client read
--   path. A CHECK constraint cannot parse HTML, and a sanitizer
--   written in PL/pgSQL would be a second implementation to
--   disagree with the first. What the database contributes is the
--   length bound, which is the one property it can enforce
--   honestly.
--
-- Deliberately NOT done here:
-- - No grant of the new column on public.services to anon or
--   authenticated, and no change to the existing column list.
-- - No client-facing read model in the database. A client reads
--   these instructions through an orchestrator endpoint that
--   proves payment first; the service role reads past the column
--   privilege after that check, which is not something an RLS
--   policy could express.
-- - No default. Null means "no instructions written", which is a
--   different and more honest thing than an empty string.
--
-- Rerun safety:
-- - Idempotent. ADD COLUMN IF NOT EXISTS, the constraint is
--   dropped before it is added, and the view is CREATE OR REPLACE
--   with the new column APPENDED — PostgreSQL permits adding
--   columns to a view in place but not reordering or retyping
--   them, so the existing seventeen keep their order exactly.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----

do $$
begin
  if to_regclass('public.services') is null then
    raise exception
      'migration 042: public.services not found - migration 001 must be applied first';
  end if;

  if to_regclass('public.admin_services') is null then
    raise exception
      'migration 042: public.admin_services not found - migration 041 must be applied first';
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception
      'migration 042: public.is_admin() not found - migration 002 must be applied first';
  end if;

  /*
   * The property this migration relies on for its privacy. If
   * authenticated already held a table-level SELECT then migration
   * 034 part E has been undone, the new column would be world
   * readable the moment it is added, and adding it would be
   * actively unsafe.
   */
  if has_table_privilege('authenticated', 'public.services', 'SELECT')
     or has_table_privilege('anon', 'public.services', 'SELECT') then
    raise exception
      'migration 042: a table-level SELECT on public.services exists, which would make the new column readable by everyone - migration 034 part E must be restored first';
  end if;
end;
$$;


-- ============================================================
-- A. services.post_purchase_instructions_html
-- ============================================================

alter table public.services
  add column if not exists post_purchase_instructions_html text;

/*
 * The bound applies to the SANITIZED value, because sanitized is
 * the only thing the orchestrator ever writes. 20,000 characters
 * is far more than onboarding instructions need and far less than
 * a payload worth worrying about.
 *
 * Null is permitted and is the resting state: a service with no
 * instructions written, and equally a service whose instructions
 * sanitized away to nothing, both store null. The application
 * collapses those two cases deliberately so there is one empty
 * state rather than two that render differently.
 */
alter table public.services
  drop constraint if exists services_post_purchase_instructions_length_check;
alter table public.services
  add constraint services_post_purchase_instructions_length_check
  check (
    post_purchase_instructions_html is null
    or length(post_purchase_instructions_html) <= 20000
  );

comment on column public.services.post_purchase_instructions_html is
  'Migration 042. PRIVATE delivery content shown to a client after '
  'they have paid for this service: onboarding steps, download and '
  'booking URLs, contact routes. Sanitized HTML from a strict '
  'allowlist, written only by the admin service endpoints and '
  'sanitized again when read. Deliberately NOT granted to anon or '
  'authenticated on this table - migration 034 part E''s column '
  'list fails closed, and this is the first column to depend on '
  'that. An administrator reads it through public.admin_services; '
  'a client reads it only through an orchestrator endpoint that '
  'proves payment first. Null means no instructions have been '
  'written.';


-- ============================================================
-- B. admin_services
-- ============================================================
--
-- Unchanged in every respect except the appended column: still
-- owner-executed so it can read a column its callers cannot, still
-- security_barrier so a caller-supplied predicate cannot be pushed
-- below the gate, still `where public.is_admin()` so a client or
-- consultant reads zero rows, still SELECT-only for authenticated.
--
-- Part B restates the whole view rather than patching it because
-- CREATE OR REPLACE VIEW takes a complete definition. The
-- seventeen existing columns are byte-identical to migration 041
-- and in the same order, which is what makes the replace legal.

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
  s.consultant_commission_bps,
  s.post_purchase_instructions_html
from public.services s
where public.is_admin();

comment on view public.admin_services is
  'Migrations 041 and 042. The administrator projection of the '
  'service catalog, including the two columns the base table '
  'withholds from every authenticated caller: '
  'consultant_commission_bps (migration 034 part E) and '
  'post_purchase_instructions_html (migration 042). Readable only '
  'by an administrator: the view is owner-executed and its entire '
  'body is gated on is_admin(), so a client or consultant reading '
  'it gets zero rows and anon holds no privilege on it at all. '
  'Includes inactive services, which an administrator managing a '
  'catalog needs and a client must never see. Read-only; the '
  'catalog is still written exclusively through the admin '
  'endpoints of Amendment 004.';


-- ============================================================
-- C. Privileges
-- ============================================================
--
-- Re-asserted rather than assumed. CREATE OR REPLACE VIEW keeps
-- the existing ACL, so in principle nothing needed doing — but a
-- view that was ever dropped and recreated would pick up
-- Supabase's default GRANT ALL, and this view is a simple view
-- over one table and therefore AUTO-UPDATABLE. Left with those
-- defaults it would be a write path into public.services that
-- bypasses the admin endpoints entirely. Stating the intent costs
-- nothing and removes that possibility permanently.

revoke all on public.admin_services from public;
revoke all on public.admin_services from anon;
revoke all on public.admin_services from authenticated;
revoke all on public.admin_services from service_role;

grant select on public.admin_services to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_042_VERIFICATION.sql for the full self-contained suite.
--
--  1. select has_column_privilege(
--       'authenticated', 'public.services',
--       'post_purchase_instructions_html', 'SELECT');
--       -> false
--
--  2. select has_column_privilege(
--       'anon', 'public.services',
--       'post_purchase_instructions_html', 'SELECT');
--       -> false
--
--  3. select count(*) from information_schema.columns
--      where table_schema = 'public' and table_name = 'admin_services'
--        and column_name in (
--          'consultant_commission_bps',
--          'post_purchase_instructions_html');
--       -> 2
--
--  4. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 21  (unchanged; this migration adds no table)
