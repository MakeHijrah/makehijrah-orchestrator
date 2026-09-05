-- ============================================================
-- Verification for migration_057_blog_html_write_enforcement
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  the rule, as a pure function       read-only
--   Part 2  writes as real roles               STAGING ONLY, rolls back
--   Part 3  revisions and RLS regression       STAGING ONLY, rolls back
--   Part 4  rollback guidance
--
-- Parts 2 and 3 share one transaction ending in ROLLBACK.
--
-- Per the standing rule from migration 046, enforcement is proved
-- by ATTEMPTING THE WRITE as the role that would make it, not by
-- reading the constraint's source and inferring.
--
-- Check map:
--    1  the function exists, is IMMUTABLE, and is not executable
--       by anon
--    2  the constraint exists on blog_posts.body_html
--    3  every safe editor construct is accepted
--    4  CTA markdown source survives
--    5  every hostile payload is refused
--    6  scheme obfuscation is refused
--    7  attribute smuggling is refused
--    8  blog manager CAN write safe HTML
--    9  blog manager CANNOT write unsafe HTML
--   10  admin CAN write safe HTML
--   11  admin CANNOT write unsafe HTML
--   12  the rejection is SQLSTATE 23514 naming unsafe_blog_html
--   13  rejected content is not echoed in the error
--   14  ordinary authenticated user still cannot write at all
--   15  anon still cannot write at all
--   16  anon can still read a published post
--   17  the revision trigger still fires on a safe update
--   18  direct revision insert is still denied
--   19  blog_post_revisions is deliberately NOT constrained
--   20  scheduled publishing is unaffected
--   21  update path is enforced, not only insert
--   22  the BEFORE trigger fronts the constraint
--   24  service_role holds EXECUTE explicitly, not ambiently
--   25  service_role CAN write safe HTML
--   26  service_role CANNOT write unsafe HTML
--   23  the error carries NO echo of the submitted payload,
--       in message or in DETAIL
-- ============================================================


-- ============================================================
-- PART 1 — THE RULE (read-only)
-- ============================================================

do $$
declare
  v_volatile char;
  v_ok boolean;
  v_label text;
  v_html text;
begin
  select provolatile into v_volatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'is_safe_blog_html';

  if v_volatile is null then
    raise exception 'VERIFICATION FAILED 1: is_safe_blog_html does not exist';
  end if;

  if v_volatile <> 'i' then
    raise exception
      'VERIFICATION FAILED 1: is_safe_blog_html must be IMMUTABLE to sit behind a CHECK constraint, is %',
      v_volatile;
  end if;

  if has_function_privilege('anon', 'public.is_safe_blog_html(text)', 'execute') then
    raise exception 'VERIFICATION FAILED 1: anon can execute is_safe_blog_html';
  end if;

  raise notice 'PASS 1: the rule exists, is IMMUTABLE, and anon cannot call it';

  if not exists (
    select 1 from pg_constraint
    where conname = 'unsafe_blog_html'
      and conrelid = 'public.blog_posts'::regclass
      and contype = 'c'
  ) then
    raise exception 'VERIFICATION FAILED 2: the unsafe_blog_html check constraint is missing';
  end if;

  raise notice 'PASS 2: the constraint is present on blog_posts';

  -- Check 3: every construct the editor legitimately emits.
  for v_label, v_html in
    select * from (values
      ('paragraph'        , '<p>Paragraph</p>'),
      ('h2'               , '<h2>Heading</h2>'),
      ('h3'               , '<h3>Heading</h3>'),
      ('bold italic'      , '<p><strong>Bold</strong> and <em>italic</em>.</p>'),
      ('b i u'            , '<p><b>b</b><i>i</i><u>u</u></p>'),
      ('nested ul'        , '<ul><li><p>Item</p></li></ul>'),
      ('nested ol'        , '<ol><li><p>Item</p></li></ol>'),
      ('br self-closed'   , '<p>a<br />b</p>'),
      ('br bare'          , '<p>a<br>b</p>'),
      ('link'             , '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">Link</a></p>'),
      ('link newlines'    , E'<p>\n  <a href="https://example.com"\n     target="_blank"\n     rel="noopener noreferrer nofollow">\n    Link\n  </a>\n</p>'),
      ('mailto'           , '<p><a href="mailto:test@example.com" target="_blank" rel="noopener noreferrer nofollow">Email</a></p>'),
      ('http'             , '<p><a href="http://example.com">x</a></p>'),
      ('internal path'    , '<p><a href="/consultation">Book</a></p>'),
      ('attr order swap'  , '<p><a target="_blank" rel="nofollow" href="https://e.test">x</a></p>'),
      ('escaped angles'   , '<p>5 &lt; 7 and 9 &gt; 3 &amp; more</p>'),
      ('escaped in attr'  , '<p><a href="https://e.test" title="a &gt; b">x</a></p>'),
      ('non-ascii'        , '<p>As-salāmu ʿalaykum — “quotes”</p>'),
      ('empty'            , ''),
      ('tabs newlines'    , E'<p>a\tb\nc</p>'),
      ('blockquote'       , '<blockquote><p>Quoted text</p></blockquote>'),
      ('pre code block'   , '<pre><code>const x = 1;</code></pre>'),
      ('inline code'      , '<p><code>inline</code></p>'),
      ('hr bare'          , '<hr>'),
      ('hr self-closed'   , '<hr />'),
      ('strikethrough s'  , '<p><s>old</s></p>'),
      ('del'              , '<p><del>old</del></p>'),
      ('code with entity' , '<pre><code>if (a &lt; b) {}</code></pre>'),
      ('rel arbitrary'    , '<p><a href="https://e.test" rel="me">x</a></p>'),
      ('target arbitrary' , '<p><a href="https://e.test" target="_self">x</a></p>')
    ) as t(l, h)
  loop
    if not public.is_safe_blog_html(v_html) then
      raise exception
        'VERIFICATION FAILED 3: legitimate editor output was refused: %', v_label;
    end if;
  end loop;

  raise notice 'PASS 3: all 31 legitimate editor constructs are accepted';

  -- Check 4: CTA source syntax is literal text and must survive.
  if not public.is_safe_blog_html(
    '<p><strong>[Book a Consultation](https://hijrah.network/consultation)</strong></p>'
  ) then
    raise exception 'VERIFICATION FAILED 4: CTA markdown source was refused';
  end if;

  raise notice 'PASS 4: CTA markdown source survives untouched';

  -- Checks 5, 6 and 7: everything that must be refused.
  for v_label, v_html in
    select * from (values
      ('script'            , '<script>alert(1)</script>'),
      ('img onerror'       , '<img src=x onerror=alert(1)>'),
      ('svg onload'        , '<svg onload=alert(1)></svg>'),
      ('iframe'            , '<iframe srcdoc="x"></iframe>'),
      ('object'            , '<object data="x"></object>'),
      ('embed'             , '<embed src="x">'),
      ('table'             , '<table><tr><td>x</td></tr></table>'),
      ('form'              , '<form action="https://evil.example">x</form>'),
      ('input'             , '<input name="a">'),
      ('button'            , '<button>x</button>'),
      ('meta'              , '<meta http-equiv="refresh" content="0">'),
      ('link tag'          , '<link rel="stylesheet" href="x">'),
      ('style tag'         , '<style>body{}</style>'),
      ('math'              , '<math><mtext></mtext></math>'),
      ('video'             , '<video src="x"></video>'),
      ('audio'             , '<audio src="x"></audio>'),
      ('div style'         , '<div style="position:fixed">overlay</div>'),
      ('span class'        , '<span class="whatever">text</span>'),
      ('p onclick'         , '<p onclick="alert(1)">text</p>'),
      ('p with id'         , '<p id="x">y</p>'),
      ('p with title'      , '<p title="x">y</p>'),
      ('a with id'         , '<a href="https://e.test" id="x">y</a>'),
      ('a with data-attr'  , '<a href="https://e.test" data-foo="1">y</a>'),
      ('a with onerror'    , '<a href="https://e.test" onerror="alert(1)">y</a>'),
      ('a no-space attr'   , '<a href="https://e.test"onerror="alert(1)">y</a>'),
      ('a with style'      , '<a href="https://e.test" style="x">y</a>'),
      ('blockquote class'  , '<blockquote class="x">y</blockquote>'),
      ('pre style'         , '<pre style="color:red">y</pre>'),
      ('code onclick'      , '<code onclick="alert(1)">y</code>'),
      ('hr id'             , '<hr id="x">'),
      ('s class'           , '<s class="x">y</s>'),
      ('del data-attr'     , '<del data-a="1">y</del>'),
      ('blockquote cite'   , '<blockquote cite="https://e.test">y</blockquote>'),
      ('javascript:'       , '<a href="javascript:alert(1)">x</a>'),
      ('JaVaScRiPt:'       , '<a href="JaVaScRiPt:alert(1)">x</a>'),
      ('js with tab'       , E'<a href="java\tscript:alert(1)">x</a>'),
      ('js leading space'  , '<a href=" javascript:alert(1)">x</a>'),
      ('data:'             , '<a href="data:text/html,x">x</a>'),
      ('vbscript:'         , '<a href="vbscript:msgbox(1)">x</a>'),
      ('file:'             , '<a href="file:///etc/passwd">x</a>'),
      ('protocol-relative' , '<a href="//evil.example">x</a>'),
      ('proto-rel path'    , '<a href="//e.test/x">y</a>'),
      ('backslash host'    , '<a href="/\evil.example">x</a>'),
      ('href empty'        , '<a href="">x</a>'),
      ('href whitespace'   , '<a href="   ">x</a>'),
      ('href trailing junk', '<a href="https://e.test x">y</a>'),
      ('href newline'      , E'<a href="https://e.test\nx">y</a>'),
      ('uppercase SCRIPT'  , '<SCRIPT>alert(1)</SCRIPT>'),
      ('uppercase P'       , '<P>x</P>'),
      ('single-quoted'     , '<a href=''https://e.test''>x</a>'),
      ('unquoted attr'     , '<a href=https://e.test>x</a>'),
      ('valueless attr'    , '<a href>x</a>'),
      ('html comment'      , '<p>a<!-- note -->b</p>'),
      ('doctype'           , '<!DOCTYPE html><p>x</p>'),
      ('raw lt in text'    , '<p>5 < 7</p>'),
      ('stray gt'          , '<p>x</p>>'),
      ('space before name' , '< p>x</p>'),
      ('space after name'  , '<p >x</p>'),
      ('smuggle in title'  , '<a href="https://e.test" title="<script>alert(1)</script>">y</a>'),
      ('nested script'     , '<a href="https://e.test"><script>alert(1)</script></a>'),
      ('control char'      , E'<p>a\x01b</p>'),
      ('vertical tab'      , E'<p>a\x0Bb</p>')
    ) as t(l, h)
  loop
    if public.is_safe_blog_html(v_html) then
      raise exception
        'VERIFICATION FAILED 5/6/7: an unsafe payload was ACCEPTED: %', v_label;
    end if;
  end loop;

  raise notice 'PASS 5, 6, 7: all 62 hostile payloads are refused';
end $$;


-- ============================================================
-- PART 2 — REAL WRITES AS REAL ROLES (STAGING ONLY)
-- ============================================================

begin;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_adm uuid := gen_random_uuid();
  v_usr uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_mgr, 'v57-manager@verification.invalid'),
    (v_adm, 'v57-admin@verification.invalid'),
    (v_usr, 'v57-user@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_mgr, 'client',  'V57 Manager', 'v57-manager@verification.invalid'),
    (v_adm, 'admin',   'V57 Admin',   'v57-admin@verification.invalid'),
    (v_usr, 'client',  'V57 User',    'v57-user@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  /* The manager's blog access is a GRANT, not a role. */
  insert into public.blog_managers (email, profile_id, granted_by)
  values ('v57-manager@verification.invalid', v_mgr, v_adm);

  perform set_config('app.v57_mgr', v_mgr::text, false);
  perform set_config('app.v57_adm', v_adm::text, false);
  perform set_config('app.v57_usr', v_usr::text, false);
end $$;


-- Checks 8 and 9: the blog manager.

do $$
declare
  v_sqlstate text;
  v_message text;
  v_detail text;
  v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_mgr'), true);

  insert into public.blog_posts (slug, title, body_html)
  values ('v57-manager-safe', 'Manager safe',
          '<h2>Heading</h2><p><strong>Bold</strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">Link</a></p>')
  returning id into v_id;

  if v_id is null then
    raise exception 'VERIFICATION FAILED 8: the blog manager could not write safe HTML';
  end if;

  reset role;
  raise notice 'PASS 8: a blog manager can write safe HTML';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_mgr'), true);

  begin
    insert into public.blog_posts (slug, title, body_html)
    values ('v57-manager-xss', 'Manager XSS', '<img src=x onerror=alert(1)>');

    reset role;
    raise exception 'VERIFICATION FAILED 9: a blog manager persisted unsafe HTML';
  exception
    when check_violation then
      get stacked diagnostics
        v_sqlstate = returned_sqlstate,
        v_message  = message_text,
        v_detail   = pg_exception_detail;
  end;

  reset role;

  if v_sqlstate <> '23514' then
    raise exception 'VERIFICATION FAILED 12: expected SQLSTATE 23514, got %', v_sqlstate;
  end if;

  if v_message <> 'unsafe_blog_html' then
    raise exception
      'VERIFICATION FAILED 12: expected the exact token unsafe_blog_html, got %', v_message;
  end if;

  /*
   * The payload must not come back to the caller, in the message
   * or in DETAIL. A bare CHECK constraint fails this: PostgreSQL
   * attaches "Failing row contains (...)" and PostgREST forwards
   * it as `details`, which is why the BEFORE trigger fronts it.
   */
  if v_message like '%onerror%' or v_message like '%alert(1)%'
     or coalesce(v_detail, '') like '%onerror%'
     or coalesce(v_detail, '') like '%alert(1)%' then
    raise exception
      'VERIFICATION FAILED 13: the rejected payload was echoed back: message=% detail=%',
      v_message, v_detail;
  end if;

  raise notice 'PASS 9: a blog manager CANNOT persist unsafe HTML';
  raise notice 'PASS 12: rejection is SQLSTATE 23514 with the exact token unsafe_blog_html';
  raise notice 'PASS 13: the rejected content is echoed in neither message nor DETAIL';

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_blog_posts_validate_html'
      and tgrelid = 'public.blog_posts'::regclass
      and not tgisinternal
  ) then
    raise exception 'VERIFICATION FAILED 22: the validating BEFORE trigger is missing';
  end if;

  raise notice 'PASS 22: the BEFORE trigger fronts the constraint';
end $$;


-- Checks 10 and 11: the admin is bound by the same rule.

do $$
declare
  v_id uuid;
  v_refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_adm'), true);

  insert into public.blog_posts (slug, title, body_html)
  values ('v57-admin-safe', 'Admin safe', '<p>Fine</p>')
  returning id into v_id;

  if v_id is null then
    raise exception 'VERIFICATION FAILED 10: an admin could not write safe HTML';
  end if;

  begin
    insert into public.blog_posts (slug, title, body_html)
    values ('v57-admin-xss', 'Admin XSS', '<script>alert(1)</script>');
    v_refused := false;
  exception
    when check_violation then
      v_refused := true;
  end;

  reset role;

  if not v_refused then
    raise exception
      'VERIFICATION FAILED 11: an admin persisted unsafe HTML - the rule must bind every writer';
  end if;

  raise notice 'PASS 10, 11: an admin can write safe HTML and is refused unsafe HTML';
end $$;


-- Check 21: UPDATE is enforced, not only INSERT.

do $$
declare
  v_refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_mgr'), true);

  begin
    update public.blog_posts
       set body_html = '<div style="position:fixed">overlay</div>'
     where slug = 'v57-manager-safe';
    v_refused := false;
  exception
    when check_violation then
      v_refused := true;
  end;

  reset role;

  if not v_refused then
    raise exception 'VERIFICATION FAILED 21: an UPDATE smuggled unsafe HTML past the rule';
  end if;

  raise notice 'PASS 21: UPDATE is enforced exactly as INSERT is';
end $$;


-- Checks 14 and 15: who may write at all is unchanged.

do $$
declare
  v_blocked boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_usr'), true);

  begin
    insert into public.blog_posts (slug, title, body_html)
    values ('v57-ordinary', 'Ordinary', '<p>Safe but unauthorized</p>');
    v_blocked := false;
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;

  reset role;

  if not v_blocked then
    raise exception
      'VERIFICATION FAILED 14: an ordinary authenticated user wrote to blog_posts';
  end if;

  raise notice 'PASS 14: an ordinary authenticated user still cannot write';

  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  begin
    insert into public.blog_posts (slug, title, body_html)
    values ('v57-anon', 'Anon', '<p>Safe but unauthorized</p>');
    v_blocked := false;
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;

  reset role;

  if not v_blocked then
    raise exception 'VERIFICATION FAILED 15: anon wrote to blog_posts';
  end if;

  raise notice 'PASS 15: anon still cannot write';
end $$;


-- Checks 24, 25 and 26: service_role.
--
-- The BEFORE trigger calls is_safe_blog_html as the INVOKING
-- role, so any writer of blog_posts needs EXECUTE on it.
-- service_role can write blog_posts through Supabase's own
-- grants, so without that EXECUTE every orchestrator write would
-- fail with "permission denied for function" the moment this
-- migration applied.

do $$
declare
  v_id uuid;
  v_refused boolean := false;
  v_msg text;
begin
  if not has_function_privilege(
       'service_role', 'public.is_safe_blog_html(text)', 'execute') then
    raise exception
      'VERIFICATION FAILED 24: service_role cannot execute is_safe_blog_html; every service-role write to blog_posts would fail';
  end if;

  /*
   * Explicitly granted, not merely inherited. Migration 056's
   * lesson: an ambient Supabase default is not something to build
   * on. Asserted by looking for service_role in the function's
   * own ACL rather than trusting has_function_privilege, which
   * cannot tell an explicit grant from an ambient one.
   */
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(coalesce(p.proacl, '{}')) as acl(entry)
    where n.nspname = 'public'
      and p.proname = 'is_safe_blog_html'
      and acl.entry::text like 'service_role=%'
  ) then
    raise exception
      'VERIFICATION FAILED 24: service_role EXECUTE is not stated in the function ACL, only inherited';
  end if;

  raise notice 'PASS 24: service_role holds EXECUTE explicitly, not ambiently';

  set local role service_role;

  insert into public.blog_posts (slug, title, body_html)
  values ('v57-service-safe', 'Service safe',
          '<blockquote><p>Quoted</p></blockquote><pre><code>const x = 1;</code></pre><hr>')
  returning id into v_id;

  if v_id is null then
    raise exception 'VERIFICATION FAILED 25: service_role could not write safe HTML';
  end if;

  raise notice 'PASS 25: service_role can write safe HTML';

  begin
    insert into public.blog_posts (slug, title, body_html)
    values ('v57-service-xss', 'Service XSS', '<img src=x onerror=alert(1)>');
    v_refused := false;
  exception
    when check_violation then
      v_refused := true;
      get stacked diagnostics v_msg = message_text;
  end;

  reset role;

  if not v_refused then
    raise exception 'VERIFICATION FAILED 26: service_role persisted unsafe HTML';
  end if;

  if v_msg <> 'unsafe_blog_html' then
    raise exception
      'VERIFICATION FAILED 26: service_role rejection message was %, expected unsafe_blog_html', v_msg;
  end if;

  raise notice 'PASS 26: service_role is refused unsafe HTML, with the same clean error';
end $$;


-- ============================================================
-- PART 3 — REVISIONS, READS AND SCHEDULING (STAGING ONLY)
-- ============================================================

-- Check 16: the public can still read a published post.

do $$
declare
  v_count int;
begin
  update public.blog_posts
     set status = 'published', published_at = now() - interval '1 hour'
   where slug = 'v57-manager-safe';

  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into v_count
  from public.blog_posts where slug = 'v57-manager-safe';

  reset role;

  if v_count <> 1 then
    raise exception 'VERIFICATION FAILED 16: anon can no longer read a published post';
  end if;

  raise notice 'PASS 16: a published post is still publicly readable';
end $$;


-- Checks 17, 18 and 19: revisions.

do $$
declare
  v_before int;
  v_after int;
  v_denied boolean := false;
  v_post uuid;
begin
  select id into v_post from public.blog_posts where slug = 'v57-manager-safe';

  select count(*) into v_before
  from public.blog_post_revisions where post_id = v_post;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_mgr'), true);

  update public.blog_posts
     set body_html = '<p>An edited, still perfectly safe body.</p>'
   where id = v_post;

  reset role;

  select count(*) into v_after
  from public.blog_post_revisions where post_id = v_post;

  if v_after <= v_before then
    raise exception
      'VERIFICATION FAILED 17: the revision trigger stopped recording safe updates';
  end if;

  raise notice 'PASS 17: the revision trigger still records a safe update';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', current_setting('app.v57_mgr'), true);

  begin
    insert into public.blog_post_revisions (post_id, title, body_html)
    values (v_post, 'Direct', '<p>direct</p>');
    v_denied := false;
  exception
    when insufficient_privilege or check_violation then
      v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception
      'VERIFICATION FAILED 18: a client inserted directly into blog_post_revisions';
  end if;

  raise notice 'PASS 18: direct revision insert is still denied';

  /*
   * Deliberate: the archive is NOT constrained. Migration 057
   * constrains blog_posts only, so historical revisions are never
   * rewritten to satisfy a rule introduced after they were
   * written. New revisions are compliant by construction because
   * they are copied from an already-validated blog_posts row.
   */
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.blog_post_revisions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%is_safe_blog_html%'
  ) then
    raise exception
      'VERIFICATION FAILED 19: the archive was constrained; historical revisions must stay untouched';
  end if;

  raise notice 'PASS 19: blog_post_revisions is deliberately left unconstrained';
end $$;


-- Check 20: scheduled publishing is unaffected.

do $$
declare
  v_published int;
begin
  insert into public.blog_posts (slug, title, body_html, status, scheduled_for)
  values ('v57-scheduled', 'Scheduled', '<p>Due now</p>',
          'scheduled', now() - interval '1 minute');

  perform public.publish_due_blog_posts();

  select count(*) into v_published
  from public.blog_posts
  where slug = 'v57-scheduled' and status = 'published';

  if v_published <> 1 then
    raise exception
      'VERIFICATION FAILED 20: scheduled publishing no longer promotes a due post';
  end if;

  raise notice 'PASS 20: scheduled publishing is unaffected';
end $$;

rollback;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
--   alter table public.blog_posts drop constraint unsafe_blog_html;
--   drop function if exists public.is_safe_blog_html(text);
--
-- Dropping the constraint restores the pre-057 position exactly:
-- a blog manager's JWT can again persist arbitrary HTML through
-- PostgREST, and readers depend entirely on the frontend
-- sanitizer. No content is altered by adding or dropping it.
-- ============================================================
