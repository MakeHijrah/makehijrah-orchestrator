# PROJECT_LOCK Amendment 016 — Recovering an acceptance that failed after the capture

**Status:** Approved
**Implemented by:** migration 051 and the orchestrator commit accompanying this file.
**Relationship to the frozen finance baseline:** **nothing in the finance path changes.** No ledger row, split, snapshot, payout or refund behaviour is touched, and no finance RPC is called, altered or reordered. Migration 051's verification asserts every finance function and the ledger append-only trigger are intact.

---

## 1. The production defect

A consultant accepted a consultation. In order, the orchestrator:

1. verified the Google connection,
2. **captured the payment** — the client's money was taken,
3. tried to create the Google Calendar event, and **failed**,
4. set `status = 'admin_attention'`, `admin_attention_reason = 'calendar_failed'`.

The consultant was then **permanently locked out**. Their client had paid, no calendar event existed, no Meet link existed, and every retry was refused. Nothing in the product could move the consultation forward — there is no admin "retry acceptance" route, only cancel-and-refund.

## 2. Root cause — two layers that disagreed

`finalize_consultation_acceptance` has permitted this recovery **since migration 008**:

```sql
if v_consultation.status = 'admin_attention'
   and v_consultation.admin_attention_reason <>
     'calendar_created_confirmation_failed' then
  raise exception ...
```

The orchestrator's own guard did not:

```ts
if (consultation.status !== "pending_acceptance" &&
    consultation.status !== "captured") {
  return { code: "INVALID_TRANSITION", ... };
}
```

So there were **two independent faults**, and both had to be fixed:

| Layer | Fault |
|---|---|
| `acceptance.service.ts` | refused `admin_attention` outright, so the retry never reached the RPC. This also made migration 008's recovery branch **unreachable dead code** — the intended `calendar_created_confirmation_failed` recovery had never once been able to run. |
| `finalize_consultation_acceptance` | whitelisted only `calendar_created_confirmation_failed`, never `calendar_failed` — the *earlier* and more common of the two post-capture failures. |

The database was designed for this recovery. The orchestrator guard was never widened to match, and the whitelist covered the wrong one of the two failures.

## 3. What is now recoverable, and why exactly these two

```
calendar_failed                        capture succeeded, event creation failed
calendar_created_confirmation_failed   capture succeeded, event created, DB finalize failed
```

Both mean the same thing: **the consultant accepted, the money was captured, and an infrastructure step after the capture failed.** Both leave a consultation that needs only the rest of the flow re-run.

Retrying is safe because both steps are already idempotent:

- `capturePaymentIntent` retrieves first and returns success on an already `succeeded` PaymentIntent — it does not attempt a second capture.
- `finalize_consultation_acceptance` returns the existing row unchanged on a `confirmed` replay, and preserves an `accepted_at` that was already set.

**This stays a whitelist, and every other reason stays refused.** `declined` and `timeout` both cancelled the authorization; an admin cancellation note means the money was refunded. Accepting from any of them would confirm a consultation with no live payment.

**A NULL reason is now refused too.** Migration 008 compared with `<>`, which evaluates to NULL against a NULL reason, so the guard was NULL and fell through to the status check — which admits `admin_attention`. Migration 051 uses `coalesce(...) not in (...)`, closing a hole that had been open since 008.

## 4. The 48-hour window does not apply to a recovery

The window governs whether a consultant **may accept**. A recovery is not a new acceptance: they already accepted inside the window, and their client's money was taken on that acceptance.

If the window closed while the consultation sat in `admin_attention` — entirely possible, since nothing was alerting anyone — applying it on retry would strand a **captured payment** with no calendar event and no way to finish. That is the opposite of what the window is for, so `isRecovery` skips it. The window is unchanged for every first acceptance.

## 5. What this does not do

- **It does not fix whatever made Google fail.** That cause is only in the production logs, under `"Google Calendar event creation failed"`, which records Google's HTTP status, error code, message and status. This amendment makes the consultation **recoverable**; if the Google failure is persistent, the retry will fail the same way until that cause is addressed.
- **No finance change**, no new table, column, status, route or endpoint, and no frontend change — the consultant's existing Accept button now succeeds where it previously returned an error.
