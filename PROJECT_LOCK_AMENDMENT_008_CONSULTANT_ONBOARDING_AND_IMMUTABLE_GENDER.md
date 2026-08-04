# PROJECT_LOCK Amendment 008 — Consultant Self-Managed Booking Capability, Complete Profile Submission, and Immutable Gender

| Field | Value |
|---|---|
| Status | **APPROVED** |
| Date approved | 2026-08-03 |
| Release classification | **v1.0.x production patch** |
| Amends | `PROJECT_LOCK.md`, `DATABASE_SCHEMA.md`, `API_CONTRACT.md`, `ROLE_ACCESS_MATRIX.md`, `RLS_POLICY_PLAN.md` |
| Supersedes | The admin-only country-assignment rule and the unrestricted consultant gender edit permitted by `RLS_POLICY_PLAN.md` §2 (see §2) |
| Implemented by | `migration_026_consultant_onboarding_and_gender_lock.sql` (Phase 1); a later direct-write lockdown migration (Phase 4); orchestrator consultant-profile module (Phase 2); frontend profile and onboarding (Phase 3) |
| Database migration | **Yes.** One new nullable column on `consultants`, one extended guard function. No new table. |
| Scope | Governance only. This document authorises work. It does not perform it. |

---

## 1. Standing

1.1 Amendments 001 through 007 remain authoritative in full. This amendment
supersedes only the two specific rules named in §2.

1.2 The locked data model remains **exactly 16 tables**. This amendment adds no
table. It adds one nullable column to an existing table.

1.3 This is a **v1.0.x production patch** against released v1.0. It is not a
v1.1 feature. It exists because the released product contains defects that make
a consultant unable to become bookable without administrator intervention.

1.4 Where this amendment conflicts with an earlier document, this amendment
prevails, and only for consultant profile management, onboarding completion,
gender mutability and consultant activation.

---

## 2. Superseded rules

2.1 **Country assignment is no longer exclusively an administrative
responsibility.** `ROLE_ACCESS_MATRIX.md` records "Assign consultant ↔ country"
as an admin capability with an RLS write, and `RLS_POLICY_PLAN.md` §2 grants
`consultant_countries` INSERT and DELETE to `is_admin()` only. From this
amendment a consultant selects their own countries, through the orchestrator.

2.2 **Consultant gender is no longer freely editable.** `RLS_POLICY_PLAN.md` §2
lists the consultant-updatable safe columns and applies trigger protection only
to `is_active`, `available_for_general` and `profile_id`. Migration 018 added
`consultants.gender` and no guard was extended to cover it, so a consultant can
change their own gender at any time. From this amendment gender is immutable
after onboarding completion.

2.3 Older amendments are not rewritten. This section is the authoritative record
of what changed.

---

## 3. Authoritative profile photograph

3.1 The authoritative profile photograph for every role, consultants included,
is **`profiles.avatar_url`**.

3.2 `consultants.photo_url` is **not** the completeness source. It is the
**denormalised public projection** of `profiles.avatar_url`, and is not dropped
by this amendment.

*Amended 2026-08-04 by the approved avatar architecture decision, implemented as
migration 028.* The projection exists because public, client and anon surfaces
may read `public.consultants` but may not read `public.profiles`. Without it the
authoritative photograph would be invisible to exactly the audience a consultant
photograph exists for, and the only alternative — widening `profiles` SELECT —
would expose `email`, `phone_whatsapp` and every other private column to publish
one public field. **RLS is unchanged; the projection is the mechanism that keeps
it unchanged.**

3.3 The two fields are maintained together by the service-role RPC
`save_consultant_profile`, **atomically, in one transaction, from one argument**:
when `p_avatar_url` is non-null both are set to it; when it is null both are
preserved. They therefore cannot diverge through the supported write path. No
other writer maintains the projection, and nothing else may write `photo_url`.

3.4 Migration 028 additionally performs a one-time reconciliation: it adopts a
legacy `consultants.photo_url` into `profiles.avatar_url` **only where the
authoritative field is null**, then synchronises the projection from the
authoritative field. An existing `avatar_url` is never overwritten, and a legacy
`photo_url` is never cleared.

3.5 Own-profile surfaces read `profiles.avatar_url`. Public, client and anon
surfaces read `consultants.photo_url`. The profile-save response returns the
authoritative `avatar_url` and never exposes `photo_url`.

3.4 The storage bucket is unchanged: `public-media`, prefix
`avatars/{auth.uid()}/*`.

---

## 4. Onboarding completion marker

4.1 A new column is added:

```sql
consultants.onboarding_completed_at timestamptz null
```

4.2 The marker is set **once**, at the first successful complete profile
submission. It is never reset, never cleared, and never set a second time.

4.3 The marker is **not** `is_active`. Activation is an administrative decision;
onboarding completion is a consultant action. The two are independent, and
conflating them is what would make deactivation reopen gender.

4.4 **Backfill.** Consultants that are `is_active = true` when
`migration_026` runs are treated as previously onboarded and receive
`onboarding_completed_at = now()`.

4.5 **Inactive consultants are not backfilled.** Their marker stays null, they
complete onboarding through the new flow, and they select gender at that point.

4.6 Backfilled consultants:

- have immutable gender **immediately**;
- use the normal post-onboarding update mode;
- do not repeat onboarding submission.

4.7 The marker is immutable to non-privileged writers. A consultant who could
clear it could reopen gender, so the marker carries the same protection as the
value it guards.

---

## 5. Gender

5.1 Gender remains `text`, constrained by `consultants_gender_check` to
`null`, `male` or `female`. That constraint is unchanged.

5.2 **Before onboarding completion** — while `onboarding_completed_at is null` —
the consultant may select `male` or `female`, and gender is **required** before
submission succeeds.

5.3 **After onboarding completion** the consultant cannot change gender and
cannot clear it.

5.4 **Deactivation does not reopen gender.** The lock keys on
`onboarding_completed_at`, never on `is_active` (§4.3).

5.5 The normal administrator interface does not expose gender editing. No
administrative gender-correction workflow is built by this amendment.

5.6 **Exceptional correction** is a service-role or direct SQL action, outside
the normal application workflow, requiring explicit confirmation and audit
logging. It is deliberately not reachable through any route. Building it
requires its own amendment.

5.7 A second onboarding submission by an already-completed consultant is
rejected. It must not be a path back to an editable gender.

---

## 6. Booking capability

6.1 Consultant destinations are stored **only** in `public.consultant_countries`,
the existing many-to-many table.

6.2 **No comma-separated, array or JSON country field** is added to
`consultants`. This is prohibited, not merely discouraged.

6.3 General consultations remain governed by
`consultants.available_for_general`, which stays consultant-controlled as
Amendment 003 and migration 021 established.

6.4 **Booking capability requires at least one assigned active country OR
`available_for_general = true`.** Assignment to only inactive countries does not
satisfy it.

6.5 General consultations are optional. A consultant serving only countries is
valid; a consultant serving only general is valid.

6.6 Only active countries may be newly selected. Existing assignments to a
country that later becomes inactive are not deleted; they simply stop counting
toward capability.

---

## 7. Profile submission states

7.1 **Before onboarding completion**, two distinct actions exist:

| Action | Validation | Marker | Result |
|---|---|---|---|
| Save draft | Shape and type only; incomplete permitted | Not set | Profile remains incomplete, consultant not activation-ready, and this is stated plainly in the interface |
| Submit profile | Full completeness (§8) | **Set on success** | Gender locks permanently |

7.2 **After onboarding completion** the two actions are replaced by a single
**Save profile**, in which gender is read-only, countries and general
availability remain editable, and the marker is never reset.

7.3 A submission that fails validation writes **nothing**. There is no partial
save.

---

## 8. Completeness requirements

8.1 All of the following are required before onboarding submission succeeds and
before administrator activation succeeds:

| # | Requirement | Rule |
|---|---|---|
| 1 | Full name | `profiles.full_name`, non-empty after trimming |
| 2 | Profile photograph | `profiles.avatar_url`, non-empty (§3) |
| 3 | Gender | exactly `male` or `female` |
| 4 | Headline | non-empty after trimming, maximum **120** characters |
| 5 | Biography | non-empty after trimming, maximum **2,000** characters |
| 6 | Timezone | valid IANA zone, validated with the existing luxon `IANAZone` convention |
| 7 | Minimum booking notice | integer, **0 to 168** hours inclusive |
| 8 | Booking capability | §6.4 |
| 9 | Weekly working hours | at least one interval; every interval `start < end`; **no overlapping intervals on the same weekday**; not every weekday needs hours |
| 10 | Google Calendar | connected and not revoked, for initial submission and initial activation |

8.2 `consultants.headline` has no database length constraint today. The 120
character maximum in 8.1 is an application rule. No constraint is added.

8.3 Same-weekday overlap detection does not exist in the current codebase and is
new logic.

---

## 8a. Working-hours weekday key format

*Added 2026-08-04 by the approved working-hours storage decision, implemented as
migration 029.*

8a.1 There are two representations and they are **not** interchangeable:

| Layer | Format | Example |
|---|---|---|
| HTTP wire (`PUT /api/consultant/profile`, request and response) | **named** weekdays | `{"sunday": [...]}` |
| Database storage (`consultants.working_hours_jsonb`) | **numeric** keys `"0"`–`"6"` | `{"0": [...]}` |

8a.2 The mapping is fixed: `0` sunday, `1` monday, `2` tuesday, `3` wednesday,
`4` thursday, `5` friday, `6` saturday.

8a.3 **Named to numeric happens in the RPC**, on the way in. The RPC accepts
named keys only; numeric, mixed and unrecognised keys are rejected with
`CONSULTANT_WORKING_HOURS_FORMAT_INVALID`. It refuses to guess.

8a.4 **Numeric to named happens in the orchestrator response mapper**, on the
way out. Numeric keys never cross the HTTP boundary.

8a.5 The database must never store named weekday keys. Migrations 027 and 028
stored the argument verbatim and therefore did; **migration 029 repairs those
rows** and moves the conversion into the RPC.

8a.6 Internal readers — availability slot generation and the completeness
evaluator — accept **either** format, because rows written before migration 029
carry named keys. A reader understanding only one format would produce an empty
week rather than an error, making a consultant appear unbookable instead of
broken.

---

## 9. Google Calendar and degraded availability

9.1 A Google connection is required for **initial** onboarding submission and
**initial** administrator activation.

9.2 **Amendment 003 degraded availability behaviour is unchanged.** After
activation, a degraded or revoked Google connection:

- does **not** automatically deactivate the consultant;
- does **not** hide an otherwise active consultant where Amendment 003 permits
  degraded behaviour;
- does **not** erase `onboarding_completed_at`;
- does **not** make gender editable;
- does **not** block a completed consultant from saving an otherwise valid
  profile update.

*Implementation note (2026-08-03, orchestrator `59637eb`).* The shared
completeness evaluator is context-aware for exactly this reason. Google is
required for `onboarding_submit` and `admin_activation` and is not consulted at
all for `active_profile_update`. Every structural requirement is identical
across the three contexts.

9.3 Google connection status is read server-side from `oauth_connections`. It is
never supplied by the browser, and no OAuth secret appears in any profile
payload.

---

## 10. Orchestrator-owned atomic mutation

10.1 Consultant profile mutation becomes the responsibility of a new
authenticated orchestrator endpoint. A single submission atomically covers
profile columns, general availability, country assignments and, on first
successful submit, the onboarding marker.

10.2 The endpoint resolves consultant identity **server-side from the
authenticated session**. A consultant identifier supplied by the browser is
never trusted.

10.3 The endpoint replaces only the authenticated consultant's country
assignments. Cross-consultant assignment and cross-consultant deletion are
impossible by construction.

10.4 Duplicate country identifiers in a request are harmless and never create
duplicate rows.

10.5 Inactive or non-existent country identifiers are rejected.

10.6 Atomicity is achieved through a database function invoked by the
orchestrator, following the existing RPC transaction convention already used by
`create_draft_consultation`, `redeem_consultant_invite` and the `finalize_*`
family.

10.7 **Reads remain on existing RLS.** `consultants_select_own_or_admin` and
`cc_select_public` are already sufficient. No read policy is added or widened.

10.8 **`consultant_countries` write policies remain administrator-only.**
Consultants never receive direct INSERT or DELETE on that table. Granting it
would create a second, unvalidated write path — precisely the bypass this
amendment exists to close.

---

## 11. Direct browser writes

11.1 The end state is that a consultant cannot bypass completeness validation,
active-consultant safety, gender immutability or atomic capability updates by
writing directly to Supabase.

11.2 That end state is reached in **two stages**, because the currently deployed
frontend still writes directly and must not be broken during the gap between
orchestrator and frontend deployment:

| Stage | Migration | Effect |
|---|---|---|
| Now | `026` | Marker added and backfilled. Gender immutable after completion. Marker immutable to clients. All other consultant-editable columns still directly writable. |
| Later | a subsequent migration, immediately before the new frontend ships | Direct client writes to the booking-critical columns are blocked, leaving the orchestrator endpoint as the only path. |

11.3 The gender lock takes effect in stage one **by design**, per §4.6. A
currently deployed profile page that submits an unchanged gender is unaffected,
because the guard compares old and new values and only rejects an actual change.
A page that attempts to change the gender of a backfilled consultant will fail,
which is the intended new rule.

11.4 The stage-two migration is authorised by this amendment but deliberately
not written in stage one, because blocking those columns before the endpoint
exists would break the live profile page.

---

## 12. Active consultant edit safety

12.1 A save that would leave an **active** consultant incomplete is **rejected**.

12.2 The consultant is **never silently deactivated** as a way of accepting an
incomplete profile.

12.3 The rejection is atomic: no profile column, no country assignment and no
working-hours value changes.

12.4 Rejections that must occur for an active consultant include removing the
final country while general availability is false, disabling general
availability while no active country remains, clearing the photograph, name,
headline or biography, clearing or invalidating working hours, setting an
invalid timezone or booking notice, and any attempt to clear or change gender.

12.5 An **inactive** consultant whose onboarding is complete may hold an
incomplete profile. Administrator activation is the gate that re-checks
completeness.

---

## 13. Validation feedback

13.1 Every current problem is returned in one attempt. Returning only the first
error is prohibited.

13.2 Identifiers are stable and machine-readable:

```text
avatar                        full_name
gender                        headline
bio                           timezone
minimum_booking_notice_hours  booking_capability
country_ids                   working_hours
google_calendar               gender_immutable
```

*Implementation note (2026-08-03).* The orchestrator currently emits eleven of
these: the ten structural identifiers above plus `onboarding_completed`, which
only administrator activation returns. `country_ids` and `gender_immutable`
remain reserved but are not reached — an unusable country set surfaces as
`booking_capability`, and a gender-change attempt returns the dedicated
`CONSULTANT_GENDER_IMMUTABLE` error code rather than a completeness identifier.
Clients should tolerate both without depending on them.

13.3 The interface shows a summary listing every problem, moves keyboard focus
to it, exposes it with `role="alert"` or equivalent, associates each message
with its input, and clears a field error when corrected.

13.4 Validation failures are visually and semantically distinct from network
failures.

13.5 No raw database text, PostgreSQL error, or internal exception detail
reaches the client.

13.6 Success copy is exactly: **Draft saved**, **Profile submitted
successfully**, **Profile updated successfully**.

---

## 14. Error contract

14.1 The locked response envelope from `API_CONTRACT.md` §0 is **unchanged and
binding**:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }
```

14.2 New codes approved by this amendment:

| Code | Status | Meaning |
|---|---|---|
| `CONSULTANT_PROFILE_INCOMPLETE` | 409 | Completeness failed. `details.missing[]` lists every unmet requirement. |
| `CONSULTANT_GENDER_IMMUTABLE` | 409 | Gender change attempted after onboarding completion. |

14.3 `CONSULTANT_GENDER_IMMUTABLE` carries exactly: *"Consultant gender cannot
be changed after onboarding is completed."*

14.4 `CONSULTANT_PROFILE_INCOMPLETE` replaces `ACTIVATION_BLOCKED` on the
administrator activation endpoint. This is a **breaking change** for any client
consuming the old code and must ship in coordination with the frontend.

14.5 The database raises stable, greppable markers that application code maps to
14.2. Raw exception text is never forwarded.

---

## 15. Administrator activation

15.1 The activation endpoint independently validates the full §8 set plus
`onboarding_completed_at is not null`. It never trusts frontend validation.

15.2 It returns **every** unmet requirement, using the §13.2 identifiers, under
`error.details.missing[]`.

15.3 A consultant assigned only to inactive countries fails `booking_capability`.

---

## 16. Database changes authorised

16.1 `migration_026_consultant_onboarding_and_gender_lock.sql`:

- adds `consultants.onboarding_completed_at timestamptz null`;
- backfills active consultants only (§4.4, §4.5);
- extends `public.guard_consultants_columns` in place, preserving every existing
  protection byte-for-byte, adding marker immutability and post-onboarding
  gender immutability for non-privileged writers.

16.2 The existing `trg_guard_consultants` binding is reused. **No second trigger
is created**, so there is no trigger-ordering ambiguity.

16.3 No RLS policy is added, removed or widened by migration 026.

16.4 No constraint is added or altered. No column is dropped or retyped. No
table is created.

---

## 17. Atomic profile function

17.1 `public.save_consultant_profile(...)` was deferred from migration 026
because its contract was not final. It is now final and is created by
**`migration_027_atomic_consultant_profile_save.sql`**. The signature below is
the one that shipped, unchanged from the proposal.

17.2 Signature:

```sql
create or replace function public.save_consultant_profile(
  p_consultant_id                 uuid,
  p_mode                          text,          -- 'draft' | 'submit' | 'update'
  p_full_name                     text,
  p_avatar_url                    text,
  p_gender                        text,          -- honoured only when p_mode = 'submit'
  p_headline                      text,
  p_bio                           text,
  p_timezone                      text,
  p_minimum_booking_notice_hours  integer,
  p_available_for_general         boolean,
  p_country_ids                   uuid[],
  p_working_hours                 jsonb
)
returns table (
  consultant_id            uuid,
  onboarding_completed_at  timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public;
```

17.3 Binding requirements when it is created:

- `EXECUTE` granted **only** to `service_role`; `authenticated` and `anon`
  receive none;
- consultant identity supplied only by trusted orchestrator code;
- country identifiers validated as existing and active inside the function;
- `consultant_countries` replacement atomic within the transaction;
- duplicate identifiers harmless;
- `onboarding_completed_at` set only on a successful `submit`, and only when
  currently null;
- no partial write on any failure;
- **no Google OAuth validation inside SQL** — that requires an external read and
  stays in the application layer;
- application-layer completeness remains authoritative for any requirement
  needing data outside this transaction.

17.4 A half-secure function must not be created. Deferral was the correct
outcome while the contract was unsettled.

17.5 **Finalised mode semantics**, as implemented:

| Mode | Precondition | Marker | Gender |
|---|---|---|---|
| `draft` | marker **is null** | never set or cleared | optional; if supplied must be `male` or `female` |
| `submit` | marker **is null** | set to `now()`, exactly once | **required**, `male` or `female` |
| `update` | marker **is not null** | never changed | null ignored; equal to stored tolerated for rollout; different rejected |

17.6 **Null-preserve semantics.** In every mode, a null field argument means
"leave the stored value unchanged". Null is never coerced into an empty string.
An empty string is stored only when the application deliberately sends one.

17.7 **Country semantics.** `p_country_ids` null preserves existing assignments.
A supplied array replaces them wholesale, after de-duplication and after
validating that every distinct identifier exists and is active. An **empty array
is an instruction to remove all assignments**, distinguished from null by
`IS NULL` rather than by `array_length`, which returns null for an empty array
and would otherwise conflate the two.

17.8 **Stable exception markers** raised by the function, for the service to map
to §14.2 API codes:

```text
CONSULTANT_PROFILE_MODE_INVALID
CONSULTANT_PROFILE_NOT_FOUND
CONSULTANT_ONBOARDING_ALREADY_COMPLETED
CONSULTANT_ONBOARDING_INCOMPLETE
CONSULTANT_GENDER_INVALID
CONSULTANT_GENDER_IMMUTABLE
CONSULTANT_COUNTRY_INVALID
```

`CONSULTANT_ONBOARDING_INCOMPLETE` is new in migration 027. It covers `update`
attempted before onboarding completion, a case the original text did not name.
Raw PostgreSQL text is never forwarded to a client.

17.9 The function runs `security definer`, so it bypasses the migration 026
trigger exactly as `service_role` already does. Its body therefore re-enforces
the gender rules independently. The trigger guards direct client writes; the
function guards itself. Both layers are required and neither is redundant.

17.10 The consultant row is locked with `FOR UPDATE` for the life of the
transaction, so two concurrent saves for one consultant serialise rather than
interleaving their country replacement.

---

## 18. Test baselines

18.1 At the time of approval: **orchestrator 235**, **frontend 446**.

18.2 Every existing test must remain passing. Booking, payment, authentication,
profile, OAuth, activation and messaging behaviour is unchanged except where
this amendment explicitly changes it.

---

## 19. Deployment order

19.1 Binding, and orchestrator-first:

1. Amendment and migration prepared *(this phase)*
2. Migration reviewed
3. Migration applied to staging
4. RLS and trigger verification
5. Orchestrator endpoint and activation validation
6. Orchestrator tests
7. Orchestrator deployment
8. Frontend profile and onboarding
9. Frontend tests
10. Frontend deployment
11. Manual consultant onboarding verification
12. Manual active-profile edit verification
13. Manual public booking verification
14. Documentation closeout
15. Recorded as a v1.0.x patch

19.2 **Frontend-first deployment is prohibited.**

19.3 The stage-two direct-write lockdown migration (§11.2) is applied between
steps 9 and 10.

---

## 20. Rollback

20.1 `onboarding_completed_at` **is not dropped** once values are written,
without explicit written approval. Dropping it silently reopens gender for every
completed consultant.

20.2 Country assignments written through the new endpoint are never deleted on
rollback. They are valid under the old model and remain readable.

20.3 The guard function is independently revertible to its migration 021 body if
the lock causes an operational problem. That is the correct partial rollback.

20.4 The orchestrator endpoint can be disabled without a deployment by revoking
`EXECUTE` on the atomic function from `service_role`, once that function exists.

20.5 The previous frontend continues to work after an orchestrator rollback,
except that gender edits for completed consultants fail — which is the intended
rule, not a regression.

---

## 21. Approval

```
Proposed by:  MakeHijrah ........................   Date: 2026-08-03

Reviewed by:  MakeHijrah ........................   Date: 2026-08-03

Approved by:  MakeHijrah ........................   Date: 2026-08-03

Status on approval:  APPROVED
```
