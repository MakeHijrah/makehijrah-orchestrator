-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 056: Blog scheduler grant hardening
-- ============================================================
--
-- Classification:
-- - Security patch, found during the audit this recovery task
--   required. No behaviour change for any legitimate caller: the
--   orchestrator worker that calls this function (added alongside
--   this migration) uses the service role, which this migration
--   does not touch.
--
-- The defect:
-- - Migration 052 (imported from the frontend repo as
--   migration_051_blog.sql) ends with:
--
--     revoke all on function public.publish_due_blog_posts() from public;
--     grant execute on function public.publish_due_blog_posts() to service_role;
--
--   REVOKE ... FROM PUBLIC does not remove a grant Supabase issued
--   BY NAME. Supabase runs ALTER DEFAULT PRIVILEGES ... GRANT ALL
--   ON FUNCTIONS TO anon, authenticated, service_role for every
--   new function, and a role holding a privilege by name keeps it
--   through a PUBLIC-only revoke -- this is the exact mechanism
--   migration 036 exists to fix, and the exact mistake this
--   migration's author made, one migration before 036 was written
--   in this repository's own history and unknown to a migration
--   authored in a different repository.
--
-- - The result, confirmed against a fresh replay of migrations
--   001 through 055: publish_due_blog_posts() -- a SECURITY
--   DEFINER function that force-publishes every scheduled post
--   whose time has arrived -- is directly callable by an anon
--   key. Migration 036's own verification suite, re-run against
--   the newly-canonicalized blog schema, is what surfaced this;
--   it predates the blog by many migrations and never saw this
--   function.
--
-- The fix:
-- - REVOKE ... FROM PUBLIC, anon, authenticated BY NAME, exactly
--   the pattern migration 036 established. GRANT to service_role
--   restated for clarity, though it was never actually lost.
--
-- Deliberately NOT done here:
-- - No change to publish_due_blog_posts()'s body, its SECURITY
--   DEFINER status, or its search_path. Only its grants.
-- - No change to any other blog function. is_blog_manager()
--   legitimately keeps EXECUTE for both anon and authenticated --
--   blog_posts_select_public is `to anon, authenticated` and calls
--   it in its USING clause, the same architectural fact that keeps
--   is_admin() callable by anon since migration 036.
--
-- Rerun safety:
-- - Idempotent. Both statements are unconditional REVOKE/GRANT,
--   safe to reapply.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.publish_due_blog_posts()') is null then
    raise exception
      'migration 056: public.publish_due_blog_posts() not found - migration 052 must be applied first';
  end if;
end;
$$;

revoke all on function public.publish_due_blog_posts()
  from public, anon, authenticated;

grant execute on function public.publish_due_blog_posts()
  to service_role;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_056_VERIFICATION.sql for the full self-contained suite.
--
--  1. select has_function_privilege('anon',
--       'public.publish_due_blog_posts()', 'EXECUTE');
--       -> false
--
--  2. select has_function_privilege('authenticated',
--       'public.publish_due_blog_posts()', 'EXECUTE');
--       -> false
--
--  3. select has_function_privilege('service_role',
--       'public.publish_due_blog_posts()', 'EXECUTE');
--       -> true
