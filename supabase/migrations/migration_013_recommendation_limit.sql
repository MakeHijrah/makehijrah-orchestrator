-- ============================================================
-- MakeHijrah Relocation OS
-- Migration 013: Enforce recommendation limit
-- ============================================================

create or replace function public.enforce_service_recommendation_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recommendation_count integer;
begin
  /*
   * Consultants may create no more than three recommendations
   * for a single consultation.
   *
   * Sent recommendations remain part of the consultation's
   * three-recommendation allowance.
   */
  select count(*)
  into v_recommendation_count
  from public.service_recommendations
  where consultation_id = new.consultation_id;

  if v_recommendation_count >= 3 then
    raise exception
      using
        errcode = 'P0001',
        message = 'Maximum 3 recommendations per consultation';
  end if;

  return new;
end;
$$;

drop trigger if exists
  enforce_service_recommendation_limit
on public.service_recommendations;

create trigger
  enforce_service_recommendation_limit
before insert
on public.service_recommendations
for each row
execute function
  public.enforce_service_recommendation_limit();

revoke all
on function public.enforce_service_recommendation_limit()
from public;

grant execute
on function public.enforce_service_recommendation_limit()
to service_role;
