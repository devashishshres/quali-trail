-- Match-run lifecycle, authoritative writes and privilege hardening.
-- NEW migration (does not rewrite 20261114170000_init.sql).
-- Owner of this change: Job Qualification feature. Reconcile with Evidence Passport owner.
--
-- Problems this fixes:
--   1. A run's evidence_revision was whatever the client wrote; reading the
--      revision and inserting the run were separate steps.
--   2. Completing a run was several independent writes: evidence could change
--      between them and the run would still end up "completed".
--   3. Signed-in clients could INSERT match results / evidence system columns
--      directly with the publishable key, forging assessments or index state.
--   4. Two concurrent runs, or a crashed run stuck in "processing", were not handled.
--
-- Trust model: the three functions below are executable ONLY by service_role.
-- The Next.js server calls them after authenticating the user and passes the
-- worker id explicitly; each function re-checks that the run/opportunity
-- belongs to that worker. Provider calls (Supermemory) happen between
-- start and finalize, never inside a transaction.

-- ------------------------------------------------------------------
-- One live run per worker + opportunity
-- ------------------------------------------------------------------

create unique index if not exists match_runs_one_processing_idx
  on public.match_runs (worker_id, opportunity_id)
  where status = 'processing';

-- ------------------------------------------------------------------
-- start_match_run
-- ------------------------------------------------------------------
-- Captures workers.evidence_revision in the same statement that inserts the
-- run. Callers must load evidence AFTER this returns, so finalize can detect
-- any change since.
create or replace function public.start_match_run(p_worker_id uuid, p_opportunity_id uuid)
returns table (id uuid, evidence_revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.opportunities o
    where o.id = p_opportunity_id and o.worker_id = p_worker_id
  ) then
    raise exception 'opportunity not found' using errcode = 'P0002';
  end if;

  -- Recover runs abandoned by a crashed/timed-out request.
  update public.match_runs m
     set status = 'failed', error = 'abandoned', completed_at = now()
   where m.worker_id = p_worker_id
     and m.opportunity_id = p_opportunity_id
     and m.status = 'processing'
     and m.created_at < now() - interval '5 minutes';

  begin
    return query
      insert into public.match_runs as m (worker_id, opportunity_id, evidence_revision, status)
      select p_worker_id, p_opportunity_id, w.evidence_revision, 'processing'
        from public.workers w
       where w.id = p_worker_id
      returning m.id, m.evidence_revision;
  exception when unique_violation then
    raise exception 'a matching run is already in progress' using errcode = '55P03';
  end;

  if not found then
    raise exception 'worker not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ------------------------------------------------------------------
-- finalize_match_run
-- ------------------------------------------------------------------
-- p_results: [{requirement_id, assessment, explanation, uncertainties[], missing_documentation[]}]
-- p_matches: [{requirement_id, evidence_id, role, contribution, relevance_explanation, memory_similarity}]
-- Returns 'completed' or 'stale'. All writes happen in this one transaction.
create or replace function public.finalize_match_run(
  p_worker_id uuid,
  p_run_id uuid,
  p_results jsonb,
  p_matches jsonb,
  p_memory_warning text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run     public.match_runs%rowtype;
  v_rev     bigint;
  v_req_ids uuid[];
  v_res_ids uuid[];
begin
  if jsonb_typeof(p_results) is distinct from 'array' or jsonb_typeof(p_matches) is distinct from 'array' then
    raise exception 'results and matches must be JSON arrays' using errcode = 'check_violation';
  end if;

  -- Lock the worker row FIRST (share), then the run. The evidence trigger
  -- UPDATEs workers.evidence_revision, which conflicts with FOR SHARE:
  --   * evidence change committed first  -> we read the newer revision -> 'stale'
  --   * we hold the lock first           -> the change waits, then its trigger
  --                                         marks our completed run 'stale'
  -- Both orders end correctly.
  select w.evidence_revision into v_rev
    from public.workers w where w.id = p_worker_id for share;
  if not found then raise exception 'worker not found' using errcode = 'P0002'; end if;

  select * into v_run from public.match_runs m
   where m.id = p_run_id and m.worker_id = p_worker_id for update;
  if not found then raise exception 'run not found' using errcode = 'P0002'; end if;
  if v_run.status <> 'processing' then
    raise exception 'run is not processing' using errcode = 'check_violation';
  end if;

  if v_rev <> v_run.evidence_revision then
    update public.match_runs set status = 'stale', completed_at = now() where id = p_run_id;
    return 'stale';
  end if;

  -- Exactly one result per requirement of THIS run's opportunity.
  select coalesce(array_agg(r.id order by r.id), '{}') into v_req_ids
    from public.requirements r where r.opportunity_id = v_run.opportunity_id;
  select coalesce(array_agg(x.requirement_id order by x.requirement_id), '{}') into v_res_ids
    from jsonb_to_recordset(p_results) as x (requirement_id uuid);
  if v_req_ids is distinct from v_res_ids then
    raise exception 'results must cover exactly the opportunity requirements' using errcode = 'check_violation';
  end if;

  -- Every match must point at a requirement of this opportunity.
  if exists (
    select 1 from jsonb_to_recordset(p_matches) as m (requirement_id uuid)
     where m.requirement_id <> all (v_req_ids)
  ) then
    raise exception 'match references a requirement outside this opportunity' using errcode = 'check_violation';
  end if;

  insert into public.requirement_results
    (match_run_id, requirement_id, assessment, explanation, uncertainties, missing_documentation)
  select p_run_id, x.requirement_id, x.assessment, coalesce(x.explanation, ''),
         coalesce((select array_agg(u) from jsonb_array_elements_text(coalesce(x.uncertainties, '[]'::jsonb)) u), '{}'),
         coalesce((select array_agg(u) from jsonb_array_elements_text(coalesce(x.missing_documentation, '[]'::jsonb)) u), '{}')
    from jsonb_to_recordset(p_results) as x
      (requirement_id uuid, assessment text, explanation text, uncertainties jsonb, missing_documentation jsonb);

  -- Composite FKs reject evidence owned by another worker.
  insert into public.evidence_matches
    (match_run_id, worker_id, requirement_id, evidence_id, role, contribution, relevance_explanation, memory_similarity)
  select p_run_id, p_worker_id, m.requirement_id, m.evidence_id, m.role,
         coalesce(m.contribution, ''), coalesce(m.relevance_explanation, ''), m.memory_similarity
    from jsonb_to_recordset(p_matches) as m
      (requirement_id uuid, evidence_id uuid, role text, contribution text,
       relevance_explanation text, memory_similarity real);

  update public.match_runs
     set status = 'completed', completed_at = now(), memory_warning = p_memory_warning
   where id = p_run_id;
  return 'completed';
end;
$$;

-- ------------------------------------------------------------------
-- fail_match_run
-- ------------------------------------------------------------------
create or replace function public.fail_match_run(
  p_worker_id uuid,
  p_run_id uuid,
  p_error text,
  p_memory_warning text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.match_runs
     set status = 'failed', error = left(p_error, 500), memory_warning = p_memory_warning, completed_at = now()
   where id = p_run_id and worker_id = p_worker_id and status = 'processing';
end;
$$;

revoke all on function public.start_match_run(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_match_run(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.fail_match_run(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.start_match_run(uuid, uuid) to service_role;
grant execute on function public.finalize_match_run(uuid, uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.fail_match_run(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------------
-- Privilege hardening: signed-in clients may READ match data, never write it.
-- ------------------------------------------------------------------

revoke insert, update, delete on public.match_runs, public.requirement_results, public.evidence_matches
  from authenticated;

-- Evidence system columns (verification, indexing, ownership, hash, storage
-- path, version) are server-controlled. Clients may edit descriptive fields only,
-- and new evidence is inserted by trusted server code after validation.
revoke insert, update, delete on public.evidence from authenticated;
grant update (type, title, source_date, issuer, structured_data) on public.evidence to authenticated;
