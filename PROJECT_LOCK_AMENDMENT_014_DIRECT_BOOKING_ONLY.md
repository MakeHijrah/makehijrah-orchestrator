# PROJECT_LOCK Amendment 014 — Direct-booking-only consultants, and the calculator contract

**Status:** Approved
**Implemented by:** migration 050, orchestrator commit accompanying this file
**Relationship to Amendments 011–013:** *extends them.* The direct booking feature, its slug governance and its ownership split are unchanged. This adds one consultant preference and publishes the commission terms a consultant's own calculator needs.
**Relationship to the frozen finance baseline:** **nothing in the finance path changes.** No ledger row, split, snapshot, payout or refund behaviour is touched. See §6.

---

## 1. What this adds

A consultant may say **"I only want direct bookings."**

When set, they disappear from the ordinary `/consultation` chooser — country-specific *and* general-information — while remaining fully bookable through their own direct link, at their own price, under exactly the commission rules they had before.

## 2. The column

```sql
alter table public.consultants
  add column if not exists direct_booking_only boolean not null default false;
```

Defaulted `false`, so every consultant who exists today keeps the eligibility they have today. Nothing is backfilled.

**Deliberately not one of the three that resemble it:**

| Column | What it actually means |
|---|---|
| `is_active` | an **administrative** decision about whether the consultant works here at all |
| `available_for_general` | which of the **two standard flows** they take — says nothing about country-specific ones |
| `direct_booking_enabled` | whether their **own page is live** — an admin decision (Amendment 013) |
| **`direct_booking_only`** | **whether the platform offers them in its own chooser** |

None of the first three means the fourth, and overloading any of them would make two different intents share one switch.

## 3. Where the exclusion is enforced, and why it is an RLS policy

**There is no orchestrator endpoint that lists consultants for `/consultation`.** That list is the frontend reading `public.consultants` directly through `consultants_select_active_public`. A filter in orchestrator code cannot remove a consultant from a list the orchestrator does not produce, so the exclusion lives where the read happens:

```sql
using (is_active = true and direct_booking_only = false)
```

One policy change covers **both** standard paths, because both read it — and it applies regardless of country assignment, `available_for_general`, headline, bio or price.

**The direct page is unaffected.** `loadPublicConsultantBySlug` runs as the service role and bypasses RLS entirely.

### The restoration policy

Narrowing alone would also hide the consultant from **a client who has already booked them**, breaking the consultant's name on that client's own dashboard. So:

```sql
create policy consultants_select_booked_direct_only on consultants
for select to authenticated
using (
  is_active = true
  and direct_booking_only = true
  and exists (select 1 from public.consultations c
               where c.consultant_id = consultants.id
                 and c.client_profile_id = auth.uid())
);
```

Scoped to `direct_booking_only = true` and to an existing consultation, so it restores **exactly** what the narrowing removed and grants nothing else.

### And the booking gate

Invisible is not the same as unbookable. `validateDraftConsultantGender` — the first eligibility check on `POST /api/consultations/draft` — refuses a direct-booking-only consultant when `booking_source = 'standard'`, with reason `consultant_direct_booking_only`. A request naming them by id from a stale list, a cached page or a hand-crafted call is refused. **Direct bookings pass straight through**: the consultant is refusing the platform's chooser, not their own clients.

## 4. Ownership

| Setting | Writes | Reads |
|---|---|---|
| `consultant_slug` | admin | consultant, admin |
| `direct_booking_enabled` | admin | consultant, admin |
| `direct_booking_price_cents` | consultant | consultant, admin |
| **`direct_booking_only`** | **consultant** | consultant, admin |
| `effective_direct_booking_price_cents` | nobody — server-derived | consultant, admin |
| **the three calculator terms** | **nobody** | consultant, admin |

`direct_booking_only` is the consultant's because it is a statement about **how they want to work**, not a platform decision.

**Guarded at the database anyway.** Migration 050 extends `guard_consultants_columns` so a browser cannot write it directly — the same treatment `direct_booking_price_cents` gets, and for the same reason: the rules around it are the orchestrator's, and this keeps one rule for all four direct booking columns rather than three guarded and one not.

**Direct-booking-only with the direct page disabled is ACCEPTED, not refused.** The consultant is then bookable nowhere, which is a state they chose. Refusing it would let an admin-owned setting block a consultant's own preference. The frontend warns them; the backend does not stand in the way.

## 5. The calculator contract

The consultant settings screen shows a bidirectional **Direct Booking Price ↔ You Earn** calculator. The frontend must not hardcode the percentages, so both GETs — consultant and admin — publish them read-only:

```
direct_booking_only                  boolean
standard_booking_price_cents         integer   read-only
base_consultant_commission_bps       integer   read-only
premium_consultant_commission_bps    integer   read-only
```

**No PATCH accepts any of the three.** Both schemas are strict and neither carries them, so sending one is a `400`.

### The formula

```
charged = max(price, standard_booking_price_cents)   // effective price rule
base    = min(charged, standard_booking_price_cents)
premium = charged - base
earn    = round(base    * base_bps    / 10000)
        + round(premium * premium_bps / 10000)
```

Integer minor units throughout. Rounded **per component**, never on the blended total. PostgreSQL's `round()` and JavaScript's `Math.round()` agree on positive halves, and these are always positive. Published as `estimateDirectBookingConsultantEarnings` so the two sides cannot drift.

`standard_booking_price_cents` and `minimum_direct_booking_price_cents` are the **same underlying value** — `app_settings.consultation_price_cents` — under two names answering two questions: *"the lowest price I may set"* and *"where my premium starts"*. They must never be allowed to diverge; a test asserts they are equal.

## 6. Provenance of the two rates — read this before changing either

**The calculator is a display estimate. The ledger is what a consultant is paid.**

| Rate | Authority | How the orchestrator gets it |
|---|---|---|
| **base** | `app_settings.consultation_consultant_commission_bps` — the row `record_consultation_earning` and the base component of `record_direct_booking_earning` both read | **read from it.** The settings provider projection was widened; no copy exists |
| **premium** | `c_premium_bps constant integer := 8000` inside **`record_direct_booking_earning`** (migration 045) | **mirrored** as `DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS`, because there is nothing to read — it is not in `app_settings`, not in any table, and not derivable |

**`DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS` is NOT the financial authority.** It exists so the settings GET can publish the current term. `record_direct_booking_earning` decides the money and is untouched by this amendment.

**The drift is not left to discipline.** `MIGRATION_050_VERIFICATION.sql` **check 2** reads the ledger function's own source and **fails if the literal is no longer 8000** — before anybody is shown an earnings figure the ledger will not honour. If the rate is deliberately changed, both move together and the check's expected value moves with them.

If the premium rate ever needs to be configurable, the right change is to move it into `app_settings` and have the ledger function read it — one authority, no mirror. That is a **finance change against a frozen baseline** and needs its own approved scope and regression. It is deliberately not done here.

## 7. What this amendment does not do

- **No finance change.** No ledger row, split, snapshot, payout, refund or commission behaviour. Migration 050's verification asserts all eleven finance RPCs and the append-only trigger are intact.
- **No frontend.** The checkbox, the bidirectional calculator, the tooltip and client-side `/consultation` filtering are a separate build.
- **No new table, status, route or endpoint.**
- **No change to the availability endpoint.** A stale list may still request slots for a direct-booking-only consultant; the draft refusal stops the booking, and leaving it alone keeps the direct page working through the same path.
- **No admin edit control** for `direct_booking_only`. Admin reads it; the consultant owns it.
