-- MakeHijrah Relocation OS v1.0
-- migration_004_optional_whatsapp.sql
-- Purpose: make consultation_intake.phone_whatsapp optional.
-- The required consultation summary remains stored in answers_jsonb under
-- the locked key: consultation_summary.

begin;

alter table public.consultation_intake
  alter column phone_whatsapp drop not null;

comment on column public.consultation_intake.phone_whatsapp is
  'Optional WhatsApp contact number supplied during consultation booking.';

comment on column public.consultation_intake.answers_jsonb is
  'Booking intake answers. Must include a non-empty consultation_summary key for new bookings; enforced by the orchestrator/API validation.';

commit;
