# MakeHijrah Relocation OS — ROLE_ACCESS_MATRIX.md

**Version:** 1.0 (draft for Dave's review)

Four actors: **Anon** (pre-login visitor), **Client**, **Consultant**, **Admin**, plus **Orchestrator** (service role — not a human role, but listed because every sensitive write routes through it).

Legend: ✅ allowed · ❌ denied · 🔧 = happens only via orchestrator endpoint (Lovable calls the API; Supabase write is service-role)

---

## 1. Capability matrix (what each actor can DO)

| Capability | Anon | Client | Consultant | Admin | Write path |
|---|---|---|---|---|---|
| View active consultants & countries | ✅ | ✅ | ✅ | ✅ | RLS read |
| Start booking form | ✅ (login/OTP required before payment) | ✅ | ❌ | ✅ | — |
| See availability slots | ✅ | ✅ | ❌ | ✅ | 🔧 `GET /api/availability` |
| Create draft consultation (slot hold) | ❌ | ✅ | ❌ | ✅ | 🔧 `POST /api/consultations/draft` |
| Authorize payment | ❌ | ✅ | ❌ | ❌ | 🔧 Stripe Checkout via orchestrator |
| View own consultations | ❌ | ✅ own | ✅ assigned | ✅ all | RLS read |
| View Meet link / join call | ❌ | ✅ own confirmed | ✅ assigned confirmed | ✅ | RLS read |
| Accept / decline consultation | ❌ | ❌ | ✅ assigned, pending only | ❌ | 🔧 `POST /api/consultations/:id/accept\|decline` |
| Cancel consultation | ❌ | ❌ | ❌ | ✅ | 🔧 (may involve Stripe cancel/refund) |
| Reschedule consultation | ❌ | ❌ | ❌ | ✅ manual | 🔧 |
| Trigger refund | ❌ | ❌ | ❌ | ✅ | 🔧 |
| Write consultation notes | ❌ | ❌ | ✅ own, post-call | ✅ view all | RLS write |
| Propose service recommendations (1–3) | ❌ | ❌ | ✅ own consultations | ✅ view | RLS write (`proposed` only) |
| Send recommendation to client | ❌ | ❌ | ❌ | ✅ | 🔧 `POST /api/admin/recommendations/:id/send` (also sends Mandrill email) |
| View recommended services | ❌ | ✅ `sent` only⁷ | ✅ own proposals | ✅ all | RLS read |
| View services catalog | ❌ | ✅ active | ✅ active | ✅ all | RLS read |
| Manage services catalog | ❌ | ❌ | ❌ | ✅ orchestrator only | 🔧 `POST /api/admin/services`, `PATCH /api/admin/services/:id`, `POST /api/admin/services/:id/activate\|deactivate`, `DELETE /api/admin/services/:id` |
| View/update service requests | ❌ | ✅ view own | ❌ | ✅ full | RLS |
| Send/read consultation messages | ❌ | ✅ own consultations | ✅ assigned consultations | ✅ read all | RLS |
| Send/read direct messages (admin ↔ consultant) | ❌ | ❌ | ✅ with the admin | ✅ with any consultant | RLS write (pairing enforced by trigger) |
| Mark a received message read | ❌ | ✅ own | ✅ own | ✅ own | RLS write (`read_at` only, trigger-guarded) |
| Schedule a message email notification | ❌ | ✅ own sent | ✅ own sent | ✅ own sent | 🔧 `POST /api/messages/:id/notification` |
| View giveaways | ❌ | ✅ active | ✅ active | ✅ all | RLS read |
| Manage giveaways | ❌ | ❌ | ❌ | ✅ | RLS write |
| Edit own profile (name, phone, avatar) | ❌ | ✅ | ✅ | ✅ | RLS write |
| Edit consultant profile (bio, hours, timezone, notice) | ❌ | ❌ | ✅ own | ✅ any | RLS write (protected columns via trigger) |
| Save consultant profile draft (pre-onboarding) | ❌ | ❌ | ✅ own | ❌ | 🔧 `PUT /api/consultant/profile` mode `draft` |
| Submit consultant onboarding (once) | ❌ | ❌ | ✅ own | ❌ | 🔧 `PUT /api/consultant/profile` mode `submit` |
| Update consultant profile after completion | ❌ | ❌ | ✅ own | ❌ | 🔧 `PUT /api/consultant/profile` mode `update` |
| Set own gender before completion | ❌ | ❌ | ✅ own | ❌ | 🔧 profile endpoint; immutable afterwards⁸ |
| Select own active countries / general availability | ❌ | ❌ | ✅ own | ❌ | 🔧 profile endpoint |
| Connect Google account | ❌ | ❌ | ✅ own | ❌ | 🔧 OAuth flow |
| See own Google connection status | ❌ | ❌ | ✅ | ✅ | 🔧 `GET /api/consultant/oauth-status` |
| Create consultant invites | ❌ | ❌ | ❌ | ✅ | 🔧 (token hashing server-side) |
| Redeem consultant invite | ✅ (with valid token) | — | — | — | 🔧 (grants role, creates consultants row) |
| Activate/deactivate consultant | ❌ | ❌ | ❌ | ✅ | 🔧 `POST /api/admin/consultants/:id/activate\|deactivate` — activation requires a fully complete profile⁸ |
| Assign consultant ↔ country | ❌ | ❌ | ❌ | ✅ | RLS write |
| View admin intervention queue | ❌ | ❌ | ❌ | ✅ | RLS read (`status = 'admin_attention'`) |
| View payments log | ❌ | ❌ | ❌ | ✅ | RLS read |
| View intake answers | ❌ | ✅ own | ✅ assigned | ✅ all | RLS read |
| Change any user's role | ❌ | ❌ | ❌ | ❌ (manual/seeded or orchestrator) | 🔧 / SQL |
| View public settings (price, currency, duration) | ✅ | ✅ | ✅ | ✅ | 🔧 `GET /api/public/settings` |
| View/manage admin settings | ❌ | ❌ | ❌ | ✅ orchestrator only | 🔧 `GET`/`PATCH /api/admin/settings` — never RLS |
| Switch Stripe mode (test/live) | ❌ | ❌ | ❌ | ✅ orchestrator only | 🔧 `PATCH /api/admin/settings/stripe-mode`; credentials stay in Railway |

---

## 2. Table access matrix (raw RLS view — cross-check against RLS_POLICY_PLAN.md)

| Table | Anon | Client | Consultant | Admin |
|---|---|---|---|---|
| profiles | ❌ | R/W own¹ | R/W own¹ | R all |
| consultants | R active | R active | R active + R/W own² | R/W all |
| consultant_invites | ❌ | ❌ | ❌ | R |
| countries | R active | R active | R active | R/W |
| consultant_countries | R | R | R | R/W |
| oauth_connections | ❌ | ❌ | ❌ | ❌ |
| consultations | ❌ | R own | R assigned | R all |
| consultation_intake | ❌ | R own | R assigned | R all |
| consultation_notes | ❌ | ❌ | R/W own | R all |
| services | ❌ | R active | R active | R all⁴ |
| service_recommendations | ❌ | R own `sent` | R/W own `proposed`³ | R all |
| service_requests | ❌ | R own | ❌ | R/W |
| payments | ❌ | ❌ | ❌ | R |
| messages | ❌ | R/W participant (consultation only)⁶ | R/W participant (consultation + direct with admin)⁶ | R all; R/W direct with consultants⁶ |
| giveaways | ❌ | R active | R active | R/W |
| app_settings | ❌ | ❌ | ❌ | ❌⁵ |

¹ excluding `role`, `email` (trigger-guarded)
² excluding `is_active`, `available_for_general`, `profile_id` (trigger-guarded)
³ insert as `proposed`, delete own while `proposed`; cannot set `sent`
⁴ **read only.** No authenticated role — admin included — holds raw `INSERT`, `UPDATE` or `DELETE` on `services`. Migration 022 revoked those grants and dropped the three admin write policies; `services_select_active` is all that remains. Catalog mutations are performed by the orchestrator under the service role, via the endpoints in §1.

⁶ **two message classes, one table.** `consultation_id is not null` = consultation message; `consultation_id is null` = direct admin ↔ consultant message (Amendment 005, migration 023). Six RLS policies split by class. **Clients cannot participate in direct messaging at all**, and a consultant cannot reach another consultant's direct thread — the `messages_direct_pairing` trigger requires exactly one admin and one consultant and rejects every other pairing, including self-send. Write access is `INSERT` as yourself plus `UPDATE` of `read_at` on messages you received; the `messages_guard_columns` trigger blocks identity and body changes. There is no `DELETE` policy.

⁵ **no browser access at all, admin included.** Migration 025 enables RLS on `app_settings` with **zero policies** and revokes all privileges from `anon` and `authenticated`, so the table is unreachable from the browser by construction rather than by convention. Admins read and write settings only through the orchestrator endpoints in `API_CONTRACT.md` §3b. The table contains no secret: Stripe credentials remain solely in Railway environment variables, and `stripe_mode` merely selects between them.

**All status transitions on `consultations` and all `payments` writes: service role only. No exceptions.**

**All `services` mutations — pricing, Stripe resource IDs, activation, deactivation, deletion: service role only, through the orchestrator. No exceptions.**

**All `app_settings` reads and writes: service role only, through the orchestrator. No exceptions.** (Amendment 007.) **Stripe mode mutation is admin-initiated and orchestrator-performed only**; no role holds a database write path to it.

⁸ **Consultant profile mutation is orchestrator-only, and scoped to self.** `PUT /api/consultant/profile` (Amendment 008) resolves the consultant from the authenticated profile through the unique `consultants.profile_id`; `consultant_id` is never accepted from a request and the body schema rejects unknown keys, so one consultant can never address another's row. A consultant may save drafts before onboarding, submit exactly once, and update afterwards. They may **not** change `is_active`, `profile_id`, or `onboarding_completed_at` — none is accepted by the endpoint and all three are trigger-guarded at the database. **Gender is settable before completion and immutable after**, keyed on the completion marker rather than `is_active`, so deactivation does not unlock it.

Admin may activate **only** a fully complete consultant and receives every unmet requirement in `error.details.missing`. Activation state remains an administrator decision; no consultant can activate themselves. Anon and client roles have no access to consultant profile mutation in any form.

**Direct browser execution of `public.save_consultant_profile` is prohibited.** The RPC is granted `EXECUTE` to `service_role` only; `PUBLIC`, `anon` and `authenticated` are explicitly revoked (migration 027). The only route to it is the orchestrator endpoint above.

A Google Calendar connection is required for **initial submission** and for **admin activation**. It is not required for an already-completed consultant's profile update — Amendment 003 degraded behaviour is preserved, and a revoked connection never clears the completion marker, unlocks gender, or deactivates the consultant.

⁷ **`sent` gates client visibility, and the payment link rides along.** A `proposed` recommendation is invisible to the client — the RLS `SELECT` requires `status = 'sent'` **and** that the parent consultation belongs to `auth.uid()`. Once sent, the client reads the recommended service through the normal `services_select_active` path, which is what exposes the configured Stripe Payment Link URL behind the **Pay {price}** CTA. No additional policy or endpoint is involved, and no consultant can make a recommendation visible: there is no consultant `UPDATE` policy on `service_recommendations`.

**Admin avatar is unchanged by Amendment 007.** It continues to use own-profile RLS write on `profiles.avatar_url` plus the existing `public-media` bucket at prefix `avatars/{auth.uid()}/*` — the same path as every other role, per the "Edit own profile" row above. No new endpoint, bucket, column or storage policy, and no avatar data in `app_settings`.

---

## 3. Page map → role gating (feeds Lovable page map, deliverable 4)

| Route | Roles |
|---|---|
| `/` `/consultation` (booking) | public |
| `/login` | public |
| `/dashboard` (client) | client |
| `/dashboard/consultation/:id` (room, Meet button, messages) | client (own) |
| `/consultant` (dashboard: pending, upcoming, past) | consultant |
| `/consultant/consultation/:id` (accept/decline, notes, recommendations) | consultant (assigned) |
| `/consultant/profile` (bio, hours, timezone, Google connect) | consultant |
| `/onboard/:token` (invite redemption + profile form) | public with valid token |
| `/admin` (interventions queue front and center) | admin |
| `/admin/consultations` | admin |
| `/admin/consultants` (+ invites) | admin |
| `/admin/services` | admin |
| `/admin/recommendations` (review → Send to Client) | admin |
| `/admin/settings` (profile, consultation, Stripe, general) | admin |
| `/consultant/profile` (onboarding and profile editing) | consultant (own) |
| `/admin/messages` (direct threads with consultants) | admin |
| `/consultant/messages` (direct thread with the admin) | consultant |
| `/admin/service-requests` | admin |
| `/admin/giveaways` | admin |
| `/admin/countries` | admin |

Role routing rule for Lovable: on login, read `profiles.role`, route to `/dashboard`, `/consultant`, or `/admin`. Guard every route group with a role check; unauthorized → redirect to own home, never a 403 page.

**Staging debug requirement (Dave):** every role-based redirect must `console.warn('[role-guard] redirected', { from, role })` in staging/dev builds, so misconfigured role routing is visible instead of looking like a broken page. No production UI for this.

---

## 4. Decision rule (for any future ambiguity)

When Troy hits an access question not covered above, apply in order:

1. Does it touch money, status, tokens, or Google? → orchestrator, service role, no RLS write.
2. Does it touch **service pricing, a Stripe resource ID, or service activation or deletion**? → orchestrator, service role, no RLS write. A service write can create or supersede a Stripe Product, Price or Payment Link, so it is never a plain database edit. (Amendment 004.)
3. Is it the user's own harmless data? → RLS.
4. Is it admin-only and side-effect-free? → admin RLS. Note that services no longer qualify: rule 2 takes precedence.
5. Still unclear? → ask Dave. Do not guess toward more access.
