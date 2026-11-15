-- Job import: a technician pastes a public job URL (or the posting text), reviews the requirements QualiTrail
-- drafted from it, and confirms. ADDITIVE ONLY: new table, new nullable columns, new functions, and one widened
-- check constraint. Existing rows keep their meaning; seeded requirements have no rule and evaluate as before.
-- Rollback (only while nothing has been imported): scripts/sql/rollback-job-import-if-empty.sql
--
-- Trust model, as for match runs: every function is executable ONLY by service_role. The Next.js server calls
-- them after authenticating the user and passes the worker id explicitly; each function re-checks ownership.
-- Provider calls (TinyFish, Gemini) happen between these calls, never inside a transaction.
--
-- Privacy: the stored listing text is the PUBLIC posting only. It is cleared when the draft is confirmed, and
-- drafts expire after 7 days. Nothing about the technician is ever sent to a provider.

-- ------------------------------------------------------------------
-- Drafts
-- ------------------------------------------------------------------

create table public.opportunity_imports (
  id                  uuid primary key default gen_random_uuid(),
  worker_id           uuid not null references public.workers (id) on delete cascade,
  source_kind         text not null check (source_kind in ('listing_url', 'pasted_text')),
  submitted_url       text check (submitted_url is null or char_length(submitted_url) <= 2048),
  status              text not null default 'fetching'
                        check (status in ('fetching', 'fetched', 'drafting', 'drafted', 'confirmed', 'failed', 'expired')),
  final_url           text check (final_url is null or char_length(final_url) <= 2048),
  listing_title       text check (listing_title is null or char_length(listing_title) <= 300),
  content_text        text check (content_text is null or char_length(content_text) <= 60000),
  content_truncated   boolean not null default false,
  retrieved_at        timestamptz,
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 200),
  draft               jsonb check (draft is null or jsonb_typeof(draft) = 'object'),
  draft_version       integer not null default 0,
  warnings            text[] not null default '{}',
  error_code          text check (error_code is null or char_length(error_code) <= 60),
  error_message       text check (error_message is null or char_length(error_message) <= 500),
  lease_until         timestamptz,
  opportunity_id      uuid references public.opportunities (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  expires_at          timestamptz not null default now() + interval '7 days',
  check (source_kind <> 'listing_url' or submitted_url is not null)
);

create index opportunity_imports_worker_idx on public.opportunity_imports (worker_id, created_at desc);
-- No two concurrent provider fetches of the same URL for the same technician.
create unique index opportunity_imports_one_fetch_idx
  on public.opportunity_imports (worker_id, submitted_url) where status = 'fetching';

alter table public.opportunity_imports enable row level security;
-- Server-only table: no policies, and no privileges for browser roles.
revoke all on public.opportunity_imports from anon, authenticated;

-- ------------------------------------------------------------------
-- Opportunities and requirements: provenance and review fields
-- ------------------------------------------------------------------

alter table public.opportunities
  add column import_id       uuid references public.opportunity_imports (id) on delete set null,
  add column source_kind     text check (source_kind is null or source_kind in ('listing_url', 'pasted_text')),
  add column location        text check (location is null or char_length(location) <= 300),
  add column retrieved_at    timestamptz,
  add column final_url       text check (final_url is null or char_length(final_url) <= 2048),
  add column supersedes_id   uuid references public.opportunities (id) on delete set null,
  add column import_warnings text[] not null default '{}',
  add column removed_count   integer not null default 0 check (removed_count >= 0),
  add column edited_count    integer not null default 0 check (edited_count >= 0);

-- One opportunity per confirmed draft: confirmation can never create two.
create unique index opportunities_import_once_idx on public.opportunities (import_id) where import_id is not null;

alter table public.requirements
  add column priority          text check (priority is null or priority in ('required', 'preferred', 'unspecified')),
  add column original_priority text check (original_priority is null or original_priority in ('required', 'preferred', 'unspecified')),
  add column display_text      text check (display_text is null or char_length(display_text) between 1 and 1000),
  add column source_excerpt    text check (source_excerpt is null or char_length(source_excerpt) <= 2000),
  add column category          text check (category is null or char_length(category) <= 60);

-- ------------------------------------------------------------------
-- Results: "cannot_assess" (QualiTrail cannot judge this line from records)
-- ------------------------------------------------------------------

do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.requirement_results'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%assessment%'
  loop
    execute format('alter table public.requirement_results drop constraint %I', c);
  end loop;
end $$;

alter table public.requirement_results
  add constraint requirement_results_assessment_check
  check (assessment in ('evidence_found', 'needs_review', 'no_sufficient_evidence', 'cannot_assess'));

-- ------------------------------------------------------------------
-- Lifecycle functions
-- ------------------------------------------------------------------

-- Start an import. Recovers a crashed fetch (older than 3 minutes), refuses a concurrent fetch of the same URL,
-- and enforces the per-technician daily limit on PROVIDER calls (pasted text does not count).
create or replace function public.opportunity_import_begin(
  p_worker_id uuid, p_source_kind text, p_url text, p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid; v_used integer;
begin
  if not exists (select 1 from public.workers w where w.id = p_worker_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  update public.opportunity_imports
     set status = 'failed', error_code = 'abandoned', error_message = 'The retrieval did not finish.', updated_at = now()
   where worker_id = p_worker_id and status = 'fetching' and created_at < now() - interval '3 minutes';

  if p_source_kind = 'listing_url' then
    select count(*) into v_used from public.opportunity_imports
     where worker_id = p_worker_id and source_kind = 'listing_url' and created_at > now() - interval '24 hours';
    if v_used >= greatest(p_daily_limit, 0) then
      return jsonb_build_object('ok', false, 'reason', 'daily_limit');
    end if;
  end if;

  begin
    insert into public.opportunity_imports (worker_id, source_kind, submitted_url, status)
    values (p_worker_id, p_source_kind, p_url, 'fetching')
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'in_progress');
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- Record the retrieved (or pasted) listing. Only from 'fetching'.
create or replace function public.opportunity_import_fetched(
  p_worker_id uuid, p_id uuid, p_title text, p_final_url text, p_text text, p_truncated boolean,
  p_request_id text, p_warnings text[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.opportunity_imports
     set status = 'fetched', listing_title = left(p_title, 300), final_url = p_final_url, content_text = p_text,
         content_truncated = coalesce(p_truncated, false), provider_request_id = p_request_id,
         warnings = coalesce(p_warnings, '{}'), retrieved_at = now(), updated_at = now()
   where id = p_id and worker_id = p_worker_id and status = 'fetching';
  return found;
end;
$$;

-- Mark a fetch or draft attempt failed. A failed draft keeps its listing text so drafting can be retried.
create or replace function public.opportunity_import_fail(p_worker_id uuid, p_id uuid, p_code text, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.opportunity_imports
     set status = 'failed', error_code = left(p_code, 60), error_message = left(p_message, 500), lease_until = null, updated_at = now()
   where id = p_id and worker_id = p_worker_id and status in ('fetching', 'drafting');
end;
$$;

-- Take the drafting lease. Exactly one caller gets true; a crashed lease can be retaken after it lapses.
-- Never from 'drafted' or 'confirmed', so a finished or confirmed draft is never regenerated or overwritten.
create or replace function public.opportunity_import_lease(p_worker_id uuid, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.opportunity_imports
     set status = 'drafting', lease_until = now() + interval '2 minutes', error_code = null, error_message = null, updated_at = now()
   where id = p_id and worker_id = p_worker_id and expires_at > now() and content_text is not null
     and (status = 'fetched'
          or (status = 'drafting' and lease_until < now())
          or (status = 'failed' and error_code like 'draft_%'));
  return found;
end;
$$;

-- Store the generated draft. Only the lease holder's attempt can land (status must still be 'drafting').
create or replace function public.opportunity_import_drafted(p_worker_id uuid, p_id uuid, p_draft jsonb, p_warnings text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v integer;
begin
  update public.opportunity_imports
     set status = 'drafted', draft = p_draft, draft_version = draft_version + 1, lease_until = null,
         warnings = coalesce(p_warnings, '{}'), updated_at = now()
   where id = p_id and worker_id = p_worker_id and status = 'drafting'
  returning draft_version into v;
  return v;
end;
$$;

-- Save the technician's review edits. Optimistic: the caller's version must match.
create or replace function public.opportunity_import_save_review(p_worker_id uuid, p_id uuid, p_expected_version integer, p_draft jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v integer;
begin
  update public.opportunity_imports
     set draft = p_draft, draft_version = draft_version + 1, updated_at = now()
   where id = p_id and worker_id = p_worker_id and status = 'drafted' and draft_version = p_expected_version
     and expires_at > now()
  returning draft_version into v;
  return v;
end;
$$;

-- Confirm atomically and idempotently. Locks the draft; a repeat returns the opportunity already created.
-- p_opportunity: {title, employer, description, source_url, location, warnings[], removed_count, edited_count}
-- p_requirements: [{position, original_text, criteria_json, mandatory, source, priority, original_priority,
--                   display_text, source_excerpt, category}]
create or replace function public.opportunity_import_confirm(
  p_worker_id uuid, p_id uuid, p_expected_version integer, p_opportunity jsonb, p_requirements jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_imp public.opportunity_imports%rowtype; v_opp uuid;
begin
  select * into v_imp from public.opportunity_imports where id = p_id and worker_id = p_worker_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_imp.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'opportunityId', v_imp.opportunity_id, 'repeated', true);
  end if;
  if v_imp.expires_at <= now() then
    update public.opportunity_imports set status = 'expired', content_text = null, draft = null, updated_at = now() where id = p_id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_imp.status <> 'drafted' then return jsonb_build_object('ok', false, 'reason', 'not_ready'); end if;
  if v_imp.draft_version <> p_expected_version then return jsonb_build_object('ok', false, 'reason', 'changed'); end if;
  if jsonb_typeof(p_requirements) is distinct from 'array' or jsonb_array_length(p_requirements) not between 1 and 40 then
    raise exception 'requirements must be an array of 1 to 40 items' using errcode = 'check_violation';
  end if;

  insert into public.opportunities
    (worker_id, title, employer, description, source_url, is_synthetic, import_id, source_kind, location,
     retrieved_at, final_url, import_warnings, removed_count, edited_count)
  values
    (p_worker_id, p_opportunity->>'title', p_opportunity->>'employer', coalesce(p_opportunity->>'description', ''),
     v_imp.submitted_url, false, v_imp.id, v_imp.source_kind, p_opportunity->>'location',
     v_imp.retrieved_at, v_imp.final_url,
     coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_opportunity->'warnings', '[]'::jsonb)) x), '{}'),
     coalesce((p_opportunity->>'removed_count')::integer, 0), coalesce((p_opportunity->>'edited_count')::integer, 0))
  returning id into v_opp;

  insert into public.requirements
    (opportunity_id, position, original_text, criteria_json, mandatory, source, priority, original_priority,
     display_text, source_excerpt, category)
  select v_opp, x.position, x.original_text, x.criteria_json, x.mandatory, x.source, x.priority, x.original_priority,
         x.display_text, x.source_excerpt, x.category
    from jsonb_to_recordset(p_requirements) as x
      (position integer, original_text text, criteria_json jsonb, mandatory boolean, source text, priority text,
       original_priority text, display_text text, source_excerpt text, category text);

  -- The listing text has done its job; keep only what the confirmed requirements quote.
  update public.opportunity_imports
     set status = 'confirmed', opportunity_id = v_opp, confirmed_at = now(), content_text = null, updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'opportunityId', v_opp, 'repeated', false);
end;
$$;

-- Expire stale drafts and drop their listing text. Safe to run any time (no schedule is installed by this migration).
create or replace function public.opportunity_import_expire()
returns integer
language sql
security definer
set search_path = ''
as $$
  with x as (
    update public.opportunity_imports
       set status = 'expired', content_text = null, draft = null, lease_until = null, updated_at = now()
     where expires_at <= now() and status not in ('confirmed', 'expired')
    returning 1
  ) select count(*)::integer from x;
$$;

revoke all on function public.opportunity_import_begin(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.opportunity_import_fetched(uuid, uuid, text, text, text, boolean, text, text[]) from public, anon, authenticated;
revoke all on function public.opportunity_import_fail(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.opportunity_import_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.opportunity_import_drafted(uuid, uuid, jsonb, text[]) from public, anon, authenticated;
revoke all on function public.opportunity_import_save_review(uuid, uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.opportunity_import_confirm(uuid, uuid, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.opportunity_import_expire() from public, anon, authenticated;
grant execute on function public.opportunity_import_begin(uuid, text, text, integer) to service_role;
grant execute on function public.opportunity_import_fetched(uuid, uuid, text, text, text, boolean, text, text[]) to service_role;
grant execute on function public.opportunity_import_fail(uuid, uuid, text, text) to service_role;
grant execute on function public.opportunity_import_lease(uuid, uuid) to service_role;
grant execute on function public.opportunity_import_drafted(uuid, uuid, jsonb, text[]) to service_role;
grant execute on function public.opportunity_import_save_review(uuid, uuid, integer, jsonb) to service_role;
grant execute on function public.opportunity_import_confirm(uuid, uuid, integer, jsonb, jsonb) to service_role;
grant execute on function public.opportunity_import_expire() to service_role;
grant select, insert, update, delete on public.opportunity_imports to service_role;
