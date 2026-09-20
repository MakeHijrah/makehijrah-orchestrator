# PROJECT_LOCK Amendment 019 — Client-requested cancellation follow-up

**Status:** Approved
**Implemented by:** migration 058 (authored, **not yet applied**), orchestrator commit accompanying this file.
**Relationship to the frozen finance baseline:** none. No ledger, split, snapshot, payout or refund behaviour changes. `finalize_admin_consultation_cancel`'s refund and cancellation transition rules, and its free-text `note` handling, are byte-for-byte unchanged — the only addition is one new column and the parameter that writes it.

---

## 1. What this adds

When an admin cancels a consultation **because the client asked them to**, Make Hijrah now sends the client one friendly follow-up email asking what happened and whether there's anything the team could have done differently — with an optional, safe "book another consultation" link.

It is sent for exactly one reason, and never for any other: the admin performing the cancellation recorded, through a structured field, that the client requested it. Every other cancellation — the admin's own decision, an automated system path, a consultant decline, an authorization timeout — sends nothing.

## 2. Why this needed a migration before it could be an email

An audit preceding this amendment (conducted in plan mode, no code changed) traced every way a consultation reaches `status = 'cancelled'` and found two facts that made "just email the client when it's cancelled" the wrong, and actively harmful, design:

1. **There is no client self-service cancellation endpoint.** Every `cancelled` consultation — with a real, previously-confirmed booking — is cancelled by an admin, through `POST /api/admin/consultations/:id/cancel`. An admin cancels for many reasons: the client asked, a scheduling conflict on Make Hijrah's side, a booking made in error, a fraud or dispute resolution. None of these was distinguishable from any other before this amendment.
2. **Nothing recorded *why*.** `consultations` carried `admin_attention_reason`, a free-text field, and no structured signal at all. A follow-up asking "what happened?" fired off every `cancelled` row — the literal, simplest implementation — would have reached clients whose consultant made an error, or whose booking was cancelled for a reason that had nothing to do with their own intent. That is the opposite of the non-presumptuous tone the email is written in, and it is explicitly the failure mode this amendment exists to prevent.

So this amendment starts with a database column, not an email template.

## 3. `consultations.cancellation_source`

```sql
alter table public.consultations
  add column cancellation_source text;

alter table public.consultations
  add constraint consultations_cancellation_source_check
  check (cancellation_source is null
         or cancellation_source in ('client_requested', 'admin', 'system'));
```

Nullable, no default, no backfill. Written **only** by `finalize_admin_consultation_cancel`, through a new fourth parameter, `p_cancellation_source`, defaulted to `'admin'` at the SQL level. Never inferred from `admin_attention_reason` or from any other free text — the admin states it, structurally, as part of the same action that performs the cancellation.

**`'system'` is in the vocabulary and is written by nothing.** Two automated paths also cancel a consultation — `abandon_draft_consultation` (a visitor superseding an unpaid draft) and `expire_stale_draft_consultations` (an abandoned unpaid draft timing out, Amendment on migration 047). Both cancel a `draft`: no payment, frequently no completed intake, nothing a client would recognise as "I cancelled my booking." Migration 058 deliberately did not touch either function. `'system'` is reserved for a future amendment that decides to classify them, not asserted by this one.

**Immutable once set.** `finalize_admin_consultation_cancel` already contained two idempotent early-return branches — for an already-refunded consultation, and for a repeat non-refund cancellation of an already-cancelled one — predating this amendment. The `UPDATE` that sets `cancellation_source` reads `coalesce(consultations.cancellation_source, v_source)`, so those same branches, and the coalesce itself, mean the value the *first* successful cancellation recorded can never be overwritten by a later call, even one that supplies a different value. This is what makes `cancellation_source = 'client_requested'` a safe trigger for the email: whatever a reader sees is what actually happened at the moment of cancellation, not what the most recent API call happened to say.

## 4. Backward compatibility, made structural rather than promised

`finalize_admin_consultation_cancel`'s `RETURNS TABLE` gained a column, which PostgreSQL requires a `DROP FUNCTION` + `CREATE FUNCTION` for — `CREATE OR REPLACE` refuses a return-type change. A dropped function loses its access control list, and Supabase's ambient default privileges grant `EXECUTE` on every new function to `anon` and `authenticated` — the exact mechanism a prior migration (036, RPC execution hardening) exists to correct, and which a careless drop-and-recreate would have silently reopened here. Every grant this function already held is therefore re-asserted **by name** in migration 058, and verified directly: `has_function_privilege('anon', 'finalize_admin_consultation_cancel(...)', 'EXECUTE')` is `false` after applying.

The new parameter carries a name (`p_cancellation_source`) and a default (`'admin'`). Supabase's `.rpc()` client always calls with named arguments, so an existing caller that has not been updated simply omits the key and gets `'admin'` — never `client_requested`, never inferred, never silently different behaviour. The orchestrator's own `adminCancelConsultation` resolves the same default independently, so the two layers cannot disagree about what an old caller means.

`POST /api/admin/consultations/:id/cancel`'s request body gains one optional field, `cancellation_source`. Existing refund and note semantics are untouched.

## 5. The email

Sent from `admin-consultation-cancel.service.ts`, immediately after the cancellation has committed — never before, and a delivery failure never turns a successful cancellation into an HTTP error, matching how the existing client/consultant cancellation notifications already behave.

Recipient is `consultation_intake.email`, the address the client typed at the time of *this* booking — never `profiles.email` — matching every other client-facing consultation notification in this system. Subject and body copy match the approved brief exactly: friendly, first-name only, no urgency, no discount, no implication of fault, no internal cancellation metadata (no note, no reason, no cancellation source, no consultation identifier).

**The rebook link reuses checkout's own destination logic rather than a second implementation of it.** `buildPublicBookingDestinationUrl` (`direct-booking.slug.ts`) is the same branch `checkout.service.ts`'s cancel-and-return redirect already computes — a direct booking's consultant slug, or `/consultation` for a standard booking — extracted so the two cannot quietly disagree. Omitted from the email entirely, rather than a guessed destination, when a direct booking's consultant has no usable slug.

**Reply-To is unchanged.** This amendment does not add a Reply-To header or a new environment variable; the preceding audit could not verify the live `MANDRILL_FROM_EMAIL` value from this workspace, and the email copy is written not to depend on one.

## 6. Idempotency

One Redis delivery key per consultation, `client-cancellation-followup:delivery:<consultationId>`, 30-day TTL — the identical pattern already in production use for the admin-cancellation, booking and decline notifications. No second notification framework. An API retry, a duplicate frontend submission, an admin page refresh, or a worker restart cannot produce a second copy.

## 7. No historical backfill

Every consultation cancelled before migration 058 reads `cancellation_source = null`, permanently. The email's eligibility check requires the literal value `'client_requested'`; `null` can never satisfy it. This feature applies prospectively, to cancellations recorded after deployment, and nothing in this amendment scans, classifies, or emails about a historical row.

## 8. What this does not do

- **No client self-service cancellation endpoint.** Explicitly out of scope. Every cancellation remains an admin action; this amendment adds a way to say *why*, not a new way to *do* it.
- **No change to refund logic, transition guards, or the free-text `note` field.**
- **No widening of `abandon_draft_consultation` or `expire_stale_draft_consultations`** to write `'system'`. A later amendment's decision, not this one's.
- **No new environment variable, no new Reply-To mailbox.**
- **No backfill of any kind.**
