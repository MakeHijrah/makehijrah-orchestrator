-- ============================================================
-- Verification for migration_056_blog_scheduler_grant_hardening
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
-- Read-only throughout: this migration changes only privileges,
-- so proving the grant state is proving the whole thing.
--
--   Part 1  grants                                  read-only
--   Part 2  the publication lifecycle, end to end   STAGING ONLY, rolls back
--
-- Check map:
--   1  anon cannot execute publish_due_blog_posts()             Part 1
--   2  authenticated cannot execute publish_due_blog_posts()    Part 1
--   3  service_role can still execute it                        Part 1
--   4  is_blog_manager() is unaffected: still callable by both
--      anon and authenticated, which the public post-reading
--      policy requires                                          Part 1
--   5  a scheduled post whose time has passed is published,
--      with published_at set from scheduled_for                 Part 2
--   6  a scheduled post not yet due is left untouched            Part 2
--   7  a draft post (never scheduled) is left untouched          Part 2
--   8  re-running finds nothing left to publish -- the
--      idempotency the orchestrator worker depends on            Part 2
--   9  fixtures roll back, asserted not assumed                  Part 2
-- ============================================================


-- ============================================================
-- PART 1 — GRANTS (read-only)
-- ============================================================

do $$
begin
  if has_function_privilege(
       'anon', 'public.publish_due_blog_posts()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 1: anon can execute publish_due_blog_posts()';
  end if;

  raise notice 'PASS 1: anon cannot execute publish_due_blog_posts()';
end $$;

do $$
begin
  if has_function_privilege(
       'authenticated', 'public.publish_due_blog_posts()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 2: authenticated can execute publish_due_blog_posts()';
  end if;

  raise notice 'PASS 2: authenticated cannot execute publish_due_blog_posts()';
end $$;

do $$
begin
  if not has_function_privilege(
       'service_role', 'public.publish_due_blog_posts()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 3: service_role lost EXECUTE on publish_due_blog_posts()';
  end if;

  raise notice 'PASS 3: service_role can still execute publish_due_blog_posts()';
end $$;

do $$
begin
  if not has_function_privilege(
       'anon', 'public.is_blog_manager()', 'EXECUTE')
     or not has_function_privilege(
       'authenticated', 'public.is_blog_manager()', 'EXECUTE')
  then
    raise exception
      'VERIFICATION FAILED 4: is_blog_manager() lost a grant the public read policy needs';
  end if;

  raise notice 'PASS 4: is_blog_manager() is unaffected';
end $$;



-- ============================================================
-- PART 2 — THE PUBLICATION LIFECYCLE, END TO END
-- (STAGING ONLY, rolls back)
-- ============================================================
--
-- publish_due_blog_posts() is unchanged by migration 056 -- only
-- its grants moved. This proves the RPC itself still does exactly
-- what the orchestrator worker (added alongside this migration)
-- will depend on, called the same way the worker calls it: as the
-- privileged role, with no arguments.

begin;

do $$
declare
  v_due_id uuid;
  v_not_due_id uuid;
  v_draft_id uuid;
  v_published_count integer;
  v_status public.blog_post_status;
  v_published_at timestamptz;
  v_scheduled_for timestamptz := now() - interval '5 minutes';
begin
  -- Check 5 and 6 fixtures: one post due, one not yet due.
  insert into public.blog_posts
    (slug, title, body_html, status, scheduled_for)
  values
    ('v56-due-post', 'Due for publication',
     '<p>this post was scheduled in the past and should publish</p>',
     'scheduled', v_scheduled_for)
  returning id into v_due_id;

  insert into public.blog_posts
    (slug, title, body_html, status, scheduled_for)
  values
    ('v56-not-due-post', 'Not yet due',
     '<p>this post is scheduled well into the future</p>',
     'scheduled', now() + interval '1 day')
  returning id into v_not_due_id;

  -- Check 7 fixture: an ordinary draft, never scheduled.
  insert into public.blog_posts (slug, title, body_html, status)
  values ('v56-draft-post', 'Still a draft',
    '<p>never scheduled, must stay a draft</p>', 'draft')
  returning id into v_draft_id;

  select public.publish_due_blog_posts() into v_published_count;

  if v_published_count <> 1 then
    raise exception
      'VERIFICATION FAILED 5: publish_due_blog_posts() published %, expected 1',
      v_published_count;
  end if;

  select status, published_at into v_status, v_published_at
    from public.blog_posts where id = v_due_id;

  if v_status <> 'published' then
    raise exception
      'VERIFICATION FAILED 5: the due post is %, expected published',
      v_status;
  end if;

  if v_published_at is distinct from v_scheduled_for then
    raise exception
      'VERIFICATION FAILED 5: published_at is %, expected scheduled_for (%)',
      v_published_at, v_scheduled_for;
  end if;

  raise notice
    'PASS 5: a due post publishes, published_at set from scheduled_for';

  -- Check 6.
  select status into v_status
    from public.blog_posts where id = v_not_due_id;

  if v_status <> 'scheduled' then
    raise exception
      'VERIFICATION FAILED 6: the not-yet-due post is %, expected scheduled',
      v_status;
  end if;

  raise notice 'PASS 6: a not-yet-due post is left untouched';

  -- Check 7.
  select status into v_status
    from public.blog_posts where id = v_draft_id;

  if v_status <> 'draft' then
    raise exception
      'VERIFICATION FAILED 7: the draft post is %, expected draft',
      v_status;
  end if;

  raise notice 'PASS 7: a draft post is left untouched';

  -- Check 8: the idempotency the worker's periodic re-run depends
  -- on. A second call must publish nothing more -- not the
  -- already-published post again, and not the still-future one.
  select public.publish_due_blog_posts() into v_published_count;

  if v_published_count <> 0 then
    raise exception
      'VERIFICATION FAILED 8: a second call published %, expected 0',
      v_published_count;
  end if;

  raise notice
    'PASS 8: a second call publishes nothing further -- safe for a periodic worker';
end $$;

rollback;

-- Check 9 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.blog_posts where slug like 'v56-%';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 9: % verification post(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS 9: every fixture rolled back';
end $$;


do $$
begin
  raise notice
    'migration 056 verification complete: no check raised';
end $$;
