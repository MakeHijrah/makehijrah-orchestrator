-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 036: RPC execution hardening
-- ============================================================
--
-- Classification:
-- - Security patch. No behaviour change, no schema change, no
--   policy change, no function body change.
--
-- The problem this solves:
-- - Supabase issues ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
--   FUNCTIONS TO anon, authenticated. A grant held BY NAME is not
--   removed by REVOKE ... FROM PUBLIC, so the older convention of
--   revoking only from PUBLIC left orchestrator-only RPCs
--   executable with an anon key. Migration 035 hit this while
--   hardening the finance functions; this migration applies the
--   same treatment to everything that predates it.
-- - Five functions were exposed to both anon and authenticated:
--
--     process_stripe_webhook_event        the worst of them: it
--       transitions a consultation's payment state and writes the
--       payments ledger. Reachable with a publishable anon key,
--       it lets anyone move a consultation to captured, refunded
--       or authorization_cancelled without Stripe involved.
--     complete_consultation               marks a consultation
--       completed, which is half of what releases a consultant
--       earning.
--     finalize_consultation_acceptance    confirms a booking.
--     finalize_consultation_decline       declines one.
--     finalize_authorization_timeout      cancels an authorized
--       payment.
--
-- What this migration does:
--   A. Revokes EXECUTE from PUBLIC, anon and authenticated on
--      every orchestrator-only RPC, and re-grants service_role.
--   B. Revokes the same on every trigger function.
--   C. Revokes anon's EXECUTE on the RLS helpers no anon policy
--      uses. authenticated keeps them.
--
-- What this migration deliberately does NOT touch, and why:
-- - is_admin() keeps EXECUTE for BOTH anon and authenticated.
--   29 policies call it and countries_select_active_public is
--   `to anon, authenticated`, so anon genuinely needs it. This
--   was verified against PostgreSQL 16 rather than assumed: with
--   EXECUTE revoked, a policy read that reaches is_admin() fails
--   with insufficient_privilege. Revoking it would break RLS for
--   the public booking surface.
-- - is_privileged_writer() keeps EXECUTE for authenticated. The
--   column guards on profiles, consultants and messages call it
--   in their trigger bodies as the invoking user, and revoking it
--   makes every authenticated UPDATE on those tables fail. Also
--   verified rather than assumed. It returns a boolean about the
--   caller's own role and leaks nothing.
-- - get_my_role() keeps EXECUTE for authenticated. No policy
--   calls it, but it returns only the caller's own role, so
--   revoking it buys no security while risking a frontend that
--   may read it. Removing access nobody asked to remove would be
--   a behaviour change, which this migration is not for.
-- - get_direct_message_admin() and
--   get_direct_message_admin_contact() keep EXECUTE for
--   authenticated. Migrations 024 and 031 granted it
--   deliberately: they are the supported client-callable
--   resolvers, and both already revoke anon.
-- - The eight finance functions are already correct (migration
--   035). They are re-asserted here so one file states the whole
--   intent, and the verification proves no regression.
--
-- Why the revokes are written as a loop over pg_proc rather than
-- as typed-out signatures:
-- - REVOKE requires an exact signature, and a signature typed by
--   hand that does not match leaves the function exposed while
--   the migration reports success. Resolving oid::regprocedure
--   produces the exact signature PostgreSQL itself records, and
--   covers every overload of a name rather than the one overload
--   somebody remembered.
--
-- Rerun safety:
-- - Idempotent. REVOKE and GRANT are declarative, and the loops
--   skip a name that does not exist.
-- ============================================================

begin;

-- ------------------------------------------------------- guard ----
--
-- Every name below must exist. A typo would otherwise revoke
-- nothing and pass silently, which is the exact failure mode this
-- migration exists to correct.

do $$
declare
  v_name text;
  v_missing text[] := '{}';
  v_expected text[] := array[
    -- orchestrator-only RPCs
    'process_stripe_webhook_event',
    'create_draft_consultation',
    'finalize_consultation_acceptance',
    'finalize_consultation_decline',
    'complete_consultation',
    'redeem_consultant_invite',
    'finalize_authorization_timeout',
    'finalize_admin_consultation_cancel',
    'save_consultant_profile',
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_ledger_entry',
    'reverse_consultation_earning',
    'create_ledger_adjustment',
    'request_consultant_payout',
    'decide_payout',
    'mark_payout_paid',
    -- trigger functions
    'set_updated_at',
    'handle_new_user',
    'guard_profiles_columns',
    'guard_consultants_columns',
    'guard_messages_columns',
    'enforce_service_recommendation_limit',
    'enforce_single_active_consultant_invite',
    'enforce_direct_message_pairing',
    'normalize_country_tagline',
    'enforce_ledger_append_only',
    'enforce_payout_allocation',
    -- RLS helpers
    'is_admin',
    'my_consultant_id',
    'get_my_role',
    'is_consultation_participant',
    'can_view_consultation',
    'can_note_consultation',
    'can_recommend_for_consultation',
    'can_view_payout',
    'is_privileged_writer'
  ];
begin
  foreach v_name in array v_expected
  loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    ) then
      v_missing := v_missing || v_name;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'migration 036: expected function(s) not found: %',
      array_to_string(v_missing, ', ');
  end if;
end;
$$;


-- ============================================================
-- A. Orchestrator-only RPCs
-- ============================================================
--
-- Called by the orchestrator with the service role, always after
-- it has established who the caller is and whether they may act.
-- None is part of any client's API surface: every one of them has
-- an HTTP endpoint in front of it that does the authorisation.
--
-- Nine of these predate migration 035. Five were reachable by
-- anon; four were already correct because their migrations
-- revoked anon and authenticated by name. The eight finance
-- functions are re-asserted from migration 035 so this file
-- states the complete intent in one place.

do $$
declare
  v_fn regprocedure;
  v_names text[] := array[
    'process_stripe_webhook_event',
    'create_draft_consultation',
    'finalize_consultation_acceptance',
    'finalize_consultation_decline',
    'complete_consultation',
    'redeem_consultant_invite',
    'finalize_authorization_timeout',
    'finalize_admin_consultation_cancel',
    'save_consultant_profile',
    'record_consultation_earning',
    'release_consultation_earning',
    'reverse_ledger_entry',
    'reverse_consultation_earning',
    'create_ledger_adjustment',
    'request_consultant_payout',
    'decide_payout',
    'mark_payout_paid'
  ];
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_fn
    );

    execute format(
      'grant execute on function %s to service_role',
      v_fn
    );
  end loop;
end;
$$;


-- ============================================================
-- B. Trigger functions
-- ============================================================
--
-- None of these is an API surface. Firing a trigger does not
-- consult EXECUTE privilege on its function — verified against
-- PostgreSQL 16 by revoking set_updated_at and
-- guard_profiles_columns and confirming an authenticated UPDATE
-- still succeeded — so revoking costs nothing and removes a
-- direct call path that should never have existed.
--
-- No grant to service_role: the triggers fire regardless of who
-- writes the row, and nothing calls these directly.

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_fn
    );
  end loop;
end;
$$;


-- ============================================================
-- C. RLS helpers
-- ============================================================
--
-- SECURITY DEFINER helpers that RLS policies call. The role a
-- policy targets MUST keep EXECUTE or the policy fails closed
-- with insufficient_privilege instead of filtering, so these are
-- narrowed rather than removed.
--
-- Exactly one is referenced by a policy targeting anon: is_admin(),
-- through countries_select_active_public. Everything else appears
-- only in policies `to authenticated`, so anon's access is surplus.
--
-- Revoking from anon is not enough on its own. CREATE FUNCTION
-- grants EXECUTE to PUBLIC, anon is a member of PUBLIC, and a
-- REVOKE aimed at anon leaves the PUBLIC grant standing — the
-- mirror image of the bug this whole migration is about. So
-- PUBLIC goes first and every role that genuinely needs the
-- function is then granted BY NAME, which is the only form that
-- survives a later default-privilege change.
--
-- service_role is granted throughout. It bypasses RLS and so
-- never needs these, but a SECURITY DEFINER function added later
-- might call one, and a missing grant would surface as a
-- confusing runtime failure rather than as an intent.

do $$
declare
  v_fn regprocedure;
  /* Needed by a policy that targets anon. */
  v_anon_names text[] := array['is_admin'];
  /* Needed by authenticated only. */
  v_authed_names text[] := array[
    'my_consultant_id',
    'get_my_role',
    'is_consultation_participant',
    'can_view_consultation',
    'can_note_consultation',
    'can_recommend_for_consultation',
    'can_view_payout',
    'is_privileged_writer'
  ];
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_anon_names)
  loop
    execute format(
      'revoke all on function %s from public', v_fn
    );
    execute format(
      'grant execute on function %s to anon, authenticated, service_role',
      v_fn
    );
  end loop;

  for v_fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_authed_names)
  loop
    execute format(
      'revoke all on function %s from public, anon', v_fn
    );
    execute format(
      'grant execute on function %s to authenticated, service_role',
      v_fn
    );
  end loop;
end;
$$;

commit;

-- ------------------------------------------------------------ verification ----
-- Read-only. Run after applying. See
-- MIGRATION_036_VERIFICATION.sql for the full self-contained suite.
--
--  1. select count(*) from pg_proc p
--      join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and has_function_privilege('anon', p.oid, 'EXECUTE')
--       and p.proname <> 'is_admin';
--       -> 0
--
--  2. select has_function_privilege(
--       'service_role', 'public.process_stripe_webhook_event(
--         text, text, text, uuid, integer, text, text, jsonb,
--         consultation_status, timestamptz, timestamptz,
--         timestamptz)', 'EXECUTE');
--       -> true
--
--  3. select has_function_privilege(
--       'authenticated', 'public.is_admin()', 'EXECUTE');
--       -> true  (29 policies depend on it)
