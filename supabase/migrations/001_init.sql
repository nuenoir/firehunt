-- FireHunt migration 001: the original schema (jobs, CVs, private file bucket).
-- Idempotent: safe to re-run. Already applied to the live project; kept here so the
-- whole database is reproducible from this repository.

-- ---------------------------------------------------------------------------
-- Jobs: one row per tracked job, locked to the user who created it.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  company text not null default '',
  country text not null default '',
  url text not null default '',
  salary text not null default '',
  status text not null default 'interested',
  notes text not null default '',
  date_added timestamptz not null default now(),
  deadline text,
  follow_up_date text,
  cv_id text,
  updated_at timestamptz not null default now()
);

alter table public.jobs enable row level security;

drop policy if exists "Users manage their own jobs" on public.jobs;
create policy "Users manage their own jobs"
  on public.jobs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists jobs_user_id_idx on public.jobs (user_id);

-- ---------------------------------------------------------------------------
-- CVs: details table (the file bytes live in Storage).
-- ---------------------------------------------------------------------------
create table if not exists public.cvs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'general',
  type text not null default '',
  size bigint not null default 0,
  date_added timestamptz not null default now(),
  path text not null,
  updated_at timestamptz not null default now()
);

alter table public.cvs enable row level security;

drop policy if exists "Users manage their own cvs" on public.cvs;
create policy "Users manage their own cvs"
  on public.cvs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists cvs_user_id_idx on public.cvs (user_id);

-- ---------------------------------------------------------------------------
-- Private bucket for the CV files. Objects live at "{user-id}/{cv-id}" and a user
-- may only touch objects inside their own folder.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('cvs', 'cvs', false)
on conflict (id) do nothing;

drop policy if exists "cv read own"   on storage.objects;
drop policy if exists "cv insert own" on storage.objects;
drop policy if exists "cv update own" on storage.objects;
drop policy if exists "cv delete own" on storage.objects;

create policy "cv read own" on storage.objects for select
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cv insert own" on storage.objects for insert
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cv update own" on storage.objects for update
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cv delete own" on storage.objects for delete
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);
