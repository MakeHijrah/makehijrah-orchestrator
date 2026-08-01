-- ============================================================
-- MakeHijrah Relocation OS — Migration 001: Schema (FROZEN v1.0)
-- Source of truth: DATABASE_SCHEMA.md
-- Run in Supabase SQL editor (staging first).
-- ============================================================

-- ---------- Enums ----------
create type user_role as enum ('client', 'consultant', 'admin');

create type invite_status as enum ('unused', 'used', 'expired', 'revoked');

create type consultation_status as enum (
  'draft',
  'payment_authorized',
  'pending_acceptance',
  'confirmed',
  'declined',
  'admin_attention',
  'completed',
  'cancelled',
  'authorization_cancelled',
  'captured',
  'refunded'
);

create type service_request_status as enum ('pending', 'active', 'completed', 'cancelled');

create type recommendation_status as enum ('proposed', 'sent');

-- ---------- 1. profiles ----------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'client',
  full_name text,
  email text not null,
  phone_whatsapp text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 2. consultants ----------
create table consultants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id) on delete cascade,
  headline text,
  bio text,
  photo_url text,
  timezone text not null,
  working_hours_jsonb jsonb not null default '{}'::jsonb,
  minimum_booking_notice_hours integer not null default 24,
  available_for_general boolean not null default false,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 3. consultant_invites ----------
create table consultant_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null,
  status invite_status not null default 'unused',
  expires_at timestamptz not null,
  created_by uuid not null references profiles(id),
  used_at timestamptz,
  used_by_profile_id uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index idx_consultant_invites_status on consultant_invites (status, expires_at);

-- ---------- 4. countries ----------
create table countries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  iso_code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- 5. consultant_countries ----------
create table consultant_countries (
  consultant_id uuid not null references consultants(id) on delete cascade,
  country_id uuid not null references countries(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (consultant_id, country_id)
);

-- ---------- 6. oauth_connections ----------
create table oauth_connections (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null unique references consultants(id) on delete cascade,
  provider text not null default 'google',
  encrypted_refresh_token text not null,
  google_email text,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------- 7. consultations ----------
create table consultations (
  id uuid primary key default gen_random_uuid(),
  client_profile_id uuid not null references profiles(id),
  consultant_id uuid not null references consultants(id),
  country_id uuid references countries(id),  -- NULL = general consultation (sole signal)
  status consultation_status not null default 'draft',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  client_timezone text,
  price_cents integer not null,
  currency text not null default 'usd',
  stripe_payment_intent_id text unique,
  payment_authorized_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  captured_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  google_event_id text,
  meet_link text,
  admin_attention_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consultation_end_after_start check (scheduled_end_at > scheduled_start_at),
  constraint consultation_currency_lowercase check (currency = lower(currency))
);

-- Race-condition referee (day one, non-negotiable)
create unique index unique_reserved_consultant_slot
on consultations (consultant_id, scheduled_start_at)
where status in (
  'draft',
  'payment_authorized',
  'pending_acceptance',
  'confirmed',
  'captured'
);

create index idx_consultations_client on consultations (client_profile_id, created_at desc);
create index idx_consultations_consultant on consultations (consultant_id, scheduled_start_at);
create index idx_consultations_timeout on consultations (status, payment_authorized_at)
  where status = 'pending_acceptance';
create index idx_consultations_stale_drafts on consultations (status, created_at)
  where status = 'draft';

-- ---------- 8. consultation_intake ----------
create table consultation_intake (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null unique references consultations(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone_whatsapp text not null,
  answers_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- 9. consultation_notes ----------
create table consultation_notes (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references consultations(id) on delete cascade,
  consultant_id uuid not null references consultants(id),
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_notes_consultation on consultation_notes (consultation_id);

-- ---------- 10. services ----------
create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price_display text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 11. service_recommendations ----------
create table service_recommendations (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references consultations(id) on delete cascade,
  service_id uuid not null references services(id),
  recommended_by_consultant_id uuid not null references consultants(id),
  status recommendation_status not null default 'proposed',
  consultant_note text,
  sent_by_admin_id uuid references profiles(id),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (consultation_id, service_id),
  constraint sent_recommendation_requires_admin_metadata check (
    status = 'proposed'
    or (status = 'sent' and sent_by_admin_id is not null and sent_at is not null)
  )
);

-- ---------- 12. service_requests ----------
create table service_requests (
  id uuid primary key default gen_random_uuid(),
  client_profile_id uuid not null references profiles(id),
  service_id uuid not null references services(id),
  consultation_id uuid references consultations(id),
  status service_request_status not null default 'pending',
  details_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 13. payments ----------
create table payments (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid references consultations(id),
  stripe_payment_intent_id text not null,
  stripe_event_id text unique,
  event_type text not null,
  amount_cents integer not null,
  currency text not null default 'usd',
  status text not null,
  raw_jsonb jsonb,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

create index idx_payments_pi on payments (stripe_payment_intent_id);
create index idx_payments_consultation on payments (consultation_id);

-- ---------- 14. messages ----------
create table messages (
  id uuid primary key default gen_random_uuid(),
  consultation_id uuid not null references consultations(id) on delete cascade,
  sender_profile_id uuid not null references profiles(id),
  recipient_profile_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

create index idx_messages_consultation on messages (consultation_id, created_at);

-- ---------- 15. giveaways ----------
create table giveaways (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  resource_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Triggers
-- ============================================================

-- updated_at maintenance
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();
create trigger trg_consultants_updated before update on consultants
  for each row execute function set_updated_at();
create trigger trg_oauth_updated before update on oauth_connections
  for each row execute function set_updated_at();
create trigger trg_consultations_updated before update on consultations
  for each row execute function set_updated_at();
create trigger trg_notes_updated before update on consultation_notes
  for each row execute function set_updated_at();
create trigger trg_services_updated before update on services
  for each row execute function set_updated_at();
create trigger trg_service_requests_updated before update on service_requests
  for each row execute function set_updated_at();

-- profiles auto-creation on signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();

-- Helper for column guards: true when the caller may bypass column protection.
-- Covers PostgREST service-role calls AND direct SQL-editor sessions (postgres role).
create or replace function is_privileged_writer()
returns boolean language sql stable as $$
  select coalesce(auth.role(), '') = 'service_role'
      or current_user in ('postgres', 'supabase_admin');
$$;

-- Guard: profiles.role and profiles.email are orchestrator/manual-SQL only
create or replace function guard_profiles_columns()
returns trigger language plpgsql as $$
begin
  if not is_privileged_writer() then
    if new.role is distinct from old.role then
      raise exception 'profiles.role may not be changed by clients';
    end if;
    if new.email is distinct from old.email then
      raise exception 'profiles.email may not be changed by clients';
    end if;
  end if;
  return new;
end $$;

create trigger trg_guard_profiles
before update on profiles
for each row execute function guard_profiles_columns();

-- Guard: consultants privileged columns are orchestrator-only
create or replace function guard_consultants_columns()
returns trigger language plpgsql as $$
begin
  if not is_privileged_writer() then
    if new.is_active is distinct from old.is_active then
      raise exception 'consultants.is_active may not be changed by clients';
    end if;
    if new.available_for_general is distinct from old.available_for_general then
      raise exception 'consultants.available_for_general may not be changed by clients';
    end if;
    if new.profile_id is distinct from old.profile_id then
      raise exception 'consultants.profile_id may not be changed by clients';
    end if;
  end if;
  return new;
end $$;

create trigger trg_guard_consultants
before update on consultants
for each row execute function guard_consultants_columns();
