# PROJECT LOCK AMENDMENT 005
## Admin ↔ Consultant Direct Messaging

| Field | Value |
|---|---|
| Amendment number | 005 |
| Title | Admin ↔ Consultant Direct Messaging |
| Status | **APPROVED** |
| Date proposed | 2026-07-31 |
| Date approved | 2026-07-31 |
| Supersedes | The `messages` consultation-scoping rule, the `messages` UPDATE/DELETE rule, and the "no Realtime in MVP" rule in `RLS_POLICY_PLAN.md` (see sections 4, 6, 8) |
| Amends | `PROJECT_LOCK.md`, `DATABASE_SCHEMA.md`, `API_CONTRACT.md`, `ROLE_ACCESS_MATRIX.md`, `RLS_POLICY_PLAN.md` |
| Implemented by | `supabase/migrations/migration_023_admin_consultant_direct_messages.sql` |
| Scope | Governance only. This document authorises work. It does not perform it. |

---

## 1. Purpose

1.1 This amendment permits direct messaging between an **admin** profile and a
**consultant** profile, outside any consultation.

1.2 It exists so operational communication with consultants does not have to be
forced through an unrelated client consultation.

---

## 2. Table policy

2.1 **No new table is added.** The 15-table MVP lock in `PROJECT_LOCK.md` is
unaffected and remains binding.

2.2 `public.messages` remains the single message store.

2.3 No conversation table, participant table, notification table, unread counter
column, or trigger-maintained counter is introduced.

---

## 3. Schema change

3.1 `messages.consultation_id` becomes **nullable**.

3.2 `messages.read_at` and `messages.email_notification_sent_at` **already exist**
and are preserved unchanged. No column is added by this amendment.

---

## 4. Message classification

4.1 Every row in `public.messages` is exactly one of:

1. **Consultation message** — `consultation_id IS NOT NULL`. Existing client ↔
   consultant participant rules apply, unchanged.
2. **Direct message** — `consultation_id IS NULL`. Reserved exclusively for
   admin ↔ consultant direct messaging.

4.2 Consultation-scoped client ↔ consultant messaging is **unchanged** by this
amendment. Consultation policies are explicitly re-scoped to
`consultation_id IS NOT NULL` so a direct message can never appear inside a
consultation thread.

4.3 Direct messages are excluded from all consultation-scoped queries.

---

## 5. Participation rules

5.1 A direct message is permitted only between one **admin** profile and one
**consultant** profile.

5.2 **Consultants may initiate and reply to** direct admin messages. A prior
admin message is **not** required before a consultant may insert a direct
message.

5.3 Consultants communicate only with an admin.

5.4 **Clients cannot participate** in direct admin ↔ consultant threads.

5.5 **Consultant-to-consultant** direct messaging is prohibited.

5.6 Admins may read and send direct consultant messages.

5.7 Consultants may read and send only their own direct admin conversation. A
consultant cannot read another consultant's direct thread.

5.8 `sender_profile_id` must equal `auth.uid()`. Sender spoofing is prohibited.

---

## 6. Read state

6.1 Admins may mark **received** consultant messages read.

6.2 Consultants may mark **received** admin messages read.

6.3 Neither party may mark a message they sent as read, nor a message addressed
to anyone else.

6.4 Unread state is always derived from `messages.read_at`. No counter is
maintained anywhere.

6.5 This supersedes the `RLS_POLICY_PLAN.md` rule that `messages` has no UPDATE
policy. A narrow UPDATE policy is introduced, constrained by trigger to
`read_at` only.

---

## 7. Immutability

7.1 Message `body` and identity fields (`id`, `consultation_id`,
`sender_profile_id`, `recipient_profile_id`, `created_at`) are immutable after
insert, enforced by trigger.

7.2 `read_at` is the only column any client may update.

7.3 Messages are **not deletable**. No DELETE policy exists. Where QA rows must
be removed, that is an authorised service-role maintenance action, not a policy
change.

---

## 8. Delivery mechanism

8.1 The frontend already uses **Supabase Realtime** (`postgres_changes`) for
messages in `MessageThread`, `useUnreadMessageCounts` and
`useUnreadNotifications`.

8.2 This supersedes the `RLS_POLICY_PLAN.md` instruction to enable Realtime on no
table in MVP, **for `public.messages` only**. Realtime configuration for every
other table is unchanged.

8.3 Realtime is an optimisation, not a correctness requirement: every consuming
query retains a refetch path, so the feature degrades to refetch-on-interval if
the publication is absent.

---

## 9. Excluded functionality

9.1 No attachment, thread, reaction, typing-indicator, presence,
push-notification, or email-notification functionality is introduced.

9.2 Direct messages deliberately do **not** trigger the existing email
notification path.

---

## 10. Interface delivery

10.1 The **admin interface is delivered first**: `/admin/messages`, admin data
access, admin unread badge, and admin header bell.

10.2 The **consultant-facing interface will be implemented in a separate
frontend build**. The database path it requires — including consultant-initiated
direct messages — is delivered and enforced by migration 023, so no further
schema or policy change is expected for it.
