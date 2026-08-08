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

**Not done:** no frontend. The `/dashboard/consultation/{uuid}` route and the WYSIWYG editor are a separate build; static Payment Links still land on `/dashboard` and generic dashboard purchases show only a generic success message.

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
- Stripe manual-capture workflow.
- `consultations.stripe_mode` as the selector for existing payments.
- Stripe credentials in Railway environment variables only.
- Redis checkout capability design.
- Google OAuth token encryption and server-only secret handling.
- Orchestrator ownership of sensitive state transitions.
- One-time invitation URL handling.
- `src/routeTree.gen.ts` restoration procedure.
- Service-role key prohibition in the frontend.
- Completed booking, invitation, messaging, settings and recommendation flows.

---

## 13. Next task

**v1.1 planning; v1.0.x production patches only.**

v1.0 is released and frozen. Until v1.1 is planned and approved, the only permitted changes are v1.0.x production patches:

1. Production defect fixes.
2. The non-blocking technical debt in section 9b.
3. Documentation corrections.

No new feature ships against v1.0. New scope requires a v1.1 plan or an amendment under the existing change-control rule.

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
- `DATABASE_SCHEMA.md`
- `RLS_POLICY_PLAN.md`
- `ROLE_ACCESS_MATRIX.md`
- `API_CONTRACT.md`
- `supabase/migrations/` — migrations 001 through 042

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
