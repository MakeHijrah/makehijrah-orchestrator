# PROJECT_LOCK Amendment 012 — Consultant slug governance

**Status:** Approved
**Implemented by:** migration 049, orchestrator commit accompanying this file
**Relationship to Amendment 011:** *amends it.* 011 created consultant slugs and let a consultant set their own. This amendment removes that self-service and makes slugs admin-managed. Everything else in 011 — the effective price rule, the two-component split, the cumulative refund semantics, the public projection — is unchanged.

---

## 1. What changes, stated plainly

**A consultant may no longer choose or change their own booking link.**

That is a removal of a capability they had, so it is worth saying why rather than only what.

## 2. Why the change

A consultant slug is not a profile field. It is a **root URL**, in the same namespace as every top-level route the platform owns, and it is the address a consultant hands to clients.

Two consequences follow, and neither was adequately handled by self-service:

1. **The namespace is shared with the platform.** The reserved set that protects `/dashboard`, `/privacy-policy` and the rest lives in the orchestrator. A consultant editing their own slug is one bypass away from claiming a route the frontend is about to need — and until migration 049, that bypass was a single PostgREST call away.

2. **A link that moves breaks everything already carrying it.** Business cards, email signatures, social profiles, WhatsApp messages. A consultant who renames themselves on a Tuesday has broken every one of them, with no redirect and no warning. Making the change deliberate and administrative is what makes it rare.

## 3. What a consultant keeps

**Self-service is narrowed, not removed.** Through `PATCH /api/consultant/direct-booking` a consultant still controls:

- `direct_booking_enabled` — whether their page is live
- `direct_booking_price_cents` — what it charges, subject to the platform floor

They may **read** their slug and their canonical booking URL from `GET /api/consultant/direct-booking`, and copy it. They simply cannot write it.

`consultant_slug` is removed from the update schema, which is `.strict()` — so a client still sending it gets a `400`, not a silent no-op. For a field that used to work, being told is the right answer.

## 4. Default slug generation

A consultant who cannot choose a link must be given one.

- **Source:** `consultants.display_name`, the public projection of `profiles.full_name` (Amendment 008). The authoritative field is a **fallback**, read only when the projection is empty. There is no second name authority.
- **Normalizer:** the existing one, unchanged — trim, lowercase, NFKD, drop combining marks, non-alphanumeric runs to a single hyphen, collapse, trim. `Abu Mansur Omar Sherrer` → `abu-mansur-omar-sherrer`. `O'Brien` → `o-brien`. `Ålesund` → `alesund`. Nothing is percent-encoded; this is a path segment somebody has to type.
- **When:** at **activation**, and only when `consultant_slug IS NULL`. Never on a rename, never on reactivation, never twice.
- **Generation failure blocks activation.** An active consultant with no booking link is a half-finished state somebody would have to notice and repair by hand.
- **It does not enable direct booking.** A link is an address, not a decision to publish.

## 5. Collision strategy

| | Generated default | Admin-entered |
|---|---|---|
| Already taken | suffix: `john-smith`, `john-smith-2`, `john-smith-3` | **refused**, `409 SLUG_TAKEN` |
| Reserved | skipped — a consultant called Admin gets `admin-2` | **refused**, `400 SLUG_RESERVED` |
| Too short / malformed | skipped | **refused** with its own code |

The asymmetry is the point. Nobody asked for `john-smith-2`, so producing it silently is helpful. Somebody *typed* the admin-entered one, so silently storing something else would be worse than saying it is taken.

Mechanics: normalize the base first; truncate before appending a suffix so the 60-character limit holds and no doubled hyphen is produced; try up to **20** sequential suffixes; then fall back to a short random tail (`john-smith-a1b2c3`); a consultant with no usable name at all gets `consultant-<random>`. **The unique index remains the final authority** — a `23505` is caught and the next candidate is tried.

## 6. Admin control

`PATCH /api/admin/consultants/:id/direct-booking`, body `{ "consultant_slug": "..." }`, strict. Admin auth only. It runs the **same** validation path as everything else — normalize, reserved, format, length, uniqueness — because a second implementation is a second set of rules waiting to disagree.

Stable error reasons, in `error.details.reason`: `SLUG_EMPTY`, `SLUG_TOO_SHORT`, `SLUG_TOO_LONG`, `SLUG_INVALID`, `SLUG_RESERVED`, `SLUG_TAKEN`. **No raw unique-constraint error ever reaches HTTP.**

An admin sets the address only. The price and the enabled flag are carried through unchanged — they remain the consultant's.

## 7. The database lock

Migration 049 extends `guard_consultants_columns` so a non-privileged writer cannot change `consultant_slug`, `direct_booking_enabled` or `direct_booking_price_cents`.

This closes a real bypass. `consultants_update_own_or_admin` has existed since migration 002, so a consultant holding their own JWT could reach PostgREST and set any of the three directly — taking a reserved slug, publishing a page an admin had not activated, or pricing a booking **below the platform's own consultation** through a page the platform hosts. The price floor in particular is enforced *only* by the orchestrator, by design, so a direct write was the whole of the way around it.

**Authority stays split exactly as Amendment 011 set it:**

| Concern | Owner |
|---|---|
| slug format, slug length, uniqueness | **database** — CHECK constraints and `uq_consultants_slug` |
| reserved set, price floor, publish preconditions, admin-only slug | **orchestrator** |

No slug validation is added in SQL. The reserved set remains orchestrator-side because it is a fact about the frontend's routing table, and now that sanctioned writes are forced through the orchestrator, that split is complete rather than merely intended.

**Not changed:** no RLS policy added, removed or narrowed; consultants keep the SELECT they have always had, including on all three columns; `available_for_general`, `headline`, `bio` and the rest remain directly writable exactly as before; no new anon access.

## 8. Backfill

Consultants activated before this amendment have no link. A one-off orchestrator script — `npm run backfill:consultant-slugs` — assigns one using the **same generator**, never in SQL, because reimplementing the normalizer and the reserved set in a migration would create rules that could disagree with the originals.

It selects active consultants with a null slug, is idempotent, never overwrites, **does not enable direct booking**, logs every consultant id beside its assigned link, continues past a consultant it cannot name, and exits non-zero if any failed.

## 9. Known limitation, stated rather than discovered later

**An admin changing a slug breaks the old URL.** There is no redirect and no slug history. Anyone holding the previous link gets a 404.

That is accepted for now, and it is the main reason slug changes are administrative rather than self-service: making them rare is the mitigation. A future amendment may add a `consultant_slug_history` table and 301 redirects; until it does, an admin changing a live consultant's link should expect to tell them.

## 10. What this amendment does not do

- No frontend. The consultant settings panel must drop its slug input; the admin consultant page gains one.
- No change to the effective price rule, the commission split, refunds, or the public projection.
- No new table. No `reserved_slugs` table, for the reason Amendment 011 gave.
- No automatic enabling of direct booking, anywhere.
