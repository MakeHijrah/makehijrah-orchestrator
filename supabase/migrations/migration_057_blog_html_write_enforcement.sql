-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 057: Blog HTML write-boundary enforcement
-- ============================================================
--
-- THE TRUST BOUNDARY THIS ESTABLISHES — READ THIS FIRST.
--
-- RLS on blog_posts controls WHO may write. Nothing controlled
-- WHAT they may write. A blog manager holds a valid JWT, and that
-- JWT is usable against PostgREST directly — curl, fetch from any
-- origin, the Supabase JS client in a console. The editor's
-- sanitizer is a frontend convenience the writer can simply skip.
--
-- So before this migration, any blog manager could persist
--
--     <img src=x onerror=alert(1)>
--
-- into blog_posts.body_html, and every reader of that post was
-- protected only by the frontend remembering to sanitize on the
-- way out.
--
-- This migration makes the DATABASE enforce the allowed shape, on
-- every write path, for every role, forever.
--
-- ------------------------------------------------------------
-- WHY REJECT AND NOT SANITIZE
-- ------------------------------------------------------------
--
-- PostgreSQL has no HTML parser. A regex-based sanitizer that
-- MUTATES markup is the classic source of mutation-XSS: the
-- rewriter and the browser disagree about where a tag ends, and
-- the attacker engineers the disagreement.
--
-- This function never rewrites anything. It answers one question
-- — is this value entirely within the approved contract — and the
-- write is refused if the answer is no. A rejecter's failure mode
-- is a refused write. A rewriter's failure mode is a stored XSS.
--
-- ------------------------------------------------------------
-- WHY TOKENISING WITH A REGEX IS SOUND *HERE*
-- ------------------------------------------------------------
--
-- Regex tokenising of arbitrary HTML is unsound. It is sound
-- against this contract, because of an empirically verified
-- property of the frontend's sanitize-html output (2.17.7,
-- verified against the exact allowlist in section 3 of the
-- approved policy):
--
--   every '<' and '>' that is not part of a tag is emitted as
--   &lt; / &gt;, INCLUDING inside attribute values, where '>' is
--   escaped and '"' is escaped to &quot;.
--
-- So in conforming content, '<' always begins a tag and '"'
-- always delimits an attribute value. Tokenising is exact rather
-- than approximate.
--
-- Content that does NOT have this property fails the check —
-- which is the safe direction. The rule is: strip every tag that
-- is unambiguously on the allowlist, and if any '<' or '>'
-- survives, refuse the write. Anything the allowlist patterns do
-- not match exactly is left behind and rejects the row. There is
-- no path where an unrecognised construct is silently accepted.
--
-- ------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ------------------------------------------------------------
--
-- Not a well-formedness check. '<p>x' with no closing tag is
-- accepted: unbalanced markup is a rendering concern, not a
-- security one, and rejecting it would refuse legitimate content
-- over a fault no reader can be harmed by.
--
-- Not a decoder. '&lt;script&gt;' is accepted because it IS text
-- — it renders as the literal characters "<script>" and cannot
-- execute. A post explaining HTML must remain writable. This
-- holds as long as stored HTML is inserted once, never decoded
-- and re-inserted.
--
-- Not applied to blog_post_revisions. Those rows are an archive,
-- written only by the trigger from an already-validated
-- blog_posts row, so new revisions are compliant by construction.
-- Historical rows are records of what was published and are not
-- rewritten to satisfy a rule introduced afterwards. All 30
-- existing revisions were audited and would pass regardless.
--
-- DOES NOT REPLACE FRONTEND SANITIZATION. Persistence integrity
-- and rendering security are different jobs. sanitizeBlogHtml()
-- before dangerouslySetInnerHTML remains mandatory: revisions are
-- unconstrained, imports and manual SQL bypass application
-- assumptions, and every rendering sink must keep treating stored
-- HTML as untrusted.
-- ============================================================


-- ------------------------------------------------------------
-- A. The rule
-- ------------------------------------------------------------
--
-- IMMUTABLE and side-effect free, as a function reached from a
-- CHECK constraint must be.
--
-- The allowlist is exactly the frontend's approved contract:
--   tags       p br strong em b i u ul ol li h2 h3 a
--              s del code pre blockquote hr
--   attributes href title rel target — on <a> only
--   schemes    http https mailto, plus an internal path
--
-- The six formatting tags beyond the original set (s, del, code,
-- pre, blockquote, hr) carry NO attributes, exactly like the rest.
-- None of them can execute anything; they are typography.
--
-- WHAT THIS VALIDATOR IS FOR, AND WHAT IT IS NOT FOR.
--
-- It enforces a safe VOCABULARY: which elements may exist, which
-- attributes may appear on them, and which URL shapes an href may
-- take. It deliberately does NOT enforce the frontend's
-- serialization. rel, target and title accept any text that
-- contains no quote or angle bracket, because none of them can
-- execute; requiring an exact string, or an attribute order,
-- would make storage brittle against a harmless editor change
-- while adding no security.
--
--   Database  — safe vocabulary, safe href, no executable
--               elements or attributes.
--   Frontend  — canonicalises surviving links to
--               target="_blank" rel="noopener noreferrer nofollow".
--
-- Those are different jobs and the split is intentional.
--
-- Attributes are permitted on <a> and on nothing else, so
-- <p onclick="..."> and <span class="..."> are refused by the
-- same mechanism that refuses <script>: their tag never matches
-- an allowlist pattern, so it is never stripped, so a '<'
-- survives.

create or replace function public.is_safe_blog_html(p text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  with input as (
    select coalesce(p, '') as h
  ),
  stripped as (
    /*
     * Remove every tag that is unambiguously on the allowlist.
     *
     * Alternatives are ordered longest-first so the match is
     * deterministic regardless of how the regex engine resolves
     * an ambiguous alternation: 'strong' is tried before 's',
     * 'blockquote' before 'b'.
     *
     * Case-sensitive on purpose: sanitize-html lowercases tag and
     * attribute names, so <SCRIPT> and <P> are both non-conforming
     * and both must reject.
     *
     * br and hr are the two void elements. Both are accepted bare
     * or self-closed; sanitize-html emits '<br />' and '<hr />'.
     *
     * Attribute values may not contain " < or >, which is what
     * makes the <a> pattern exact — a smuggled '>' inside a title
     * cannot terminate the tag early.
     */
    select regexp_replace(
             regexp_replace(
               regexp_replace(
                 h,
                 '</?(blockquote|strong|code|pre|del|h2|h3|li|ol|ul|em|b|i|p|s|u)>', '', 'g'),
               '<(br|hr)\s*/?>', '', 'g'),
             '<a(\s+(href|title|rel|target)="[^"<>]*")*\s*>|</a>', '', 'g'
           ) as rest
    from input
  )
  select
    /*
     * No C0 control characters or DEL. Tab, LF and CR are allowed
     * — the editor emits them as formatting whitespace. Everything
     * else in that range is a smuggling primitive.
     */
    (select h !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' from input)

    /*
     * The load-bearing check. After stripping the allowlist,
     * conforming content contains no angle bracket at all.
     */
    and (select rest !~ '[<>]' from stripped)

    /*
     * Every href, checked independently of where it appeared.
     * Anchored end to end, so 'https://e.test javascript:x' is not
     * accepted on the strength of its prefix, and no whitespace is
     * tolerated inside a URL — that is where scheme obfuscation
     * lives.
     */
    and not exists (
      select 1
      from input, regexp_matches(input.h, 'href="([^"]*)"', 'g') as m
      where not (
        m[1] ~ '^https?://[^[:space:]"<>]+$'
        or m[1] ~ '^mailto:[^[:space:]"<>]+$'
        /*
         * Internal links reuse migration 055's rule rather than a
         * second opinion about what a safe path is. It refuses
         * //host, ://, backslashes and control characters.
         *
         * The frontend sets allowProtocolRelative: false and also
         * refuses //evil.example. Both layers reject it; this is
         * agreement, not one layer covering for the other.
         */
        or public.is_safe_internal_path(m[1])
      )
    );
$$;

comment on function public.is_safe_blog_html(text) is
  'Migration 057. True only for blog HTML entirely within the '
  'approved editorial contract: tags p br strong em b i u ul ol '
  'li h2 h3 a s del code pre blockquote hr; attributes href, '
  'title, rel and target on <a> only and on no other tag; hrefs '
  'limited to http, https, mailto or a safe internal path. '
  'Enforces vocabulary, not serialization -- rel/target/title '
  'take any quote-free, angle-free text, because canonicalising '
  'them is the frontend sanitizer''s job. Validates, never '
  'rewrites. Does NOT replace render-time sanitization.';

revoke all on function public.is_safe_blog_html(text)
  from public, anon, authenticated;

/*
 * Reached through the CHECK constraint regardless of this grant —
 * constraint evaluation does not consult EXECUTE privilege, the
 * same fact migrations 036 and 055 established. Granted to
 * authenticated explicitly, as migration 055 grants
 * is_safe_internal_path, so an editor can validate before
 * submitting and show a better message than a bare constraint
 * violation. Read-only, and reveals nothing beyond true/false
 * about a string the caller already holds.
 */
grant execute on function public.is_safe_blog_html(text)
  to authenticated;

/*
 * service_role needs this explicitly, and the reason is migration
 * 056's lesson restated.
 *
 * The BEFORE trigger below calls this function as the INVOKING
 * role, not as the owner. So any writer of blog_posts must be
 * able to execute it, and service_role can write blog_posts --
 * verified against production, where Supabase's own grants let
 * the service key insert into the table directly.
 *
 * Today service_role also holds EXECUTE here, but only through
 * Supabase's ambient default privileges: verified in production
 * against is_safe_internal_path, which carries this identical
 * revoke-then-grant pattern and which service_role can call.
 * That is precisely the kind of ambient grant migration 056 was
 * written about. Depending on it would mean every orchestrator
 * write to blog_posts breaks the day the platform default
 * changes -- so the grant is stated here rather than inherited.
 */
grant execute on function public.is_safe_blog_html(text)
  to service_role;


-- ------------------------------------------------------------
-- B. Guard: existing rows must already satisfy the rule
-- ------------------------------------------------------------
--
-- This repository cannot inspect production's rows before this
-- file runs. This block is what makes "stop rather than break
-- live content" true in that circumstance: it applies the exact
-- rule to every existing row and RAISES, naming the offenders, if
-- any would fail.
--
-- The migration is one transaction, so that RAISE aborts
-- everything here — no constraint is added, no content is
-- touched, and the failing slugs are reported for review.
--
-- Nothing is rewritten. A destructive fix-up of editorial content
-- is not something a migration gets to decide.

do $$
declare
  v_bad text;
  v_count int;
begin
  select count(*), string_agg(slug, ', ' order by slug)
    into v_count, v_bad
  from public.blog_posts
  where not public.is_safe_blog_html(body_html);

  if v_count > 0 then
    raise exception
      'Migration 057 stopped: % existing blog post(s) do not satisfy the safe-HTML rule: %. '
      'Nothing has been applied. Review and correct these posts, then re-run.',
      v_count, v_bad;
  end if;
end $$;


-- ------------------------------------------------------------
-- C. The constraint
-- ------------------------------------------------------------
--
-- A CHECK constraint rather than a trigger, deliberately:
--
--  - it is evaluated AFTER every BEFORE trigger, so it validates
--    the value actually being stored, not an earlier draft of it;
--  - it applies to every writer identically — blog manager, admin,
--    service_role, PostgREST, psql, a future orchestrator route —
--    with no ordering or privilege subtleties;
--  - adding it validates every existing row, so the guard above
--    cannot be silently out of date.
--
-- Named for the failure it reports, not the state it requires, so
-- the error a client receives is self-describing. PostgREST
-- surfaces it as SQLSTATE 23514 with the constraint name in the
-- message, which is a stable string the frontend can map without
-- parsing prose. Nothing about the rejected content is echoed
-- back.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'unsafe_blog_html'
      and conrelid = 'public.blog_posts'::regclass
  ) then
    alter table public.blog_posts
      add constraint unsafe_blog_html
      check (public.is_safe_blog_html(body_html));
  end if;
end $$;

comment on constraint unsafe_blog_html on public.blog_posts is
  'Migration 057. Refuses any body_html outside the approved '
  'editorial contract, on every write path including direct '
  'PostgREST. Defence in depth: render-time sanitization in the '
  'frontend remains mandatory and is not replaced by this.';

-- ------------------------------------------------------------
-- D. A clean error, in front of the constraint
-- ------------------------------------------------------------
--
-- The constraint alone enforces correctly but reports badly.
-- PostgreSQL attaches a DETAIL of "Failing row contains (...)" to
-- a check violation, and PostgREST passes that through to the
-- client as `details`. That string contains the rejected markup
-- verbatim.
--
-- It is the writer's own payload returned to the writer, so it
-- discloses nothing they did not already have. It is still worth
-- removing: an admin UI that renders an API error into the page
-- would be rendering attacker-authored markup, which turns a
-- refused write into self-XSS.
--
-- So a BEFORE trigger raises the same refusal first, with a
-- deterministic message and no DETAIL. The CHECK constraint stays
-- underneath it as the structural backstop — it validates
-- existing rows when added, cannot be disabled by a table owner
-- the way a trigger can, and still catches anything that somehow
-- reaches the table without firing triggers.
--
-- Fires after trg_blog_posts_before_write (alphabetical order),
-- which derives body_text and stamps timestamps but never alters
-- body_html — so this validates the value that will actually be
-- stored.

create or replace function public.blog_posts_validate_html()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not public.is_safe_blog_html(new.body_html) then
    /*
     * The message is the whole contract: a stable token the
     * frontend can map, and nothing else. No offsets, no excerpt,
     * no echo of what was submitted, and no HINT.
     *
     * The allowed vocabulary is deliberately NOT stated here. A
     * database error is client-visible, and reciting the allowlist
     * to an unauthenticated-in-spirit caller hands an attacker the
     * exact shape of what passes without them having to probe for
     * it. The contract is published where it belongs — in
     * API_CONTRACT.md and Amendment 018 — for the people entitled
     * to read it.
     */
    raise exception 'unsafe_blog_html'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.blog_posts_validate_html() is
  'Migration 057. Refuses an unsafe body_html with the '
  'deterministic message unsafe_blog_html and nothing else: no '
  'echo of the submitted content, and no statement of the allowed '
  'vocabulary. The CHECK constraint of the same name is the '
  'backstop beneath it.';

revoke all on function public.blog_posts_validate_html()
  from public, anon, authenticated;

drop trigger if exists trg_blog_posts_validate_html on public.blog_posts;
create trigger trg_blog_posts_validate_html
  before insert or update on public.blog_posts
  for each row execute function public.blog_posts_validate_html();
