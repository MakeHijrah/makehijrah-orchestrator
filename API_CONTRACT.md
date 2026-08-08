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

Added since v1.0 by approved amendments:

```txt
UNAUTHORIZED                     (auth layer; emitted where v1.0 wrote UNAUTHENTICATED)
INTERNAL_ERROR                   (emitted where v1.0 wrote INTERNAL)
STRIPE_MODE_NOT_CONFIGURED       Amendment 007, §3b
LIVE_MODE_CONFIRMATION_REQUIRED  Amendment 007, §3b
STRIPE_LIVEMODE_MISMATCH         Amendment 007, §1
CONSULTANT_PROFILE_INCOMPLETE    Amendment 008, §2b and §3
CONSULTANT_GENDER_IMMUTABLE      Amendment 008, §2b
CONSULTANT_COUNTRY_INVALID       Amendment 008, §2b
```

The implemented auth layer emits `UNAUTHORIZED` and `INTERNAL_ERROR`; the v1.0 spellings `UNAUTHENTICATED` and `INTERNAL` were never emitted by the orchestrator. Clients should match the implemented names.
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

## 2b. Consultant profile — consultant role

Added by PROJECT_LOCK Amendment 008, backed by `save_consultant_profile` (migration 027).

### `PUT /api/consultant/profile`

The single write path for a consultant's own profile. A save spans `profiles`, `consultants` and `consultant_countries`; the orchestrator performs it in one database transaction so a partial save is impossible.

**Authentication.** Consultant role required. The consultant is resolved server-side from the authenticated profile via the unique `consultants.profile_id`. **`consultant_id` is never accepted from the request** — the body schema is strict, so any such key is rejected as a validation error. There is no code path that reads a consultant identifier from a caller.

Rate limit: 30 / minute.

Body:
```json
{
  "mode": "draft" | "submit" | "update",
  "full_name": "string | null",
  "avatar_url": "string | null",
  "gender": "male | female | null",
  "headline": "string | null",
  "bio": "string | null",
  "timezone": "string | null",
  "minimum_booking_notice_hours": "integer | null",
  "available_for_general": "boolean | null",
  "country_ids": "uuid[] | null",
  "working_hours": "object | null"
}
```
`mode` is required. Every other field is optional. **Unknown keys are rejected.**

#### Semantics

- **Omitted or `null` preserves the stored value.** Null is never written as an empty string.
- **`draft`** — allowed **only before** onboarding completion. Permits partial data, validates whatever is supplied, does not require completeness, does not require Google, does not set the completion marker.
- **`submit`** — allowed **only before** onboarding completion. Requires the full completeness bar and sets `onboarding_completed_at` exactly once.
- **`update`** — allowed **only after** onboarding completion. Never clears or moves the marker.
- **Gender is immutable after completion.** Before completion it may be set freely. After, `null` is ignored and the stored value is tolerated; any different value is rejected. This keys on the completion marker, not on `is_active`, so a deactivated consultant stays locked.
- **`country_ids: null` preserves** assignments; **`[]` removes all**. The two are distinguished by null, never by length. Duplicates are collapsed. Every identifier must exist and be active.
- **`submit` requires a Google Calendar connection.**
- **Updates after completion do not require a healthy Google connection** — see §9 below.
- **An active consultant's update must leave the profile structurally complete.** It is rejected before the write if it would not.

Completeness is always evaluated against the **merged final state** — stored values with the request's non-null fields applied — never against the request alone.

#### Success

```json
{
  "ok": true,
  "data": {
    "consultant": {
      "id": "uuid",
      "profile_id": "uuid",
      "full_name": "…",
      "avatar_url": "…",
      "gender": "male | female | null",
      "headline": "…",
      "bio": "…",
      "timezone": "Africa/Cairo",
      "minimum_booking_notice_hours": 24,
      "available_for_general": true,
      "country_ids": ["uuid"],
      "working_hours": { "monday": [{ "start": "09:00", "end": "17:00" }] },
      "onboarding_completed_at": "2026-08-03T00:00:00Z | null"
    }
  }
}
```

The consultant object is **re-read after the save**, so it is the authoritative persisted state rather than an echo of the request. `working_hours` is returned normalised: lowercase weekday keys, intervals sorted, empty days omitted.

`full_name` and `avatar_url` are the **authoritative** `profiles` values. Their public projections on `consultants` — `display_name` (migration 030) and `photo_url` (migration 028) — are deliberately **not** part of this response: the RPC writes each projection atomically with its source, so returning both would add a second copy of the same value with no way for them to differ, and any difference the client did observe would be a bug rather than information. Cross-user and public consultant surfaces read `consultants.display_name` directly, without reading `profiles`; no orchestrator endpoint exposes it, and none is required.

#### Errors

| Code | Status | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | missing or invalid token |
| `FORBIDDEN` | 403 | authenticated but not a consultant |
| `VALIDATION_ERROR` | 400 | unknown key, bad enum, malformed working hours, invalid timezone, out-of-range notice. `details.issues` lists **every** problem |
| `NOT_FOUND` | 404 | the authenticated account has no consultant row |
| `CONSULTANT_PROFILE_INCOMPLETE` | 409 | `details.missing` lists **every** unmet requirement |
| `CONSULTANT_GENDER_IMMUTABLE` | 409 | attempt to change gender after completion |
| `CONSULTANT_COUNTRY_INVALID` | 409 | a supplied country does not exist or is not active |
| `INVALID_TRANSITION` | 409 | mode is wrong for the current onboarding state; `details.reason` carries the specific cause |
| `INTERNAL_ERROR` | 500 | generic; details logged server-side only |

**No PostgreSQL text is ever part of this contract.** The database raises internal markers, and the orchestrator maps each to the codes above. Raw exception prose, SQLSTATE values and relation names never reach a client.

#### Working hours

**The wire format is named weekdays, in both directions.** An object keyed by lowercase weekday (`monday`…`sunday`). Each value is an array of `{ "start": "HH:MM", "end": "HH:MM" }` in 24-hour form.

**Database storage is numeric** (`"0"`–`"6"`, `0` = sunday), which is an internal detail the HTTP contract never exposes. Named-to-numeric conversion happens inside `save_consultant_profile`; numeric-to-named happens in the orchestrator response mapper (Amendment 008 §8a, migration 029). Clients send and receive named keys only — **numeric keys in a request are rejected with `VALIDATION_ERROR`**, and a response never contains one. `end` must be after `start`. Intervals on the same day must not overlap; touching intervals (`09:00–10:00` then `10:00–11:00`) are allowed. Not every weekday is required. Every problem is reported at once.

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

~~Guard for activate: consultant has timezone, working hours non-empty, and OAuth connected — else `409` with which precondition failed in `data.missing[]`.~~ **Superseded by PROJECT_LOCK Amendment 008** (orchestrator commit `59637eb`).

**Activation now applies the same completeness evaluator a consultant must satisfy to submit their profile.** One shared implementation serves consultant submission, active-consultant updates and admin activation, so activation can never disagree with submission about what a complete profile is. Previously it checked only timezone, working hours and Google, which meant a consultant could be activated with no avatar, no headline, no bio and no way to be booked.

Activation requires **all** of: onboarding completed; avatar; full name; gender; headline; bio; a valid IANA timezone; a minimum booking notice within range; booking capability (at least one active country **or** `available_for_general`); non-empty valid working hours; and an active Google Calendar connection.

**Breaking change.** The failure code is now `CONSULTANT_PROFILE_INCOMPLETE`, not `ACTIVATION_BLOCKED`:

```json
{
  "ok": false,
  "error": {
    "code": "CONSULTANT_PROFILE_INCOMPLETE",
    "message": "The consultant profile is incomplete.",
    "details": {
      "missing": ["onboarding_completed", "avatar", "bio"]
    }
  }
}
```

`details.missing` lists **every** unmet requirement in one response, never just the first. The identifiers the implementation can return are exactly:

```txt
onboarding_completed          avatar
full_name                     gender
headline                      bio
timezone                      minimum_booking_notice_hours
booking_capability            working_hours
google_calendar
```

`onboarding_completed` is returned only by activation. The other ten are shared with `PUT /api/consultant/profile` (§2b).

> **Reserved but not currently emitted.** PROJECT_LOCK Amendment 008 §13.2 also reserves `country_ids` and `gender_immutable`. The implementation reaches neither: an unusable country set surfaces as `booking_capability`, and a gender-change attempt returns the dedicated `CONSULTANT_GENDER_IMMUTABLE` code rather than a completeness identifier. Clients should tolerate them but must not depend on them.

**Google requirement.** An active Google Calendar connection is required for activation and for a consultant's initial profile submission. It is **not** required for an already-completed consultant's profile update — see §2b and Amendment 003. `deactivate` has no completeness requirement.

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

### ~~Purchases are not recorded here~~ — **Superseded by PROJECT_LOCK Amendment 009 (migration 040)**

~~A service Payment Link purchase creates no row in any MakeHijrah table… Stripe is the temporary source of truth… Reconciliation into the database is out of scope and requires its own amendment.~~

**Service purchases are now reconciled into the database.** See §3c. Stripe remains the payment processor and the authority on whether money moved; it is no longer the record of what was sold, to whom, on whose recommendation, or what a consultant is owed. `payments` is still **not** written for service purchases — that table remains the consultation payment log — and `service_requests` remains the operational workflow record, created by an admin as before.

`payment_intent.succeeded` **still** produces `{ "ignored": true, "reason": "non_consultation_event" }` for a service payment. That is deliberate and load-bearing: a one-time service payment emits both it and `checkout.session.completed`, and only the latter creates a purchase. Acting on both would produce two financial records for one payment.

### Post-purchase instructions on a service — Amendment 010, migration 042

`POST`/`PATCH /api/admin/services` also accept:

```json
{ "post_purchase_instructions_html": "<p>Book your onboarding call <a href=\"https://…\">here</a>.</p>" }
```

**Private delivery content** — onboarding steps, download URLs, booking URLs, contact routes — shown to a client only after they have paid. Nullable; `undefined` leaves it unchanged, `null` clears it. Raw payloads above ~50,000 characters are refused; the value is **sanitized before storage** and the sanitized result must be ≤ 20,000 characters.

Sanitization uses one strict allowlist: tags `p br strong em b i u ul ol li h2 h3 a`; attributes `href` and `title` on `a` only; schemes `http https mailto`. Every surviving link is rewritten with `rel="noopener noreferrer nofollow" target="_blank"`, overwriting anything the author supplied. `script`, `style`, `iframe`, `object`, `embed`, `form`, event handlers and `javascript:`/`data:`/`vbscript:` URLs are discarded. Content that sanitizes away to nothing is stored as `null`.

The admin projection returns the stored, already-sanitized HTML so a WYSIWYG editor can round-trip it. The column is **never** granted on `public.services` to `anon` or `authenticated`; an admin reads it through `admin_services`, a client through §3d.

### Commission rate on a service

`POST /api/admin/services` and `PATCH /api/admin/services/:id` additionally accept:

```json
{ "consultant_commission_bps": 4500 }
```

Integer basis points of the **gross** amount charged, `0`–`10000`, nullable. `null` means no rate has been agreed; `0` means an agreed zero. Both produce no consultant earning, but only one of them is a decision. It is **not** a Stripe identifier and **not** server-owned — it is the one commercial term about a service that only an administrator can set, and before migration 040 there was no way to set it at all. It is returned in the admin service projection and remains hidden from clients by the column privilege migration 034 established.

---

## 3c. Service purchases and consultant commission — Amendment 009, migration 040

### `POST /api/services/:id/checkout` — client

Rate limit: 20 / minute. Body: **`{}`**. There is deliberately no body schema beyond the empty object — `consultant_id`, `attributed_consultant_id`, `commission_bps`, `service_request_id` and `consultation_id` are not merely rejected, there is no field in which any of them could be sent.

The purchasing client comes from the bearer token. The server resolves the applicable `service_request`, the latest **sent** `service_recommendation` for this service and client, its `consultation_id` and its `recommended_by_consultant_id`, and stamps that trusted context into Stripe metadata — on `subscription_data.metadata` too for a recurring service, so a renewal invoice a year later can still resolve its context.

Creates `mode: "payment"` for a one-time service and `mode: "subscription"` for a recurring one. Ordinary Stripe behaviour, never manual capture.

Response `data`: `{ "checkout_url", "session_id", "mode", "attributed" }`. `attributed` says whether a consultant will be credited; it names no consultant.

Errors: `404 NOT_FOUND` (unknown or inactive service), `409 INVALID_TRANSITION` (service not yet priced in Stripe), `502 STRIPE_ERROR`, `401`/`403`. Consultants and admins are refused — buying a service is the client's own act.

**Existing static Payment Links keep working.** A purchase through one is resolved against `services.stripe_payment_link_id` — a database lookup, never Payment Link metadata — and is recorded **unattributed** when no client resolves. Unattributed revenue is recorded and visible, never discarded.

### `POST /api/admin/service-purchases/:id/fulfill` — admin

The financial fulfilment act, and the only thing that turns a service earning from pending into available. Body `{}`.

Response `data`: `{ "purchase_id", "status", "fulfilled_at", "released", "reason", "entry_id", "available_at" }`. `reason` is `released` | `already_fulfilled` | `already_available` | `no_entry`, so a double-clicked button reads as `already_fulfilled` rather than as a silent success.

**`service_purchases.fulfilled_at` is authoritative, not `service_requests.status = 'completed'`.** The two are separate on purpose: the request is the operational record an admin drives directly through RLS, and a status an ordinary browser write can move must never be the thing that releases money. Each renewal of a recurring service is fulfilled individually.

Errors: `404 NOT_FOUND`, `409 INVALID_TRANSITION` (only a paid purchase may be fulfilled), `403 FORBIDDEN`.

### Stripe events

| Event | Authoritative for | Guard |
|---|---|---|
| `checkout.session.completed` | one-time purchase + pending earning | `mode = payment` **and** `payment_status = paid` |
| `invoice.paid` | recurring purchase + pending earning, first period **and** every renewal | `billing_reason` ∈ `subscription_create`, `subscription_cycle` |
| `invoice.payment_failed` | nothing — logged and ignored | — |
| `charge.refunded` | reversal, if the charge belongs to a service purchase; otherwise the consultation path handles it unchanged | — |

A subscription-mode `checkout.session.completed` creates **nothing**; its first invoice does. The webhook response gains `service_purchase_action` and `service_purchase_id`, both `null` on every consultation event.

**Amendment 004 §10.3.3 is reaffirmed:** the webhook path still makes RPC calls only and reads no table directly. Every lookup — service by payment link or price, the subscription's prior purchase, the purchase behind a refunded PaymentIntent — happens inside a `SECURITY DEFINER` function.

---

## 3d. Post-purchase service instructions — Amendment 010, migration 042

### `GET /api/consultations/:consultationId/services/:serviceId/instructions` — client

Rate limit: 60 / minute. Optional query: `session_id=<Stripe Checkout Session id>`.

Response `data` — **exactly these three fields**:

```json
{ "service_id": "…", "service_name": "Visa Pack", "post_purchase_instructions_html": "<p>…</p>" }
```

No price, no Stripe identifier, no commission, no purchase, no consultant. `post_purchase_instructions_html` is `null` when the admin has written none — a `200`, not a `404`.

**Authorization.** All of:

1. authenticated role `client` — consultants and admins are refused (an admin reads `admin_services`);
2. `consultations.client_profile_id` is the caller's own profile;
3. the service is associated with that consultation, through a **sent** recommendation **or** a recorded purchase;
4. **and payment is proved**, by either
   - a `service_purchases` row matching service, client **and** consultation in status `paid`, `fulfilled` or `refunded`; or
   - a Checkout Session named by `session_id`, retrieved **server-side** and verified: it exists, `livemode` matches the environment, `payment_status = 'paid'`, and its `makehijrah_service_id`, `makehijrah_client_profile_id` and `makehijrah_consultation_id` metadata all match the request. Those keys are written only by `POST /api/services/:id/checkout`.

**A sent recommendation alone does NOT reveal instructions.** An admin offering a service is not the client having bought it.

Every refusal is the **same `404 NOT_FOUND`**. Unknown service, unknown consultation, another client's consultation, unrelated service and unpaid all return identically; the difference between those answers is itself information. A malformed `session_id` is ignored rather than rejected, so a junk query string degrades to "no session supplied".

**Webhook independence.** The browser routinely returns from Stripe before `checkout.session.completed` has written the purchase row. The Checkout Session path exists precisely for that window — there is no polling, and the redirect itself is never treated as proof.

### `POST /api/admin/service-purchases/:id/refund` — admin, Amendment 009 + migration 043

Rate limit: 30 / minute. Strict discriminated union — unknown keys are a `400`:

```json
{ "type": "full" }
{ "type": "partial", "amount_minor": 500 }
```

`amount_minor` is an **integer in minor units**. No decimal or floating-point currency value crosses this boundary; converting `"5.00"` to `500` is the caller's job and must be done by string manipulation, never `Math.round(value * 100)`.

**The request carries no trusted value.** `payment_intent_id`, `charge_id`, `stripe_invoice_id`, `client_profile_id`, `consultant_id`, `service_id`, `currency`, commission, platform or ledger amounts, a success URL and arbitrary metadata all have **no field to be sent in**. Everything is resolved from the purchase by id: the PaymentIntent, the Stripe mode, the gross, the amount already refunded, the service and the client.

`type: "full"` refunds exactly `gross_amount_minor − refunded_amount_minor` — the **remaining** balance, not the gross.

**This endpoint INITIATES a refund and records no accounting.** It does not move `refunded_amount_minor`, does not set a status, creates no ledger reversal and calls no finance RPC. **`charge.refunded` remains the sole financial recorder.** The one permitted local write is described below.

**Stripe mode** is taken from the purchase's own `stripe_mode`, never the current global mode — the rule Amendment 007 locked for consultations, for the same reason.

**PaymentIntent resolution, and the repair.** A one-time purchase stores its PaymentIntent. A subscription invoice may not, because migration 040 reads it from `invoice.payments`, an expandable list that can be absent from the webhook payload. When it is null and `stripe_invoice_id` exists, the endpoint calls `stripe.invoicePayments.list({ invoice })`, takes the first row whose own `invoice` matches and whose `payment.type` is `payment_intent`, and **persists that PaymentIntent onto the purchase before creating the refund**. This is metadata repair, not financial state: the later `charge.refunded` webhook finds the purchase *by* PaymentIntent, so refunding without the repair would return money to the client with no reversal recorded against the consultant. If neither source resolves, the endpoint returns `409` and **never calls `refunds.create`**.

**Idempotency.** Key `service-refund-{purchaseId}-{amountMinor}-{refundedSoFarMinor}`, plus a short-lived Redis in-flight claim. Two identical submissions before the webhook lands produce **one** Stripe refund; a deliberate second refund of the same amount after the webhook has moved `refunded_amount_minor` gets a different key and goes through.

Response — submission information only, with **no local status**:

```json
{ "purchase_id": "…", "refund_submitted": true,
  "amount_minor": 500, "currency": "usd", "stripe_refund_id": "re_…" }
```

Errors: `404 NOT_FOUND`; `409 INVALID_TRANSITION` (cancelled, already fully refunded, amount above remaining, unresolvable payment reference); `409 STRIPE_MODE_NOT_CONFIGURED`; `409 CONFLICT` (a submission is already in flight); `502 STRIPE_ERROR` — **nothing local is mutated on failure**; `403`/`401`.

> **Refunding a recurring purchase refunds that invoice period only.** It does **not** cancel the Stripe subscription, stop future billing, or change subscription status. The refund dialog must say so: *"Refunding this payment does not cancel recurring billing."* Subscription cancellation is not part of this system.

### Cumulative refund semantics — migration 043

`charge.refunded` carries `charge.amount_refunded`, which is **cumulative**: the total refunded on that charge to date, not the amount of the refund that just happened. The webhook passes it as a **total**, and `reverse_service_purchase_earning` computes `delta = total − refunded_amount_minor` itself, reversing only the delta.

That makes refund processing idempotent by construction: a redelivered event applies nothing, a second partial reverses only its own share, and partial-then-full completes correctly. Migration 040 treated the figure as a delta, which double-counted redeliveries, over-reversed a consultant's ledger on a second partial, and silently dropped a partial-then-full. Status reaches `refunded` only when the cumulative total reaches the gross.

### `GET /api/me/service-purchases` — client

Rate limit: 60 / minute. No path parameter, no query, no body — `me` is the entire parameter surface, so a client cannot ask for anybody else's purchases and there is no field a later edit could start trusting. The caller's `client_profile_id` is resolved from the bearer token.

Response `data.purchases[]`, newest first, **exactly these eleven fields**:

```json
{
  "id": "…", "service_id": "…", "service_name": "Visa Pack",
  "consultation_id": "… | null",
  "status": "paid | fulfilled | refunded | cancelled",
  "gross_amount_minor": 9999, "currency": "usd",
  "purchased_at": "2026-08-01T10:00:00.000Z",
  "billing_type": "one_time | recurring",
  "recurring_interval": "month | year | null",
  "billing_period_sequence": 1
}
```

`service_name` is the service's **current** name, resolved in a **single batched read** of `services` selecting only `id, name` — never one query per purchase, and the id list is de-duplicated so a subscription's many renewal rows ask once. Read with the service role, so a **deactivated** service still names itself: withdrawing a catalogue entry must not take away the name of something already bought. No other service field travels through this endpoint — not the description, price, Stripe identifiers, commission rate or post-purchase instructions.

**Never returned:** `attributed_consultant_id`, `refunded_amount_minor`, any `stripe_*` identifier, `stripe_mode`, `service_request_id`, `client_profile_id`, or any ledger, commission, platform-revenue or payout data. The projection is an explicit column list, so a column added to `service_purchases` later is invisible here until somebody deliberately adds it.

**`public.service_purchases` RLS is unchanged and clients remain excluded from it at the database layer.** Migration 034's policy names the attributed consultant and an admin and nobody else, and the client's exclusion is structural — no policy on any finance table mentions `client_profile_id`. This endpoint reads with the service role; **the frontend must never query `service_purchases` from Supabase directly.**

Client only. A consultant and an admin already read that table through RLS and are refused here (`403`). Capped at 200 rows, newest first — roughly sixteen years of monthly renewals.

### Checkout redirects

`POST /api/services/:id/checkout` (body still `{}`):

| | attributed | unattributed |
|---|---|---|
| success | `{APP_URL}/dashboard/consultation/{consultation_id}?purchase=success&service={service_id}&session_id={CHECKOUT_SESSION_ID}` | `{APP_URL}/dashboard?purchase=success&service={service_id}&session_id={CHECKOUT_SESSION_ID}` |
| cancel | `{APP_URL}/dashboard/consultation/{consultation_id}?purchase=cancelled` | `{APP_URL}/dashboard?purchase=cancelled` |

`{CHECKOUT_SESSION_ID}` is **Stripe's literal placeholder** and is never percent-encoded; Stripe substitutes the real id. `consultation_id` and `service_id` come from server-resolved context only — `success_url`, `cancel_url`, `consultation_id`, `client_profile_id`, `consultant_id` and `service_request_id` have nowhere to be sent in the request body.

Generic dashboard purchases show only a generic success message; **no consultation-free instructions endpoint exists**, pending a separate delivery design.

---

### What Lovable reads

`service_purchases` is readable under the existing migration 034 policy: the **attributed consultant** sees their own, an **admin** sees all, a **client** sees none. Admin finance can therefore render service, client, consultant, gross, commission (from `consultant_ledger_entries`), currency, status, `fulfilled_at`, Stripe reference, `billing_period_sequence`, `refunded_amount_minor` and unattributed purchases with no new read endpoint.

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
admin_services (admin only)                      → admin service catalog
service_requests (own / admin)                   → dashboards
messages (participant)                           → consultation room, 30s polling
profiles (own)                                   → account settings
consultant_payout_settings (own / admin)         → payout method section, admin finance
```

**`consultant_payout_settings` is the one finance table Lovable writes (migration 039).** A consultant reads, inserts and updates **their own** row — that is the Payout Method section of the consultant profile — and an admin reads every row, which is the "Current payout method" line on Consultant Finance Detail. A client and an anonymous visitor get nothing: `anon` holds no privilege on the table at all, and every policy scopes through `my_consultant_id()`, which is null for a client. Upsert on the `consultant_id` primary key; do **not** send a `consultant_id` belonging to anyone else, because the `INSERT` policy's `WITH CHECK` overrules it rather than trusting it. `payout_method` is `'paypal'` or `'wise'`; `payout_email` is required whenever a method is set. There is no `DELETE` — clearing a method is an update to null. No other finance table is writable from the browser.

**`POST /api/consultant/payouts` no longer accepts `destination_note` (migration 039).** The destination is read from the consultant's saved payout setting inside the RPC and snapshotted onto `payouts.destination_note`, so the payout request body is `{ currency }` and nothing else; a `destination_note` still sent is ignored, not stored. The response now includes `destination_note` (`"PayPal | consultant@example.com"`). A consultant with no complete payout method is refused `409 PAYOUT_METHOD_MISSING` — the Request Payout dialog should read the setting first and disable the button, treating the 409 as the backstop for a stale page. Admin payout screens read the **snapshot** on the payout row, never the consultant's current setting: the two are labelled separately because a consultant may change their address after a payout was requested.

**One admin RPC is also callable directly (migration 038).** `rpc('get_admin_finance_kpis', { p_from, p_to })` returns admin finance period totals, one row per currency: `gross_revenue_minor`, `platform_revenue_minor`, `consultant_earnings_minor` (all net of reversals and adjustments), `reversals_minor`, `adjustments_minor` and `ledger_entry_count`. It exists because PostgREST aggregates are disabled and the alternative is downloading the ledger into a browser; aggregates stay disabled. `EXECUTE` is granted to `authenticated` only — `anon`, `PUBLIC` and `service_role` are revoked — and the function re-checks `is_admin()` on the calling JWT itself, so a consultant or client key is refused with `403`. It returns no ledger row, consultant id, commission rate or memo, and takes no filter parameter beyond the two period bounds. Not an orchestrator endpoint and not a general finance query API. Point-in-time balances (`available`, `reserved`, `pending`) come from `consultant_balances`, not from this call.

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

**Contract status: FROZEN v1.0, plus Amendments 004, 005, 006, 007 and 008.** Any new endpoint requires Dave's written approval and a version bump of this document.

Endpoint additions since v1.0, each authorised by an approved amendment:

| Section | Endpoints | Amendment |
|---|---|---|
| §3a | five admin service catalog endpoints | 004 |
| §2a | `POST /api/messages/:id/notification` | 005, 006 |
| §3b | four application settings endpoints | 007 |
| §2b | `PUT /api/consultant/profile` | 008 |

No other endpoint has been added. No existing endpoint changed behaviour, except the non-consultation acknowledgement on `POST /api/webhooks/stripe` described in §1, the price/duration/Stripe-mode sourcing described in §1 and §3b, and the admin activation completeness guard described in §3, which now returns `CONSULTANT_PROFILE_INCOMPLETE` in place of `ACTIVATION_BLOCKED` (Amendment 008).

**Amendment 007 endpoints are live** and documented in §3b. Amendment 005/006 added `POST /api/messages/:id/notification`, documented in §2a.
