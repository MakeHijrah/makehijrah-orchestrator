# MakeHijrah Relocation OS — RLS_POLICY_PLAN.md

**Version:** 1.0 (draft for Dave's review)

---

## 0. The security model in one paragraph

Two clients touch Postgres. **Lovable** uses the anon key + Supabase Auth JWT and is governed entirely by RLS — it can only ever *read* safe data and *write* the handful of things a user legitimately owns (own profile, own messages, consultant's own notes/recommendations). **The Node orchestrator** uses the service role key and bypasses RLS — it owns every state transition, every payment, every token, every calendar call. If a write involves money, status, tokens, or Google, it does not have an RLS policy allowing it; it goes through the orchestrator or it doesn't happen.

RLS is enabled on **all 16 tables**, no exceptions. Default deny; every access below is an explicit policy. *(Amended from 15 to 16 by PROJECT_LOCK Amendment 007, which added `app_settings` — the one table with RLS enabled and deliberately **zero** policies.)*

---

## 1. Helper functions

Never reference the querying table inside its own policy (recursion). Use `security definer` helpers:

```sql
create or replace function public.current_role()
returns user_role language sql stable security definer
set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_consultant_id()
returns uuid language sql stable security definer
set search_path = public as $$
  select c.id from consultants c where c.profile_id = auth.uid();
$$;
```

This is the same `SECURITY DEFINER` pattern we use on Sufra/KB — role checks never read the row being checked.

---

## 2. Per-table policies

Notation: policies are per-command. Anything not listed = denied for anon/authenticated. Service role bypasses everything.

### `profiles`
| Command | Policy |
|---|---|
| SELECT | own row (`id = auth.uid()`) OR `is_admin()` |
| UPDATE | own row, **excluding** `role` and `email` — enforced via a `before update` trigger that rejects role/email changes when `auth.role() <> 'service_role'` (RLS can't do column-level) |
| INSERT / DELETE | none (trigger creates; nothing deletes) |

Consultant names/photos shown to clients come from `consultants` (below), not from cross-reading `profiles`.

### `consultants`
| Command | Policy |
|---|---|
| SELECT | `is_active = true` for **anon + authenticated** (booking form needs it pre-login) OR own row (`profile_id = auth.uid()`) OR `is_admin()` |
| UPDATE | own row for the safe columns only (`headline`, `bio`, `photo_url`, `timezone`, `working_hours_jsonb`, `minimum_booking_notice_hours`) — column protection via trigger blocking `is_active`, `available_for_general`, `profile_id` unless service role/admin |
| INSERT / DELETE | none from client. Row is created by orchestrator during invite redemption |

Note: public SELECT exposes `working_hours_jsonb`. That is acceptable — it's marketing-adjacent data, not secret. Nothing sensitive lives on this table.

### `consultant_invites`
| Command | Policy |
|---|---|
| SELECT | `is_admin()` only |
| INSERT / UPDATE / DELETE | none — all via orchestrator (token hashing is server-side by definition) |

Even admins never see `token_hash` usefully; consider excluding it from the admin UI query.

### `countries`
| Command | Policy |
|---|---|
| SELECT | everyone (anon + authenticated), `is_active = true`; admins see all |
| INSERT / UPDATE / DELETE | `is_admin()` |

### `consultant_countries`
| Command | Policy |
|---|---|
| SELECT | everyone (needed to filter consultants by country in booking form) |
| INSERT / DELETE | `is_admin()` (assignment is an admin action per Week 2 scope) |

### `oauth_connections`
| Command | Policy |
|---|---|
| ALL | **no policies at all.** RLS enabled, zero policies = zero client access. Service role only. |

The one exception worth offering: consultants need to see *whether* they're connected. Solve in UI via an orchestrator endpoint `GET /api/consultant/oauth-status` returning `{connected: bool, google_email}` — never a direct table read.

### `consultations`
| Command | Policy |
|---|---|
| SELECT | client: `client_profile_id = auth.uid()`; consultant: `consultant_id = my_consultant_id()`; admin: all |
| INSERT / UPDATE / DELETE | **none.** Every consultation is created (draft) and transitioned by the orchestrator. Consultant Accept/Decline buttons call orchestrator endpoints, not Supabase. |

This is the single most important row in this document. If Lovable can write `consultations.status`, the payment system is broken.

### `consultation_intake`
| Command | Policy |
|---|---|
| SELECT | client: via join — intake's consultation belongs to them; consultant: same via `my_consultant_id()`; admin: all |
| INSERT / UPDATE | none — written by orchestrator during booking |

### `consultation_notes`
| Command | Policy |
|---|---|
| SELECT | consultant: `consultant_id = my_consultant_id()`; admin: all. **Client: nothing.** |
| INSERT | consultant, only for consultations where `consultant_id = my_consultant_id()` and consultation status is `confirmed`, `captured`, or `completed` (check via security-definer helper). `confirmed` is included so the consultant can take notes during the call without waiting on an admin action. |
| UPDATE | consultant, own notes only |
| DELETE | none |

### `services`
| Command | Policy |
|---|---|
| SELECT | authenticated where `is_active = true`; admin all — policy `services_select_active`, unchanged |
| INSERT | **none** for authenticated |
| UPDATE | **none** for authenticated |
| DELETE | **none** for authenticated |

Service role only for every mutation. This supersedes the original v1.0 rule, which granted `is_admin()` write access directly through RLS. Admins now manage the catalog exclusively through the orchestrator endpoints in `API_CONTRACT.md` §3a, because a service write can create or supersede Stripe Product, Price and Payment Link resources — side effects RLS cannot perform or police.

**Applied by migration 022** (PROJECT_LOCK Amendment 004, approved):

- revoked `INSERT` on `public.services` from `authenticated`;
- revoked `UPDATE` on `public.services` from `authenticated`;
- revoked `DELETE` on `public.services` from `authenticated`;
- dropped policy `services_insert_admin`;
- dropped policy `services_update_admin`;
- dropped policy `services_delete_admin`;
- retained policy `services_select_active`, unchanged.

`services_select_active` is now the only policy on the table. `authenticated` holds `SELECT` and nothing else. RLS remains enabled and not forced, so service role and postgres continue to bypass it exactly as before.

### `service_recommendations`

Verified live behaviour.

| Command | Policy |
|---|---|
| SELECT | client: `status = 'sent'` **AND** the parent consultation belongs to `auth.uid()`; consultant: own (`recommended_by_consultant_id = my_consultant_id()`); admin: all |
| INSERT | consultant, for own consultations, `status` forced to `'proposed'` via `with check` |
| UPDATE | **no consultant UPDATE policy exists.** The `proposed` → `sent` transition is performed only by the orchestrator under the service role, through `POST /api/admin/recommendations/:id/send` |
| DELETE | consultant may delete own rows while `status = 'proposed'` (changed their mind pre-send) |

The client-side `status = 'sent'` filter is the load-bearing policy: it is what makes the admin-review step real rather than cosmetic. A `proposed` recommendation is invisible to the client, and a consultant has no database path to make one visible.

**The maximum of three recommendations per consultation is enforced in PostgreSQL**, by the `enforce_service_recommendation_limit` trigger on `before insert` (migration 013). It is not a UI or orchestrator-only rule. Sent recommendations remain part of the three-item allowance. A theoretical race exists between concurrent inserts because the trigger counts rows; this is an accepted v1.0 limitation.

**Payment links.** A `sent` recommendation exposes its service's Stripe Payment Link to the client through the normal `services` read path (`services_select_active`), not through any additional policy on this table.

### `service_requests`
| Command | Policy |
|---|---|
| SELECT | client: own; admin: all. Consultant: none in MVP (not in the locked flow) |
| INSERT / UPDATE / DELETE | `is_admin()` for status changes via dashboard is acceptable here (no money, no external side effects) — or orchestrator; either is safe. I default to direct admin RLS to save an endpoint. |

### `payments`
| Command | Policy |
|---|---|
| SELECT | `is_admin()` only |
| INSERT / UPDATE / DELETE | none — webhook/orchestrator only |

Clients see payment outcome through `consultations.status`, never through the Stripe log.

### `messages`

Live model is **post-migration 023** (PROJECT_LOCK Amendment 005, applied and verified). The original three-policy consultation-only set was dropped by name and replaced with **six** policies: three scoped to `consultation_id is not null`, three to `consultation_id is null`.

**Consultation messages**

| Policy | Command | Rule |
|---|---|---|
| `messages_consultation_select` | SELECT | `consultation_id is not null` AND (`sender_profile_id = auth.uid()` OR `recipient_profile_id = auth.uid()` OR `is_admin()`) |
| `messages_consultation_insert` | INSERT | `consultation_id is not null` AND `sender_profile_id = auth.uid()` AND `recipient_profile_id <> auth.uid()` AND `is_consultation_participant(consultation_id, auth.uid())` AND `is_consultation_participant(consultation_id, recipient_profile_id)` |
| `messages_consultation_update` | UPDATE | `consultation_id is not null` AND `recipient_profile_id = auth.uid()` (both `using` and `with check`) |

**Direct admin ↔ consultant messages**

| Policy | Command | Rule |
|---|---|---|
| `messages_direct_select` | SELECT | `consultation_id is null` AND (`sender_profile_id = auth.uid()` OR `recipient_profile_id = auth.uid()` OR `is_admin()`) |
| `messages_direct_insert` | INSERT | `consultation_id is null` AND `sender_profile_id = auth.uid()` AND `recipient_profile_id <> auth.uid()` |
| `messages_direct_update` | UPDATE | `consultation_id is null` AND `recipient_profile_id = auth.uid()` (both `using` and `with check`) |

Rules that hold across both classes:

- **Direct messages require `consultation_id is null`; consultation messages require `consultation_id is not null`.** The column is the sole classifier.
- **The direct pair must be exactly one admin and one consultant.** This is enforced by the `messages_direct_pairing` trigger reading `public.profiles`, not by policy — which is why `messages_direct_insert` only has to pin the sender to the caller.
- **Clients cannot participate in direct messaging** in either direction; the pairing trigger rejects them.
- **A consultant cannot reach another consultant's direct thread** — the pairing trigger rejects consultant ↔ consultant on insert, and the select policies scope reads to participants (or admin).
- `sender_profile_id` must equal `auth.uid()` on insert. Spoofing a sender fails the `with check`.
- **UPDATE exists solely so a recipient can set `read_at` on a message they received.** The `messages_guard_columns` trigger blocks every other column for non-privileged writers, so the UPDATE policy cannot be used to rewrite a body.
- **No DELETE policy on either class.** Messages are not deletable. Removing QA rows is an authorised `service_role` maintenance action.
- `messages` is the **only** application table authorised for Realtime, for direct-conversation presence under Amendment 005. See §4.

### `giveaways`
| Command | Policy |
|---|---|
| SELECT | authenticated where `active = true`; admin all |
| INSERT / UPDATE / DELETE | `is_admin()` |

### `app_settings`

Added by **PROJECT_LOCK Amendment 007**, applied as migration 025.

| Command | Policy |
|---|---|
| SELECT | **none** |
| INSERT / UPDATE / DELETE | **none** |

**RLS is enabled and no policy exists.** Under PostgreSQL, a table with RLS enabled and zero policies denies every row to every non-bypassing role, so `anon` and `authenticated` — admin included — have no access whatsoever. This is deliberately stronger than a restrictive policy and simpler to audit: there is no expression to get wrong.

In addition, migration 025 runs `revoke all on public.app_settings from anon` and `from authenticated`, so the intent survives even if a policy is added by mistake later.

The orchestrator's service role bypasses RLS and is the only reader and writer. Admin settings reads and writes go through orchestrator endpoints (Phase 2), never through the browser.

**The table contains no secret.** Stripe secret keys and webhook signing secrets remain solely in Railway environment variables; `app_settings.stripe_mode` only selects between them. No credential column may ever be added to this table.

**Not in the `supabase_realtime` publication** — see §4.

---

## 3. Storage policies

One bucket, locked: `public-media`. No separate avatars/consultant-photos buckets.

- **Read:** public.
- **Write:** authenticated users may upload only under their own prefix: `avatars/{auth.uid()}/*`; consultant photos under `consultants/{auth.uid()}/*`; `giveaways/*` admin-only.
- **Size/type limits:** enforce in Lovable upload component (5 MB, image mime types) — Storage policies can't check mime reliably; acceptable MVP risk since bucket is images-only by convention and public anyway.

---

## 4. Realtime

Not required by the locked flow. Do **not** enable Realtime on any table in MVP. Dashboards refetch on navigation/interval. (Messages could tempt us; resist — polling every 30s in the consultation room is fine for beta.)

`app_settings` is explicitly **not** added to the `supabase_realtime` publication (Amendment 007 §3.5). Settings change rarely and are delivered through orchestrator endpoints; a Realtime subscription would also be a browser-side read path on a table that has none by design.

`messages` is in the publication as discovered live and is used for direct-message presence under Amendments 005 and 006. That predates this section and is unchanged.

---

## 5. Testing checklist (before Week 1 sign-off)

Run as three test users (client / consultant / admin) via anon key:

1. Client cannot `select * from oauth_connections` (0 rows, no error leakage).
2. Client cannot `update consultations set status = 'captured'` (denied).
3. Client cannot see another client's consultations.
4. Client cannot see `service_recommendations` where status = `proposed`.
5. Client cannot see any `consultation_notes`.
6. Consultant cannot see another consultant's consultations or notes.
7. Consultant cannot update `consultants.is_active` on own row.
8. Anon can read active consultants + countries (booking form pre-login).
9. Nobody but admin reads `payments` or `consultant_invites`.
10. Profile `role` cannot be self-escalated via UPDATE.
11. **Admin cannot `insert`, `update` or `delete` `services` directly** (denied — catalog writes route through the orchestrator per Amendment 004).

Item 10 is the classic Supabase privilege-escalation hole; the trigger in §2 exists specifically for it.
