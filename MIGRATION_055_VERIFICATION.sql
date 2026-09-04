-- ============================================================
-- Verification for migration_055_blog_redirect_hardening
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  the function against a full example table   read-only
--   Part 2  the constraint on real inserts               STAGING ONLY, rolls back
--   Part 3  the pre-check guard                          STAGING ONLY, rolls back
--   Part 4  rollback guidance
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  every required accepted example passes            Part 1
--    2  every required rejected example fails, including
--       the exact reported defect (//evil.example)        Part 1
--    3  from_path and to_path use the identical function  Part 1
--    4  a safe redirect can still be inserted             Part 2
--    5  //evil.example is rejected by the live constraint,
--       not only by the function in isolation             Part 2
--    6  every other unsafe example is rejected by the
--       live constraint                                   Part 2
--    7  blog_redirects_no_self and blog_redirects_status
--       are unchanged                                     Part 2
--    8  the guard query the migration's pre-check runs on
--       every existing row detects a seeded unsafe one
--       (the migration's own apply-time abort over this
--       exact scenario -- and that nothing is applied,
--       and that it succeeds once corrected -- was
--       proven directly against the real migration file,
--       not only reasoned about here)                     Part 3
--    9  once corrected, the same guard query finds
--       nothing left to block                              Part 3
-- ============================================================


-- ============================================================
-- PART 1 — THE FUNCTION AGAINST A FULL EXAMPLE TABLE (read-only)
-- ============================================================

do $$
declare
  v_path text;
  v_failed text[] := '{}';
begin
  foreach v_path in array array[
    '/',
    '/blog',
    '/blog/new-slug',
    '/blog/category/egypt'
  ]
  loop
    if not public.is_safe_internal_path(v_path) then
      v_failed := v_failed || v_path;
    end if;
  end loop;

  if array_length(v_failed, 1) > 0 then
    raise exception
      'VERIFICATION FAILED 1: rejected as unsafe, but must be accepted: %',
      array_to_string(v_failed, ', ');
  end if;

  raise notice 'PASS 1: every required accepted example passes';
end $$;

do $$
declare
  v_path text;
  v_accepted text[] := '{}';
begin
  foreach v_path in array array[
    -- the exact reported defect
    '//evil.example',
    -- categorical variants of the same class
    '///evil.example',
    'https://evil.example',
    'http://evil.example',
    '/redirect?to=https://evil.example',
    '/\evil.example',
    E'/blog\r\nSet-Cookie: x=1',
    E'/blog\ttab',
    '',
    'blog',
    'blog/new-slug'
  ]
  loop
    if public.is_safe_internal_path(v_path) then
      v_accepted := v_accepted || v_path;
    end if;
  end loop;

  if array_length(v_accepted, 1) > 0 then
    raise exception
      'VERIFICATION FAILED 2: accepted as safe, but must be rejected: %',
      array_to_string(v_accepted, ', ');
  end if;

  raise notice 'PASS 2: every required rejected example fails, including //evil.example';
end $$;

do $$
declare
  v_from_def text;
  v_to_def text;
begin
  select pg_get_constraintdef(oid) into v_from_def
    from pg_constraint
   where conrelid = 'public.blog_redirects'::regclass
     and conname = 'blog_redirects_from_leading_slash';

  select pg_get_constraintdef(oid) into v_to_def
    from pg_constraint
   where conrelid = 'public.blog_redirects'::regclass
     and conname = 'blog_redirects_to_leading_slash';

  if v_from_def !~ 'is_safe_internal_path' then
    raise exception
      'VERIFICATION FAILED 3: blog_redirects_from_leading_slash is %, expected it to call is_safe_internal_path',
      v_from_def;
  end if;

  if v_to_def !~ 'is_safe_internal_path' then
    raise exception
      'VERIFICATION FAILED 3: blog_redirects_to_leading_slash is %, expected it to call is_safe_internal_path',
      v_to_def;
  end if;

  raise notice 'PASS 3: from_path and to_path are validated by the identical function';
end $$;


-- ============================================================
-- PART 2 — THE CONSTRAINT ON REAL INSERTS (STAGING ONLY, rolls back)
-- ============================================================

begin;

-- Check 4.

do $$
begin
  insert into public.blog_redirects (from_path, to_path, status_code)
  values ('/v55-old-slug', '/blog/v55-new-slug', 301);

  raise notice 'PASS 4: a safe redirect can still be inserted';
end $$;

-- Check 5: the exact reported defect, against the live table.

do $$
begin
  begin
    insert into public.blog_redirects (from_path, to_path, status_code)
    values ('/v55-open-redirect', '//evil.example', 301);

    raise exception
      'VERIFICATION FAILED 5: //evil.example was accepted by the live constraint';
  exception
    when check_violation then
      raise notice
        'PASS 5: //evil.example is rejected by the live constraint (%)', sqlerrm;
  end;
end $$;

-- Check 6: the rest of the unsafe set, against the live table,
-- covering both columns.

do $$
declare
  v_path text;
  v_accepted text[] := '{}';
begin
  foreach v_path in array array[
    'https://evil.example',
    '/redirect?to=https://evil.example',
    '/\evil.example',
    E'/v55\r\nx',
    ''
  ]
  loop
    begin
      insert into public.blog_redirects (from_path, to_path, status_code)
      values ('/v55-from-' || md5(v_path), v_path, 301);

      v_accepted := v_accepted || ('to_path=' || v_path);
    exception
      when check_violation then null;
    end;

    begin
      insert into public.blog_redirects (from_path, to_path, status_code)
      values (v_path, '/v55-to-' || md5(v_path), 301);

      v_accepted := v_accepted || ('from_path=' || v_path);
    exception
      when check_violation then null;
    end;
  end loop;

  if array_length(v_accepted, 1) > 0 then
    raise exception
      'VERIFICATION FAILED 6: the live constraint accepted: %',
      array_to_string(v_accepted, '; ');
  end if;

  raise notice 'PASS 6: every unsafe example is rejected on both columns by the live constraint';
end $$;

-- Check 7: the two constraints this migration does not touch.

do $$
begin
  begin
    insert into public.blog_redirects (from_path, to_path, status_code)
    values ('/v55-same', '/v55-same', 301);

    raise exception
      'VERIFICATION FAILED 7: blog_redirects_no_self no longer rejects from_path = to_path';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.blog_redirects (from_path, to_path, status_code)
    values ('/v55-bad-status', '/v55-target', 307);

    raise exception
      'VERIFICATION FAILED 7: blog_redirects_status no longer rejects an unlisted status code';
  exception
    when check_violation then null;
  end;

  raise notice 'PASS 7: blog_redirects_no_self and blog_redirects_status are unchanged';
end $$;

rollback;


-- ============================================================
-- PART 3 — THE PRE-CHECK GUARD (STAGING ONLY, rolls back)
-- ============================================================
--
-- The migration file's guard (part B of
-- migration_055_blog_redirect_hardening.sql) is one query: does
-- any existing row fail is_safe_internal_path on either column.
-- That exact query, and the fact that applying the real migration
-- file over a seeded unsafe row aborts with nothing committed and
-- applying it again after correction succeeds, was proven directly
-- against the actual migration file, outside this file, as part of
-- building it -- not merely asserted here. What this part checks
-- is the query the guard is built on, self-contained and without
-- re-implementing the migration's DDL inline.

begin;

/*
 * The live constraint from this same migration would refuse the
 * seed row below -- correctly, since that is exactly what it is
 * for. Dropped here, inside a transaction that ends in ROLLBACK,
 * purely to construct the "existing unsafe row" scenario the
 * guard query is checked against; nothing outside this
 * transaction ever sees the table without it.
 */
alter table public.blog_redirects
  drop constraint if exists blog_redirects_from_leading_slash;
alter table public.blog_redirects
  drop constraint if exists blog_redirects_to_leading_slash;

-- Check 8.

do $$
declare
  v_bad_id uuid;
  v_detected boolean;
begin
  insert into public.blog_redirects (from_path, to_path, status_code)
  values ('/v55-guard-old-path', '//evil.example', 301)
  returning id into v_bad_id;

  select exists (
    select 1 from public.blog_redirects
     where id = v_bad_id
       and (not public.is_safe_internal_path(from_path)
            or not public.is_safe_internal_path(to_path))
  ) into v_detected;

  if not v_detected then
    raise exception
      'VERIFICATION FAILED 8: the guard query did not detect the seeded unsafe row';
  end if;

  raise notice
    'PASS 8: the guard query detects a pre-existing unsafe row (id %)', v_bad_id;

  perform set_config('app.v55_bad_id', v_bad_id::text, true);
end $$;

-- Check 9: corrected, the same query must find nothing.

do $$
declare
  v_bad_id uuid := current_setting('app.v55_bad_id')::uuid;
  v_still_bad boolean;
begin
  update public.blog_redirects
     set to_path = '/blog/v55-guard-corrected'
   where id = v_bad_id;

  select exists (
    select 1 from public.blog_redirects
     where not public.is_safe_internal_path(from_path)
        or not public.is_safe_internal_path(to_path)
  ) into v_still_bad;

  if v_still_bad then
    raise exception
      'VERIFICATION FAILED 9: an unsafe row remains after correction';
  end if;

  raise notice 'PASS 9: once corrected, the guard query finds nothing to block';
end $$;

rollback;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 055 changes two CHECK constraints and adds one pure
-- function. It rewrites no existing row.
--
-- To reverse it -- NOT recommended, since it reopens the
-- open-redirect defect this migration closes:
--
--   alter table public.blog_redirects
--     drop constraint if exists blog_redirects_from_leading_slash;
--   alter table public.blog_redirects
--     add constraint blog_redirects_from_leading_slash
--     check (from_path like '/%');
--
--   alter table public.blog_redirects
--     drop constraint if exists blog_redirects_to_leading_slash;
--   alter table public.blog_redirects
--     add constraint blog_redirects_to_leading_slash
--     check (to_path like '/%');
--
--   drop function if exists public.is_safe_internal_path(text);
--
-- That restores the migration 052 constraints exactly, which
-- means restoring //evil.example as an insertable redirect
-- target. There is no scenario in which reversing this migration
-- is the right response to a problem with it -- fix forward
-- instead.
-- ============================================================

do $$
begin
  raise notice
    'migration 055 verification complete: no check raised';
end $$;
