# Frontend spec — "Needs attention" on the consultant dashboard

**Repo:** frontend (not the orchestrator). **No backend change is required.**
**Why:** a paid booking whose calendar step failed disappears from the consultant dashboard entirely.

---

## 1. The bug this fixes

Consultation `549beff0` on 2026-09-01: `status = 'admin_attention'`, `admin_attention_reason = 'calendar_failed'`, payment **captured** ($97 live), session at 17:00 UTC — and it appeared in **none** of the three dashboard sections.

The dashboard buckets are:

| Section | Matches |
|---|---|
| Pending acceptance | `status = 'pending_acceptance'` |
| Upcoming | `status in ('confirmed','captured')` and a future start |
| Past | a start time in the past |

`admin_attention` matches no live bucket, and its start was in the **future**, so it did not fall into Past either. The consultant lost sight of a booking their client had already paid for.

RLS is not involved: `consultations_select_roles` matches on `consultant_id` with **no status filter**, so the row is fully readable. This is purely bucketing.

## 2. The change

Add a **Needs attention** section, rendered **first** — above Pending acceptance.

```
status === 'admin_attention'
  && ['calendar_failed', 'calendar_created_confirmation_failed']
       .includes(admin_attention_reason)
```

Each card shows the scheduled time, the client, and an **Open** action to the existing consultation detail page — which already renders the red banner and working Accept / Decline buttons, so no new screen is needed.

## 3. The part that is easy to get wrong

**Do not bucket every `admin_attention` row as actionable.** Only those two reasons are recoverable. The others are terminal and the consultant cannot act on them:

| Reason | Meaning | Actionable |
|---|---|---|
| `calendar_failed` | captured, calendar event creation failed | **yes** |
| `calendar_created_confirmation_failed` | captured, event created, DB finalize failed | **yes** |
| `declined` | consultant declined; authorization cancelled | no |
| `timeout` | 48h expired; authorization cancelled | no |
| *(admin cancellation note, free text)* | admin cancelled; payment refunded | no |

Showing a terminal one here would give the consultant an Accept button that always fails — the payment behind it no longer exists.

**Match the two reasons explicitly. Never match on `status === 'admin_attention'` alone, and never on a substring of the reason** — an admin cancellation note is free text and could contain anything.

## 4. Keep the list in sync with the backend

That two-reason set is the same whitelist enforced in `acceptance.service.ts` (`RECOVERABLE_ADMIN_ATTENTION_REASONS`) and in `finalize_consultation_acceptance` (migration 051). All three must be widened together or not at all — see PROJECT_LOCK Amendment 016 §3.

Terminal rows are not lost by this spec: they keep falling into Past by date, exactly as now.

## 5. What this deliberately does not change

- **No backend change.** `admin_attention` remains the correct status — the booking genuinely does need attention — and the admin dashboard read model (migration 044) keeps counting it by `status = 'admin_attention'`.
- **No new endpoint.** The dashboard reads `consultations` directly through RLS.
- **No new detail screen.** The existing one already handles this state correctly.
