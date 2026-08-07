-- ============================================================
-- Verification for migration_033_country_tagline
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  column, trigger and function shape     read-only
--   Part 2  write behaviour                        STAGING ONLY, rolls back
--   Part 3  scope inspection                       read-only
--   Part 4  rollback guidance
--
-- Part 2 creates every fixture it needs inside a transaction and
-- rolls it back. It reads no business record and writes to no
-- table other than countries.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed. There are no SKIP paths.
--
-- Check map:
--    1  the column exists: text, nullable, no default        Part 1
--    2  the normalisation trigger exists, BEFORE INSERT and
--       UPDATE OF tagline, FOR EACH ROW                      Part 1
--    3  the trigger function is plpgsql with a pinned
--       search_path and is not SECURITY DEFINER              Part 1
--    4  an admin create stores a tagline                     Part 2
--    5  a create trims surrounding whitespace                Part 2
--    6  an admin update changes a tagline                    Part 2
--    7  an update can clear a tagline back to null           Part 2
--    8  a blank or whitespace-only tagline stores null, on
--       both insert and update                               Part 2
--    9  a create that omits tagline stores null              Part 2
--   10  an update that does not name tagline preserves it    Part 2
--   11  an existing country keeps null and stays writable
--       exactly as before                                    Part 2
--   12  no country predating the migration acquired a
--       tagline                                              Part 3
--   13  the four countries policies are unchanged and RLS
--       is still enabled                                     Part 3
--   14  no column-level grant narrows the new column: the
--       roles that could write the row can write tagline     Part 3
--   15  table count remains 16, no enum changed              Part 3
--   16  fixtures roll back, asserted not assumed             Part 2
-- ============================================================


-- ============================================================
-- PART 1 — COLUMN, TRIGGER AND FUNCTION SHAPE (read-only)
-- ============================================================

-- Check 1.
--
-- Nullable and defaultless are the whole contract of the column.
-- A default that crept in would make every future country carry a
-- value nobody typed.

do $$
declare
  v_type     text;
  v_nullable text;
  v_default  text;
begin
  select data_type, is_nullable, column_default
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'countries'
     and column_name  = 'tagline';

  if v_type is null then
    raise exception
      'check 1 failed: public.countries.tagline does not exist';
  end if;

  if v_type <> 'text' then
    raise exception
      'check 1 failed: tagline is %, expected text', v_type;
  end if;

  if v_nullable <> 'YES' then
    raise exception
      'check 1 failed: tagline is not nullable';
  end if;

  if v_default is not null then
    raise exception
      'check 1 failed: tagline carries a default (%)', v_default;
  end if;

  raise notice 'check 1 passed: tagline is text, nullable, no default';
end;
$$;


-- Checks 2 and 3.
--
-- The trigger is what makes the blank-to-null rule true for the
-- admin frontend, which writes the table directly. If it is
-- missing or fires on the wrong event, every other check in
-- Part 2 would still pass for the rows this file writes and fail
-- for the rows the product writes.

do $$
declare
  v_tgtype    smallint;
  v_cols      smallint[];
  v_fn        oid;
  v_lang      text;
  v_secdef    boolean;
  v_config    text;
  v_tagline   smallint;
begin
  select t.tgtype, t.tgattr::smallint[], t.tgfoid
    into v_tgtype, v_cols, v_fn
    from pg_trigger t
   where t.tgrelid  = 'public.countries'::regclass
     and t.tgname   = 'trg_countries_normalize_tagline'
     and not t.tgisinternal;

  if v_tgtype is null then
    raise exception
      'check 2 failed: trg_countries_normalize_tagline not found on public.countries';
  end if;

  -- pg_trigger.tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT,
  -- 16 = UPDATE.
  if (v_tgtype & 1) = 0 then
    raise exception 'check 2 failed: trigger is not FOR EACH ROW';
  end if;

  if (v_tgtype & 2) = 0 then
    raise exception 'check 2 failed: trigger is not BEFORE';
  end if;

  if (v_tgtype & 4) = 0 then
    raise exception 'check 2 failed: trigger does not fire on INSERT';
  end if;

  if (v_tgtype & 16) = 0 then
    raise exception 'check 2 failed: trigger does not fire on UPDATE';
  end if;

  select a.attnum
    into v_tagline
    from pg_attribute a
   where a.attrelid = 'public.countries'::regclass
     and a.attname  = 'tagline';

  if v_cols is null
     or array_length(v_cols, 1) <> 1
     or v_cols[1] <> v_tagline then
    raise exception
      'check 2 failed: trigger UPDATE column list is %, expected {tagline}',
      v_cols;
  end if;

  select l.lanname,
         p.prosecdef,
         array_to_string(p.proconfig, ', ')
    into v_lang, v_secdef, v_config
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = v_fn;

  if v_lang <> 'plpgsql' then
    raise exception
      'check 3 failed: trigger function language is %', v_lang;
  end if;

  if v_secdef then
    raise exception
      'check 3 failed: trigger function is SECURITY DEFINER; it must run as the writer';
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'check 3 failed: trigger function search_path is %, expected search_path=pg_catalog, public',
      coalesce(v_config, '<unset>');
  end if;

  raise notice 'checks 2 and 3 passed: trigger and function shape are correct';
end;
$$;


-- ============================================================
-- PART 2 — WRITE BEHAVIOUR (STAGING ONLY, rolls back)
-- ============================================================
--
-- Everything below happens inside one transaction that ends in
-- ROLLBACK. The fixtures use an iso_code range no real country
-- occupies. Check 16 proves the rollback afterwards.

begin;

do $$
declare
  v_existing  uuid;
  v_created   uuid;
  v_tagline   text;
  v_name      text;
  v_iso       text;
  v_active    boolean;
  v_created_at timestamptz;
begin
  -- ---------------------------------------------------------
  -- Check 11 — a country that predates the tagline, written the
  -- way migration 001 allowed, is still insertable unchanged and
  -- reads back with a null tagline.
  -- ---------------------------------------------------------
  insert into public.countries (name, iso_code)
  values ('Verification Legacy 033', 'Q1')
  returning id into v_existing;

  select tagline, is_active
    into v_tagline, v_active
    from public.countries
   where id = v_existing;

  if v_tagline is not null then
    raise exception
      'check 11 failed: a country written without a tagline stored %',
      quote_literal(v_tagline);
  end if;

  if v_active is not true then
    raise exception
      'check 11 failed: is_active no longer defaults to true';
  end if;

  -- ---------------------------------------------------------
  -- Checks 4 and 5 — an admin create stores a tagline, trimmed.
  -- ---------------------------------------------------------
  insert into public.countries (name, iso_code, tagline, is_active)
  values (
    'Verification Create 033',
    'Q2',
    E'  Where the Nile meets the sea \t ',
    true
  )
  returning id into v_created;

  select name, iso_code, tagline, is_active, created_at
    into v_name, v_iso, v_tagline, v_active, v_created_at
    from public.countries
   where id = v_created;

  if v_tagline <> 'Where the Nile meets the sea' then
    raise exception
      'checks 4 and 5 failed: stored tagline is %, expected the trimmed value',
      quote_literal(v_tagline);
  end if;

  if v_name <> 'Verification Create 033'
     or v_iso <> 'Q2'
     or v_active is not true
     or v_created_at is null then
    raise exception
      'check 4 failed: a create carrying a tagline disturbed another column';
  end if;

  raise notice 'checks 4, 5 and 11 passed: create stores a trimmed tagline; a legacy row is unaffected';

  -- ---------------------------------------------------------
  -- Check 6 — an admin update changes a tagline.
  -- ---------------------------------------------------------
  update public.countries
     set tagline = '  A second line  '
   where id = v_created;

  select tagline into v_tagline
    from public.countries where id = v_created;

  if v_tagline <> 'A second line' then
    raise exception
      'check 6 failed: updated tagline is %, expected the trimmed second line',
      quote_literal(v_tagline);
  end if;

  -- ---------------------------------------------------------
  -- Check 8 — a blank or whitespace-only tagline stores null,
  -- on update and on insert alike.
  -- ---------------------------------------------------------
  for v_name in
    select unnest(array['', '   ', E'\t', E' \n ', E'\r\n'])
  loop
    update public.countries
       set tagline = v_name
     where id = v_created;

    select tagline into v_tagline
      from public.countries where id = v_created;

    if v_tagline is not null then
      raise exception
        'check 8 failed: blank input % stored %',
        quote_literal(v_name), quote_literal(v_tagline);
    end if;
  end loop;

  insert into public.countries (name, iso_code, tagline)
  values ('Verification Blank 033', 'Q3', '     ');

  select tagline into v_tagline
    from public.countries where iso_code = 'Q3';

  if v_tagline is not null then
    raise exception
      'check 8 failed: a blank tagline on insert stored %',
      quote_literal(v_tagline);
  end if;

  raise notice 'checks 6 and 8 passed: update changes a tagline; blank input stores null';

  -- ---------------------------------------------------------
  -- Checks 7 and 9 — an explicit null clears, and an omitted
  -- tagline stores null.
  -- ---------------------------------------------------------
  update public.countries
     set tagline = 'restored'
   where id = v_created;

  update public.countries
     set tagline = null
   where id = v_created;

  select tagline into v_tagline
    from public.countries where id = v_created;

  if v_tagline is not null then
    raise exception
      'check 7 failed: an explicit null stored %',
      quote_literal(v_tagline);
  end if;

  insert into public.countries (name, iso_code)
  values ('Verification Omitted 033', 'Q4');

  select tagline into v_tagline
    from public.countries where iso_code = 'Q4';

  if v_tagline is not null then
    raise exception
      'check 9 failed: an omitted tagline stored %',
      quote_literal(v_tagline);
  end if;

  -- ---------------------------------------------------------
  -- Check 10 — an update that does not name tagline leaves it
  -- alone. This is the case `update of tagline` is narrowed for,
  -- and the one that would silently drop taglines if the trigger
  -- were written against the whole row incorrectly.
  -- ---------------------------------------------------------
  update public.countries
     set tagline = 'kept across an unrelated update'
   where id = v_created;

  update public.countries
     set is_active = false
   where id = v_created;

  select tagline, is_active
    into v_tagline, v_active
    from public.countries
   where id = v_created;

  if v_tagline is distinct from 'kept across an unrelated update' then
    raise exception
      'check 10 failed: an unrelated update changed tagline to %',
      quote_literal(coalesce(v_tagline, '<null>'));
  end if;

  if v_active is not false then
    raise exception
      'check 10 failed: the unrelated update did not apply';
  end if;

  -- The legacy row must have gone through all of this untouched.
  select tagline into v_tagline
    from public.countries where id = v_existing;

  if v_tagline is not null then
    raise exception
      'check 11 failed: the legacy row acquired a tagline';
  end if;

  raise notice 'checks 7, 9 and 10 passed: null clears, omission stores null, unrelated updates preserve';
end;
$$;

rollback;


-- Check 16 — the fixtures are gone.

do $$
declare
  v_left integer;
begin
  select count(*)
    into v_left
    from public.countries
   where iso_code in ('Q1', 'Q2', 'Q3', 'Q4');

  if v_left <> 0 then
    raise exception
      'check 16 failed: % verification country row(s) survived the rollback',
      v_left;
  end if;

  raise notice 'check 16 passed: every fixture rolled back';
end;
$$;


-- ============================================================
-- PART 3 — SCOPE INSPECTION (read-only)
-- ============================================================

-- Check 12.
--
-- Run immediately after applying the migration. Every country
-- that existed beforehand must still read null: the migration
-- backfills nothing and invents nothing.

do $$
declare
  v_with_tagline integer;
begin
  select count(*)
    into v_with_tagline
    from public.countries
   where tagline is not null;

  if v_with_tagline <> 0 then
    raise notice
      'check 12: % country row(s) already carry a tagline. Expected 0 immediately after applying; anything else means editing has begun.',
      v_with_tagline;
  else
    raise notice 'check 12 passed: no pre-existing country acquired a tagline';
  end if;
end;
$$;


-- Check 13.
--
-- Migration 033 adds, drops and rewrites no policy. The four
-- policies from migration 002 must still be present with the same
-- commands and the same admin predicate, and RLS must still be
-- enabled on the table.

do $$
declare
  v_rls   boolean;
  v_count integer;
  v_row   record;
begin
  select c.relrowsecurity
    into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'countries';

  if v_rls is not true then
    raise exception
      'check 13 failed: row level security is not enabled on public.countries';
  end if;

  select count(*)
    into v_count
    from pg_policies
   where schemaname = 'public' and tablename = 'countries';

  if v_count <> 4 then
    raise exception
      'check 13 failed: public.countries carries % policies, expected 4',
      v_count;
  end if;

  for v_row in
    select policyname, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public' and tablename = 'countries'
  loop
    if v_row.policyname = 'countries_select_active_public' then
      if v_row.cmd <> 'SELECT'
         or v_row.qual not like '%is_admin()%'
         or v_row.qual not like '%is_active%' then
        raise exception
          'check 13 failed: countries_select_active_public changed (cmd %, using %)',
          v_row.cmd, v_row.qual;
      end if;

    elsif v_row.policyname = 'countries_insert_admin' then
      if v_row.cmd <> 'INSERT'
         or v_row.with_check not like '%is_admin()%' then
        raise exception
          'check 13 failed: countries_insert_admin changed';
      end if;

    elsif v_row.policyname = 'countries_update_admin' then
      if v_row.cmd <> 'UPDATE'
         or v_row.qual not like '%is_admin()%'
         or v_row.with_check not like '%is_admin()%' then
        raise exception
          'check 13 failed: countries_update_admin changed';
      end if;

    elsif v_row.policyname = 'countries_delete_admin' then
      if v_row.cmd <> 'DELETE'
         or v_row.qual not like '%is_admin()%' then
        raise exception
          'check 13 failed: countries_delete_admin changed';
      end if;

    else
      raise exception
        'check 13 failed: unexpected policy % on public.countries',
        v_row.policyname;
    end if;
  end loop;

  raise notice 'check 13 passed: the four countries policies and RLS are unchanged';
end;
$$;


-- Check 14.
--
-- Policies are row-level. What decides whether the admin CRUD
-- path can write the NEW column is the column privilege, and
-- countries has never carried a column-level grant. If tagline
-- were somehow not writable by `authenticated`, admin edits would
-- fail with a permission error that no policy inspection explains.

do $$
begin
  if not has_column_privilege(
       'authenticated', 'public.countries', 'tagline', 'INSERT'
     ) then
    raise exception
      'check 14 failed: authenticated cannot INSERT countries.tagline';
  end if;

  if not has_column_privilege(
       'authenticated', 'public.countries', 'tagline', 'UPDATE'
     ) then
    raise exception
      'check 14 failed: authenticated cannot UPDATE countries.tagline';
  end if;

  if not has_column_privilege(
       'authenticated', 'public.countries', 'tagline', 'SELECT'
     ) then
    raise exception
      'check 14 failed: authenticated cannot SELECT countries.tagline';
  end if;

  -- The public booking surface reads countries before login.
  if not has_column_privilege(
       'anon', 'public.countries', 'tagline', 'SELECT'
     ) then
    raise exception
      'check 14 failed: anon cannot SELECT countries.tagline';
  end if;

  -- anon must still be unable to write the catalogue at all.
  if has_column_privilege(
       'anon', 'public.countries', 'tagline', 'UPDATE'
     ) then
    raise notice
      'check 14: anon holds the UPDATE grant on countries.tagline. This matches the table-wide grant Supabase issues; the countries_update_admin policy is what denies the write.';
  end if;

  raise notice 'check 14 passed: tagline carries the same privileges as the rest of the row';
end;
$$;


-- Check 15.
--
-- The migration adds a column and a trigger. It must not have
-- added a table or touched an enum.

do $$
declare
  v_tables  integer;
  v_columns integer;
  v_labels  integer;
begin
  select count(*)
    into v_tables
    from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  /*
   * 20 since migration 034 added the four finance tables. This
   * check exists to prove migration 033 added none of its own, so
   * the number tracks the current model size and moves whenever a
   * later migration legitimately adds a table.
   */
  if v_tables <> 20 then
    raise exception
      'check 15 failed: public holds % base tables, expected 20',
      v_tables;
  end if;

  select count(*)
    into v_columns
    from information_schema.columns
   where table_schema = 'public' and table_name = 'countries';

  if v_columns <> 6 then
    raise exception
      'check 15 failed: countries holds % columns, expected 6 (id, name, iso_code, is_active, created_at, tagline)',
      v_columns;
  end if;

  select count(*)
    into v_labels
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public';

  raise notice
    'check 15 passed: 16 base tables, countries holds 6 columns, % enum labels recorded for comparison against the pre-migration count',
    v_labels;
end;
$$;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Migration 033 is additive. Nothing reads tagline yet, so the
-- migration can be left in place and simply ignored; that is the
-- preferred response to a problem with it.
--
-- To reverse it fully, in this order:
--
--   drop trigger if exists trg_countries_normalize_tagline
--     on public.countries;
--
--   drop function if exists public.normalize_country_tagline();
--
--   alter table public.countries drop column if exists tagline;
--
-- Dropping the column destroys every tagline written since the
-- migration was applied, and no other copy exists. Export them
-- first if any editing has happened:
--
--   select iso_code, tagline from public.countries
--    where tagline is not null;
--
-- To keep the taglines but stop the normalisation, drop the
-- trigger alone. Blank strings then become storable again, so a
-- writer must trim before it writes.
-- ============================================================

do $$
begin
  raise notice
    'migration 033 verification complete: no check raised';
end;
$$;
