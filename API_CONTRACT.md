# MakeHijrah Relocation OS — API_CONTRACT.md

**Version:** 1.0 (draft for Dave's review)
**Purpose:** The complete, closed list of orchestrator endpoints. **If an endpoint is not in this document, the frontend does not call it and it does not exist.** Every prompt that touches the backend references this file.

> **Terminology note (2026-08-01).** Historical references to "Lovable" throughout this document mean **the frontend application generally**, which is now maintained directly in Git. The original wording is preserved rather than rewritten; read it as "the frontend".
>
> **Provider note (2026-08-01).** Historical references to **Resend** describe the originally specified email provider. The implemented and deployed provider is **Mandrill** (`src/lib/mandrill.ts`). Delivery semantics are as documented; only the vendor differs.

---

## 0. Global conventions

### Base URL
```txt
staging:    https://api-staging.makehijrah.com   (or Railway-generated domain until DNS)
production: https://api.makehijrah.com
```

### Authentication
- Lovable sends the Supabase access token: `Authorization: Bearer <supabase_jwt>`.
- Orchestrator verifies the JWT (Supabase JWT secret), extracts `sub` = profile id, then loads `profiles.role` via service role for authorization. **The role claim is never trusted from the client; it is always re-read from the DB.**
- Endpoints marked **public** need no token. Endpoints marked **client / consultant / admin** enforce that role server-side.

### Response envelope
```json
// success
{ "ok": true, "data": { ... } }

// error
{ "ok": false, "error": { "code": "SLOT_TAKEN", "message": "Human-readable, safe to display." } }
```

### HTTP status usage
`200` success · `400` validation · `401` no/bad token · `403` wrong role or not owner · `404` not found (also used instead of 403 where existence itself is sensitive) · `409` conflict (slot taken, invalid transition) · `429` rate limited · `500` internal (generic message, details logged server-side only).

### Error codes (closed list)
```txt
VALIDATION_ERROR, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND,
SLOT_TAKEN, SLOT_TOO_SOON, SLOT_OUTSIDE_HOURS, DRAFT_EXPIRED,
INVALID_TRANSITION, INVITE_INVALID, INVITE_EXPIRED,
OAUTH_NOT_CONNECTED, GOOGLE_ERROR, STRIPE_ERROR, RATE_LIMITED, INTERNAL
```
Lovable maps codes → UI copy. Lovable never parses `message` strings for logic.

### Rate limiting (MVP-light)
Per-IP on public endpoints: availability 30/min, draft creation 5/min, invite redemption 5/min. Everything else per-user 60/min. 429 with `RATE_LIMITED`.

### Idempotency
- Stripe webhook: `stripe_event_id` unique + `processed_at` per the schema doc (transition in same transaction, or event ID as BullMQ job ID).
- Accept/decline: naturally idempotent via status guard — repeat call on already-transitioned consultation returns `409 INVALID_TRANSITION` with current status in `data`.
- Draft creation: DB unique index makes double-submit safe (`SLOT_TAKEN`).

---

## 1. Booking (public → client)

### `GET /api/availability` — public
Returns bookable slots for a consultant.

Query params:
```txt
consultant_id  uuid, required
from           ISO date, required (client-local day start ok; server treats as UTC window)
to             ISO date, required, max 14 days after from
```

Server computes: working_hours_jsonb (consultant TZ → UTC) ∩ NOT Google FreeBusy ∩ NOT non-terminal consultations ∩ ≥ minimum_booking_notice_hours from now. 60-min slots on 30-min intervals. Result cached in Redis 2 min per `(consultant_id, from, to)`.

Response `data`:
```json
{
  "consultant_id": "...",
  "slots": [
    { "start_at": "2026-08-03T07:00:00Z", "end_at": "2026-08-03T08:00:00Z" }
  ],
  "generated_at": "2026-07-17T10:00:00Z",
  "cache_ttl_seconds": 120
}
```
Errors: `NOT_FOUND` (inactive/unknown consultant), `OAUTH_NOT_CONNECTED` (consultant has no Google connection — UI shows "temporarily unavailable"), `VALIDATION_ERROR`.

All times in the contract are UTC ISO-8601. Lovable converts to the browser's local timezone for display and sends the browser's IANA zone in draft creation.

### `POST /api/consultations/draft` — client (authenticated)
Creates the slot hold. This is the ONLY way a consultation row comes into existence.

Body:
```json
{
  "consultant_id": "uuid",
  "country_id": "uuid | null",
  "start_at": "2026-08-03T07:00:00Z",
  "client_timezone": "Africa/Cairo",
  "intake": {
    "full_name": "…",
    "email": "…",
    "phone_whatsapp": "…",
    "answers": { }
  }
}
```

Server: re-validate slot exactly as `GET /api/availability` (fresh FreeBusy, bypass cache) → insert `consultations` (status `draft`, price snapshot from `app_settings`, `end_at = start + consultation_duration_minutes`) + `consultation_intake` in one transaction → unique index is the final referee.

**Price source (PROJECT_LOCK Amendment 007, migration 025).** The price is read from `app_settings.consultation_price_cents`, not from an environment variable, and is **snapshotted** into `consultations.price_cents` at draft creation. An admin price change therefore affects newly created consultations only; existing consultations and existing drafts keep their original price. Checkout always takes its amount from `consultations.price_cents`. The client never submits, controls or influences the amount — there is no price field in this request body and none is accepted. Live since orchestrator commit `f905431`; see §3b.

Response `data`:
```json
{
  "consultation_id": "uuid",
  "status": "draft",
  "hold_expires_at": "2026-07-17T10:30:00Z",
  "price_cents": 15000,
  "currency": "usd"
}
```
Errors: `SLOT_TAKEN` (409, unique index or FreeBusy conflict — UI returns user to slot picker with refreshed slots), `SLOT_TOO_SOON`, `SLOT_OUTSIDE_HOURS`, `VALIDATION_ERROR`.

### `POST /api/consultations/:id/checkout` — client (owner)
Creates Stripe Checkout session, manual capture.

**Stripe mode (PROJECT_LOCK Amendment 007, migration 025).** The PaymentIntent is created under the currently active `app_settings.stripe_mode`, and that mode is recorded on the consultation as `consultations.stripe_mode`. Every later Stripe operation on that consultation — capture on accept, cancellation on decline or timeout, admin cancel, refund — selects its Stripe client from `consultations.stripe_mode`, **never** from the current global mode. A consultation authorised in Test therefore still captures against Test after an admin switches the platform to Live. Stripe credentials remain solely in Railway environment variables and are never stored in the database or sent to any browser. Live since orchestrator commit `f905431`. Migration 025 added the column and backfilled existing PaymentIntent rows to `'test'`; see §3b.

Body: none.
Server: verify ownership + status `draft` + draft not stale (< 30 min) → create Checkout Session (`capture_method: manual`, amount = snapshotted `price_cents`) → store `stripe_payment_intent_id` on the consultation.

Response `data`:
```json
{ "checkout_url": "https://checkout.stripe.com/…" }
```
Errors: `DRAFT_EXPIRED` (409 — UI restarts slot selection), `INVALID_TRANSITION`, `STRIPE_ERROR`.

Success/cancel URLs: `{app}/dashboard?booking=success&cid=:id` and `{app}/consultation?booking=cancelled&cid=:id`. **The success page shows "payment authorized, awaiting consultant" only after the consultation status (read via Supabase RLS) is `pending_acceptance` — never trust the redirect alone.**

### `POST /api/webhooks/stripe` — Stripe only (signature-verified, no JWT)
Handles: `payment_intent.amount_capturable_updated` (→ status `payment_authorized` → immediately `pending_acceptance`, set `payment_authorized_at`, email client + consultant), `payment_intent.canceled`, `payment_intent.succeeded` (capture confirmation), `charge.refunded`.

Rules: verify `Stripe-Signature` → insert `payments` row + consultation transition in one transaction → `processed_at` on success, `processing_error` on failure (Stripe retry will reprocess since `processed_at` is null).

**Non-consultation events (Amendment 004 §10):** a correctly signed event carrying no `consultation_id` — which is what service Payment Link purchases produce — is acknowledged with **HTTP 200** and ignored, not rejected. Response `data` includes `"ignored": true, "reason": "non_consultation_event"`. No consultation transition, no `payments` row, no consultation RPC. Rejecting these would cause Stripe to retry and eventually disable the endpoint, which would break consultation capture. Signature verification is unchanged: an invalid signature is still `400`. Event types the webhook does not handle continue to be acknowledged and ignored, with `"reason": "unsupported_event_type"`.

---

## 2. Consultant actions — consultant role

### `POST /api/consultations/:id/accept`
Guard: assigned consultant + status `pending_acceptance` + within 48h window.
Server sequence (order matters):
1. Capture Stripe PaymentIntent.
2. On capture success → status `captured`, set `captured_at`, `accepted_at`.
3. Create Google Calendar event on the **consultant's calendar only — the client is NEVER added as an attendee** (privacy rule: consultant must not see client email via Google). Event title uses an internal reference, e.g. `MakeHijrah Consultation #ABC123`; description may contain consultation ID, dashboard link, Join Meet link — and must NOT contain client email, phone, or WhatsApp. Meet link via `conferenceData.createRequest`.
4. Store `google_event_id`, `meet_link` → status `confirmed`.
5. Emails (Mandrill; originally specified as Resend): client receives Meet link **plus an `.ics` calendar attachment** (this replaces the Google invite); consultant receives confirmation.

If step 3/4 fails after capture: status `admin_attention`, reason `calendar_failed`, money stays captured, admin resolves manually. **Never auto-refund on calendar failure.**

Response `data`: `{ "status": "confirmed", "meet_link": "…" }` (or `{ "status": "admin_attention" }`).
Errors: `INVALID_TRANSITION` (already accepted/declined/timed out), `STRIPE_ERROR`, `GOOGLE_ERROR`.

### `POST /api/consultations/:id/decline`
Body: `{ "reason": "optional text" }`
Guard: assigned consultant + status `pending_acceptance`.
Server: cancel Stripe authorization → status `admin_attention`, reason `declined`, set `declined_at` → payments log row → email admin + client ("no charge was made").
Response `data`: `{ "status": "admin_attention" }`.

### `GET /api/consultant/oauth-status`
Response `data`: `{ "connected": true, "google_email": "…" }` or `{ "connected": false }`.

### `GET /api/consultant/oauth/connect`
Returns Google OAuth consent URL (`access_type=offline`, `prompt=consent`, Calendar scopes, `state` = signed consultant binding).
Response `data`: `{ "redirect_url": "https://accounts.google.com/o/oauth2/…" }`.

### `GET /api/oauth/google/callback` — public (state-verified)
Exchanges code → encrypts refresh token → upserts `oauth_connections` → 302 redirect to `{app}/consultant/profile?google=connected` (or `?google=error`).

### `POST /api/consultations/:id/complete` — consultant (assigned) or admin
Guard (locked by Dave): status in (`confirmed`, `captured`) AND `scheduled_end_at <= now()`.
Server: status `completed`, `completed_at = now()`. Unlocks recommendation proposals.
UI copy requirement: consultant sees "You can write notes now. You can mark the consultation complete after the scheduled end time." — notes are never blocked (allowed during `confirmed`/`captured`/`completed` per RLS plan); recommendations are proposed after completion.

---

## 2a. Message notification — client, consultant or admin

Added by PROJECT_LOCK Amendments 005 and 006.

### `POST /api/messages/:id/notification`

Schedules the delayed email notification for a message that has already been persisted. It does **not** send mail directly and it does **not** create or modify the message.

Auth: any authenticated `client`, `consultant` or `admin`. The caller's profile id must equal `messages.sender_profile_id` — admin was added solely so an admin can schedule notifications for direct messages they sent, and it grants no other message access.

Body: **none.** The message id in the path is the only input. The message class is read from the stored row (`consultation_id is not null` = consultation message, `null` = direct message) and never from the request.

Rate limit: 30 / minute.

Response `data`:
```json
{ "message_id": "uuid", "notification": "scheduled" }
```
`notification` is one of `scheduled`, `suppressed` (already read), `already_sent`. **All three are success.** Callers should treat this as fire-and-forget: the message is already persisted, so a scheduling failure must never be surfaced as a send failure.

Errors: `403 FORBIDDEN` (caller is not the sender, or direct-message pairing is invalid), `404 NOT_FOUND`, `400 VALIDATION_ERROR` (malformed id), `500 INTERNAL_ERROR`.

Behaviour: a fixed delay elapses before delivery; if the recipient reads the message first, **no email is sent**. `messages.email_notification_sent_at` is the sole idempotency marker and is written only after a successful send while the message is still unread and unmarked. Repeated scheduling of the same message never produces a duplicate email. Direct emails are tagged `direct-message` and carry metadata limited to `message_id`, `sender_role` and `recipient_role`; consultation emails remain tagged `consultation-message` and carry no metadata. Message bodies never appear in metadata.

---

## 3. Admin actions — admin role

### `POST /api/admin/invites`
Body: `{ "email": "…", "expires_in_days": 7 }`
Server: generate 256-bit token → Argon2id hash → insert `consultant_invites` → **return raw token once, never persisted, never logged**.
Response `data`: `{ "invite_id": "…", "invite_url": "{app}/onboard/<raw_token>", "expires_at": "…" }`.
UI rule: show copy-once modal with explicit "this will not be shown again."

### `POST /api/onboard/redeem` — authenticated + invite token
(The token proves the invitation; the JWT proves which Supabase user receives the consultant role.)
Body:
```json
{
  "token": "raw invite token",
  "profile": { "full_name": "…", "timezone": "Africa/Cairo" }
}
```
Precondition: user has already completed Supabase OTP signup and sends their JWT too (so we bind invite → auth user).
Server (one transaction): verify token against `unused` non-expired hashes → mark invite `used` → set `profiles.role = 'consultant'` → create `consultants` row (`is_active = false`).
Errors: `INVITE_INVALID`, `INVITE_EXPIRED`.

### `POST /api/admin/consultants/:id/activate` and `/deactivate`
Guard for activate: consultant has timezone, working hours non-empty, and OAuth connected — else `409` with which precondition failed in `data.missing[]`.

### `POST /api/admin/consultations/:id/cancel`
Body: `{ "refund": true | false, "note": "…" }`
Server by current status: `pending_acceptance` → cancel authorization; `confirmed`/`captured` → refund if `refund: true`, delete/patch Google event; always → status `cancelled` (or `refunded`), payments log, emails to both parties.

### `POST /api/admin/recommendations/:id/send` — admin
Guard: recommendation status `proposed`, parent consultation `completed`.
Server: status `sent`, `sent_at`, `sent_by_admin_id` (satisfies the DB check constraint) → Mandrill email "recommended services" to client.
Response `data`: `{ "status": "sent" }`.

---

## 3a. Admin service catalog — admin role

Added by **PROJECT_LOCK Amendment 004** (approved), which is the written approval this document's §7 requires. These five endpoints are the *only* way `public.services` is mutated. Migration 022 revoked `INSERT`, `UPDATE` and `DELETE` on `public.services` from `authenticated`, so there is no RLS write path left — not even for admins.

**Rules common to all five:**

- **Admin JWT required.** The role claim is never trusted from the client; the server re-reads `profiles.role` via service role, exactly as §0 specifies. Non-admin → `403 FORBIDDEN`.
- **The orchestrator performs every database mutation using the service role.** Lovable never writes to `services`.
- **The frontend never sends a Stripe identifier.** `stripe_product_id`, `stripe_price_id`, `stripe_payment_link_id` and `stripe_payment_link_url` are orchestrator-owned, rejected with `VALIDATION_ERROR` if present in any request body.
- **One Stripe Product per service**, created once and reused for that service's lifetime.
- **Allowed currencies: `usd`, `gbp`, `eur`.** No other currency is accepted. Pricing is fully structured or fully absent — partial pricing is rejected with `VALIDATION_ERROR`.
- Responses use the standard envelope from §0. **No new error codes**: these endpoints use only `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_TRANSITION`, `STRIPE_ERROR`, `INTERNAL`.
- Service Payment Links use **normal Stripe payment and subscription behaviour**. They are not manual capture. Consultation Checkout (§1) is unchanged and remains manual capture.

### `POST /api/admin/services`
Creates a service. **Database-first and inactive**: the row is written with `is_active = false` and no Stripe resources. Nothing is created in Stripe by this call.

Body: `name`, `description?`, `sort_order?`, and either no pricing at all, or a complete set — `billing_type` (`one_time` | `recurring`), `recurring_interval` (`month` | `year`, required for `recurring`, forbidden for `one_time`), `price_cents` (integer > 0), `currency` (`usd` | `gbp` | `eur`).

Response `data`: the created service, `is_active: false`, Stripe identifiers `null`.
Errors: `VALIDATION_ERROR`, `FORBIDDEN`.

### `PATCH /api/admin/services/:id`
Updates a service. Descriptive changes (`name`, `description`, `sort_order`) touch the database only.

**A change to `price_cents`, `currency`, `billing_type` or `recurring_interval` creates a new Stripe Price** — Stripe Prices are immutable — **and a replacement Payment Link.** The service's existing Stripe Product is reused. The superseded Price and Payment Link are preserved in Stripe; only the pointer columns on the row move.

Response `data`: the updated service.
Errors: `VALIDATION_ERROR`, `NOT_FOUND`, `STRIPE_ERROR`, `FORBIDDEN`.

### `POST /api/admin/services/:id/activate`
Sets `is_active = true`. **Requires a valid Stripe Payment Link.** If the service has no complete structured pricing, or no current Payment Link, activation is refused with `409 INVALID_TRANSITION` — a service is never publicly listed without a working way to buy it. Where pricing exists but Stripe resources do not, the orchestrator creates the Product, Price and Payment Link as part of this call.

Payment Links redirect on completion to `${APP_URL}/dashboard`. **No new frontend route is introduced**; in particular there is no `/services/thank-you` route.

Response `data`: the activated service.
Errors: `INVALID_TRANSITION` (409, missing pricing or Payment Link), `NOT_FOUND`, `STRIPE_ERROR`, `FORBIDDEN`.

### `POST /api/admin/services/:id/deactivate`
Sets `is_active = false`. The service disappears from client-visible catalog reads (`services_select_active`). Stripe resources are retained, not deleted. This is the correct action for a service that can no longer be deleted because other rows reference it.

Response `data`: the deactivated service.
Errors: `NOT_FOUND`, `FORBIDDEN`.

### `DELETE /api/admin/services/:id`
**Hard deletion only when no row references the service.** The orchestrator checks every foreign key referencing `public.services` — currently `service_recommendations.service_id` and `service_requests.service_id` — and refuses with `409 INVALID_TRANSITION` if any referencing row exists, returning the blocking counts in `data`. **No historical record is ever cascade-deleted, detached or nulled.** A referenced service must be deactivated instead.

Requires explicit administrator confirmation in the UI before the call is made.

Response `data`: `{ "deleted": true }`.
Errors: `INVALID_TRANSITION` (409, service is referenced), `NOT_FOUND`, `FORBIDDEN`.

### Purchases are not recorded here

A service Payment Link purchase **creates no row in any MakeHijrah table**. It does not write to `payments`, and it does not create a `service_requests` row. **Stripe is the temporary source of truth** for service purchases and subscriptions in this scope, including subscription management and refunds. Reconciliation into the database is out of scope and requires its own amendment.

Correctly signed Stripe events that carry no `consultation_id` — which is what service Payment Link purchases produce — are acknowledged by `POST /api/webhooks/stripe` with **HTTP 200** and ignored: `{ "ignored": true, "reason": "non_consultation_event" }`. No consultation transitions, no `payments` row is written, and no consultation RPC is called. See §1.

---

## 3b. Application settings — public read, admin write

Added by PROJECT_LOCK Amendment 007, applied as migration 025. `public.app_settings` has RLS enabled with **zero policies** and `anon`/`authenticated` revoked, so it is unreachable from the browser by construction. These four endpoints are the only access path. There is deliberately **no** generic settings endpoint accepting arbitrary keys.

### `GET /api/public/settings` — public, no auth

Rate limit: 60 / minute.

Response `data` — exactly these three fields, nothing else:
```json
{
  "consultation_price_cents": 15000,
  "consultation_currency": "usd",
  "consultation_duration_minutes": 60
}
```
No `stripe_mode`, no configured booleans, no `support_email`, no `default_timezone`, no timestamps, no audit id. Fails closed with `500 INTERNAL_ERROR` rather than returning a guessed price.

### `GET /api/admin/settings` — admin

Response `data`:
```json
{
  "consultation_price_cents": 15000,
  "consultation_currency": "usd",
  "consultation_duration_minutes": 60,
  "support_email": null,
  "default_timezone": "Africa/Cairo",
  "stripe_mode": "test",
  "stripe_test_configured": true,
  "stripe_live_configured": true,
  "updated_at": "2026-08-01T00:00:00.000Z"
}
```
`stripe_test_configured` / `stripe_live_configured` are derived **solely** from server-side environment-variable presence and are booleans. No key material — whole, partial, masked, prefixed or suffixed — is ever returned.

### `PATCH /api/admin/settings` — admin

Strict body; **unknown keys are rejected**. At least one field required.
```json
{
  "consultation_price_cents": 20000,
  "consultation_duration_minutes": 45,
  "support_email": "help@example.com",
  "default_timezone": "Africa/Cairo"
}
```
Validation: price `100`–`1000000` integer cents; duration `15`–`240` integer minutes; `support_email` a valid email or explicit `null` to clear; `default_timezone` a valid IANA zone. Bounds mirror the migration-025 check constraints exactly. `stripe_mode` is **not** accepted here.

Writes `updated_by_admin_profile_id`; `updated_at` is set by the `set_app_settings_updated_at` trigger. Returns the admin projection above. Invalidates the settings cache before responding.

Errors: `400 VALIDATION_ERROR`, `401`, `403`, `500`.

### `PATCH /api/admin/settings/stripe-mode` — admin

```json
{ "stripe_mode": "live", "confirm_live": true }
```
Rules: the target mode's environment credential pair must exist, or `409 STRIPE_MODE_NOT_CONFIGURED`. Switching to `live` requires `confirm_live: true`, or `409 LIVE_MODE_CONFIRMATION_REQUIRED`.

Response `data` — only:
```json
{ "stripe_mode": "live", "stripe_test_configured": true, "stripe_live_configured": true }
```

Effective immediately, without redeploy or restart. **Never** returns a credential.

### Settings-driven runtime behaviour

- **Consultation price** is read from `app_settings.consultation_price_cents` at draft creation and **snapshotted** into `consultations.price_cents`. Existing consultations and drafts keep their original price. Checkout always takes its amount from the snapshot. The client never submits or influences the amount.
- **Consultation duration** is read from `app_settings.consultation_duration_minutes` and drives both availability slot generation and draft `scheduled_end_at` from a single value. Existing scheduled consultations retain their stored `scheduled_end_at`.
- **`consultations.stripe_mode`** records the mode a consultation's PaymentIntent was created under. Every later capture, cancellation and refund selects its Stripe client from that value, **never** from the current global mode — so a payment authorised in test still captures against test after a switch to live. After retrieval, `paymentIntent.livemode` must match the recorded mode or the operation is refused.
- **Webhook verification** tries each configured mode's signing secret in a fixed, bounded order and consults no database state. After a signature verifies, `event.livemode` must match the verifying secret's mode or the event is rejected `400 STRIPE_LIVEMODE_MISMATCH` and never processed. Test events stay processable while the platform is live, and vice versa. Duplicate protection through the unique `payments.stripe_event_id` is unchanged.
- **Manual capture is unchanged.**
- Stripe credentials live **only** in Railway environment variables and are never stored in the database, sent to a browser, accepted through a UI, or logged.

---

## 4. What Lovable reads directly from Supabase (no endpoint)

Everything RLS already grants — this is the *only* non-orchestrator data path:

```txt
consultants + consultant_countries + countries   → booking form, profiles
consultations (own/assigned)                     → all dashboards, statuses, meet_link
consultation_intake (own/assigned)               → consultant pre-call view
consultation_notes (own consultant)              → notes UI (writes via RLS too)
service_recommendations                          → per-role filtered views (consultant inserts 'proposed' via RLS)
services, giveaways (active)                     → catalogs
service_requests (own / admin)                   → dashboards
messages (participant)                           → consultation room, 30s polling
profiles (own)                                   → account settings
```

**Banned from Lovable, permanently:** any read of or write to `app_settings`; any write to `consultations`, `payments`, `oauth_connections`, `consultant_invites`, `services`; any Google or Stripe API call; any Stripe identifier in a request body, query parameter or header; any status field mutation on any table except `service_requests` (admin) and `service_recommendations` deletion of own `proposed` rows.

`app_settings` is unreachable from the browser by construction: RLS is enabled with zero policies and all privileges are revoked from `anon` and `authenticated` (Amendment 007). Settings are read and written exclusively through the orchestrator endpoints in §3b.

`services` is read-only for every authenticated role, admin included — the database enforces this, not just convention (migration 022). Catalog changes go through §3a.

---

## 5. Background jobs (BullMQ, not endpoints — listed so nobody invents endpoints for them)

| Job | Schedule | Action |
|---|---|---|
| `expire-drafts` | every 15 min | `draft` older than 30 min → `cancelled` |
| `authorization-timeout` | every 15 min | `pending_acceptance` + `payment_authorized_at < now()-48h` → cancel Stripe auth → `admin_attention` (reason `timeout`) → email admin + client |
| `consultant-reminder` | every 15 min | `pending_acceptance` at 24h mark → reminder email to consultant (once, tracked via jsonb flag or sent-window logic) |
| `session-reminder` | every 15 min | `confirmed` starting within 24h / 1h → reminder emails (client + consultant) |

All jobs use job-ID-based dedup where a single-fire per consultation matters.

---

## 6. Email map (Mandrill — originally specified as Resend — `consultations@makehijrah.com`)

| Trigger | To |
|---|---|
| Payment authorized (webhook) | client ("authorized, not charged yet"), consultant ("new booking to accept") |
| Consultant accepted (accept endpoint) | client (Meet link + `.ics` attachment — replaces Google invite), consultant (confirmation) |
| Consultant declined / 48h timeout | client ("no charge made"), admin |
| 24h consultant reminder | consultant |
| Session reminders | client + consultant |
| Recommendation sent | client |

Templates are plain HTML in the orchestrator repo. No template service in MVP.

---

## 7. Resolved decisions (locked by Dave)

1. **Google Calendar privacy:** client is never an attendee; consultant's event carries internal reference only; client gets Meet link + `.ics` via Mandrill. (Applied in §2.)
2. **`/complete`:** consultant or admin, only after `scheduled_end_at`. (Applied in §2.)
3. **Accept ordering:** capture first, calendar second; Google failure post-capture → `admin_attention`, no auto-refund. Approved.
4. ~~**Price:** staging placeholder `DEFAULT_CONSULTATION_PRICE_CENTS=15000` ($150 USD).~~ **Superseded by PROJECT_LOCK Amendment 007 (migration 025).** The price is now `app_settings.consultation_price_cents`, admin-managed and seeded at the same `15000`. The environment variable is retained only as the migration seed and a bootstrap fallback.
5. **Reminders:** 24h consultant acceptance reminder; 24h + 1h session reminders. Approved as proposed.

**Contract status: FROZEN v1.0, plus Amendments 004, 005, 006 and 007.** Any new endpoint requires Dave's written approval and a version bump of this document.

Endpoint additions since v1.0, each authorised by an approved amendment:

| Section | Endpoints | Amendment |
|---|---|---|
| §3a | five admin service catalog endpoints | 004 |
| §2a | `POST /api/messages/:id/notification` | 005, 006 |
| §3b | four application settings endpoints | 007 |

No other endpoint has been added. No existing endpoint changed behaviour, except the non-consultation acknowledgement on `POST /api/webhooks/stripe` described in §1, and the price/duration/Stripe-mode sourcing described in §1 and §3b.

**Amendment 007 endpoints are live** and documented in §3b. Amendment 005/006 added `POST /api/messages/:id/notification`, documented in §2a.
