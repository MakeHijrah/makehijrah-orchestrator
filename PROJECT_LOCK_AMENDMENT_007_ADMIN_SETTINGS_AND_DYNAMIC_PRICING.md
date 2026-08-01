# PROJECT_LOCK Amendment 007 — Admin Settings and Dynamic Consultation Pricing

| Field | Value |
|---|---|
| Status | PROPOSED — requires written approval from Dave |
| Amends | `PROJECT_LOCK.md`, `DATABASE_SCHEMA.md`, `API_CONTRACT.md`, `ROLE_ACCESS_MATRIX.md`, `RLS_POLICY_PLAN.md` |
| Implemented by | `migration_025_admin_settings_and_dynamic_pricing.sql`; orchestrator settings module (Phase 2); admin frontend (Phase 3) |
| Database migration | **Yes.** One new table, one new nullable column on `consultations`. |
| Scope | Governance only. This document authorises work. It does not perform it. |

## 1. Standing

1.1 Amendments 004, 005 and 006 remain authoritative in full. This amendment
supersedes none of them.

1.2 Amendment 004 continues to govern the `services` catalog and its Stripe
Products, Prices and Payment Links, subject only to the mode rule in section
5.9 below.

## 2. Table count

2.1 The frozen data model of exactly 15 tables becomes **exactly 16**. The
sixteenth table is `public.app_settings` and no other.

2.2 Every statement of "15 tables" in `PROJECT_LOCK.md` and
`DATABASE_SCHEMA.md` is amended to 16.

2.3 No further table may be added without a new amendment.

## 3. `public.app_settings`

3.1 The table is a **singleton**: exactly one logical row, enforced
deterministically by a `unique` constraint on a boolean column that is itself
constrained to `true`. No trigger and no fixed magic UUID is used.

3.2 The table carries exactly six settings columns and nothing else:

- `consultation_price_cents`
- `consultation_currency`
- `consultation_duration_minutes`
- `stripe_mode`
- `support_email`
- `default_timezone`

together with `id`, the singleton marker, `created_at`, `updated_at` and
`updated_by_admin_profile_id`.

3.3 All columns are **explicitly typed**. No JSON settings blob, no key/value
rows, no generic extension column, and no arbitrary future widening without a
further amendment.

3.4 The table holds **no secret of any kind**. No API key, webhook signing
secret, token, password or credential may be stored in it, now or at any later
date.

3.5 The table is **not** added to the `supabase_realtime` publication.

3.6 RLS is enabled with **no policies**, and all privileges are revoked from
`anon` and `authenticated`. Only the orchestrator's service role reads or
writes the table.

3.7 `consultant_acceptance_timeout_hours` is **explicitly excluded** from this
table. See section 7.

## 4. Consultation pricing

4.1 The global consultation price moves from
`env.DEFAULT_CONSULTATION_PRICE_CENTS` to
`app_settings.consultation_price_cents`. The environment variable is retained
only as the migration seed value and as a bootstrap fallback.

4.2 Every new consultation **snapshots** the price in force at draft creation
into `consultations.price_cents`, exactly as it does today.

4.3 Existing consultations and existing drafts **never** change price when the
global price changes. A price change affects newly created consultations only.

4.4 Stripe Checkout continues to take its amount solely from
`consultations.price_cents`. The frontend never submits, controls or influences
the Checkout amount.

4.5 Prices are integer cents. **USD only.** Multi-currency is not authorised
and `consultation_currency` is constrained to `'usd'`.

4.6 A public endpoint (Phase 2) will expose the current effective price for
display. It exposes no setting beyond consultation price, currency and
duration.

## 5. Stripe mode

5.1 `app_settings.stripe_mode` stores exactly one of `'test'` or `'live'`. The
seeded value is `'test'`.

5.2 **Stripe credentials remain solely in Railway environment variables.** No
Stripe secret key and no webhook signing secret may be stored in the database,
transmitted to any browser, accepted through any user interface, written to any
log, or returned by any endpoint — in whole, in part, masked, prefixed or
suffixed.

5.3 The four credential variables are `STRIPE_TEST_SECRET_KEY`,
`STRIPE_TEST_WEBHOOK_SECRET`, `STRIPE_LIVE_SECRET_KEY` and
`STRIPE_LIVE_WEBHOOK_SECRET`.

5.4 The admin interface may display only whether each mode is **configured**,
derived solely from server-side environment-variable presence, and expressed
only as a boolean.

5.5 Switching mode requires the admin role and, for `live`, an explicit
confirmation. A switch to a mode whose credentials are absent must fail.

5.6 A mode change takes effect immediately, without redeploy or restart.

5.7 A mode change **never** redirects an existing payment operation to a
different Stripe account. Capture, cancellation and refund of an already
authorised payment always use the mode under which that payment was created.

5.8 `consultations.stripe_mode` records the mode at PaymentIntent creation and
is the authoritative selector for every later Stripe operation on that
consultation.

5.9 Service catalog Stripe objects — Products, Prices and Payment Links created
under Amendment 004 — use the **currently active** mode at the moment they are
created or updated. Existing catalog objects are **not** copied, mirrored or
recreated automatically when the mode changes. Reconciling the catalog across
modes is a deliberate, separately authorised operation.

5.10 Stripe Connect is **not** introduced. Manual capture is unchanged.

## 6. Webhook verification

6.1 Webhook signatures are verified against each configured webhook secret in a
bounded, fixed order. Verification consults no database state and no admin
setting.

6.2 After successful verification, `event.livemode` **must** match the mode of
the secret that verified it. Mismatches are rejected and never processed.

6.3 Test events remain processable while the active mode is Live, and live
events while the active mode is Test. Support for either class is never removed
on the basis of the admin's current mode selection.

6.4 Duplicate-webhook protection through the unique `payments.stripe_event_id`
is unchanged.

6.5 Sections 6.1 to 6.3 are authorised here and implemented in Phase 2. This
migration changes no webhook behaviour.

## 7. Consultant acceptance timeout — deferred

7.1 The 48-hour consultant acceptance timeout is **deferred from this build**
and is **not** an admin-managed setting.

7.2 No `consultant_acceptance_timeout_hours` column is created.

7.3 `migration_016_finalize_authorization_timeout.sql` and
`public.finalize_authorization_timeout` are **not modified**. The interval
remains hardcoded at 48 hours in both the orchestrator scheduler and the RPC
guard, and those two values remain deliberately in agreement.

7.4 Making the timeout dynamic would require parameterising a payment-critical
RPC. That work requires its own amendment.

## 8. General settings

8.1 The only operational settings authorised by this amendment are: support
email, default timezone, and consultation duration.

8.2 `default_timezone` is seeded as `Africa/Cairo` and must always be a valid
IANA timezone identifier.

8.3 `default_timezone` **never** overwrites `consultants.timezone` or
`consultations.client_timezone`. It applies only where the application uses a
global default.

8.4 `support_email` does not change the email sender identity, which remains
governed by the Mandrill configuration in Railway. It is seeded `null`.

8.5 Consultation duration affects newly created consultations and their
calendar events. Existing scheduled consultations are unchanged, because
`scheduled_end_at` is already stored per consultation.

8.6 **Not authorised:** CMS features, branding controls, SEO settings, email
template editors, feature flags, arbitrary environment control, or any
credential for Mandrill, Google OAuth, Redis or Railway.

## 9. Avatar

9.1 The admin avatar uses the **existing** profile and storage architecture:
`profiles.avatar_url`, storage bucket `public-media`, prefix
`avatars/{auth.uid()}/*`, own-profile RLS write.

9.2 No new bucket, column, endpoint or storage policy is created.

9.3 Avatar binary data and avatar URLs are never stored in `app_settings`.

## 10. Consultant-specific pricing — deferred

10.1 Consultant-specific pricing is **explicitly deferred**. No consultant
price column and no consultant override interface is added.

10.2 The future rule is recorded here so it is not reinvented: the effective
consultation price is the consultant override when present, otherwise the
global `app_settings` price.

10.3 This build remains **globally priced**.

## 11. Unchanged by this amendment

11.1 Manual capture, payment authorization, decline, timeout and refund
behaviour.

11.2 Consultation messaging, direct messaging, presence and notifications
(Amendments 005 and 006).

11.3 All RLS policies on all other tables.

11.4 The `payments` table, which gains no column. Payment mode is resolved from
`consultations.stripe_mode`, never from `payments`.

11.5 Existing consultation prices. The migration does not alter a single
`consultations.price_cents` value.

## 12. Phasing

12.1 **Phase 1 (this amendment and migration 025):** schema only. One table,
one column, one seed row, RLS, privileges, documentation. No runtime behaviour
changes.

12.2 **Phase 2:** orchestrator settings reader and writer, Stripe mode
provider, Stripe client lifecycle, webhook verification, dynamic pricing at
draft creation, and the settings endpoints.

12.3 **Phase 3:** admin settings interface and public price display.

12.4 Nothing in Phase 1 alters application behaviour. Until Phase 2 ships, the
orchestrator continues to read the price from the environment variable, and
`app_settings` is inert.
