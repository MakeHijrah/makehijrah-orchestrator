-- ============================================================
-- Verification for migration_039_consultant_payout_settings
-- ============================================================
--
-- Review and staging aid. NOT a migration; lives outside
-- supabase/migrations/ so no runner applies it.
--
-- DO NOT RUN AGAINST PRODUCTION.
--
--   Part 1  shape, grants and regressions   read-only
--   Part 2  who may read and write it       STAGING ONLY, rolls back
--   Part 3  the payout snapshot             STAGING ONLY, rolls back
--   Part 4  rollback guidance
--
-- Parts 2 and 3 share one transaction that ends in ROLLBACK and
-- create every fixture they need.
--
-- Every check raises on failure. A run that reaches the final
-- notice without an exception has passed.
--
-- Check map:
--    1  the table exists, keyed by consultant_id, cascading from
--       consultants                                        Part 1
--    2  the vocabulary, presence and shape constraints are
--       all present                                        Part 1
--    3  exactly three policies — select, insert, update —
--       and no DELETE policy                               Part 1
--    4  anon holds nothing; authenticated holds SELECT,
--       INSERT and UPDATE and no DELETE                    Part 1
--    5  request_consultant_payout takes two arguments; the
--       three-argument form that accepted a caller-supplied
--       destination is GONE                                Part 1
--    6  the replaced RPC is SECURITY DEFINER, pinned, and
--       executable only by service_role                    Part 1
--    7  build_payout_destination_note formats both methods
--       and returns null for anything incomplete           Part 1
--    8  no relation anon or a client can read exposes
--       payout_email, and consultants has no payout column Part 1
--    9  21 base tables, and migrations 034-038 are intact   Part 1
--   10  a consultant reads their own setting               Part 2
--   11  a consultant cannot read another consultant's      Part 2
--   12  an admin reads any consultant's setting            Part 2
--   13  a client is denied                                 Part 2
--   14  anon is denied                                     Part 2
--   15  a consultant saves PayPal + email                  Part 2
--   16  a consultant saves Wise + email                    Part 2
--   17  an invalid payout_method is rejected               Part 2
--   18  a method with no email is rejected                 Part 2
--   19  a whitespace-only email normalises to null and is
--       then rejected                                      Part 2
--   20  a consultant cannot write a row for another
--       consultant, even naming their id explicitly        Part 2
--   21  no consultant may delete a settings row            Part 2
--   22  a payout request is refused when no method is set  Part 3
--   23  a payout request is refused when the setting is
--       incomplete                                         Part 3
--   24  a PayPal destination is snapshotted exactly        Part 3
--   25  a Wise destination is snapshotted exactly          Part 3
--   26  changing the setting afterwards does NOT alter an
--       existing payout's destination_note                 Part 3
--   27  the mark-paid workflow is untouched                Part 3
--   28  fixtures roll back, asserted not assumed           Part 3
-- ============================================================


-- ============================================================
-- PART 1 — SHAPE, GRANTS AND REGRESSIONS (read-only)
-- ============================================================

-- Check 1.

do $$
declare
  v_pk text;
  v_delete_rule text;
  v_cols text;
begin
  if to_regclass('public.consultant_payout_settings') is null then
    raise exception
      'VERIFICATION FAILED 1: public.consultant_payout_settings does not exist';
  end if;

  select string_agg(a.attname, ', ' order by a.attnum)
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.consultant_payout_settings'::regclass
     and a.attnum > 0
     and not a.attisdropped;

  if v_cols is distinct from
     'consultant_id, payout_method, payout_email, created_at, updated_at' then
    raise exception
      'VERIFICATION FAILED 1: columns are [%]; expected exactly consultant_id, payout_method, payout_email, created_at, updated_at',
      v_cols;
  end if;

  select string_agg(a.attname, ', ')
    into v_pk
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.conrelid = 'public.consultant_payout_settings'::regclass
     and c.contype = 'p';

  if v_pk is distinct from 'consultant_id' then
    raise exception
      'VERIFICATION FAILED 1: the primary key is [%], expected consultant_id — one payout destination per consultant must be unrepresentable otherwise',
      v_pk;
  end if;

  select case c.confdeltype when 'c' then 'cascade' else c.confdeltype::text end
    into v_delete_rule
    from pg_constraint c
   where c.conrelid = 'public.consultant_payout_settings'::regclass
     and c.contype = 'f';

  if v_delete_rule is distinct from 'cascade' then
    raise exception
      'VERIFICATION FAILED 1: the consultants foreign key deletes with [%], expected cascade',
      coalesce(v_delete_rule, '(no foreign key)');
  end if;

  raise notice
    'PASS 1: consultant_payout_settings is keyed by consultant_id and cascades from consultants';
end $$;


-- Check 2.

do $$
declare
  v_name text;
  v_missing text[] := '{}';
begin
  foreach v_name in array array[
    'payout_settings_method_check',
    'payout_settings_email_presence_check',
    'payout_settings_email_shape_check'
  ]
  loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'public.consultant_payout_settings'::regclass
         and conname = v_name
         and contype = 'c'
    ) then
      v_missing := v_missing || v_name;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'VERIFICATION FAILED 2: missing constraint(s): %',
      array_to_string(v_missing, ', ');
  end if;

  raise notice
    'PASS 2: the vocabulary, presence and shape constraints are all present';
end $$;


-- Check 3.

do $$
declare
  v_cmds text;
begin
  select string_agg(cmd, ', ' order by cmd)
    into v_cmds
    from pg_policies
   where schemaname = 'public'
     and tablename = 'consultant_payout_settings';

  if v_cmds is distinct from 'INSERT, SELECT, UPDATE' then
    raise exception
      'VERIFICATION FAILED 3: the policies are [%]; expected exactly INSERT, SELECT, UPDATE and no DELETE',
      coalesce(v_cmds, '(none)');
  end if;

  if not (
    select relrowsecurity
      from pg_class
     where oid = 'public.consultant_payout_settings'::regclass
  ) then
    raise exception
      'VERIFICATION FAILED 3: row level security is not enabled on consultant_payout_settings';
  end if;

  raise notice
    'PASS 3: RLS is on with exactly three policies and no DELETE policy';
end $$;


-- Check 4.

do $$
declare
  v_privilege text;
begin
  foreach v_privilege in array array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
  ]
  loop
    if has_table_privilege(
         'anon', 'public.consultant_payout_settings', v_privilege) then
      raise exception
        'VERIFICATION FAILED 4: anon holds % on consultant_payout_settings',
        v_privilege;
    end if;
  end loop;

  foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE']
  loop
    if not has_table_privilege(
         'authenticated', 'public.consultant_payout_settings', v_privilege) then
      raise exception
        'VERIFICATION FAILED 4: authenticated lost % on consultant_payout_settings',
        v_privilege;
    end if;
  end loop;

  foreach v_privilege in array array['DELETE', 'TRUNCATE']
  loop
    if has_table_privilege(
         'authenticated', 'public.consultant_payout_settings', v_privilege) then
      raise exception
        'VERIFICATION FAILED 4: authenticated holds % on consultant_payout_settings',
        v_privilege;
    end if;
  end loop;

  raise notice
    'PASS 4: anon holds nothing; authenticated holds SELECT, INSERT, UPDATE and nothing else';
end $$;


-- Checks 5 and 6.
--
-- The three-argument form has to be GONE, not merely unused. A
-- function that still accepts a destination is a function a later
-- edit can start trusting again, and it would be reachable by
-- anything holding the service role.

do $$
declare
  v_config text;
  v_secdef boolean;
  v_oid oid;
begin
  if to_regprocedure(
       'public.request_consultant_payout(uuid, text, text)'
     ) is not null then
    raise exception
      'VERIFICATION FAILED 5: the old three-argument request_consultant_payout still exists; a caller could still supply a destination';
  end if;

  v_oid := to_regprocedure(
    'public.request_consultant_payout(uuid, text)');

  if v_oid is null then
    raise exception
      'VERIFICATION FAILED 5: request_consultant_payout(uuid, text) does not exist';
  end if;

  select p.prosecdef,
         coalesce(array_to_string(p.proconfig, ', '), '(none)')
    into v_secdef, v_config
    from pg_proc p where p.oid = v_oid;

  if not v_secdef then
    raise exception
      'VERIFICATION FAILED 6: request_consultant_payout is not SECURITY DEFINER';
  end if;

  if v_config is distinct from 'search_path=pg_catalog, public' then
    raise exception
      'VERIFICATION FAILED 6: request_consultant_payout has search_path %',
      v_config;
  end if;

  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 6: request_consultant_payout is client-callable; a recreated function loses its ACL and Supabase grants it straight back';
  end if;

  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception
      'VERIFICATION FAILED 6: service_role lost EXECUTE on request_consultant_payout';
  end if;

  raise notice
    'PASS 5 and 6: the destination argument is gone, and the replaced RPC is SECURITY DEFINER, pinned and service_role only';
end $$;


-- Check 7.

do $$
declare
  v_paypal text;
  v_wise text;
begin
  v_paypal := public.build_payout_destination_note(
    'paypal', 'consultant@example.com');
  v_wise := public.build_payout_destination_note(
    'wise', 'consultant@example.com');

  if v_paypal is distinct from 'PayPal | consultant@example.com' then
    raise exception
      'VERIFICATION FAILED 7: paypal formatted as [%]', v_paypal;
  end if;

  if v_wise is distinct from 'Wise | consultant@example.com' then
    raise exception
      'VERIFICATION FAILED 7: wise formatted as [%]', v_wise;
  end if;

  /* Case and padding from a select box must still resolve. */
  if public.build_payout_destination_note(
       '  PayPal  ', '  consultant@example.com  ')
     is distinct from 'PayPal | consultant@example.com' then
    raise exception
      'VERIFICATION FAILED 7: a padded, capitalised method did not normalise';
  end if;

  /* Everything incomplete is null, which is the payable test. */
  if public.build_payout_destination_note(
       'venmo', 'consultant@example.com') is not null
     or public.build_payout_destination_note('paypal', '') is not null
     or public.build_payout_destination_note('paypal', '   ') is not null
     or public.build_payout_destination_note('paypal', null) is not null
     or public.build_payout_destination_note(null, 'a@b.com') is not null
     or public.build_payout_destination_note(null, null) is not null then
    raise exception
      'VERIFICATION FAILED 7: an incomplete destination produced a non-null note';
  end if;

  raise notice
    'PASS 7: both methods format exactly, and every incomplete destination is null';
end $$;


-- Check 8 — the private field is private.
--
-- Two separate claims. First, that consultants — the projection
-- every client and anonymous visitor reads to choose who to book
-- — has acquired no payout column. Second, that no relation
-- anywhere in public that anon can read exposes one.

do $$
declare
  v_leak text;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'consultants'
       and column_name in (
         'payout_email', 'payout_method', 'payout_settings')
  ) then
    raise exception
      'VERIFICATION FAILED 8: a payout column was added to public.consultants, which anon and every client can read';
  end if;

  select string_agg(
           c.table_name || '.' || c.column_name, ', ')
    into v_leak
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
   where c.table_schema = 'public'
     and c.column_name in ('payout_email', 'payout_method')
     and has_column_privilege(
           'anon',
           format('%I.%I', c.table_schema, c.table_name)::regclass,
           c.column_name, 'SELECT');

  if v_leak is not null then
    raise exception
      'VERIFICATION FAILED 8: anon can select payout column(s): %',
      v_leak;
  end if;

  /*
   * authenticated may reach exactly one relation carrying these
   * columns, and it is the RLS-protected settings table itself.
   * Anything else would be a projection that hands one
   * consultant's payout email to another.
   */
  select string_agg(
           c.table_name || '.' || c.column_name, ', ')
    into v_leak
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.column_name in ('payout_email', 'payout_method')
     and c.table_name <> 'consultant_payout_settings'
     and has_column_privilege(
           'authenticated',
           format('%I.%I', c.table_schema, c.table_name)::regclass,
           c.column_name, 'SELECT');

  if v_leak is not null then
    raise exception
      'VERIFICATION FAILED 8: authenticated can select payout column(s) outside the settings table: %',
      v_leak;
  end if;

  raise notice
    'PASS 8: no payout column on consultants, none readable by anon, and none reachable by authenticated outside the RLS-protected table';
end $$;


-- Check 9 — migrations 034 to 038 are intact.

do $$
declare
  v_tables integer;
  v_fn regprocedure;
  v_names text[] := array[
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_ledger_entry',
    'reverse_consultation_earning',
    'create_ledger_adjustment',
    'decide_payout',
    'mark_payout_paid'
  ];
  v_checked integer := 0;
begin
  select count(*) into v_tables
    from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE';

  if v_tables <> 21 then
    raise exception
      'VERIFICATION FAILED 9: % base tables in public, expected 21 (20 plus consultant_payout_settings)',
      v_tables;
  end if;

  /*
   * The other seven finance RPCs must be exactly as migration 036
   * left them. This migration replaced one of the eight; if it
   * disturbed another's reachability that is a regression, not a
   * side effect.
   */
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    if has_function_privilege('anon', v_fn::oid, 'EXECUTE')
       or has_function_privilege(
            'authenticated', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 9: % became client-callable', v_fn;
    end if;

    if not has_function_privilege(
         'service_role', v_fn::oid, 'EXECUTE') then
      raise exception
        'VERIFICATION FAILED 9: service_role lost EXECUTE on %', v_fn;
    end if;

    v_checked := v_checked + 1;
  end loop;

  if v_checked <> array_length(v_names, 1) then
    raise exception
      'VERIFICATION FAILED 9: found % of % untouched finance RPCs',
      v_checked, array_length(v_names, 1);
  end if;

  if to_regprocedure(
       'public.get_admin_finance_kpis(timestamptz, timestamptz)'
     ) is null then
    raise exception
      'VERIFICATION FAILED 9: migration 038''s get_admin_finance_kpis disappeared';
  end if;

  raise notice
    'PASS 9: 21 base tables, the other seven finance RPCs untouched, migration 038 intact';
end $$;


-- ============================================================
-- PART 2 — WHO MAY READ AND WRITE IT (STAGING ONLY, rolls back)
-- ============================================================

begin;

do $$
declare
  v_apr uuid := gen_random_uuid();
  v_cpr uuid := gen_random_uuid();
  v_opr uuid := gen_random_uuid();
  v_clp uuid := gen_random_uuid();
  v_con uuid;
  v_oth uuid;
begin
  insert into auth.users (id, email) values
    (v_apr, 'v39-admin@verification.invalid'),
    (v_cpr, 'v39-consultant@verification.invalid'),
    (v_opr, 'v39-other@verification.invalid'),
    (v_clp, 'v39-client@verification.invalid');

  insert into public.profiles (id, role, full_name, email) values
    (v_apr, 'admin', 'V39 Admin',
     'v39-admin@verification.invalid'),
    (v_cpr, 'consultant', 'V39 Consultant',
     'v39-consultant@verification.invalid'),
    (v_opr, 'consultant', 'V39 Other',
     'v39-other@verification.invalid'),
    (v_clp, 'client', 'V39 Client',
     'v39-client@verification.invalid')
  on conflict (id) do update set role = excluded.role;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_cpr, 'Africa/Cairo', true) returning id into v_con;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_opr, 'Africa/Cairo', true) returning id into v_oth;

  /* The other consultant has a setting; ours starts with none. */
  insert into public.consultant_payout_settings (
    consultant_id, payout_method, payout_email)
  values (v_oth, 'wise', 'other@verification.invalid');

  perform set_config('app.v39_admin', v_apr::text, true);
  perform set_config('app.v39_consultant', v_cpr::text, true);
  perform set_config('app.v39_other', v_opr::text, true);
  perform set_config('app.v39_client', v_clp::text, true);
  perform set_config('app.v39_con', v_con::text, true);
  perform set_config('app.v39_oth', v_oth::text, true);
end $$;


-- Checks 15, 16, 17, 18, 19 and 20 — the consultant writing
-- their own setting, which is what the profile screen does.

do $$
declare
  v_method text;
  v_email text;
  v_created timestamptz;
  v_updated timestamptz;
  v_refused integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v39_consultant'), true);

  /* Check 15 — the first save, PayPal. */
  insert into public.consultant_payout_settings (
    consultant_id, payout_method, payout_email)
  values (
    current_setting('app.v39_con')::uuid,
    'PayPal',
    '  consultant@verification.invalid  ');

  select payout_method, payout_email, created_at
    into v_method, v_email, v_created
    from public.consultant_payout_settings
   where consultant_id = current_setting('app.v39_con')::uuid;

  if v_method <> 'paypal'
     or v_email <> 'consultant@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 15: saved as [% / %]; expected paypal and the trimmed address',
      v_method, v_email;
  end if;

  /* Check 16 — switching to Wise. */
  update public.consultant_payout_settings
     set payout_method = 'wise',
         payout_email = 'consultant-wise@verification.invalid'
   where consultant_id = current_setting('app.v39_con')::uuid;

  select payout_method, payout_email, updated_at
    into v_method, v_email, v_updated
    from public.consultant_payout_settings
   where consultant_id = current_setting('app.v39_con')::uuid;

  if v_method <> 'wise'
     or v_email <> 'consultant-wise@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 16: saved as [% / %]; expected wise', v_method, v_email;
  end if;

  if v_updated < v_created then
    raise exception
      'VERIFICATION FAILED 16: updated_at did not advance on save';
  end if;

  /* Check 17 — an unsupported service. */
  begin
    update public.consultant_payout_settings
       set payout_method = 'venmo'
     where consultant_id = current_setting('app.v39_con')::uuid;
    raise exception
      'VERIFICATION FAILED 17: payout_method venmo was accepted';
  exception when check_violation then
    v_refused := v_refused + 1;
  end;

  /* Check 18 — a method with nowhere to send the money. */
  begin
    update public.consultant_payout_settings
       set payout_method = 'paypal', payout_email = null
     where consultant_id = current_setting('app.v39_con')::uuid;
    raise exception
      'VERIFICATION FAILED 18: a payout method with no email was accepted';
  exception when check_violation then
    v_refused := v_refused + 1;
  end;

  /* Check 19 — a cleared field is whitespace, not null. */
  begin
    update public.consultant_payout_settings
       set payout_method = 'paypal', payout_email = '   '
     where consultant_id = current_setting('app.v39_con')::uuid;
    raise exception
      'VERIFICATION FAILED 19: a whitespace-only email was accepted';
  exception when check_violation then
    v_refused := v_refused + 1;
  end;

  /* Check 19 — and a malformed one. */
  begin
    update public.consultant_payout_settings
       set payout_email = 'not-an-address'
     where consultant_id = current_setting('app.v39_con')::uuid;
    raise exception
      'VERIFICATION FAILED 19: a malformed email was accepted';
  exception when check_violation then
    v_refused := v_refused + 1;
  end;

  /* Check 20 — no delete path at all. */
  begin
    delete from public.consultant_payout_settings
     where consultant_id = current_setting('app.v39_con')::uuid;
    raise exception
      'VERIFICATION FAILED 20: a consultant deleted their settings row';
  exception when insufficient_privilege then
    v_refused := v_refused + 1;
  end;

  reset role;

  if v_refused <> 5 then
    raise exception
      'VERIFICATION FAILED 17-20: only % of 5 invalid writes were refused',
      v_refused;
  end if;

  raise notice
    'PASS 15-20: PayPal and Wise both save and normalise; an unknown method, a missing email, a blank email, a malformed email and a DELETE are all refused';
end $$;


-- Checks 10, 11 and 20's forged-id sibling (check 20 in the map
-- covers DELETE; this covers writing as somebody else).

do $$
declare
  v_own integer;
  v_all integer;
  v_forged boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v39_consultant'), true);

  select count(*) into v_all
    from public.consultant_payout_settings;

  select count(*) into v_own
    from public.consultant_payout_settings
   where consultant_id = current_setting('app.v39_con')::uuid;

  if v_own <> 1 then
    raise exception
      'VERIFICATION FAILED 10: the consultant sees % of their own settings rows, expected 1',
      v_own;
  end if;

  /* Check 11 — the other consultant's row exists and is invisible. */
  if v_all <> 1 then
    raise exception
      'VERIFICATION FAILED 11: the consultant sees % settings rows in total; another consultant''s payout email is visible',
      v_all;
  end if;

  /*
   * Naming another consultant's id explicitly. The INSERT policy
   * compares the row against my_consultant_id(), so the supplied
   * value is not merely distrusted, it is overruled.
   */
  begin
    insert into public.consultant_payout_settings (
      consultant_id, payout_method, payout_email)
    values (
      current_setting('app.v39_oth')::uuid,
      'paypal',
      'attacker@verification.invalid')
    on conflict (consultant_id) do update
      set payout_email = excluded.payout_email;
  exception when insufficient_privilege or unique_violation then
    v_forged := true;
  end;

  reset role;

  if not v_forged then
    raise exception
      'VERIFICATION FAILED 20: a consultant wrote a payout row naming another consultant''s id';
  end if;

  if (
    select payout_email from public.consultant_payout_settings
     where consultant_id = current_setting('app.v39_oth')::uuid
  ) <> 'other@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 20: another consultant''s payout email was overwritten';
  end if;

  raise notice
    'PASS 10, 11 and 20: a consultant reads only their own row and cannot write anybody else''s, even naming the id';
end $$;


-- Check 12 — an admin reads every consultant's setting, which is
-- what "Current payout method" on the finance detail screen is.

do $$
declare
  v_all integer;
  v_email text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v39_admin'), true);

  select count(*) into v_all
    from public.consultant_payout_settings;

  select payout_email into v_email
    from public.consultant_payout_settings
   where consultant_id = current_setting('app.v39_oth')::uuid;

  reset role;

  if v_all <> 2 then
    raise exception
      'VERIFICATION FAILED 12: the admin sees % settings rows, expected 2',
      v_all;
  end if;

  if v_email <> 'other@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 12: the admin read [%] for the other consultant',
      v_email;
  end if;

  raise notice
    'PASS 12: an admin reads every consultant''s current payout method';
end $$;


-- Checks 13 and 14 — a client and an anonymous visitor.

do $$
declare
  v_client integer;
  v_anon_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
    current_setting('app.v39_client'), true);

  select count(*) into v_client
    from public.consultant_payout_settings;

  reset role;

  if v_client <> 0 then
    raise exception
      'VERIFICATION FAILED 13: a client sees % payout settings rows',
      v_client;
  end if;

  set local role anon;

  begin
    perform 1 from public.consultant_payout_settings;
  exception when insufficient_privilege then
    v_anon_denied := true;
  end;

  reset role;

  if not v_anon_denied then
    raise exception
      'VERIFICATION FAILED 14: anon could read consultant_payout_settings';
  end if;

  raise notice
    'PASS 13 and 14: a client sees nothing and anon is refused at the privilege layer';
end $$;


-- ============================================================
-- PART 3 — THE PAYOUT SNAPSHOT (STAGING ONLY, rolls back)
-- ============================================================

-- Fixtures: available earnings for both consultants, so a payout
-- request has something to reserve.

do $$
begin
  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at)
  values
    (current_setting('app.v39_con')::uuid, 'earning', 'consultation',
     gen_random_uuid(), 15000, 7500, 7500, 5000, 'standard_50_50',
     'usd', now()),
    (current_setting('app.v39_oth')::uuid, 'earning', 'consultation',
     gen_random_uuid(), 20000, 10000, 10000, 5000, 'standard_50_50',
     'usd', now());
end $$;


-- Checks 22 and 23 — a payout with nowhere to go is refused.

do $$
declare
  v_third_profile uuid := gen_random_uuid();
  v_third uuid;
  v_refused integer := 0;
begin
  insert into auth.users (id, email)
  values (v_third_profile, 'v39-third@verification.invalid');

  /* public.handle_new_user() already created this row from the
     auth.users insert above, so this is an upsert rather than an
     insert - the trigger is real and fires in staging. */
  insert into public.profiles (id, role, full_name, email)
  values (v_third_profile, 'consultant', 'V39 Third',
          'v39-third@verification.invalid')
  on conflict (id) do update
    set role = excluded.role,
        full_name = excluded.full_name;

  insert into public.consultants (profile_id, timezone, is_active)
  values (v_third_profile, 'Africa/Cairo', true)
  returning id into v_third;

  insert into public.consultant_ledger_entries (
    consultant_id, entry_type, source_type, source_id,
    gross_amount_minor, consultant_amount_minor,
    platform_amount_minor, commission_bps, commission_basis,
    currency, available_at)
  values (v_third, 'earning', 'consultation', gen_random_uuid(),
    30000, 15000, 15000, 5000, 'standard_50_50', 'usd', now());

  /* Check 22 — no settings row at all. */
  begin
    perform 1 from public.request_consultant_payout(v_third, 'usd');
    raise exception
      'VERIFICATION FAILED 22: a consultant with no payout method opened a payout request';
  exception when raise_exception then
    if sqlerrm not like '%FINANCE_PAYOUT_METHOD_MISSING%' then
      raise;
    end if;
    v_refused := v_refused + 1;
  end;

  /* Check 23 — a row exists but the method was never chosen. */
  insert into public.consultant_payout_settings (
    consultant_id, payout_email)
  values (v_third, 'third@verification.invalid');

  begin
    perform 1 from public.request_consultant_payout(v_third, 'usd');
    raise exception
      'VERIFICATION FAILED 23: an incomplete payout setting opened a payout request';
  exception when raise_exception then
    if sqlerrm not like '%FINANCE_PAYOUT_METHOD_MISSING%' then
      raise;
    end if;
    v_refused := v_refused + 1;
  end;

  if v_refused <> 2 then
    raise exception
      'VERIFICATION FAILED 22/23: only % of 2 unpayable requests were refused',
      v_refused;
  end if;

  /* Nothing may have been half-created by either refusal. */
  if exists (select 1 from public.payouts where consultant_id = v_third) then
    raise exception
      'VERIFICATION FAILED 22/23: a refused request still created a payout row';
  end if;

  if exists (
    select 1 from public.payout_allocations a
     join public.consultant_ledger_entries e
       on e.id = a.ledger_entry_id
    where e.consultant_id = v_third
  ) then
    raise exception
      'VERIFICATION FAILED 22/23: a refused request still reserved an earning';
  end if;

  raise notice
    'PASS 22 and 23: a missing and an incomplete payout method are both refused, and neither reserves anything';
end $$;


-- Checks 24, 25 and 26 — the snapshot, and its permanence.

do $$
declare
  v_note text;
  v_payout_id uuid;
  v_after text;
begin
  /* Check 25 — Wise, on the consultant who already has one. */
  select p.destination_note into v_note
    from public.request_consultant_payout(
      current_setting('app.v39_oth')::uuid, 'usd') p;

  if v_note <> 'Wise | other@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 25: the Wise destination snapshotted as [%]',
      v_note;
  end if;

  /* Check 24 — PayPal, on ours. It is currently set to wise from
     Part 2, so set it back to PayPal first. */
  update public.consultant_payout_settings
     set payout_method = 'paypal',
         payout_email = 'consultant@verification.invalid'
   where consultant_id = current_setting('app.v39_con')::uuid;

  select p.payout_id, p.destination_note
    into v_payout_id, v_note
    from public.request_consultant_payout(
      current_setting('app.v39_con')::uuid, 'usd') p;

  if v_note <> 'PayPal | consultant@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 24: the PayPal destination snapshotted as [%]',
      v_note;
  end if;

  /* The row itself, not just the returned value. */
  select destination_note into v_after
    from public.payouts where id = v_payout_id;

  if v_after <> 'PayPal | consultant@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 24: payouts.destination_note holds [%]', v_after;
  end if;

  /*
   * Check 26 — the whole point. The consultant changes their mind
   * and their address after requesting. The payout they already
   * requested must still say where the money was actually going.
   */
  update public.consultant_payout_settings
     set payout_method = 'wise',
         payout_email = 'changed@verification.invalid'
   where consultant_id = current_setting('app.v39_con')::uuid;

  select destination_note into v_after
    from public.payouts where id = v_payout_id;

  if v_after <> 'PayPal | consultant@verification.invalid' then
    raise exception
      'VERIFICATION FAILED 26: changing the setting rewrote an existing payout destination to [%]',
      v_after;
  end if;

  raise notice
    'PASS 24, 25 and 26: both destinations snapshot exactly, and a later profile change cannot rewrite payout history';
end $$;


-- Check 27 — the mark-paid workflow is untouched.
--
-- Asserted at the signature, because this migration's claim is
-- that it did not go near it. What an admin records — amount,
-- date, external reference, note — is the same set of arguments
-- migration 035 defined.

do $$
declare
  v_args text;
begin
  select coalesce(string_agg(
           format_type(t.typ, null), ', ' order by t.ord), '(none)')
    into v_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(p.proargtypes) with ordinality
      as t(typ, ord)
   where n.nspname = 'public'
     and p.proname = 'mark_payout_paid';

  if v_args <> 'uuid, integer, text, uuid, timestamp with time zone, text' then
    raise exception
      'VERIFICATION FAILED 27: mark_payout_paid takes [%]; the mark-paid workflow was changed',
      v_args;
  end if;

  raise notice
    'PASS 27: mark_payout_paid still takes amount, reference, admin, date and note — unchanged';
end $$;

rollback;


-- Check 28 — the fixtures are gone.

do $$
declare
  v_left integer;
  v_settings integer;
begin
  select count(*) into v_left
    from public.profiles
   where email like 'v39-%@verification.invalid';

  select count(*) into v_settings
    from public.consultant_payout_settings
   where payout_email like '%@verification.invalid';

  if v_left <> 0 or v_settings <> 0 then
    raise exception
      'VERIFICATION FAILED 28: % profile(s) and % settings row(s) survived the rollback',
      v_left, v_settings;
  end if;

  raise notice 'PASS 28: every fixture rolled back';
end $$;


-- ============================================================
-- PART 4 — ROLLBACK GUIDANCE
-- ============================================================
--
-- Rolling this back has one consequence that is not obvious, so
-- it is stated first: restoring the old three-argument
-- request_consultant_payout brings back a caller-supplied
-- destination. Payouts created in the meantime keep their
-- snapshots — destination_note is an ordinary column and nothing
-- here rewrites it — but new requests would once again accept
-- whatever note the caller sent, and the orchestrator no longer
-- sends one, so they would be created with a null destination.
-- Roll the orchestrator back with it.
--
--   -- 1. restore the previous RPC from migration 037 part G,
--   --    verbatim, then:
--   drop function if exists public.request_consultant_payout(uuid, text);
--   revoke all on function public.request_consultant_payout(
--     uuid, text, text) from public, anon, authenticated;
--   grant execute on function public.request_consultant_payout(
--     uuid, text, text) to service_role;
--
--   -- 2. the setting itself. This DESTROYS every consultant's
--   --    saved payout destination; they would each have to enter
--   --    it again. Existing payout snapshots are unaffected.
--   drop table if exists public.consultant_payout_settings;
--   drop function if exists public.build_payout_destination_note(
--     text, text);
--   drop function if exists
--     public.normalize_consultant_payout_settings();
--
-- Nothing else needs undoing: no existing table, column,
-- constraint, trigger, policy or grant was changed, no ledger row
-- was written, and no commission, payout status rule or mark-paid
-- behaviour was touched.
-- ============================================================

do $$
begin
  raise notice
    'migration 039 verification complete: no check raised';
end $$;
