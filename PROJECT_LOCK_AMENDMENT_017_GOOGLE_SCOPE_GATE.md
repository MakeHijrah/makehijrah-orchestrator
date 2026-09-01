# PROJECT_LOCK Amendment 017 — Refusing a Google grant that cannot do the job

**Status:** Approved
**Implemented by:** the orchestrator commit accompanying this file. **No migration.**
**Relationship to the frozen finance baseline:** no ledger, split, snapshot, payout or refund behaviour changes. It changes **when** a capture is attempted, never how money is calculated or recorded — and only ever by refusing *before* the capture, never after.

---

## 1. What actually happened

Consultation `549beff0`, 2026-09-01: the client paid, the consultant accepted, **$97 was captured in live mode**, and creating the Google Calendar event failed. The booking was stranded — money taken, no event, no Meet link.

The cause was not a Google outage. The consultant's stored grant was:

```
openid
https://www.googleapis.com/auth/calendar.events.freebusy
https://www.googleapis.com/auth/userinfo.email
```

`https://www.googleapis.com/auth/calendar.events` — the scope that **creates** an event — was never granted. Google presents its scopes as individual checkboxes and lets a user untick one while still completing the flow.

**Nothing checked.** `scopes` was written at connect time and never read again. The connection looked healthy by every measure the system had — the row existed, it was not revoked, the refresh token worked — so acceptance proceeded, captured the money, and only then discovered the token had no permission to create anything.

**2 of 7 consultants were in this state**, and the second had no calendar scopes at all.

## 2. Two gates, because there are two moments to catch it

### At connect time — refuse the grant

The OAuth callback now checks the granted scopes and, if a required one is missing, **saves nothing** and redirects with `google=error&reason=missing_calendar_permission`.

Saving nothing matters: a consultant who already has a good grant and re-runs the flow badly **keeps the good one** rather than overwriting it with a broken one.

`prompt=consent` was already set, so Google reliably re-presents the checkboxes on a reconnect. What was missing was any consequence for unticking one.

### At use time — refuse before the capture

`getGoogleAccessToken` now takes the scopes the **caller** needs and returns `OAUTH_INSUFFICIENT_SCOPE` when the stored grant lacks one. Acceptance and event creation both ask for `calendar.events`.

In acceptance this check sits **before `capturePaymentIntent`**. That ordering is the entire point: the same grant that stranded `549beff0` now stops the acceptance with *"Reconnect Google Calendar and allow calendar access"* while the client's money is still only authorised.

## 3. Why the requirement is per-operation and not global

The obvious implementation — one global required-scope list enforced inside `getGoogleAccessToken` — is **wrong, and would have caused a second outage.**

The consultant on `549beff0` *does* hold `calendar.events.freebusy`. Their **availability works fine**. A global gate would have refused their token everywhere and broken a working calendar for no reason.

So callers state what they need. Availability passes nothing and behaves exactly as before; event creation asks for `calendar.events`. A consultant who can answer free/busy but not create events is degraded in precisely the one way that is true of them.

## 4. Two deliberate limits

**Only enforced when scopes were recorded.** An empty `scopes` column means the grant is *unknown*, not known-bad, so it is allowed through rather than risk refusing a consultant whose access works.

**Checked against the two calendar scopes, never against `GOOGLE_OAUTH_SCOPES`.** Google normalises the requested `email` to `.../auth/userinfo.email` in its response, so matching the requested list verbatim would reject **every** grant, good ones included. A test pins this.

## 5. What this does not do

- **It does not repair the two existing broken connections.** Those consultants must reconnect; the connect-time gate is what makes that reconnect trustworthy.
- **No migration**, no schema change, no new table, column, status, route or endpoint.
- **No finance change**, and no change to availability behaviour.
- **No frontend change required.** The redirect stays `google=error`, which the profile screen already handles; `reason` is additive for a screen that wants to name the missing permission.
