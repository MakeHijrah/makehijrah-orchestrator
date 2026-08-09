# PROJECT_LOCK Amendment 011 — Direct consultant booking

**Status:** Approved
**Implemented by:** migration 045, orchestrator commit accompanying this file
**Relationship to Amendment 002:** *preserved, not replaced.* The frictionless public booking flow and its post-payment account provisioning are unchanged. See §8.
**Relationship to Amendment 007:** the platform's consultation price and commission rate remain the settings referred to here. Nothing about `app_settings` changes.
**Relationship to Amendment 009:** independent. Service purchase finance is untouched.

---

## 1. What this amendment adds

A consultant may publish a **personal booking page at a root URL** — `makehijrah.com/aisha-rahman` — and set **their own price** for bookings taken through it.

That is the whole feature. Everything else about such a booking is what it already was.

## 2. The single most important rule

**Direct booking does not create a second booking system.**

A direct booking is an **ordinary consultation**: same `public.consultations` row, same statuses, same draft hold, same double-booking exclusion, same checkout, same capture, same completion, same refund path, same 48-hour authorization timeout, same admin cancellation. There is:

- **no** `direct_consultations` table,
- **no** parallel payment record,
- **no** second account system,
- **no** separate calendar or availability path.

The only thing that distinguishes it is `consultations.booking_source`, which decides where the price came from and which commission rule applies to the money. Anything that would have required a second system was rejected on that ground.

## 3. Root consultant URLs, and who owns the namespace

A published consultant lives at a **root path**. That puts consultant slugs in the same namespace as every top-level route the frontend owns, so slug authority is **split deliberately**:

| Concern | Owner | Why |
|---|---|---|
| **Format** — lowercase, URL-safe, 3–60 chars, no leading/trailing/doubled hyphen | **Database** (`consultants_slug_format_check`, `consultants_slug_length_check`) | A property of the value; belongs where the value lives. |
| **Uniqueness** when non-null | **Database** (`uq_consultants_slug`, partial) | Only the database can arbitrate a race. Partial, so many consultants may hold `null`. |
| **Reserved names** | **Orchestrator** (`src/modules/direct-booking/direct-booking.slug.ts`) | This is a fact about the frontend's **routing table**. It changes when a route is added, not when the schema changes. Encoding it in a migration would guarantee the two drift apart, and the day they drift a consultant claims `/dashboard`. |

**There is no `reserved_slugs` table**, for the same reason.

### Normalization

Applied to every slug on the way in, and to every slug looked up:

trim → lowercase → NFKD → drop combining marks → replace each run of non-alphanumerics with a single hyphen → collapse hyphens → trim hyphens.

NFKD *then* dropping the marks is what turns `Aïsha` into `aisha` rather than `a-sha`. The **stored** value is always the normalized one, so the column is always exactly what appears in the URL.

### Reserved set

Reserved names are matched **after** normalization, against **normalized** reserved values — so `Admin`, `  ADMIN  ` and `favicon.ico` (which normalizes to `favicon-ico`) are all refused. The list includes at minimum:

`admin`, `dashboard`, `consultant`, `consultants`, `consultation`, `consultations`, `login`, `logout`, `onboard`, `api`, `privacy`, `terms`, `finance`, `settings`, `profile`, `messages`, `earnings`, `signup`, `signin`, `auth`, `static`, `assets`, `public`, `_build`, `favicon.ico`, `robots.txt`, `sitemap.xml`

plus the rest of the routing table and its near misses. **When a top-level page is added to the frontend, it is added to this list in the same change.**

A reserved slug is **rejected** (400, `reason: SLUG_RESERVED`). A uniqueness conflict is **409** (`reason: SLUG_TAKEN`).

## 4. The effective price rule

```
effective_direct_price = max(
  consultants.direct_booking_price_cents,
  app_settings.consultation_price_cents
)
```

A consultant sets a price once. The platform's own consultation price may rise afterwards, and when it does, a direct booking priced below it would sell the platform's own product at a discount through a page the platform hosts. **So the floor moves with the platform.**

This rule is applied in exactly **two** places and they must agree:

1. the price **displayed** on the public booking page, and
2. the price **written onto the draft consultation**, which checkout then charges.

Both read it from one function (`resolveEffectiveDirectPrice`). **Never display the stale stored price and charge a higher amount.** The public read model therefore publishes `effective_direct_booking_price_cents` and **does not publish** `direct_booking_price_cents` at all, so a frontend cannot render the stored figure by accident. The frontend does not reproduce trusted price logic; it renders what the server computed.

A save-time floor is also enforced: a consultant may not *set* a price below the platform's current price (400, `reason: PRICE_BELOW_PLATFORM_MINIMUM`). That is deliberately **not** a database constraint — the platform default may later rise above a stored price, and a constraint would then invalidate an untouched row and block every unrelated update to it. The effective price rule is what keeps a stale low price safe afterwards.

## 5. The commission split

A direct booking's earning is **two ledger rows**, because two different rates apply to two portions of one payment. Migration 034 anticipated exactly this: `source_component` already admitted `standard` and `premium`, and `ledger_basis_alignment_check` already named the two bases. Migration 045 is the first thing to use them.

| Component | Gross | Consultant rate | Basis |
|---|---|---|---|
| **standard** | `min(price, platform default)` | the platform's current consultation rate (**5000 bps** today) | `direct_booking_standard` |
| **premium** | `price − standard gross` | **8000 bps**, locked | `direct_booking_premium` |

- The premium row is written **only when the premium is positive**. A direct booking priced at exactly the platform default is simply a standard 50/50 split, and a zero-value premium row would record no financial fact.
- `min()` handles the inverted case: if the platform default has risen past the booked price, the standard component takes the whole amount and there is no premium row, rather than a negative one.
- **Rounding:** the consultant's share is `round(gross × bps ÷ 10000)` through `numeric`, and **the platform takes the remainder by subtraction**. Never round both sides — `consultant + platform = gross` must hold on every row.

### The locked example

Platform default **15000**, direct price **20000**:

| | gross | consultant | platform |
|---|---|---|---|
| standard | 15000 | 7500 | 7500 |
| premium | 5000 | 4000 | 1000 |
| **total** | **20000** | **11500** | **8500** |

## 6. Refunds are CUMULATIVE

`reverse_direct_booking_earning(p_consultation_id, p_reason, p_refunded_total_minor)`.

`p_refunded_total_minor` is what Stripe says has been refunded **in total** against this consultation — `charge.amount_refunded` — **not the amount of one refund**. Migration 040 read the same figure as a delta for service purchases, and a second partial refund over-reversed a consultant's ledger by the first refund's amount. Migration 043 fixed that and renamed the parameter so a stale caller fails loudly. **The same name is used here for the same reason.**

Splitting a cumulative target across two components:

```
standard_target = round(refunded_total × standard_gross ÷ total_gross)
premium_target  = refunded_total − standard_target
```

The premium target is the **remainder**, never a second rounding. That is what guarantees the property that matters:

> **The component reversals sum to the cumulative refund exactly.**

Rounding both independently could leave the two targets summing to one minor unit more or less than the customer was actually refunded, and that unit would come from or go to a consultant who had nothing to do with it.

Each component is then compared against its **own** prior reversals, and only the new delta is applied. So: a first partial applies its amount; a redelivered event applies nothing; a second partial applies only its difference; partial-then-full completes exactly; a duplicate full applies nothing. A delta of zero or less is a no-op. A target above the gross is **rejected**, not clamped.

## 7. Server authority

The draft endpoint accepts **no** price, currency, `booking_source`, commission, split, premium or earnings value. Those fields do not exist in its schema, so they are stripped at the boundary and cannot reach the RPC — no later check has to remember to ignore them.

A direct booking is identified **only** by `consultant_slug`. The server resolves the slug to a consultant, verifies the page is actually published, computes the effective price, and sets `booking_source = 'direct_booking'`. A request carrying **both** a slug and a `consultant_id` is **refused**, not resolved by precedence: trusting a browser-supplied id alongside a slug would let a request quote one consultant's page and book another's calendar at that consultant's price.

Checkout continues to trust `consultations.price_cents`, unchanged.

### The two finance paths cannot cross

The Stripe webhook may not read `consultations.booking_source` — Amendment 004 §10.3.3 holds that path to RPC calls only. So the **database** decides, through one uniform rule: **try the direct RPC first, and fall back to the standard one on `FINANCE_NOT_DIRECT_BOOKING`.** All three direct RPCs raise that marker for a standard consultation. The answer is therefore read under the same row lock as the write it authorises; a separate lookup could be stale by the time the write happened.

Migration 045 also gives `record_consultation_earning` a matching `booking_source` guard (`FINANCE_NOT_STANDARD_BOOKING`). Handed a direct booking, it would otherwise write a flat 50/50 earning across the whole price *in addition to* the two components — two earnings for one payment, with the consultant robbed of the premium they published for. The ledger's unique index would not have stopped it, because that index is per `source_type`.

## 8. Amendment 002 is preserved

Public draft creation may still resolve or provision an Auth user and a client profile **before** payment. That is Amendment 002's frictionless flow and it is unchanged by this amendment.

**Provisioning an account is not authenticating a visitor.** A visitor who books through a consultant's page is not logged in by doing so, and dashboard access still requires the post-payment OTP / magic-link step. Direct booking adds no new account path and changes nothing about the existing one.

## 9. API surface

| Endpoint | Role | Change |
|---|---|---|
| `GET /api/public/consultants/:slug` | **anon** | **New.** Safe projection + `effective_direct_booking_price_cents`. Unknown, inactive and disabled all return the **same 404**. |
| `POST /api/consultations/draft` | anon | Accepts `consultant_slug` **instead of** `consultant_id`. Never both. |
| `GET /api/consultant/direct-booking` | consultant | **New.** Own settings, effective price, canonical URL. |
| `PATCH /api/consultant/direct-booking` | consultant | **New.** `consultant_slug`, `direct_booking_enabled`, `direct_booking_price_cents` — and nothing else. Strict schema. |
| `GET /api/admin/consultants/:id/direct-booking` | admin | **New.** Enabled flag, slug, configured price, effective price. |
| `POST /api/admin/consultants/:id/direct-booking/disable` | admin | **New.** The moderation action. |

The public projection returns `consultant_id`, `consultant_slug`, `display_name`, `headline`, `bio`, `photo_url`, `timezone`, `gender`, `available_for_general`, `minimum_booking_notice_hours`, `country_ids`, `effective_direct_booking_price_cents`, `currency` — and **nothing else**. No commission rule, no payout setting, no email, no `profiles.full_name`, no ledger, no internal finance.

A consultant edits **only their own** settings: the row is found from the profile id on the verified token, and the API accepts no consultant identifier at all, so there is nothing to tamper with. An admin may **disable** a page but may not rename a consultant's link or set their price — an admin who could set the price could change what a consultant earns. Disabling leaves the slug and price intact, so re-enabling restores the same URL rather than freeing it.

**No editable commission percentage is exposed anywhere.** The 50/50 base and the 80/20 premium are platform rules.

## 10. Analytics

No change. Migration 044 groups recorded revenue by `source_type`, so `direct_booking` appears on its own row the moment one exists. No dashboard change was needed and none was made.

## 11. What this amendment does not do

- No Stripe Connect, and no automated consultant payouts.
- No change to standard consultation commission, service purchase finance, or any existing policy, grant or RLS rule.
- No new anon-facing table policy: the public page is a **server-built projection**, not a table read.
- No frontend code in this repository.
