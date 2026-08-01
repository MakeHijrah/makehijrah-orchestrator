# MakeHijrah Relocation OS v1.0

## PROJECT_LOCK Amendment 003

**Title:** Resilient Calendar Availability, Validated WhatsApp Input, and Gender-Aware Consultant Selection  
**Status:** Approved  
**Approved by:** Abu Mansur  
**Approval date:** 2026-07-28  
**Applies to:** `PROJECT_LOCK.md` v1.0  
**Change type:** Controlled MVP amendment  
**Rule:** This amendment supersedes any conflicting requirement in the locked MVP documents. All unaffected requirements remain locked.

---

# 1. Purpose

This amendment prevents a revoked or unavailable Google OAuth connection from silently removing an active consultant from the public booking flow. It also strengthens consultation intake by validating WhatsApp numbers and introduces gender-aware consultant selection.

The approved changes are:

1. Google Calendar degraded availability mode.
2. OAuth health monitoring and reconnection alerts.
3. Validated international WhatsApp input.
4. Client gender collection.
5. Consultant gender collection.
6. Client consultant-gender preference.
7. Gender-aware consultant filtering and matching.

---

# 2. Resilient Google Calendar Availability

## 2.1 Existing problem

The current availability endpoint treats a missing, revoked, or unusable Google OAuth connection as a hard booking failure. This can make an active consultant appear unavailable without the consultant or administrator knowing that prospective clients are being blocked.

This behavior is no longer approved.

## 2.2 Approved availability modes

The orchestrator must support two availability modes.

### Normal mode

Normal mode uses:

- consultant working hours
- minimum booking notice
- Google FreeBusy results
- existing MakeHijrah consultation reservations
- database slot protection
- Redis availability cache

Example API metadata:

```json
{
  "availability_mode": "normal",
  "calendar_connected": true
}
```

### Degraded mode

Degraded mode applies when Google Calendar cannot be used because of:

- `OAUTH_REVOKED`
- `OAUTH_NOT_CONNECTED`
- token refresh failure
- temporary Google API failure
- temporary Google service unavailability

In degraded mode, the consultant remains visible and bookable.

Available slots must be generated from:

- consultant working hours
- minimum booking notice
- existing non-terminal MakeHijrah consultations
- database slot protection

Google FreeBusy must not be used in degraded mode.

Example API metadata:

```json
{
  "availability_mode": "degraded",
  "calendar_connected": false
}
```

## 2.3 Public booking behavior

The public booking page must not display a hard-stop message solely because Google OAuth is disconnected or revoked.

The booking flow must continue using degraded availability.

The client does not need to see internal OAuth details. A neutral warning may be shown only when operationally useful, but it must not block booking.

## 2.4 Acceptance gate

A consultant may receive and review a consultation booked in degraded mode.

The consultant must not be allowed to accept the consultation until Google Calendar is reconnected and the orchestrator can create:

- the consultant calendar event
- the Google Meet link

The payment remains authorized and uncaptured while acceptance is blocked.

The consultant may decline the consultation if the proposed time conflicts with an external calendar commitment. In that case, the existing authorization-cancellation flow applies and no charge is captured.

## 2.5 Conflict protection

Degraded mode protects only against conflicts inside MakeHijrah.

The system must continue enforcing database-level protection against two MakeHijrah consultations occupying the same consultant slot.

Degraded mode does not claim to detect conflicts from the consultant's external Google Calendar.

---

# 3. OAuth Health Monitoring and Alerts

## 3.1 Scheduled health check

The orchestrator must run a scheduled OAuth health check for every active consultant with a Google connection.

Minimum frequency:

- once every 24 hours

The health check must attempt a safe token refresh or equivalent minimal verification.

## 3.2 Failure handling

When a connection becomes invalid or revoked, the system must:

1. mark the OAuth connection as revoked or disconnected
2. place availability in degraded mode
3. notify the consultant by email
4. notify administrators by email
5. display a persistent reconnect warning in the consultant dashboard
6. display the connection state in the admin consultant view

## 3.3 Notification idempotency

OAuth failure notifications must be idempotent.

The system must not repeatedly send duplicate alerts for the same unresolved disconnection event.

A reminder may be sent once every 24 hours until the connection is restored.

## 3.4 Recovery

After the consultant completes OAuth reconnection successfully:

- `revoked_at` must be cleared through the normal OAuth flow
- the new encrypted refresh token must be stored
- availability returns to normal mode
- persistent reconnect warnings are removed
- future acceptance actions may proceed normally

`revoked_at` must never be cleared manually as a substitute for OAuth reconnection.

---

# 4. Validated WhatsApp Input

## 4.1 Requirement

The booking form must use an international phone input for WhatsApp.

The input must include:

- country selector
- country flag
- international dial code
- numeric local-number entry

## 4.2 Validation

The frontend must:

- allow digits only in the number portion
- prevent clearly invalid values
- display a useful validation error
- normalize the visible value before submission

The orchestrator must perform authoritative validation and normalization.

Frontend validation alone is not sufficient.

## 4.3 Storage format

Valid WhatsApp numbers must be stored in E.164 format.

Example:

```text
+201001234567
```

The system must strip display formatting such as:

- spaces
- dashes
- parentheses

The existing field remains:

```text
consultation_intake.phone_whatsapp
```

No new WhatsApp database column is approved.

## 4.4 Required status

WhatsApp remains optional for MVP.

When provided, it must be valid.

This rule supersedes any earlier implementation that accepts an arbitrary unvalidated string.

---

# 5. Consultant Gender

## 5.1 Data model

Add the following nullable constrained text field to `consultants`:

```sql
gender text check (gender in ('male', 'female'))
```

A new PostgreSQL enum must not be introduced for this field.

## 5.2 Operational rule

Consultant gender must be completed before a consultant can be activated for public booking.

Existing active consultants with a null gender must be flagged for administrative completion.

## 5.3 Management surfaces

Consultant gender must be supported in:

- consultant onboarding
- consultant profile
- admin consultant review
- admin consultant editing
- public consultant selection data

---

# 6. Client Gender and Consultant-Gender Preference

## 6.1 Separate answers

The system must collect two separate values:

1. client gender
2. preferred consultant gender

The system must not infer one from the other.

## 6.2 Approved values

Client gender:

```text
male
female
```

Preferred consultant gender:

```text
male
female
no_preference
```

## 6.3 Storage

Store the client answers in `consultation_intake.answers_jsonb`.

Approved shape:

```json
{
  "consultation_summary": "...",
  "client_gender": "male",
  "preferred_consultant_gender": "male"
}
```

No new client-gender or preference table is approved.

No new intake columns are required for these values.

---

# 7. Revised Public Booking Flow

The approved booking sequence is:

1. Destination
2. Consultant preference
3. Consultant
4. Time
5. Details
6. Payment

## 7.1 Consultant preference step

The client must choose one:

- Prefer a male consultant
- Prefer a female consultant
- No preference

## 7.2 Consultant selection behavior

When the client selects an explicit preference:

- only consultants matching that gender may be selected
- non-matching consultants must not appear as valid options

When the client selects `no_preference`:

- all otherwise eligible consultants may appear

Consultants with a null gender must not appear in public booking.

## 7.3 No-match state

When no active consultant matches the selected country and gender preference, display:

> No consultant matching your preference is currently available. You may change your preference or request assistance.

The user must be able to return to the preference step and change the selection.

## 7.4 Details step

The details step must collect:

- full name
- email
- client gender
- WhatsApp number
- consultation summary

The selected consultant-gender preference must remain attached to the booking draft and be submitted with the intake data.

---

# 8. API Contract Changes

## 8.1 Availability response

Availability responses must expose operational metadata:

```json
{
  "availability_mode": "normal | degraded",
  "calendar_connected": true
}
```

Existing slot data remains unchanged unless an implementation-specific wrapper is required.

## 8.2 Consultant list response

Public consultant data must include:

```json
{
  "gender": "male | female"
}
```

Consultants with null gender are excluded from public booking results.

## 8.3 Booking/intake request

The booking or intake payload must support:

```json
{
  "phone_whatsapp": "+201001234567",
  "client_gender": "male",
  "preferred_consultant_gender": "male"
}
```

The orchestrator must reject:

- invalid WhatsApp values when provided
- invalid gender values
- a selected consultant whose stored gender conflicts with the submitted explicit preference

The backend must not trust frontend filtering alone.

---

# 9. Security and Privacy

Gender and WhatsApp data are consultation intake data.

Existing access rules continue to apply:

- clients may access their own consultation data
- assigned consultants may access data required for their consultations
- administrators may access consultation administration data
- public endpoints must expose only consultant gender, not private profile data

Google calendar events must continue excluding client email, phone, and WhatsApp information.

---

# 10. Database Impact

This amendment authorizes:

- one additive nullable constrained text column on `consultants`
- no new tables
- no new consultation statuses
- no new service workflow statuses
- no new PostgreSQL enum

A migration must:

1. add `consultants.gender`
2. add the allowed-value check constraint
3. preserve existing rows
4. leave existing values null until updated
5. avoid activating or publicly listing consultants whose gender remains null

---

# 11. Implementation Order

The approved implementation order is:

1. schema migration for consultant gender
2. backend validation and API contract updates
3. degraded availability behavior
4. OAuth health check and alerts
5. consultant onboarding/profile gender support
6. admin consultant gender and OAuth status support
7. public gender-preference step and filtering
8. WhatsApp international input and validation
9. end-to-end verification

No implementation phase may bypass backend validation.

---

# 12. Required Verification Gates

The amendment is not complete until all tests pass.

## Gate A: Google availability resilience

- revoke or invalidate a consultant OAuth connection
- consultant remains visible and bookable
- availability response reports degraded mode
- MakeHijrah slot conflicts remain blocked
- consultant cannot accept until Google reconnects
- consultant and admin receive idempotent alerts
- reconnecting restores normal mode

## Gate B: WhatsApp validation

- country selector and flag display correctly
- number portion accepts digits only
- valid international number stores in E.164 format
- invalid number is rejected by frontend
- invalid number is rejected independently by orchestrator
- blank value is accepted because WhatsApp remains optional

## Gate C: Gender data

- consultant gender saves through onboarding/profile/admin
- null-gender consultant is excluded from public booking
- active consultant cannot become publicly bookable without gender
- client gender saves in `answers_jsonb`
- consultant preference saves in `answers_jsonb`

## Gate D: Matching

- male preference shows only male consultants
- female preference shows only female consultants
- no preference shows all eligible consultants
- manipulated frontend request with mismatched consultant is rejected by backend
- no-match message and change-preference flow work

## Gate E: Regression

- normal Google availability still uses FreeBusy
- Stripe authorization and capture flow remains unchanged
- consultant acceptance still creates Calendar event and Meet link
- decline and timeout still cancel authorization
- admin cancellation and refund remain functional
- existing role and RLS protections remain intact

---

# 13. Explicitly Not Approved

This amendment does not approve:

- additional gender values for MVP
- automatic consultant assignment
- client-facing disclosure of OAuth technical errors
- bypassing Google Calendar at acceptance
- capturing payment before Google Calendar and Meet creation succeed
- storing unvalidated WhatsApp strings
- a new table for gender preferences
- a new PostgreSQL enum
- removing database slot protection

---

# 14. Approval Record

Abu Mansur approved this amendment in writing on 2026-07-28.

This amendment is now part of the locked MakeHijrah Relocation OS v1.0 specification.
