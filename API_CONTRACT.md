# MakeHijrah Relocation OS — API_CONTRACT.md

**Version:** 1.0 (draft for Dave's review)
**Purpose:** The complete, closed list of orchestrator endpoints. **If an endpoint is not in this document, Lovable does not call it and it does not exist.** Every Lovable prompt that touches the backend references this file.

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

Server: re-validate slot exactly as `GET /api/availability` (fresh FreeBusy, bypass cache) → insert `consultations` (status `draft`, price snapshot from env, `end_at = start + 60min`) + `consultation_intake` in one transaction → unique index is the final referee.

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
5. Emails (Resend): client receives Meet link **plus an `.ics` calendar attachment** (this replaces the Google invite); consultant receives confirmation.

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

### `POST /api/admin/recommendations/:id/send`
Guard: recommendation status `proposed`, parent consultation `completed`.
Server: status `sent`, `sent_at`, `sent_by_admin_id` (satisfies the DB check constraint) → Resend email "recommended services" to client.
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

**Banned from Lovable, permanently:** any write to `consultations`, `payments`, `oauth_connections`, `consultant_invites`, `services`; any Google or Stripe API call; any Stripe identifier in a request body, query parameter or header; any status field mutation on any table except `service_requests` (admin) and `service_recommendations` deletion of own `proposed` rows.

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

## 6. Email map (Resend, `consultations@makehijrah.com`)

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

1. **Google Calendar privacy:** client is never an attendee; consultant's event carries internal reference only; client gets Meet link + `.ics` via Resend. (Applied in §2.)
2. **`/complete`:** consultant or admin, only after `scheduled_end_at`. (Applied in §2.)
3. **Accept ordering:** capture first, calendar second; Google failure post-capture → `admin_attention`, no auto-refund. Approved.
4. **Price:** staging placeholder `DEFAULT_CONSULTATION_PRICE_CENTS=15000` ($150 USD). Owners confirm real price before Week 4; does not block Weeks 1–3.
5. **Reminders:** 24h consultant acceptance reminder; 24h + 1h session reminders. Approved as proposed.

**Contract status: FROZEN v1.0, plus Amendment 004.** Any new endpoint requires Dave's written approval and a version bump of this document. The five admin service endpoints in §3a are the only addition, authorised by PROJECT_LOCK Amendment 004 (approved). No other endpoint has been added, and no existing endpoint changed behaviour, except the non-consultation acknowledgement on `POST /api/webhooks/stripe` described in §1.
