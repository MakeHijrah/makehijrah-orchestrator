-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 055: Blog redirect hardening
-- ============================================================
--
-- Classification:
-- - Security patch. No behaviour change for any legitimate
--   redirect; closes an open-redirect class of defect.
--
-- The defect:
-- - Migration 052 constrains from_path and to_path with
--   `like '/%'` -- "starts with a slash". That accepts
--   //evil.example, because the string starts with a slash
--   followed by another slash. A path beginning // is a
--   SCHEME-RELATIVE URL: a browser resolves it against the
--   CURRENT PROTOCOL and sends the visitor to evil.example, not
--   to a path on this site. A redirect table meant to hold only
--   internal application paths could therefore be made to hold an
--   external one.
--
-- The fix:
-- - A shared validation function, used identically for both
--   from_path and to_path, requiring: exactly one leading slash
--   (starts with /, does not start with //); no :// anywhere (a
--   scheme embedded past the first character, e.g.
--   /redirect?to=https://evil.example, is not blocked by the
--   leading-slash rule alone); no backslash anywhere (some
--   browsers normalize \ to / when resolving a URL, so
--   /\evil.example can become //evil.example after normalization
--   even though it never contains a literal // or :// -- this is
--   the same open-redirect class as the reported defect, reached
--   through a different character, and is closed for the same
--   reason); no control character, which includes CR and LF (a
--   raw \r\n in a value that ever reaches a Location header is a
--   header-injection vector, not merely an open redirect); and
--   non-empty.
--
-- Before adding the constraint, every EXISTING row is checked
-- against the new rule. If any row would violate it, this
-- migration RAISES and applies nothing -- see the guard below.
-- This repository cannot inspect production's actual data from
-- here; the guard is what makes "stop if unsafe rows exist" true
-- regardless of who applies this migration or what state the
-- table is actually in.
--
-- Defense in depth, and its limit:
-- - This backend has no redirect-serving code of its own to
--   harden. blog_redirects.from_path is described, in migration
--   052's own comment, as "what the edge handler compares
--   against" -- redirects are served by a frontend/edge function
--   outside this repository, not by the orchestrator. The
--   database constraint below is therefore the only validation
--   layer this repository can own; hardening the edge handler
--   itself is a frontend/infra follow-up, not something this
--   migration can reach.
--
-- Deliberately NOT done here:
-- - blog_redirects_no_self and blog_redirects_status are
--   unchanged.
-- - No rewriting of any existing value. A row that fails the new
--   rule is reported, never silently corrected -- correcting it
--   is an editorial decision (what should evil.example have
--   actually pointed to?) that only a human can make.
-- - No new table, no new column.
--
-- Rerun safety:
-- - Idempotent. The validation function is CREATE OR REPLACE, and
--   each constraint is dropped before being re-added. The
--   pre-check guard is naturally idempotent: a database that
--   already satisfies the new rule raises nothing on a second
--   run.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.blog_redirects') is null then
    raise exception
      'migration 055: public.blog_redirects not found - migration 052 must be applied first';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- A. The shared validation rule
-- ------------------------------------------------------------
--
-- IMMUTABLE and side-effect free, which a function referenced
-- from a CHECK constraint is required to be. Used identically for
-- from_path and to_path -- there is no reason for the two to
-- follow different rules, since both are internal-path values
-- compared against the same edge handler.

create or replace function public.is_safe_internal_path(p text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select
    p is not null
    and p <> ''
    -- exactly one leading slash: starts with /, but not //
    and p ~ '^/'
    and p !~ '^//'
    -- no embedded scheme, at any position
    and p !~ '://'
    -- no backslash: some browsers normalize \ to / when resolving
    -- a URL, which can turn /\host into a scheme-relative //host
    -- after normalization even though this literal string never
    -- contains // or ://
    and p !~ '\\'
    -- no control character, which covers CR and LF (header
    -- injection if this value ever reaches a raw Location header)
    -- alongside every other C0 control and DEL
    and p !~ '[\x00-\x1F\x7F]';
$$;

comment on function public.is_safe_internal_path(text) is
  'Migration 055. True only for a value that is safe to treat as '
  'an internal application path: exactly one leading slash, no '
  'embedded scheme, no backslash, no control character, '
  'non-empty. Used identically for blog_redirects.from_path and '
  '.to_path.';

revoke all on function public.is_safe_internal_path(text)
  from public, anon, authenticated;

/*
 * Reachable through the CHECK constraints below regardless of
 * this grant -- constraint evaluation does not consult EXECUTE
 * privilege on a function it calls, the same fact migration 036
 * established for triggers. Granted to authenticated anyway,
 * explicitly rather than left to Supabase's ambient default,
 * because unlike a trigger function this one is a plausible
 * candidate for a client to call directly (a blog manager's
 * editor validating a redirect destination before submitting it,
 * for a better error than a bare constraint violation). Read-only
 * and reveals nothing beyond true/false for a string the caller
 * already supplied.
 */
grant execute on function public.is_safe_internal_path(text)
  to authenticated;

-- ------------------------------------------------------------
-- B. Guard: existing data must already satisfy the new rule
-- ------------------------------------------------------------
--
-- This repository cannot inspect production's actual rows before
-- applying this file. This block is what makes "stop if unsafe
-- rows exist" true in that circumstance: it runs the exact rule
-- the constraint is about to enforce against every existing row,
-- and RAISES, naming them, if any would fail. Because this
-- migration is one transaction, that RAISE aborts the whole
-- migration -- nothing here is applied.

do $$
declare
  v_bad_from text;
  v_bad_to text;
begin
  select string_agg(format('id=%s from_path=%L', id, from_path), '; ')
    into v_bad_from
    from public.blog_redirects
   where not public.is_safe_internal_path(from_path);

  select string_agg(format('id=%s to_path=%L', id, to_path), '; ')
    into v_bad_to
    from public.blog_redirects
   where not public.is_safe_internal_path(to_path);

  if v_bad_from is not null or v_bad_to is not null then
    raise exception
      'migration 055: existing blog_redirects row(s) fail the hardened path rule and must be corrected by hand before this migration can apply. Unsafe from_path: %. Unsafe to_path: %.',
      coalesce(v_bad_from, '(none)'), coalesce(v_bad_to, '(none)');
  end if;
end;
$$;

-- ------------------------------------------------------------
-- C. The hardened constraints
-- ------------------------------------------------------------

alter table public.blog_redirects
  drop constraint if exists blog_redirects_from_leading_slash;
alter table public.blog_redirects
  add constraint blog_redirects_from_leading_slash
  check (public.is_safe_internal_path(from_path));

alter table public.blog_redirects
  drop constraint if exists blog_redirects_to_leading_slash;
alter table public.blog_redirects
  add constraint blog_redirects_to_leading_slash
  check (public.is_safe_internal_path(to_path));

-- Unchanged, restated for clarity that this migration did not
-- touch them.
--   blog_redirects_no_self  check (from_path <> to_path)
--   blog_redirects_status   check (status_code in (301, 302, 308))

commit;

-- ------------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_055_VERIFICATION.sql for the full self-contained suite.
--
--  1. select public.is_safe_internal_path('/blog/new-slug');
--       -> true
--
--  2. select public.is_safe_internal_path('//evil.example');
--       -> false
--
--  3. select conname, pg_get_constraintdef(oid) from pg_constraint
--      where conrelid = 'public.blog_redirects'::regclass
--        and conname like 'blog_redirects_%leading_slash';
--       -> both reference is_safe_internal_path(...)
