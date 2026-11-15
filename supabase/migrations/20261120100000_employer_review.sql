-- Employer review portal. ADDITIVE. Not applied to any shared project by this change.
--
-- A technician shares ONE frozen packet (a job report plus the records and completed confirmations they chose)
-- with ONE reviewer email address. The reviewer proves they control that address by signing in with it (confirmed
-- email); that is all it proves. Access is read-only, expires, can be withdrawn, and is logged.
--
-- Separation from everything else:
--   * No client role can read or write these tables (RLS on, all privileges revoked). Only the service-role
--     functions below touch them, and each checks the caller explicitly.
--   * Nothing here reads or grants supervisor authority, and no supervisor function reads these tables.
--   * The reviewer never gets a path to worker tables: the packet is a copy made at share time.
--
-- Consent for showing a supervisor's name to an employer is a SEPARATE, insert-only record made at decision time
-- (review_share_consents). Existing review_responses rows are untouched, so no consent is assumed for them.

create table public.employer_shares (
  id                    uuid primary key default gen_random_uuid(),
  worker_id             uuid not null references public.workers (id) on delete restrict,
  -- Provenance only. The packet below is self-contained, so later edits or deletions never change it.
  opportunity_id        uuid not null,
  match_run_id          uuid not null,
  packet_format         text not null check (char_length(packet_format) <= 60),
  packet                jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_hash           text not null check (packet_hash ~ '^[0-9a-f]{64}$'),
  -- [{id, version, fileHash, original}] taken from the evidence table at share time (never from the client).
  shared_records        jsonb not null check (jsonb_typeof(shared_records) = 'array'),
  -- The invited address is needed only until it is used. Cleared on accept, revoke and expiry.
  invited_email         text check (invited_email is null or char_length(invited_email) <= 320),
  invited_email_hash    text not null,
  email_hint            text,
  token_hash            text unique,
  -- After acceptance the token hash moves here. It only ever answers "already accepted" to the SAME account.
  consumed_token_hash   text unique,
  status                text not null default 'pending'
                          check (status in ('pending','active','revoked','expired')),
  reviewer_auth_user_id uuid references auth.users (id) on delete restrict,
  expires_at            timestamptz not null,
  accepted_at           timestamptz,
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  check (status <> 'active' or (reviewer_auth_user_id is not null and accepted_at is not null))
);
create index employer_shares_worker_idx on public.employer_shares (worker_id, created_at desc);
create index employer_shares_reviewer_idx on public.employer_shares (reviewer_auth_user_id, created_at desc) where reviewer_auth_user_id is not null;
create index employer_shares_pending_email_idx on public.employer_shares (invited_email_hash) where status = 'pending';

-- Audit trail: event names only. Never tokens, addresses, signed URLs or packet content.
create table public.employer_share_events (
  id          bigint generated always as identity primary key,
  share_id    uuid not null references public.employer_shares (id) on delete restrict,
  event       text not null check (event in ('invited','accepted','viewed','original_opened','revoked','expired')),
  record_id   uuid,
  created_at  timestamptz not null default now()
);
create index employer_share_events_share_idx on public.employer_share_events (share_id, id);

-- A supervisor's explicit, prospective permission to show their self-entered name, organization and title with a
-- confirmation in packets the technician shares with employers. One per review request; insert-only.
create table public.review_share_consents (
  request_id            uuid primary key references public.review_requests (id) on delete restrict,
  reviewer_auth_user_id uuid not null references auth.users (id) on delete restrict,
  consent_version       text not null check (char_length(consent_version) <= 60),
  created_at            timestamptz not null default now()
);

alter table public.employer_shares       enable row level security;
alter table public.employer_share_events enable row level security;
alter table public.review_share_consents enable row level security;
revoke all on public.employer_shares, public.employer_share_events, public.review_share_consents from public, anon, authenticated;
revoke all on sequence public.employer_share_events_id_seq from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Immutability
-- ------------------------------------------------------------------

create or replace function public.employer_shares_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'employer shares cannot be deleted'; end if;
  if new.packet is distinct from old.packet or new.packet_hash is distinct from old.packet_hash
     or new.packet_format is distinct from old.packet_format or new.shared_records is distinct from old.shared_records
     or new.worker_id is distinct from old.worker_id or new.opportunity_id is distinct from old.opportunity_id
     or new.match_run_id is distinct from old.match_run_id or new.invited_email_hash is distinct from old.invited_email_hash
     or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
    raise exception 'a shared packet cannot be changed';
  end if;
  if old.reviewer_auth_user_id is not null and new.reviewer_auth_user_id is distinct from old.reviewer_auth_user_id then
    raise exception 'the reviewer of a share cannot be changed';
  end if;
  if old.status in ('revoked','expired') and new.status is distinct from old.status then
    raise exception 'a closed share cannot be reopened';
  end if;
  return new;
end;
$$;
create trigger employer_shares_frozen before update or delete on public.employer_shares
  for each row execute function public.employer_shares_frozen();

create or replace function public.employer_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;
create trigger employer_share_events_append_only before update or delete on public.employer_share_events
  for each row execute function public.employer_append_only();
create trigger review_share_consents_append_only before update or delete on public.review_share_consents
  for each row execute function public.employer_append_only();

-- ------------------------------------------------------------------
-- Email delivery records may now describe this message kind (supersets of the old checks).
-- ------------------------------------------------------------------

alter table public.email_deliveries drop constraint email_deliveries_kind_check;
alter table public.email_deliveries add constraint email_deliveries_kind_check check (kind in
  ('customer_invitation','customer_code','customer_receipt',
   'supervisor_invitation','review_notification','decision_notice','reminder',
   'employer_share_invitation'));
alter table public.email_deliveries drop constraint email_deliveries_related_type_check;
alter table public.email_deliveries add constraint email_deliveries_related_type_check check (related_type in
  ('signoff_request','supervisor_relationship','review_request','employer_share'));

-- ------------------------------------------------------------------
-- Functions (service role only; see the grant loop at the end)
-- ------------------------------------------------------------------

-- Lazily close shares past their expiry. Clears the address and tokens.
create or replace function public.employer_share_expire_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with x as (
    update public.employer_shares
       set status = 'expired', closed_at = now(), invited_email = null, token_hash = null, consumed_token_hash = null
     where status in ('pending','active') and expires_at <= now()
     returning id)
  insert into public.employer_share_events (share_id, event) select id, 'expired' from x;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- May this address register an account to open a share? Used ONLY by sign-up (never by role creation).
create or replace function public.account_has_pending_employer_share(p_email_hash text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.employer_shares
                  where invited_email_hash = p_email_hash and status = 'pending' and expires_at > now());
$$;

-- Create a share atomically. p_records: [{"id": uuid, "original": bool}]. The packet is built by the server from
-- the worker's own data; this function checks that it describes exactly the records it says, at their CURRENT
-- versions, and that they and the run belong to this worker.
create or replace function public.employer_share_create(
  p_worker uuid, p_run uuid, p_packet_format text, p_packet jsonb, p_records jsonb,
  p_email text, p_email_hash text, p_hint text, p_token_hash text, p_valid_days integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w public.workers%rowtype; run public.match_runs%rowtype; own_email text; rec jsonb; e public.evidence%rowtype;
  shared jsonb := '[]'::jsonb; packet_ids text[]; given_ids text[]; new_id uuid; pv integer;
begin
  select * into w from public.workers where id = p_worker;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into run from public.match_runs where id = p_run and worker_id = p_worker;
  if not found or run.status <> 'completed' then return jsonb_build_object('ok', false, 'reason', 'no_report'); end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 100 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select lower(email) into own_email from auth.users where id = w.auth_user_id;
  if own_email = lower(p_email) then return jsonb_build_object('ok', false, 'reason', 'own_email'); end if;
  if exists (select 1 from public.signoff_suppressions where email_hash = p_email_hash) then
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  if (select count(*) from public.employer_shares where worker_id = p_worker and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;

  for rec in select * from jsonb_array_elements(p_records) loop
    select * into e from public.evidence where id = (rec ->> 'id')::uuid and worker_id = p_worker for share;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if coalesce((rec ->> 'original')::boolean, false) and e.storage_path is null then
      return jsonb_build_object('ok', false, 'reason', 'no_original');
    end if;
    -- The packet must show the record at the version that is current now.
    select (x ->> 'version')::integer into pv from jsonb_array_elements(p_packet -> 'records') x where x ->> 'id' = e.id::text;
    if pv is distinct from e.version then return jsonb_build_object('ok', false, 'reason', 'changed'); end if;
    shared := shared || jsonb_build_array(jsonb_build_object(
      'id', e.id, 'version', e.version, 'fileHash', e.file_hash, 'original', coalesce((rec ->> 'original')::boolean, false)));
  end loop;
  select coalesce(array_agg(x ->> 'id' order by x ->> 'id'), '{}') into packet_ids from jsonb_array_elements(p_packet -> 'records') x;
  select coalesce(array_agg(x ->> 'id' order by x ->> 'id'), '{}') into given_ids from jsonb_array_elements(p_records) x;
  if packet_ids is distinct from given_ids then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;

  insert into public.employer_shares
    (worker_id, opportunity_id, match_run_id, packet_format, packet, packet_hash, shared_records,
     invited_email, invited_email_hash, email_hint, token_hash, expires_at)
  values
    (p_worker, run.opportunity_id, run.id, p_packet_format, p_packet, encode(sha256(convert_to(p_packet::text, 'utf8')), 'hex'), shared,
     lower(p_email), p_email_hash, p_hint, p_token_hash, now() + make_interval(days => greatest(1, least(coalesce(p_valid_days, 7), 30))))
  returning id into new_id;
  insert into public.employer_share_events (share_id, event) values (new_id, 'invited');
  return jsonb_build_object('ok', true, 'id', new_id, 'workerName', w.name);
end;
$$;

-- Minimal facts for the invitation page: who shared, the masked address, the status. Never the packet.
create or replace function public.employer_share_peek(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.employer_shares%rowtype; wname text;
begin
  perform public.employer_share_expire_due();
  select * into s from public.employer_shares where token_hash = p_token_hash;
  if not found then
    select * into s from public.employer_shares where consumed_token_hash = p_token_hash;
    if found then return jsonb_build_object('ok', true, 'status', s.status, 'workerName', null, 'emailHint', null, 'answered', true); end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select name into wname from public.workers where id = s.worker_id;
  return jsonb_build_object('ok', true, 'status', s.status, 'workerName', wname, 'emailHint', s.email_hint, 'expiresAt', s.expires_at);
end;
$$;

-- Open a share. The CALLER's confirmed account email must equal the invited address. Any role (or none) may open
-- it; opening grants nothing beyond this one packet.
create or replace function public.employer_share_accept(p_token_hash text, p_auth uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.employer_shares%rowtype; u record; worker_auth uuid;
begin
  perform public.employer_share_expire_due();
  select * into s from public.employer_shares where token_hash = p_token_hash or consumed_token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select id, lower(email) as email, email_confirmed_at into u from auth.users where id = p_auth;
  if not found or u.email_confirmed_at is null then return jsonb_build_object('ok', false, 'reason', 'email_unconfirmed'); end if;
  select auth_user_id into worker_auth from public.workers where id = s.worker_id;
  if worker_auth = p_auth then return jsonb_build_object('ok', false, 'reason', 'self'); end if;

  if s.consumed_token_hash = p_token_hash then
    if s.status = 'active' and s.reviewer_auth_user_id = p_auth then
      return jsonb_build_object('ok', true, 'id', s.id, 'repeated', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', case when s.status = 'active' then 'wrong_account' else s.status end);
  end if;
  if s.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', s.status); end if;
  if s.invited_email is null or s.invited_email <> u.email then
    return jsonb_build_object('ok', false, 'reason', 'wrong_account');
  end if;
  update public.employer_shares
     set status = 'active', reviewer_auth_user_id = p_auth, accepted_at = now(),
         invited_email = null, token_hash = null, consumed_token_hash = p_token_hash
   where id = s.id;
  insert into public.employer_share_events (share_id, event) values (s.id, 'accepted');
  return jsonb_build_object('ok', true, 'id', s.id);
end;
$$;

-- Shares opened by this account. Closed ones are listed without content.
create or replace function public.employer_share_list_for_reviewer(p_auth uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.employer_share_expire_due();
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'status', s.status, 'technician', s.packet #>> '{technician,name}',
           'jobTitle', s.packet #>> '{opportunity,title}', 'sharedAt', s.created_at, 'expiresAt', s.expires_at)
           order by s.created_at desc), '[]'::jsonb)
    from public.employer_shares s where s.reviewer_auth_user_id = p_auth);
end;
$$;

-- Records whose current version no longer matches what was shared (edited or deleted since).
create or replace function public.employer_share_changed(p_share uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(r ->> 'id'), '[]'::jsonb)
    from public.employer_shares s, jsonb_array_elements(s.shared_records) r
   where s.id = p_share
     and not exists (select 1 from public.evidence e
                      where e.id = (r ->> 'id')::uuid and e.worker_id = s.worker_id
                        and e.version = (r ->> 'version')::integer and e.file_hash = r ->> 'fileHash');
$$;

-- The packet, for the account that opened it, while the share is active. Each read is logged.
create or replace function public.employer_share_get(p_auth uuid, p_share uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.employer_shares%rowtype;
begin
  perform public.employer_share_expire_due();
  select * into s from public.employer_shares where id = p_share;
  if not found or s.reviewer_auth_user_id is distinct from p_auth then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if s.status <> 'active' then return jsonb_build_object('ok', false, 'reason', s.status); end if;
  insert into public.employer_share_events (share_id, event) values (s.id, 'viewed');
  return jsonb_build_object('ok', true, 'id', s.id, 'packet', s.packet, 'packetHash', s.packet_hash,
    'sharedAt', s.created_at, 'expiresAt', s.expires_at, 'changedRecordIds', public.employer_share_changed(s.id));
end;
$$;

-- Storage path of an original, only if the technician shared THAT original in THIS packet, the share is active,
-- and the record is still the version that was shared. Logged.
create or replace function public.employer_share_document_path(p_auth uuid, p_share uuid, p_record uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.employer_shares%rowtype; path text;
begin
  perform public.employer_share_expire_due();
  select * into s from public.employer_shares where id = p_share;
  if not found or s.reviewer_auth_user_id is distinct from p_auth or s.status <> 'active' then return null; end if;
  select e.storage_path into path
    from jsonb_array_elements(s.shared_records) r
    join public.evidence e on e.id = (r ->> 'id')::uuid and e.worker_id = s.worker_id
   where (r ->> 'id')::uuid = p_record and coalesce((r ->> 'original')::boolean, false)
     and e.version = (r ->> 'version')::integer and e.file_hash = r ->> 'fileHash' and e.storage_path is not null;
  if path is null then return null; end if;
  insert into public.employer_share_events (share_id, event, record_id) values (s.id, 'original_opened', p_record);
  return path;
end;
$$;

-- The technician's own shares, with access counts. Never the reviewer's address or account id.
create or replace function public.employer_share_list_for_worker(p_worker uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.employer_share_expire_due();
  return (select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'status', s.status, 'emailHint', s.email_hint, 'opportunityId', s.opportunity_id,
           'jobTitle', s.packet #>> '{opportunity,title}', 'recordCount', jsonb_array_length(s.shared_records),
           'createdAt', s.created_at, 'expiresAt', s.expires_at, 'acceptedAt', s.accepted_at, 'closedAt', s.closed_at,
           'views', (select count(*) from public.employer_share_events v where v.share_id = s.id and v.event = 'viewed'),
           'originalsOpened', (select count(*) from public.employer_share_events v where v.share_id = s.id and v.event = 'original_opened'),
           'lastViewedAt', (select max(created_at) from public.employer_share_events v where v.share_id = s.id and v.event = 'viewed'))
           order by s.created_at desc), '[]'::jsonb)
    from public.employer_shares s where s.worker_id = p_worker);
end;
$$;

-- The technician's own view of exactly what was sent (same packet the reviewer sees).
create or replace function public.employer_share_worker_get(p_worker uuid, p_share uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.employer_shares%rowtype;
begin
  select * into s from public.employer_shares where id = p_share and worker_id = p_worker;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'id', s.id, 'status', s.status, 'packet', s.packet, 'packetHash', s.packet_hash,
    'sharedAt', s.created_at, 'expiresAt', s.expires_at, 'changedRecordIds', public.employer_share_changed(s.id));
end;
$$;

create or replace function public.employer_share_revoke(p_worker uuid, p_share uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.employer_shares%rowtype;
begin
  select * into s from public.employer_shares where id = p_share and worker_id = p_worker for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if s.status in ('revoked','expired') then return jsonb_build_object('ok', true, 'status', s.status, 'repeated', true); end if;
  update public.employer_shares
     set status = 'revoked', closed_at = now(), invited_email = null, token_hash = null, consumed_token_hash = null
   where id = s.id;
  insert into public.employer_share_events (share_id, event) values (s.id, 'revoked');
  return jsonb_build_object('ok', true, 'status', 'revoked');
end;
$$;

-- Record a supervisor's explicit consent, only by the reviewer who decided, only for a confirmation, and only at
-- decision time (within 15 minutes of it). Never retroactive for older reviews.
create or replace function public.review_record_share_consent(p_auth uuid, p_request uuid, p_consent_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare resp public.review_responses%rowtype;
begin
  select * into resp from public.review_responses where request_id = p_request;
  if not found or resp.reviewer_auth_user_id is distinct from p_auth then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if resp.decision not in ('confirm_observed','confirm_documents_reviewed') then return jsonb_build_object('ok', false, 'reason', 'not_confirmation'); end if;
  if exists (select 1 from public.review_share_consents where request_id = p_request) then return jsonb_build_object('ok', true, 'repeated', true); end if;
  if resp.created_at < now() - interval '15 minutes' then return jsonb_build_object('ok', false, 'reason', 'too_late'); end if;
  insert into public.review_share_consents (request_id, reviewer_auth_user_id, consent_version) values (p_request, p_auth, p_consent_version);
  return jsonb_build_object('ok', true);
end;
$$;

-- Which of this worker's reviews carry consent (for building packets).
create or replace function public.review_share_consented(p_worker uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c.request_id), '[]'::jsonb)
    from public.review_share_consents c join public.review_requests q on q.id = c.request_id
   where q.worker_id = p_worker;
$$;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('employer_share_expire_due','account_has_pending_employer_share','employer_share_create',
                                'employer_share_peek','employer_share_accept','employer_share_list_for_reviewer',
                                'employer_share_changed','employer_share_get','employer_share_document_path',
                                'employer_share_list_for_worker','employer_share_worker_get','employer_share_revoke',
                                'review_record_share_consent','review_share_consented')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
