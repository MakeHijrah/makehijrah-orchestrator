# PROJECT_LOCK Amendment 006 — Direct Message Presence and Email Notifications

| Field | Value |
|---|---|
| Status | PROPOSED — requires written approval from Dave |
| Supersedes | PROJECT_LOCK Amendment 005, sections 9.1 and 9.2, only as stated below |
| Amends | `PROJECT_LOCK.md`, `API_CONTRACT.md`, `ROLE_ACCESS_MATRIX.md` |
| Implemented by | Frontend presence owner module; orchestrator message-notification service |
| Database migration | **None.** No schema change is required or permitted by this amendment. |
| Scope | Governance only. This document authorises work. It does not perform it. |

## 1. Standing

1.1 Amendment 005 remains authoritative in full, except for sections 9.1 and
9.2, which are superseded only to the extent set out in sections 2 and 3 below.

1.2 Every other rule in Amendment 005 — participation rules, read state,
immutability, RLS, and the exclusion of clients — is unchanged and continues to
govern.

## 2. Presence (supersedes Amendment 005 section 9.1 in part)

2.1 Direct admin ↔ consultant conversations use **Supabase Presence**, scoped to
a single conversation pair.

2.2 Presence is **informational only**. It never gates sending, reading,
scheduling, or delivery, and no decision anywhere in the system depends on it.

2.3 Presence means one thing: the peer currently has **that exact direct
conversation open**. It is not a claim about the peer's presence anywhere else
in the application.

2.4 **No global user-presence system is introduced.** No presence indicator is
added to any list, dashboard, or navigation surface.

2.5 The presence payload contains only `profile_id` and `online_at`. No email,
name, role, token, message content, or consultation data is ever transmitted.

2.6 Presence state is ephemeral and lives only in the Supabase Realtime
channel. **No table, column, or persisted record is created for it.**

2.7 A presence failure must degrade to Offline. It may never crash the thread
or the application shell.

2.8 Consultation-scoped presence is unchanged by this amendment.

## 3. Email notifications (supersedes Amendment 005 section 9.2)

3.1 Direct admin ↔ consultant messages now use the **existing delayed email
notification pipeline**. No second pipeline, queue, or delivery path is created.

3.2 The existing delay, Redis due-set, per-message locking, retry behaviour, and
Mandrill delivery are unchanged.

3.3 `messages.email_notification_sent_at` remains the **sole idempotency
marker**. It is written only after a successful send, and only while the message
is still unread and not already marked.

3.4 If the recipient reads the message before the delay expires, **no email is
sent**. Read suppression applies identically to both message classes.

3.5 The orchestrator validates direct-message role pairing **from
`public.profiles`**, never from any value supplied by a client. It requires
exactly one admin and one consultant, rejects self-send, rejects
consultant ↔ consultant, rejects admin ↔ admin, and rejects any client
participation.

3.6 Direct-message email tags and metadata must not carry a null consultation
identifier. Direct emails are tagged `direct-message`; consultation emails
remain tagged `consultation-message`.

3.7 Email metadata is limited to `message_id`, `sender_role` and
`recipient_role`. **Message body is never placed in metadata.**

3.8 Portal links follow the existing protected-link convention: the recipient is
sent to `/login?redirect=<encoded protected path>`, being `/admin/messages` for
an admin recipient and `/consultant/messages` for a consultant recipient.

3.9 **No email reply ingestion.** Replies to notification email are not
monitored, parsed, or delivered into any thread.

3.10 **No push notifications** of any kind are introduced.

## 4. Unchanged by this amendment

4.1 The database schema is **unchanged**. No new table, column, enum, index,
policy, or trigger.

4.2 `public.messages` remains the **only** message store.

4.3 No new message status is introduced.

4.4 Messages remain non-deletable and non-editable. `read_at` remains the only
client-writable column.

4.5 **Clients remain excluded** from direct admin ↔ consultant messaging, for
both presence and email.

4.6 Consultation messaging — its threads, presence, notifications, subjects,
tags, and portal links — is **unchanged in every respect**.

## 5. Interface delivery

5.1 Presence and email apply to both directions of an existing direct
conversation and to both the `/admin/messages` and `/consultant/messages`
interfaces, which share one thread implementation.

5.2 The orchestrator notification endpoint is extended to accept an
authenticated **admin** caller. This is required because an admin sending a
direct message must be able to schedule its notification; it grants no other
admin capability.
