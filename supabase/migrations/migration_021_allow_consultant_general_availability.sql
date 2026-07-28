-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 021: Allow consultants to manage general availability
-- ============================================================
--
-- Purpose:
-- - Permit a consultant to enable or disable available_for_general
--   on their own consultant row.
--
-- Product decision:
-- - available_for_general is no longer admin-only. It becomes a
--   consultant-controlled setting on their own profile.
--
-- Unchanged security posture:
-- - Consultants may still update only their own row. Row scoping
--   is enforced by the existing RLS policy:
--     using       ((profile_id = auth.uid()) or is_admin())
--     with check  ((profile_id = auth.uid()) or is_admin())
-- - is_active remains protected from non-privileged writers.
-- - profile_id remains protected from non-privileged writers.
-- - Privileged writers continue to bypass both checks through the
--   existing is_privileged_writer() logic, so service_role and
--   admin behaviour is unaffected.
--
-- Scope:
-- - This migration replaces the guard function body only.
-- - No RLS policy, grant, table, column, constraint, or trigger
--   binding is altered. The existing trg_guard_consultants trigger
--   continues to reference this function and is left in place.
-- - The function header intentionally states no security mode,
--   search_path, volatility, parallel, cost, or leakproof clause.
--   The live function relies on the PostgreSQL defaults for all of
--   them (security invoker, volatile, parallel unsafe, cost 100).
--   Leaving them unstated preserves those defaults exactly. Do not
--   add any of them here without a separately approved reason.
-- ============================================================

begin;

create or replace function public.guard_consultants_columns()
returns trigger
language plpgsql
as $$
begin
  /*
   * Privileged writers (service_role and admin) retain full
   * control over every column.
   */
  if not public.is_privileged_writer() then
    /*
     * Activation remains an administrative decision. A consultant
     * may not activate or deactivate their own profile.
     */
    if new.is_active is distinct from old.is_active then
      raise exception
        'consultants.is_active may not be changed by clients';
    end if;

    /*
     * Row ownership may never be reassigned by a client, otherwise
     * a consultant could point their row at another profile.
     */
    if new.profile_id is distinct from old.profile_id then
      raise exception
        'consultants.profile_id may not be changed by clients';
    end if;

    /*
     * available_for_general is intentionally no longer guarded.
     * Consultants control their own general availability, still
     * confined to their own row by the RLS policy above.
     */
  end if;

  return new;
end;
$$;

commit;
