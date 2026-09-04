-- ============================================================
-- CANONICALIZATION NOTE (added by orchestrator, content below
-- otherwise unchanged from the source)
-- ============================================================
--
-- This migration originated in the frontend repository as
-- migration_051_blog.sql and was already applied to production
-- from there. It is imported here, renumbered to the next free
-- backend slot, so the orchestrator repository — which owns
-- canonical migration history — can reproduce the blog schema in
-- a fresh environment.
--
-- DO NOT APPLY THIS FILE TO PRODUCTION. The objects it creates
-- already exist there. Applying it again is harmless in isolation
-- (every statement is IF NOT EXISTS / CREATE OR REPLACE), but it
-- is listed here as history, not as a pending change.
--
-- Content below is byte-for-byte the source file except for the
-- migration number in the banner and in one COMMENT ON, updated
-- from 051 to 052 to match this file's canonical position.
-- ============================================================

-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 052: Editorial blog
-- ============================================================
--
-- Classification:
-- - Additive feature migration. Creates new tables only.
--
-- What this migration does NOT do, deliberately:
-- - It does not touch the user_role enum. A Postgres enum value
--   can never be removed, a profile can hold only one role, and
--   the existing three are load-bearing across every RLS policy
--   in the system. Blog access is a GRANT held in its own table
--   instead: additive, revocable with one DELETE, and orthogonal
--   to whatever role a person already has. An admin can also be
--   a blog manager without ceasing to be an admin.
-- - It does not alter profiles, consultants, consultations,
--   services or anything financial. No existing policy, trigger,
--   grant or column is modified.
--
-- The access model:
--   PUBLIC (anon)      may read PUBLISHED posts, and the
--                      categories, tags and authors they
--                      reference. Nothing else.
--   BLOG MANAGER       full authorship: drafts, scheduling,
--                      taxonomy, redirects, revisions.
--   ADMIN              is a blog manager implicitly, and is the
--                      only role that may grant or revoke the
--                      capability.
--
-- Rerun safety:
-- - Every statement is IF NOT EXISTS / CREATE OR REPLACE / DROP
--   POLICY IF EXISTS + CREATE POLICY. Safe to apply twice.
-- ============================================================

-- ------------------------------------------------------------
-- A. The capability
-- ------------------------------------------------------------

create table if not exists public.blog_managers (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  granted_by  uuid not null references public.profiles(id),
  granted_at  timestamptz not null default now(),
  note        text
);

comment on table public.blog_managers is
  'Migration 052. Grants blog authorship. Deliberately a table and '
  'not a user_role enum value: enum values cannot be removed, a '
  'profile may hold only one role, and this capability is '
  'orthogonal to being a client, consultant or admin.';

/*
 * The RLS helper. Admins are included so an administrator never
 * has to grant the capability to themselves to fix a typo, and so
 * every policy below can be written against one predicate.
 */
create or replace function public.is_blog_manager()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.blog_managers bm where bm.profile_id = auth.uid()
  ) or public.is_admin();
$$;

-- ------------------------------------------------------------
-- B. Taxonomy and bylines
-- ------------------------------------------------------------

/*
 * An author is NOT a profile. A byline may belong to a guest
 * writer, an agency or a pen name that never has a login, so the
 * link to profiles is optional and nullable.
 */
create table if not exists public.blog_authors (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references public.profiles(id) on delete set null,
  name        text not null,
  slug        text not null unique,
  bio         text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint blog_authors_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint blog_authors_name_present check (length(btrim(name)) > 0)
);

create table if not exists public.blog_categories (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  description      text,
  -- A category is an indexable landing page, so it carries its own meta.
  seo_title        text,
  seo_description  text,
  sort_order       int  not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint blog_categories_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint blog_categories_name_present check (length(btrim(name)) > 0)
);

create table if not exists public.blog_tags (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now(),
  constraint blog_tags_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint blog_tags_name_present check (length(btrim(name)) > 0)
);

-- ------------------------------------------------------------
-- C. Posts
-- ------------------------------------------------------------

do $$ begin
  create type public.blog_post_status as enum
    ('draft', 'scheduled', 'published', 'archived');
exception when duplicate_object then null;
end $$;

create table if not exists public.blog_posts (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  status        public.blog_post_status not null default 'draft',

  -- Content
  title         text not null,
  excerpt       text,
  body_html     text not null default '',
  /*
   * Plain text alongside the markup, maintained by the trigger
   * below. Reading time and any future search index must not be
   * computed from HTML, where a long class attribute counts as
   * words and an <img> counts as none.
   */
  body_text     text not null default '',
  reading_minutes int not null default 1,

  -- Imagery. The alt text is NOT optional in spirit: an image
  -- without it is invisible to search and to screen readers.
  featured_image_url text,
  featured_image_alt text,

  -- SEO. Every field here overrides a default rather than
  -- replacing it, so a post with none of them still renders
  -- complete metadata derived from its title and excerpt.
  seo_title        text,
  seo_description  text,
  canonical_url    text,
  noindex          boolean not null default false,
  og_title         text,
  og_description   text,
  og_image_url     text,

  -- Relationships
  author_id     uuid references public.blog_authors(id) on delete set null,
  category_id   uuid references public.blog_categories(id) on delete set null,

  -- Lifecycle
  published_at  timestamptz,
  scheduled_for timestamptz,
  created_by    uuid references public.profiles(id),
  updated_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint blog_posts_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint blog_posts_slug_length check (length(slug) between 3 and 120),
  constraint blog_posts_title_present check (length(btrim(title)) > 0),

  /*
   * A published post must have a publication date. Without one it
   * cannot be ordered, cannot carry a dateline, and cannot be
   * placed in a sitemap with a lastmod anybody should trust.
   */
  constraint blog_posts_published_needs_date check (
    status <> 'published' or published_at is not null
  ),
  constraint blog_posts_scheduled_needs_date check (
    status <> 'scheduled' or scheduled_for is not null
  )
);

create index if not exists idx_blog_posts_published
  on public.blog_posts (published_at desc)
  where status = 'published';

create index if not exists idx_blog_posts_category
  on public.blog_posts (category_id)
  where status = 'published';

create index if not exists idx_blog_posts_scheduled
  on public.blog_posts (scheduled_for)
  where status = 'scheduled';

create table if not exists public.blog_post_tags (
  post_id uuid not null references public.blog_posts(id) on delete cascade,
  tag_id  uuid not null references public.blog_tags(id) on delete cascade,
  primary key (post_id, tag_id)
);

create index if not exists idx_blog_post_tags_tag on public.blog_post_tags (tag_id);

-- ------------------------------------------------------------
-- D. Revisions
-- ------------------------------------------------------------

/*
 * Append-only history, written by the trigger below on every
 * content change. An editor who overwrites three paragraphs at
 * 2am must be able to get them back.
 */
create table if not exists public.blog_post_revisions (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.blog_posts(id) on delete cascade,
  title       text not null,
  excerpt     text,
  body_html   text not null,
  edited_by   uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create index if not exists idx_blog_post_revisions_post
  on public.blog_post_revisions (post_id, created_at desc);

-- ------------------------------------------------------------
-- E. Redirects
-- ------------------------------------------------------------

/*
 * A slug change breaks every inbound link and every ranking
 * already earned at the old address. The old path is recorded
 * here so it can answer 301 instead of 404.
 *
 * from_path is stored WITH its leading slash and without a host,
 * because that is what the edge handler compares against.
 */
create table if not exists public.blog_redirects (
  id          uuid primary key default gen_random_uuid(),
  from_path   text not null unique,
  to_path     text not null,
  status_code int  not null default 301,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id),
  constraint blog_redirects_from_leading_slash check (from_path like '/%'),
  constraint blog_redirects_to_leading_slash check (to_path like '/%'),
  constraint blog_redirects_no_self check (from_path <> to_path),
  constraint blog_redirects_status check (status_code in (301, 302, 308))
);

-- ------------------------------------------------------------
-- F. Triggers
-- ------------------------------------------------------------

create or replace function public.blog_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

/*
 * Derives body_text and reading time from the markup, and records
 * a revision whenever the content actually changes.
 *
 * Reading time is computed here rather than in the browser so it
 * is identical for every reader and cannot drift between the
 * editor's preview and the published page. 200 words per minute
 * is the usual convention; a post always reads as at least one
 * minute, because "0 min read" is not a useful thing to print.
 */
create or replace function public.blog_posts_before_write()
returns trigger language plpgsql as $$
declare
  v_words int;
begin
  new.body_text := btrim(
    regexp_replace(
      regexp_replace(coalesce(new.body_html, ''), '<[^>]*>', ' ', 'g'),
      '\s+', ' ', 'g'
    )
  );

  v_words := coalesce(array_length(
    regexp_split_to_array(nullif(new.body_text, ''), '\s+'), 1
  ), 0);

  new.reading_minutes := greatest(1, ceil(v_words / 200.0)::int);

  -- Publishing stamps the date once, and never restamps it: an
  -- edit is not a new publication and must not move the dateline.
  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.blog_posts_after_write()
returns trigger language plpgsql as $$
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

drop trigger if exists trg_blog_posts_before_write on public.blog_posts;
create trigger trg_blog_posts_before_write
  before insert or update on public.blog_posts
  for each row execute function public.blog_posts_before_write();

drop trigger if exists trg_blog_posts_after_write on public.blog_posts;
create trigger trg_blog_posts_after_write
  after insert or update on public.blog_posts
  for each row execute function public.blog_posts_after_write();

drop trigger if exists trg_blog_authors_touch on public.blog_authors;
create trigger trg_blog_authors_touch before update on public.blog_authors
  for each row execute function public.blog_touch_updated_at();

drop trigger if exists trg_blog_categories_touch on public.blog_categories;
create trigger trg_blog_categories_touch before update on public.blog_categories
  for each row execute function public.blog_touch_updated_at();

-- ------------------------------------------------------------
-- G. Row level security
-- ------------------------------------------------------------

alter table public.blog_managers       enable row level security;
alter table public.blog_authors        enable row level security;
alter table public.blog_categories     enable row level security;
alter table public.blog_tags           enable row level security;
alter table public.blog_posts          enable row level security;
alter table public.blog_post_tags      enable row level security;
alter table public.blog_post_revisions enable row level security;
alter table public.blog_redirects      enable row level security;

/*
 * The single definition of "publicly visible". A scheduled post
 * whose time has come is NOT public until something flips its
 * status: the date alone is a promise, not a state, and reading
 * it as one would publish work an editor has not released.
 */
drop policy if exists blog_posts_select_public on public.blog_posts;
create policy blog_posts_select_public on public.blog_posts
for select to anon, authenticated
using (
  (status = 'published' and published_at is not null and published_at <= now())
  or public.is_blog_manager()
);

drop policy if exists blog_posts_write_manager on public.blog_posts;
create policy blog_posts_write_manager on public.blog_posts
for all to authenticated
using (public.is_blog_manager()) with check (public.is_blog_manager());

-- Taxonomy and bylines are public reference data; only managers write.
drop policy if exists blog_authors_select_public on public.blog_authors;
create policy blog_authors_select_public on public.blog_authors
for select to anon, authenticated using (true);
drop policy if exists blog_authors_write_manager on public.blog_authors;
create policy blog_authors_write_manager on public.blog_authors
for all to authenticated
using (public.is_blog_manager()) with check (public.is_blog_manager());

drop policy if exists blog_categories_select_public on public.blog_categories;
create policy blog_categories_select_public on public.blog_categories
for select to anon, authenticated using (true);
drop policy if exists blog_categories_write_manager on public.blog_categories;
create policy blog_categories_write_manager on public.blog_categories
for all to authenticated
using (public.is_blog_manager()) with check (public.is_blog_manager());

drop policy if exists blog_tags_select_public on public.blog_tags;
create policy blog_tags_select_public on public.blog_tags
for select to anon, authenticated using (true);
drop policy if exists blog_tags_write_manager on public.blog_tags;
create policy blog_tags_write_manager on public.blog_tags
for all to authenticated
using (public.is_blog_manager()) with check (public.is_blog_manager());

/*
 * The join is readable publicly, but only ever discloses the
 * pairing. A tag on an unpublished post leaks nothing, because
 * the post itself is unreadable.
 */
drop policy if exists blog_post_tags_select_public on public.blog_post_tags;
create policy blog_post_tags_select_public on public.blog_post_tags
for select to anon, authenticated using (true);
drop policy if exists blog_post_tags_write_manager on public.blog_post_tags;
create policy blog_post_tags_write_manager on public.blog_post_tags
for all to authenticated
using (public.is_blog_manager()) with check (public.is_blog_manager());

-- Drafts live in revisions. Never public.
drop policy if exists blog_revisions_manager on public.blog_post_revisions;
create policy blog_revisions_manager on public.blog_post_revisions
for select to authenticated using (public.is_blog_manager());

drop policy if exists blog_redirects_select_public on public.blog_redirects;
create policy blog_redirects_select_public on public.blog_redirects
for select to anon, authenticated using (true);
drop policy if exists blog_redirects_write_manager on public.blog_redirects;
create policy blog_redirects_write_manager on public.blog_redirects
for all to authenticated
using (public.is_blog_manager()) with check (public.is_blog_manager());

/*
 * Granting the capability is an ADMIN act, not a blog-manager
 * one. A manager who could appoint managers is an administrator
 * by another name.
 */
drop policy if exists blog_managers_select on public.blog_managers;
create policy blog_managers_select on public.blog_managers
for select to authenticated
using (profile_id = auth.uid() or public.is_admin());

drop policy if exists blog_managers_write_admin on public.blog_managers;
create policy blog_managers_write_admin on public.blog_managers
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- H. Scheduled publishing
-- ------------------------------------------------------------

/*
 * Releases posts whose time has arrived. Idempotent, so it may be
 * called from pg_cron, from the orchestrator, or by hand.
 *
 * Security definer with a locked search_path: it must be able to
 * flip status regardless of who calls it, and is granted only to
 * service_role.
 */
create or replace function public.publish_due_blog_posts()
returns integer language plpgsql security definer
set search_path = public as $$
declare
  v_count integer;
begin
  with due as (
    update public.blog_posts
       set status = 'published',
           published_at = coalesce(published_at, scheduled_for, now())
     where status = 'scheduled'
       and scheduled_for is not null
       and scheduled_for <= now()
    returning 1
  )
  select count(*) into v_count from due;
  return v_count;
end;
$$;

revoke all on function public.publish_due_blog_posts() from public;
grant execute on function public.publish_due_blog_posts() to service_role;
