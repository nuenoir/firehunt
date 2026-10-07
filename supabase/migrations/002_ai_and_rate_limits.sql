-- FireHunt migration 002: AI fields on jobs + shared rate limiting.
-- Idempotent: safe to re-run. Paste into Supabase -> SQL Editor -> Run.

-- ---------------------------------------------------------------------------
-- 1) Jobs gain two JSON columns for the AI features.
--    contacts: recruiter contacts extracted from the posting (with names/roles)
--    analysis: the saved CV-to-job fit analysis
-- ---------------------------------------------------------------------------
alter table public.jobs add column if not exists contacts jsonb;
alter table public.jobs add column if not exists analysis jsonb;

-- ---------------------------------------------------------------------------
-- 2) Fixed-window rate limiting, shared across serverless instances.
--    Used to protect the public search routes (per IP) and to cap AI spend
--    (per user per day, and globally per day).
--
--    RLS is enabled with NO policies, so the browser (anon/authenticated keys)
--    cannot read or write this table at all — only the server's service key can.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

alter table public.rate_limits enable row level security;

-- Atomically count one hit and report whether it is within the limit.
create or replace function public.hit_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  w timestamptz;
  c integer;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, w, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning r.count into c;
  return c <= p_limit;
end;
$$;

-- Only the server (service role) may call it; otherwise anyone could burn other
-- people's allowance by passing their key.
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
