-- LS Maps: community police reports table.
-- Lives in the same Supabase project as ASCEND but is a separate table —
-- ASCEND's data is untouched. Run once in the dashboard SQL Editor.
--
-- Security model: the shipped publishable key can only INSERT police pins
-- and SELECT pins younger than 4 hours (reports auto-expire from view).

create table if not exists public.ls_reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('police')),
  lng double precision not null check (lng between -180 and 180),
  lat double precision not null check (lat between -90 and 90),
  created_at timestamptz not null default now()
);

alter table public.ls_reports enable row level security;

drop policy if exists ls_reports_insert on public.ls_reports;
create policy ls_reports_insert on public.ls_reports
  for insert to anon, authenticated
  with check (kind = 'police');

drop policy if exists ls_reports_select_recent on public.ls_reports;
create policy ls_reports_select_recent on public.ls_reports
  for select to anon, authenticated
  using (created_at > now() - interval '4 hours');

create index if not exists ls_reports_created_idx on public.ls_reports (created_at desc);
