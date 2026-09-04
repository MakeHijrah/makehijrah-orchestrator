-- ============================================================
-- CANONICALIZATION NOTE (added by orchestrator, content below
-- otherwise unchanged from the source)
-- ============================================================
--
-- This migration originated in the frontend repository as
-- migration_052_blog_grants_and_email_invites.sql and was already
-- applied to production from there. It is imported here,
-- renumbered to the next free backend slot, so the orchestrator
-- repository — which owns canonical migration history — can
-- reproduce the blog schema in a fresh environment.
--
-- DO NOT APPLY THIS FILE TO PRODUCTION. The objects and grants it
-- creates already exist there. Applying it again is safe in
-- isolation (every statement is guarded), but it is listed here
-- as history, not as a pending change.
--
-- Content below is byte-for-byte the source file except for the
-- migration number in the banner, the three cross-references to
-- the preceding migration, and two COMMENT ON statements, all
-- updated from 052/051 to this file's canonical position (053,
-- referring back to 052).
-- ============================================================

-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 053: Blog table grants, and granting access by email
-- ============================================================
--
-- Fixes two defects in migration 052.
--
-- A. MISSING GRANTS.
--    052 created every blog table with RLS policies but no table
--    privileges. Those are two different things: a policy decides
--    WHICH ROWS a role may see, a grant decides whether the role
--    may touch the table at all. With policies alone every blog
--    table answers 42501 "permission denied", so the blog was
--    entirely unreachable — including public post reads, which is
--    why the sitemap came back empty.
--
-- B. A GRANT COULD NOT PRECEDE AN ACCOUNT.
--    blog_managers was keyed on profile_id, so access could only
--    be given to somebody who already had a login. The public site
--    calls signInWithOtp with shouldCreateUser: false and there is
--    no public sign-up anywhere, so an outside SEO contractor had
--    no way to obtain an account and therefore no way to be given
--    the blog. The grant is now keyed on EMAIL and may be issued
--    before the account exists; it activates by itself the moment
--    somebody signs in with that address.
--
-- Rerun safety: every statement is guarded. Safe to apply twice.
-- ============================================================

-- ------------------------------------------------------------
-- A. Table privileges
-- ------------------------------------------------------------

/*
 * RLS remains the control. These grants only make the tables
 * addressable; every row still passes the policies from 052.
 *
 * anon receives SELECT on the public reading surface and on
 * nothing else. It is not granted a single write anywhere, and it
 * cannot address blog_managers or blog_post_revisions at all —
 * those hold, respectively, who may write and what drafts said.
 */
grant select on public.blog_posts      to anon, authenticated;
grant select on public.blog_authors    to anon, authenticated;
grant select on public.blog_categories to anon, authenticated;
grant select on public.blog_tags       to anon, authenticated;
grant select on public.blog_post_tags  to anon, authenticated;
grant select on public.blog_redirects  to anon, authenticated;

grant insert, update, delete on public.blog_posts      to authenticated;
grant insert, update, delete on public.blog_authors    to authenticated;
grant insert, update, delete on public.blog_categories to authenticated;
grant insert, update, delete on public.blog_tags       to authenticated;
grant insert, update, delete on public.blog_post_tags  to authenticated;
grant insert, update, delete on public.blog_redirects  to authenticated;

-- Authorship history: readable by managers, written by the trigger.
grant select on public.blog_post_revisions to authenticated;

-- Who may write. Never anon; RLS narrows this to administrators.
grant select, insert, update, delete on public.blog_managers to authenticated;

-- ------------------------------------------------------------
-- B. Grants that can precede an account
-- ------------------------------------------------------------

/*
 * profile_id stops being the identity of a grant and becomes a
 * note about it — filled in when the person is known, absent when
 * they have not signed in yet. The email is what the grant is
 * actually about.
 */
alter table public.blog_managers
  drop constraint if exists blog_managers_pkey;

alter table public.blog_managers
  alter column profile_id drop not null;

alter table public.blog_managers
  add column if not exists id uuid not null default gen_random_uuid();

alter table public.blog_managers
  add column if not exists email text;

-- Any grant issued under the old shape keeps working.
update public.blog_managers bm
   set email = lower(btrim(p.email))
  from public.profiles p
 where p.id = bm.profile_id
   and (bm.email is null or btrim(bm.email) = '');

/*
 * A row with neither an email nor a resolvable profile identifies
 * nobody and can never activate. There should be none; deleting
 * them is what makes the NOT NULL below safe to apply.
 */
delete from public.blog_managers where email is null or btrim(email) = '';

alter table public.blog_managers alter column email set not null;

do $$ begin
  alter table public.blog_managers add primary key (id);
exception when invalid_table_definition then null;
end $$;

/*
 * One grant per address, case-insensitively. Somebody typing
 * Mahmud@Agency.com must not create a second grant beside
 * mahmud@agency.com.
 */
create unique index if not exists uq_blog_managers_email
  on public.blog_managers (lower(btrim(email)));

comment on column public.blog_managers.email is
  'Migration 053. The address the grant is for. May be issued '
  'before an account exists; it activates on first sign-in.';
comment on column public.blog_managers.profile_id is
  'Migration 053. Informational, and null until the person signs '
  'in. Access is decided by email, never by this column alone.';

-- ------------------------------------------------------------
-- C. The capability, resolved by address
-- ------------------------------------------------------------

/*
 * Matches on the verified email in the caller's JWT, or on a
 * profile_id already linked.
 *
 * The empty-string guard matters: without it a token carrying no
 * email would match any row whose address had somehow been blanked,
 * which is precisely the kind of accident that hands out authorship.
 */
create or replace function public.is_blog_manager()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1
      from public.blog_managers bm
     where bm.profile_id = auth.uid()
        or (
          coalesce(auth.jwt() ->> 'email', '') <> ''
          and lower(btrim(bm.email)) = lower(btrim(auth.jwt() ->> 'email'))
        )
  ) or public.is_admin();
$$;

/*
 * A person may see their own grant, by either identity. Granting
 * and revoking remain administrator-only: a manager who could
 * appoint managers is an administrator by another name.
 */
drop policy if exists blog_managers_select on public.blog_managers;
create policy blog_managers_select on public.blog_managers
for select to authenticated
using (
  public.is_admin()
  or profile_id = auth.uid()
  or (
    coalesce(auth.jwt() ->> 'email', '') <> ''
    and lower(btrim(email)) = lower(btrim(auth.jwt() ->> 'email'))
  )
);

-- ------------------------------------------------------------
-- D. Linking a grant to its account
-- ------------------------------------------------------------

/*
 * When somebody signs in for the first time, handle_new_user
 * creates their profile. This attaches any grant already waiting
 * on that address, so the admin list can show a name rather than
 * only an email.
 *
 * Access does NOT depend on this running — is_blog_manager()
 * already matches by address. This only tidies the record.
 */
create or replace function public.link_blog_manager_profile()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  update public.blog_managers
     set profile_id = new.id
   where profile_id is null
     and coalesce(new.email, '') <> ''
     and lower(btrim(email)) = lower(btrim(new.email));
  return new;
end;
$$;

drop trigger if exists trg_link_blog_manager_profile on public.profiles;
create trigger trg_link_blog_manager_profile
  after insert on public.profiles
  for each row execute function public.link_blog_manager_profile();
