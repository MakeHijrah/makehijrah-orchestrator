# PROJECT_LOCK Amendment 009 — Service purchase finance reconciliation

**Status:** Approved
**Supersedes:** API_CONTRACT.md §3a, *"Purchases are not recorded here"*
**Implemented by:** migration 040, orchestrator commit accompanying this file

---

## 1. What this amendment changes

Amendment 004 §10 established that a service Payment Link purchase creates **no row in any MakeHijrah table**, and that **Stripe is the temporary source of truth** for service purchases, subscriptions and refunds. It stated in terms that "reconciliation into the database is out of scope and requires its own amendment."

This is that amendment. Service purchases are now financially reconciled into MakeHijrah. Stripe remains the payment processor and the authority on whether money moved; it is no longer the record of what was sold, to whom, by whose recommendation, or what a consultant is owed for it.

**Why this was necessary rather than merely desirable.** The locked business rules already said a consultant earns commission on services they recommend, and that a recurring service earns on every renewal. Neither rule could be honoured: a consultant could recommend a service, an admin could send it, a client could buy it, and the consultant earned nothing — because nothing in this system ever learned the sale happened. `services.consultant_commission_bps` had existed since migration 034 with no code that could set it and no code that could read it.

## 2. What is now recorded

`public.service_purchases` (migration 034, unused until now) becomes the financial transaction record for every service sale:

- **One-time purchase** — one row, created on `checkout.session.completed`.
- **Recurring subscription** — one row per successful invoice, created on `invoice.paid`, distinguished by `billing_period_sequence` and by its own Stripe invoice id. The original row is never overwritten.
- **Consultant commission** — a pending `consultant_ledger_entries` earning at `services.consultant_commission_bps` of the **gross**, `source_type = 'service_purchase'`, `commission_basis = 'service_rate'`.
- **Refunds** — negative ledger entries through the existing `reverse_ledger_entry`. No historical earning is ever mutated.

`public.service_requests` is **unchanged and remains the operational workflow record.** It is not the financial source of truth, it does not release money, and completing it has no financial effect.

## 3. The rules this amendment locks

1. **A purchase is recorded only after Stripe confirms payment.** There is no pending purchase state.
2. **`checkout.session.completed` is authoritative for one-time purchases only.** A subscription-mode session creates nothing; its first invoice does.
3. **`invoice.paid` is authoritative for recurring purchases**, both the first period and every renewal.
4. **`payment_intent.succeeded` never creates a service purchase.** It continues to be acknowledged and ignored. This is what prevents a duplicate financial record for a one-time payment.
5. **`invoice.payment_failed` creates nothing.** A failed payment is not revenue.
6. **Consultant attribution is derived by the database, never supplied.** `record_service_purchase` accepts no consultant and no commission parameter. It re-derives the consultant from `service_recommendations` joined to `consultations` on every call. A consultant id present in Stripe metadata — however it got there, including metadata this orchestrator itself set — cannot influence who is credited.
7. **A purchase that cannot be attributed is still recorded**, with `attributed_consultant_id` null and no ledger entry. Unattributed revenue is visible to an admin; it is never discarded.
8. **Payment creates a pending earning. Only fulfilment releases it.** The authoritative finance fulfilment fact is `service_purchases.fulfilled_at`, set by `fulfill_service_purchase` through an admin endpoint — **not** `service_requests.status = 'completed'`, which an ordinary browser write can move.
9. **Every renewal is fulfilled individually.** Paying for a month does not deliver it.
10. **Commission is integer arithmetic on the gross**, `round(gross::numeric * bps / 10000)`, with the platform taking the remainder by subtraction. No floating-point money math anywhere.
11. **Currencies remain separate. No FX conversion.**
12. **A null or zero commission rate creates no ledger entry at all** — not a zero-value one. The purchase and its attribution are still recorded.

## 4. What is still explicitly out of scope

- **No Stripe Connect.** Consultants are still paid manually.
- **No automated payouts.** The manual payout flow of migrations 034–039 is untouched.
- **No commission calculation change.** Consultation commission is unchanged; service commission uses the per-service rate that migration 034 defined.
- **No new purchase table**, no new purchase status value, no change to any existing RLS policy, trigger or grant.
- **No backfill.** Service payments taken before migration 040 exist only in Stripe. This amendment is forward-only; reconciling history is a separate exercise.

## 5. New API surface

| Endpoint | Role | Purpose |
|---|---|---|
| `POST /api/services/:id/checkout` | client | Creates a Checkout Session with server-resolved trusted context. The body carries no attribution fields of any kind. |
| `POST /api/admin/service-purchases/:id/fulfill` | admin | The financial fulfilment act; releases the pending earning. Idempotent. |

`POST`/`PATCH /api/admin/services` additionally accept `consultant_commission_bps` (integer, 0–10000, nullable). It is not a Stripe identifier and is not server-owned; it is the one commercial term about a service that only an administrator can decide, and before this there was no way to set it.

**Static Stripe Payment Links continue to operate.** A purchase through one is resolved via `services.stripe_payment_link_id` — a database lookup, never Payment Link metadata — and is recorded unattributed when no client can be resolved.

## 6. Amendment 004 §10.3.3 is reaffirmed, not relaxed

The Stripe webhook path still makes **RPC calls only** and reads no table directly. Every lookup this feature needs — the service behind a payment link or price, the subscription's prior purchase, the purchase behind a refunded PaymentIntent — happens inside a `SECURITY DEFINER` function. The webhook test enforces this by making any direct table access from that path throw.

## 7. Verification

`MIGRATION_040_VERIFICATION.sql` proves 31 properties against PostgreSQL 16, including the commission arithmetic, the odd-minor rounding rule, attribution that cannot be spoofed, pending-then-released availability, renewal sequencing under an advisory lock, refund proportionality and over-refund refusal, multi-currency separation, and that migrations 034, 038 and 039 protections remain intact. 34 orchestrator tests cover the event selection rules and the two new endpoints.
