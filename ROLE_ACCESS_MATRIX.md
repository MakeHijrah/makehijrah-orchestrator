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
| Send recommendation to client | ❌ | ❌ | ❌ | ✅ | 🔧 (also sends Resend email) |
| View recommended services | ❌ | ✅ `sent` only | ✅ own proposals | ✅ all | RLS read |
| View services catalog | ❌ | ✅ active | ✅ active | ✅ all | RLS read |
| Manage services catalog | ❌ | ❌ | ❌ | ✅ orchestrator only | 🔧 `POST /api/admin/services`, `PATCH /api/admin/services/:id`, `POST /api/admin/services/:id/activate\|deactivate`, `DELETE /api/admin/services/:id` |
| View/update service requests | ❌ | ✅ view own | ❌ | ✅ full | RLS |
| Send/read messages | ❌ | ✅ own consultations | ✅ assigned consultations | ✅ read all | RLS |
| View giveaways | ❌ | ✅ active | ✅ active | ✅ all | RLS read |
| Manage giveaways | ❌ | ❌ | ❌ | ✅ | RLS write |
| Edit own profile (name, phone, avatar) | ❌ | ✅ | ✅ | ✅ | RLS write |
| Edit consultant profile (bio, hours, timezone, notice) | ❌ | ❌ | ✅ own | ✅ any | RLS write (protected columns via trigger) |
| Connect Google account | ❌ | ❌ | ✅ own | ❌ | 🔧 OAuth flow |
| See own Google connection status | ❌ | ❌ | ✅ | ✅ | 🔧 `GET /api/consultant/oauth-status` |
| Create consultant invites | ❌ | ❌ | ❌ | ✅ | 🔧 (token hashing server-side) |
| Redeem consultant invite | ✅ (with valid token) | — | — | — | 🔧 (grants role, creates consultants row) |
| Activate/deactivate consultant | ❌ | ❌ | ❌ | ✅ | 🔧 or admin RLS via trigger-guarded column |
| Assign consultant ↔ country | ❌ | ❌ | ❌ | ✅ | RLS write |
| View admin intervention queue | ❌ | ❌ | ❌ | ✅ | RLS read (`status = 'admin_attention'`) |
| View payments log | ❌ | ❌ | ❌ | ✅ | RLS read |
| View intake answers | ❌ | ✅ own | ✅ assigned | ✅ all | RLS read |
| Change any user's role | ❌ | ❌ | ❌ | ❌ (manual/seeded or orchestrator) | 🔧 / SQL |

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
| messages | ❌ | R/W participant | R/W participant | R |
| giveaways | ❌ | R active | R active | R/W |

¹ excluding `role`, `email` (trigger-guarded)
² excluding `is_active`, `available_for_general`, `profile_id` (trigger-guarded)
³ insert as `proposed`, delete own while `proposed`; cannot set `sent`
⁴ **read only.** No authenticated role — admin included — holds raw `INSERT`, `UPDATE` or `DELETE` on `services`. Migration 022 revoked those grants and dropped the three admin write policies; `services_select_active` is all that remains. Catalog mutations are performed by the orchestrator under the service role, via the endpoints in §1.

**All status transitions on `consultations` and all `payments` writes: service role only. No exceptions.**

**All `services` mutations — pricing, Stripe resource IDs, activation, deactivation, deletion: service role only, through the orchestrator. No exceptions.**

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
