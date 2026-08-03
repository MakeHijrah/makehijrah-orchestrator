# MakeHijrah Relocation OS — v1.0.0 Release Report

**Product:** MakeHijrah Relocation OS
**Version:** 1.0.0
**Release date:** 2026-08-03
**Status:** RELEASED — frozen

---

## Verification key

Every claim in this report carries its evidence source. This matters more in a
release record than anywhere else, because a release report is the document
people trust later without re-checking.

| Mark | Meaning |
|---|---|
| **[D]** | Verified directly in this workspace during release documentation |
| **[M]** | Manually verified by the owner against production |
| **[O]** | Owner-supplied; not independently confirmed here |

The frontend repository is **not present in this workspace**. Every frontend
claim below is therefore **[O]** or **[M]**, never **[D]**.

---

## 1. Delivered business loop

The locked v1.0 loop ships end to end:

Client books a consultation → consultant accepts → payment captures → Google
Calendar event and Meet link are created → the consultation happens →
the consultant writes notes and recommends services → an admin sends the
recommendation → the client sees the recommended service card and can pay.

Nothing outside this loop shipped in v1.0.

## 2. Supporting admin and messaging features

- Consultant invitation, onboarding and activation.
- Admin consultation management, cancellation and refund handling.
- Gender matching and resilient availability (Amendment 003).
- Structured service pricing with Stripe Payment Links (Amendment 004).
- Admin ↔ consultant direct messaging (Amendment 005).
- Direct message presence and delayed email notification (Amendment 006).
- Admin settings and dynamic pricing runtime (Amendment 007).
- Countries and giveaways catalogues.

## 3. Consultant notes

Complete and manually verified. **[M]** Consultants may write notes only for
their own assigned consultations, under the existing RLS policy. Clients have
no access to consultation notes at any point.

---

## 4. Production URLs

```text
Frontend:      https://hijrah-consultation.lovable.app
Orchestrator:  https://orchestrator-production-e24e.up.railway.app
```

## 5. Release commits and deployments

### Frontend **[O]**

```text
Commit:      775716769e40a3131c5d6d913d0d7fc1b40abdfd
Message:     Wire consultant notes
Deployment:  250874ba
```

### Orchestrator

```text
Runtime commit:            f9054314744dda99950c22277a7704f273950311   [D]
Message:                   Add admin settings runtime

Pre-release documentation: 01af24381ca3b17915e671a31bb66ba31904f5ff   [D]
Message:                   Reconcile v1.0 documentation
```

**Railway deployment `5707559039`** is the last confirmed healthy deployment
before the release-documentation rebuild. **[O]**

---

## 6. Database state

- **Migration level:** `migration_025_admin_settings_and_dynamic_pricing.sql` **[D]**
- **16 public application tables** **[D]** (source read in this workspace;
  production row-level confirmation is owner-verified **[M]**)

## 7. Amendments

All seven amendments are approved and implemented:

| # | Title |
|---|---|
| 001 | Intake fields |
| 002 | Frictionless public booking |
| 003 | Resilient availability and gender matching |
| 004 | Structured service pricing and Stripe Payment Links |
| 005 | Admin ↔ consultant direct messaging |
| 006 | Direct message presence and delayed email |
| 007 | Admin settings and dynamic pricing |

---

## 8. Security confirmations

Owner-verified against production unless marked otherwise. **[M]**

1. Public self-signup is blocked.
2. An unknown-email OTP cannot create an account.
3. Role guards are active on every gated route.
4. Clients cannot see `proposed` recommendations — only `sent`.
5. Consultants cannot send recommendations; sending is admin-only.
6. Direct messaging is restricted to admin ↔ consultant pairs.
7. Clients cannot access direct message threads.
8. `app_settings` cannot be read directly by the browser.
9. Payment and consultation-state mutations remain orchestrator-only.
10. The role switcher is absent from the production build.
11. No server secret was found in the frontend bundle.
12. Recommendation payment links require safe HTTPS URLs.
13. Clients cannot read consultant notes.
14. Consultants can write only their own notes, for assigned consultations,
    under the existing RLS policy.
15. **Direct Presence is verified complete.** An earlier failed observation
    used the wrong consultant account; the correct admin-consultant two-user
    test passed.

## 9. Test results

```text
Frontend:      392 / 392 passing   [O]
Orchestrator:  221 / 221 passing   [D]  (33 suites, 0 fail, 0 skipped, 0 todo)
```

Orchestrator `npm run typecheck`, `npm run typecheck:test` and `npm run build`
all clean. **[D]**

## 10. Final production regression — 2026-08-03 **[M]**

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

No release blocker.

---

## 11. Accepted v1.0 limitations

Accepted product and architectural limitations, not defects. Full text in
`BUILD_STATUS.md` section 9.

1. Consultation pricing is global; consultant-specific pricing is deferred.
2. Consultant acceptance timeout is fixed at 48 hours.
3. Support email does not change the Mandrill sender identity.
4. The service Stripe catalogue stores one active mode at a time.
5. Switching Stripe mode does not copy Products, Prices or Payment Links.
6. Existing catalogue objects may require regeneration after a mode switch.
7. Concurrent recommendation inserts carry a theoretical race on the
   three-item trigger.
8. The timezone UI uses the current supported shortlist.
9. Concurrent admin settings edits are last-write-wins.
10. Temporary Mandrill failure injection remains untested.

Service Payment Link purchases are not recorded in the MakeHijrah database in
this scope; Stripe is the temporary source of truth (Amendment 004 §11).

**Direct Presence is not a limitation.** It is complete and verified.

## 12. Non-blocking technical debt

Deferred to a v1.0.x patch. **These are not accepted product limitations.**

1. The frontend `.env` is tracked in Git. It contains browser-public `VITE_`
   values only — no server secret. Removal and `.gitignore` hardening are
   deferred to v1.0.x. **[O]**
2. Inactive mock fixtures remain bundled but are not selected in production.
   Dead-code cleanup is deferred to v1.0.x. **[O]**

---

## 13. Rollback references

| Target | Commit / ID |
|---|---|
| Frontend production commit | `775716769e40a3131c5d6d913d0d7fc1b40abdfd` |
| Frontend production deployment | `250874ba` |
| Orchestrator runtime commit | `f9054314744dda99950c22277a7704f273950311` |
| Orchestrator pre-release docs | `01af24381ca3b17915e671a31bb66ba31904f5ff` |
| Last confirmed healthy Railway deployment | `5707559039` |
| Migration level | `025` |

Rolling the orchestrator back to `f905431` restores the released runtime. The
release-documentation commit changes no runtime behaviour, so it is safe to
revert independently.

## 14. Git tags

```text
Orchestrator  v1.0.0  -> release-documentation commit on origin/main
Frontend      v1.0.0  -> 775716769e40a3131c5d6d913d0d7fc1b40abdfd
```

**Status: PENDING — neither tag has been created.**

The frontend repository is not present in this workspace, so its tag could not
be created or verified. The orchestrator tag was deliberately held rather than
created alone: a tag is effectively immutable under the project's
no-force-push rule, and a half-tagged release would be worse than an untagged
one.

To complete tagging once the frontend workspace is available:

```sh
# Orchestrator — from the release-documentation commit on origin/main
cd /workspaces/makehijrah-orchestrator
git tag -a v1.0.0 -m "MakeHijrah Relocation OS v1.0.0"
git push origin v1.0.0

# Frontend — must be at 7757167, clean, HEAD == origin/main
cd /workspaces/hijrah-consultation
git tag -a v1.0.0 -m "MakeHijrah Relocation OS v1.0.0"
git push origin v1.0.0
```

Verify both with:

```sh
git ls-remote --tags origin refs/tags/v1.0.0
git ls-remote --tags origin refs/tags/v1.0.0^{}
```

---

## 15. Freeze statement

**MakeHijrah Relocation OS v1.0.0 is frozen.**

The locked business loop, database schema, API contract, RLS policy plan and
role access matrix are closed for v1.0. Until v1.1 is planned and approved,
the only permitted changes are v1.0.x production patches: production defect
fixes, the technical debt in section 12, and documentation corrections.

Any new table, enum, status, route, endpoint, payment behaviour, calendar
behaviour, auth behaviour, RLS behaviour, storage behaviour or secret handling
change requires written approval under the existing change-control rule.
