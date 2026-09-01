# PROJECT_LOCK Amendment 015 — The consultant's "new booking to accept" email

**Status:** Approved
**Implemented by:** the orchestrator commit accompanying this file. **No migration.**
**Relationship to the frozen finance baseline:** **nothing in the finance path changes.** No ledger row, split, snapshot, payout or refund behaviour is touched, and no finance RPC is called, altered or reordered.

---

## 1. What this is, and why it is a patch rather than new scope

`API_CONTRACT.md` section 6 has specified this since the contract was written:

| Trigger | To |
|---|---|
| Payment authorized (webhook) | client ("authorized, not charged yet"), **consultant ("new booking to accept")** |

**It was never built.** An audit of the webhook path found that it scheduled no notification of any kind. A consultant learned about a new booking only by opening their dashboard, while a 48-hour acceptance window ran down and the authorization expired on its own if they did not.

That is a delivered-behaviour gap against the contract, not a new feature, and it is fixed here as a v1.0.x production patch under section 13's standing constraints.

**The client half of the same row is still unbuilt.** It was deliberately excluded from this task's approved scope. Section 5 records it as an outstanding gap so the omission is visible rather than assumed complete.

## 2. When the email is sent

**At payment authorization** — `payment_intent.amount_capturable_updated` carrying a `consultation_id` — which is what the contract specifies and the first moment a real commitment exists.

**Deliberately not at draft creation.** A draft holds a slot for thirty minutes and most expire unpaid (migration 047). Emailing then would tell consultants about bookings that mostly evaporate, and would train them to ignore the email that matters.

## 3. Why a worker, and not the webhook itself

**The webhook path may not touch a table.** Amendment 004 section 10.3.3 restricts it to RPC calls, and `stripe-webhook.test.ts` enforces this by replacing `supabaseAdmin.from` with a stub that throws on any direct table access.

So the webhook does one thing — schedule, in Redis, with no database read at all — and every lookup the email needs happens later, in `booking-notification.worker.ts`. This is the established shape of every other notification in the codebase (`decline-notification`, `authorization-timeout-notification`, `message-notification`): a Redis due set, a per-consultation lock, a ten-second poll, and a sixty-second retry backoff.

It also means a Mandrill outage cannot affect a payment. The scheduling call is wrapped and swallowed exactly like the ledger side effects beside it: a non-2xx returned to Stripe would trigger redelivery and re-run the payment transition, which is far worse than a delayed email.

## 4. Idempotency — the property that matters most

**Stripe redelivers.** Without a marker, every redelivery of the same authorization would email the consultant again.

`booking-notification:done:<id>` is that marker, checked **both** when scheduling and when processing, with a thirty-day TTL. The payload and the due-set entry are both written `NX`, so a redelivery arriving before the worker has run leaves the original queue position alone rather than pushing the notification further out.

**No migration, and no marker column on `consultations`.** Redis already holds this state for every other notification in the system, the marker is disposable operational state rather than a business fact, and adding a column would have meant a table write from a path that is not allowed to make one. The consequence is honest: if Redis loses the key within thirty days *and* Stripe redelivers the same event, the consultant is emailed twice. That is strictly better than the alternative failure, which is never emailing them at all.

### Suppression is also permanent

Between the webhook scheduling the job and the worker running it, the consultant may have already accepted or declined, or the authorization may have been cancelled. The worker sends only while the status is `payment_authorized` or `pending_acceptance`; anything else is **dropped and marked done**, so a later redelivery cannot revive it. An email telling a consultant to accept something they already accepted is worse than no email.

## 5. What this does not do

- **No client email.** The other half of the same contract row — client "authorized, not charged yet" — remains unbuilt, along with the acceptance, 24-hour reminder and session reminder rows of section 6. Three of the map's six rows are implemented.
- **No migration, no new table, column, status, route or endpoint.**
- **No change to any payment transition, RPC, or finance behaviour.**
- **No frontend.**
