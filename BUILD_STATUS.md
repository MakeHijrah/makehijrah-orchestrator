# MakeHijrah Relocation OS v1.0

## BUILD_STATUS.md

**Status:** **V1.0 RELEASED**
**Release date:** 2026-08-03
**Last updated:** 2026-08-03 (consultant profile backend, orchestrator `59637eb`)
**Project owner:** MakeHijrah
**Lead architect:** Dave
**Coordinator:** Abu Mansur
**Next task:** migrations 028 and 029 review and application (029 depends on 028); consultant profile frontend integration; v1.1 planning

**Purpose:** Record what has actually been built and verified so completed work is not repeated and the next task is chosen from the real project state.

**v1.0 is released.** The final production regression passed on 2026-08-03 with no release blocker. This file now records the released state; see `V1_RELEASE_REPORT.md` for the full release record.

---

## 1. Authority and usage

This file is an execution-status record. It does not replace the governing documents.

Authority order:

1. `PROJECT_LOCK.md`
2. Approved `PROJECT_LOCK` amendments
3. `DATABASE_SCHEMA.md`
4. `API_CONTRACT.md`
5. `ROLE_ACCESS_MATRIX.md`
6. `RLS_POLICY_PLAN.md`
7. This `BUILD_STATUS.md`
8. Current source code, Git history, and deployment evidence

Rules:

- Update this file only after a feature passes its verification gate.
- Do not mark a feature complete because code exists. Mark it complete only after required browser, API, SQL, or build verification passes.
- Do not infer the next task from the original project timeline.
- Architecture, authentication, payment, calendar, RLS, messaging, route, endpoint, table, enum, status, secret-handling, or storage changes require the approval process in `PROJECT_LOCK.md` §28.
- Every prompt must state either **PLAN MODE** or **BUILD MODE**. Build Mode is not approved until the plan has been reviewed and approved.

---

## 2. Verification key

Every claim in this file carries one of these markers. They are not decorative: they record *who* verified something and *how*.

| Key | Meaning |
|---|---|
| **[D]** | Independently deployment- or source-verified in this workspace (Git, source inspection, live HTTP, build/test run) |
| **[M]** | Manually verified by the owner through browser, API, or SQL |
| **[O]** | Owner-supplied evidence that is not independently available in this workspace |

The frontend repository is **not** available in this workspace, so every frontend claim is **[M]** or **[O]** and none is **[D]**.

---

## 3. Locked architecture

### Frontend

- React/TypeScript frontend, maintained directly in Git.
- TanStack Start routing; React Query v5; shadcn/ui.
- Owns UI, authenticated safe reads, and calls to the orchestrator.
- Must not own backend orchestration.
- Must never receive the Supabase service-role key or any server secret.
- Lovable Cloud is not used.

### Database, authentication, and storage

- Supabase owns PostgreSQL, Auth, RLS, and Storage.
- Schema and RLS changes are applied through migrations or the Supabase SQL Editor.
- RLS is default-deny across the locked tables.

### Backend

- Node.js/Fastify orchestrator on Railway. Repository `MakeHijrah/makehijrah-orchestrator`, branch `main`.
- Redis (Railway) connected.
- Owns sensitive writes, state transitions, Stripe, Google OAuth/Calendar, Redis capabilities, invitations, notifications, and settings.

---

## 4. Current deployment state

### Production URLs

```text
Frontend:      https://hijrah-consultation.lovable.app
Orchestrator:  https://orchestrator-production-e24e.up.railway.app
```

### Orchestrator **[D]**

```text
Runtime commit:       59637eb7ac04a28eba33dd6bf4f3069f91f6e51f
Message:              Allow profile updates during degraded Google mode
Railway deployment:   5732804402   Successful   2026-08-03T20:03:05Z

Previous runtime:     f9054314744dda99950c22277a7704f273950311
Message:              Add admin settings runtime

Pre-release docs:     01af24381ca3b17915e671a31bb66ba31904f5ff
Message:              Reconcile v1.0 documentation
```

Verified in this workspace: local `HEAD` == `origin/main` == `01af243` before release documentation.

```text
Railway deployment: 5707559039   Successful   (last confirmed before release docs)
Railway deployment: 5723913641   Successful   (release-documentation rebuild)
```

`5707559039` is the last confirmed healthy deployment before the release-documentation rebuild. `5723913641` is the documentation-only rebuild triggered by the `Release v1.0.0` commit; it changes no runtime behaviour. `/health` returned HTTP 200 with `redis: connected`, `supabase: connected`, `supabaseTestRows: 1`, `environment: production` after both. **[D]**

### Frontend **[O]**

```text
Commit:     775716769e40a3131c5d6d913d0d7fc1b40abdfd
Message:    Wire consultant notes
Deployment: 250874ba
```

**Owner-supplied.** The frontend repository is not present in this workspace, so neither this commit, its deployment, its test suite, nor any frontend browser verification in this file was independently confirmed here.

---

## 5. Database state (production)

**[M]** owner-verified in Supabase; **[D]** migration source present and read in this workspace.

- Exactly **16** public application tables.
- `public.app_settings` is the sixteenth table.
- `app_settings` is a singleton (`is_singleton` constrained `true` + unique).
- `app_settings` has RLS **enabled** with **zero policies**.
- `anon` and `authenticated` privileges on `app_settings` are **revoked**.
- `app_settings` is **excluded** from the Supabase Realtime publication.
- `consultations.stripe_mode` exists.
- 10 PaymentIntent consultations backfilled to `test`.
- No PaymentIntent consultation remains without `stripe_mode`.
- No non-PaymentIntent consultation received `stripe_mode`.
- Latest migration **applied to production**: `migration_025_admin_settings_and_dynamic_pricing.sql`.
- Migrations **026 and 027 are applied and verified in PRODUCTION** (owner-confirmed 2026-08-04). **[M]**
- Migration **028 is authored and NOT applied** — not to staging, not to production. **[D]**
- Migration **029 is authored and NOT applied** — not to staging, not to production. **[D]**

---

## 6. Amendment index

All seven amendments are approved. All seven documents are in version control.

| # | Title | Document | Applied as |
|---|---|---|---|
| 001 | Consultation Intake Fields | `PROJECT_LOCK_AMENDMENT_001_INTAKE_FIELDS.md` | migration 004 |
| 002 | Frictionless Public Booking | `PROJECT_LOCK_AMENDMENT_002_FRICTIONLESS_PUBLIC_BOOKING.md` | migration 005 + orchestrator |
| 003 | Resilient Availability, Validated WhatsApp, Gender Matching | `PROJECT_LOCK_AMENDMENT_003_RESILIENT_AVAILABILITY_AND_GENDER_MATCHING.md` | migrations 018–020 |
| 004 | Structured Service Pricing and Stripe Payment Links | `PROJECT_LOCK_AMENDMENT_004_STRUCTURED_SERVICE_PRICING_AND_STRIPE_PAYMENT_LINKS.md` | migration 022 |
| 005 | Admin ↔ Consultant Direct Messaging | `PROJECT_LOCK_AMENDMENT_005_ADMIN_CONSULTANT_DIRECT_MESSAGING.md` | migrations 023–024 |
| 006 | Direct Presence and Delayed Email Notifications | `PROJECT_LOCK_AMENDMENT_006_DIRECT_MESSAGE_PRESENCE_AND_EMAIL.md` | no migration |
| 007 | Admin Settings and Dynamic Consultation Pricing | `PROJECT_LOCK_AMENDMENT_007_ADMIN_SETTINGS_AND_DYNAMIC_PRICING.md` | migration 025 |

---

## 7. Migration inventory

All 25 migrations are present in `supabase/migrations/`. **[D]**

| # | Filename | Purpose | Amendment | In Git | Applied |
|---|---|---|---|---|---|
| 001 | `migration_001_schema.sql` | Frozen v1.0 schema: enums, tables, indexes | — | ✅ | ✅ |
| 002 | `migration_002_rls.sql` | Default-deny RLS, helper functions, policies | — | ✅ | ✅ |
| 003 | `migration_003_stripe_webhook_rpc.sql` | Atomic Stripe webhook event processing | — | ✅ | ✅ |
| 004 | `migration_004_optional_whatsapp.sql` | `consultation_intake.phone_whatsapp` optional | 001 | ✅ | ✅ |
| 005 | `migration_005_create_draft_consultation_rpc.sql` | Atomic draft consultation + intake | 002 | ✅ | ✅ |
| 006 | `migration_006_consultation_acceptance_rpc.sql` | Consultant acceptance transition | — | ✅ | ✅ |
| 007 | `migration_007_protect_stripe_webhook_transitions.sql` | Guard webhook state transitions | — | ✅ | ✅ |
| 008 | `migration_008_fix_acceptance_rpc.sql` | Acceptance RPC correction | — | ✅ | ✅ |
| 009 | `migration_009_protect_decline_webhook_transition.sql` | Guard decline webhook transition | — | ✅ | ✅ |
| 010 | `migration_010_decline_consultation_rpc.sql` | Consultant decline transition | — | ✅ | ✅ |
| 011 | `migration_011_fix_decline_rpc_race.sql` | Decline race correction | — | ✅ | ✅ |
| 012 | `migration_012_complete_consultation.sql` | Consultation completion | — | ✅ | ✅ |
| 013 | `migration_013_recommendation_limit.sql` | Trigger: max 3 recommendations per consultation | — | ✅ | ✅ |
| 014 | `migration_014_consultant_invite_redemption.sql` | Atomic consultant invite redemption | — | ✅ | ✅ |
| 015 | `migration_015_prevent_duplicate_active_invites.sql` | One active invite per normalized email | — | ✅ | ✅ |
| 016 | `migration_016_finalize_authorization_timeout.sql` | 48-hour authorization timeout finalizer | — | ✅ | ✅ |
| 017 | `migration_017_finalize_admin_consultation_cancel.sql` | Admin consultation cancellation | — | ✅ | ✅ |
| 018 | `migration_018_consultant_gender.sql` | `consultants.gender` + check constraint | 003 | ✅ | ✅ |
| 019 | `migration_019_oauth_health_monitoring.sql` | OAuth health fields, constraint, partial index | 003 | ✅ | ✅ |
| 020 | `migration_020_consultant_onboarding_gender.sql` | 5-arg `redeem_consultant_invite`; drops 4-arg | 003 | ✅ | ✅ **[M]** |
| 021 | `migration_021_allow_consultant_general_availability.sql` | Guard permits `available_for_general` | — | ✅ | ✅ **[M]** |
| 022 | `migration_022_service_structured_pricing.sql` | `services` structured pricing + Stripe ids | 004 | ✅ | ✅ **[M]** |
| 023 | `migration_023_admin_consultant_direct_messages.sql` | Nullable `consultation_id`, 6 policies, 2 triggers | 005 | ✅ | ✅ **[M]** |
| 024 | `migration_024_direct_message_admin_resolver.sql` | `get_direct_message_admin()` | 005 | ✅ | ✅ **[M]** |
| 025 | `migration_025_admin_settings_and_dynamic_pricing.sql` | `app_settings` + `consultations.stripe_mode` | 007 | ✅ | ✅ production **[M]** |
| 026 | `migration_026_consultant_onboarding_and_gender_lock.sql` | `consultants.onboarding_completed_at`; gender and marker locks in the column guard | 008 | ✅ | ✅ production **[M]** |
| 027 | `migration_027_atomic_consultant_profile_save.sql` | `save_consultant_profile` transactional RPC, `service_role` only | 008 | ✅ | ✅ production **[M]** |
| 028 | `migration_028_consultant_avatar_projection.sql` | avatar backfill, `consultants.photo_url` public projection, RPC maintains both | 008 | ✅ | ❌ **NOT APPLIED** |
| 029 | `migration_029_normalize_consultant_working_hours.sql` | repairs named weekday keys to numeric; RPC converts named input to numeric storage | 008 | ✅ | ❌ **NOT APPLIED** |

---

## 8. Completed and verified features

### Foundation

- Frozen v1.0 schema, enums, statuses, default-deny RLS, helper functions, `public-media` storage bucket. **[M]**
- Staging profiles seeded; Egypt seeded and active. **[M]**
- Consultant activation guard; profile role-change protection; `oauth_connections` denied to the frontend. **[M]**

### Public booking (Amendments 001, 002)

- Destination → consultant → slot → details, required name/email/summary, optional WhatsApp. **[M]**
- Public draft creation through the orchestrator; account provisioned without authenticating the visitor. **[M]**
- Server-controlled price; slot hold and expiry; one-time Redis checkout capability; Stripe Checkout initiation. **[D]** source, **[M]** browser.
- OTP/magic-link access after payment. **[M]**

### Consultant invitations and onboarding

- Admin-only creation, Argon2id hashing, one-time URL, email-bound redemption, atomic promotion, replay rejection, duplicate-active prevention. **[D]** source, **[M]** browser.
- Safe `GET /api/admin/invites` metadata listing; never returns raw token, hash or URL. **[D]**
- Pending Invitations panel with expiry crossover handling. **[M]**

### Gender and resilient availability (Amendment 003)

- `consultants.gender`; onboarding captures gender atomically; 4-arg redemption RPC removed. **[D]** source, **[M]** live SQL.
- Normal and degraded availability modes; conflict protection. **[M]**

### Payments and lifecycle

- Manual-capture authorization; accept/capture; decline/cancel; 48-hour timeout cancel. **[D]** source, **[M]** live.
- Google Calendar event and Meet link creation. **[M]**
- OAuth health monitoring, alerts, idempotent notifications, recovery reset. **[D]** source, **[M]** live.

### Services (Amendment 004)

- Structured pricing; Stripe Products, Prices and Payment Links; admin service management; activation refused without a working Payment Link. **[D]** source, **[M]** live.

### Countries and giveaways

- Admin country management, live CRUD verified. **[M]**
- Admin giveaway management. **[M]**

### Messaging (Amendments 005, 006)

- Consultation messaging. **[M]**
- Direct admin → consultant and consultant → admin messaging, both directions. **[M]**
- Unread counts, thread loading, read state. **[M]**
- **Direct Presence: complete and verified.** An earlier failed observation used the wrong consultant account; the correct two-user test passed. **[M]**
- Delayed direct-message email notifications with read suppression, single Redis pipeline, `direct-message` tag, and metadata limited to `message_id`, `sender_role`, `recipient_role`. **[D]** source and 42 automated tests, **[M]** live delivery both directions.

### Admin settings and dynamic runtime (Amendment 007)

- `/admin/settings` with Profile, Consultation, Stripe and General sections. **[M]**
- Avatar upload and persistence; header avatar with immediate refresh, icon fallback, background removed when an avatar exists. **[M]**
- Global consultation price, consultation duration, support email, default timezone. **[M]**
- Stripe Test/Live selector with configured-state indicators and confirmation before Live. **[M]**
- **Live confirmation cancellation safeguard** — cancelling the dialog leaves the mode unchanged. **[M]**
- No Stripe credentials in the UI or the database. **[D]** source and automated leakage scans, **[M]** live.
- Four settings endpoints live; `GET /api/public/settings` returns the seeded `15000 / usd / 60`. **[D]**
- Dynamic price snapshot into new consultations; existing consultations retain price and `scheduled_end_at`. **[D]** source, **[M]** live.
- Dynamic consultation duration drives both slot generation and draft end time from one value. **[D]**
- Stripe clients selected per mode; existing payment operations use `consultations.stripe_mode`; dual-mode webhook verification with livemode mismatch rejection; manual capture unchanged. **[D]**

### Post-call recommendation flow

- Consultant completion after the scheduled end. **[M]**
- Consultant proposes up to three services; PostgreSQL trigger enforces the maximum. **[D]** migration 013, **[M]** live.
- Admin sends a proposed recommendation. **[M]**
- Clients cannot see proposed recommendations; live RLS confirmed — admin reads all, recommending consultant reads own, client reads only `sent` recommendations on their own consultation. **[M]**
- Consultant cannot transition `proposed` to `sent`. **[M]**
- Client sees the recommendation after the admin sends it, with service name, description, price and consultant note. **[M]**
- **Pay {price} CTA** opens the service Stripe Payment Link; unsafe or missing links handled safely. **[M]**

### Build health **[D]**

- `npm run typecheck`, `npm run typecheck:test`, `npm run build` clean.
- `npm test` — 221 tests, 221 pass, 0 fail.

---

### Consultant profile backend (Amendment 008) — v1.0.x patch

**Database.** Migrations 026 and 027 are applied and verified in **production** (owner-confirmed 2026-08-04). **[M]** Both verification scripts are self-contained: they create their own fixtures inside a transaction and roll back, so they depend on no business record.

**Migration 028 — AUTHORED, NOT APPLIED.** `migration_028_consultant_avatar_projection.sql` makes `profiles.avatar_url` authoritative, adopts a legacy `consultants.photo_url` only where the authoritative field is null, synchronises the projection, and replaces the RPC so both avatar fields are written atomically from one argument. It changes **no** RLS policy, table, column or constraint. Awaiting review; **not applied to staging or production**. **[D]**

**Orchestrator — DEPLOYED TO PRODUCTION.** Commit `59637eb`, Railway deployment `5732804402`, successful; `/health` 200 with Redis and Supabase connected. **[D]**

- `PUT /api/consultant/profile` implemented — `draft`, `submit` and `update` modes over the single transactional RPC. Consultant resolved from the authenticated profile; `consultant_id` never accepted from a request. **[D]**
- **Shared completeness evaluator** implemented — one implementation serving consultant submission, active-consultant updates and admin activation, so the three can never disagree about what a complete profile is. Returns every unmet requirement at once. **[D]**
- **Admin activation validation expanded** from three checks (timezone, working hours, Google) to the full evaluator plus `onboarding_completed`. Failure code changed `ACTIVATION_BLOCKED` → `CONSULTANT_PROFILE_INCOMPLETE`. **[D]**
- **Degraded Google update behaviour corrected.** The first implementation (`fac25a2`) wrongly required a healthy Google connection for an active consultant's profile update, which conflicted with Amendment 003. Corrected in `59637eb`: the evaluator is context-aware and Google is required only for `onboarding_submit` and `admin_activation`. A degraded connection never blocks edits, clears the marker, unlocks gender or deactivates. **[D]**
- **300 tests passing** (235 pre-existing + 65 new). Typecheck, typecheck:test and build clean. **[D]**

**Avatar architecture.** `profiles.avatar_url` is authoritative; `consultants.photo_url` is its denormalised public projection, required because public, client and anon surfaces may read `consultants` but not `profiles`. The projection avoids widening `profiles` SELECT, which would expose `email`, `phone_whatsapp` and every other private column. No runtime change was needed: the endpoint already reads and returns `profiles.avatar_url` and never references `photo_url`. **[D]**

**Migration 030 — AUTHORED, NOT APPLIED.** `migration_030_consultant_display_name_projection.sql` adds `public.consultants.display_name`, backfills it from `profiles.full_name`, and replaces the RPC so the authoritative name and its projection are written atomically from one argument. It changes **no** RLS policy, table, trigger or constraint, and copies no other `profiles` column. The data model remains 16 tables. Awaiting review; **not applied to staging or production**. **[D]**

**Display-name architecture.** `profiles.full_name` is authoritative; `consultants.display_name` is its denormalised public projection — the exact relationship migration 028 established for the avatar, for the same reason. The public booking flow renders `{consultant name} - {headline}`; `headline` already lived on `consultants` and the name did not, so the flow could not render without either widening `profiles` SELECT or projecting the one public-safe field. The service-role RPC maintains both atomically: a non-null `p_full_name` sets both, a null preserves both. Public booking may read `consultants.display_name` **without reading `profiles`**, through the pre-existing `consultants_select_active_public` policy. **[D]**

No orchestrator runtime change was needed. `PUT /api/consultant/profile` already returns the authoritative `profiles.full_name`, and — as with `photo_url`, which has zero runtime references — the projection exists for the frontend public booking reader to select directly. No new public endpoint was added. **[D]**

**Working-hours storage (Amendment 008 §8a, migration 029) — AUTHORED, NOT APPLIED.** The HTTP wire format is named weekdays; database storage is numeric `"0"`–`"6"` with `0` = sunday. The migration 027/028 RPC stored the argument verbatim, so successful saves wrote **named** keys into `consultants.working_hours_jsonb` and profile loading failed against a production row shaped `{"sunday": [...]}`. Migration 029 repairs those rows and moves the conversion into the RPC. **[D]**

Conversion boundaries: named → numeric in the RPC on the way in; numeric → named in the orchestrator response mapper on the way out. Numeric keys never cross the HTTP boundary. **[D]**

Runtime readers were made format-tolerant in the same commit — availability slot generation and the completeness evaluator both accept either format. Without that, applying 029 would have produced **zero availability slots for every consultant** and reported `working_hours` missing on every profile, because slot generation matches on luxon's named weekday. **[D]**

**Frontend — PENDING.** No frontend work has been done for this endpoint. The consultant onboarding and profile-editing interface remains unbuilt, and the admin UI still matches the retired `ACTIVATION_BLOCKED` code. See §13.

---

## 9. Accepted v1.0 limitations

These are accepted for v1.0. They are not defects and do not block release.

1. Consultation pricing is **global**; consultant-specific pricing is deferred (Amendment 007 §10).
2. Consultant acceptance timeout is **fixed at 48 hours**, hardcoded in both the orchestrator scheduler and `finalize_authorization_timeout` (Amendment 007 §7). **[D]**
3. Support email does **not** change the Mandrill sender identity, which remains governed by Railway configuration.
4. The service Stripe catalog stores **one active mode at a time** — `stripe_product_id`, `stripe_price_id` and `stripe_payment_link_url` have no mode dimension. **[D]**
5. Switching Stripe mode does **not** copy Products, Prices or Payment Links between modes.
6. Existing catalog objects may require **regeneration** after a mode switch.
7. Concurrent recommendation inserts carry a **theoretical race** around the count-based three-item trigger.
8. The timezone UI uses the current supported **shortlist**.
9. Concurrent admin settings edits are **last-write-wins**; there is no conflict detection on the settings PATCH. **[D]**
10. Temporary Mandrill failure injection remains **untested** where previously noted.

---

## 9a. Final production regression — 2026-08-03 **[M]**

Owner-executed against production. All areas passed; no release blocker.

| Area | Result |
|---|---|
| Public booking | PASS |
| Authentication | PASS |
| Consultant acceptance | PASS |
| Stripe capture | PASS |
| Calendar/Meet | PASS |
| Consultation messaging | PASS |
| Direct messaging/presence | PASS |
| Consultant notes | PASS |
| Completion/recommendations | PASS |
| Client payment CTA | PASS |
| Admin settings/avatar | PASS |
| Production safety | PASS |

Consultant notes are complete and manually verified. Direct Presence is complete and verified; an earlier failed observation used the wrong consultant account, and the correct admin-consultant two-user test passed.

---

## 9b. Non-blocking technical debt

**These are not accepted product limitations.** They are cleanup items deferred to a v1.0.x patch and are deliberately kept out of section 9.

1. The frontend `.env` file is currently tracked in Git. It contains **browser-public `VITE_` values only** — no server secret. Removal from tracking and `.gitignore` hardening are deferred to v1.0.x. **[O]**
2. Inactive mock fixtures remain bundled in the frontend build. They are **not selected in production** and are inert. Dead-code cleanup is deferred to v1.0.x. **[O]**

---

## 9c. Service purchase finance — Amendment 009, migration 040 **[D]**

Client service payments are now reconciled into the database. Previously they existed only in Stripe, so a consultant could recommend a service, a client could buy it, and the consultant earned nothing — `services.consultant_commission_bps` had existed since migration 034 with no code that could set it and none that could read it.

- `service_purchases` becomes the financial transaction record. `service_requests` is unchanged and remains the operational workflow record. **[D]**
- Payment creates a **pending** consultant earning at the per-service rate on the gross; only `POST /api/admin/service-purchases/:id/fulfill` releases it. **[D]**
- One-time purchases come from `checkout.session.completed`; recurring purchases — first period *and* every renewal — from `invoice.paid`. `payment_intent.succeeded` deliberately creates nothing, which is what prevents a duplicate record. **[D]**
- Consultant attribution is re-derived inside the RPC from `service_recommendations`; the RPC accepts no consultant or commission parameter, so metadata cannot influence who is credited. **[D]**
- Refunds create negative ledger entries through the existing `reverse_ledger_entry`; partial refunds accumulate in `refunded_amount_minor` and are proportional. **[D]**
- `POST /api/services/:id/checkout` (client) creates a Session with server-resolved trusted context. Static Payment Links continue to work, recorded unattributed when no client resolves. **[D]**
- `POST`/`PATCH /api/admin/services` accept `consultant_commission_bps`. **[D]**

Verification: `MIGRATION_040_VERIFICATION.sql`, 31 checks against PostgreSQL 16, plus 34 orchestrator tests. Migrations 038 and 039 re-verified against the same database. **[D]** source, **[ ]** not yet applied to staging or live.

**Not done:** no Stripe Connect, no automated payouts, no backfill of purchases taken before migration 040 — those exist only in Stripe and reconciling them is a separate exercise.

---

## 9d. Post-purchase service instructions — Amendment 010, migration 042 **[D]**

A client who bought a recommended service was redirected to the dashboard and told nothing. `services.post_purchase_instructions_html` is now where an admin writes the delivery content, and the client is returned to the consultation it was recommended on.

- Private column on `services`, ungranted to `anon` and `authenticated` — migration 034 part E's column list fails closed, and this is the first column to depend on that deliberately. **[D]**
- `admin_services` (migration 041) extended to expose it alongside the commission. **[D]**
- Rich text sanitized against one strict allowlist on admin write **and** again on client read; `sanitize-html` added as a production dependency. **[D]**
- `GET /api/consultations/:consultationId/services/:serviceId/instructions` returns exactly three fields, to the consultation's own client, and **only after payment is proved**. **[D]**
- **A sent recommendation alone does not reveal instructions.** Payment is proved by a recorded `service_purchases` row or by a Checkout Session verified server-side. **[D]**
- The Stripe Session path makes the success page work before `checkout.session.completed` lands — no polling. **[D]**
- Attributed checkout now returns to `/dashboard/consultation/{id}?purchase=success&service={id}&session_id={CHECKOUT_SESSION_ID}`. **[D]**

Verification: `MIGRATION_042_VERIFICATION.sql`, 13 checks against PostgreSQL 16, plus 57 orchestrator tests. Migrations 038-041 re-verified against the same database. **[D]** source, **[ ]** not yet applied to staging or live.

`GET /api/me/service-purchases` returns a client's own purchases through a narrow orchestrator projection (ten client-safe fields, newest first). **`service_purchases` RLS is unchanged and clients remain excluded from it at the database layer** — the frontend must never query that table directly. **[D]**

**Not done:** no frontend. The `/dashboard/consultation/{uuid}` route, the WYSIWYG editor, the Purchases dashboard section, the recommendation filtering and the instructions modal are all a separate build in the frontend repo, which is not present in this workspace. Static Payment Links still land on `/dashboard` and generic dashboard purchases show only a generic success message.

---

## 9e. Admin service refunds + cumulative refund fix — migration 043 **[D]**

An admin can refund a service purchase from Admin Finance without opening the Stripe Dashboard. Building it required fixing the refund accounting first.

- **Migration 043 fixes a real accounting bug.** `charge.amount_refunded` is cumulative; migration 040 treated it as a delta. Duplicate partial deliveries double-counted, a second partial **over-reversed the consultant's ledger by the first refund's amount**, and partial-then-full was silently dropped. The RPC now takes a cumulative total and applies only the difference. **[D]**
- Migration 043 also fixes a latent `record is not assigned yet` fault on the no-earning path, present in migration 040 and never reached until an unattributed refund was tested. **[D]**
- `POST /api/admin/service-purchases/:id/refund`, admin only, strict `full`/`partial` union, integer minor units. **[D]**
- **The endpoint records no accounting** — no `refunded_amount_minor`, no status, no ledger, no finance RPC. `charge.refunded` remains the sole financial recorder, asserted by tests. **[D]**
- Recurring purchases with a null PaymentIntent are repaired from `stripe.invoicePayments.list({ invoice })` and the id is **persisted before** the refund, so the later webhook can find the purchase. **[D]**
- Idempotency: Stripe key derived from purchase + amount + refunded-so-far, plus a Redis in-flight claim. **[D]**
- Refunding a recurring purchase refunds that period only and does **not** cancel the subscription. **[D]**

Verification: `MIGRATION_043_VERIFICATION.sql`, 14 checks against PostgreSQL 16 — three of which fail against migration 040 and pass against 043. Migrations 038–042 re-verified against the same database. 35 orchestrator tests added. **[D]** source, **[ ]** not yet applied to staging or live.

**Not done:** no frontend. The refund button, confirmation modal, decimal→minor-units helper and post-submit refetch are a separate build in the frontend repo, which is not present in this workspace.

---

## 9f. Admin dashboard read model — migration 044 **[D]**

`/admin` can now answer "how is the business performing" and "what needs my attention" without downloading the ledger into a browser.

- Two admin-only `SECURITY DEFINER` RPCs, read directly by the admin's Supabase client. **No orchestrator endpoint** — matches `get_admin_finance_kpis`. **[D]**
- `get_admin_revenue_by_source` returns both periods in one call, grouped by currency and ledger source type. Sources sum to the recorded total, so a scoped KPI is a subset and nothing double-counts. **[D]**
- **Recorded Revenue is ledger-derived and excludes unattributed service purchases**, whose gross is surfaced separately per currency as an alert. The UI must label it "Recorded Revenue", never "Revenue". **[D]**
- `direct_booking` is supported and silent — migration 034 admitted the source type before the feature existed. Nothing is faked. **[D]**
- Bookings count `created_at` in period excluding drafts, not consultations completed. **[D]**
- Five alerts only: admin attention, pending payouts, paid-but-unfulfilled, unattributed purchases, partial refunds. Categories that are not unambiguously errors were deliberately excluded. **[D]**
- Currencies never combined, no FX; per-currency figures are ordered jsonb arrays defaulting to `[]`. **[D]**

Verification: `MIGRATION_044_VERIFICATION.sql`, 33 checks against PostgreSQL 16, with point-in-time figures asserted as deltas against a pre-fixture baseline so they hold on a database that already has real rows. Migrations 038–043 re-verified against the same database; `get_admin_finance_kpis` asserted unchanged. **[D]** source, **[ ]** not yet applied to staging or live.

**Not done:** no frontend. The KPI cards, Action Required section, month-boundary helpers and mobile layout are a separate build in the frontend repo, which is not present in this workspace.

---

## 9g. Direct consultant booking — migration 045 **[D]**

A consultant publishes a personal booking page at a **root URL** (`makehijrah.com/aisha-rahman`) and sets their own price. PROJECT_LOCK Amendment 011.

- **No second booking system.** A direct booking is an ordinary consultation: same table, same statuses, same draft hold, same double-booking exclusion, same checkout, capture, completion, refund and 48-hour timeout. No `direct_consultations` table, no parallel payment record, no second account path. `consultations.booking_source` is the only distinguishing column. **[D]**
- **Slug authority is split.** The database owns format and uniqueness; the orchestrator owns the **reserved** set, because that list is a fact about the frontend's routing table and would drift if frozen into a migration. **No `reserved_slugs` table.** **[D]**
- **Effective price = `max(configured, platform default)`**, computed in one function and used by **both** the public page's displayed price and the draft consultation's `price_cents`. The public projection publishes only the effective figure, so a frontend cannot render a stale price while checkout charges a higher one. **[D]**
- **Two ledger components:** the standard-price portion at the platform's consultation rate (5000 bps today, basis `direct_booking_standard`), and only the premium above it at **8000 bps** (basis `direct_booking_premium`). The premium row is written only when the premium is positive. Migration 034 had already admitted both components and both bases; this is the first use of them. **[D]**
- **The locked example holds:** 15000 default, 20000 direct → consultant **11500**, platform **8500**. **[D]**
- **Refunds are CUMULATIVE**, migration 043 semantics. `p_refunded_total_minor` is Stripe's `charge.amount_refunded`; the split across components uses the remainder for the premium rather than a second rounding, so the component reversals sum to the refund **exactly**. First partial, redelivery, second partial, partial-then-full and duplicate full all behave. The pre-043 delta bug is not reproduced. **[D]**
- **The two finance paths cannot cross.** The webhook may not read `booking_source` (Amendment 004 §10.3.3), so the dispatch tries the direct RPC first and falls back on `FINANCE_NOT_DIRECT_BOOKING` — the database decides, under the same row lock as the write. Migration 045 also guards `record_consultation_earning` with `FINANCE_NOT_STANDARD_BOOKING`, which prevents two earnings for one payment. **[D]**
- **Server authority.** The draft endpoint accepts no price, currency, `booking_source`, commission, split or earnings value; a request carrying both a slug and a `consultant_id` is refused rather than resolved by precedence. A consultant edits only their own settings (resolved from the token; the API takes no consultant identifier). An admin may **disable** a page but may not rename a link or set a price. **[D]**
- **Amendment 002 preserved.** Public draft creation may still provision an account before payment; that is not authentication, and dashboard access still requires post-payment OTP / magic-link. **[D]**
- **Analytics unchanged.** Migration 044 groups by `source_type`, so `direct_booking` surfaces on its own row with no dashboard change. **[D]**

Verification: `MIGRATION_045_VERIFICATION.sql`, **27 checks against PostgreSQL 16**, with `app_settings` pinned to the locked example inside the rolled-back transaction so the finance assertions are exact rather than dependent on staging's current price. Migrations 038–044 re-verified against the same database. Orchestrator: **603 tests pass**, including the slug reserved list, the public projection's exact key set and leak markers, every refusal in the settings API, the two-component split, release idempotency, the full cumulative refund sequence, and the webhook passing Stripe's cumulative total. **[D]** source, **[ ]** not yet applied to staging or live.

**Not done:** no frontend. The root-URL route, the booking page, the consultant settings panel and the admin control are a separate build in the frontend repository, which is not present in this workspace. **The frontend must render `effective_direct_booking_price_cents` and must not reproduce the price rule.**

---

## 9h. Generic booking draft regression — migration 046 **[D]**

A production outage caused by migration 045, found and fixed. Every booking — generic and direct alike — answered `500 INTERNAL_ERROR` after inserting its consultation, and each failed attempt left a draft holding the slot.

- **Root cause.** Migration 045 dropped `create_draft_consultation` to add a `booking_source` argument and rewrote the body, returning `(consultation_id, created_at)` where migration 005 returned five columns. The orchestrator reads `hold_expires_at` off that row and turns it into the Redis checkout capability's TTL; the missing column read as `undefined`, `Date.parse` gave `NaN`, the TTL was refused, and `createCheckoutCapability` failed **before touching Redis**. Redis, Stripe, environment and configuration were not involved. **[D]**
- **Three further regressions in the same function**, all fixed: migration 045's added overlap guard raised `SLOT_TAKEN` as **P0001** where the repository maps only **23505**, so a genuine double booking became a 500 with an orphaned draft; that guard was also broader than the index it duplicated, permanently blocking any slot left in `admin_attention`, `completed` or `refunded`; and the three migration 005 validations (`end > start`, `price > 0`, lowercase currency, all `22023`) plus `nullif(trim(p_phone_whatsapp), '')` had been dropped. **[D]**
- **Migration 046 restores migration 005's body verbatim**, with only `p_booking_source` and the `booking_source` insert added, and the migration 036 hardened `search_path` and ACL posture. The overlap guard is removed entirely — `unique_reserved_consultant_slot` is again the sole authority on slot conflicts, and is not modified. **[D]**
- **`abandon_draft_consultation(uuid)`**, new. Cancels a consultation matching `id AND status = 'draft'`, so it cannot touch a booking whose payment preparation succeeded and is idempotent by construction. `cancelled` sits outside the index's status list, so the slot frees immediately. **[D]**
- **`prepareDraftConsultation`** now owns the insert and the capability together, because they cannot share a transaction — one is PostgreSQL, one is Redis. On any post-insert failure it releases the slot. The cleanup's outcome is logged separately and **never changes the response**; a cleanup that itself fails is reported as a stuck slot, and the client still hears the error that actually stopped their booking. No cleanup runs on success, and none runs on a 23505 — that row belongs to somebody else. **[D]**
- **The `expire-drafts` job in `API_CONTRACT.md` §5 has never been implemented.** That is why an orphaned draft held its slot indefinitely rather than for thirty minutes. Still not implemented; the compensation above covers the failure path, not abandonment. **[ ]**
- **Migration 045's finance guards are untouched.** `FINANCE_NOT_STANDARD_BOOKING` on `record_consultation_earning` and the three direct booking RPCs are unrelated to this regression and remain exactly as built. **[D]**

Verification: `MIGRATION_046_VERIFICATION.sql`, **24 checks against PostgreSQL 16**, which **invokes** the RPC and asserts `pg_get_function_result` column by column. Migrations 038–045 re-verified; clean-room replay of 001–046 and a second run of 046 for idempotency. Orchestrator: **616 tests pass**, including a stub that reproduces migration 045's broken two-column row and asserts it is refused at the repository boundary with the slot released. **[D]** source, **[ ]** not yet applied to staging or live.

**Operational, not in the migration:** drafts stranded by this bug must be cancelled by an operator. Scope is the established thirty-minute hold, not any deployment window — the review and update statements are in `MIGRATION_046_VERIFICATION.sql` part 7. This workspace has no production credentials and the cleanup has **not** been run.

### Standing regression rule

**Any migration that replaces an RPC the orchestrator calls must have a verification that INVOKES it and asserts its runtime result contract, column by column.** Migration 045's verification checked that the function existed at the right signature and that its ACL was correct, and passed, because both were true. The orchestrator tests passed too — they stub the RPC, and the stub returned the shape the code expected rather than the shape the database produced. Neither layer ever called the function. A signature says nothing about what comes back.

---

## 9i. Draft slot lifecycle — migration 047 **[D]**

Two ways an unpaid draft could hold a consultant's slot forever, both closed.

- **A draft IS the slot hold.** `unique_reserved_consultant_slot` covers `draft`, so while the row exists nobody else can book that time. The hold is 30 minutes, defined once in SQL beside `hold_expires_at`. **[D]**
- **Superseded drafts.** A visitor who reached the payment step, went back and picked a different time left the first slot reserved — nothing told the server. `POST /api/consultations/draft` now accepts `supersedes_consultation_id` + `supersedes_checkout_token`, and releases the previous draft **only after the replacement is fully prepared**. If the replacement fails at any point the previous draft is untouched: the visitor never gives up a booking for one they did not get. **[D]**
- **The token is the authorisation, not the id.** The existing checkout capability — 32 random bytes, stored only as a sha256 digest, bound to one consultation, expiring with its hold — already is a bearer capability for exactly that draft. No new token, no new table, no new trust. A guessed id, a token bound to a different consultation, and a booking past `draft` are each refused, the last by the database. **[D]**
- **Same-slot reselection returns the existing draft.** Availability counts a `draft` as busy, so a visitor re-picking the time they already hold would otherwise be refused by their own booking. The claim is resolved before slot validation for exactly this reason. No second row, no cancellation, and the token they sent is handed back. **[D]**
- **`expire_stale_draft_consultations(p_limit)`** — one set-based statement, oldest first, `FOR UPDATE SKIP LOCKED`, `status = 'draft'` the only status it can read and `cancelled` the only one it can write. Idempotent; a cancelled row no longer matches. Serves `idx_consultations_stale_drafts`, which migration 001 created for this job and which nothing used until now. **[D]**
- **The `expire-drafts` worker exists at last**, on a **60-second** interval — worst-case slot release 30m00s–31m00s. Simpler than the authorization-timeout worker: no per-row due-set and no per-row lock, because one set-based UPDATE needs neither. The Redis cycle lock is an optimisation that fails open; the database is the correctness boundary. **[D]**
- **`DRAFT_HOLD_MINUTES` consolidated** into `draft-hold.ts`. It was private to `checkout.service.ts` and about to be copied a second time; there is now one copy in TypeScript and the authoritative one in SQL. **[D]**
- **No new anti-abuse controls**, deliberately. The public draft rate limit stays at 5/minute per IP — a test now reads it off the registered route so a change is caught. No CAPTCHA, no per-client draft cap, no unload/`sendBeacon` release, no public release endpoint, no booking-holds table. **[D]**

Verification: `MIGRATION_047_VERIFICATION.sql`, **20 checks against PostgreSQL 16**, invoking the RPC — the thirty-minute boundary asserted from both sides, and one consultation per status (`payment_authorized`, `pending_acceptance`, `confirmed`, `captured`, `completed`) aged well past the cutoff to prove age alone cannot cancel a real booking. Migrations 038–046 re-verified. Orchestrator: **639 tests pass**. **[D]** source, **[ ]** not yet applied to staging or live.

**Frontend contract, not built here.** The frontend must retain the active `consultation_id` and `checkout_token` across backward navigation — storage that survives it, not React state alone — and send both as `supersedes_*` when submitting a replacement draft. It must **not** release the old slot merely because the visitor navigated backward, and must not use unload or `sendBeacon`. A frontend that does none of this still gets 30-minute expiry.

---

## 9j. Same-slot draft intake refresh — migration 048 **[D]**

A correctness gap opened by migration 047's same-slot short circuit, closed before the frontend build depends on it.

- **The bug.** A visitor reaches Payment, goes back to **Details**, corrects a typo'd email or name, re-picks the **same** time, and submits. Migration 047 returned the held draft unchanged — right about the slot, wrong about the form. Every edit was silently discarded and the consultant received the version the visitor had already rejected. **[D]**
- **Why the email matters most.** `consultation_intake.email` is not a dead snapshot: the decline, authorization timeout, admin cancellation, recommendation and message notifications are all sent to it. A discarded correction there means mail to an address the visitor knows is wrong. **[D]**
- **`refresh_draft_consultation_intake(...)`** — `SECURITY DEFINER`, pinned search_path, service_role only, matched on `id AND status = 'draft'`. Rewrites `full_name`, `email`, `phone_whatsapp`, `answers_jsonb`, `client_timezone`, `country_id` and `client_profile_id`, with migration 005's `nullif(trim(...), '')` on the WhatsApp number. Idempotent. **[D]**
- **`client_profile_id` is refreshed too, and that is deliberate.** It is *derived* from the intake email under Amendment 002, so refreshing the address while leaving the profile behind would produce exactly the divergence this fixes. It moves only while the row is a draft, before any payment, and only to the profile the visitor's own submitted email resolves to — precisely what a fresh draft would have done. The orchestrator passes null when the address is unchanged, so an ordinary refresh costs no account lookup. **[D]**
- **Nothing else can move.** The consultant, the schedule, the status, the price, the currency, the booking source, every Stripe identifier and every payment timestamp are not parameters of the function, so no caller can ask for them. **[D]**
- **Eligibility is re-validated first.** The consultant gender/destination check was hoisted above the supersede resolution so it runs against the **submitted** country and preference — a visitor who changes their destination on the way back cannot end up holding a consultant who does not serve it. **[D]**
- **Failure leaves the hold intact.** A refresh failure returns `500 INTERNAL_ERROR` (write failed) or `409 DRAFT_UNAVAILABLE` (draft expired or cancelled in between). The draft is not cancelled, no replacement is created, and the checkout capability is **not** consumed — deliberately not dressed up as a slot error, which would send the visitor to fix the wrong thing. **[D]**
- **Different-slot supersede is unchanged**, as is migration 046's compensation and migration 047's expiry. **[D]**

Verification: `MIGRATION_048_VERIFICATION.sql`, **26 checks against PostgreSQL 16**, invoking the RPC. Part 3 snapshots the whole consultation row as `jsonb` before the refresh and compares it key by key afterwards, excusing only the three mutable columns — so a payment or finance column added to `consultations` later is covered the day it exists, without anybody remembering to write a check for it. Migrations 038–047 re-verified. Orchestrator: **647 tests pass**, including one that asserts the exact argument key set reaching the RPC, so a later spread of the request body would fail rather than quietly widen the surface. **[D]** source, **[ ]** not yet applied to staging or live.

**Frontend contract, unchanged from §9i** and now safe to build against: retain `consultation_id` + `checkout_token` across backward navigation and send them as `supersedes_*`. Editing details and re-picking the same slot now persists those edits instead of discarding them.

---

## 9k. Consultant slug governance — migration 049 **[D]**

Consultant slugs become admin-managed, generated by default, and closed to direct browser writes. PROJECT_LOCK Amendment 012.

- **Self-service removed, deliberately.** A slug is a **root URL** in the same namespace as every top-level route the platform owns, and a link a consultant can rewrite breaks every card, signature and post already carrying it. `consultant_slug` is gone from the consultant PATCH schema — and because that schema is strict, a client still sending it gets a `400` rather than a silent no-op. **[D]**
- **Self-service preserved where it belongs.** `direct_booking_enabled` and `direct_booking_price_cents` remain the consultant's, through the same endpoint, with the same price floor. They may still read their slug and booking URL. **[D]**
- **Default generation at activation**, from `display_name` with `profiles.full_name` as the fallback — a projection and its source, not two name authorities. Only when the slug is null; never on a rename; never twice. Generation failure **blocks activation**, because an active consultant with no link is a half-finished state somebody would repair by hand. It does **not** enable direct booking. **[D]**
- **Collision strategy is asymmetric on purpose.** Generated defaults suffix (`john-smith-2`, `-3`), skip reserved bases (a consultant called Admin gets `admin-2`), truncate before suffixing so 60 chars holds with no doubled hyphen, try 20 sequential candidates, then fall back to a short random tail. Admin-entered slugs **never** suffix — somebody typed that one, so a collision is refused. The unique index stays the final authority; `23505` is caught and the next candidate tried. **[D]**
- **`PATCH /api/admin/consultants/:id/direct-booking`**, strict, one key, reusing the same validation path. Stable reasons: `SLUG_EMPTY`, `SLUG_TOO_SHORT`, `SLUG_TOO_LONG`, `SLUG_INVALID`, `SLUG_RESERVED`, `SLUG_TAKEN`. No raw constraint error reaches HTTP. **[D]**
- **Migration 049 closes a real bypass.** `consultants_update_own_or_admin` dates from migration 002, so a consultant with their own JWT could write all three columns through PostgREST — taking a reserved slug, publishing a page an admin had not activated, or pricing below the platform's own consultation. The price floor is enforced *only* by the orchestrator by design, so the direct write was the whole of the way around it. **[D]**
- **Reserved set extended** after a route audit: `contact`, `about`, and the hyphenated policy routes `privacy-policy`, `terms-of-service`, plus `terms-and-conditions`, `cookie-policy`, `refund-policy`, `sign-in`, `sign-up`, `log-in`, `log-out`, `reset-password`, `forgot-password`, `verify-email`, `my-bookings`, `not-found`, `error`, `health`. These are **not** redundant with `privacy`/`terms`: the set is matched after normalization, and `/privacy-policy` is a different route from `/privacy`. **[D]**
- **Authority split unchanged.** Database owns format, length and uniqueness; orchestrator owns the reserved set, the price floor, the publish preconditions and admin-only slug management. **No slug validation was added to SQL.** No policy added, removed or narrowed; no new anon access. **[D]**
- **Backfill is a script, not SQL** — `npm run backfill:consultant-slugs`. Reimplementing the normalizer and reserved set in a migration would create rules that could disagree with the originals. Idempotent, never overwrites, active consultants only, does not enable direct booking, logs every id beside its link, continues past a consultant it cannot name, exits non-zero on failure. **[D]**

Verification: `MIGRATION_049_VERIFICATION.sql`, **16 checks against PostgreSQL 16**, which **exercises** the guard rather than reading its source — it takes the `authenticated` role with the consultant's JWT subject and attempts each write a browser could attempt, then takes `service_role` and proves the sanctioned path still works. Migrations 038–048 re-verified. Orchestrator: **686 tests pass**. **[D]** source, **[ ]** not yet applied to staging or live.

**Known limitation, recorded rather than discovered later:** an admin changing a slug **breaks the old URL**. There is no redirect and no slug history; anyone holding the previous link gets a 404. Making changes administrative is the mitigation, not a fix. See Amendment 012 §9.

**Frontend: shipped and verified.** The consultant settings panel no longer sends `consultant_slug`, and the admin consultant page manages it. Implemented and manually verified — see section 9n. Production consultant slugs were corrected directly and direct-booking slug behaviour is live verified, so no backfill run is outstanding.

---

## 9l. Direct booking setting ownership — no migration **[D]**

A governance correction settling who writes each of the three direct booking settings. PROJECT_LOCK Amendment 013, which supersedes one rule of Amendment 012.

- **The model.** Admin writes `consultant_slug` and `direct_booking_enabled`; consultant writes `direct_booking_price_cents`; the effective price is server-derived and written by nobody. Both roles read all four. **[D]**
- **The line is not arbitrary.** What is published under the platform's own domain is the platform's decision — a slug is a root URL in the platform's namespace, and enabling puts a page live under the platform's brand, the same kind of decision activation already is. What somebody charges for their own time is theirs, and an admin who could set it could set what that consultant earns. **[D]**
- **`direct_booking_enabled` moved from consultant to admin.** That is the whole change from 012. **[D]**
- **Both schemas are strict and neither carries the other's field**, so sending one is a `400` rather than a silent no-op — the right answer for fields that used to work. The admin body also requires at least one supported field: answering 200 to a request that changes nothing would hide whatever mistake produced it. **[D]**
- **Preconditions unchanged and applied to the new actor.** An admin enabling a page is held to exactly what a consultant was: active, slug present, price present, price at or above the platform minimum. The active check now runs **first** — it is the one that cannot be worked around, and sending an admin to set a price for a consultant who cannot be published either way points them at the wrong problem. **[D]**
- **No "effective price ≥ minimum" refusal, deliberately.** The effective price is `max(configured, platform)` and is at or above the minimum by construction; a check for a case that cannot arise would be dead code, and would wrongly block enabling a consultant whose stored price predates a price rise. **[D]**
- **Disabling turns the page off and nothing else** — slug preserved so re-enabling restores the same URL, configured price preserved so it need not be set again. **[D]**
- **Two entry points, separate input types**, rather than one function taking an actor. There is no object that can carry "any direct booking field", so a later edit cannot widen an actor's reach by adding a property. Validation and the write are shared and defined once: ownership differs, the rules do not. **[D]**
- **`adminDisableDirectBooking` removed from the repository** — the disable endpoint now delegates to the shared admin path, and the old function was dead. **[D]**
- **No migration.** Migration 049 already blocks direct browser writes to all three columns and is untouched. No schema, RLS, policy or finance change. **[D]**

Read contracts are **unchanged** for both roles — same eight keys, same envelope — and asserted key-by-key in the tests.

Verification: migrations 038–049 re-verified (no migration added). Orchestrator: **689 tests pass**, including the full ownership matrix on both endpoints, disable-preserves-slug-and-price, admin held to every publish precondition, and both GET contracts asserted as exact key sets. **[D]** source, **[ ]** not yet applied to staging or live.

**Frontend: shipped and verified.** The consultant settings panel no longer sends `consultant_slug` or `direct_booking_enabled` — it sends only `direct_booking_price_cents` — and the admin consultant page manages both. Implemented and manually verified; see section 9n.

---

## 9m. Direct booking Stripe cancel routing — no migration **[D]**

A visitor who abandoned Stripe Checkout on a **direct** booking was returned to `/consultation?booking=cancelled&cid=…` — the generic consultation page, not the consultant's own page they had been booking from. They landed somewhere they had never been, with no route back.

- **Root cause.** `cancel_url` in `checkout.service.ts` was a literal `${APP_URL}/consultation`, written before direct booking existed and never revisited. The checkout projection did not read `booking_source` or `consultant_id` at all, so the information needed to decide was not in the function. **[D]**
- **Standard bookings are unchanged** — still `{APP_URL}/consultation?booking=cancelled&cid={id}`. **[D]**
- **Direct bookings return to the consultant's page** — `{APP_URL}/{consultant_slug}?booking=cancelled&cid={id}`. **[D]**
- **Server remains the sole authority for Stripe return URLs.** The request carries no cancel URL, no slug and no booking source, and there is nowhere for one to arrive: `createStripeCheckout` takes a single consultation id. `booking_source` and `consultant_id` come off the consultation row; the slug comes off the consultant row. A test asserts the function's arity so a later options parameter fails there rather than becoming an open redirect. **[D]**
- **The slug is read, never re-derived.** Regenerating it from the consultant's name would reproduce the generator's collision suffixes and could point at a different consultant entirely — `john-smith` when the booking belongs to `john-smith-2`. **[D]**
- **A direct booking whose consultant has no slug refuses checkout** rather than falling back to the generic page. That state should not exist — activation generates a slug and neither sanctioned write path can null it — so creating a payment session on top of it would hide a data integrity problem behind a successful checkout. **[D]**
- **One builder, one origin normalisation.** `buildCancelUrl` is the only place a cancel URL is composed; the direct branch reuses `buildDirectBookingUrl`, so an `APP_URL` with a trailing slash cannot produce `//slug`. Query values are percent-encoded. **[D]**
- **Success URL and manual capture untouched** — this was cancel routing only, and a test reads both off the same recorded session object so a change to either fails. **[D]**

Verification: **702 orchestrator tests pass**, including nine new ones driving the real service against a patched Stripe client and asserting the recorded `cancel_url` as a parsed URL. No migration, no schema, RLS, finance or lifecycle change. **[D]** source, **[ ]** not yet applied to staging or live.

---

## 9n. Finance + direct booking release baseline — FROZEN **[D]**

The finance and direct booking feature group has completed backend regression, frontend automated verification and manual browser verification, and is frozen as the current verified release baseline.

**Full record: `FINANCE_DIRECT_BOOKING_BASELINE.md`.** That document carries the evidence marks, the per-case results, the commit list and the frozen rules. This section is the pointer, not a second copy.

**Freeze statement:**

> Finance, payouts, recommendation purchases, admin finance analytics, and independent consultant direct booking have completed backend regression, frontend automated verification, and manual browser verification. This feature group is frozen as the current verified release baseline. Future changes require a separately approved scope and regression appropriate to the affected subsystem.

**This freezes the feature group only.** It is not a statement that the MakeHijrah application is production-complete; `V1_RELEASE_REPORT.md` remains the authority on the v1.0.0 product release and is unchanged.

**Verified — backend, in this workspace [D]:** migrations 001–049 replayed with 0 failures; backend suite **702/702**; typecheck, typecheck:test and build clean; migration verification suites 038–049 at 138 pass-notices / 0 errors; financial reconciliation **PASS** across all nineteen cases — standard economics, direct booking economics, snapshot immutability, balance reconciliation, the full payout lifecycle, refunds and reversals, negative-balance behaviour, admin adjustments, service purchase finance, multi-currency separation, idempotency and authorization. Backend cleared for frontend verification.

**Verified — frontend [O] / manual [M]:** automated suite passed; the platform revenue CSV missing-export defect was fixed in frontend commit `00e676e`; manual consultant finance, admin finance, client role-gating, consultant/admin number reconciliation, direct booking finance, payout UI, CSV exports and mobile finance all **PASS**; no remaining finance defects reported.

**Backend commits in the baseline [D]:** `4326df4` (direct booking setting ownership correction), `25e4bf0` (direct booking Stripe cancel return URL). Live verification of both **[M]**.

**Frontend verified release commits [O]** — recorded as supplied; the frontend repository is not present in this workspace and these were not resolved here: `ddeaf41`, `fdff975`, `b87d90e`, `8c34b06`, `b49502f`, `554a758`, `00e676e`.

**Frozen finance rules:** integer minor units only; append-only ledger; standard 50/50; direct booking base 50/50 with the premium above the default at 80/20 in the consultant's favour; historical snapshots immutable; consultation earnings available after completion; service purchase earnings created on payment and available after fulfilment; refunds append negative entries; admin corrections append adjustments; payout requests reserve; rejected and cancelled payouts release; paid payouts terminal; negative balances permitted after post-payout refunds and offset by future earnings; currencies separate; no FX; no automatic payouts; PAY and ADJ references globally monotonic under the current implementation.

**Technical debt carried forward, not fixed:** stale verification artifacts in migrations 026, 027, 030, 031, 032, 033, 035 and 037 — low-priority test-artifact debt, not a production finance defect, behaviour re-covered by the later suites. And CSV formula-injection protection causing negative exported amounts to import as text in spreadsheet applications — non-blocking export-format debt, no release blocker.

---

## 9o. Direct-booking-only + calculator terms — migration 050 **[D]**

A consultant may say "I only want direct bookings", and their settings screen can now show a price ↔ earnings calculator without hardcoding commission percentages. PROJECT_LOCK Amendment 014.

- **`consultants.direct_booking_only`**, boolean, default false — so no existing consultant's eligibility changes. Deliberately not a reuse of `is_active`, `available_for_general` or `direct_booking_enabled`; none of those means this one, and overloading any would make two intents share one switch. **[D]**
- **The exclusion is an RLS policy, and that was the decisive audit finding.** There is no orchestrator endpoint that lists consultants for `/consultation` — the chooser reads `consultants` directly. A filter in orchestrator code cannot remove a consultant from a list the orchestrator does not produce, so `consultants_select_active_public` now reads `is_active = true and direct_booking_only = false`. One policy covers country-specific and general-information selection together, because both read it. **[D]**
- **A companion policy restores what the narrowing would have broken.** Without it, a client who had already booked the consultant would lose their name off their own dashboard. Scoped to `direct_booking_only = true` plus an existing consultation, so it returns exactly what was removed and nothing more. **[D]**
- **Invisible is not unbookable.** `validateDraftConsultantGender` refuses a *standard* draft naming a direct-booking-only consultant (`reason: consultant_direct_booking_only`); a stale list or hand-crafted call gets nowhere. Direct bookings pass straight through — the consultant is refusing the platform's chooser, not their own clients. **[D]**
- **Guarded at the database.** Migration 050 extends `guard_consultants_columns` with the new column, joining the other three direct-booking settings. Consultant-managed but orchestrator-written, exactly as the price is. **[D]**
- **Direct-booking-only with the page disabled is accepted, not refused** — a state the consultant chose. Refusing it would let an admin-owned setting block a consultant's own preference. **[D]**
- **Calculator terms published read-only** on both GETs: `standard_booking_price_cents`, `base_consultant_commission_bps`, `premium_consultant_commission_bps`. Neither PATCH schema carries them, so sending one is a 400. **[D]**
- **Provenance, and it is not symmetrical.** The base rate is **read** from `app_settings.consultation_consultant_commission_bps` — the row the ledger RPCs read; the settings provider projection was widened and no copy exists. The premium rate has **no table to read**: its only authority is `c_premium_bps constant integer := 8000` inside `record_direct_booking_earning`, so it is **mirrored** as `DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS`. **That constant is not the financial authority** and the module says so at the top. **[D]**
- **The mirror cannot drift silently.** `MIGRATION_050_VERIFICATION.sql` check 2 reads the ledger function's own source, with comments stripped, and fails if the literal is no longer 8000 — before any consultant sees a figure the ledger will not honour. **[D]**
- **No finance change.** Verification asserts all eleven finance RPCs and the ledger append-only trigger are intact; the frozen baseline's rules are untouched. **[D]**

Verification: `MIGRATION_050_VERIFICATION.sql`, **20 checks against PostgreSQL 16**, exercising the policies as `anon`, as an unrelated client, as the booking client, as the consultant, as an admin and as `service_role` rather than reading their source. Migrations 045–049 re-verified; 050 re-run for idempotency; clean replay 001–050. Orchestrator: **722 tests pass**.

**Also fixed:** `MIGRATION_045_VERIFICATION` check 27 and `MIGRATION_049_VERIFICATION` check 15 asserted a hard-coded policy **count** of 3. Migration 050 legitimately added a fourth and both failed while nothing was wrong — the same brittleness that leaves migrations 030–033 asserting a table count of 16. Both now assert the pre-existing policies **by name and by meaning**, which is what those checks were actually for. **[D]**

**Not done:** no frontend. The checkbox, the bidirectional calculator, the tooltip and client-side `/consultation` filtering are a separate build.

---

## 9p. Consultant "new booking to accept" email — no migration **[D]**

A consultant is now emailed when a client books them and the payment is authorized. PROJECT_LOCK Amendment 015. **This is a v1.0.x production patch, not new scope.**

- **It was specified and never built, and the audit is the finding.** `API_CONTRACT.md` section 6 has always listed *"Payment authorized (webhook) → consultant ('new booking to accept')"*. The webhook scheduled **no notification of any kind**. A consultant learned of a booking only by opening their dashboard, while a 48-hour acceptance window ran down and the authorization expired on its own. **[D]**
- **Sent at payment authorization**, per the contract — the first moment a real commitment exists. Deliberately not at draft creation: a draft holds a slot for thirty minutes and most expire unpaid, so emailing then would train consultants to ignore the email that matters. **[D]**
- **The webhook schedules; a worker sends.** Amendment 004 section 10.3.3 restricts the webhook path to RPC calls, and `stripe-webhook.test.ts` enforces it with a stub that throws on any direct table access. So scheduling is Redis-only with no database read, and every lookup happens later in `booking-notification.worker.ts` — the same due-set, per-consultation-lock, ten-second-poll, sixty-second-retry shape as the three existing notification workers. A Mandrill outage cannot affect a payment. **[D]**
- **Idempotent across Stripe redeliveries.** `booking-notification:done:<id>`, checked when scheduling *and* when processing, thirty-day TTL; payload and due-set entry both written `NX` so a redelivery keeps the original queue position rather than pushing the email further out. **[D]**
- **No migration and no marker column**, deliberately. Redis already holds this state for every other notification, the marker is disposable operational state rather than a business fact, and a column would have meant a table write from a path not allowed to make one. **[D]**
- **Suppression is permanent, not a retry.** If the consultant accepted or declined, or the authorization was cancelled, before the worker ran, the job is dropped **and marked done** so a redelivery cannot revive it. Telling a consultant to accept something they already accepted is worse than saying nothing. **[D]**
- **No finance change.** No ledger row, split, snapshot, payout or refund behaviour; no finance RPC called, altered or reordered. **[D]**

Verification: **745 orchestrator tests pass** (up from 722), `build`, `typecheck` and `typecheck:test` all clean. 19 new tests in `booking-notification.test.ts` cover scheduling, redelivery, the email's recipient/tag/content, HTML escaping, general-vs-country topic, single-send idempotency, all five suppression paths, and Mandrill/database retry. 4 new tests in `stripe-webhook.test.ts` assert the webhook queues it on authorization only — and queues it **without reading a table**, since the section 10.3.3 stub is still in force.

**Not done, and recorded rather than assumed:** the **client** half of the same contract row ("authorized, not charged yet") is still unbuilt, as are the acceptance and both reminder rows. Three of the email map's six rows are implemented. `API_CONTRACT.md` section 6 now carries a **Built** column so this is visible on the contract itself.

---

## 9q. Acceptance recovery after a post-capture failure — migration 051 **[D]**

A consultant whose acceptance captured the payment and then failed to create the Google Calendar event was **permanently locked out** of that consultation. PROJECT_LOCK Amendment 016. **Production defect fix, v1.0.x patch.**

- **Reported from production**, with the consultant's screen showing "Payment may have been captured, but calendar setup failed. Admin review is required." beside an Accept button that returned an error every time. **[D]**
- **The client had paid.** The capture happens *before* the calendar call, so `calendar_failed` always means the money was taken. No calendar event, no Meet link, and no route in the product to move it forward — the admin console can only cancel and refund. **[D]**
- **Two layers disagreed, and both were wrong.** `finalize_consultation_acceptance` has allowed recovery from `admin_attention` since **migration 008** — but the service guard refused `admin_attention` outright, so the retry never reached the RPC, and migration 008's recovery branch was **unreachable dead code that had never once run**. Meanwhile the RPC whitelisted only `calendar_created_confirmation_failed`, never `calendar_failed` — the earlier and more common of the two post-capture failures. **[D]**
- **Both reasons are now recoverable, and the whitelist stays a whitelist.** Both mean the consultant accepted, the money was captured, and an infrastructure step after the capture failed. Retrying is safe because capture short-circuits on an already succeeded PaymentIntent and the RPC is idempotent on replay. `declined`, `timeout` and an admin cancellation note stay refused — each cancelled or refunded the payment. **[D]**
- **A latent NULL hole closed.** Migration 008 compared with `<>`, which is NULL against a NULL reason, so the guard was NULL and fell through to a status check that admits `admin_attention`. `coalesce(...) not in (...)` now refuses it. **[D]**
- **The 48-hour window does not apply to a recovery.** The consultant already accepted inside it and the money is already captured; applying it on retry would strand a captured payment permanently. Unchanged for every first acceptance. **[D]**
- **No finance change.** No ledger row, split, snapshot, payout or refund behaviour; no finance RPC called, altered or reordered. **[D]**

Verification: `MIGRATION_051_VERIFICATION.sql`, **17 checks against PostgreSQL 16**, which **invoke** the RPC and assert its five-column runtime contract per the standing rule from migration 046, on a clean replay of 001–051; 051 re-run for idempotency. **The defect was reproduced before it was fixed**: with migration 008 loaded the same fixture returns *"Consultation cannot be recovered from admin attention reason calendar_failed"*; with 051 it returns `confirmed`. Orchestrator: **759 tests pass** (up from 745), including 14 in `acceptance-recovery.test.ts` — verified to fail on exactly the three recovery cases when the service guard is reverted.

**Not fixed here, and it matters:** *why* Google failed is not known from the code. It is recorded in the production logs under `"Google Calendar event creation failed"` with Google's HTTP status, error code, message and status. This work makes the consultation recoverable; a persistent Google fault will still fail the retry until that cause is addressed.

---

## 10. Technical cautions

### Generated route file (frontend)

`src/routeTree.gen.ts` is auto-regenerated and has previously removed required TanStack module registrations. Known-good source `0a24d47`. Restore with `git checkout 0a24d47 -- src/routeTree.gen.ts`, do not rebuild afterwards, and commit only if it differs.

### Documentation gap

Frontend commit hashes are not recorded in this file beyond the current deployed commit, because the frontend repository is not available in this workspace. Retrieve them from frontend Git history rather than inferring them.

---

## 11. Deferred refinements

Combine into a later frontend refinement pass; do not interrupt core work:

1. Message thread initial scroll position should consistently show the latest message.
2. Auto-growing textareas applied consistently.

---

## 12. Areas that must not be changed casually

- Locked **16**-table schema (15 original + `app_settings`, Amendment 007).
- Existing enums and statuses.
- RLS security model, including `app_settings` zero-policy isolation.
- Public self-signup prohibition and `shouldCreateUser: false`.
- Client provisioning through the booking backend; consultant provisioning through invitations.
- Server-controlled consultation price and currency; price snapshot immutability.
- The effective direct booking price rule, and the reserved slug list, which must gain an entry whenever a top-level frontend route is added (Amendments 011 and 012).
- Admin-only consultant slug management, and the column guard closing consultant_slug, direct_booking_enabled and direct_booking_price_cents to direct browser writes (Amendment 012, migration 049).
- The direct booking ownership split: admin writes slug and enabled, consultant writes price and direct_booking_only, nobody writes the effective price or the calculator terms (Amendments 013 and 014).
- `DIRECT_BOOKING_PREMIUM_CONSULTANT_BPS` is a display mirror, never the financial authority; `record_direct_booking_earning` decides the money, and MIGRATION_050_VERIFICATION check 2 fails if the two diverge (Amendment 014).
- `create_draft_consultation`'s five-column return contract, and `unique_reserved_consultant_slot` as the sole authority on slot conflicts (migration 046).
- The thirty-minute draft hold, defined in SQL beside `hold_expires_at`, and the rule that a superseded draft is released only *after* its replacement is fully prepared (migration 047).
- Stripe manual-capture workflow.
- `consultations.stripe_mode` as the selector for existing payments.
- Stripe credentials in Railway environment variables only.
- Redis checkout capability design.
- Google OAuth token encryption and server-only secret handling.
- Orchestrator ownership of sensitive state transitions.
- The recoverable `admin_attention` whitelist — `calendar_failed` and `calendar_created_confirmation_failed` only, the two failures that happen *after* the payment is captured. It is enforced in both `acceptance.service.ts` and `finalize_consultation_acceptance`, and the two must be widened together or not at all (Amendment 016, migration 051).
- The rule that the Stripe webhook path schedules notifications into Redis and never reads a table for one (Amendment 004 section 10.3.3, Amendment 015), and that every notification is idempotent by a `done` marker checked at both scheduling and processing.
- One-time invitation URL handling.
- `src/routeTree.gen.ts` restoration procedure.
- Service-role key prohibition in the frontend.
- Completed booking, invitation, messaging, settings and recommendation flows.

---

## 13. Next task

**Review the remaining MVP acceptance criteria against the current verified build state and identify the first genuinely incomplete criterion.**

No next feature has been selected, deliberately. The finance and direct booking group is frozen (section 9n), and choosing what follows it before that review would risk building against an assumption rather than against what the product still actually needs.

### Standing constraints, unchanged

**v1.1 planning; v1.0.x production patches only.**

v1.0 is released and frozen. Until v1.1 is planned and approved, the only permitted changes are v1.0.x production patches:

1. Production defect fixes.
2. The non-blocking technical debt in sections 9b and 9n.
3. Documentation corrections.

New scope requires a v1.1 plan or an amendment under the existing change-control rule.

### Release tags

```text
Orchestrator  v1.0.0  -> release-documentation commit on origin/main
Frontend      v1.0.0  -> 775716769e40a3131c5d6d913d0d7fc1b40abdfd
```

**Tagging status: PENDING.** Neither tag has been created. The frontend repository is not present in this workspace, so the frontend tag could not be created or verified, and the orchestrator tag was deliberately held so the two repositories are tagged together rather than leaving an asymmetric half-tagged release. See `V1_RELEASE_REPORT.md` for the exact commands.

---

## 14. Update template

```md
### [Feature name]

**Status:** Complete and verified
**Completed:** YYYY-MM-DD

**Scope**
- ...

**Files changed**
- ...

**Commits**
- `hash` — message

**Verification passed** [D]/[M]/[O]
1. ...

**Known limitations**
- None / ...

**Next dependency**
- ...
```

---

## 15. Primary source documents

- `PROJECT_LOCK.md`
- `PROJECT_LOCK_AMENDMENT_001_INTAKE_FIELDS.md`
- `PROJECT_LOCK_AMENDMENT_002_FRICTIONLESS_PUBLIC_BOOKING.md`
- `PROJECT_LOCK_AMENDMENT_003_RESILIENT_AVAILABILITY_AND_GENDER_MATCHING.md`
- `PROJECT_LOCK_AMENDMENT_004_STRUCTURED_SERVICE_PRICING_AND_STRIPE_PAYMENT_LINKS.md`
- `PROJECT_LOCK_AMENDMENT_005_ADMIN_CONSULTANT_DIRECT_MESSAGING.md`
- `PROJECT_LOCK_AMENDMENT_006_DIRECT_MESSAGE_PRESENCE_AND_EMAIL.md`
- `PROJECT_LOCK_AMENDMENT_007_ADMIN_SETTINGS_AND_DYNAMIC_PRICING.md`
- `PROJECT_LOCK_AMENDMENT_008_CONSULTANT_ONBOARDING_AND_IMMUTABLE_GENDER.md`
- `PROJECT_LOCK_AMENDMENT_009_SERVICE_PURCHASE_FINANCE.md`
- `PROJECT_LOCK_AMENDMENT_010_POST_PURCHASE_SERVICE_INSTRUCTIONS.md`
- `PROJECT_LOCK_AMENDMENT_011_DIRECT_CONSULTANT_BOOKING.md`
- `PROJECT_LOCK_AMENDMENT_012_CONSULTANT_SLUG_GOVERNANCE.md`
- `PROJECT_LOCK_AMENDMENT_013_DIRECT_BOOKING_SETTING_OWNERSHIP.md`
- `PROJECT_LOCK_AMENDMENT_014_DIRECT_BOOKING_ONLY.md`
- `PROJECT_LOCK_AMENDMENT_015_CONSULTANT_BOOKING_NOTIFICATION.md`
- `PROJECT_LOCK_AMENDMENT_016_ACCEPTANCE_CALENDAR_RECOVERY.md`
- `FINANCE_DIRECT_BOOKING_BASELINE.md` — the frozen finance + direct booking release baseline
- `DATABASE_SCHEMA.md`
- `RLS_POLICY_PLAN.md`
- `ROLE_ACCESS_MATRIX.md`
- `API_CONTRACT.md`
- `supabase/migrations/` — migrations 001 through 051

---

## 16. Maintenance rule

At the end of every verified feature:

1. Add the feature, files, commits, and verification results with the correct **[D]**/**[M]**/**[O]** marker.
2. Move any resolved issue out of cautions.
3. Add new limitations honestly.
4. Set the next task only after owner approval.
5. Commit this file.

Suggested commit message:

```text
Update project build status
```
