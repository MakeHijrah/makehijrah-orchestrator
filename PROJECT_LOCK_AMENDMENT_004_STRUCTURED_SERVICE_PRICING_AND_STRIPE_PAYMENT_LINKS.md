# PROJECT LOCK AMENDMENT 004
## Structured Service Pricing and Stripe Payment Links

| Field | Value |
|---|---|
| Amendment number | 004 |
| Title | Structured Service Pricing and Stripe Payment Links |
| Status | **APPROVED** |
| Date proposed | 2026-07-29 |
| Date approved | 2026-07-29 |
| Supersedes | The `public.services` direct-write rule in `RLS_POLICY_PLAN.md` (see section 3) |
| Amends | `PROJECT_LOCK.md`, `DATABASE_SCHEMA.md`, `API_CONTRACT.md`, `ROLE_ACCESS_MATRIX.md`, `RLS_POLICY_PLAN.md` |
| Scope | Governance only. This document authorises work. It does not perform it. |

---

## 1. Purpose

1.1 This amendment permits Make Hijrah services to carry structured, authoritative
pricing, and to be sold to clients through Stripe Payment Links that are created
and owned exclusively by the orchestrator.

1.2 It is the minimum amendment required to deliver admin service management at
`/admin/services`. It grants no capability beyond those enumerated in section 4,
section 8 and section 14.

1.3 Where this document conflicts with a prior locked document, this document
prevails from the date of approval recorded in section 21, and only for the
subjects it addresses. Every other locked rule remains in force unchanged.

---

## 2. Governance order — approval precedes implementation

2.1 No work authorised by this amendment may begin before this amendment is
approved and the approval is recorded in section 21.

2.2 In particular, **none** of the following may be performed, merged, deployed or
executed against any environment — including staging — before approval:

- 2.2.1 the Stripe webhook tolerance change described in section 10;
- 2.2.2 any schema migration adding, altering or removing columns, constraints,
  indexes, grants or RLS policies on `public.services`;
- 2.2.3 any orchestrator endpoint that mutates `public.services`;
- 2.2.4 the creation of any Stripe Product, Stripe Price or Stripe Payment Link
  representing a Make Hijrah service, in test mode or live mode.

2.3 The binding implementation order in section 18 begins at approval. No step in
that order may be reordered to precede approval.

2.4 Read-only inspection of the live schema, rows, foreign keys, grants and RLS
policies is permitted before approval and is expected during review of this
amendment. Inspection is not implementation.

---

## 3. Service mutation ownership — supersession of the direct-write rule

3.1 The locked RLS plan currently permits the `admin` role to `INSERT`, `UPDATE`
and `DELETE` rows in `public.services` directly. **That rule is superseded and
withdrawn by this amendment.**

3.2 From approval, the following are binding:

- 3.2.1 Authenticated users retain the approved `SELECT` access to
  `public.services` exactly as presently defined. Read access is not changed by
  this amendment.
- 3.2.2 **No authenticated role, including `admin`, may `INSERT`, `UPDATE` or
  `DELETE` rows in `public.services` directly.** The withdrawal of write access
  applies to the `admin` role without exception.
- 3.2.3 Every mutation of `public.services` is performed by the orchestrator using
  the Supabase service role.
- 3.2.4 The service role remains orchestrator-only. It is never present in
  frontend source, frontend environment, or any browser-delivered bundle.

3.3 Frontend code must not directly mutate any of the following, by any path,
including but not limited to the Supabase client, PostgREST, RPC, or any future
client-side data layer:

- 3.3.1 service identity fields — `name`, `description`, and any other column
  identifying the service;
- 3.3.2 structured pricing — `billing_type`, `recurring_interval`, `price_cents`,
  `currency`, `price_display`;
- 3.3.3 Stripe identifiers — `stripe_product_id`, `stripe_price_id`,
  `stripe_payment_link_id`, `stripe_payment_link_url`;
- 3.3.4 `is_active`;
- 3.3.5 deletion of any `public.services` row.

3.4 **The migration authorised by this amendment removes the direct-write RLS
policies and grants on `public.services`.** Specifically, the migration revokes
`INSERT`, `UPDATE` and `DELETE` on `public.services` from the `authenticated`
role and from any role reachable by an authenticated session, and drops or
narrows every RLS policy on `public.services` whose command is `INSERT`, `UPDATE`,
`DELETE` or `ALL` such that no authenticated session retains a write path.
Policies and grants serving `SELECT` are retained.

3.5 The migration must leave the service role's write path intact. Removal of
authenticated write access must not impair service-role access, which bypasses
RLS.

3.6 Verification that no authenticated write path to `public.services` remains is
a mandatory gate. It is step 5 of section 18 and may not be waived.

---

## 4. Permitted schema additions

4.1 The following additive columns are permitted on `public.services`:

| Column | Type | Nullability |
|---|---|---|
| `billing_type` | text | nullable |
| `recurring_interval` | text | nullable |
| `price_cents` | integer | nullable |
| `currency` | text | nullable |
| `stripe_product_id` | text | nullable |
| `stripe_price_id` | text | nullable |
| `stripe_payment_link_id` | text | nullable |
| `stripe_payment_link_url` | text | nullable |

4.2 All eight columns are nullable. Services that predate this amendment carry no
structured pricing and no Stripe resources; nullability is the correct
representation of that state and is what allows the migration to run without
fabricating data.

4.3 **No new table is created.** The locked table count is unchanged by this
amendment.

4.4 No existing column is dropped, renamed or retyped by this amendment.

4.5 Additional check constraints and unique indexes required to enforce section 5
are permitted on `public.services`.

---

## 5. Structured pricing rules

5.1 `billing_type` is constrained to exactly two values: `one_time` and
`recurring`. No third value may be introduced without a further amendment.

5.2 `recurring_interval` is constrained to exactly two values: `month` and `year`.
No third value may be introduced without a further amendment.

5.3 A service with `billing_type = 'one_time'` must have `recurring_interval`
`NULL`.

5.4 A service with `billing_type = 'recurring'` must have `recurring_interval`
equal to `month` or `year`.

5.5 `price_cents` is an integer strictly greater than zero, expressed in the minor
unit of the service's currency.

5.6 `currency` is a lowercase three-letter ISO 4217 code. **The permitted set is
initially limited to `usd`, `gbp` and `eur`.** Extending the set requires a
further amendment, because currencies without two minor-unit decimals invalidate
the `price_cents` representation and the derived display format.

5.7 A service is either fully priced or entirely unpriced. `billing_type`,
`price_cents` and `currency` are either all present or all absent. No
partially-priced state is permitted to exist in the database.

5.8 Pricing values are validated server-side by the orchestrator on every
mutation, and independently enforced by database constraints. Neither layer is a
substitute for the other.

---

## 6. `price_display`

6.1 `price_display` remains present on `public.services`. It is not dropped and
its type is not changed.

6.2 Where structured pricing exists, `price_display` is **generated server-side by
the orchestrator from the structured pricing fields** and written in the same
operation that writes those fields.

6.3 `price_display` is never accepted from a client, never computed by the
frontend, and never treated as authoritative for any purpose. It is a rendering
convenience only.

6.4 `price_display` is not a database-generated column. Currency-aware formatting
is not an immutable expression and cannot be expressed as a stored generated
column without stranding the format in schema.

6.5 Services that predate this amendment retain their existing free-text
`price_display` until an administrator supplies structured pricing for that
service. Existing consumers of `price_display`, including client-facing
recommendation email, are unaffected by the migration.

---

## 7. Stripe ownership

7.1 Stripe secret keys remain orchestrator-only. No Stripe secret key, restricted
key, or publishable key granting write capability may be present in frontend
source, frontend environment, or any browser-delivered bundle.

7.2 The frontend never calls the Stripe API directly. All Stripe operations are
performed server-side by the orchestrator.

7.3 The frontend never supplies a Stripe identifier in a request body, query
string, or header. Request validation rejects any request carrying a Stripe
identifier.

7.4 Stripe Product, Stripe Price and Stripe Payment Link resources representing
Make Hijrah services are created exclusively by the orchestrator. These three
resource families are added to the permitted Stripe surface by this amendment;
they were not previously in scope.

7.5 Every Stripe object created under this amendment carries metadata identifying
the owning service, the application, and the environment, so that orphaned
resources remain attributable.

---

## 8. Stripe resource model and lifecycle

### 8.1 Product

- 8.1.1 **One Stripe Product exists per service**, for the life of that service.
- 8.1.2 A change to the service name or description updates the existing Product
  in place. It does not create a second Product.
- 8.1.3 A Stripe Product is never deleted. On service deletion it is archived.

### 8.2 Price

- 8.2.1 **Stripe Prices are immutable.** The orchestrator never attempts to change
  the amount, currency, billing type, or recurring interval of an existing Stripe
  Price.
- 8.2.2 A change to `price_cents`, `currency`, `billing_type` or
  `recurring_interval` creates **a new Stripe Price** and **a new Stripe Payment
  Link**. The service row is updated to reference the new resources.
- 8.2.3 The only mutable attributes the orchestrator may set on an existing Price
  are its active flag, nickname and metadata.
- 8.2.4 A Stripe Price is never deleted. It may be deactivated.
- 8.2.5 A one-time service maps to a Price with no recurrence. A recurring service
  maps to a Price whose recurring interval is `month` or `year`, matching
  `recurring_interval`.

### 8.3 Payment Link

- 8.3.1 One current Stripe Payment Link exists per priced service.
- 8.3.2 A Payment Link is never deleted. It may be deactivated.
- 8.3.3 `stripe_payment_link_url` is stored only from the URL returned in the
  Stripe API response. It is never constructed, templated or inferred.

### 8.4 Historical preservation

- 8.4.1 Historical Stripe resources are preserved. Superseded Products, Prices and
  Payment Links remain in Stripe.
- 8.4.2 Superseded Prices and Payment Links may be deactivated. **They are never
  deleted.**
- 8.4.3 A superseded Payment Link is deactivated only after the database has been
  updated to reference its replacement. A service must never reference a
  deactivated Payment Link as its current link.

---

## 9. Payment Link redirect

9.1 Payment Links created under this amendment redirect on completion to:

```
${APP_URL}/dashboard
```

9.2 **No new frontend route is approved or referenced by this amendment.** In
particular, no `/services/thank-you` route is approved, referenced, or to be
created.

9.3 A dedicated service thank-you or post-purchase route requires separate
approval under its own amendment.

---

## 10. Consultation payment protection

10.1 The consultation payment workflow is unchanged by this amendment. The
manual-capture Checkout Session flow, the consultation payment state machine, the
consultation payment RPCs, the consultation payment rows, and the consultation
webhook transitions defined in prior locked documents remain exactly as they are.

10.2 **One narrow webhook change is permitted, and no other.** Stripe events that
carry no `consultation_id` metadata and are unrelated to consultations are
acknowledged with **HTTP 200** and treated as ignored, rather than rejected. This
is required because service Payment Link purchases produce Stripe events with no
`consultation_id`, and rejecting them causes Stripe to retry and ultimately
disable the webhook endpoint, which would break consultation payment capture.

10.3 The permitted change is bounded as follows:

- 10.3.1 Ignored events are recorded or logged as ignored, using the existing safe
  logging convention. No secret, token or raw Stripe error payload is logged.
- 10.3.2 **No consultation status transition occurs** for an ignored event.
- 10.3.3 **No consultation payment row is created, updated or deleted** for an
  ignored event.
- 10.3.4 **No consultation payment RPC is called or altered.**
- 10.3.5 Events that carry a `consultation_id` continue through the existing
  processing flow, unchanged in every respect.
- 10.3.6 Webhook signature verification is unchanged. Acknowledging an unrelated
  event does not relax authentication of the event.

10.4 The webhook change is a change to event acknowledgement only.

10.5 **The webhook change must be deployed and regression-tested before the first
service Payment Link is created in any environment.** This ordering is binding and
appears as steps 6 and 7 of section 18.

10.6 Regression evidence that the consultation flow is unaffected is a mandatory
gate at step 7 of section 18.

---

## 11. Purchase and subscription limitation

11.1 **Service Payment Link purchases are not recorded in the Make Hijrah database
by this amendment.** No purchase row, subscription row, customer row or revenue
record is created.

11.2 For the duration of this amendment, **Stripe is the temporary source of truth
for**:

- 11.2.1 purchaser identity;
- 11.2.2 successful service payments;
- 11.2.3 subscription status;
- 11.2.4 recurring renewals;
- 11.2.5 failed payments;
- 11.2.6 cancellations;
- 11.2.7 revenue reporting.

11.3 Recurring subscription management remains in Stripe. The orchestrator does
not create, modify, pause or cancel subscriptions.

11.4 **A service purchase does not automatically create a `service_requests`
row**, or any other record, in the Make Hijrah database.

11.5 Service fulfilment automation is out of scope.

11.6 Refund tooling and subscription cancellation tooling are out of scope.

11.7 Adding purchase reconciliation — recording service payments, subscriptions,
renewals, failures, cancellations or revenue in the Make Hijrah database — **requires
a separate amendment.** It is not authorised here.

11.8 This limitation is a deliberate, accepted consequence of the amendment and
must be understood by the approver: revenue collected through service Payment
Links will be visible in Stripe and will not be visible in the Make Hijrah
database.

---

## 12. Activation and deactivation

### 12.1 Activation

- 12.1.1 A newly created service, and a service newly given structured pricing,
  **cannot become active without a valid current Stripe Payment Link.**
- 12.1.2 A service is created inactive. It becomes activatable only once its
  Product, Price and Payment Link exist and are referenced by the service row.
- 12.1.3 Activation verifies that the current Payment Link is valid and
  corresponds to the service's current Price. Where the link is missing, inactive
  or mismatched, the orchestrator reuses, reactivates or replaces it before the
  service becomes active. A replacement never deletes its predecessor.
- 12.1.4 **Services that predate this amendment and are currently active remain
  unchanged by the migration.** Rule 12.1.1 applies prospectively, at the point an
  administrator edits the service, and is never applied retroactively. The
  migration does not deactivate any service.

### 12.2 Deactivation

- 12.2.1 Deactivation marks the service inactive.
- 12.2.2 Deactivation deactivates the current Stripe Payment Link where the
  operation is supported.
- 12.2.3 Deactivation preserves all historical records. Existing recommendations
  and requests referencing the service are not modified, detached or removed.
- 12.2.4 Deactivation preserves the Stripe Product and Stripe Price.
- 12.2.5 Inactive services are excluded from new selection by a read-side filter.
  Exclusion is never achieved by altering historical rows.

---

## 13. Deletion

13.1 Hard deletion of a service row is permitted **only when no table references
the service.**

13.2 `service_recommendations` and `service_requests` must both be checked.

13.3 **All actual foreign keys referencing `public.services` must be enumerated
from the live schema before the deletion capability is implemented.** The set
checked in code is the set enumerated from the live schema, not an assumed set.
This enumeration is part of step 2 of section 18 and is a precondition of step 8.

13.4 Where the service is referenced, deletion is refused and the administrator is
directed to deactivate instead.

13.5 **No historical business record may be cascade-deleted, detached, nulled or
otherwise modified in order to permit a deletion.** `ON DELETE CASCADE` and
`ON DELETE SET NULL` are prohibited on foreign keys referencing `public.services`.

13.6 Deletion requires explicit administrator confirmation.

13.7 On deletion, associated Stripe objects are archived or deactivated. **Stripe
objects are not deleted.** Stripe identifiers are recorded in logs before the row
is removed, so the resources remain attributable after deletion.

13.8 Stripe teardown precedes row deletion, so that a failure cannot leave a live
Payment Link selling a service that no longer exists.

---

## 14. API permission

14.1 The following admin-only orchestrator endpoints are permitted:

```
POST   /api/admin/services
PATCH  /api/admin/services/:id
POST   /api/admin/services/:id/activate
POST   /api/admin/services/:id/deactivate
DELETE /api/admin/services/:id
```

14.2 No other service-mutation endpoint is authorised by this amendment.

14.3 Every endpoint above requires all of the following:

- 14.3.1 an authenticated request bearing a verified Supabase JWT;
- 14.3.2 **server-side re-read of the role from `public.profiles`** for the
  authenticated user on every request. Role claims carried in the token are never
  trusted;
- 14.3.3 the `admin` role;
- 14.3.4 strict server-side request validation of params, query and body, in which
  unknown keys are rejected rather than ignored;
- 14.3.5 database mutation performed with the Supabase service role;
- 14.3.6 all Stripe operations performed server-side;
- 14.3.7 idempotency protection sufficient to make retries and duplicate
  submissions safe, including Stripe idempotency keys on resource creation;
- 14.3.8 an authoritative response object read back from the database, never a
  reflection of the submitted values;
- 14.3.9 stable, structured error responses using the existing response envelope,
  with a fixed set of machine-readable error codes;
- 14.3.10 no Stripe identifier accepted from the client, and no client-supplied
  price display accepted or trusted;
- 14.3.11 Stripe error detail sanitised before it leaves the orchestrator. Raw
  Stripe messages, request identifiers and decline codes are logged server-side
  and never returned to the client.

---

## 15. Role access

15.1 Only the `admin` role may create, edit, activate, deactivate or delete a
service, and only through the endpoints in section 14.

15.2 The `admin` role's direct database write access to `public.services` is
withdrawn by section 3. Administrative authority over services is exercised
through the orchestrator, not through the database.

15.3 No change is made by this amendment to consultant or client access to
`public.services`, other than as stated in section 3.

15.4 `ROLE_ACCESS_MATRIX.md` is amended to reflect 15.1 and 15.2.

---

## 16. Security invariants

The following are binding and are verified before production readiness is
approved:

- 16.1 No Stripe secret in frontend source, environment or bundle.
- 16.2 No Supabase service-role key in frontend source, environment or bundle.
- 16.3 No direct frontend mutation of service pricing.
- 16.4 No direct frontend mutation of Stripe identifiers.
- 16.5 No direct browser call to any Stripe API.
- 16.6 Admin role verified server-side by re-reading `public.profiles`.
- 16.7 Prices handled as integer minor units end to end.
- 16.8 Currency validated server-side against the permitted set in 5.6.
- 16.9 Request bodies schema-validated with unknown keys rejected.
- 16.10 Stripe errors sanitised before being returned.
- 16.11 Logs contain no secrets, tokens or raw Stripe error payloads. Stripe
  object identifiers are not secrets and may be logged.
- 16.12 URLs stored and returned only as received from Stripe responses.
- 16.13 Deletion destroys no historical record.
- 16.14 No authenticated write path to `public.services` remains after migration.

---

## 17. Out of scope

The following remain locked and are **not** permitted by this amendment:

- Stripe Customers, Stripe Subscriptions management, Stripe Invoices, Stripe
  Coupons and promotion codes, Stripe Tax.
- Recording service purchases, subscriptions, renewals, failures, cancellations
  or revenue in the Make Hijrah database.
- Automatic creation of `service_requests` or any other record from a purchase.
- Service fulfilment automation.
- Refunds and subscription cancellation tooling.
- Per-client or negotiated pricing.
- Service revenue reporting.
- Currencies outside `usd`, `gbp`, `eur`.
- Any new database table.
- Any new frontend route, including any service thank-you or post-purchase route.

---

## 18. Binding implementation order

18.1 The following order is binding. Steps may not be reordered, merged in a way
that defeats a gate, or begun before step 1 completes.

| Step | Action | Gate |
|---|---|---|
| 1 | **Approve this amendment** | Approval recorded in section 21 |
| 2 | Inspect the live `public.services` schema, rows, foreign keys, grants and RLS policies | Foreign key set enumerated; existing row state known; current grants and policies documented |
| 3 | Author and review the additive migration | Migration reviewed and approved |
| 4 | Apply the migration to staging | Clean apply; no existing row altered; no service deactivated |
| 5 | Verify constraints and **verify removal of direct service writes** | Constraints enforce section 5; no authenticated session can `INSERT`, `UPDATE` or `DELETE` `public.services`; `SELECT` unaffected |
| 6 | Implement the webhook tolerance change of section 10 | Change confined to event acknowledgement |
| 7 | Deploy the webhook change and **regression-test consultation payments** | Consultation draft → checkout → authorize → accept → capture passes; consultation events still processed; unrelated events acknowledged 200 |
| 8 | Implement the admin service orchestrator module | Endpoints of section 14 complete; typecheck and build clean |
| 9 | Deploy and verify auth, validation and Stripe test-mode behaviour | Unauthenticated 401; non-admin 403; validation rejections correct; Product, Price and Payment Link created correctly in test mode for one-time, monthly and yearly |
| 10 | Wire the frontend | All actions wired; placeholder unavailability notice removed only once every action is genuinely wired |
| 11 | Deploy the frontend | Page loads; mock mode does not leak into production |
| 12 | Complete browser, database and Stripe verification | All service actions exercised in browser; database records correct; Stripe dashboard shows correct Products, Prices and Payment Links, with superseded resources archived or deactivated and none deleted |

18.2 The first service Payment Link may not be created in any environment before
step 7 completes.

18.3 Production readiness is approved only after step 12 completes.

---

## 19. Migration obligations

19.1 The migration authorised by this amendment must:

- 19.1.1 add the eight columns of section 4.1 as nullable;
- 19.1.2 add check constraints enforcing 5.1 through 5.5 and 5.7;
- 19.1.3 constrain `currency` to a lowercase three-letter code at the database
  level, with the narrower permitted set of 5.6 enforced by the orchestrator;
- 19.1.4 add uniqueness on each of `stripe_product_id`, `stripe_price_id` and
  `stripe_payment_link_id` where the value is not null, so that no two services
  can share a Stripe resource;
- 19.1.5 **revoke `INSERT`, `UPDATE` and `DELETE` on `public.services` from the
  `authenticated` role, and drop or narrow every write-granting RLS policy on
  `public.services`, per section 3.4**;
- 19.1.6 retain `SELECT` access as presently approved;
- 19.1.7 write no data;
- 19.1.8 alter no existing row;
- 19.1.9 deactivate no service;
- 19.1.10 create no table.

19.2 The migration is additive with respect to data and restrictive with respect
to write privilege. It is not permitted to be destructive with respect to either
rows or history.

---

## 20. Compliance

20.1 An implementation that violates any binding clause of this amendment is out
of compliance with the project lock, regardless of whether it functions.

20.2 Discovery of a violation requires either correction of the implementation or
a further amendment. It does not create a precedent.

20.3 This amendment does not authorise itself to be varied in implementation. Any
deviation discovered during implementation is escalated for approval, not
absorbed.

---

## 21. Approval

This amendment takes effect only when signed below. No work in section 18 may
begin before the approval date is recorded.

```
Proposed by:  MakeHijrah ........................   Date: 2026-07-29

Reviewed by:  MakeHijrah ........................   Date: 2026-07-29

Approved by:  MakeHijrah ........................   Date: 2026-07-29

Status on approval:  APPROVED
```

---

## Appendix A — Clause index

| Subject | Clause |
|---|---|
| Approval precedes all implementation | 2.1–2.4, 18.1 |
| Admin direct writes superseded | 3.1, 3.2.2 |
| Migration removes direct-write policies and grants | 3.4, 19.1.5 |
| Frontend may not mutate services | 3.3 |
| Permitted columns | 4.1 |
| No new table | 4.3, 17 |
| Billing types and intervals | 5.1–5.4 |
| Positive integer minor units | 5.5 |
| Currency limited to usd, gbp, eur | 5.6 |
| `price_display` generated server-side | 6.2, 6.3 |
| Stripe secrets orchestrator-only | 7.1 |
| One Product per service | 8.1.1 |
| Prices immutable | 8.2.1 |
| Change creates new Price and Payment Link | 8.2.2 |
| Historical Stripe resources preserved, never deleted | 8.4.1–8.4.2 |
| Payment Link redirect to `${APP_URL}/dashboard` | 9.1 |
| No new route approved | 9.2, 17 |
| Consultation flow unchanged | 10.1 |
| Narrow webhook tolerance change | 10.2–10.4 |
| Webhook change deploys before first Payment Link | 10.5, 18.2 |
| Purchases not recorded; Stripe temporary source of truth | 11.1, 11.2 |
| Purchases do not create `service_requests` | 11.4 |
| Reconciliation requires separate amendment | 11.7 |
| Activation requires valid Payment Link | 12.1.1 |
| Legacy active services unchanged by migration | 12.1.4 |
| Deletion only when unreferenced | 13.1 |
| Foreign keys enumerated from live schema | 13.3 |
| No cascade delete or detachment | 13.5 |
| Permitted endpoints | 14.1 |
| Server-side role re-read | 14.3.2 |
| Binding implementation order | 18.1 |