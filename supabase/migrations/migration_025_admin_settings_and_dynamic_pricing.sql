-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 025: Admin settings and dynamic consultation pricing
-- ============================================================
--
-- Governing document:
-- - PROJECT_LOCK Amendment 007
--   "Admin Settings and Dynamic Consultation Pricing".
--   This migration implements sections 2, 3, 4.1, 5.1, 5.8 and 8
--   of that amendment and nothing beyond them.
--
-- Purpose:
-- - Create public.app_settings, the sixteenth and final table, as
--   a singleton row of explicitly typed operational settings.
-- - Record the Stripe mode under which a consultation's
--   PaymentIntent was created, so a later capture, cancellation or
--   refund always reaches the same Stripe account even after the
--   global mode changes.
--
-- Deliberately NOT done here:
-- - No consultant_acceptance_timeout_hours column. The 48-hour
--   timeout is deferred by Amendment 007 section 7.
-- - migration_016 and public.finalize_authorization_timeout are
--   untouched.
-- - No secret, key or webhook-secret column of any kind. Stripe
--   credentials live only in Railway environment variables.
-- - No JSON settings blob and no key/value columns.
-- - No Realtime publication change.
-- - No RLS policy is created on app_settings. RLS is enabled with
--   zero policies, which denies anon and authenticated outright.
-- - No stripe_mode column on public.payments. Payment mode is
--   resolved from public.consultations.
-- - No existing consultation price is altered.
--
-- This migration changes no application behaviour. Until Phase 2
-- ships, the orchestrator still reads the price from the
-- environment and app_settings is inert.
--
-- Idempotent. Transaction-wrapped.
-- ============================================================

begin;

-- ------------------------------------------------------------- pre-flight ----
-- Fail before creating anything if a dependency is missing or if the
-- app_settings name is already taken by an unrelated object, so the
-- transaction rolls back and the live state is untouched.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception
      'migration 025: public.profiles not found - required by updated_by_admin_profile_id';
  end if;

  if to_regclass('public.consultations') is null then
    raise exception
      'migration 025: public.consultations not found - required by the stripe_mode column';
  end if;

  -- The shared updated_at trigger function, as discovered live. This
  -- migration attaches a trigger to it but never creates or replaces it.
  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'migration 025: public.set_updated_at() not found - required by the app_settings trigger';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'migration 025: role anon not found - required by the revoke block';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception
      'migration 025: role authenticated not found - required by the revoke block';
  end if;

  -- Re-running this migration must find its own table, not something else
  -- wearing the same name.
  if to_regclass('public.app_settings') is not null
     and not exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'app_settings'
          and c.relkind = 'r'
     )
  then
    raise exception
      'migration 025: public.app_settings exists but is not an ordinary table';
  end if;
end;
$$;

-- ------------------------------------------------------- app_settings ----
-- The sixteenth table. Amendment 007 section 2.
--
-- Singleton pattern: is_singleton is constrained to true and carries a
-- unique constraint, so a second row is rejected by the database. No
-- trigger, no fixed magic UUID, no count(*) race.

create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),

  is_singleton boolean not null default true,

  consultation_price_cents integer not null,
  consultation_currency text not null default 'usd',
  consultation_duration_minutes integer not null,

  stripe_mode text not null,

  support_email text,
  default_timezone text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_admin_profile_id uuid references public.profiles(id)
);

-- Constraints are added separately and idempotently so a re-run repairs a
-- partially applied state rather than failing.

alter table public.app_settings
  drop constraint if exists app_settings_singleton_check;
alter table public.app_settings
  add constraint app_settings_singleton_check
  check (is_singleton);

alter table public.app_settings
  drop constraint if exists app_settings_singleton_unique;
alter table public.app_settings
  add constraint app_settings_singleton_unique
  unique (is_singleton);

alter table public.app_settings
  drop constraint if exists app_settings_stripe_mode_check;
alter table public.app_settings
  add constraint app_settings_stripe_mode_check
  check (stripe_mode in ('test', 'live'));

-- USD only for this phase. Amendment 007 section 4.5.
alter table public.app_settings
  drop constraint if exists app_settings_currency_check;
alter table public.app_settings
  add constraint app_settings_currency_check
  check (consultation_currency = 'usd');

-- $1.00 through $10,000.00.
alter table public.app_settings
  drop constraint if exists app_settings_price_bounds_check;
alter table public.app_settings
  add constraint app_settings_price_bounds_check
  check (consultation_price_cents between 100 and 1000000);

alter table public.app_settings
  drop constraint if exists app_settings_duration_bounds_check;
alter table public.app_settings
  add constraint app_settings_duration_bounds_check
  check (consultation_duration_minutes between 15 and 240);

-- Deliberately a shape check, not an attempt at full RFC 5322. The
-- orchestrator performs authoritative validation before writing.
alter table public.app_settings
  drop constraint if exists app_settings_support_email_check;
alter table public.app_settings
  add constraint app_settings_support_email_check
  check (
    support_email is null
    or support_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  );

alter table public.app_settings
  drop constraint if exists app_settings_default_timezone_check;
alter table public.app_settings
  add constraint app_settings_default_timezone_check
  check (btrim(default_timezone) <> '');

comment on table public.app_settings is
  'Amendment 007. Singleton row of operational settings. Read and written '
  'only by the orchestrator service role. Contains no secret of any kind: '
  'Stripe credentials live only in Railway environment variables.';

-- ---------------------------------------------------------- updated_at ----
-- Follows the existing project convention. public.set_updated_at() is the
-- shared function already attached to profiles, consultants,
-- oauth_connections, consultations, consultation_notes, services and
-- service_requests. It is neither created nor replaced here.

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- seed ----
-- Exactly one row, carrying the values currently in force, so behaviour is
-- unchanged the moment this migration is applied.
--
--   consultation_price_cents      15000  <- env.ts DEFAULT_CONSULTATION_PRICE_CENTS
--   consultation_currency         'usd'  <- env.ts DEFAULT_CURRENCY
--   consultation_duration_minutes 60     <- draft-availability.ts SLOT_DURATION_MILLISECONDS
--   stripe_mode                   'test' <- current live Stripe mode, confirmed
--   default_timezone              'Africa/Cairo'
--   support_email                 null   <- no value supplied yet
--
-- No row UUID is hardcoded: the singleton constraint, not a known id, is
-- what guarantees uniqueness, and no project convention requires a fixed id.

insert into public.app_settings (
  consultation_price_cents,
  consultation_currency,
  consultation_duration_minutes,
  stripe_mode,
  support_email,
  default_timezone,
  updated_by_admin_profile_id
)
select
  15000,
  'usd',
  60,
  'test',
  null,
  'Africa/Cairo',
  null
where not exists (
  select 1 from public.app_settings
);

-- -------------------------------------------------------------------- RLS ----
-- Amendment 007 section 3.6.
--
-- RLS is enabled and no policy is created. Under PostgreSQL, a table with RLS
-- enabled and zero policies denies every row to every non-bypassing role, so
-- anon and authenticated have no access at all. The service role bypasses RLS,
-- which is how the orchestrator reads and writes.
--
-- The revokes are belt and braces: they ensure the intent survives even if a
-- policy is added by mistake later.

alter table public.app_settings enable row level security;

revoke all on public.app_settings from anon;
revoke all on public.app_settings from authenticated;

-- app_settings is deliberately NOT added to the supabase_realtime
-- publication. Amendment 007 section 3.5.

-- ------------------------------------------------ consultations.stripe_mode ----
-- Amendment 007 sections 5.7 and 5.8.
--
-- Nullable, because a consultation with no PaymentIntent has no mode, and
-- because existing rows must remain valid. Written by the orchestrator at
-- PaymentIntent creation from Phase 2 onward.
--
-- ADD COLUMN with no default is metadata-only in PostgreSQL 11+, so this does
-- not rewrite the table.

alter table public.consultations
  add column if not exists stripe_mode text;

alter table public.consultations
  drop constraint if exists consultations_stripe_mode_check;
alter table public.consultations
  add constraint consultations_stripe_mode_check
  check (stripe_mode is null or stripe_mode in ('test', 'live'));

comment on column public.consultations.stripe_mode is
  'Amendment 007. Stripe mode under which this consultation''s PaymentIntent '
  'was created. Authoritative selector for every later capture, cancellation '
  'or refund, so a global mode change never redirects an existing payment to '
  'the wrong Stripe account. Null when no PaymentIntent exists.';

-- ------------------------------------------------------------- backfill ----
-- Every existing PaymentIntent was created in test mode, which is the mode
-- currently in force. Rows without a PaymentIntent are left null: they have no
-- Stripe object and therefore no mode.
--
-- Idempotent: the stripe_mode is null predicate means a re-run touches
-- nothing, and no already-set value is ever overwritten.

update public.consultations
   set stripe_mode = 'test'
 where stripe_payment_intent_id is not null
   and stripe_mode is null;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying.
--
--  1. select count(*) from public.app_settings;
--       -> exactly 1
--
--  2. insert into public.app_settings (
--       consultation_price_cents, consultation_duration_minutes,
--       stripe_mode, default_timezone
--     ) values (15000, 60, 'test', 'Africa/Cairo');
--       -> fails on app_settings_singleton_unique. Roll back.
--
--  3. select consultation_price_cents, consultation_currency,
--            consultation_duration_minutes, stripe_mode,
--            support_email, default_timezone
--       from public.app_settings;
--       -> 15000, usd, 60, test, null, Africa/Cairo
--
--  4. select relrowsecurity, relforcerowsecurity
--       from pg_class where oid = 'public.app_settings'::regclass;
--       -> relrowsecurity = true
--
--  5. select count(*) from pg_policies
--      where schemaname = 'public' and tablename = 'app_settings';
--       -> 0
--
--  6. select has_table_privilege('anon', 'public.app_settings', 'SELECT'),
--            has_table_privilege('authenticated', 'public.app_settings', 'SELECT');
--       -> false, false
--
--  7. select count(*) from pg_publication_tables
--      where pubname = 'supabase_realtime'
--        and schemaname = 'public' and tablename = 'app_settings';
--       -> 0
--
--  8. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
--
--  9. select count(*) filter (where stripe_mode = 'test')  as backfilled,
--            count(*) filter (where stripe_mode is null)   as untouched
--       from public.consultations
--      where stripe_payment_intent_id is not null;
--       -> untouched = 0
--
-- 10. select count(*) from public.consultations
--      where stripe_payment_intent_id is null and stripe_mode is not null;
--       -> 0
--
-- 11. select tgname from pg_trigger
--      where tgrelid = 'public.app_settings'::regclass and not tgisinternal;
--       -> set_app_settings_updated_at
--
-- 12. select column_name from information_schema.columns
--      where table_schema = 'public' and table_name = 'app_settings'
--        and column_name = 'consultant_acceptance_timeout_hours';
--       -> 0 rows (deferred by Amendment 007 section 7)
