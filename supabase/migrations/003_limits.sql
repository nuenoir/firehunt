-- FireHunt migration 003: server-side limits.
-- Idempotent: safe to re-run. Paste into Supabase -> SQL Editor -> Run
-- (make sure the editor is on the "Primary Database" source, not Logs).
--
-- Why: anyone can sign in with a magic link and the browser talks to Supabase
-- directly with a public key. Row-level security stops people reading or editing
-- each other's data, but does not limit HOW MUCH one account can store. These
-- limits are enforced by the database itself, so they hold even if somebody skips
-- the app and calls Supabase directly. The numbers are mirrored in lib/limits.ts.
--
--   Jobs:    300 per account; title/company 500 chars, notes 20,000, etc. (below)
--   CVs:     10 per account; 20 files per account in storage; 5 MB each;
--            PDF / DOC / DOCX only; a file may only be stored for a CV record
--            that already exists (so the record cap also caps the files)
--
-- Needs migrations 001 and 002 to have been run first (the jobs.contacts and
-- jobs.analysis columns come from 002).
--
-- Rows that already exist are left alone: new constraints are added "not valid"
-- (checked for new and edited rows) and then validated if the existing data allows.
-- A leftover row that already breaks a rule can still be read and deleted, but any
-- edit to it (even to another field) is refused until every oversize field on that
-- row has been trimmed, because Postgres checks the whole row on every edit.

-- ---------------------------------------------------------------------------
-- 1) Field size limits.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('jobs', 'jobs_title_len',    'char_length(title) <= 500'),
      ('jobs', 'jobs_company_len',  'char_length(company) <= 500'),
      ('jobs', 'jobs_country_len',  'char_length(country) <= 100'),
      ('jobs', 'jobs_url_len',      'char_length(url) <= 2000'),
      ('jobs', 'jobs_salary_len',   'char_length(salary) <= 200'),
      ('jobs', 'jobs_status_len',   'char_length(status) <= 30'),
      ('jobs', 'jobs_notes_len',    'char_length(notes) <= 20000'),
      ('jobs', 'jobs_deadline_len', 'char_length(deadline) <= 40'),
      ('jobs', 'jobs_follow_up_len','char_length(follow_up_date) <= 40'),
      ('jobs', 'jobs_cv_id_len',    'char_length(cv_id) <= 64'),
      ('jobs', 'jobs_contacts_size','char_length(contacts::text) <= 8000'),
      ('jobs', 'jobs_analysis_size','char_length(analysis::text) <= 40000'),
      ('cvs',  'cvs_name_len',      'char_length(name) <= 300'),
      ('cvs',  'cvs_role_len',      'char_length(role) <= 30'),
      ('cvs',  'cvs_type_len',      'char_length(type) <= 150'),
      -- 10 MB, not the 5 MB bucket limit: a CV saved before the limit was lowered
      -- must stay editable (every edit re-checks the whole record).
      ('cvs',  'cvs_size_range',    'size >= 0 and size <= 10485760'),
      -- Files live at "{user-id}/{cv-id}"; a CV row may not point anywhere else.
      ('cvs',  'cvs_path_shape',    'path = user_id::text || ''/'' || id::text')
    ) as t(tbl, name, expr)
  loop
    execute format('alter table public.%I drop constraint if exists %I', c.tbl, c.name);
    execute format('alter table public.%I add constraint %I check (%s) not valid', c.tbl, c.name, c.expr);
    begin
      execute format('alter table public.%I validate constraint %I', c.tbl, c.name);
    exception when check_violation then
      raise notice 'FireHunt: some existing rows in % break the rule "%". New and edited rows are still checked; trim those rows and re-run this migration to finish validating.', c.tbl, c.name;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Row-count caps per account.
--    A BEFORE INSERT trigger counts the account's rows. An upsert of a row that
--    already exists also fires it, so existing rows are let through (otherwise an
--    account sitting exactly at its cap could not edit anything). A per-account
--    advisory lock makes the count exact even when two requests race.
--    Raises Postgres error 54000 with a message written for people.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_row_cap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cap integer := tg_argv[0]::integer;
  label text := tg_argv[1];
  already boolean;
  n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(tg_table_name || ':' || new.user_id::text, 0));

  execute format('select exists (select 1 from public.%I where id = $1)', tg_table_name)
    into already using new.id;
  if already then
    return new;
  end if;

  execute format('select count(*) from public.%I where user_id = $1', tg_table_name)
    into n using new.user_id;
  if n >= cap then
    raise exception 'FireHunt limit: an account can keep at most % %. Delete some to add more.', cap, label
      using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_row_cap on public.jobs;
create trigger jobs_row_cap
  before insert on public.jobs
  for each row execute function public.enforce_row_cap(300, 'jobs');

drop trigger if exists cvs_row_cap on public.cvs;
create trigger cvs_row_cap
  before insert on public.cvs
  for each row execute function public.enforce_row_cap(10, 'CVs');

-- ---------------------------------------------------------------------------
-- 3) CV file storage: size and type limits on the bucket, and a cap on how many
--    files one account may hold.
--    The size and type limits are enforced by the Storage service itself (it reads
--    them from this row), not by SQL. It judges the type by what the upload DECLARES
--    (the browser's file type), so the type list keeps honest uploads tidy but is not
--    a defence against someone who labels any bytes "application/pdf"; the size limit
--    and the file cap below are the parts that protect the free storage quota.
-- ---------------------------------------------------------------------------
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array[
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       ]
 where id = 'cvs';

-- Same rule as migration 001 (you may only add files inside your own folder), plus:
--   a) the file must belong to a CV record you already have (path = the record's
--      "{user-id}/{cv-id}"). Records are capped at 10 per account by the trigger above,
--      so this is what really caps the files: you cannot store a file out of thin air.
--      The app therefore saves the record FIRST and uploads the file second.
--   b) stay under 20 files in the bucket, unless this upload replaces a file you
--      already have (this only matters when old stray files are already there).
-- Honest limits of this check:
--   * Supabase checks this policy when an upload link is REQUESTED, not again when the
--     file arrives through that link, so someone who deliberately scripts "create a
--     record, request a link, delete the record, repeat" can park more files than the
--     cap. Each file is still limited to 5 MB. A scheduled clean-up of files that have
--     no record would close this completely (see README, Known limitations).
--   * The count is taken once per statement and two uploads landing at the same instant
--     could both pass; the 5 MB limit keeps any such overshoot small.
drop policy if exists "cv insert own" on storage.objects;
create policy "cv insert own" on storage.objects for insert
  with check (
    bucket_id = 'cvs'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.cvs c
       where c.user_id = auth.uid() and c.path = objects.name
    )
    and (
      exists (
        select 1 from storage.objects o
         where o.bucket_id = 'cvs' and o.name = objects.name
      )
      or (
        select count(*) from storage.objects o
         where o.bucket_id = 'cvs'
           and (storage.foldername(o.name))[1] = auth.uid()::text
      ) < 20
    )
  );

-- ---------------------------------------------------------------------------
-- 4) Heads-up for accounts that are ALREADY over a cap (for example the owner's, from
--    earlier testing). Nothing is deleted: such an account keeps what it has and can
--    still edit it, but cannot add more until it is under the cap. These notices appear
--    in the SQL editor's results so you know before it surprises you.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select user_id, count(*) as n from public.jobs group by user_id having count(*) >= 300 loop
    raise notice 'FireHunt: account % has % jobs (limit 300). It keeps them but cannot add more until it is under the limit.', r.user_id, r.n;
  end loop;
  for r in select user_id, count(*) as n from public.cvs group by user_id having count(*) >= 10 loop
    raise notice 'FireHunt: account % has % CVs (limit 10). It keeps them but cannot add more until it is under the limit.', r.user_id, r.n;
  end loop;
  begin
    for r in
      select (storage.foldername(name))[1] as uid, count(*) as n
        from storage.objects where bucket_id = 'cvs'
       group by 1 having count(*) >= 20
    loop
      raise notice 'FireHunt: account % has % stored CV files (limit 20). It keeps them but cannot upload new ones until it is under the limit.', r.uid, r.n;
    end loop;
  exception when others then
    raise notice 'FireHunt: could not count stored CV files (%).', sqlerrm;
  end;
end $$;
