-- Customer sign-off (Phase 1). ADDITIVE: new tables and functions only.
-- Not applied to any shared project. Tested on a disposable local PostgreSQL.
--
-- What a decision means: a person who received a code at the address the worker
-- provided entered that code, then acknowledged a snapshot of one work record or
-- checklist. It does NOT make the record independently confirmed and nothing here
-- touches evidence.verification_status.
--
-- Privacy: tokens, codes and session tokens are stored only as HMAC hashes (the
-- application holds the pepper). Customer email/name are held only until the
-- retention purge (signoff_purge_pii). No client role can read these tables;
-- every function is service-role only and returns jsonb {ok, reason}.

create table public.signoff_requests (
  id                  uuid primary key default gen_random_uuid(),
  worker_id           uuid not null references public.workers (id) on delete restrict,
  evidence_id         uuid not null,
  evidence_version    integer not null,
  snapshot            jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash       text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  file_hash           text not null,
  -- Personal data: removed by signoff_purge_pii.
  customer_email      text check (customer_email is null or char_length(customer_email) <= 320),
  customer_name       text check (customer_name is null or char_length(customer_name) <= 200),
  customer_email_hash text,
  email_hint          text,
  token_hash          text not null unique,
  signer_role         text not null default 'customer' check (signer_role = 'customer'),
  status              text not null default 'pending' check (status in
                        ('pending','acknowledged','correction_requested','declined',
                         'expired','revoked','superseded','locked')),
  delivery_mode       text not null check (delivery_mode in ('resend','mock')),
  expires_at          timestamptz not null,
  invite_send_count   integer not null default 1,
  failed_total        integer not null default 0,
  verified_session_id uuid,
  email_verified_at   timestamptz,
  pii_purged_at       timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  foreign key (evidence_id, worker_id) references public.evidence (id, worker_id) on delete restrict,
  -- A decision exists only after a code-verified session. A link alone never gets here.
  check (status not in ('acknowledged','correction_requested','declined')
         or (verified_session_id is not null and email_verified_at is not null))
);
create index signoff_requests_worker_idx on public.signoff_requests (worker_id, created_at desc);
create index signoff_requests_evidence_idx on public.signoff_requests (evidence_id, status);
create index signoff_requests_email_hash_idx on public.signoff_requests (customer_email_hash) where customer_email_hash is not null;

create table public.signoff_codes (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.signoff_requests (id) on delete cascade,
  code_hash      text not null,
  expires_at     timestamptz not null,
  attempts       integer not null default 0,
  used_at        timestamptz,
  invalidated_at timestamptz,
  created_at     timestamptz not null default now()
);
create index signoff_codes_request_idx on public.signoff_codes (request_id, created_at desc);
-- At most one usable code per request: a new code invalidates the earlier one first.
create unique index signoff_codes_one_active on public.signoff_codes (request_id)
  where used_at is null and invalidated_at is null;

create table public.signoff_sessions (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.signoff_requests (id) on delete cascade,
  session_hash text not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table public.signoff_responses (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null unique references public.signoff_requests (id) on delete restrict,
  decision          text not null check (decision in ('confirm','request_correction','decline')),
  -- A typed signature is itself personal information; see signoff_purge_pii.
  typed_name        text check (typed_name is null or char_length(typed_name) between 2 and 200),
  comment           text check (comment is null or char_length(comment) <= 1000),
  statement_version text not null,
  snapshot_hash     text not null,
  evidence_version  integer not null,
  session_id        uuid not null,
  created_at        timestamptz not null default now(),
  check (decision <> 'confirm' or typed_name is not null)
);

-- Audit trail. Event names and provider message ids only: no addresses, tokens or codes.
create table public.signoff_events (
  id          bigint generated always as identity primary key,
  request_id  uuid references public.signoff_requests (id) on delete restrict,
  event       text not null check (char_length(event) <= 60),
  detail      text check (detail is null or char_length(detail) <= 200),
  created_at  timestamptz not null default now()
);
create index signoff_events_request_idx on public.signoff_events (request_id, id);

create table public.signoff_rate_limits (
  key_hash     text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key_hash, window_start)
);

create table public.signoff_suppressions (
  email_hash          text primary key,
  reason              text not null check (reason in ('bounce','complaint','opt_out','manual')),
  provider_message_id text,
  created_at          timestamptz not null default now()
);

alter table public.signoff_requests     enable row level security;
alter table public.signoff_codes        enable row level security;
alter table public.signoff_sessions     enable row level security;
alter table public.signoff_responses    enable row level security;
alter table public.signoff_events       enable row level security;
alter table public.signoff_rate_limits  enable row level security;
alter table public.signoff_suppressions enable row level security;
revoke all on public.signoff_requests, public.signoff_codes, public.signoff_sessions, public.signoff_responses,
  public.signoff_events, public.signoff_rate_limits, public.signoff_suppressions from public, anon, authenticated;
revoke all on sequence public.signoff_events_id_seq from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Immutability
-- ------------------------------------------------------------------

create or replace function public.signoff_requests_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'signoff_requests rows are not deleted' using errcode = 'check_violation';
  end if;
  if (new.worker_id, new.evidence_id, new.evidence_version, new.snapshot, new.snapshot_hash, new.file_hash, new.signer_role)
     is distinct from
     (old.worker_id, old.evidence_id, old.evidence_version, old.snapshot, old.snapshot_hash, old.file_hash, old.signer_role)
  then
    raise exception 'the snapshot of a sign-off request is immutable' using errcode = 'check_violation';
  end if;
  -- Terminal states are final.
  if old.status in ('acknowledged','correction_requested','declined') and new.status is distinct from old.status then
    raise exception 'a recorded decision cannot change status' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger signoff_requests_frozen before update or delete on public.signoff_requests
  for each row execute function public.signoff_requests_frozen();

create or replace function public.signoff_responses_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'signoff_responses rows are not deleted' using errcode = 'check_violation';
  end if;
  -- The only permitted change is removing the free-text comment (retention purge).
  if (new.request_id, new.decision, new.typed_name, new.statement_version, new.snapshot_hash, new.evidence_version, new.session_id, new.created_at)
     is distinct from
     (old.request_id, old.decision, old.typed_name, old.statement_version, old.snapshot_hash, old.evidence_version, old.session_id, old.created_at)
     or (new.comment is not null and new.comment is distinct from old.comment)
  then
    raise exception 'a recorded response is immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger signoff_responses_frozen before update or delete on public.signoff_responses
  for each row execute function public.signoff_responses_frozen();

-- Any change to the record's content or verification bumps its version (existing trigger).
-- An open request then no longer describes the current record.
create or replace function public.evidence_supersede_signoffs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.signoff_requests
     set status = 'superseded', closed_at = now()
   where evidence_id = new.id and status = 'pending';
  insert into public.signoff_events (request_id, event, detail)
    select id, 'superseded', 'evidence changed' from public.signoff_requests
     where evidence_id = new.id and status = 'superseded' and closed_at >= now() - interval '1 second';
  return new;
end;
$$;
create trigger evidence_supersede_signoffs after update on public.evidence
  for each row when (old.version is distinct from new.version)
  execute function public.evidence_supersede_signoffs();

-- ------------------------------------------------------------------
-- Functions (service role only)
-- ------------------------------------------------------------------

-- Worker creates a request. The snapshot is built HERE from the stored row, never from client input.
create or replace function public.signoff_create_request(
  p_worker uuid, p_evidence uuid, p_email text, p_name text, p_email_hash text,
  p_hint text, p_token_hash text, p_delivery_mode text, p_worker_email_hash text, p_valid_days integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.evidence%rowtype;
  w public.workers%rowtype;
  snap jsonb;
  new_id uuid;
begin
  select * into e from public.evidence where id = p_evidence and worker_id = p_worker for share;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into w from public.workers where id = p_worker;
  if e.type not in ('work_record','checklist') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_type');
  end if;
  if e.verification_status not in ('self_reported','document_supplied') then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;
  if p_worker_email_hash is not null and p_worker_email_hash = p_email_hash then
    return jsonb_build_object('ok', false, 'reason', 'own_email');
  end if;
  if exists (select 1 from public.signoff_suppressions where email_hash = p_email_hash) then
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  if exists (select 1 from public.signoff_requests where evidence_id = e.id and status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_open');
  end if;
  if exists (select 1 from public.signoff_requests
              where evidence_id = e.id and evidence_version = e.version and status = 'declined'
                and customer_email_hash = p_email_hash) then
    return jsonb_build_object('ok', false, 'reason', 'declined_same_version');
  end if;
  if (select count(*) from public.signoff_requests where evidence_id = e.id and customer_email_hash = p_email_hash) >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'cap_reached');
  end if;

  snap := jsonb_build_object(
    'workerName', w.name,
    'type', e.type,
    'title', e.title,
    'date', e.source_date,
    'issuer', e.issuer,
    'skills', coalesce(e.structured_data -> 'skills', '[]'::jsonb),
    'activities', coalesce(e.structured_data -> 'activities', '[]'::jsonb),
    'equipment', coalesce(e.structured_data -> 'equipment', '[]'::jsonb),
    'summary', e.structured_data -> 'summary',
    'recordVersion', e.version);

  insert into public.signoff_requests
    (worker_id, evidence_id, evidence_version, snapshot, snapshot_hash, file_hash, customer_email, customer_name,
     customer_email_hash, email_hint, token_hash, delivery_mode, expires_at)
  values
    (p_worker, e.id, e.version, snap, encode(sha256(convert_to(snap::text, 'utf8')), 'hex'), e.file_hash,
     p_email, nullif(p_name, ''), p_email_hash, p_hint, p_token_hash, p_delivery_mode,
     now() + make_interval(days => greatest(1, least(p_valid_days, 30))))
  returning id into new_id;
  insert into public.signoff_events (request_id, event) values (new_id, 'created');
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

-- Minimal gate page data. Reveals only the worker's name, a masked address hint and the status.
create or replace function public.signoff_gate(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.signoff_requests%rowtype;
begin
  select * into r from public.signoff_requests where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.status = 'pending' and r.expires_at <= now() then
    update public.signoff_requests set status = 'expired', closed_at = now() where id = r.id;
    insert into public.signoff_events (request_id, event) values (r.id, 'expired');
    r.status := 'expired';
  end if;
  return jsonb_build_object('ok', true, 'status', r.status, 'workerName', r.snapshot ->> 'workerName',
    'emailHint', r.email_hint, 'deliveryMode', r.delivery_mode);
end;
$$;

-- Issue (or reissue) a code. Earlier codes are invalidated. Returns the address to mail, to the server only.
create or replace function public.signoff_issue_code(p_token_hash text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.signoff_requests%rowtype; last_at timestamptz; recent integer;
begin
  select * into r from public.signoff_requests where token_hash = p_token_hash for update;
  if not found or r.status <> 'pending' or r.expires_at <= now() or r.customer_email is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select max(created_at), count(*) filter (where created_at > now() - interval '24 hours')
    into last_at, recent from public.signoff_codes where request_id = r.id;
  if last_at is not null and last_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;
  if recent >= 3 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  update public.signoff_codes set invalidated_at = now()
   where request_id = r.id and used_at is null and invalidated_at is null;
  insert into public.signoff_codes (request_id, code_hash, expires_at)
    values (r.id, p_code_hash, now() + interval '10 minutes');
  insert into public.signoff_events (request_id, event) values (r.id, 'code_issued');
  return jsonb_build_object('ok', true, 'requestId', r.id, 'email', r.customer_email,
    'deliveryMode', r.delivery_mode, 'workerName', r.snapshot ->> 'workerName');
end;
$$;

-- Check a code. Single use, 5 tries per code, request locks after 10 failures in total.
-- Every failure looks the same to the caller.
create or replace function public.signoff_verify_code(p_token_hash text, p_code_hash text, p_session_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.signoff_requests%rowtype; c public.signoff_codes%rowtype; sid uuid;
begin
  select * into r from public.signoff_requests where token_hash = p_token_hash for update;
  if not found or r.status <> 'pending' or r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select * into c from public.signoff_codes
   where request_id = r.id and used_at is null and invalidated_at is null for update;
  if not found or c.expires_at <= now() or c.attempts >= 5 then
    update public.signoff_requests set failed_total = failed_total + 1 where id = r.id;
    if r.failed_total + 1 >= 10 then
      update public.signoff_requests set status = 'locked', closed_at = now() where id = r.id;
      insert into public.signoff_events (request_id, event) values (r.id, 'locked');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if c.code_hash <> p_code_hash then
    update public.signoff_codes set attempts = attempts + 1 where id = c.id;
    update public.signoff_requests set failed_total = failed_total + 1 where id = r.id;
    if r.failed_total + 1 >= 10 then
      update public.signoff_requests set status = 'locked', closed_at = now() where id = r.id;
      insert into public.signoff_events (request_id, event) values (r.id, 'locked');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update public.signoff_codes set used_at = now() where id = c.id;
  update public.signoff_sessions set revoked_at = now() where request_id = r.id and revoked_at is null;
  insert into public.signoff_sessions (request_id, session_hash, expires_at)
    values (r.id, p_session_hash, now() + interval '30 minutes') returning id into sid;
  update public.signoff_requests set verified_session_id = sid, email_verified_at = now() where id = r.id;
  insert into public.signoff_events (request_id, event) values (r.id, 'email_verified');
  return jsonb_build_object('ok', true);
end;
$$;

-- Full snapshot: needs the link token AND a live session bound to this request.
create or replace function public.signoff_read_snapshot(p_token_hash text, p_session_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.signoff_requests%rowtype;
begin
  select * into r from public.signoff_requests where token_hash = p_token_hash;
  if not found or not exists (
       select 1 from public.signoff_sessions s
        where s.request_id = r.id and s.session_hash = p_session_hash
          and s.revoked_at is null and s.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  return jsonb_build_object('ok', true, 'status', r.status, 'snapshot', r.snapshot,
    'snapshotHash', r.snapshot_hash, 'deliveryMode', r.delivery_mode,
    'response', (select jsonb_build_object('decision', p.decision, 'createdAt', p.created_at)
                   from public.signoff_responses p where p.request_id = r.id));
end;
$$;

-- Record a decision atomically. Lock order is always evidence, then request.
create or replace function public.signoff_respond(
  p_token_hash text, p_session_hash text, p_decision text, p_typed_name text, p_comment text, p_statement_version text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.signoff_requests%rowtype;
  ev_id uuid; ev_version integer; sid uuid; existing public.signoff_responses%rowtype; new_status text;
begin
  if p_decision not in ('confirm','request_correction','decline') then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select evidence_id into ev_id from public.signoff_requests where token_hash = p_token_hash;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select version into ev_version from public.evidence where id = ev_id for share;
  select * into r from public.signoff_requests where token_hash = p_token_hash for update;

  select s.id into sid from public.signoff_sessions s
   where s.request_id = r.id and s.session_hash = p_session_hash and s.revoked_at is null and s.expires_at > now();
  if sid is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;

  select * into existing from public.signoff_responses where request_id = r.id;
  if found then
    if existing.decision = p_decision then return jsonb_build_object('ok', true, 'repeated', true); end if;
    return jsonb_build_object('ok', false, 'reason', 'already_responded');
  end if;

  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', r.status); end if;
  if r.expires_at <= now() then
    update public.signoff_requests set status = 'expired', closed_at = now() where id = r.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if ev_version is distinct from r.evidence_version then
    update public.signoff_requests set status = 'superseded', closed_at = now() where id = r.id;
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;
  if r.verified_session_id is distinct from sid then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_decision = 'confirm' and (p_typed_name is null or char_length(btrim(p_typed_name)) < 2) then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if p_decision = 'request_correction' and (p_comment is null or char_length(btrim(p_comment)) < 1) then
    return jsonb_build_object('ok', false, 'reason', 'comment_required');
  end if;

  insert into public.signoff_responses (request_id, decision, typed_name, comment, statement_version, snapshot_hash, evidence_version, session_id)
    values (r.id, p_decision, case when p_decision = 'confirm' then btrim(p_typed_name) end,
            nullif(btrim(coalesce(p_comment, '')), ''), p_statement_version, r.snapshot_hash, r.evidence_version, sid);
  new_status := case p_decision when 'confirm' then 'acknowledged' when 'request_correction' then 'correction_requested' else 'declined' end;
  update public.signoff_requests set status = new_status, closed_at = now() where id = r.id;
  update public.signoff_sessions set revoked_at = now() where request_id = r.id and revoked_at is null;
  insert into public.signoff_events (request_id, event, detail) values (r.id, 'responded', p_decision);
  return jsonb_build_object('ok', true, 'repeated', false, 'status', new_status);
end;
$$;

create or replace function public.signoff_revoke_request(p_worker uuid, p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.signoff_requests%rowtype;
begin
  select * into r from public.signoff_requests where id = p_request and worker_id = p_worker for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', r.status); end if;
  update public.signoff_requests set status = 'revoked', closed_at = now() where id = r.id;
  update public.signoff_sessions set revoked_at = now() where request_id = r.id and revoked_at is null;
  update public.signoff_codes set invalidated_at = now() where request_id = r.id and used_at is null and invalidated_at is null;
  insert into public.signoff_events (request_id, event) values (r.id, 'revoked');
  return jsonb_build_object('ok', true);
end;
$$;

-- Resend the invitation: the old link stops working, sessions and codes are dropped.
create or replace function public.signoff_rotate_token(p_worker uuid, p_request uuid, p_new_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.signoff_requests%rowtype;
begin
  select * into r from public.signoff_requests where id = p_request and worker_id = p_worker for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status <> 'pending' or r.expires_at <= now() or r.customer_email is null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if r.invite_send_count >= 5 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  if exists (select 1 from public.signoff_suppressions where email_hash = r.customer_email_hash) then
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  update public.signoff_requests set token_hash = p_new_token_hash, invite_send_count = invite_send_count + 1,
         verified_session_id = null, email_verified_at = null where id = r.id;
  update public.signoff_sessions set revoked_at = now() where request_id = r.id and revoked_at is null;
  update public.signoff_codes set invalidated_at = now() where request_id = r.id and used_at is null and invalidated_at is null;
  insert into public.signoff_events (request_id, event) values (r.id, 'invitation_resent');
  return jsonb_build_object('ok', true, 'email', r.customer_email, 'deliveryMode', r.delivery_mode,
    'workerName', r.snapshot ->> 'workerName');
end;
$$;

create or replace function public.signoff_expire_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with u as (update public.signoff_requests set status = 'expired', closed_at = now()
              where status = 'pending' and expires_at <= now() returning id)
  select count(*) into n from u;
  return n;
end;
$$;

-- Retention. Removes personal data that is no longer needed; keeps the acknowledgment itself.
--   REMOVED:  customer_email, customer_name, customer_email_hash, email_hint (requests);
--             free-text comments (responses); codes, sessions, rate-limit rows.
--   KEPT:     the typed signature (it IS the acknowledgment and is personal information),
--             decision, timestamps, snapshot + hash, evidence version, file hash, event names.
--   Suppression hashes are NOT purged: they honour opt-outs and bounces.
create or replace function public.signoff_purge_pii(p_days integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz := now() - make_interval(days => greatest(p_days, 1)); a integer; b integer; c integer; d integer;
begin
  perform public.signoff_expire_due();
  update public.signoff_responses p set comment = null
    from public.signoff_requests r
   where r.id = p.request_id and r.closed_at <= cutoff and p.comment is not null;
  get diagnostics a = row_count;
  update public.signoff_requests
     set customer_email = null, customer_name = null, customer_email_hash = null, email_hint = null, pii_purged_at = now()
   where closed_at <= cutoff and pii_purged_at is null;
  get diagnostics b = row_count;
  delete from public.signoff_codes where created_at <= cutoff or request_id in (select id from public.signoff_requests where pii_purged_at is not null);
  get diagnostics c = row_count;
  delete from public.signoff_sessions where expires_at <= cutoff;
  delete from public.signoff_rate_limits where window_start <= cutoff;
  get diagnostics d = row_count;
  return jsonb_build_object('requestsPurged', b, 'commentsRemoved', a, 'codesDeleted', c, 'rateLimitRows', d);
end;
$$;

create or replace function public.signoff_add_suppression(p_email_hash text, p_reason text, p_message_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.signoff_suppressions (email_hash, reason, provider_message_id)
    values (p_email_hash, p_reason, p_message_id) on conflict (email_hash) do nothing;
  with u as (update public.signoff_requests set status = 'revoked', closed_at = now()
              where customer_email_hash = p_email_hash and status = 'pending' returning id)
  select count(*) into n from u;
  insert into public.signoff_events (request_id, event, detail)
    select id, 'suppressed', p_reason from public.signoff_requests
     where customer_email_hash = p_email_hash and status = 'revoked' and closed_at >= now() - interval '1 second';
  return jsonb_build_object('ok', true, 'revoked', n);
end;
$$;

-- Fixed-window counter. Keys are HMAC hashes (never raw IPs or addresses).
create or replace function public.signoff_hit_rate_limit(p_key_hash text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare w timestamptz; h integer;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.signoff_rate_limits as l (key_hash, window_start, hits) values (p_key_hash, w, 1)
    on conflict (key_hash, window_start) do update set hits = l.hits + 1
    returning l.hits into h;
  return h <= p_max;
end;
$$;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'signoff\_%' or p.proname = 'evidence_supersede_signoffs')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
