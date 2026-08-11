# PROJECT_LOCK Amendment 013 — Direct booking setting ownership

**Status:** Approved
**Implemented by:** orchestrator commit accompanying this file. **No migration.**
**Relationship to Amendment 012:** *supersedes one rule of it.* 012 made the slug admin-managed and left `direct_booking_enabled` with the consultant. This amendment moves enabling to the administrator as well. Everything else in 012 — default generation, the collision strategy, the reserved set, migration 049's column lock — stands unchanged.

---

## 1. The ownership model, final

| Setting | Writes | Reads |
|---|---|---|
| `consultant_slug` | **admin** | consultant, admin |
| `direct_booking_enabled` | **admin** | consultant, admin |
| `direct_booking_price_cents` | **consultant** | consultant, admin |
| `effective_direct_booking_price_cents` | **nobody** — server-derived | consultant, admin |

The line is not arbitrary. **What is published under the platform's own domain is the platform's decision; what somebody charges for their own time is theirs.**

- A **slug** is a root URL in the platform's namespace, and a link that moves breaks every card already carrying it.
- **Enabling** puts a page live on the platform's domain under the platform's brand — the same kind of decision activation already is, and it now sits with the same actor who makes that one.
- The **price** is the consultant's, and an admin who could set it could set what that consultant earns — and, through the effective price rule, what a client is charged.

## 2. What changed from Amendment 012

**`direct_booking_enabled` moved from consultant to admin.** That is the whole change. A consultant who could publish their own page could put a listing live under the platform's brand without the platform agreeing to it.

## 3. API surface

### `PATCH /api/consultant/direct-booking` — consultant

Strict. **One field:**

```json
{ "direct_booking_price_cents": "integer | null" }
```

`consultant_slug` and `direct_booking_enabled` are **absent from the schema**, so sending either is a **400**, not a silent no-op. That is the right answer for fields that used to work: a save that appears to succeed and changes nothing is worse than one that fails. Null clears a configured price — how a consultant withdraws a price they no longer want to offer.

### `PATCH /api/admin/consultants/:id/direct-booking` — admin

Strict. **Two fields, at least one required:**

```json
{
  "consultant_slug": "string",
  "direct_booking_enabled": "boolean"
}
```

`direct_booking_price_cents` is **absent from the schema**. A body containing neither supported field is a **400** — answering 200 to a request that changes nothing would hide whatever mistake produced it.

`POST /api/admin/consultants/:id/direct-booking/disable` remains as the one-gesture moderation action and now delegates to the same path.

## 4. Publish preconditions — unchanged, and applied to the new actor

An admin enabling a page is held to **exactly** what a consultant was held to when enabling was theirs. The change of actor is a change of authority, not a relaxation of the rules:

| Condition | Status | `reason` |
|---|---|---|
| Consultant exists | 404 | — |
| Consultant is **active** | 409 | `CONSULTANT_NOT_ACTIVE` |
| A slug exists | 400 | `SLUG_REQUIRED` |
| A configured price exists | 400 | `PRICE_REQUIRED` |
| Configured price ≥ platform minimum | 400 | `PRICE_BELOW_PLATFORM_MINIMUM` |

The active check is evaluated **first**: it is the one that cannot be worked around, and telling an admin to set a price for a consultant who cannot be published either way sends them to fix the wrong thing.

**There is deliberately no separate "effective price ≥ platform minimum" refusal.** The effective price is `max(configured, platform)`, so it is at or above the minimum *by construction*. A check for a case that cannot arise would be dead code, and it would wrongly block an admin from enabling a consultant whose stored price simply predates a price rise — which the effective price rule already handles by charging the higher figure.

## 5. Disabling

Setting `direct_booking_enabled = false` turns the public booking page off **and does nothing else**:

- the **slug is preserved**, so it stays reserved for that consultant and re-enabling restores the same URL rather than freeing it for somebody else to claim;
- the **configured price is preserved**, so the consultant does not have to set it again.

## 6. Read contracts — unchanged

Both `GET /api/consultant/direct-booking` and `GET /api/admin/consultants/:id/direct-booking` return the same object as before: `consultant_id`, `consultant_slug`, `direct_booking_enabled`, `direct_booking_price_cents`, `effective_direct_booking_price_cents`, `minimum_direct_booking_price_cents`, `currency`, `booking_url`. **No envelope change.** Ownership governs writes only; both roles still see everything.

## 7. Implementation shape

Two separate entry points with **separate input types** — `ConsultantDirectBookingUpdate` and `AdminDirectBookingUpdate` — rather than one function taking an actor parameter. There is no object that can carry "any direct booking field", so a later edit cannot widen an actor's reach by adding a property; it would have to add a parameter to a function whose name says who is calling it.

What they share is the **validation**, in one place (`validateResolvedUpdate`) applied to the resolved next state regardless of who asked for it, and one write (`saveResolvedUpdate`). Slug validation, the price floor and the publish preconditions are each defined once. **Ownership differs; the rules do not.**

## 8. The database is unchanged

Migration 049 still blocks direct PostgREST/JWT writes to all three columns, and is **not modified** by this amendment. Every sanctioned write goes through the orchestrator holding the service role, which is what makes the ownership split above enforceable at all — without it, a consultant could set any of the three from a browser regardless of what the API accepts.

No schema change, no RLS change, no policy change, no finance change, no change to public booking routing.

## 9. What this amendment does not do

- No frontend. The consultant settings panel must drop its enable/disable control (it will otherwise receive 400s); the admin consultant page gains one.
- No admin price editing, ever.
- No consultant slug editing, ever.
- No change to the effective price rule, the commission split, or refunds.
