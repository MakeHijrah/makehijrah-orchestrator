begin;

alter table public.consultants
  add column if not exists gender text;

alter table public.consultants
  drop constraint if exists consultants_gender_check;

alter table public.consultants
  add constraint consultants_gender_check
  check (
    gender is null
    or gender in ('male', 'female')
  );

commit;
