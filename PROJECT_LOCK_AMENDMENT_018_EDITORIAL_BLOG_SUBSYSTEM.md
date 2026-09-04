# PROJECT_LOCK Amendment 018 — Editorial blog subsystem

**Status:** Approved
**Implemented by:** migrations 052 (imported to this repository as the canonical copy of the frontend's `migration_051_blog.sql`, already applied to production from there), 053 (canonical copy of `migration_052_blog_grants_and_email_invites.sql`, already applied to production from there), 054 (blog revision trigger security, **authored, not yet applied**), 055 (blog redirect hardening, **authored, not yet applied**), 056 (blog scheduler grant hardening, **authored, not yet applied**), plus the orchestrator commit accompanying this file (`POST /api/admin/blog-managers/invite`, the scheduled-publishing worker).
**Relationship to the frozen finance and consultation baseline:** none. No table, trigger, RLS policy, grant or route outside the eight tables listed in §1 is touched. `user_role` is unchanged — see §5.

---

## 1. The eight tables

| Table | Purpose |
|---|---|
| `blog_managers` | The capability grant. §5. |
| `blog_authors` | A byline. Not a profile — may belong to a guest writer or pen name with no login. |
| `blog_categories` | Taxonomy; each is also an indexable landing page and carries its own `seo_title`/`seo_description`. |
| `blog_tags` | Taxonomy. |
| `blog_posts` | The content. `status` is `blog_post_status` — §2. |
| `blog_post_tags` | The post↔tag join. |
| `blog_post_revisions` | Append-only authorship history, written only by trigger. §6. |
| `blog_redirects` | Old-slug → new-slug 301/302/308 mapping. §9. |

Sixteen tables were locked by Amendment 007 (§33 of `PROJECT_LOCK.md`); later amendments (009–017) added more without folding their counts back into that section, and this amendment follows the same practice. The current total, including these eight, is confirmed against a fresh replay of every migration in `supabase/migrations/` rather than restated as a fixed number here, which is what a table count frozen in prose cannot survive past the next amendment.

## 2. `blog_post_status`

`draft`, `scheduled`, `published`, `archived`. A published post must carry `published_at`; a scheduled post must carry `scheduled_for` — both enforced by table constraint, not by application discipline.

## 3. Public read model

**Anon and authenticated** may read: any post with `status = 'published' and published_at <= now()`; every author, category, tag and the post↔tag join, unconditionally (reference data — a tag on an unpublished post discloses nothing, because the post itself is unreadable); every redirect.

**Never public:** a draft, a scheduled post before its time, `blog_managers`, `blog_post_revisions`. A scheduled post's future publish time is a promise, not a state — reading it early would publish an editor's work without their action.

## 4. Manager write permissions

A blog manager (§5) has full authorship: create, edit and change the status of any post; manage authors, categories, tags and their pairing; manage redirects.

**Not granted, by policy or by grant, to a manager:** writing `blog_post_revisions` directly (§6); granting or revoking another manager (§5 — admin only).

## 5. Blog manager is a capability, not a `user_role`

`user_role` remains `client | consultant | admin`, exactly as every consultation and finance policy already depends on. Blog authorship is a row in `blog_managers`, not a fourth enum value, because a Postgres enum value can never be removed, a profile can hold exactly one role, and this capability needs to be additive, revocable with one `DELETE`, and orthogonal to whatever role a person already holds — an admin is a blog manager implicitly (`is_blog_manager()` also returns true for `is_admin()`), and a client can become one without ceasing to be a client.

**Email-first grants (migration 053).** `blog_managers` is keyed on `email`, not `profile_id`, because a grant must be issuable to somebody with no account yet — there is no public sign-up, and `signInWithOtp` runs with `shouldCreateUser: false`, so an outside contractor had no way to obtain a login before this. `profile_id` is informational, filled in by `link_blog_manager_profile()` (a trigger on `profiles`, migration 053) the moment the person first signs in, and `is_blog_manager()` matches on **either** identity — profile_id, or a case-insensitive, trimmed match against the verified email in the caller's JWT. Access never depends on the linking trigger having run.

Granting and revoking the capability is **admin-only**, by RLS (`blog_managers_write_admin`) and by the invite endpoint's own guard (§7): a manager who could appoint managers would be an administrator by another name.

## 6. Revision model

`blog_posts_after_write()` (an `AFTER INSERT OR UPDATE` trigger on `blog_posts`) inserts one row into `blog_post_revisions` on every post insert, and on every update where `title`, `excerpt` or `body_html` actually changed — a status-only or SEO-only edit creates no revision. `edited_by` is `auth.uid()`, the calling session's own identity.

**Migration 054, fixing a live defect.** As imported, the trigger function carried no `SECURITY` clause and ran as the calling role, `authenticated` — which migration 053 grants `SELECT` on `blog_post_revisions` and nothing else. Every post create and every editorial update therefore failed the moment the trigger tried to write a revision. Migration 054 makes the function `SECURITY DEFINER` with a pinned `search_path`, so it writes as its owner (the same role that owns `blog_post_revisions`) regardless of the caller's own grant, and revokes `INSERT`, `UPDATE`, `DELETE` **and `TRUNCATE`** on `blog_post_revisions` from `authenticated` and `anon` explicitly — `TRUNCATE` is not filtered by row-level security at all, so the table grant was the only thing standing between an authenticated caller and erasing the entire revision history in one statement, and leaving it granted would have satisfied "no direct INSERT" while leaving a strictly worse hole open. The same migration closes the identical, unnecessary `EXECUTE` grant on the blog's other three trigger functions (`blog_posts_before_write`, `blog_touch_updated_at`, `link_blog_manager_profile`), matching the convention this codebase already applies to every other trigger function.

**The result:** revision history is immutable outside the trigger path, for a manager and an admin alike — proven in `MIGRATION_054_VERIFICATION.sql` by attempting a direct `INSERT`, `UPDATE` and `DELETE` as both roles and confirming each is refused.

## 7. Blog manager invite backend

`POST /api/admin/blog-managers/invite` — admin-only, strict `{ email, note? }` body. Resolves or creates the Supabase auth account **server-side**, with the service role; the new account's `role` stays `client` — blog access is the grant (§5), never the role. A repeat invite for an address already granted re-sends the email rather than erroring. The Mandrill email links to `/login?redirect=%2Fblog%2Fadmin`. Audited against the implementation for this amendment and found to match; no code changed.

## 8. Scheduled publishing

`publish_due_blog_posts()` (migration 052): one `UPDATE` over every `blog_posts` row where `status = 'scheduled' and scheduled_for <= now()`, setting `status = 'published'` and `published_at = coalesce(published_at, scheduled_for, now())`, returning the count published. `SECURITY DEFINER`. Idempotent by construction — a second call finds nothing left matching `status = 'scheduled'` for a post it already published — which is what makes it safe to call from more than one place or process without coordination.

**Audited and found unwired.** No caller existed anywhere in this backend, and this repository has no access to inspect production's `pg_cron` directly; the absence of any orchestrator caller was the fact establishable from here. A recurring worker is added alongside this amendment (`src/modules/blog/blog-publishing.worker.ts`), modelled on `draft-expiry.worker.ts` — the closest existing precedent, for the identical reason: a single set-based `UPDATE` inside the RPC, not a per-row loop, so ordinary PostgreSQL row locking is what makes two orchestrator instances running the same cycle safe, and the Redis cycle lock is an optimisation against redundant work, not a correctness dependency. Polls every five minutes, publishes on startup so a deploy immediately releases whatever came due while the process was down, and calls no logic beyond the RPC itself — the publication predicate and the `published_at` rule live in exactly one place.

**Migration 056, a second live defect found auditing this one.** `publish_due_blog_posts()`'s own `REVOKE ALL ... FROM PUBLIC` did not remove Supabase's ambient default `EXECUTE` grant to `anon` and `authenticated` by name — the identical mechanism migration 036 (RPC execution hardening — a backend security migration with no locked-behaviour change, so it carries no amendment of its own) closed for the finance and consultation RPCs, made by an author unaware of that finding. Confirmed against a fresh replay of migrations 001 through 055: an anon key could call this function directly. Migration 056 revokes it from `PUBLIC`, `anon` and `authenticated` by name and restates the grant to `service_role`.

## 9. Redirects

`blog_redirects`: `from_path`, `to_path`, `status_code ∈ {301, 302, 308}`, `from_path <> to_path`. Written and read under the same manager/public split as the rest of the blog (§3–4). `from_path` is stored with its leading slash and without a host, matching what the edge handler that serves redirects compares against — that handler is a frontend/infra concern outside this repository; see §11.

**Migration 055, closing an open redirect.** The imported constraint was `like '/%'` — "starts with a slash" — which accepts `//evil.example`: a scheme-relative URL a browser resolves against the *current protocol*, sending a visitor off-site from a table meant to hold only internal paths. Migration 055 replaces both leading-slash constraints with a shared, `IMMUTABLE` function, `is_safe_internal_path(text)`, requiring: exactly one leading slash; no `://` anywhere (not only past the first character); no backslash (some browsers normalize `\` to `/` when resolving a URL, so `/\host` can become `//host` after normalization even though it is never literally `//` or contains `://` — the same open-redirect class, reached through a different character, closed for the same reason); no control character (which includes CR/LF — a raw `\r\n` reaching a raw `Location` header is header injection, not merely an open redirect); non-empty. Before installing the constraint, the migration itself scans every existing row and **raises, naming the offending row, rather than applying anything**, if one would fail the new rule — proven in `MIGRATION_055_VERIFICATION.sql` by seeding an unsafe row, confirming the migration aborts with nothing committed, correcting it, and confirming the same migration then succeeds.

This repository has no redirect-serving code of its own — see §11.

## 10. sitemap / RSS / robots ownership

Owned entirely by the frontend/edge layer, reading `blog_posts`, `blog_categories` and `blog_redirects` directly under the public RLS policies in §3. This backend defines no sitemap, feed or robots route and generates none of that content.

## 11. Migration ownership and the frontend/backend boundary

**This repository owns canonical migration history**, for the blog exactly as for every other table. Migrations 052 and 053 are the canonical, byte-for-byte (save for renumbered header cross-references) copies of the SQL that was authored and already applied to production from the frontend repository — imported here specifically so a fresh environment can reproduce the blog schema from this repository alone. **They are historical record, not pending work: they must never be reapplied to the production database that already ran them under their original numbers.**

**What this backend owns:** every migration, every RPC, every RLS policy and grant, `is_blog_manager()`, the revision trigger, the scheduled-publishing worker, the manager invite endpoint.

**What this backend does not own, and this amendment does not add:** any blog-manager UI, any post editor, any public blog page, the sitemap/RSS/robots edge handler, or redirect-serving. Those are frontend/infra, reachable from this repository only through the RLS surface in §3–4 and the one endpoint in §7. Hardening the redirect *handler* — as distinct from the redirect *table*, closed in §9 — is a named, outstanding frontend/infra follow-up: this repository can authoritatively constrain what a redirect row may contain, and has, but cannot harden code it does not have.
