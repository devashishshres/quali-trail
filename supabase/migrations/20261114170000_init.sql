-- InstallerOS initial schema
-- Owner: Developer B
--
-- Design rules enforced IN THE DATABASE (not just in app code):
--   1. Every row belongs to one worker; RLS limits access to that worker.
--   2. Nothing can set verification_status = 'independently_confirmed'
--      unless a human 'confirmed' verification_event exists.
--   3. The same content cannot be saved twice for one worker (file_hash).
--   4. A requirement cannot link the same evidence twice in one run.
--   5. Any evidence change bumps the worker's evidence_revision and marks
--      completed match runs 'stale'.
--   6. Match links can only point at evidence owned by the run's worker
--      (composite foreign keys).

-- ------------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------------

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ------------------------------------------------------------------
-- workers
-- ------------------------------------------------------------------

create table public.workers (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid not null unique references auth.users (id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 300),
  trade             text not null check (char_length(trade) between 1 and 300),
  is_synthetic      boolean not null default false,
  -- Increments on every evidence insert/update/delete. Match runs store
  -- the revision they were computed from, so staleness is exact.
  evidence_revision bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger workers_updated_at
  before update on public.workers
  for each row execute function public.set_updated_at();

-- Resolves the signed-in user's worker id. SECURITY DEFINER so RLS
-- policies can call it without recursive policy checks.
create or replace function public.current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id from public.workers w where w.auth_user_id = auth.uid()
$$;

revoke all on function public.current_worker_id() from public;
grant execute on function public.current_worker_id() to authenticated;

-- ------------------------------------------------------------------
-- evidence
-- ------------------------------------------------------------------

create table public.evidence (
  id                  uuid primary key default gen_random_uuid(),
  worker_id           uuid not null references public.workers (id) on delete cascade,
  type                text not null check (type in
                        ('certification','training','work_record','checklist','experience_note','other')),
  title               text not null check (char_length(title) between 1 and 300),
  source_date         date,
  issuer              text check (issuer is null or char_length(issuer) <= 300),
  structured_data     jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(structured_data) = 'object'),
  source_kind         text not null check (source_kind in ('pdf_upload','manual_text','seed')),
  -- Path inside the private 'evidence' bucket: <auth_user_id>/<evidence_id>.pdf
  storage_path        text,
  mime_type           text,
  -- SHA-256 of the file bytes, or of the normalised text for manual entries.
  file_hash           text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  verification_status text not null default 'document_supplied' check (verification_status in
                        ('self_reported','document_supplied','pending_review',
                         'independently_confirmed','expired_or_invalid')),
  index_status        text not null default 'pending'
                        check (index_status in ('pending','processing','indexed','failed')),
  index_error         text,
  memory_document_id  text,
  is_synthetic        boolean not null default false,
  version             integer not null default 1 check (version > 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Needed for the composite FK from evidence_matches (rule 6).
  unique (id, worker_id),
  -- Rule 3: no duplicate content per worker.
  unique (worker_id, file_hash),
  -- An upload must have a file; a manual note must not pretend to.
  check ((source_kind = 'pdf_upload') = (storage_path is not null) or source_kind = 'seed')
);

create index evidence_worker_date_idx on public.evidence (worker_id, source_date desc);

-- Bump version when anything the matcher or report reads changes.
-- Content changes also require re-indexing in Supermemory.
create or replace function public.evidence_bump_version()
returns trigger
language plpgsql
as $$
begin
  if (new.type, new.title, new.source_date, new.issuer, new.structured_data, new.verification_status)
     is distinct from
     (old.type, old.title, old.source_date, old.issuer, old.structured_data, old.verification_status)
  then
    new.version := old.version + 1;
  end if;

  if (new.type, new.title, new.source_date, new.issuer, new.structured_data)
     is distinct from
     (old.type, old.title, old.source_date, old.issuer, old.structured_data)
     and new.index_status is not distinct from old.index_status
  then
    new.index_status := 'pending';
    new.index_error := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger evidence_bump_version
  before update on public.evidence
  for each row execute function public.evidence_bump_version();

-- ------------------------------------------------------------------
-- verification_events (human review only)
-- ------------------------------------------------------------------

create table public.verification_events (
  id          uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id),
  decision    text not null check (decision in ('confirmed','rejected','needs_more_information')),
  note        text check (note is null or char_length(note) <= 2000),
  created_at  timestamptz not null default now()
);

create index verification_events_evidence_idx on public.verification_events (evidence_id, created_at desc);

-- Rule 2: AI output, client code or a bad migration cannot mark a record
-- as independently confirmed. Only a prior human 'confirmed' event allows it.
create or replace function public.evidence_guard_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status = 'independently_confirmed'
     and (tg_op = 'INSERT' or old.verification_status is distinct from 'independently_confirmed')
     and not exists (
       select 1 from public.verification_events ve
       where ve.evidence_id = new.id and ve.decision = 'confirmed'
     )
  then
    raise exception 'independently_confirmed requires a confirmed verification_event'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger evidence_guard_verification
  before insert or update of verification_status on public.evidence
  for each row execute function public.evidence_guard_verification();

-- ------------------------------------------------------------------
-- evidence_drafts (Gemini output awaiting worker confirmation)
-- ------------------------------------------------------------------

create table public.evidence_drafts (
  id               uuid primary key default gen_random_uuid(),
  worker_id        uuid not null references public.workers (id) on delete cascade,
  source_kind      text not null check (source_kind in ('pdf_upload','manual_text')),
  file_name        text,
  storage_path     text,
  mime_type        text,
  file_hash        text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  raw_text         text check (raw_text is null or char_length(raw_text) <= 10000),
  extraction       jsonb,
  extraction_error text,
  created_at       timestamptz not null default now(),
  check ((source_kind = 'pdf_upload') = (storage_path is not null))
);

create index evidence_drafts_worker_idx on public.evidence_drafts (worker_id, created_at desc);

-- ------------------------------------------------------------------
-- opportunities & requirements
-- ------------------------------------------------------------------

create table public.opportunities (
  id           uuid primary key default gen_random_uuid(),
  worker_id    uuid not null references public.workers (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 300),
  employer     text not null check (char_length(employer) between 1 and 300),
  description  text not null default '' check (char_length(description) <= 10000),
  source_url   text,
  is_synthetic boolean not null default false,
  created_at   timestamptz not null default now()
);

create table public.requirements (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  position       integer not null check (position >= 0),
  original_text  text not null check (char_length(original_text) between 1 and 1000),
  criteria_json  jsonb not null check (jsonb_typeof(criteria_json) = 'object'),
  mandatory      boolean not null default true,
  source         text not null,
  unique (opportunity_id, position)
);

-- ------------------------------------------------------------------
-- match_runs, requirement_results, evidence_matches
-- ------------------------------------------------------------------

create table public.match_runs (
  id                uuid primary key default gen_random_uuid(),
  worker_id         uuid not null references public.workers (id) on delete cascade,
  opportunity_id    uuid not null references public.opportunities (id) on delete cascade,
  -- workers.evidence_revision at the time the run started.
  evidence_revision bigint not null check (evidence_revision >= 0),
  status            text not null default 'processing'
                      check (status in ('processing','completed','failed','stale')),
  memory_warning    text,
  error             text,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  unique (id, worker_id)
);

create index match_runs_lookup_idx on public.match_runs (worker_id, opportunity_id, created_at desc);

-- One row per requirement per run: the assessment itself.
create table public.requirement_results (
  id                    uuid primary key default gen_random_uuid(),
  match_run_id          uuid not null references public.match_runs (id) on delete cascade,
  requirement_id        uuid not null references public.requirements (id) on delete cascade,
  assessment            text not null check (assessment in
                          ('evidence_found','needs_review','no_sufficient_evidence')),
  explanation           text not null default '',
  uncertainties         text[] not null default '{}',
  missing_documentation text[] not null default '{}',
  unique (match_run_id, requirement_id)
);

-- One row per (requirement, evidence) link: the constellation edges.
create table public.evidence_matches (
  id                    uuid primary key default gen_random_uuid(),
  match_run_id          uuid not null,
  worker_id             uuid not null,
  requirement_id        uuid not null references public.requirements (id) on delete cascade,
  evidence_id           uuid not null,
  role                  text not null check (role in ('direct','supporting')),
  contribution          text not null default '',
  relevance_explanation text not null default '',
  memory_similarity     real check (memory_similarity is null or memory_similarity between 0 and 1),
  -- Rule 6: both sides must belong to the same worker.
  foreign key (match_run_id, worker_id) references public.match_runs (id, worker_id) on delete cascade,
  foreign key (evidence_id, worker_id) references public.evidence (id, worker_id) on delete cascade,
  -- Rule 4: no double counting.
  unique (match_run_id, requirement_id, evidence_id)
);

create index evidence_matches_run_idx on public.evidence_matches (match_run_id);

-- ------------------------------------------------------------------
-- Rule 5: staleness
-- ------------------------------------------------------------------

-- SECURITY DEFINER: workers has no UPDATE policy for users, so without it
-- RLS would silently turn the revision bump into a no-op.
create or replace function public.evidence_mark_matches_stale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_worker uuid := coalesce(new.worker_id, old.worker_id);
begin
  update public.workers
     set evidence_revision = evidence_revision + 1
   where id = affected_worker;

  update public.match_runs
     set status = 'stale'
   where worker_id = affected_worker
     and status = 'completed';

  return null;
end;
$$;

create trigger evidence_stale_on_insert_delete
  after insert or delete on public.evidence
  for each row execute function public.evidence_mark_matches_stale();

create trigger evidence_stale_on_update
  after update on public.evidence
  for each row
  when (old.version is distinct from new.version)
  execute function public.evidence_mark_matches_stale();

-- A record becoming searchable in memory can change results too.
create trigger evidence_stale_on_indexed
  after update of index_status on public.evidence
  for each row
  when (new.index_status = 'indexed' and old.index_status is distinct from 'indexed')
  execute function public.evidence_mark_matches_stale();

-- ------------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------------

alter table public.workers             enable row level security;
alter table public.evidence            enable row level security;
alter table public.evidence_drafts     enable row level security;
alter table public.verification_events enable row level security;
alter table public.opportunities       enable row level security;
alter table public.requirements        enable row level security;
alter table public.match_runs          enable row level security;
alter table public.requirement_results enable row level security;
alter table public.evidence_matches    enable row level security;

-- workers: read own profile only. Created by the server (service role).
create policy workers_select_own on public.workers
  for select to authenticated using (auth_user_id = auth.uid());

-- evidence: full CRUD on own rows.
create policy evidence_select_own on public.evidence
  for select to authenticated using (worker_id = public.current_worker_id());
create policy evidence_insert_own on public.evidence
  for insert to authenticated with check (worker_id = public.current_worker_id());
create policy evidence_update_own on public.evidence
  for update to authenticated
  using (worker_id = public.current_worker_id())
  with check (worker_id = public.current_worker_id());
create policy evidence_delete_own on public.evidence
  for delete to authenticated using (worker_id = public.current_worker_id());

-- drafts: full CRUD on own rows.
create policy drafts_all_own on public.evidence_drafts
  for all to authenticated
  using (worker_id = public.current_worker_id())
  with check (worker_id = public.current_worker_id());

-- verification_events: worker can read events on their evidence.
-- No insert policy: only the service role (server-side reviewer flow) writes.
create policy verification_select_own on public.verification_events
  for select to authenticated using (
    exists (select 1 from public.evidence e
            where e.id = evidence_id and e.worker_id = public.current_worker_id())
  );

-- opportunities / requirements: read own.
create policy opportunities_select_own on public.opportunities
  for select to authenticated using (worker_id = public.current_worker_id());
create policy requirements_select_own on public.requirements
  for select to authenticated using (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.worker_id = public.current_worker_id())
  );

-- match data: read + write own (the matcher runs as the signed-in user).
create policy match_runs_select_own on public.match_runs
  for select to authenticated using (worker_id = public.current_worker_id());
create policy match_runs_insert_own on public.match_runs
  for insert to authenticated with check (worker_id = public.current_worker_id());
create policy match_runs_update_own on public.match_runs
  for update to authenticated
  using (worker_id = public.current_worker_id())
  with check (worker_id = public.current_worker_id());

create policy requirement_results_select_own on public.requirement_results
  for select to authenticated using (
    exists (select 1 from public.match_runs m
            where m.id = match_run_id and m.worker_id = public.current_worker_id())
  );
create policy requirement_results_insert_own on public.requirement_results
  for insert to authenticated with check (
    exists (select 1 from public.match_runs m
            where m.id = match_run_id and m.worker_id = public.current_worker_id())
  );

create policy evidence_matches_select_own on public.evidence_matches
  for select to authenticated using (worker_id = public.current_worker_id());
create policy evidence_matches_insert_own on public.evidence_matches
  for insert to authenticated with check (worker_id = public.current_worker_id());

-- Anonymous visitors get nothing.
revoke all on public.workers, public.evidence, public.evidence_drafts,
              public.verification_events, public.opportunities, public.requirements,
              public.match_runs, public.requirement_results, public.evidence_matches
  from anon;
