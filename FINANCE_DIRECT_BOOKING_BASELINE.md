# MakeHijrah Relocation OS — Finance + Direct Booking Release Baseline

**Feature group:** Finance, payouts, recommendation/service purchases, admin finance analytics, independent consultant direct booking
**Baseline date:** 2026-08-12
**Status:** FROZEN — verified release baseline
**Scope of this freeze:** this feature group only. It does **not** declare the MakeHijrah application production-complete; `V1_RELEASE_REPORT.md` remains the record of the v1.0.0 product release and is unchanged by this document.

---

## Verification key

Same convention as `V1_RELEASE_REPORT.md`, and for the same reason: a baseline
record is a document people trust later without re-checking, so every claim
carries where it came from.

| Mark | Meaning |
|---|---|
| **[D]** | Verified directly in this workspace |
| **[M]** | Manually verified by the owner against the live product |
| **[O]** | Owner-supplied; not independently confirmed here |

The **frontend repository is not present in this workspace.** Every frontend
claim below is therefore **[O]** or **[M]**, never **[D]**.

---

## 1. Finance release — delivered

| Area | Status | Evidence |
|---|---|---|
| Financial foundation (ledger, balances, references) | Complete | **[D]** |
| Consultant earnings and payouts | Complete | **[D]** |
| Admin finance | Complete | **[D]** |
| Recommendation / service purchase finance | Complete | **[D]** |
| Admin finance and dashboard reconciliation | Complete | **[D]** |
| Direct booking finance integration | Complete | **[D]** |
| Backend financial regression | **PASS** | **[D]** |
| Frontend finance regression (automated) | **PASS** | **[O]** |
| Manual finance verification (browser) | **PASS** | **[M]** |

## 2. Direct booking — delivered

- An **independent consultant booking page** is integrated into the existing consultation system — same table, same statuses, same draft hold, same double-booking protection, same checkout, capture, completion, refund and timeout. **[D]**
- **Standard and direct commission rules verified** against PostgreSQL 16. **[D]**
- **Direct booking price ownership verified** — consultant owns the price, admin owns the link and whether the page is live, the effective price is server-derived. **[D]** source, **[M]** live.
- **Slug governance verified** — admin-managed, generated at activation, reserved set enforced orchestrator-side, direct browser writes blocked at the database. **[D]**
- **Stripe cancellation return verified** — standard returns to `/consultation`, direct returns to the consultant's own page. **[D]** source, **[M]** live.
- **Direct booking feeds the same financial ledger and payout system.** One ledger table, one payout pipeline, no second money path. **[D]**

## 3. Backend financial regression — results

Run in this workspace against PostgreSQL 16 with migrations **001–049 replayed
(0 failures)**, in a transaction that rolled back. **[D]**

| # | Case | Result |
|---|---|---|
| 1 | Standard consultation economics | PASS |
| 2 | Direct booking economics | PASS |
| 3 | Snapshot immutability | PASS |
| 4 | Consultant balance reconciliation | PASS |
| 5 | Payout request | PASS |
| 6 | Payout approval | PASS |
| 7 | Payout rejection | PASS |
| 8 | Payout paid | PASS |
| 9 | Refund before payout | PASS |
| 10 | Refund after payout / negative balance | PASS |
| 11 | Admin adjustments | PASS |
| 12 | Service purchase finance | PASS |
| 13 | Multi-currency separation | PASS |
| 14 | Idempotency | PASS |
| 15 | PAY / ADJ references | PASS |
| 16 | Finance read models | PASS |
| 17 | Authorization boundaries | PASS |
| 18 | Direct booking regression | PASS |
| 19 | Standard booking regression | PASS |

Supporting figures, all **[D]**:

- Backend suite **702/702**, typecheck, typecheck:test and build clean.
- Migration verification suites **038–049: 138 pass-notices, 0 errors**.
- Admin KPI read model **usd gross 133000 / platform 73500 / consultant 59500**, reconciling **exactly** to the raw ledger sums; by-source rows summing to the same totals.
- Locked direct booking example: platform default 15000, direct price 20000 → **consultant 11500 / platform 8500**.

## 4. Frontend finance verification — recorded

All **[O]** unless marked, recorded as supplied by the owner:

- Automated suite passed. **[O]**
- Platform revenue CSV missing-export defect **fixed** in frontend commit `00e676e`. **[O]**
- Manual consultant finance verification **PASS**. **[M]**
- Manual admin finance verification **PASS**. **[M]**
- Client finance role-gating **PASS**. **[M]**
- Consultant / admin number reconciliation **PASS**. **[M]**
- Direct booking finance **PASS**. **[M]**
- Payout UI **PASS**. **[M]**
- CSV exports **PASS**. **[M]**
- Mobile finance **PASS**. **[M]**
- **No remaining finance defects reported.** **[O]**

## 5. Commits in this baseline

**Backend** (verified in this workspace, **[D]**):

| Commit | Change |
|---|---|
| `4326df4` | Direct booking setting ownership correction — admin owns slug and enabled, consultant owns price |
| `25e4bf0` | Direct booking Stripe cancel return URL |

Live verification of both: **[M]** — standard cancellation PASS, direct consultant cancellation PASS, ownership behaviour PASS.

**Frontend verified release commits** (**[O]** — recorded as supplied; the
frontend repository is not present here and these were not resolved or
inspected in this workspace):

```text
ddeaf41
fdff975
b87d90e
8c34b06
b49502f
554a758
00e676e
```

## 6. Finance rules frozen in this baseline

These are the rules the regression above verified. Changing any of them is a
new scope, not a patch.

**Money representation**
- Integer **minor units only**. No floating-point money arithmetic anywhere.
- The ledger is **append-only**. Nothing is edited or deleted; corrections are new rows.

**Splits**
- **Standard consultations:** 50 / 50 gross split.
- **Direct booking:** the base portion up to the platform default splits **50 / 50**; the **premium above the default splits 80 % consultant / 20 % platform**. Written as two ledger components, never one blended rate.

**Snapshots**
- Historical financial snapshots are **immutable**. Later changes to the platform price, a consultant's direct price or a service's commission rate do **not** recalculate anything already recorded.

**Availability**
- Consultation earnings become available **after consultation completion**.
- Service purchase earnings are created **on successful payment** and become available **after fulfilment**.

**Corrections**
- Refunds and reversals **append negative entries** mirroring the original snapshot.
- Admin corrections **append adjustment entries** carrying actor, reason and timestamp.

**Payouts**
- A payout request **reserves** the earnings it covers.
- **Rejected or cancelled** payouts **release** their allocations back to available.
- **Paid payouts are terminal** and immutable.
- A consultant balance **may go negative** after a post-payout refund; **future earnings offset** that debt rather than it being written off.
- **No automatic payouts.** Every payout is requested and decided.

**Currency**
- Currencies remain **separate** — balances, reservations and payouts never combine them.
- **No FX conversion exists** anywhere in the system.

**References**
- `PAY` and `ADJ` references remain **globally unique and monotonic** under the current implementation. They are **not** per-consultant sequences, and nothing should assume they are.

## 7. Technical debt carried forward — not fixed

Recorded deliberately. None of it blocks this baseline.

### 7.1 Stale verification artifacts

`MIGRATION_026`, `027`, `030`, `031`, `032`, `033`, `035` and
`037_VERIFICATION.sql` fail against the current schema. **[D]**

- **Classification:** low-priority **test-artifact debt**.
- **Not a production finance defect.** The failures are stale assumptions in the verification files themselves: hard-coded table counts (16 / 20 against an actual 21 after the finance-era tables), pre-migration-039 payout RPC signatures, and one file (026) that is an un-substituted template carrying placeholder UUIDs.
- **Behaviour re-covered** by the later migration and finance verification suites, which pass 138 / 138.

### 7.2 CSV export formatting

CSV formula-injection protection causes **negative exported amounts to import
as text** in spreadsheet applications. **[O]**

- **Classification:** non-blocking **export-format** technical debt.
- **Not a release blocker.** The protection itself is correct and is doing its job; the cost is a formatting nuisance on negative values.

### 7.3 Operational items outstanding

- The **production consultant slug backfill** (`npm run backfill:consultant-slugs`) has not been run from this workspace — no production credentials are available here. **[D]**
- The **frontend must not send** `consultant_slug` or `direct_booking_enabled` to `PATCH /api/consultant/direct-booking`; both are now refused with `400` under Amendments 012 and 013. **[D]**

---

## 8. Freeze statement

> Finance, payouts, recommendation purchases, admin finance analytics, and independent consultant direct booking have completed backend regression, frontend automated verification, and manual browser verification. This feature group is frozen as the current verified release baseline. Future changes require a separately approved scope and regression appropriate to the affected subsystem.

This freeze covers **this feature group only**. It makes no claim about the
completeness of the wider MakeHijrah application; `V1_RELEASE_REPORT.md`
remains the authority on the v1.0.0 product release and is unchanged.

---

## 9. Next dependency

**Review the remaining MVP acceptance criteria against the current verified
build state and identify the first genuinely incomplete criterion.**

No next feature has been selected. Selecting one before that review would risk
building against an assumption rather than against what the product actually
still needs.
