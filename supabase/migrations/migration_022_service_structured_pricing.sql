-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 022: Service structured pricing
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 004
--   "Structured Service Pricing and Stripe Payment Links"
--   (APPROVED). This migration implements sections 4, 5, 19.1
--   of that amendment and nothing beyond them.
--
-- Purpose:
-- - Add structured service pricing to public.services:
--   billing_type, recurring_interval, price_cents, currency.
-- - Add the Stripe Product, Price and Payment Link identifiers
--   that the orchestrator will own:
--     stripe_product_id
--     stripe_price_id
--     stripe_payment_link_id
--     stripe_payment_link_url
-- - Remove direct authenticated writes to public.services, so
--   that every service mutation passes through the orchestrator
--   under the service role (Amendment 004 section 3).
--
-- Preservation:
-- - Existing rows are preserved exactly. This migration writes
--   no data and updates no row. All eight new columns are
--   nullable and are NULL for every existing row.
-- - Legacy price_display values are preserved. price_display is
--   not dropped, not altered, and not backfilled. Amendment 004
--   section 6.5 keeps legacy free text in place until an admin
--   supplies structured pricing for that service.
-- - is_active and sort_order are preserved. No service is
--   deactivated or reordered.
-- - The SELECT policy services_select_active is preserved
--   unchanged, as are authenticated SELECT access, service_role
--   access and postgres access.
-- - Both foreign keys referencing public.services are untouched:
--     service_recommendations_service_id_fkey
--     service_requests_service_id_fkey
--   No cascade behaviour is introduced. No historical record is
--   deleted or detached.
--
-- Deliberately not done:
-- - No table is created. No enum type is created; billing_type
--   and recurring_interval are constrained text, matching the
--   consultants.gender precedent from migration 018.
-- - No structured pricing is inferred or backfilled. The '$'
--   glyph in the existing price_display values is not evidence
--   of currency, and no display string is evidence of billing
--   type. Amendment 004 section 5.7 permits only two states:
--   fully priced or entirely unpriced. Existing rows stay
--   entirely unpriced until an administrator prices them.
-- - No other table is modified.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Structured pricing and Stripe identifier columns
-- ------------------------------------------------------------
--
-- All columns are nullable with no default. Existing rows carry
-- no structured pricing and no Stripe resources, and nullability
-- is the correct representation of that state. Adding nullable
-- columns without a default does not rewrite the table.

alter table public.services
  add column if not exists billing_type text,
  add column if not exists recurring_interval text,
  add column if not exists price_cents integer,
  add column if not exists currency text,
  add column if not exists stripe_product_id text,
  add column if not exists stripe_price_id text,
  add column if not exists stripe_payment_link_id text,
  add column if not exists stripe_payment_link_url text;

-- ------------------------------------------------------------
-- 2. Value constraints
-- ------------------------------------------------------------
--
-- Each constraint is dropped before being added so the migration
-- can be re-run safely.

alter table public.services
  drop constraint if exists services_billing_type_check;

alter table public.services
  add constraint services_billing_type_check
  check (
    billing_type is null
    or billing_type in ('one_time', 'recurring')
  );

alter table public.services
  drop constraint if exists services_recurring_interval_check;

alter table public.services
  add constraint services_recurring_interval_check
  check (
    recurring_interval is null
    or recurring_interval in ('month', 'year')
  );

/*
 * price_cents is expressed in the minor unit of the service
 * currency and must be strictly positive when present. A zero
 * or negative amount is never a valid service price.
 */
alter table public.services
  drop constraint if exists services_price_cents_check;

alter table public.services
  add constraint services_price_cents_check
  check (
    price_cents is null
    or price_cents > 0
  );

/*
 * Amendment 004 section 5.6 limits the initial currency set to
 * usd, gbp and eur. The set is enumerated here rather than
 * pattern-matched, so an unsupported currency is rejected by the
 * database and not only by the orchestrator. Uppercase input is
 * rejected because the enumerated values are lowercase.
 */
alter table public.services
  drop constraint if exists services_currency_check;

alter table public.services
  add constraint services_currency_check
  check (
    currency is null
    or currency in ('usd', 'gbp', 'eur')
  );

-- ------------------------------------------------------------
-- 3. Billing shape constraint
-- ------------------------------------------------------------
--
-- A service is in exactly one of three states:
--
--   unpriced   billing_type, recurring_interval, price_cents
--              and currency are all NULL
--
--   one-time   billing_type = 'one_time'
--              recurring_interval IS NULL
--              price_cents and currency present
--
--   recurring  billing_type = 'recurring'
--              recurring_interval IN ('month', 'year')
--              price_cents and currency present
--
-- Every branch opens with an IS NULL or IS NOT NULL predicate.
-- That is deliberate and load-bearing, not stylistic.
--
-- A CHECK constraint admits a row when its expression evaluates
-- to NULL rather than false. Written without the guards, the
-- comparison billing_type = 'one_time' yields NULL for an
-- unpriced row, the second branch as a whole yields NULL, and a
-- row carrying price_cents and currency but no billing_type
-- would be admitted. Likewise recurring_interval IN
-- ('month','year') yields NULL for a recurring row with no
-- interval, admitting it.
--
-- The IS NOT NULL guards force every branch to evaluate to a
-- concrete boolean, because "false AND NULL" is false in SQL's
-- three-valued logic. The constraint therefore never evaluates
-- to NULL for any input, and partial pricing is rejected.

alter table public.services
  drop constraint if exists services_billing_shape_check;

alter table public.services
  add constraint services_billing_shape_check
  check (
    (
      billing_type is null
      and recurring_interval is null
      and price_cents is null
      and currency is null
    )
    or (
      billing_type is not null
      and billing_type = 'one_time'
      and recurring_interval is null
      and price_cents is not null
      and currency is not null
    )
    or (
      billing_type is not null
      and billing_type = 'recurring'
      and recurring_interval is not null
      and recurring_interval in ('month', 'year')
      and price_cents is not null
      and currency is not null
    )
  );

-- ------------------------------------------------------------
-- 4. Stripe identifier uniqueness
-- ------------------------------------------------------------
--
-- Each column holds the current Stripe resource for exactly one
-- service. Two services sharing a Stripe Product, Price or
-- Payment Link is always a defect.
--
-- The indexes are partial so that unpriced services, which hold
-- NULL in all three columns, do not collide with one another.
-- Price rotation is unaffected: a superseded identifier leaves
-- the column when its replacement is written, and the superseded
-- Stripe resource itself is preserved in Stripe.
--
-- These indexes exist to enforce integrity. They are not
-- performance indexes; public.services is a small catalog table.

create unique index if not exists
  services_stripe_product_id_key
  on public.services (stripe_product_id)
  where stripe_product_id is not null;

create unique index if not exists
  services_stripe_price_id_key
  on public.services (stripe_price_id)
  where stripe_price_id is not null;

create unique index if not exists
  services_stripe_payment_link_id_key
  on public.services (stripe_payment_link_id)
  where stripe_payment_link_id is not null;

-- ------------------------------------------------------------
-- 5. Removal of direct authenticated service writes
-- ------------------------------------------------------------
--
-- Amendment 004 section 3 supersedes the previous rule that
-- allowed the admin role to INSERT, UPDATE and DELETE
-- public.services directly. From this migration onward every
-- mutation of public.services is performed by the orchestrator
-- under the service role.
--
-- Table privileges are removed first. REVOKE of a privilege that
-- is not held is a no-op, so this section is re-runnable.
--
-- SELECT is deliberately not revoked. Authenticated read access
-- and the policy that backs it are retained unchanged.

revoke insert
on table public.services
from authenticated;

revoke update
on table public.services
from authenticated;

revoke delete
on table public.services
from authenticated;

/*
 * The write policies are then dropped, so that no authenticated
 * write path remains through either privilege or policy.
 *
 * services_select_active is intentionally absent from this list.
 * It is not dropped, replaced or altered by this migration.
 *
 * RLS remains enabled and remains not forced. Neither setting is
 * changed here. service_role and postgres continue to bypass RLS
 * exactly as before.
 */
drop policy if exists services_insert_admin
  on public.services;

drop policy if exists services_update_admin
  on public.services;

drop policy if exists services_delete_admin
  on public.services;

commit;
