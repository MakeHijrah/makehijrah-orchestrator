-- ============================================================
-- MakeHijrah Relocation OS — Migration 002: RLS (FROZEN v1.0)
-- Source of truth: RLS_POLICY_PLAN.md
-- Run AFTER migration_001_schema.sql.
-- Default deny: RLS enabled on ALL 15 tables; only the policies
-- below grant access. Service role bypasses everything.
-- ============================================================

-- ---------- Helper functions (security definer; never recursive) ----------
-- NOTE: named get_my_role, not current_role — current_role is a reserved
-- SQL keyword and cannot be used as a function name. (Deviation from the
-- RLS plan's illustrative name only; behavior identical.)

create or replace function public.get_my_role()
returns user_role language sql stable security definer
set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_consultant_id()
returns uuid language sql stable security definer
set search_path = public as $$
  select c.id from consultants c where c.profile_id = auth.uid();
$$;

-- participant check: profile is the client or the assigned consultant of the consultation
create or replace function public.is_consultation_participant(p_consultation_id uuid, p_profile_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1
    from consultations con
    left join consultants c on c.id = con.consultant_id
    where con.id = p_consultation_id
      and (con.client_profile_id = p_profile_id or c.profile_id = p_profile_id)
  );
$$;

-- notes window: assigned consultant + status confirmed/captured/completed
create or replace function public.can_note_consultation(p_consultation_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from consultations con
    where con.id = p_consultation_id
      and con.consultant_id = my_consultant_id()
      and con.status in ('confirmed', 'captured', 'completed')
  );
$$;

-- recommendation window: assigned consultant + status completed
create or replace function public.can_recommend_for_consultation(p_consultation_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from consultations con
    where con.id = p_consultation_id
      and con.consultant_id = my_consultant_id()
      and con.status = 'completed'
  );
$$;

-- consultation visibility for intake reads
create or replace function public.can_view_consultation(p_consultation_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from consultations con
    where con.id = p_consultation_id
      and (con.client_profile_id = auth.uid() or con.consultant_id = my_consultant_id())
  ) or is_admin();
$$;

-- ---------- Enable RLS everywhere ----------
alter table profiles enable row level security;
alter table consultants enable row level security;
alter table consultant_invites enable row level security;
alter table countries enable row level security;
alter table consultant_countries enable row level security;
alter table oauth_connections enable row level security;   -- ZERO policies. Total lockout.
alter table consultations enable row level security;
alter table consultation_intake enable row level security;
alter table consultation_notes enable row level security;
alter table services enable row level security;
alter table service_recommendations enable row level security;
alter table service_requests enable row level security;
alter table payments enable row level security;
alter table messages enable row level security;
alter table giveaways enable row level security;

-- ---------- profiles ----------
create policy profiles_select_own_or_admin on profiles
for select to authenticated
using (id = auth.uid() or is_admin());

create policy profiles_update_own on profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());
-- role/email protected by trg_guard_profiles (migration 001)

-- ---------- consultants ----------
create policy consultants_select_active_public on consultants
for select to anon, authenticated
using (is_active = true);

create policy consultants_select_own_or_admin on consultants
for select to authenticated
using (profile_id = auth.uid() or is_admin());

create policy consultants_update_own_or_admin on consultants
for update to authenticated
using (profile_id = auth.uid() or is_admin())
with check (profile_id = auth.uid() or is_admin());
-- is_active / available_for_general / profile_id protected by trg_guard_consultants

-- ---------- consultant_invites ----------
create policy invites_select_admin on consultant_invites
for select to authenticated
using (is_admin());
-- No insert/update/delete policies: orchestrator only.

-- ---------- countries ----------
create policy countries_select_active_public on countries
for select to anon, authenticated
using (is_active = true or is_admin());

create policy countries_insert_admin on countries
for insert to authenticated with check (is_admin());
create policy countries_update_admin on countries
for update to authenticated using (is_admin()) with check (is_admin());
create policy countries_delete_admin on countries
for delete to authenticated using (is_admin());

-- ---------- consultant_countries ----------
create policy cc_select_public on consultant_countries
for select to anon, authenticated
using (true);

create policy cc_insert_admin on consultant_countries
for insert to authenticated with check (is_admin());
create policy cc_delete_admin on consultant_countries
for delete to authenticated using (is_admin());

-- ---------- oauth_connections ----------
-- Intentionally NO policies. RLS on + zero policies = zero client access.

-- ---------- consultations ----------
create policy consultations_select_roles on consultations
for select to authenticated
using (
  client_profile_id = auth.uid()
  or consultant_id = my_consultant_id()
  or is_admin()
);
-- No insert/update/delete policies: ALL writes via orchestrator (service role).
-- This is the single most important rule in the system.

-- ---------- consultation_intake ----------
create policy intake_select_participants on consultation_intake
for select to authenticated
using (can_view_consultation(consultation_id));
-- No write policies: orchestrator writes during booking.

-- ---------- consultation_notes ----------
create policy notes_select_own_or_admin on consultation_notes
for select to authenticated
using (consultant_id = my_consultant_id() or is_admin());
-- Clients have NO access to notes.

create policy notes_insert_consultant on consultation_notes
for insert to authenticated
with check (
  consultant_id = my_consultant_id()
  and can_note_consultation(consultation_id)
);

create policy notes_update_own on consultation_notes
for update to authenticated
using (consultant_id = my_consultant_id())
with check (consultant_id = my_consultant_id());

-- ---------- services ----------
create policy services_select_active on services
for select to authenticated
using (is_active = true or is_admin());

create policy services_insert_admin on services
for insert to authenticated with check (is_admin());
create policy services_update_admin on services
for update to authenticated using (is_admin()) with check (is_admin());
create policy services_delete_admin on services
for delete to authenticated using (is_admin());

-- ---------- service_recommendations ----------
create policy recs_select_roles on service_recommendations
for select to authenticated
using (
  is_admin()
  or recommended_by_consultant_id = my_consultant_id()
  or (
    status = 'sent'
    and exists (
      select 1 from consultations con
      where con.id = consultation_id and con.client_profile_id = auth.uid()
    )
  )
);
-- The status='sent' clause is load-bearing: it is what makes admin review real.

create policy recs_insert_consultant on service_recommendations
for insert to authenticated
with check (
  recommended_by_consultant_id = my_consultant_id()
  and status = 'proposed'
  and can_recommend_for_consultation(consultation_id)
);

create policy recs_delete_own_proposed on service_recommendations
for delete to authenticated
using (
  recommended_by_consultant_id = my_consultant_id()
  and status = 'proposed'
);
-- No UPDATE policy: send action goes through orchestrator (triggers Resend email).

-- ---------- service_requests ----------
create policy sr_select_own_or_admin on service_requests
for select to authenticated
using (client_profile_id = auth.uid() or is_admin());

create policy sr_insert_admin on service_requests
for insert to authenticated with check (is_admin());
create policy sr_update_admin on service_requests
for update to authenticated using (is_admin()) with check (is_admin());
create policy sr_delete_admin on service_requests
for delete to authenticated using (is_admin());

-- ---------- payments ----------
create policy payments_select_admin on payments
for select to authenticated
using (is_admin());
-- No write policies: webhook/orchestrator only.

-- ---------- messages ----------
create policy messages_select_participants on messages
for select to authenticated
using (
  sender_profile_id = auth.uid()
  or recipient_profile_id = auth.uid()
  or is_admin()
);

create policy messages_insert_participant on messages
for insert to authenticated
with check (
  sender_profile_id = auth.uid()
  and recipient_profile_id <> auth.uid()
  and is_consultation_participant(consultation_id, auth.uid())
  and is_consultation_participant(consultation_id, recipient_profile_id)
);
-- No update/delete: messages are immutable in MVP.

-- ---------- giveaways ----------
create policy giveaways_select_active on giveaways
for select to authenticated
using (active = true or is_admin());

create policy giveaways_insert_admin on giveaways
for insert to authenticated with check (is_admin());
create policy giveaways_update_admin on giveaways
for update to authenticated using (is_admin()) with check (is_admin());
create policy giveaways_delete_admin on giveaways
for delete to authenticated using (is_admin());

-- ============================================================
-- Storage: single bucket public-media
-- ============================================================
insert into storage.buckets (id, name, public)
values ('public-media', 'public-media', true)
on conflict (id) do nothing;

create policy storage_public_read on storage.objects
for select to anon, authenticated
using (bucket_id = 'public-media');

create policy storage_upload_own_prefix on storage.objects
for insert to authenticated
with check (
  bucket_id = 'public-media'
  and (
    name like 'avatars/' || auth.uid()::text || '/%'
    or name like 'consultants/' || auth.uid()::text || '/%'
    or (name like 'giveaways/%' and is_admin())
  )
);

create policy storage_update_own_prefix on storage.objects
for update to authenticated
using (
  bucket_id = 'public-media'
  and (
    name like 'avatars/' || auth.uid()::text || '/%'
    or name like 'consultants/' || auth.uid()::text || '/%'
    or (name like 'giveaways/%' and is_admin())
  )
);

create policy storage_delete_own_prefix on storage.objects
for delete to authenticated
using (
  bucket_id = 'public-media'
  and (
    name like 'avatars/' || auth.uid()::text || '/%'
    or name like 'consultants/' || auth.uid()::text || '/%'
    or (name like 'giveaways/%' and is_admin())
  )
);

-- ============================================================
-- Post-run manual steps (NOT in this script)
-- ============================================================
-- 1. Seed first admin after they sign up via OTP:
--    update profiles set role = 'admin' where email = '<owner email>';
-- 2. Seed beta country:
--    insert into countries (name, iso_code) values ('Egypt', 'EG');
-- 3. Run the 10-item RLS test checklist from RLS_POLICY_PLAN.md §5
--    as client / consultant / admin test users BEFORE Week 1 sign-off.
