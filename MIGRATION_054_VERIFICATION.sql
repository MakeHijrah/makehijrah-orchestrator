-- ============================================================
-- Verification for migration_054_blog_revision_trigger_security
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  function and grant shape          read-only
--   Part 2  the write path, end to end        STAGING ONLY, rolls back
--   Part 3  access control                    STAGING ONLY, rolls back
--   Part 4  immutability                      STAGING ONLY, rolls back
--   Part 5  rollback guidance
--
-- Parts 2 to 4 share one transaction that ends in ROLLBACK. Every
-- fixture is created inside it; nothing here reads a business
-- record.
--
-- Role switches (SET LOCAL ROLE, set_config on request.jwt.*) are
-- top-level statements between the fixture-creating DO block and
-- the DO block that exercises the write path as that role. SET
-- LOCAL ROLE does not behave reliably issued from inside a
-- PL/pgSQL block, so this file never attempts it there.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  blog_posts_after_write is SECURITY DEFINER with a
--       pinned search_path                                Part 1
--    2  authenticated cannot execute the function directly Part 1
--    3  authenticated holds SELECT only on
--       blog_post_revisions; anon holds nothing            Part 1
--    4  no INSERT/UPDATE/DELETE policy exists for
--       authenticated on blog_post_revisions               Part 1
--    5  a blog manager can INSERT a blog post              Part 2
--    6  the matching revision row is created
--       automatically, attributed to the caller            Part 2
--    7  a blog manager can UPDATE a blog post               Part 2
--    8  an editorial UPDATE (title/excerpt/body) creates
--       a second revision                                  Part 2
--    9  a non-editorial UPDATE creates no revision          Part 2
--   10  a blog manager cannot directly INSERT into
--       blog_post_revisions                                Part 3
--   11  anon cannot insert a post or a revision             Part 3
--   12  a client with no blog-manager grant cannot
--       create or update a post                             Part 3
--   13  an admin (implicit manager) can write posts and
--       trigger revisions                                  Part 3
--   14  revision rows are immutable outside the trigger:
--       no UPDATE, no DELETE, even by a manager or admin    Part 4
--   15  the three sibling blog trigger functions also
--       carry no direct EXECUTE grant, matching the
--       migration-036 convention this repo already
--       applies to every other trigger function            Part 1
--   16  fixtures roll back, asserted not assumed            Part 4
-- ============================================================


-- ============================================================
-- PART 1 — FUNCTION AND GRANT SHAPE (read-only)
-- ============================================================

-- Checks 1 and 2.

do $$
declare
  v_secdef boolean;
  v_config text;
begin
  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ', '), '(none)')
    into v_secdef, v_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'blog_posts_after_write';

  if v_secdef is null then
    raise exception
      'VERIFICATION FAILED 1: public.blog_posts_after_write() does not exist';
  end if;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 1: blog_posts_after_write() is not SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 1: search_path is %, expected search_path=pg_catalog, public',
      v_config;
  end if;

  if has_function_privilege(
       'authenticated', 'public.blog_posts_after_write()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 2: authenticated can execute blog_posts_after_write() directly';
  end if;

  if has_function_privilege(
       'anon', 'public.blog_posts_after_write()', 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 2: anon can execute blog_posts_after_write() directly';
  end if;

  raise notice
    'PASS 1 and 2: SECURITY DEFINER, pinned search_path, no direct EXECUTE';
end $$;


-- Check 15.
--
-- Migration 036 revoked EXECUTE from every trigger function on
-- the finding that firing one never consults it. The blog's other
-- three trigger functions postdate that migration and were never
-- brought into the pattern until migration 054 closed the gap
-- alongside its primary fix.

do $$
declare
  v_name text;
  v_leaked text[] := '{}';
begin
  foreach v_name in array array[
    'blog_posts_before_write',
    'blog_touch_updated_at',
    'link_blog_manager_profile'
  ]
  loop
    if has_function_privilege(
         'anon', format('public.%I()', v_name), 'EXECUTE')
       or has_function_privilege(
            'authenticated', format('public.%I()', v_name), 'EXECUTE')
    then
      v_leaked := v_leaked || v_name;
    end if;
  end loop;

  if array_length(v_leaked, 1) > 0 then
    raise exception
      'VERIFICATION FAILED 15: % still directly executable by anon or authenticated',
      array_to_string(v_leaked, ', ');
  end if;

  raise notice
    'PASS 15: the three sibling blog trigger functions carry no direct EXECUTE grant either';
end $$;


-- Checks 3 and 4.

do $$
declare
  v_authenticated_privs text;
  v_anon_privs text;
  v_write_policies integer;
begin
  select coalesce(string_agg(privilege_type, ', ' order by privilege_type), '(none)')
    into v_authenticated_privs
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'blog_post_revisions'
     and grantee = 'authenticated';

  if v_authenticated_privs <> 'SELECT' then
    raise exception
      'VERIFICATION FAILED 3: authenticated holds % on blog_post_revisions, expected SELECT only',
      v_authenticated_privs;
  end if;

  /*
   * TRUNCATE specifically, called out on its own: it is not
   * filtered by RLS at all (there is no "FOR TRUNCATE" policy
   * type), so the table grant is the only thing that can stop an
   * authenticated caller from wiping every revision in one
   * statement. A REVOKE that only touched INSERT/UPDATE/DELETE
   * would still leave this open.
   */
  if has_table_privilege('authenticated', 'public.blog_post_revisions', 'TRUNCATE') then
    raise exception
      'VERIFICATION FAILED 3: authenticated holds TRUNCATE on blog_post_revisions';
  end if;

  if has_table_privilege('anon', 'public.blog_post_revisions', 'TRUNCATE') then
    raise exception
      'VERIFICATION FAILED 3: anon holds TRUNCATE on blog_post_revisions';
  end if;

  select coalesce(string_agg(privilege_type, ', ' order by privilege_type), '(none)')
    into v_anon_privs
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'blog_post_revisions'
     and grantee = 'anon';

  if v_anon_privs <> '(none)' then
    raise exception
      'VERIFICATION FAILED 3: anon holds % on blog_post_revisions, expected nothing',
      v_anon_privs;
  end if;

  select count(*) into v_write_policies
    from pg_policies
   where schemaname = 'public'
     and tablename = 'blog_post_revisions'
     and cmd in ('INSERT', 'UPDATE', 'DELETE');

  if v_write_policies <> 0 then
    raise exception
      'VERIFICATION FAILED 4: % write polic(y/ies) exist on blog_post_revisions, expected 0',
      v_write_policies;
  end if;

  raise notice
    'PASS 3 and 4: authenticated is SELECT-only, anon has nothing, no write policy exists';
end $$;


-- ============================================================
-- PART 2 — THE WRITE PATH, END TO END (STAGING ONLY, rolls back)
-- ============================================================

begin;

-- Fixtures, created as the connecting (superuser) role so they
-- are not subject to RLS themselves.

do $$
declare
  v_manager uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_manager, 'v54-manager@verification.invalid');

  if not exists (select 1 from public.profiles where id = v_manager) then
    raise exception
      'test setup failed: handle_new_user() did not create a profile for the manager';
  end if;

  insert into public.blog_managers (profile_id, granted_by, email)
  values (v_manager, v_manager, 'v54-manager@verification.invalid');

  perform set_config('app.v54_manager', v_manager::text, true);
end $$;

-- Switch to the manager's session. Top-level, not inside a DO
-- block: SET LOCAL ROLE issued from within PL/pgSQL does not
-- reliably take effect for the surrounding transaction.

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('app.v54_manager'), true);
select set_config(
  'request.jwt.claims',
  json_build_object('email', 'v54-manager@verification.invalid')::text,
  true
);

do $$
declare
  v_manager uuid := current_setting('app.v54_manager')::uuid;
  v_post_id uuid;
  v_edited_by uuid;
  v_revision_count integer;
begin
  -- Check 5
  begin
    insert into public.blog_posts (slug, title, body_html, status)
    values (
      'v54-first-post',
      'Migration 054 verification post',
      '<p>the quick brown fox jumps over the lazy dog and keeps going for a while longer so the reading time works out to more than zero minutes</p>',
      'draft'
    )
    returning id into v_post_id;
  exception when others then
    raise exception
      'VERIFICATION FAILED 5: a blog manager could not INSERT a post: %', sqlerrm;
  end;

  perform set_config('app.v54_post', v_post_id::text, true);

  -- Check 6
  select count(*) into v_revision_count
    from public.blog_post_revisions
   where post_id = v_post_id;

  if v_revision_count <> 1 then
    raise exception
      'VERIFICATION FAILED 6: % revision row(s) exist after insert, expected 1',
      v_revision_count;
  end if;

  select edited_by into v_edited_by
    from public.blog_post_revisions
   where post_id = v_post_id;

  if v_edited_by is distinct from v_manager then
    raise exception
      'VERIFICATION FAILED 6: edited_by is %, expected the calling manager %',
      v_edited_by, v_manager;
  end if;

  raise notice 'PASS 5 and 6: insert succeeds, one revision created, correctly attributed';

  -- Checks 7 and 8: an editorial update creates a second revision.
  --
  -- now() is transaction-stable, so this whole test runs inside
  -- one BEGIN/ROLLBACK and every now() call returns the identical
  -- value throughout. updated_at cannot be used as evidence the
  -- update ran; the actual content change is checked instead.
  begin
    update public.blog_posts
       set title = 'Migration 054 verification post, revised'
     where id = v_post_id;
  exception when others then
    raise exception
      'VERIFICATION FAILED 7: a blog manager could not UPDATE a post: %', sqlerrm;
  end;

  if not exists (
    select 1 from public.blog_posts
     where id = v_post_id
       and title = 'Migration 054 verification post, revised'
  ) then
    raise exception
      'VERIFICATION FAILED 7: the update did not persist';
  end if;

  select count(*) into v_revision_count
    from public.blog_post_revisions
   where post_id = v_post_id;

  if v_revision_count <> 2 then
    raise exception
      'VERIFICATION FAILED 8: % revision row(s) exist after an editorial update, expected 2',
      v_revision_count;
  end if;

  raise notice 'PASS 7 and 8: update succeeds, editorial change creates a second revision';

  -- Check 9: a non-editorial update (status only) must not create a
  -- third revision. blog_posts_after_write() compares only title,
  -- excerpt and body_html.
  update public.blog_posts
     set status = 'archived'
   where id = v_post_id;

  select count(*) into v_revision_count
    from public.blog_post_revisions
   where post_id = v_post_id;

  if v_revision_count <> 2 then
    raise exception
      'VERIFICATION FAILED 9: a non-editorial update changed the revision count to %, expected it to stay 2',
      v_revision_count;
  end if;

  raise notice 'PASS 9: a non-editorial update creates no revision';
end $$;

reset role;


-- ============================================================
-- PART 3 — ACCESS CONTROL (same transaction)
-- ============================================================
--
-- The manager fixture (v54-manager) and their post
-- (v54-first-post, id in app.v54_post) from Part 2 are still
-- live in this transaction.

do $$
declare
  v_other uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_other, 'v54-other@verification.invalid'),
    (v_admin, 'v54-admin@verification.invalid');

  if not exists (select 1 from public.profiles where id = v_other)
     or not exists (select 1 from public.profiles where id = v_admin) then
    raise exception
      'test setup failed: handle_new_user() did not create both profiles';
  end if;

  update public.profiles set role = 'admin' where id = v_admin;

  perform set_config('app.v54_other', v_other::text, true);
  perform set_config('app.v54_admin', v_admin::text, true);
end $$;

-- Check 10. Re-establish the manager's session explicitly --
-- Part 2 ended with RESET ROLE, so it is not still active here
-- and must be set again, not assumed.

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('app.v54_manager'), true);
select set_config(
  'request.jwt.claims',
  json_build_object('email', 'v54-manager@verification.invalid')::text,
  true
);

do $$
declare
  v_post_id uuid := current_setting('app.v54_post')::uuid;
begin
  begin
    insert into public.blog_post_revisions
      (post_id, title, excerpt, body_html, edited_by)
    values (
      v_post_id, 'forged revision', null, '<p>forged</p>',
      current_setting('app.v54_manager')::uuid
    );

    raise exception
      'VERIFICATION FAILED 10: a blog manager directly inserted a revision row';
  exception
    when insufficient_privilege then
      raise notice
        'PASS 10: a blog manager cannot directly INSERT into blog_post_revisions (%)',
        sqlerrm;
  end;
end $$;

reset role;

-- Check 11: anon.

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  begin
    insert into public.blog_posts (slug, title, body_html, status)
    values ('v54-anon-post', 'Anon post', '<p>should never land</p>', 'draft');

    raise exception 'VERIFICATION FAILED 11: anon inserted a blog post';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.blog_post_revisions
      (post_id, title, excerpt, body_html, edited_by)
    values (
      current_setting('app.v54_post')::uuid, 'anon revision', null,
      '<p>should never land</p>', null
    );

    raise exception 'VERIFICATION FAILED 11: anon inserted a revision row';
  exception
    when insufficient_privilege then null;
  end;

  raise notice 'PASS 11: anon can write neither a post nor a revision';
end $$;

reset role;

-- Check 12: an ordinary authenticated client with no blog-manager grant.

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('app.v54_other'), true);
select set_config(
  'request.jwt.claims',
  json_build_object('email', 'v54-other@verification.invalid')::text,
  true
);

do $$
declare
  v_post_id uuid := current_setting('app.v54_post')::uuid;
begin
  begin
    insert into public.blog_posts (slug, title, body_html, status)
    values ('v54-client-post', 'Client post', '<p>should never land</p>', 'draft');

    raise exception
      'VERIFICATION FAILED 12: a non-manager client created a post';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.blog_posts
       set title = 'hijacked by a non-manager'
     where id = v_post_id;

    if found then
      raise exception
        'VERIFICATION FAILED 12: a non-manager client updated another post';
    end if;
  exception
    when insufficient_privilege then null;
  end;

  raise notice
    'PASS 12: a client with no blog-manager grant cannot create or update a post';
end $$;

reset role;

-- Check 13: an admin, who is an implicit manager under both
-- is_blog_manager() definitions.

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('app.v54_admin'), true);
select set_config(
  'request.jwt.claims',
  json_build_object('email', 'v54-admin@verification.invalid')::text,
  true
);

do $$
declare
  v_admin_post_id uuid;
  v_revision_count integer;
begin
  begin
    insert into public.blog_posts (slug, title, body_html, status)
    values (
      'v54-admin-post', 'Admin post',
      '<p>an admin can write and trigger a revision even with no explicit blog_managers grant</p>',
      'draft'
    )
    returning id into v_admin_post_id;
  exception when others then
    raise exception
      'VERIFICATION FAILED 13: an admin could not create a post: %', sqlerrm;
  end;

  select count(*) into v_revision_count
    from public.blog_post_revisions
   where post_id = v_admin_post_id;

  if v_revision_count <> 1 then
    raise exception
      'VERIFICATION FAILED 13: % revision row(s) for the admin''s post, expected 1',
      v_revision_count;
  end if;

  perform set_config('app.v54_admin_post', v_admin_post_id::text, true);

  raise notice 'PASS 13: an admin can write posts and trigger revisions';
end $$;

reset role;


-- ============================================================
-- PART 4 — IMMUTABILITY (same transaction)
-- ============================================================
--
-- Existing revision rows (from Parts 2 and 3) must survive
-- untouched: no UPDATE, no DELETE, not even by a manager or an
-- admin, because the only sanctioned writer is the trigger.

do $$
declare
  v_revision_id uuid;
  v_original_title text;
begin
  /*
   * created_at is transaction-stable (now() returns the same
   * value for every statement in this transaction), so the two
   * revision rows from Parts 2 and 3 are tied on it and ORDER BY
   * created_at cannot distinguish them deterministically. Any one
   * row is a fine subject for an immutability test; what matters
   * is capturing ITS actual original content here, rather than
   * assuming which row was picked and hardcoding a title that may
   * belong to the other one.
   */
  select id, title into v_revision_id, v_original_title
    from public.blog_post_revisions
   where post_id = current_setting('app.v54_post')::uuid
   limit 1;

  perform set_config('app.v54_revision', v_revision_id::text, true);
  perform set_config('app.v54_revision_title', v_original_title, true);
end $$;

-- As the manager.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('app.v54_manager'), true);
select set_config(
  'request.jwt.claims',
  json_build_object('email', 'v54-manager@verification.invalid')::text,
  true
);

do $$
declare
  v_revision_id uuid := current_setting('app.v54_revision')::uuid;
begin
  begin
    update public.blog_post_revisions
       set title = 'tampered'
     where id = v_revision_id;

    raise exception
      'VERIFICATION FAILED 14: a manager updated a revision row directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.blog_post_revisions where id = v_revision_id;

    raise exception
      'VERIFICATION FAILED 14: a manager deleted a revision row directly';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;

-- As the admin: RLS write policies are role-scoped, not
-- capability-scoped, and blog_post_revisions carries no INSERT,
-- UPDATE or DELETE policy for anyone -- an admin is still just
-- `authenticated` at the grant layer, which is what this checks.
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('app.v54_admin'), true);
select set_config(
  'request.jwt.claims',
  json_build_object('email', 'v54-admin@verification.invalid')::text,
  true
);

do $$
declare
  v_revision_id uuid := current_setting('app.v54_revision')::uuid;
begin
  begin
    update public.blog_post_revisions
       set title = 'tampered by admin'
     where id = v_revision_id;

    raise exception
      'VERIFICATION FAILED 14: an admin updated a revision row directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.blog_post_revisions where id = v_revision_id;

    raise exception
      'VERIFICATION FAILED 14: an admin deleted a revision row directly';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;

do $$
declare
  v_revision_id uuid := current_setting('app.v54_revision')::uuid;
  v_expected_title text := current_setting('app.v54_revision_title');
  v_current_title text;
begin
  select title into v_current_title
    from public.blog_post_revisions where id = v_revision_id;

  if v_current_title is distinct from v_expected_title then
    raise exception
      'VERIFICATION FAILED 14: the revision title changed from % to %',
      v_expected_title, v_current_title;
  end if;

  raise notice
    'PASS 14: revision rows are immutable outside the trigger, for a manager and an admin alike';
end $$;

rollback;


-- Check 16 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v54-%@verification.invalid';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 16: % verification profile(s) survived the rollback',
      v_left;
  end if;

  select count(*) into v_left
    from public.blog_posts
   where slug like 'v54-%';

  if v_left <> 0 then
    raise exception
      'VERIFICATION FAILED 16: % verification post(s) survived the rollback',
      v_left;
  end if;

  raise notice 'PASS 16: every fixture rolled back';
end $$;


-- ============================================================
-- PART 5 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 054 changes a function's security context, its
-- search_path, its grants, and one table's privileges. It creates
-- no table, no column, no data.
--
-- To reverse it -- NOT recommended, since it reopens the bug this
-- migration fixes:
--
--   create or replace function public.blog_posts_after_write()
--   returns trigger language plpgsql as $$
--   begin
--     if tg_op = 'UPDATE'
--        and new.title is not distinct from old.title
--        and new.excerpt is not distinct from old.excerpt
--        and new.body_html is not distinct from old.body_html then
--       return null;
--     end if;
--     insert into public.blog_post_revisions
--       (post_id, title, excerpt, body_html, edited_by)
--     values (new.id, new.title, new.excerpt, new.body_html, auth.uid());
--     return null;
--   end;
--   $$;
--
--   grant select on public.blog_post_revisions to authenticated;
--
-- That restores the migration 052/053 behaviour exactly, which
-- means restoring the bug: every blog post create or update will
-- fail again with a permission or RLS error on the revision
-- insert. There is no scenario in which reversing this migration
-- is the right response to a problem with it -- fix forward
-- instead.
-- ============================================================

do $$
begin
  raise notice
    'migration 054 verification complete: no check raised';
end $$;
