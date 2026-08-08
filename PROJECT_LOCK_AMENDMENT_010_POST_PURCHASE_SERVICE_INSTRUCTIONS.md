# PROJECT_LOCK Amendment 010 — Post-purchase service instructions

**Status:** Approved
**Implemented by:** migration 042, orchestrator commit accompanying this file
**Relationship to Amendment 009:** independent. 009 reconciled service purchases into MakeHijrah finance; this amendment governs what a client is shown *after* paying. Neither changes the other's rules.

---

## 1. What this amendment adds

A client who bought a consultant-recommended service was redirected to `/dashboard?purchase=success` and told nothing further. There was nowhere in the system for an administrator to write "here is how you actually use the thing you just paid for", so delivery happened out of band or not at all.

`services.post_purchase_instructions_html` is that place. It is **private delivery content** — onboarding steps, download URLs, booking URLs, contact routes — and it is treated throughout as something a client has *bought*, not something a service *advertises*.

## 2. The rules this amendment locks

1. **A sent recommendation is not proof of payment.** An administrator sending a recommendation says "you may buy this". The instructions are the thing being sold, so association with a consultation is **necessary and never sufficient**. This is the single most important rule in the amendment.
2. **Payment is proved by exactly one of two means**, and by nothing else:
   - a recorded `service_purchases` row matching service, client **and** consultation, in status `paid`, `fulfilled` or `refunded`; or
   - a Stripe Checkout Session retrieved **server-side** and verified field by field.
3. **A refund does not retract delivery access.** A refund reverses money and is recorded in the ledger by Amendment 009; it does not retract the fact that the client was once entitled to read what they bought. Changing that would be a new business rule and is not made here by omission.
4. **The column is private on `public.services`** and is never granted to `anon` or `authenticated`. It is reachable by an administrator through `public.admin_services` and by a client only through the endpoint in §4.
5. **Rich text is stored only after sanitization**, against a strict allowlist, and is **sanitized again on read**.
6. **A client may not supply redirect or attribution context.** The checkout body remains `{}`.
7. **`service_requests` and the finance path are untouched.** No commission rule, no purchase accounting, no ledger behaviour changes.

## 3. Sanitization

One centralized allowlist (`src/lib/html-sanitizer.ts`), used by both the admin write path and the client read path so the two cannot disagree. Delegated to `sanitize-html`; nothing about HTML parsing is hand-rolled.

- **Tags:** `p`, `br`, `strong`, `em`, `b`, `i`, `u`, `ul`, `ol`, `li`, `h2`, `h3`, `a`
- **Attributes:** `href` and `title` on `a`, and nothing on anything else
- **Schemes:** `http`, `https`, `mailto` — an allowlist, which is what rejects `javascript:`, `data:` and `vbscript:` without having to name them
- **Links are rewritten, not inspected:** `rel="noopener noreferrer nofollow"` and `target="_blank"` are forced over any author-supplied value
- `script`, `style`, `iframe`, `object`, `embed`, `form`, event handlers and every unlisted attribute are **discarded**, not escaped
- Content that sanitizes away to nothing is stored as **null** — "cleared the field" and "wrote only a `<script>` tag" are one state, not two

Sanitizing on read is not redundant. It is the only thing covering a row edited directly in the Supabase SQL editor, which never passes through the admin endpoints.

## 4. New and changed API surface

| Endpoint | Role | Change |
|---|---|---|
| `GET /api/consultations/:consultationId/services/:serviceId/instructions` | client | **New.** Returns exactly `service_id`, `service_name`, `post_purchase_instructions_html`. Optional `?session_id=`. |
| `POST`/`PATCH /api/admin/services` | admin | Accept `post_purchase_instructions_html` (nullable; ~50,000 raw, 20,000 stored after sanitization). |
| `POST /api/services/:id/checkout` | client | Attributed purchases now return to the consultation. Body still `{}`. |

Every refusal from the instructions endpoint is the **same 404**. "No such service", "not your consultation" and "you did not pay" are indistinguishable, because the difference between those answers is itself information.

## 5. Checkout redirects

Attributed (a sent recommendation resolved server-side):

```
success: {APP_URL}/dashboard/consultation/{consultation_id}?purchase=success&service={service_id}&session_id={CHECKOUT_SESSION_ID}
cancel:  {APP_URL}/dashboard/consultation/{consultation_id}?purchase=cancelled
```

`{CHECKOUT_SESSION_ID}` is **Stripe's literal placeholder** and must never be percent-encoded — Stripe substitutes the real session id when it builds the redirect, and that id is what makes §6 work.

Unattributed purchases keep `{APP_URL}/dashboard?purchase=success&service={service_id}&session_id={CHECKOUT_SESSION_ID}`. **No consultation-free instructions endpoint is created by this amendment**; a generic dashboard purchase shows a generic success message until a separate delivery design is approved.

`consultation_id` and `service_id` come from server-resolved context only.

## 6. Webhook independence

The browser routinely returns from Stripe before `checkout.session.completed` has created the `service_purchases` row. The answer is **not** polling and **not** trusting the redirect: it is to ask Stripe directly.

When no purchase row exists yet, the endpoint retrieves the Checkout Session server-side and requires **all** of:

- the session exists and belongs to this Stripe account
- `livemode` matches the running environment
- `payment_status === 'paid'`
- `metadata.makehijrah_service_id` matches the requested service
- `metadata.makehijrah_client_profile_id` matches the authenticated client
- `metadata.makehijrah_consultation_id` matches the requested consultation
- `client_reference_id`, where present, matches the authenticated client

Those metadata keys are written only by `createServiceCheckoutSession`, from server-resolved values. A session created any other way carries none of them. **A session id alone proves nothing** — it is a lookup key, validated like any other client input.

## 7. Static Payment Links

Unchanged. A shared Payment Link cannot carry a per-client consultation redirect, so purchases through one keep landing on `/dashboard`. Consultant-recommended purchases go through `POST /api/services/:id/checkout`, which is also where trusted attribution lives.

## 8. Verification

`MIGRATION_042_VERIFICATION.sql` proves 13 properties against PostgreSQL 16, including that the new column is ungranted to `anon` and `authenticated` by migration 034 part E's fail-closed column list, that `admin_services` exposes both private columns and remains read-only in practice, and that migrations 034 and 038–041 are intact. 57 orchestrator tests cover the sanitizer allowlist, the admin write path, every authorization branch of the instructions endpoint, and the redirect construction.
