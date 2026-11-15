-- "Related evidence — AI-assisted explanation": one row per match run. ADDITIVE ONLY: a new server-only table and
-- three functions. Nothing here reads or changes requirement_results, evidence_matches, evidence verification or
-- any count, so explanations can never change a checked assessment.
-- Rollback (only while no explanation exists): scripts/sql/rollback-explanations-if-empty.sql
--
-- Trust model, as for match runs: functions are executable ONLY by service_role. The Next.js server authenticates
-- the user and passes the worker id explicitly; each function re-checks that the run belongs to that worker.
-- Provider calls (Supermemory search, Gemini) happen between claim and save, never inside a transaction.

create table public.match_run_explanations (
  id                  uuid primary key default gen_random_uuid(),
  match_run_id        uuid not null unique,
  worker_id           uuid not null references public.workers (id) on delete cascade,
  status              text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  attempts            integer not null default 1 check (attempts between 1 and 3),
  ai_status           text check (ai_status is null or ai_status in ('ok', 'failed', 'skipped')),
  model               text check (model is null or char_length(model) <= 100),
  rejected_references integer not null default 0 check (rejected_references >= 0),
  items               jsonb check (items is null or (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 60)),
  error_code          text check (error_code is null or char_length(error_code) <= 60),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- The run must belong to the same worker.
  foreign key (match_run_id, worker_id) references public.match_runs (id, worker_id) on delete cascade,
  check (status <> 'completed' or (items is not null and ai_status is not null))
);

create index match_run_explanations_worker_idx on public.match_run_explanations (worker_id, created_at desc);

alter table public.match_run_explanations enable row level security;
-- Server-only table: no policies, and no privileges for browser roles. The server reads it as service_role;
-- every write goes through the functions below.
revoke all on public.match_run_explanations from anon, authenticated;
grant select on public.match_run_explanations to service_role;

-- Claim the run's explanation. Returns:
--   claimed    the caller may generate now
--   existing   a completed explanation exists (no provider calls needed)
--   busy       another request is generating it (a claim older than 3 minutes is treated as abandoned)
--   exhausted  three attempts failed for this run
--   limited    the worker reached the daily generation limit
--   not_found  no COMPLETED run with this id belongs to this worker
create or replace function public.explanation_claim(p_worker_id uuid, p_run_id uuid, p_daily_limit integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.match_run_explanations;
  n integer;
begin
  if not exists (select 1 from public.match_runs m where m.id = p_run_id and m.worker_id = p_worker_id and m.status = 'completed') then
    return 'not_found';
  end if;

  select * into r from public.match_run_explanations where match_run_id = p_run_id for update;
  if found then
    if r.worker_id <> p_worker_id then return 'not_found'; end if;
    if r.status = 'completed' then return 'existing'; end if;
    if r.status = 'processing' and r.updated_at > now() - interval '3 minutes' then return 'busy'; end if;
    if r.attempts >= 3 then return 'exhausted'; end if;
    update public.match_run_explanations
       set status = 'processing', attempts = attempts + 1, error_code = null, updated_at = now()
     where id = r.id;
    return 'claimed';
  end if;

  select count(*) into n from public.match_run_explanations
   where worker_id = p_worker_id and created_at > now() - interval '24 hours';
  if n >= greatest(p_daily_limit, 0) then return 'limited'; end if;

  insert into public.match_run_explanations (match_run_id, worker_id) values (p_run_id, p_worker_id)
  on conflict (match_run_id) do nothing;
  if not found then return 'busy'; end if;
  return 'claimed';
end;
$$;

-- Save a claimed explanation. Only a row this worker is processing can be completed; returns false otherwise.
create or replace function public.explanation_save(
  p_worker_id uuid, p_run_id uuid, p_ai_status text, p_model text, p_rejected integer, p_items jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.match_run_explanations
     set status = 'completed', ai_status = p_ai_status, model = left(p_model, 100),
         rejected_references = greatest(p_rejected, 0), items = p_items, error_code = null, updated_at = now()
   where match_run_id = p_run_id and worker_id = p_worker_id and status = 'processing';
  return found;
end;
$$;

create or replace function public.explanation_fail(p_worker_id uuid, p_run_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.match_run_explanations
     set status = 'failed', error_code = left(p_error_code, 60), updated_at = now()
   where match_run_id = p_run_id and worker_id = p_worker_id and status = 'processing';
end;
$$;

revoke all on function public.explanation_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.explanation_save(uuid, uuid, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.explanation_fail(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.explanation_claim(uuid, uuid, integer) to service_role;
grant execute on function public.explanation_save(uuid, uuid, text, text, integer, jsonb) to service_role;
grant execute on function public.explanation_fail(uuid, uuid, text) to service_role;
