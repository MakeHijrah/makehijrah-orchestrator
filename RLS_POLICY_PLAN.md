# MakeHijrah Relocation OS — RLS_POLICY_PLAN.md

**Version:** 1.0 (draft for Dave's review)

---

## 0. The security model in one paragraph

Two clients touch Postgres. **Lovable** uses the anon key + Supabase Auth JWT and is governed entirely by RLS — it can only ever *read* safe data and *write* the handful of things a user legitimately owns (own profile, own messages, consultant's own notes/recommendations). **The Node orchestrator** uses the service role key and bypasses RLS — it owns every state transition, every payment, every token, every calendar call. If a write involves money, status, tokens, or Google, it does not have an RLS policy allowing it; it goes through the orchestrator or it doesn't happen.

RLS is enabled on **all 15 tables**, no exceptions. Default deny; every access below is an explicit policy.

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
| Command | Policy |
|---|---|
| SELECT | client: `status = 'sent'` AND consultation is theirs; consultant: own (`recommended_by_consultant_id = my_consultant_id()`); admin: all |
| INSERT | consultant, for own consultations, `status` forced to `'proposed'` via `with check` |
| UPDATE | admin only in principle — but the send action (status → `sent`, `sent_at`, `sent_by_admin_id`) should go through the orchestrator anyway because it also triggers the Resend email. So: no client UPDATE policy; orchestrator does it. |
| DELETE | consultant may delete own rows while `status = 'proposed'` (changed their mind pre-send) |

The client-side `status = 'sent'` filter is the load-bearing policy: it's what makes the admin-review step real rather than cosmetic.

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
| Command | Policy |
|---|---|
| SELECT | `sender_profile_id = auth.uid()` OR `recipient_profile_id = auth.uid()` OR `is_admin()` |
| INSERT | `sender_profile_id = auth.uid()` AND sender is a participant of `consultation_id` (client or assigned consultant — security-definer helper `is_consultation_participant(consultation_id)`) AND recipient is the *other* participant |
| UPDATE / DELETE | none (immutable for MVP) |

### `giveaways`
| Command | Policy |
|---|---|
| SELECT | authenticated where `active = true`; admin all |
| INSERT / UPDATE / DELETE | `is_admin()` |

---

## 3. Storage policies

One bucket, locked: `public-media`. No separate avatars/consultant-photos buckets.

- **Read:** public.
- **Write:** authenticated users may upload only under their own prefix: `avatars/{auth.uid()}/*`; consultant photos under `consultants/{auth.uid()}/*`; `giveaways/*` admin-only.
- **Size/type limits:** enforce in Lovable upload component (5 MB, image mime types) — Storage policies can't check mime reliably; acceptable MVP risk since bucket is images-only by convention and public anyway.

---

## 4. Realtime

Not required by the locked flow. Do **not** enable Realtime on any table in MVP. Dashboards refetch on navigation/interval. (Messages could tempt us; resist — polling every 30s in the consultation room is fine for beta.)

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
