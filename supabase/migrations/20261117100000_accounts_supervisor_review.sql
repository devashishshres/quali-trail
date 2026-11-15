-- Accounts (worker / supervisor / both) and supervisor review. ADDITIVE. Not applied to any shared project.
--
-- Authorization model
--   * A WORKER is an auth user with a workers row (existing). A SUPERVISOR is an auth user with a
--     supervisor_profiles row. One person can be both. Neither role grants access to anyone else's data.
--   * A supervisor sees a worker's job ONLY through: an ACCEPTED supervisor_relationships row for that
--     (worker, supervisor account) AND a review_requests row addressed to that account. Revoking the
--     relationship stops access and closes pending requests; completed reviews are kept.
--   * Accepting an invitation requires the signed-in account's CONFIRMED email to equal the invited email,
--     and the account must not be the worker's own (no self-review). A forwarded link is useless to anyone else.
--   * Customer sign-off (token + emailed code, no account) is a separate path and shares nothing but the
--     suppression list and rate limiter.
--   * Supervisor details (name, organization, title) are self-entered and NOT verified. A review records
--     what the supervisor said they observed or reviewed; it never changes verification_status.

alter table public.workers
  add column if not exists employment_arrangement text
    check (employment_arrangement is null or employment_arrangement in
           ('employee','contractor','self_employed','apprentice','other'));

create table public.supervisor_profiles (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  organization text check (organization is null or char_length(organization) <= 200),
  title        text check (title is null or char_length(title) <= 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.supervisor_profiles enable row level security;
create policy supervisor_profiles_select_own on public.supervisor_profiles
  for select to authenticated using (auth_user_id = auth.uid());
revoke insert, update, delete on public.supervisor_profiles from anon, authenticated;
revoke all on public.supervisor_profiles from anon;

create table public.supervisor_relationships (
  id                      uuid primary key default gen_random_uuid(),
  worker_id               uuid not null references public.workers (id) on delete restrict,
  -- The invited address is needed only until the invitation is accepted or closed.
  invited_email           text check (invited_email is null or char_length(invited_email) <= 320),
  invited_email_hash      text,
  email_hint              text,
  token_hash              text unique,
  status                  text not null default 'pending'
                            check (status in ('pending','accepted','declined','revoked','expired')),
  supervisor_auth_user_id uuid references auth.users (id) on delete restrict,
  expires_at              timestamptz not null,
  invite_send_count       integer not null default 1,
  last_invited_at         timestamptz not null default now(),
  accepted_at             timestamptz,
  closed_at               timestamptz,
  pii_purged_at           timestamptz,
  created_at              timestamptz not null default now(),
  check (status <> 'accepted' or (supervisor_auth_user_id is not null and accepted_at is not null))
);
create index supervisor_relationships_worker_idx on public.supervisor_relationships (worker_id, created_at desc);
create index supervisor_relationships_supervisor_idx on public.supervisor_relationships (supervisor_auth_user_id) where supervisor_auth_user_id is not null;
create unique index supervisor_relationships_one_accepted on public.supervisor_relationships (worker_id, supervisor_auth_user_id) where status = 'accepted';
create unique index supervisor_relationships_one_pending on public.supervisor_relationships (worker_id, invited_email_hash) where status = 'pending';

create table public.review_requests (
  id                      uuid primary key default gen_random_uuid(),
  worker_id               uuid not null,
  evidence_id             uuid not null,
  evidence_version        integer not null,
  snapshot                jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash           text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  file_hash               text not null,
  has_original            boolean not null,
  relationship_id         uuid not null references public.supervisor_relationships (id) on delete restrict,
  supervisor_auth_user_id uuid not null references auth.users (id) on delete restrict,
  status                  text not null default 'pending' check (status in
                            ('pending','confirmed_observed','confirmed_documents','correction_requested',
                             'declined','revoked','superseded','expired')),
  expires_at              timestamptz not null,
  reminder_count          integer not null default 0,
  last_notified_at        timestamptz not null default now(),
  closed_at               timestamptz,
  created_at              timestamptz not null default now(),
  foreign key (evidence_id, worker_id) references public.evidence (id, worker_id) on delete restrict
);
create index review_requests_worker_idx on public.review_requests (worker_id, created_at desc);
create index review_requests_supervisor_idx on public.review_requests (supervisor_auth_user_id, status, created_at desc);
create unique index review_requests_one_pending on public.review_requests (evidence_id, relationship_id) where status = 'pending';

create table public.review_responses (
  id                     uuid primary key default gen_random_uuid(),
  request_id             uuid not null unique references public.review_requests (id) on delete restrict,
  decision               text not null check (decision in
                           ('confirm_observed','confirm_documents_reviewed','request_correction','decline')),
  -- Exactly which listed tasks the supervisor said they personally observed.
  observed_tasks         jsonb not null default '[]'::jsonb check (jsonb_typeof(observed_tasks) = 'array'),
  comment                text check (comment is null or char_length(comment) <= 2000),
  statement_version      text not null,
  snapshot_hash          text not null,
  evidence_version       integer not null,
  reviewer_auth_user_id  uuid not null,
  -- Self-entered at the time of review, kept with the review. Not verified.
  reviewer_name          text not null,
  reviewer_organization  text,
  reviewer_title         text,
  created_at             timestamptz not null default now(),
  check (decision <> 'confirm_observed' or jsonb_array_length(observed_tasks) >= 1),
  check (decision = 'confirm_observed' or jsonb_array_length(observed_tasks) = 0)
);

create table public.review_events (
  id          bigint generated always as identity primary key,
  request_id  uuid references public.review_requests (id) on delete restrict,
  relationship_id uuid references public.supervisor_relationships (id) on delete restrict,
  event       text not null check (char_length(event) <= 60),
  detail      text check (detail is null or char_length(detail) <= 200),
  created_at  timestamptz not null default now()
);

alter table public.supervisor_relationships enable row level security;
alter table public.review_requests          enable row level security;
alter table public.review_responses         enable row level security;
alter table public.review_events            enable row level security;
revoke all on public.supervisor_relationships, public.review_requests, public.review_responses, public.review_events
  from public, anon, authenticated;
revoke all on sequence public.review_events_id_seq from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Immutability
-- ------------------------------------------------------------------

create or replace function public.review_requests_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'review_requests rows are not deleted' using errcode = 'check_violation'; end if;
  if (new.worker_id, new.evidence_id, new.evidence_version, new.snapshot, new.snapshot_hash, new.file_hash,
      new.has_original, new.relationship_id, new.supervisor_auth_user_id)
     is distinct from
     (old.worker_id, old.evidence_id, old.evidence_version, old.snapshot, old.snapshot_hash, old.file_hash,
      old.has_original, old.relationship_id, old.supervisor_auth_user_id) then
    raise exception 'the snapshot of a review request is immutable' using errcode = 'check_violation';
  end if;
  if old.status in ('confirmed_observed','confirmed_documents','correction_requested','declined')
     and new.status is distinct from old.status then
    raise exception 'a recorded review cannot change status' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger review_requests_frozen before update or delete on public.review_requests
  for each row execute function public.review_requests_frozen();

create or replace function public.review_responses_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'a recorded review is immutable' using errcode = 'check_violation';
end;
$$;
create trigger review_responses_frozen before update or delete on public.review_responses
  for each row execute function public.review_responses_frozen();

-- Replaces the sign-off version: an edited record supersedes BOTH kinds of open request.
create or replace function public.evidence_supersede_signoffs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  with closed as (
    update public.signoff_requests set status = 'superseded', closed_at = now()
     where evidence_id = new.id and status = 'pending'
    returning id)
  insert into public.signoff_events (request_id, event, detail) select id, 'superseded', 'evidence changed' from closed;
  with closed as (
    update public.review_requests set status = 'superseded', closed_at = now()
     where evidence_id = new.id and status = 'pending'
    returning id)
  insert into public.review_events (request_id, event, detail) select id, 'superseded', 'evidence changed' from closed;
  return new;
end;
$$;

-- ------------------------------------------------------------------
-- Onboarding (idempotent)
-- ------------------------------------------------------------------

create or replace function public.account_onboard_worker(
  p_auth uuid, p_name text, p_trade text, p_summary text, p_arrangement text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare wid uuid; created boolean := false;
begin
  select id into wid from public.workers where auth_user_id = p_auth;
  if wid is null then
    insert into public.workers (auth_user_id, name, trade, summary, employment_arrangement, is_synthetic)
      values (p_auth, btrim(p_name), btrim(p_trade), nullif(btrim(coalesce(p_summary, '')), ''), p_arrangement, false)
      on conflict (auth_user_id) do nothing
      returning id into wid;
    created := wid is not null;
    if wid is null then select id into wid from public.workers where auth_user_id = p_auth; end if;
  end if;
  return jsonb_build_object('ok', true, 'workerId', wid, 'created', created);
end;
$$;

create or replace function public.account_onboard_supervisor(p_auth uuid, p_name text, p_org text, p_title text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare created boolean;
begin
  insert into public.supervisor_profiles (auth_user_id, name, organization, title)
    values (p_auth, btrim(p_name), nullif(btrim(coalesce(p_org, '')), ''), nullif(btrim(coalesce(p_title, '')), ''))
    on conflict (auth_user_id) do nothing;
  get diagnostics created = row_count;
  return jsonb_build_object('ok', true, 'created', created);
end;
$$;

-- An address may sign up while it holds an open supervisor invitation (invite-only signup).
create or replace function public.account_has_pending_invite(p_email_hash text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.supervisor_relationships
                  where invited_email_hash = p_email_hash and status = 'pending' and expires_at > now());
$$;

-- ------------------------------------------------------------------
-- Supervisor invitations
-- ------------------------------------------------------------------

create or replace function public.sup_invite_create(
  p_worker uuid, p_email text, p_email_hash text, p_hint text, p_token_hash text, p_valid_days integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.workers%rowtype; new_id uuid; own_email text;
begin
  select * into w from public.workers where id = p_worker;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select lower(email) into own_email from auth.users where id = w.auth_user_id;
  if own_email = lower(p_email) then return jsonb_build_object('ok', false, 'reason', 'own_email'); end if;
  if exists (select 1 from public.signoff_suppressions where email_hash = p_email_hash) then
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  if exists (select 1 from public.supervisor_relationships r join auth.users u on u.id = r.supervisor_auth_user_id
              where r.worker_id = p_worker and r.status = 'accepted' and lower(u.email) = lower(p_email)) then
    return jsonb_build_object('ok', false, 'reason', 'already_connected');
  end if;
  if exists (select 1 from public.supervisor_relationships where worker_id = p_worker and invited_email_hash = p_email_hash and status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_open');
  end if;
  if (select count(*) from public.supervisor_relationships where worker_id = p_worker and created_at > now() - interval '1 day') >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  insert into public.supervisor_relationships (worker_id, invited_email, invited_email_hash, email_hint, token_hash, expires_at)
    values (p_worker, lower(p_email), p_email_hash, p_hint, p_token_hash, now() + make_interval(days => greatest(1, least(p_valid_days, 30))))
    returning id into new_id;
  insert into public.review_events (relationship_id, event) values (new_id, 'invited');
  return jsonb_build_object('ok', true, 'id', new_id, 'workerName', w.name);
end;
$$;

-- Minimal facts for the invitation page. Expires lazily.
create or replace function public.sup_invite_peek(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.supervisor_relationships%rowtype; wname text;
begin
  select * into r from public.supervisor_relationships where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.status = 'pending' and r.expires_at <= now() then
    update public.supervisor_relationships set status = 'expired', closed_at = now() where id = r.id;
    r.status := 'expired';
  end if;
  select name into wname from public.workers where id = r.worker_id;
  return jsonb_build_object('ok', true, 'status', r.status, 'workerName', wname, 'emailHint', r.email_hint);
end;
$$;

-- Accept or decline. The CALLER's confirmed account email must equal the invited address.
create or replace function public.sup_invite_answer(p_token_hash text, p_auth uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.supervisor_relationships%rowtype; u record; worker_auth uuid;
begin
  select * into r from public.supervisor_relationships where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select id, lower(email) as email, email_confirmed_at into u from auth.users where id = p_auth;
  if not found or u.email_confirmed_at is null then return jsonb_build_object('ok', false, 'reason', 'email_unconfirmed'); end if;
  select auth_user_id into worker_auth from public.workers where id = r.worker_id;
  if worker_auth = p_auth then return jsonb_build_object('ok', false, 'reason', 'self'); end if;

  if r.status = 'accepted' and r.supervisor_auth_user_id = p_auth and p_accept then
    return jsonb_build_object('ok', true, 'repeated', true, 'relationshipId', r.id);
  end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', r.status); end if;
  if r.expires_at <= now() then
    update public.supervisor_relationships set status = 'expired', closed_at = now() where id = r.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if r.invited_email is null or r.invited_email <> u.email then
    return jsonb_build_object('ok', false, 'reason', 'wrong_account');
  end if;

  if not p_accept then
    update public.supervisor_relationships set status = 'declined', closed_at = now(), token_hash = null where id = r.id;
    insert into public.review_events (relationship_id, event) values (r.id, 'declined');
    return jsonb_build_object('ok', true, 'status', 'declined');
  end if;
  if not exists (select 1 from public.supervisor_profiles where auth_user_id = p_auth) then
    return jsonb_build_object('ok', false, 'reason', 'needs_profile');
  end if;
  if exists (select 1 from public.supervisor_relationships where worker_id = r.worker_id and supervisor_auth_user_id = p_auth and status = 'accepted') then
    update public.supervisor_relationships set status = 'declined', closed_at = now(), token_hash = null where id = r.id;
    return jsonb_build_object('ok', false, 'reason', 'already_connected');
  end if;
  -- Accepted: the address has done its job; keep only the masked hint.
  update public.supervisor_relationships
     set status = 'accepted', supervisor_auth_user_id = p_auth, accepted_at = now(),
         invited_email = null, token_hash = null
   where id = r.id;
  insert into public.review_events (relationship_id, event) values (r.id, 'accepted');
  return jsonb_build_object('ok', true, 'status', 'accepted', 'relationshipId', r.id);
end;
$$;

-- Either side may end the relationship. Pending reviews close; completed reviews are kept.
create or replace function public.sup_relationship_revoke(p_auth uuid, p_relationship uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.supervisor_relationships%rowtype; worker_auth uuid; n integer;
begin
  select * into r from public.supervisor_relationships where id = p_relationship for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select auth_user_id into worker_auth from public.workers where id = r.worker_id;
  if p_auth is distinct from worker_auth and p_auth is distinct from r.supervisor_auth_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status not in ('pending','accepted') then return jsonb_build_object('ok', false, 'reason', r.status); end if;
  update public.supervisor_relationships set status = 'revoked', closed_at = now(), token_hash = null where id = r.id;
  with closed as (
    update public.review_requests set status = 'revoked', closed_at = now()
     where relationship_id = r.id and status = 'pending' returning id)
  select count(*) into n from closed;
  insert into public.review_events (relationship_id, event, detail)
    values (r.id, 'revoked', case when p_auth = worker_auth then 'by worker' else 'by supervisor' end);
  return jsonb_build_object('ok', true, 'closedReviews', n);
end;
$$;

-- Reminder for a pending invitation: rotates the token. One a day, three in total.
create or replace function public.sup_invite_rotate(p_worker uuid, p_relationship uuid, p_new_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.supervisor_relationships%rowtype;
begin
  select * into r from public.supervisor_relationships where id = p_relationship and worker_id = p_worker for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status <> 'pending' or r.expires_at <= now() or r.invited_email is null then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if r.invite_send_count >= 4 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  if r.last_invited_at > now() - interval '1 day' then return jsonb_build_object('ok', false, 'reason', 'too_soon'); end if;
  if exists (select 1 from public.signoff_suppressions where email_hash = r.invited_email_hash) then
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  update public.supervisor_relationships
     set token_hash = p_new_token_hash, invite_send_count = invite_send_count + 1, last_invited_at = now()
   where id = r.id;
  return jsonb_build_object('ok', true, 'email', r.invited_email,
    'workerName', (select name from public.workers where id = r.worker_id));
end;
$$;

-- ------------------------------------------------------------------
-- Review requests
-- ------------------------------------------------------------------

create or replace function public.review_create(p_worker uuid, p_evidence uuid, p_relationship uuid, p_valid_days integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.evidence%rowtype; w public.workers%rowtype; r public.supervisor_relationships%rowtype; snap jsonb; new_id uuid;
begin
  select * into e from public.evidence where id = p_evidence and worker_id = p_worker for share;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into r from public.supervisor_relationships where id = p_relationship and worker_id = p_worker for share;
  if not found or r.status <> 'accepted' then return jsonb_build_object('ok', false, 'reason', 'no_relationship'); end if;
  select * into w from public.workers where id = p_worker;
  if r.supervisor_auth_user_id = w.auth_user_id then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  if e.type not in ('work_record','checklist') then return jsonb_build_object('ok', false, 'reason', 'unsupported_type'); end if;
  if e.verification_status not in ('self_reported','document_supplied') then return jsonb_build_object('ok', false, 'reason', 'not_eligible'); end if;
  if exists (select 1 from public.review_requests where evidence_id = e.id and relationship_id = r.id and status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_open');
  end if;

  snap := jsonb_build_object(
    'workerName', w.name, 'type', e.type, 'title', e.title, 'date', e.source_date, 'issuer', e.issuer,
    'skills', coalesce(e.structured_data -> 'skills', '[]'::jsonb),
    'activities', coalesce(e.structured_data -> 'activities', '[]'::jsonb),
    'equipment', coalesce(e.structured_data -> 'equipment', '[]'::jsonb),
    'summary', e.structured_data -> 'summary',
    'sourceKind', e.source_kind, 'recordVersion', e.version);
  insert into public.review_requests
    (worker_id, evidence_id, evidence_version, snapshot, snapshot_hash, file_hash, has_original,
     relationship_id, supervisor_auth_user_id, expires_at)
  values
    (p_worker, e.id, e.version, snap, encode(sha256(convert_to(snap::text, 'utf8')), 'hex'), e.file_hash, e.storage_path is not null,
     r.id, r.supervisor_auth_user_id, now() + make_interval(days => greatest(1, least(p_valid_days, 60))))
  returning id into new_id;
  insert into public.review_events (request_id, relationship_id, event) values (new_id, r.id, 'requested');
  return jsonb_build_object('ok', true, 'id', new_id, 'supervisorAuthUserId', r.supervisor_auth_user_id, 'workerName', w.name, 'title', e.title);
end;
$$;

-- What a supervisor may see: requests addressed to them under a relationship that is STILL accepted.
create or replace function public.review_list_for_supervisor(p_auth uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'workerName', q.snapshot ->> 'workerName', 'title', q.snapshot ->> 'title',
           'date', q.snapshot ->> 'date', 'status', case when q.status = 'pending' and q.expires_at <= now() then 'expired' else q.status end,
           'createdAt', q.created_at, 'expiresAt', q.expires_at) order by q.created_at desc), '[]'::jsonb)
    from public.review_requests q
    join public.supervisor_relationships r on r.id = q.relationship_id
   where q.supervisor_auth_user_id = p_auth and r.status = 'accepted' and r.supervisor_auth_user_id = p_auth;
$$;

create or replace function public.review_get(p_auth uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.review_requests%rowtype; rel public.supervisor_relationships%rowtype; resp public.review_responses%rowtype;
begin
  select * into q from public.review_requests where id = p_request;
  if not found or q.supervisor_auth_user_id is distinct from p_auth then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into rel from public.supervisor_relationships where id = q.relationship_id;
  if rel.status <> 'accepted' or rel.supervisor_auth_user_id is distinct from p_auth then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into resp from public.review_responses where request_id = q.id;
  return jsonb_build_object('ok', true, 'id', q.id,
    'status', case when q.status = 'pending' and q.expires_at <= now() then 'expired' else q.status end,
    'snapshot', q.snapshot, 'hasOriginal', q.has_original, 'createdAt', q.created_at, 'expiresAt', q.expires_at,
    'response', case when resp.id is null then null else jsonb_build_object(
      'decision', resp.decision, 'observedTasks', resp.observed_tasks, 'comment', resp.comment, 'createdAt', resp.created_at) end);
end;
$$;

-- Storage path of the original, only for the addressed supervisor, while pending, and only if the record
-- has not changed since the request (so the document is the one the snapshot describes).
create or replace function public.review_document_path(p_auth uuid, p_request uuid)
returns text language sql security definer set search_path = '' as $$
  select e.storage_path
    from public.review_requests q
    join public.supervisor_relationships r on r.id = q.relationship_id
    join public.evidence e on e.id = q.evidence_id and e.worker_id = q.worker_id
   where q.id = p_request and q.supervisor_auth_user_id = p_auth
     and r.status = 'accepted' and r.supervisor_auth_user_id = p_auth
     and q.status = 'pending' and q.expires_at > now()
     and e.version = q.evidence_version and e.file_hash = q.file_hash;
$$;

-- Record a supervisor decision atomically. Lock order: evidence, relationship, request.
create or replace function public.review_respond(
  p_auth uuid, p_request uuid, p_decision text, p_observed jsonb, p_comment text, p_statement_version text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ev uuid; wid uuid; relid uuid; ev_version integer;
  q public.review_requests%rowtype; rel public.supervisor_relationships%rowtype; prof public.supervisor_profiles%rowtype;
  existing public.review_responses%rowtype; tasks jsonb; new_status text;
begin
  if p_decision not in ('confirm_observed','confirm_documents_reviewed','request_correction','decline') then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select evidence_id, worker_id, relationship_id into ev, wid, relid from public.review_requests where id = p_request;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select version into ev_version from public.evidence where id = ev and worker_id = wid for share;
  select * into rel from public.supervisor_relationships where id = relid for share;
  select * into q from public.review_requests where id = p_request for update;

  if q.supervisor_auth_user_id is distinct from p_auth or rel.supervisor_auth_user_id is distinct from p_auth then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  tasks := case when p_decision = 'confirm_observed' then coalesce(p_observed, '[]'::jsonb) else '[]'::jsonb end;

  select * into existing from public.review_responses where request_id = q.id;
  if found then
    if existing.decision = p_decision and existing.observed_tasks = tasks then return jsonb_build_object('ok', true, 'repeated', true); end if;
    return jsonb_build_object('ok', false, 'reason', 'already_responded');
  end if;
  if rel.status <> 'accepted' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if q.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', q.status); end if;
  if q.expires_at <= now() then
    update public.review_requests set status = 'expired', closed_at = now() where id = q.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if ev_version is distinct from q.evidence_version then
    update public.review_requests set status = 'superseded', closed_at = now() where id = q.id;
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;
  if (select auth_user_id from public.workers where id = q.worker_id) = p_auth then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;

  if p_decision = 'confirm_observed' then
    if jsonb_typeof(tasks) <> 'array' or jsonb_array_length(tasks) = 0 then return jsonb_build_object('ok', false, 'reason', 'tasks_required'); end if;
    -- Every task must be one of the activities in the frozen snapshot, listed once.
    if exists (select 1 from jsonb_array_elements(tasks) t where jsonb_typeof(t) <> 'string' or not ((q.snapshot -> 'activities') @> jsonb_build_array(t)))
       or (select count(distinct t) from jsonb_array_elements_text(tasks) t) <> jsonb_array_length(tasks) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_task');
    end if;
  end if;
  if p_decision = 'confirm_documents_reviewed' and not q.has_original then
    return jsonb_build_object('ok', false, 'reason', 'no_document');
  end if;
  if p_decision = 'request_correction' and char_length(btrim(coalesce(p_comment, ''))) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'comment_required');
  end if;

  select * into prof from public.supervisor_profiles where auth_user_id = p_auth;
  if not found then return jsonb_build_object('ok', false, 'reason', 'needs_profile'); end if;

  insert into public.review_responses
    (request_id, decision, observed_tasks, comment, statement_version, snapshot_hash, evidence_version,
     reviewer_auth_user_id, reviewer_name, reviewer_organization, reviewer_title)
  values
    (q.id, p_decision, tasks, nullif(btrim(coalesce(p_comment, '')), ''), p_statement_version, q.snapshot_hash, q.evidence_version,
     p_auth, prof.name, prof.organization, prof.title);
  new_status := case p_decision when 'confirm_observed' then 'confirmed_observed' when 'confirm_documents_reviewed' then 'confirmed_documents'
                                when 'request_correction' then 'correction_requested' else 'declined' end;
  update public.review_requests set status = new_status, closed_at = now() where id = q.id;
  insert into public.review_events (request_id, relationship_id, event, detail) values (q.id, rel.id, 'responded', p_decision);
  return jsonb_build_object('ok', true, 'repeated', false, 'status', new_status, 'workerId', q.worker_id, 'title', q.snapshot ->> 'title');
end;
$$;

create or replace function public.review_revoke(p_worker uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.review_requests%rowtype;
begin
  select * into q from public.review_requests where id = p_request and worker_id = p_worker for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if q.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', q.status); end if;
  update public.review_requests set status = 'revoked', closed_at = now() where id = q.id;
  insert into public.review_events (request_id, event) values (q.id, 'revoked');
  return jsonb_build_object('ok', true);
end;
$$;

-- Manual reminder to the supervisor: one a day, three in total, only while pending and still authorized.
create or replace function public.review_remind(p_worker uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.review_requests%rowtype;
begin
  select * into q from public.review_requests where id = p_request and worker_id = p_worker for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if q.status <> 'pending' or q.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if not exists (select 1 from public.supervisor_relationships where id = q.relationship_id and status = 'accepted') then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  if q.reminder_count >= 3 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  if q.last_notified_at > now() - interval '1 day' then return jsonb_build_object('ok', false, 'reason', 'too_soon'); end if;
  update public.review_requests set reminder_count = reminder_count + 1, last_notified_at = now() where id = q.id;
  return jsonb_build_object('ok', true, 'supervisorAuthUserId', q.supervisor_auth_user_id, 'reminder', q.reminder_count + 1);
end;
$$;

create or replace function public.review_expire_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare a integer; b integer;
begin
  update public.review_requests set status = 'expired', closed_at = now() where status = 'pending' and expires_at <= now();
  get diagnostics a = row_count;
  update public.supervisor_relationships set status = 'expired', closed_at = now(), token_hash = null where status = 'pending' and expires_at <= now();
  get diagnostics b = row_count;
  return a + b;
end;
$$;

-- Retention for supervisor invitations: an unaccepted invitation's address is removed 90 days after it closes.
-- (An accepted invitation's address is removed at acceptance.) Reviews are kept: they are professional records
-- the worker relies on, and they hold the supervisor's self-entered name, which is personal information.
create or replace function public.sup_purge_pii(p_days integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform public.review_expire_due();
  update public.supervisor_relationships
     set invited_email = null, invited_email_hash = null, email_hint = null, pii_purged_at = now()
   where closed_at <= now() - make_interval(days => greatest(p_days, 1)) and pii_purged_at is null and status <> 'accepted';
  get diagnostics n = row_count;
  return n;
end;
$$;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (p.proname like 'sup\_%' or p.proname like 'review\_%' or p.proname like 'account\_%')
              and p.proname not in ('review_requests_frozen','review_responses_frozen')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
