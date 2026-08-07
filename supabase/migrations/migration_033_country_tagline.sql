-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 033: Country tagline
-- ============================================================
--
-- Classification:
-- - v1.0.x production patch against released v1.0.
--
-- The problem this solves:
-- - countries carries name and iso_code and nothing that reads as
--   a sentence. Public surfaces that list a country have no short
--   line to render beneath its name, and there is nowhere for an
--   admin to store one.
--
-- What this migration does:
--   A. Adds public.countries.tagline.
--   B. Normalises that column on write: a tagline is stored
--      trimmed, and a blank or whitespace-only tagline is stored
--      as null.
--
-- Why B is in the database rather than in the orchestrator:
-- - countries has no orchestrator route. It is one of the two
--   catalogue tables written directly against Supabase by the
--   admin frontend, under the countries_insert_admin and
--   countries_update_admin policies from migration 002, and read
--   directly by anon and authenticated clients through
--   countries_select_active_public. The orchestrator touches the
--   table only to check that a submitted country id is active
--   (consultant-profile.repository.ts) and to prove Supabase is
--   reachable (the /health probe); neither reads a column beyond
--   id, and neither writes.
-- - So the only place the trim-and-nullify rule can hold for
--   every writer is the table itself. A trigger applies it to the
--   existing admin CRUD path without introducing a new one, and
--   keeps '' and '   ' from becoming values that are visually
--   empty but not null.
--
-- Deliberately NOT done here:
-- - No default. An absent tagline is null, which is what every
--   existing row already reads as after the column is added.
-- - No not-null constraint and no backfill. Every country
--   predating this migration keeps a null tagline, and that null
--   is honest: no source exists to invent one from.
-- - No length or content check. "Short" is an editorial rule, not
--   a data one; a constraint here would reject admin input at the
--   database with an opaque error and no way to preview it.
-- - No RLS change. The four countries policies from migration 002
--   are row-level and column-agnostic, and countries carries no
--   column-level grants, so tagline is readable and writable by
--   exactly the roles that could already read and write the row.
-- - No enum change, no new table, no new column on any other
--   table. The data model remains 16 tables.
-- - No orchestrator change. Nothing in the service reads a
--   country's name or iso_code today, so there is no reader to
--   widen; adding one would be a new country workflow, not this.
--
-- Rerun safety:
-- - Idempotent. The column add is guarded, the function is
--   CREATE OR REPLACE, and the trigger is dropped before it is
--   created. Reapplying changes nothing.
-- ============================================================

begin;

-- ----------------------------------------------- A. Tagline column ----
--
-- Nullable with no default. A country without a tagline is the
-- normal state, not a defect, and null says so exactly once.
-- Defaulting to '' would make "no tagline" and "a tagline of zero
-- length" indistinguishable to every reader.
--
-- text rather than varchar(n): the length ceiling belongs to the
-- editing surface, which can show it, not to the column, which
-- can only reject.

do $$
begin
  if to_regclass('public.countries') is null then
    raise exception 'migration 033: public.countries not found';
  end if;
end;
$$;

alter table public.countries
  add column if not exists tagline text;

comment on column public.countries.tagline is
  'Short public line rendered under the country name. Nullable; '
  'stored trimmed, with a blank or whitespace-only value stored '
  'as null by trg_countries_normalize_tagline (migration 033).';

-- ------------------------------------------ B. Write normalisation ----
--
-- Runs on the row before it is stored, so the rule holds for the
-- admin frontend writing through PostgREST, for a service-role
-- write, and for anything applied by hand in the SQL editor. No
-- writer has to remember it and no writer can bypass it.
--
-- nullif(btrim(...), '') collapses the three ways a blank arrives
-- — '', '   ', a line of tabs — into one stored null. A tagline
-- that is null already stays null without reaching btrim.
--
-- The trimmed character set is spelled out rather than left to
-- btrim's default of spaces alone, so a tagline padded with tabs
-- or a trailing newline normalises the same way as one padded
-- with spaces.

create or replace function public.normalize_country_tagline()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.tagline is not null then
    new.tagline := nullif(
      btrim(new.tagline, E' \t\n\r\f\v'),
      ''
    );
  end if;

  return new;
end;
$$;

-- Not callable outside the trigger. Firing a trigger does not
-- consult EXECUTE privilege, so this narrows the surface without
-- affecting the normalisation.
revoke all
on function public.normalize_country_tagline()
from public;

drop trigger if exists trg_countries_normalize_tagline
  on public.countries;

-- `update of tagline` keeps an unrelated write — flipping
-- is_active, correcting a name — from paying for a trigger that
-- would have nothing to change. Stored taglines are already
-- normalised, so skipping those updates cannot drift the column.
create trigger trg_countries_normalize_tagline
  before insert or update of tagline on public.countries
  for each row
  execute function public.normalize_country_tagline();

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See MIGRATION_033_VERIFICATION.sql
-- for the full self-contained suite.
--
--  1. select data_type, is_nullable, column_default
--       from information_schema.columns
--      where table_schema = 'public'
--        and table_name   = 'countries'
--        and column_name  = 'tagline';
--       -> text | YES | null
--
--  2. select tgname from pg_trigger
--      where tgrelid = 'public.countries'::regclass
--        and not tgisinternal;
--       -> trg_countries_normalize_tagline
--
--  3. select count(*) from pg_policies
--      where schemaname = 'public' and tablename = 'countries';
--       -> 4
--
--  4. select count(*) from information_schema.tables
--      where table_schema = 'public' and table_type = 'BASE TABLE';
--       -> 16
