# MakeHijrah Relocation OS — DATABASE_SCHEMA.md

**Version:** 1.0 (draft for Dave's review)
**Scope:** Exactly the 16 locked tables (15 original + `app_settings`, authorised by PROJECT_LOCK Amendment 007). All additions from Dave's response (2026-07) incorporated.
**Conventions:** All timestamps `timestamptz` in UTC. All PKs `uuid default gen_random_uuid()` unless noted. IANA timezones only.

---

## 0. Enums (created first)

```sql
create type user_role as enum ('client', 'consultant', 'admin');

create type invite_status as enum ('unused', 'used', 'expired', 'revoked');

create type consultation_status as enum (
  'draft',
  'payment_authorized',
  'pending_acceptance',
  'confirmed',
  'declined',
  'admin_attention',
  'completed',
  'cancelled',
  'authorization_cancelled',
  'captured',
  'refunded'
);

create type service_request_status as enum ('pending', 'active', 'completed', 'cancelled');

create type recommendation_status as enum ('proposed', 'sent');
```

Note on `recommendation_status`: `proposed` = consultant selected it, awaiting admin review. `sent` = admin clicked Send to Client. Two states only; no scope beyond the locked flow.

---

## 1. `profiles`

Mirrors `auth.users`. Created via trigger on signup.

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'client',
  full_name text,
  email text not null,
  phone_whatsapp text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- First admin seeded manually (`update profiles set role='admin' where id=...`). No public admin registration.
- `avatar_url` points to Supabase Storage bucket `public-media`, prefix `avatars/{auth.uid()}/*`. (Single bucket — no separate `avatars` or `consultant-photos` buckets.)

---

## 2. `consultants`

One row per consultant. 1:1 with a `profiles` row of role `consultant`.

```sql
create table consultants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id) on delete cascade,
  headline text,
  bio text,
  photo_url text,                                           -- public projection of profiles.avatar_url (Amendment 008, migration 028)
  display_name text,                                        -- public projection of profiles.full_name (Amendment 008, migration 030)
  timezone text not null,                                   -- IANA, e.g. 'Africa/Cairo'
  working_hours_jsonb jsonb not null default '{}'::jsonb,
  minimum_booking_notice_hours integer not null default 24,
  available_for_general boolean not null default false,     -- "general information" path
  is_active boolean not null default false,                 -- admin activates after onboarding complete
  consultant_slug text,                                     -- root booking URL (Amendment 011, migration 045)
  direct_booking_enabled boolean not null default false,    -- Amendment 011, migration 045
  direct_booking_price_cents integer,                       -- CONFIGURED price; see the effective price rule
  direct_booking_only boolean not null default false,       -- Amendment 014, migration 050
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consultants_slug_format_check
    check (consultant_slug is null
           or consultant_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint consultants_slug_length_check
    check (consultant_slug is null
           or length(consultant_slug) between 3 and 60),
  constraint consultants_direct_price_range_check
    check (direct_booking_price_cents is null
           or direct_booking_price_cents between 100 and 1000000),
  constraint consultants_direct_booking_ready_check
    check (direct_booking_enabled = false
           or (consultant_slug is not null
               and direct_booking_price_cents is not null))
);

create unique index uq_consultants_slug
  on consultants (consultant_slug)
  where consultant_slug is not null;
```

`working_hours_jsonb` shape (per Dave):

```json
{
  "monday":    [{"start": "09:00", "end": "17:00"}],
  "friday":    [{"start": "14:00", "end": "17:00"}],
  "saturday":  [],
  "sunday":    []
}
```

Times are local to `timezone`. Slot generator (orchestrator) converts to UTC.

**Weekday key format (Amendment 008 §8a, migration 029).** Storage uses **numeric** weekday keys `"0"`–`"6"`, where `0` is sunday. The shape above shows the *HTTP wire* format, which is **named** — that is what the frontend sends and receives. The stored form of the same week is:

```json
{
  "0": [],
  "1": [{"start": "09:00", "end": "17:00"}],
  "5": [{"start": "14:00", "end": "17:00"}]
}
```

Named-to-numeric conversion happens inside `save_consultant_profile`; numeric-to-named happens in the orchestrator response mapper. The database must never store named keys. Migrations 027 and 028 stored the argument verbatim and did; migration 029 repairs those rows and moves the conversion into the RPC. Internal readers accept either format while un-migrated rows can still exist.

**`photo_url` (Amendment 008, migration 028).** The **denormalised public projection** of `profiles.avatar_url`, which remains authoritative. It exists because public, client and anon surfaces may read `consultants` but not `profiles`; publishing the authoritative field directly would require widening `profiles` SELECT and exposing `email`, `phone_whatsapp` and every other private column. Both fields are written together, from one argument, in one transaction, by the service-role RPC `save_consultant_profile` — a non-null `p_avatar_url` sets both, a null preserves both — so they cannot diverge through the supported write path. Nothing else writes `photo_url`. Migration 028 also reconciles existing rows once: a legacy `photo_url` is adopted into a **null** `avatar_url` only, and a legacy `photo_url` is never cleared.

**`display_name` (Amendment 008, migration 030 — authored, not applied).** The **denormalised public projection** of `profiles.full_name`, which remains authoritative. It exists for the same reason as `photo_url` and follows the identical rule: the public booking flow renders `{consultant name} - {headline}`, `headline` already lives on `consultants`, and the name did not — so rendering it would have required widening `profiles` SELECT and exposing `email`, `phone_whatsapp` and every other private column to reach one public field. Both fields are written together, from one argument, in one transaction, by the service-role RPC `save_consultant_profile` — a non-null `p_full_name` sets both, a null preserves both — so they cannot diverge through the supported write path. Nothing else writes `display_name`. Public, client and admin cross-user consultant surfaces may read it **without reading `profiles`**, through the pre-existing `consultants_select_active_public` policy; migration 030 adds, drops and rewrites no policy. The column is nullable with no default: a consultant whose authoritative `full_name` is null projects null, never `''`. Migration 030 backfills it once from `profiles.full_name`, skipping rows whose authoritative name is null.

Only these two public-safe fields are projected. No other `profiles` column — `email`, `phone_whatsapp`, role or profile metadata — is copied onto `consultants`.

**Direct booking (Amendment 011, migration 045).** Three columns let a consultant publish a personal booking page at a **root URL** and set their own price.

- **`consultant_slug`** is the URL. The database owns **format** (lowercase, URL-safe, 3–60 characters, no leading, trailing or doubled hyphen) and **uniqueness** (`uq_consultants_slug`, partial so many consultants may hold `null`). The database deliberately does **not** own the **reserved** set — `admin`, `dashboard`, `api`, `favicon.ico` and the rest of the frontend's routing table. That list is a fact about routing, not about the schema; it changes when a page is added, and encoding it here would guarantee the two drift apart. It lives in the orchestrator (`direct-booking.slug.ts`), and **there is no `reserved_slugs` table**. The stored value is always the normalized one, so the column is always exactly what appears in the URL.
- **`direct_booking_enabled`** defaults to `false`: a consultant opts in. `consultants_direct_booking_ready_check` makes publishing without a URL to publish at, or a price to charge, impossible rather than merely refused.
- **`direct_booking_price_cents`** is the **configured** price and is **not necessarily the price charged**. The charged price is `max(direct_booking_price_cents, app_settings.consultation_price_cents)` — see Amendment 011 §4. The "at least the platform price" rule is enforced by the orchestrator **at save time** and deliberately is *not* a constraint: the platform default may later rise above a stored price, and a constraint would then invalidate an untouched row and block every unrelated update to it.

**All three columns are closed to direct browser writes (Amendment 012, migration 049).** `guard_consultants_columns` now refuses a non-privileged change to `consultant_slug`, `direct_booking_enabled` or `direct_booking_price_cents`, joining `is_active`, `profile_id`, `onboarding_completed_at` and post-onboarding `gender` on the same trigger. This closed a real bypass: `consultants_update_own_or_admin` has existed since migration 002, so a consultant holding their own JWT could set any of the three through PostgREST — taking a reserved slug, publishing a page an admin had not activated, or pricing a booking below the platform's own consultation, since the price floor is enforced only by the orchestrator by design. SELECT is untouched: a consultant must be able to read and copy their own booking link.

**`direct_booking_only` (Amendment 014, migration 050).** Consultant-managed. When true the consultant is excluded from the ordinary `/consultation` chooser — both country-specific and general-information selection — and remains bookable only through their own direct link. Deliberately **not** a reuse of `is_active` (admin: do they work here), `available_for_general` (which standard flow) or `direct_booking_enabled` (admin: is the direct page live) — none of those means this one. Defaulted `false`, so no existing consultant's eligibility changes.

The exclusion is enforced by the **RLS policy**, because the `/consultation` chooser reads `consultants` directly rather than through an orchestrator endpoint: `consultants_select_active_public` now reads `is_active = true and direct_booking_only = false`. A companion policy, `consultants_select_booked_direct_only`, restores visibility to a client who already holds a consultation with that consultant — scoped to `direct_booking_only = true` so it gives back exactly what the narrowing removed. The orchestrator separately refuses a *standard* draft naming such a consultant; direct bookings are unaffected.

**Ownership, settled by Amendment 013 and extended by 014:** an **administrator** writes `consultant_slug` and `direct_booking_enabled`; the **consultant** writes `direct_booking_price_cents` and `direct_booking_only`; the effective price is server-derived and written by nobody. Both roles read all four. What is published under the platform's own domain is the platform's decision; what somebody charges for their own time is theirs. Migration 049 is what makes that enforceable — without it a consultant could set any of the three from a browser regardless of what the API accepts.

**The slug is admin-managed (Amendment 012).** It is generated at activation from `display_name` (falling back to `profiles.full_name`) when `consultant_slug IS NULL`, never regenerated on a rename, and changed thereafter only by an administrator. The database still owns format, length and uniqueness; the reserved set stays in the orchestrator.

`consultants_select_active_public` is a **row** policy, so `anon` can read these three columns directly. That is why the public booking page is a **server-built projection** rather than a table read: it publishes `effective_direct_booking_price_cents` and never the stored figure, so a frontend cannot display a stale price while checkout charges a higher one. No policy was added, dropped or widened by migration 045.

---

## 3. `consultant_invites`

```sql
create table consultant_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null,                 -- Argon2id hash ONLY. Never plaintext. Never logged.
  status invite_status not null default 'unused',
  expires_at timestamptz not null,
  created_by uuid not null references profiles(id),
  used_at timestamptz,
  used_by_profile_id uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index idx_consultant_invites_status on consultant_invites (status, expires_at);
```

- Raw token generated in the orchestrator, shown once to admin, hashed, discarded.
- Redemption: orchestrator receives raw token → Argon2id verify against `unused` non-expired rows.

---

## 4. `countries`

```sql
create table countries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  iso_code text not null unique,            -- ISO 3166-1 alpha-2, e.g. 'EG'
  tagline text,                             -- migration 033; nullable, no default
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
```

Booking form only offers countries that have ≥1 active consultant (derived at query time via join — no flag duplication).

**`tagline` (migration 033 — authored, not applied).** A short public line rendered under the country name. Nullable with no default: a country without one reads null, never `''`. It is **normalised on write** by `trg_countries_normalize_tagline`, a `before insert or update of tagline` row trigger that trims the value and stores a blank or whitespace-only tagline as null. The rule lives in the database because `countries` has no orchestrator route: it is written directly against Supabase by the admin frontend under `countries_insert_admin` / `countries_update_admin`, and read directly by anon and authenticated clients under `countries_select_active_public`. The orchestrator reads the table only to check that a submitted country id is active and to prove Supabase is reachable, and reads no column beyond `id`. Migration 033 adds, drops and rewrites no policy, and every country predating it keeps a null tagline — there is no backfill.

---

## 5. `consultant_countries`

```sql
create table consultant_countries (
  consultant_id uuid not null references consultants(id) on delete cascade,
  country_id uuid not null references countries(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (consultant_id, country_id)
);
```

---

## 6. `oauth_connections`

```sql
create table oauth_connections (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null unique references consultants(id) on delete cascade,
  provider text not null default 'google',
  encrypted_refresh_token text not null,    -- AES-256-GCM, key in orchestrator env only
  google_email text,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);
```

- No access tokens stored. Orchestrator mints access tokens on demand from the refresh token.
- Zero client access (see RLS plan). Lovable never touches this table.
- Encryption key: `OAUTH_TOKEN_ENCRYPTION_KEY` env var on Railway. Never in Supabase.

---

## 7. `consultations`

The core table. Also serves as the booking hold record (Dave's race-condition decision).

```sql
create table consultations (
  id uuid primary key default gen_random_uuid(),
  client_profile_id uuid not null references profiles(id),
  consultant_id uuid not null references consultants(id),
  country_id uuid references countries(id),   -- NULL = general information consultation
  status consultation_status not null default 'draft',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  client_timezone text,                       -- IANA
  price_cents integer not null,
  currency text not null default 'usd',
  booking_source text not null default 'standard',  -- Amendment 011, migration 045
  stripe_payment_intent_id text unique,
  stripe_mode text,                           -- Amendment 007, migration 025; null when no PaymentIntent
  payment_authorized_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  captured_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  google_event_id text,
  meet_link text,
  admin_attention_reason text,                -- 'declined' | 'timeout' | manual note
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consultation_end_after_start check (scheduled_end_at > scheduled_start_at),
  constraint consultation_currency_lowercase check (currency = lower(currency)),
  constraint consultations_stripe_mode_check
    check (stripe_mode is null or stripe_mode in ('test', 'live')),
  constraint consultations_booking_source_check
    check (booking_source in ('standard', 'direct_booking'))
);
```

**`booking_source` (Amendment 011, migration 045).** Where the booking came from, and therefore where its price came from and which commission rule applies to its money. `'standard'` is the generic flow; `'direct_booking'` is a consultant's own page. Existing rows were backfilled to `'standard'`, and the default means an ordinary booking never has to say so.

This column is the **only** thing that distinguishes a direct booking. There is no `direct_consultations` table and no parallel payment record: same statuses, same draft hold, same double-booking exclusion, same checkout, capture, completion, refund and timeout. See Amendment 011 §2.

**`stripe_mode` (Amendment 007, migration 025).** Records the Stripe mode under which this consultation's PaymentIntent was created. It is the authoritative selector for every later capture, cancellation or refund, so a change to the global `app_settings.stripe_mode` never redirects an existing payment to the wrong Stripe account. Null when no PaymentIntent exists. Existing rows carrying a PaymentIntent were backfilled to `'test'`.

**The draft hold (migrations 046 and 047).** A `draft` row **is** the slot hold — it appears in the index below, so while it exists nobody else can book that time. The hold is **30 minutes** from `created_at`, defined once in SQL: `create_draft_consultation` returns it as `hold_expires_at`, and `expire_stale_draft_consultations` cancels drafts past the same cutoff. The two live beside each other deliberately — a worker that disagreed with `hold_expires_at` would either cancel live bookings or leave dead ones standing.

**A held draft's intake stays editable (migration 048).** While a consultation is a `draft`, `refresh_draft_consultation_intake` rewrites the visitor-editable half — `consultation_intake.full_name`, `email`, `phone_whatsapp`, `answers_jsonb`, and `consultations.client_timezone`, `country_id`, `client_profile_id` — so a visitor who corrects their details and then re-picks the same slot does not silently lose those edits. `client_profile_id` is in that list because it is **derived** from the intake email (Amendment 002); refreshing one without the other would send notifications to the corrected address while dashboard access stayed under the old one. The consultant, the schedule, the status, the price, the currency, the booking source and every payment column are not parameters of that function and cannot be reached from it, and it matches `id AND status = 'draft'`, so nothing past draft is editable by a booking form.

Three things release a held slot, and **an abandoned draft never reserves one permanently**: it is superseded when the visitor picks another time (only after the replacement succeeds), compensated when the booking could not be prepared for payment (`abandon_draft_consultation`, migration 046), or expired by the `expire-drafts` worker within 30–31 minutes (migration 047). All three set `status = 'cancelled'`, which is **outside** the index's status list, so the slot frees the moment the transaction commits. Nothing deletes the row: the record of a booking somebody started and did not finish is worth keeping.

`idx_consultations_stale_drafts on consultations (status, created_at) where status = 'draft'` was created for the expiry sweep in migration 001 and went unused until migration 047.

**The race-condition index (day one, non-negotiable):**

```sql
create unique index unique_reserved_consultant_slot
on consultations (consultant_id, scheduled_start_at)
where status in (
  'draft',
  'payment_authorized',
  'pending_acceptance',
  'confirmed',
  'captured'
);
```

**Supporting indexes:**

```sql
create index idx_consultations_client on consultations (client_profile_id, created_at desc);
create index idx_consultations_consultant on consultations (consultant_id, scheduled_start_at);
create index idx_consultations_timeout on consultations (status, payment_authorized_at)
  where status = 'pending_acceptance';
create index idx_consultations_stale_drafts on consultations (status, created_at)
  where status = 'draft';
```

**Cleanup job contract (orchestrator, BullMQ, every 15 min):**
- `draft` older than 30 minutes → `cancelled`.
- `pending_acceptance` with `payment_authorized_at < now() - interval '48 hours'` → cancel Stripe auth → `admin_attention` (`admin_attention_reason = 'timeout'`).

---

## 8. `consultation_intake`

```sql
create table consultation_intake (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null unique references consultations(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone_whatsapp text not null,
  answers_jsonb jsonb not null default '{}'::jsonb,   -- multi-step form answers
  created_at timestamptz not null default now()
);
```

`answers_jsonb` captures the Fillout-style form ("Where are you planning to make Hijrah?", etc.) without schema churn per question.

---

## 9. `consultation_notes`

```sql
create table consultation_notes (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references consultations(id) on delete cascade,
  consultant_id uuid not null references consultants(id),
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_notes_consultation on consultation_notes (consultation_id);
```

Client has zero access to notes (see RLS plan).

---

## 10. `services`

Definition below is **post-migration 022** (PROJECT_LOCK Amendment 004, applied and verified). This supersedes the original v1.0 definition, in which `price_display` was the only pricing field. No new table was created; all eight columns are additive and nullable.

```sql
create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price_display text,          -- legacy/display string, e.g. '$1,000 / 3–5 nights'
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Structured pricing (migration 022). All nullable.
  billing_type text,           -- 'one_time' | 'recurring'
  recurring_interval text,     -- 'month' | 'year'
  price_cents integer,         -- minor units, strictly positive
  currency text,               -- 'usd' | 'gbp' | 'eur'

  -- Stripe resources, orchestrator-owned (migration 022). All nullable.
  stripe_product_id text,
  stripe_price_id text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,

  -- Consultant commission (migration 034). Nullable, no default.
  consultant_commission_bps integer   -- basis points of gross, 0..10000
);

-- Value constraints
alter table services add constraint services_billing_type_check
  check (billing_type is null or billing_type in ('one_time', 'recurring'));

alter table services add constraint services_recurring_interval_check
  check (recurring_interval is null or recurring_interval in ('month', 'year'));

alter table services add constraint services_price_cents_check
  check (price_cents is null or price_cents > 0);

alter table services add constraint services_currency_check
  check (currency is null or currency in ('usd', 'gbp', 'eur'));

-- Billing shape: fully unpriced, or fully priced. Never partial.
alter table services add constraint services_billing_shape_check
  check (
    (billing_type is null and recurring_interval is null
     and price_cents is null and currency is null)
    or (billing_type is not null and billing_type = 'one_time'
        and recurring_interval is null
        and price_cents is not null and currency is not null)
    or (billing_type is not null and billing_type = 'recurring'
        and recurring_interval is not null
        and recurring_interval in ('month', 'year')
        and price_cents is not null and currency is not null)
  );

-- Partial unique indexes: no two services may share a Stripe resource,
-- while any number of services may hold NULL.
create unique index services_stripe_product_id_key
  on services (stripe_product_id) where stripe_product_id is not null;

create unique index services_stripe_price_id_key
  on services (stripe_price_id) where stripe_price_id is not null;

create unique index services_stripe_payment_link_id_key
  on services (stripe_payment_link_id) where stripe_payment_link_id is not null;
```

**Pricing rules:**

- `billing_type` is exactly `one_time` or `recurring`.
- `recurring_interval` is exactly `month` or `year`, and only on a `recurring` service. A `one_time` service must have `recurring_interval IS NULL`.
- `price_cents` is an integer strictly greater than zero, in the minor unit of `currency`.
- `currency` is exactly `usd`, `gbp` or `eur`. Lowercase; uppercase is rejected.
- A service is **fully unpriced** (all four NULL) or **fully priced**. Partial pricing is rejected by `services_billing_shape_check`.

**`price_display`:** retained for backward compatibility and for server-generated display text. It is never accepted from a client and is not a database-generated column. Where structured pricing exists, the orchestrator generates `price_display` from it; where it does not, the legacy free-text value stands.

**Legacy rows:** services that predate migration 022 remain fully unpriced, with all eight new columns NULL, until an administrator prices them. Nothing was backfilled or inferred from the existing `price_display` strings.

**Writes:** `authenticated` has `SELECT` only on this table. Every insert, update and delete is performed by the orchestrator under the service role. See `RLS_POLICY_PLAN.md` §2 and `API_CONTRACT.md` §3.

~~Service purchases made through a Stripe Payment Link are **not** recorded in this database in the current scope.~~ **Superseded by Amendment 009 (migration 040):** service purchases are now recorded in `service_purchases` and earn consultant commission. `payments` is still not written for them, and `service_requests` remains admin-created. See §20.

### `post_purchase_instructions_html` (migration 042)

**Private delivery content.** What a client is shown *after* paying for a service: onboarding steps, download URLs, booking URLs, contact routes. Nullable `text`, bounded at 20,000 characters by `services_post_purchase_instructions_length_check`, and the bound applies to the **sanitized** value because sanitized is the only thing the orchestrator ever writes.

```sql
alter table services add column post_purchase_instructions_html text;
-- check: null or length(...) <= 20000
```

**It is private for free, and that is deliberate.** Migration 034 part E replaced the table-level `SELECT` on `services` with a computed column list and recorded the consequence in its own comment: *"adding a column later leaves it ungranted, which fails closed."* This is the first column to depend on that. Nothing is revoked in migration 042 because nothing was ever granted — `public.services` now has **two** private columns, `consultant_commission_bps` and this one, both reachable by an administrator through `admin_services` and by nobody else.

**Sanitized on write and again on read**, against one allowlist (`src/lib/html-sanitizer.ts`): tags `p br strong em b i u ul ol li h2 h3 a`, attributes `href`/`title` on `a` only, schemes `http https mailto`, and every link rewritten with `rel="noopener noreferrer nofollow" target="_blank"` over whatever the author supplied. Re-sanitizing on read is not redundant — it is the only thing covering a row edited directly in the Supabase SQL editor. Content that sanitizes away to nothing is stored as `null`.

**A client reads it only after paying.** There is no RLS path and no database read model for clients: the orchestrator endpoint (`API_CONTRACT.md` §3d) proves ownership *and* payment, then reads past the column privilege with the service role. A sent recommendation is explicitly **not** proof of payment — see Amendment 010.

### `admin_services` (view, migration 041, extended by 042)

The administrator projection of the catalog — every column of `services` that the admin endpoints return, **plus both private columns**: `consultant_commission_bps` (migration 034) and `post_purchase_instructions_html` (migration 042).

It exists because of a shape problem, not a policy one. `consultant_commission_bps` is withheld from every authenticated caller by a **column** privilege (migration 034 part E), and Supabase has exactly one logged-in database role: an administrator is an `authenticated` user distinguished only by `profiles.role`. RLS can see that distinction through `is_admin()`; a column privilege cannot. There is no `GRANT` that means "this column, but only for admins", so the Admin Services page selecting the rate got `403 Forbidden` — correctly.

```sql
create view admin_services with (security_barrier = true) as
select s.id, …, s.consultant_commission_bps, s.post_purchase_instructions_html
from services s
where is_admin();
```

**Deliberately not `security_invoker`** — that would apply the caller's own column privileges and reproduce the same 403. As an ordinary view it executes as its owner, which is the same mechanism `get_admin_finance_kpis` (migration 038) uses to aggregate a ledger its callers cannot read. `consultant_balances` *is* `security_invoker`, and the difference is intentional: there the ledger's RLS is the access rule and must be evaluated per caller; here the rule is "are you an administrator", stated once in the `WHERE`. `security_barrier` stops a caller-supplied predicate being pushed below that gate.

`SELECT` is granted to `authenticated` and to nobody else — the grant is the door, `is_admin()` is the lock, and a client or consultant reading it gets **zero rows**, not a filtered subset. `anon`, `PUBLIC` and `service_role` hold nothing. Every other privilege is revoked first, which matters: this is a simple view over one table and is therefore **auto-updatable**, so the default `GRANT ALL` would otherwise have made it a write path into `services` that bypassed the admin endpoints entirely.

Inactive services are included, which an admin managing a catalog needs and `services_select_active` exists to hide from clients. **`public.services` itself is completely unchanged** — no grant, no column list, no policy — so every public and client selector reads exactly what it read before.

---

## 11. `service_recommendations`

```sql
create table service_recommendations (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references consultations(id) on delete cascade,
  service_id uuid not null references services(id),
  recommended_by_consultant_id uuid not null references consultants(id),
  status recommendation_status not null default 'proposed',
  consultant_note text,
  sent_by_admin_id uuid references profiles(id),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (consultation_id, service_id),
  constraint sent_recommendation_requires_admin_metadata check (
    status = 'proposed'
    or (status = 'sent' and sent_by_admin_id is not null and sent_at is not null)
  )
);
```

- Consultant selects 1–3 (enforced in UI + orchestrator, not DB).
- Client only ever sees rows where `status = 'sent'` (RLS).

---

## 12. `service_requests`

```sql
create table service_requests (
  id uuid primary key default gen_random_uuid(),
  client_profile_id uuid not null references profiles(id),
  service_id uuid not null references services(id),
  consultation_id uuid references consultations(id),
  status service_request_status not null default 'pending',
  details_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Four statuses only. All fulfillment detail in `details_jsonb`. No workflow engine.

---

## 13. `payments`

Append-only Stripe event log + idempotency ledger.

```sql
create table payments (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid references consultations(id),
  stripe_payment_intent_id text not null,
  stripe_event_id text unique,              -- webhook idempotency: insert fails on replay
  event_type text not null,                 -- 'authorized' | 'captured' | 'auth_cancelled' | 'refunded' | webhook event names
  amount_cents integer not null,
  currency text not null default 'usd',
  status text not null,                     -- Stripe-reported status verbatim
  raw_jsonb jsonb,                          -- full Stripe payload for audit
  processed_at timestamptz,                 -- set only after the consultation transition succeeds
  processing_error text,                    -- last failure message, for webhook recovery/debugging
  created_at timestamptz not null default now()
);

create index idx_payments_pi on payments (stripe_payment_intent_id);
create index idx_payments_consultation on payments (consultation_id);
```

**Webhook idempotency rule (Dave's correction):** the unique `stripe_event_id` only prevents duplicate rows — it does NOT make processing idempotent by itself. The event insert and the related `consultations` state transition must happen in the **same database transaction**, or the Stripe event ID is used as the BullMQ job ID and `processed_at` is set only after the job succeeds. A replayed event checks `processed_at`: if null, reprocess; if set, no-op.

---

## 14. `messages`

Definition below is **post-migration 023** (PROJECT_LOCK Amendment 005, applied and verified). This supersedes the original v1.0 definition, in which `consultation_id` was `not null` and all messaging was consultation-scoped. No new table was created.

```sql
create table messages (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid references consultations(id) on delete cascade,  -- nullable since migration 023
  sender_profile_id uuid not null references profiles(id),
  recipient_profile_id uuid not null references profiles(id),
  body text not null,
  read_at timestamptz,
  email_notification_sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table messages add constraint messages_no_self_send
  check (sender_profile_id <> recipient_profile_id);

create index idx_messages_consultation on messages (consultation_id, created_at);

create index messages_recipient_unread_idx
  on messages (recipient_profile_id, created_at)
  where read_at is null;

create index messages_direct_pair_idx
  on messages (sender_profile_id, recipient_profile_id, created_at desc)
  where consultation_id is null;
```

**`consultation_id` is the sole classifier for the two message classes.** A message is exactly one of:

1. **Consultation message** — `consultation_id is not null`. Client ↔ assigned consultant.
2. **Direct message** — `consultation_id is null`. Admin ↔ consultant only, in either direction. A consultant may initiate without a prior admin message.

The class is never taken from any value supplied by a client.

**Triggers (migration 023):**

- `messages_direct_pairing` — `before insert`, calls `enforce_direct_message_pairing()`. For direct messages it reads both roles from `public.profiles` and requires exactly one admin and one consultant, rejecting self-send, consultant ↔ consultant, admin ↔ admin, and any client participation. Consultation messages pass through untouched.
- `messages_guard_columns` — `before update`, calls `guard_messages_columns()`. For non-privileged writers it blocks changes to `id`, `consultation_id`, `sender_profile_id`, `recipient_profile_id`, `body`, `created_at` and `email_notification_sent_at`. Privileged writers (`service_role`, admin) are exempt, which is how the orchestrator writes `email_notification_sent_at`.

**Mutability.** Message identity and body are immutable. **`read_at` is the only client-writable column.** `email_notification_sent_at` is written solely by the orchestrator after a successful send, and is the single idempotency marker for delayed notification email (Amendment 006 §3.3).

**Realtime.** `messages` is in the `supabase_realtime` publication and is used for direct-conversation presence under Amendment 005. Presence state is ephemeral and no table, column or record is created for it (Amendment 006 §2.6). No other application table is published.

No attachments and no threads.

---

## 15. `giveaways`

Per Dave's minimal spec.

```sql
create table giveaways (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  resource_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
```

No redemption tracking.

---

## 16. `app_settings`

Added by **PROJECT_LOCK Amendment 007**, applied as migration 025. The sixteenth and final table. A singleton row of explicitly typed operational settings, read and written **only** by the orchestrator service role.

```sql
create table app_settings (
  id uuid primary key default gen_random_uuid(),
  is_singleton boolean not null default true,
  consultation_price_cents integer not null,
  consultation_currency text not null default 'usd',
  consultation_duration_minutes integer not null,
  stripe_mode text not null,
  support_email text,
  default_timezone text not null,
  -- Migration 034. Consultant share of a standard consultation,
  -- in basis points of gross. Seeded at 5000 = the locked 50/50.
  consultation_consultant_commission_bps integer not null default 5000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_admin_profile_id uuid references profiles(id),
  constraint app_settings_singleton_check check (is_singleton),
  constraint app_settings_singleton_unique unique (is_singleton),
  constraint app_settings_stripe_mode_check check (stripe_mode in ('test', 'live')),
  constraint app_settings_currency_check check (consultation_currency = 'usd'),
  constraint app_settings_price_bounds_check
    check (consultation_price_cents between 100 and 1000000),
  constraint app_settings_duration_bounds_check
    check (consultation_duration_minutes between 15 and 240),
  constraint app_settings_support_email_check
    check (support_email is null
           or support_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint app_settings_default_timezone_check
    check (btrim(default_timezone) <> '')
);
```

**Singleton enforcement:** `is_singleton` is constrained to `true` and carries a unique constraint, so a second row is rejected by the database. No trigger, no fixed magic UUID, no `count(*)` race. Reads use `select ... limit 1`.

**Seeded values** (the values already in force, so applying the migration changes no behaviour): price `15000`, currency `usd`, duration `60`, `stripe_mode` `test`, `support_email` `null`, `default_timezone` `Africa/Cairo`.

**Contains no secret of any kind.** Stripe secret keys and webhook signing secrets live only in Railway environment variables — `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_WEBHOOK_SECRET`. `app_settings.stripe_mode` selects between them and never stores them.

**Access:** RLS enabled with **zero policies**, and all privileges revoked from `anon` and `authenticated`. Only the service role reaches this table. Not in the `supabase_realtime` publication. See `RLS_POLICY_PLAN.md` §2.

**Deliberately absent:** `consultant_acceptance_timeout_hours` (deferred by Amendment 007 §7 — the 48-hour timeout remains hardcoded in both the orchestrator scheduler and `finalize_authorization_timeout`), any JSON settings blob, any key/value column, and any credential field.

---

## 17–20. Financial foundation (migration 034 — authored, not applied)

Phase 1 of the Finance, Payouts & Direct Booking plan. Four tables, taking the model to **20**. No client reads any of them under any policy.

**Locked rules encoded here.** Commission is always computed on the **gross** amount charged — Stripe fees never reduce a consultant's share. A standard consultation is 50/50. A direct booking splits: the standard-price portion 50/50, the premium above it 80/20 in the consultant's favour. Each service carries its own rate and a recurring service earns on **every** successful renewal. Balances are per currency with **no FX conversion**. A negative balance after a post-payout reversal is legal and is offset by future earnings.

### 17. `consultant_ledger_entries`

Append-only. One row per financial event affecting one consultant, in the minor unit of `currency`.

```sql
create table consultant_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references consultants(id),
  entry_type text not null,        -- 'earning' | 'reversal' | 'adjustment'
  source_type text not null,       -- 'consultation' | 'service_purchase'
                                   -- | 'direct_booking' | 'manual'
  source_id uuid,                  -- null only when source_type = 'manual'
  source_component text not null default 'full',  -- 'full' | 'standard' | 'premium'
  gross_amount_minor integer not null,
  consultant_amount_minor integer not null,       -- the only balance-moving column
  platform_amount_minor integer not null,
  commission_bps integer,          -- 5000 = 50.00%
  commission_basis text not null,
  currency text not null,
  available_at timestamptz,        -- null = earned, not yet withdrawable
  reverses_entry_id uuid references consultant_ledger_entries(id),
  created_by_admin_profile_id uuid references profiles(id),
  memo text,
  created_at timestamptz not null default now()
);
```

**The commission snapshot lives here, not on `consultations` or `services`,** because a client can read their own consultation row and every active service row. This table is the only one they can never reach, so it is the only safe place for the platform's margin.

**Append-only is enforced, not conventional.** `trg_ledger_append_only` blocks every `DELETE` and every `UPDATE` except `available_at` advancing once from null to a timestamp — with **no exemption for the service role**. A wrong amount is corrected by inserting an adjustment; a refund by inserting a reversal. The original is never touched.

**The amount identity** `consultant_amount_minor + platform_amount_minor = gross_amount_minor` holds on every row, including reversals, which negate all three together. Rounding is the orchestrator's decision and is deliberately not asserted by a constraint.

**A direct booking is two rows**, `source_component` `standard` and `premium`, each with its own flat rate, so every row satisfies one simple statement rather than needing a nested breakdown.

**Duplicate-earning guard:** `unique (source_type, source_id, source_component) where entry_type = 'earning'`. A replayed webhook, a double-submitted completion or a retried renewal cannot credit twice.

### 18. `payouts`

One payout request. The only table here whose status moves: `requested → approved → paid`, or `→ rejected | cancelled`. V1 pays **manually**; no Stripe Connect, no automatic bank transfer. `destination_note` is a free-text snapshot captured per request, so a later change of bank details cannot rewrite what an old payout says.

`unique (consultant_id, currency) where status in ('requested','approved')` — one open request per consultant per currency. Each terminal status carries the evidence it happened (`paid` requires an amount, a date, an approval and an admin), and an unpaid row may not carry a paid amount.

### 19. `payout_allocations`

`(payout_id, ledger_entry_id)` with **`unique (ledger_entry_id)`** — the double-payment guarantee, enforced by the database rather than by application care. Two concurrent requests cannot both claim an entry.

`trg_payout_allocation_guard` refuses an allocation whose entry is still pending, belongs to another consultant, or is in another currency, and refuses to release the allocations of a **paid** payout. Rejecting or cancelling a payout deletes its allocations, returning the earnings to available; the payout row survives with its status and reason.

### 20. `service_purchases` (wired to the ledger by migration 040)

**Migration 040 adds two columns and makes this table live.** It existed unused from migration 034 until then — the table, the ledger, and the commission column were all in place, and nothing wrote to any of them.

```sql
alter table service_purchases
  add column stripe_subscription_id text,      -- null for a one-time sale
  add column refunded_amount_minor integer not null default 0;

-- 0 <= refunded_amount_minor <= gross_amount_minor
create unique index uq_service_purchases_subscription_period
  on service_purchases (stripe_subscription_id, billing_period_sequence)
  where stripe_subscription_id is not null;
create index idx_service_purchases_subscription
  on service_purchases (stripe_subscription_id) where stripe_subscription_id is not null;
```

`stripe_subscription_id` is what makes a renewal findable: a renewal invoice names its subscription and nothing else this system recognises, so the **first** purchase of a subscription is the record of what it is for and every later invoice inherits its service and client from it — a database fact, not metadata that must survive a year of billing cycles.

`refunded_amount_minor` accumulates across partial refunds. **A partial refund is a number, not a status:** status moves to `refunded` only when the refund reaches the gross, so no `partially_refunded` value is needed and the migration-034 status vocabulary is untouched.

**Four RPCs, `SECURITY DEFINER`, pinned search_path, `service_role` only:**

| RPC | Does |
|---|---|
| `record_service_purchase(...)` | Payment → purchase + **pending** earning, in one transaction |
| `fulfill_service_purchase(purchase, admin)` | Delivery → `fulfilled_at` + earning becomes available. Idempotent |
| `reverse_service_purchase_earning(purchase, reason, refunded_total?)` | Refund → negative ledger entry via `reverse_ledger_entry` |
| `reverse_service_purchase_for_payment_intent(pi, reason, refunded_total?)` | The webhook's refund entry point, so it never reads a table |

**Refund amounts are CUMULATIVE TOTALS, not deltas (migration 043).** `p_refunded_total_minor` means "Stripe reports this purchase has now been refunded by this much in total"; the function computes `delta = total − refunded_amount_minor` and reverses only the delta. Stripe's `charge.amount_refunded` is cumulative and monotonic, so this is idempotent **by construction** — a redelivered event applies nothing (`no_change`), a second partial reverses only its own share, and partial-then-full completes to the gross. Migration 040 treated the figure as a delta, which double-counted redeliveries and **over-reversed a consultant's ledger** on a second partial. The parameter was renamed and the old signature dropped so a stale caller fails loudly rather than silently double-counting.

**`record_service_purchase` accepts no consultant and no commission rate.** Attribution is re-derived on every call from `service_recommendations` joined to `consultations` — a consultant id in Stripe metadata cannot influence who is credited, because there is no parameter through which it could be passed. A client *candidate* may be supplied; it is validated against `profiles` and an unresolvable one produces an **unattributed** purchase rather than an error. Unattributed revenue is recorded and visible; it is never discarded.

Service resolution tries, in order of trust: explicit service id → inheritance from the subscription's first purchase → `services.stripe_payment_link_id` → `services.stripe_price_id`. Every step is a database lookup; none reads Stripe Payment Link metadata.

**Commission:** `round(gross::numeric * consultant_commission_bps / 10000)::integer`, platform takes the remainder by subtraction so `consultant + platform = gross` holds exactly. A **null or zero rate creates no ledger entry at all** — not a zero-value one, which `ledger_sign_check` would reject and which records no financial fact.

**Renewal sequencing** takes `pg_advisory_xact_lock(hashtextextended(subscription_id, 0))` before allocating `billing_period_sequence`, so two invoices arriving at once allocate 1 and 2 rather than colliding. `uq_service_purchases_subscription_period` backs it up if the lock were ever bypassed.

**Availability:** payment creates the earning with `available_at = null`. Only `fulfill_service_purchase` advances it — the single mutation `trg_ledger_append_only` permits. `service_requests.status = 'completed'` deliberately releases nothing.

The financial record of a service being paid for. **Deliberately not `service_requests`**, which remains the operational fulfillment record — a purchase *may* reference one, and for a recurring service several purchases reference the same one, which is exactly why they cannot be the same row. Each renewal is its own purchase, keyed by `billing_period_sequence` and its own Stripe invoice. Redelivery is blocked by unique partial indexes on `stripe_payment_intent_id`, `stripe_invoice_id` and `stripe_checkout_session_id`.

### `consultant_balances` (view)

**No balance is stored anywhere.** A `security_invoker` view derives `pending`, `available`, `reserved`, `paid` and `lifetime` per consultant per currency, all coalesced to zero, never summed across currencies. `available` is defined as "not claimed by a payout in `requested`, `approved` or `paid`", so an allocation left behind on a cancelled request cannot hide a withdrawable earning.

### `get_admin_revenue_by_source()` and `get_admin_dashboard_operations()` (migration 044)

The `/admin` dashboard read model. Two admin-only `SECURITY DEFINER` functions, read directly by an administrator's Supabase client exactly as `get_admin_finance_kpis` is — there is no orchestrator dashboard endpoint. Both take four explicit period bounds and call no `now()`, so the same arguments always give the same answer.

```sql
get_admin_revenue_by_source(current_from, current_to, compare_from, compare_to)
returns (period, currency, source_type,
         gross_revenue_minor, platform_revenue_minor,
         consultant_earnings_minor, reversals_minor, entry_count)
```

`period` is `current` | `comparison`; both come back in one call. Grouped by **currency and ledger `source_type`**, so consultation, service purchase and direct-booking revenue are separate rows of the same result. **Every** source type is returned — including `manual` adjustments — which is what makes the sum of the rows *be* the recorded total: a scoped KPI is a subset, not a second computation, so nothing can double-count. `direct_booking` returns no rows today; migration 034 admitted the source type before the feature existed, so it starts reporting with no change here.

**`RECORDED REVENUE` IS NOT TOTAL COLLECTED REVENUE.** It aggregates `consultant_ledger_entries` only. An **unattributed** service purchase — no consultant to credit, or a service with no commission rate — creates a `service_purchases` row and **no ledger entry** (migration 040), so its gross appears in none of these figures. The UI must label the metric **"Recorded Revenue"**, never "Revenue". The gap is surfaced beside it: `get_admin_dashboard_operations` reports unattributed purchase gross per currency as an alert. Folding `service_purchases.gross_amount_minor` into this function would produce a larger number that double-counts every attributed sale and reconciles to nothing.

```sql
get_admin_dashboard_operations(current_from, current_to, compare_from, compare_to)
```

One row: booking counts for both periods (`consultations.created_at` in period, **`status <> 'draft'`** — a draft is an abandoned hold, and this counts bookings *created*, not consultations *completed*), active and new consultant counts, pending payout liability and available consultant earnings, and five alert categories with counts and ages.

Per-currency figures are `jsonb` arrays of `{currency, amount_minor}`, ordered by currency and defaulting to `[]` rather than null — **never combined, never converted**. The two balances are deliberately not period-scoped: what is owed right now is a balance, not a flow.

The five alerts, and only these five: consultations in `admin_attention`; payouts in `requested`/`approved`; service purchases still `paid` (money taken, nothing released); purchases with `attributed_consultant_id is null` (the recorded-revenue gap); and purchases with `0 < refunded_amount_minor < gross_amount_minor`. Ages use `updated_at` where the state is entered later than creation — and for partial refunds because `refunded_at` is set only on a *full* refund.

An inactive consultant, a service with no commission rate, a consultant without Google or without working hours, and a long-open service request are all legitimate states in this system, so none is reported as needing attention.

### `get_admin_finance_kpis()` (migration 038)

The admin finance **period** read model. PostgREST aggregates are disabled, so without it an admin finance screen would have to download up to 5,000 ledger rows into a browser and add them up — shipping every consultant's individual earning, every commission rate and every memo to the client, truncating at the page size, and inviting the browser to add two currencies together. Aggregates stay disabled; the totals are computed in the database and only the totals cross the wire.

```sql
get_admin_finance_kpis(p_from timestamptz, p_to timestamptz)
returns table (
  currency                   text,
  gross_revenue_minor        bigint,
  platform_revenue_minor     bigint,
  consultant_earnings_minor  bigint,
  reversals_minor            bigint,
  adjustments_minor          bigint,
  ledger_entry_count         bigint
)
```

One row **per currency**, never summed across them and never converted. The period is **half-open**, `created_at >= p_from and created_at < p_to`, so consecutive periods tile exactly. `created_at` is the period column, not `available_at`: this answers "what did this window transact", which is a different question from "what can be withdrawn now".

**The three revenue figures are NET.** They sum every entry in the period whatever its type, so a reversal — negative on all three columns by `ledger_sign_check` — reduces them, and an adjustment moves them by its signed amount. Because `consultant + platform = gross` holds on every row it holds on the totals, so a screen showing all three can never display figures that do not add up. `reversals_minor` and `adjustments_minor` break out those two **components of the same sums** for a refunds tile; they are not a further deduction to apply. The earnings-only reading is exact arithmetic on the client: `gross_revenue_minor - reversals_minor - adjustments_minor`.

**`SECURITY DEFINER`, admin only.** It raises `insufficient_privilege` (42501 → HTTP 403) unless `is_admin()` holds for the calling JWT, so a consultant and a client both get nothing; identity cannot be supplied, only proved. `EXECUTE` is revoked from `PUBLIC`, `anon` and `service_role`, and granted to `authenticated` — the caller is an admin's browser, `authenticated` is the door and `is_admin()` is the lock. Bypassing the ledger RLS is safe because the function has **no row-returning path**: it aggregates before it returns, and its entire parameter surface is two timestamps, so no ledger row, consultant id, commission rate, memo or source id is reachable through any argument.

**Point-in-time balances are deliberately not duplicated here.** `available`, `reserved` and `pending` stay on `consultant_balances`. A period sum and a current balance are not the same figure and must not be produced by the same function.

Migration 038 also adds `idx_ledger_created_at`, since migration 034's indexes all serve per-consultant questions and a finance period is a range over the whole table. No table, column, constraint, trigger or policy changed.

## 21. `consultant_payout_settings` (migration 039)

How MakeHijrah manually pays a consultant. V1 pays **by hand** — an admin opens PayPal or Wise and sends the money — and until this table existed the system never recorded where to send it.

```sql
create table consultant_payout_settings (
  consultant_id uuid primary key
    references consultants(id) on delete cascade,
  payout_method text,          -- 'paypal' | 'wise', null until chosen
  payout_email text,           -- required whenever a method is set
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**Deliberately not columns on `consultants`.** That table is the booking projection every client and anonymous visitor reads, so a column added there is world-readable unless a column privilege is maintained to say otherwise — the surgery migration 034 had to perform for `services.consultant_commission_bps`, which fails closed only for as long as every future migration remembers it. A payout email is not booking data, and a table that is private by default cannot leak it by forgetting a grant.

**Constraints.** `payout_method in ('paypal','wise')`; a method requires a non-blank `payout_email` (`btrim(...) <> ''`, because `''` is what a cleared form field submits); the address must contain an `@`, no whitespace, and be at most 320 characters. The converse is permitted on purpose — an email with no method chosen is a half-finished form, and the payout request is where incompleteness actually matters. `trg_payout_settings_normalize` trims both fields, lowercases the method so `PayPal` from a select box passes the vocabulary check, and turns blanks into null. The address itself is **not** lowercased: the local part of an email is case-sensitive by specification.

**No `DELETE` policy and no delete grant.** Clearing a method is an `UPDATE` to null, which preserves `created_at`. **No admin write policy** either: an admin can see where a consultant is paid; changing it is the consultant's own act.

| | consultant | admin | client | anon |
|---|---|---|---|---|
| `consultant_payout_settings` | **select, insert, update** own | select all | none | none |

Every policy identifies the consultant through `my_consultant_id()`. The `INSERT` policy's `WITH CHECK` compares the row being written against the caller's own consultant id, so a `consultant_id` in the request body is never consulted — writing somebody else's row fails the check rather than depending on the client having sent the right value. `my_consultant_id()` is null for a client, and `consultant_id = null` is null, so a client is excluded by the same expression that scopes a consultant.

### `build_payout_destination_note()` and the payout snapshot

```sql
build_payout_destination_note(p_method text, p_email text) returns text
--  'PayPal | consultant@example.com'  |  'Wise | consultant@example.com'  |  null
```

Returns null for any unknown method or blank address, so one null test answers "is this consultant payable". Same single-formatter reasoning as migration 037's `build_finance_reference()`.

**`request_consultant_payout` lost its `p_destination_note` argument** (migration 039; signature is now `(uuid, text)`). The destination is read from the consultant's saved setting inside the RPC, refused with `FINANCE_PAYOUT_METHOD_MISSING` if incomplete, and **snapshotted** onto `payouts.destination_note`. It is never read back from the setting afterwards: if payout history read through to the current value, correcting a typo would silently rewrite where every past payout claims to have been sent, and the admin's record of a transfer they already made would change under them. A destination the caller cannot supply is a destination the caller cannot forge — the same treatment the amount already had.

### Access

| Table | consultant | admin | client | writes |
|---|---|---|---|---|
| all four | own records | all records | **none** | service role only |

RLS on, exactly one `SELECT` policy each, no write policy anywhere. `anon` holds no privilege at all; `authenticated` holds `SELECT` only. The client's exclusion is structural — no policy on any finance table names `client_profile_id`, so there is no clause to loosen by accident. `service_purchases.client_profile_id` is attribution data, not an access key.

**`services.consultant_commission_bps` is hidden by column privilege**, because `services_select_active` is readable by every authenticated user and RLS filters rows, not columns. Migration 034 replaces the table-level `SELECT` grant with an explicit column list that omits it. A future migration adding a client-visible column to `services` **must grant it explicitly** — the list fails closed. An administrator reads the rate through `public.admin_services` (migration 041) — see §10.

---

## 22–29. Editorial blog (migrations 052–053; 054–056 authored, not applied)

Eight tables, taking the model to 29. Migrations 052 and 053 are the canonical, byte-for-byte copies of SQL authored in the frontend repository and already applied to production from there (`migration_051_blog.sql` and `migration_052_blog_grants_and_email_invites.sql`, renumbered on import so their numbers do not collide with this repository's own history) — **imported for reproducibility, never to be reapplied**. See PROJECT_LOCK Amendment 018 for the full access model and rationale; this section is the schema reference.

```sql
create type blog_post_status as enum
  ('draft', 'scheduled', 'published', 'archived');

create table blog_managers (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references profiles(id) on delete cascade,  -- nullable; informational
  email       text not null,                                    -- the grant's real identity
  granted_by  uuid not null references profiles(id),
  granted_at  timestamptz not null default now(),
  note        text
);
-- unique index on lower(btrim(email))

create table blog_authors (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references profiles(id) on delete set null,  -- nullable; a byline need not be a login
  name        text not null,
  slug        text not null unique,
  bio         text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table blog_categories (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  description      text,
  seo_title        text,
  seo_description  text,
  sort_order       int  not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table blog_tags (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create table blog_posts (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  status              blog_post_status not null default 'draft',
  title               text not null,
  excerpt             text,
  body_html           text not null default '',
  body_text           text not null default '',   -- derived by trigger, never written directly
  reading_minutes     int  not null default 1,     -- derived by trigger
  featured_image_url  text,
  featured_image_alt  text,
  seo_title           text,
  seo_description     text,
  canonical_url       text,
  noindex             boolean not null default false,
  og_title            text,
  og_description      text,
  og_image_url        text,
  author_id           uuid references blog_authors(id) on delete set null,
  category_id         uuid references blog_categories(id) on delete set null,
  published_at        timestamptz,   -- required when status = 'published'
  scheduled_for       timestamptz,   -- required when status = 'scheduled'
  created_by          uuid references profiles(id),
  updated_by          uuid references profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table blog_post_tags (
  post_id uuid not null references blog_posts(id) on delete cascade,
  tag_id  uuid not null references blog_tags(id) on delete cascade,
  primary key (post_id, tag_id)
);

create table blog_post_revisions (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references blog_posts(id) on delete cascade,
  title       text not null,
  excerpt     text,
  body_html   text not null,
  edited_by   uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create table blog_redirects (
  id           uuid primary key default gen_random_uuid(),
  from_path    text not null unique,
  to_path      text not null,
  status_code  int  not null default 301,     -- in (301, 302, 308)
  created_at   timestamptz not null default now(),
  created_by   uuid references profiles(id)
);
```

**`blog_posts.body_html` is constrained, not merely conventional (migration 057).** The `unsafe_blog_html` CHECK constraint, fronted by the `trg_blog_posts_validate_html` BEFORE trigger, calls `is_safe_blog_html(text)` and refuses anything outside the approved editorial contract: tags `p br strong em b i u ul ol li h2 h3 a s del code pre blockquote hr`; attributes `href title rel target` on `<a>` only and on no other tag; hrefs limited to `http`, `https`, `mailto` or a safe internal path (reusing `is_safe_internal_path` from migration 055, so protocol-relative hrefs are refused — as they also are by the frontend, which sets `allowProtocolRelative: false`).

It enforces **vocabulary, not serialization**: `rel`, `target` and `title` accept any quote-free, angle-free text, because none can execute and canonicalising them to `target="_blank" rel="noopener noreferrer nofollow"` is the frontend sanitizer's job. `service_role` is granted `EXECUTE` explicitly, since the BEFORE trigger calls the validator as the invoking role. It **validates and never rewrites** — PostgreSQL has no HTML parser, and a mutating regex sanitizer is how mutation-XSS happens. A refused write is SQLSTATE `23514`, message exactly `unsafe_blog_html`, with no echo of the submitted markup.

This binds every writer identically — blog manager, admin, `service_role`, direct PostgREST — because RLS governs *who* writes and this governs *what*. `blog_post_revisions.body_html` is deliberately **not** constrained: it is an archive written only by the trigger from an already-validated row. Stored HTML must still be sanitized at render time; see Amendment 018 §10a.

**`blog_post_status`.** `published` requires `published_at`; `scheduled` requires `scheduled_for` — both are table `CHECK` constraints, not application discipline. `published_at` is stamped once, by `blog_posts_before_write()`, and never restamped: an edit is not a new publication.

**`blog_managers` is keyed on email, not `profile_id`.** `profile_id` is nullable and merely informational, filled in by a trigger on `profiles` the first time the person signs in; the grant itself is decided by `is_blog_manager()` matching either identity. See Amendment 018 §5 for why — no public sign-up exists, so a grant issued before the account does is the only way an outside contractor gets one at all.

**`blog_post_revisions.edited_by` and every INSERT into this table is written only by `blog_posts_after_write()`, a trigger on `blog_posts`.** No role, manager or admin included, holds `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` on it directly (migration 054). See "Revision trigger security" below.

### Revision trigger security (migration 054)

As imported, `blog_posts_after_write()` carried no `SECURITY` clause and ran as the calling role (`authenticated`), which migration 053 grants `SELECT` only on `blog_post_revisions` — so every post create and every editorial update failed the moment the trigger tried to write a revision. Migration 054:

- makes the function `security definer` with `set search_path = pg_catalog, public`, so the write happens as the function's owner (the same role that owns `blog_post_revisions`) regardless of the caller's grant;
- revokes `EXECUTE` on the function itself from `anon` and `authenticated` — firing a trigger does not consult it, matching the convention migration 036 established for every other trigger function in this schema;
- revokes `ALL` (not only `INSERT`/`UPDATE`/`DELETE`) on `blog_post_revisions` from `anon` and `authenticated`, then restates `SELECT` for `authenticated` explicitly. `TRUNCATE` is not filtered by RLS — there is no `FOR TRUNCATE` policy type — so the table grant is the only thing that can stop an authenticated caller wiping the entire table in one statement, and a narrower revoke would have left that open;
- applies the identical `EXECUTE` revoke to the blog's three other trigger functions (`blog_posts_before_write`, `blog_touch_updated_at`, `link_blog_manager_profile`), none of which needed a `SECURITY` change but all of which postdate migration 036 and had never been brought into its pattern.

The revision decision logic — skip a revision when nothing editorial changed, attribute to `auth.uid()` — is byte-for-byte unchanged.

### Redirect hardening (migration 055)

The imported constraint (`from_path like '/%'`, `to_path like '/%'`) accepts `//evil.example` — a scheme-relative URL a browser resolves against the current protocol. Migration 055 replaces both with `is_safe_internal_path(text)`, an `IMMUTABLE` SQL function requiring exactly one leading slash, no embedded `://`, no backslash (some browsers normalize `\` to `/`, which can produce the same scheme-relative result through a string that is never literally `//`), no control character, non-empty. Applied identically to `from_path` and `to_path`. `blog_redirects_no_self` and `blog_redirects_status` are unchanged. Before installing the constraint the migration scans existing rows and raises, naming any that would fail it, rather than applying anything over unsafe data.

This backend owns the constraint; it owns no redirect-serving code. The edge handler that actually issues the 301/302/308 is frontend/infra and is not hardened by this migration — see Amendment 018 §11.

### Scheduled publishing (migration 052's function; migration 056 hardens its grant)

`publish_due_blog_posts() returns integer`, `security definer`: one `UPDATE` over every row where `status = 'scheduled' and scheduled_for <= now()`, setting `published_at = coalesce(published_at, scheduled_for, now())`. Idempotent — a second call finds nothing left matching the predicate for a post it already published.

As imported, `revoke all on function publish_due_blog_posts() from public;` did not remove Supabase's ambient default `EXECUTE` grant to `anon`/`authenticated` held **by name** — the identical fact migration 036 exists to correct elsewhere, made by an author who had not seen that migration. Confirmed against a fresh replay of migrations 001–055: an anon key could call this function directly. Migration 056 revokes it from `PUBLIC`, `anon` and `authenticated` by name.

`src/modules/blog/blog-publishing.worker.ts` calls it every five minutes, modelled on `draft-expiry.worker.ts`: the RPC's own single-statement `UPDATE` is what makes concurrent orchestrator instances safe, and the Redis cycle lock is an optimisation against redundant calls, not a correctness dependency.

### Access

| Table | anon | authenticated (non-manager) | blog manager | admin |
|---|---|---|---|---|
| `blog_posts` | published only | published only | full | full |
| `blog_authors`, `blog_categories`, `blog_tags`, `blog_post_tags`, `blog_redirects` | read | read | full | full |
| `blog_post_revisions` | **none** | **none** | **select only** | select only |
| `blog_managers` | **none** | own grant, by profile or email | own grant | full — the only role that may grant or revoke |

`is_blog_manager()` (`security definer`, `set search_path = public`) returns true for a row in `blog_managers` matching the caller by `profile_id` or by case-insensitive email against the JWT, **or** for `is_admin()` — an admin is an implicit manager. It is deliberately callable by both `anon` and `authenticated`, matching `is_admin()`'s own precedent: `blog_posts_select_public` is `to anon, authenticated` and evaluates it in its `USING` clause, so anon visitors must be able to call it even though the answer for them is always false.

---

## `updated_at` trigger (shared)

```sql
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
```

Attached to: `profiles`, `consultants`, `oauth_connections`, `consultations`, `consultation_notes`, `services`, `service_requests`, `app_settings` (trigger `set_app_settings_updated_at`, migration 025).

## `profiles` auto-creation trigger

```sql
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();
```

Role stays `client` by default; consultant role is granted by the orchestrator during invite redemption; admin is seeded manually.

---

## Resolved decisions (locked by Dave)

1. `country_id IS NULL` is the **only** signal for a general consultation. No `is_general` boolean — one source of truth.
2. ~~`services.price_display` stays text. No `price_cents` on `services` in v1.0.~~ **Superseded by PROJECT_LOCK Amendment 004 (approved), applied as migration 022.** `services` now carries structured pricing (`billing_type`, `recurring_interval`, `price_cents`, `currency`) and orchestrator-owned Stripe identifiers. `price_display` is retained for compatibility and server-generated display text. See §10.
3. One storage bucket `public-media` with prefixes `avatars/{auth.uid()}/*`, `consultants/{auth.uid()}/*`, `giveaways/*`. **Unchanged by Amendment 007** — the admin avatar reuses this exact path, with no new bucket, column or policy.
4. The global consultation price is `app_settings.consultation_price_cents`, not an environment variable (Amendment 007, migration 025). It is snapshotted into `consultations.price_cents` at draft creation, so existing consultations and drafts never change price.

**Schema status: FROZEN v1.1** — v1.0 plus Amendment 004 (`services` structured pricing, migration 022), Amendment 005 (nullable `messages.consultation_id`, migrations 023–024) and Amendment 007 (`app_settings` plus `consultations.stripe_mode`, migration 025). Any further table requires a new amendment.

**Table count is 21:** the 16 above, plus the four finance tables of migration 034 (`consultant_ledger_entries`, `payouts`, `payout_allocations`, `service_purchases`) and `consultant_payout_settings` from migration 039. The verification suites for migrations 034 and 038 assert this total, so it moves only with a deliberate, approved addition.
