# MakeHijrah Relocation OS v1.0

## PROJECT_LOCK Amendment 002: Frictionless Public Booking

**Status:** Approved for implementation  
**Approved by:** Project Owner  
**Date:** 2026-07-22  
**Scope:** Public consultation draft creation, Stripe Checkout initiation, and post-payment account access

This amendment supersedes conflicting authentication requirements in:

- `PROJECT_LOCK.md`
- `API_CONTRACT.md`
- `ROLE_ACCESS_MATRIX.md`
- `MakeHijrah_Relocation_OS.md`

All architecture and security rules not explicitly changed below remain locked.

---

## 1. Approved public booking flow

The public booking flow is:

1. Visitor selects destination.
2. Visitor selects consultant.
3. Visitor selects an available time.
4. Visitor submits consultation details and email.
5. Orchestrator resolves or provisions the client account internally.
6. Orchestrator creates the consultation draft and slot hold.
7. Visitor reviews the server-returned price and hold expiration.
8. Visitor starts Stripe Checkout without a prior OTP interruption.
9. Stripe authorizes payment using manual capture.
10. Stripe webhook moves the consultation to `pending_acceptance`.
11. Client proves email ownership through Supabase OTP or magic-link authentication before accessing the dashboard.

The visitor is not required to log in before draft creation or Stripe Checkout.

Account creation does not authenticate the visitor.

---

## 2. Public draft endpoint

### `POST /api/consultations/draft`

The endpoint is public.

It must:

- validate the request body
- normalize the submitted email
- resolve an existing Supabase Auth user by email or create one server-side
- never mark a newly provisioned email as confirmed
- resolve the corresponding client profile internally
- reject profiles whose role is not `client`
- freshly validate the selected slot
- create the consultation and intake atomically
- return server-controlled price and hold expiration

The browser must never send:

- `client_profile_id`
- Supabase service-role credentials
- Supabase admin credentials
- account role
- price
- currency

The response remains:

```json
{
  "consultation_id": "uuid",
  "status": "draft",
  "hold_expires_at": "UTC timestamp",
  "price_cents": 15000,
  "currency": "usd"
}
3. Secure public checkout capability

A consultation UUID is not authorization.

When a public draft is created, the orchestrator must also generate a cryptographically secure, short-lived checkout capability token.

Rules:

generate at least 32 random bytes
return the raw token to the browser once
never store the raw token
store only a SHA-256 hash in Redis
bind the Redis record to the consultation ID
set expiration equal to the draft hold expiration
permit checkout initiation once
delete or consume the capability after successful Stripe Checkout Session creation
do not log the raw token
do not place the token in a URL
do not store it in Supabase
do not add a database table or column

Redis key format:

booking-checkout:<sha256-token>

Redis value:

{
  "consultation_id": "uuid"
}

The public draft response is amended to:

{
  "consultation_id": "uuid",
  "status": "draft",
  "hold_expires_at": "UTC timestamp",
  "price_cents": 15000,
  "currency": "usd",
  "checkout_token": "one-time opaque token"
}

The browser may hold this token only in current page state.

It must not store the token in:

localStorage
sessionStorage
cookies
query parameters

Changing booking details or creating a replacement draft must discard the previous token.

4. Public checkout endpoint
POST /api/consultations/:id/checkout

The endpoint may be called by:

an authenticated client who owns the consultation, or
a public visitor presenting the valid one-time checkout capability token

Public request body:

{
  "checkout_token": "opaque one-time token"
}

Authenticated clients may submit no body when ownership is verified through their JWT.

The server must:

Load the consultation.
Confirm status is draft.
Confirm the draft has not expired.
Authorize the request through either:
authenticated consultation ownership, or
valid Redis capability bound to the same consultation ID
Use the consultation’s snapshotted price_cents and currency.
Create Stripe Checkout with manual capture.
Store the Stripe PaymentIntent ID on the consultation.
Consume the public checkout capability only after successful Checkout Session creation.
Return the Stripe-hosted checkout URL.

Response:

{
  "checkout_url": "https://checkout.stripe.com/..."
}

Errors:

UNAUTHORIZED
FORBIDDEN
DRAFT_EXPIRED
INVALID_TRANSITION
CHECKOUT_TOKEN_INVALID
STRIPE_ERROR
INTERNAL_ERROR

The endpoint must never accept a client-supplied price, currency, profile ID, PaymentIntent ID, success URL, or cancel URL.

5. Stripe rules

Stripe remains orchestrator-only.

Checkout must use:

Stripe-hosted Checkout
manual PaymentIntent capture
consultation price snapshot
consultation currency snapshot
consultation ID in Stripe metadata
client profile ID in Stripe metadata
submitted booking email as Checkout customer email
success URL controlled by the orchestrator environment
cancel URL controlled by the orchestrator environment

Success URL:

{APP_URL}/dashboard?booking=success&cid={consultation_id}

Cancel URL:

{APP_URL}/consultation?booking=cancelled&cid={consultation_id}

The success redirect is not proof of payment.

Only a verified Stripe webhook may move the consultation to:

payment_authorized
pending_acceptance
captured
authorization_cancelled
refunded

No payment capture occurs before consultant acceptance.

6. Post-payment authentication

The client account may already exist or may have been provisioned during booking.

After payment authorization:

the consultation belongs to that client profile
dashboard access still requires Supabase email OTP or magic-link authentication
RLS continues to enforce ownership
the Stripe redirect alone grants no consultation access
no session is created by the orchestrator
no password is created

The payment-authorized email may include a link to /login or the dashboard login flow.

7. Privacy and enumeration protection

Public responses must not reveal whether the submitted email already had an account.

The endpoint must not return:

Auth user ID
client profile ID
account-created boolean
email-confirmation state
role
whether the email previously existed

Errors shown to public users must remain generic.

Server logs must not contain:

checkout capability token
Stripe secret key
Supabase service-role key
raw Google tokens
8. Frontend rules

Lovable may:

call the public draft endpoint
retain the returned checkout token in current component state
display server-returned price and hold expiration
submit the consultation ID and checkout token to the checkout endpoint
redirect the browser to the returned Stripe Checkout URL

Lovable must not:

call Stripe directly
create a PaymentIntent
create a Checkout Session
calculate or submit the price
create Supabase users
write directly to consultations
store the checkout token persistently
trust the Stripe redirect as payment confirmation
9. Data-model impact
No new table.
No new Supabase column.
No new consultation status.
No direct frontend database write.
Redis stores the temporary checkout capability.
The existing stripe_payment_intent_id column remains the consultation payment reference.
The existing payments table remains the append-only Stripe event and idempotency ledger.
10. Required implementation order
Amend the draft response schema to include checkout_token.
Implement Redis checkout capability creation.
Verify invalid drafts do not generate tokens.
Verify valid public drafts return a token.
Implement Stripe Checkout service.
Implement the public/authenticated checkout authorization guard.
Implement POST /api/consultations/:id/checkout.
Test Stripe Checkout in test mode.
Implement and verify Stripe webhook signature handling.
Verify payment authorization moves the consultation to pending_acceptance.
Connect the Step 5 button in Lovable.
Verify dashboard access still requires OTP authentication.

No later step begins until the preceding verification gate passes.


This amendment preserves Stripe manual capture and the locked payment lifecycle while securing checkout for the new public flow. 

Stop after saving the amendment. The next step is adding the Redis checkout capability service to the orchestrator.