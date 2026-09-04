-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 054: Blog revision trigger security
-- ============================================================
--
-- Classification:
-- - Production bug fix, plus one adjacent hardening pass found
--   while auditing the fix. Blog post create/update currently
--   fails for every blog manager and every admin.
--
-- The defect, end to end:
-- - Migration 052 (imported from the frontend repo as
--   migration_051_blog.sql) defines blog_posts_after_write() as
--   an ordinary trigger function with no SECURITY clause, which
--   means it runs with the privileges of the CALLER — the signed-
--   in blog manager or admin, over PostgREST, as role
--   `authenticated`.
-- - That function's only job is to INSERT into
--   blog_post_revisions. Migration 053 grants `authenticated`
--   SELECT on that table and nothing more.
-- - So the moment a blog manager inserts or updates a row in
--   blog_posts, the AFTER trigger fires as `authenticated`,
--   attempts the revision INSERT, and PostgreSQL raises
--   "permission denied for table blog_post_revisions" — which
--   aborts the whole transaction, including the blog_posts write
--   that triggered it. Every post create and every editorial
--   update fails.
--
-- Reproduced against a byte-for-byte fresh replay of migrations
-- 052 and 053: the write fails, but as an RLS policy violation
-- ("new row violates row-level security policy for table
-- blog_post_revisions"), not the literal grant-denial text
-- originally reported ("permission denied for table
-- blog_post_revisions"). The two are different PostgreSQL error
-- paths. A fresh replay leaves `authenticated` holding Supabase's
-- ordinary ambient default-privilege GRANT on the new table (the
-- same mechanism documented and revoked-by-name in migrations
-- 034, 036 and 037), so the grant check passes and RLS is what
-- actually blocks the insert: blog_post_revisions carries exactly
-- one policy (blog_revisions_manager, SELECT only), and a table
-- with RLS enabled and no matching write policy denies by
-- default.
--
-- The literal "permission denied" wording originally reported
-- means production's grant on this table is narrower than a
-- fresh replay of these two files produces -- most plausibly an
-- untracked manual REVOKE applied directly against production
-- outside any migration file, closing exactly the gap this
-- migration closes on purpose in part two below. This migration
-- does not depend on knowing which variant is live: SECURITY
-- DEFINER makes the function run as its owner (the same role
-- that owns blog_post_revisions, confirmed against this
-- repository's validation database), which bypasses RLS on that
-- table regardless of the grant state, and resolves both the RLS
-- variant reproduced here and the grant variant originally
-- reported.
--
-- Correct fix, per the task's explicit constraints:
-- - The trigger function becomes SECURITY DEFINER with a pinned
--   search_path, so it can write the row regardless of the
--   caller's own grant.
-- - authenticated is NOT granted direct INSERT (or UPDATE or
--   DELETE) on blog_post_revisions. The only way a row reaches
--   that table is through this function, fired by the trigger
--   that already exists on blog_posts.
-- - No INSERT policy is added for authenticated. RLS on
--   blog_post_revisions still carries exactly one policy —
--   blog_revisions_manager, SELECT only — from migration 052.
-- - The revision decision logic, the four inserted columns, and
--   the auth.uid() attribution are byte-for-byte unchanged. Only
--   the function's security context and search_path changed.
-- - The trigger name and attachment (AFTER INSERT OR UPDATE on
--   blog_posts, FOR EACH ROW) are unchanged: nothing about when
--   or how the function fires needed to change, only what it is
--   permitted to do once it does.
--
-- Why SECURITY DEFINER is safe here, specifically:
-- - The function takes no caller-supplied arguments. Every value
--   it writes (post_id, title, excerpt, body_html) comes from
--   NEW, which is the row PostgreSQL just validated against
--   blog_posts' own constraints and RLS write policy
--   (blog_posts_write_manager, which already requires
--   is_blog_manager()). A caller cannot reach this function
--   without first passing that check, and cannot make it write
--   anything it did not just write to blog_posts itself.
-- - edited_by is auth.uid(), the CALLING session's own identity,
--   evaluated inside the SECURITY DEFINER function exactly as it
--   was evaluated before. auth.uid() reads the session's JWT
--   claim, not a table the function owns, so running as definer
--   does not let a caller impersonate anyone else in the
--   attribution column.
-- - The function is granted to no role. It is reachable only by
--   firing as a trigger, which requires no EXECUTE privilege —
--   verified empirically in migration 036 by revoking EXECUTE on
--   trigger functions and confirming authenticated writes still
--   fired them.
--
-- Deliberately NOT done here:
-- - No RLS policy on blog_post_revisions changes. The single
--   SELECT policy from migration 052 stands.
-- - No change to blog_posts, blog_posts_before_write(), or any
--   other blog trigger, table or policy.
-- - No change to is_blog_manager(), blog_managers, or the invite
--   backend.
-- - No backfill: no revision row is retroactively created for a
--   post edited while the bug was live. There is nothing to
--   backfill from — the content that would have been captured
--   was never written anywhere, because the whole transaction
--   aborted.
--
-- Rerun safety:
-- - Idempotent. CREATE OR REPLACE, DROP TRIGGER IF EXISTS +
--   CREATE TRIGGER, and every REVOKE is a no-op if already
--   revoked.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.blog_posts') is null
     or to_regclass('public.blog_post_revisions') is null then
    raise exception
      'migration 054: blog tables not found - migrations 052 and 053 must be applied first';
  end if;

  if to_regprocedure('public.blog_posts_after_write()') is null then
    raise exception
      'migration 054: public.blog_posts_after_write() not found - migration 052 must be applied first';
  end if;
end;
$$;

/*
 * Byte-for-byte the migration 052 body except for `security
 * definer` and the pinned search_path. The decision logic (skip
 * a revision when nothing editorial changed), the four inserted
 * columns, and auth.uid() attribution are unchanged.
 */
create or replace function public.blog_posts_after_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and new.title is not distinct from old.title
     and new.excerpt is not distinct from old.excerpt
     and new.body_html is not distinct from old.body_html then
    return null;  -- nothing editorial changed; no revision
  end if;

  insert into public.blog_post_revisions (post_id, title, excerpt, body_html, edited_by)
  values (new.id, new.title, new.excerpt, new.body_html, auth.uid());

  return null;
end;
$$;

/*
 * Explicitly set, not left to PostgreSQL's default PUBLIC
 * EXECUTE. Firing a trigger does not consult EXECUTE privilege on
 * its function (verified in migration 036), so no role needs it
 * granted; revoking from everyone removes the one direct call
 * path that should never have existed.
 */
revoke all on function public.blog_posts_after_write()
  from public, anon, authenticated;

/*
 * Reattached rather than assumed unaffected: CREATE OR REPLACE
 * FUNCTION preserves an existing trigger's attachment, but
 * restating it here means this migration's intent for the
 * trigger's name and timing is explicit and self-contained rather
 * than inherited silently from migration 052.
 */
drop trigger if exists trg_blog_posts_after_write on public.blog_posts;
create trigger trg_blog_posts_after_write
  after insert or update on public.blog_posts
  for each row execute function public.blog_posts_after_write();

-- ------------------------------------------------------------
-- Adjacent hygiene: the other blog trigger functions
-- ------------------------------------------------------------
--
-- Migration 036 revoked EXECUTE from every trigger function in
-- the schema, on the finding that firing a trigger never consults
-- EXECUTE privilege, so a role holding it has a direct call path
-- that serves no purpose. The blog's four trigger functions
-- postdate migration 036 (052 and 053, both numbered after it)
-- and were never brought into that pattern, so all four still
-- carry Supabase's ambient default EXECUTE grant to anon and
-- authenticated:
--
--   blog_posts_after_write()     the fix above
--   blog_posts_before_write()    invoker, touches only NEW.*
--   blog_touch_updated_at()      invoker, touches only NEW.*
--   link_blog_manager_profile()  SECURITY DEFINER already, from
--                                 migration 053
--
-- None of the three below needed a SECURITY clause change --
-- link_blog_manager_profile() was already correctly SECURITY
-- DEFINER with a pinned search_path in migration 053, and the
-- other two need no elevated privilege, since they only read and
-- write the NEW row already in scope. The only gap in all three
-- is the same one blog_posts_after_write() had: an EXECUTE grant
-- that serves no purpose and should not have been left standing.
--
-- A function with RETURNS TRIGGER cannot be invoked directly by a
-- client regardless of its EXECUTE grant -- PostgreSQL rejects
-- calling a trigger-typed function outside a trigger context --
-- so this closes a path that was never actually reachable, not a
-- live hole. It is done anyway because it is what this codebase's
-- established convention calls for (migration 036), and because a
-- security review that finds three trigger functions still
-- exposed after "we harden trigger functions" was documented as
-- policy would read as an oversight, not a decision.

revoke all on function public.blog_posts_before_write()
  from public, anon, authenticated;

revoke all on function public.blog_touch_updated_at()
  from public, anon, authenticated;

revoke all on function public.link_blog_manager_profile()
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- Table privileges
-- ------------------------------------------------------------

/*
 * The privilege half of the fix, and the half that closes the
 * hole the task's own framing calls out: a blog manager must not
 * be able to manufacture revision history by writing
 * blog_post_revisions directly.
 *
 * Idempotent regardless of production's actual current state
 * (see the note at the top of this file): if authenticated
 * already lacks these privileges, each REVOKE is a no-op: If it
 * does not, this closes exactly the gap that made the ambient
 * default-privilege grant reachable in the first place.
 *
 * SELECT is untouched — migration 053 already grants it to
 * authenticated, and RLS (blog_revisions_manager) narrows actual
 * visibility to blog managers and admins.
 *
 * anon is included even though RLS already carries no write
 * policy for it (a table with RLS enabled and no matching policy
 * denies by default): defense in depth, and consistency with how
 * every other privileged table in this schema is treated.
 */
/*
 * REVOKE ALL, not just INSERT/UPDATE/DELETE. TRUNCATE and
 * REFERENCES are separate privileges from the same ambient
 * default grant, and TRUNCATE in particular is not filtered by
 * RLS at all -- there is no "FOR TRUNCATE" policy type in
 * PostgreSQL, so the table-level privilege is the ONLY thing
 * standing between an authenticated caller and wiping the entire
 * revision history in one statement. Leaving it granted would
 * have satisfied "no direct INSERT grant" while leaving a strictly
 * worse hole open.
 */
revoke all on public.blog_post_revisions
  from authenticated, anon;

/*
 * SELECT is restored to authenticated explicitly, matching
 * migration 053's intent and what blog_revisions_manager (RLS)
 * expects to filter. Re-granting by name rather than assuming a
 * bare REVOKE ALL followed by nothing is what makes this an
 * idempotent statement of the intended end state, not merely a
 * subtraction from whatever grants happened to exist before.
 */
grant select on public.blog_post_revisions to authenticated;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_054_VERIFICATION.sql for the full self-contained suite.
--
--  1. select prosecdef, proconfig from pg_proc
--      where oid = 'public.blog_posts_after_write()'::regprocedure;
--       -> prosecdef = true, proconfig = {search_path=pg_catalog, public}
--
--  2. select has_function_privilege('authenticated',
--       'public.blog_posts_after_write()', 'EXECUTE');
--       -> false
--
--  3. select privilege_type from information_schema.role_table_grants
--      where table_schema = 'public' and table_name = 'blog_post_revisions'
--        and grantee = 'authenticated';
--       -> SELECT only
--
--  4. select proname from pg_proc p
--      join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('blog_posts_before_write',
--         'blog_touch_updated_at', 'link_blog_manager_profile')
--       and (has_function_privilege('anon', p.oid, 'EXECUTE')
--         or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
--       -> 0 rows
