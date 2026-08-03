# MakeHijrah Relocation OS v1.0

## BUILD_STATUS.md

**Status:** **V1.0 RELEASED**
**Release date:** 2026-08-03
**Last updated:** 2026-08-03
**Project owner:** MakeHijrah
**Lead architect:** Dave
**Coordinator:** Abu Mansur
**Next task:** v1.1 planning; v1.0.x production patches only

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
Runtime commit:       f9054314744dda99950c22277a7704f273950311
Message:              Add admin settings runtime

Pre-release docs:     01af24381ca3b17915e671a31bb66ba31904f5ff
Message:              Reconcile v1.0 documentation
```

Verified in this workspace: local `HEAD` == `origin/main` == `01af243` before release documentation.

```text
Railway deployment: 5707559039   Successful
```

Last confirmed healthy deployment before the release-documentation rebuild. `/health` returns HTTP 200 with `redis: connected`, `supabase: connected`, `supabaseTestRows: 1`, `environment: production`. **[D]**

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
- Latest migration: `migration_025_admin_settings_and_dynamic_pricing.sql`.

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
| 025 | `migration_025_admin_settings_and_dynamic_pricing.sql` | `app_settings` + `consultations.stripe_mode` | 007 | ✅ | ✅ **[M]** |

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
- `DATABASE_SCHEMA.md`
- `RLS_POLICY_PLAN.md`
- `ROLE_ACCESS_MATRIX.md`
- `API_CONTRACT.md`
- `supabase/migrations/` — migrations 001 through 025

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
