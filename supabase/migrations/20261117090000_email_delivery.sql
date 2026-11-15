-- Email delivery records and webhook de-duplication. ADDITIVE. Not applied to any shared project.
-- Holds NO addresses, message bodies, tokens or codes: only what kind of message, which record it relates to,
-- the provider's message id and the delivery outcome.

create table public.email_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  idempotency_key     text not null unique check (char_length(idempotency_key) <= 200),
  kind                text not null check (kind in
                        ('customer_invitation','customer_code','customer_receipt',
                         'supervisor_invitation','review_notification','decision_notice','reminder')),
  mode                text not null check (mode in ('resend','mock')),
  related_type        text check (related_type in ('signoff_request','supervisor_relationship','review_request')),
  related_id          uuid,
  status              text not null default 'sending' check (status in
                        ('sending','sent','failed','delivered','delayed','bounced_transient','bounced','complained')),
  attempts            integer not null default 0,
  provider_message_id text,
  last_error          text check (last_error is null or char_length(last_error) <= 120),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index email_deliveries_related_idx on public.email_deliveries (related_type, related_id, created_at desc);
create index email_deliveries_provider_idx on public.email_deliveries (provider_message_id) where provider_message_id is not null;

create table public.email_webhook_events (
  webhook_id  text primary key check (char_length(webhook_id) <= 200),
  event_type  text not null,
  received_at timestamptz not null default now()
);

alter table public.email_deliveries enable row level security;
alter table public.email_webhook_events enable row level security;
revoke all on public.email_deliveries, public.email_webhook_events from public, anon, authenticated;

-- Start (or retry) a delivery under an idempotency key.
--   'send'        go ahead; attempts was incremented
--   'duplicate'   already sent; do not send again
--   'in_progress' another request is sending right now
--   'exhausted'   too many attempts for this key
create or replace function public.email_delivery_begin(
  p_key text, p_kind text, p_mode text, p_related_type text, p_related_id uuid, p_max_attempts integer
) returns text language plpgsql security definer set search_path = '' as $$
declare d public.email_deliveries%rowtype;
begin
  insert into public.email_deliveries (idempotency_key, kind, mode, related_type, related_id)
    values (p_key, p_kind, p_mode, p_related_type, p_related_id)
    on conflict (idempotency_key) do nothing;
  select * into d from public.email_deliveries where idempotency_key = p_key for update;
  if d.status in ('sent','delivered','delayed') then return 'duplicate'; end if;
  if d.status = 'sending' and d.attempts > 0 and d.updated_at > now() - interval '1 minute' then return 'in_progress'; end if;
  if d.status in ('bounced','complained') then return 'duplicate'; end if;
  if d.attempts >= p_max_attempts then return 'exhausted'; end if;
  update public.email_deliveries set attempts = attempts + 1, status = 'sending', updated_at = now() where id = d.id;
  return 'send';
end;
$$;

create or replace function public.email_delivery_finish(p_key text, p_ok boolean, p_message_id text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.email_deliveries
     set status = case when p_ok then 'sent' else 'failed' end,
         provider_message_id = coalesce(p_message_id, provider_message_id),
         last_error = case when p_ok then null else left(p_error, 120) end,
         updated_at = now()
   where idempotency_key = p_key;
end;
$$;

-- Webhook: returns false when this webhook id was already processed (provider retries are expected).
create or replace function public.email_webhook_first_seen(p_webhook_id text, p_event_type text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.email_webhook_events (webhook_id, event_type) values (p_webhook_id, p_event_type);
  return true;
exception when unique_violation then
  return false;
end;
$$;

-- Record a provider outcome against the delivery. Later "worse" outcomes are never overwritten by "delivered".
create or replace function public.email_delivery_event(p_message_id text, p_status text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_status not in ('delivered','delayed','bounced_transient','bounced','complained','failed') then return false; end if;
  update public.email_deliveries set status = p_status, updated_at = now()
   where provider_message_id = p_message_id
     and not (status in ('bounced','complained') and p_status in ('delivered','delayed','bounced_transient'));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Latest delivery outcome for a record (for the worker's status display). No addresses.
create or replace function public.email_delivery_latest(p_related_type text, p_related_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'mode', mode, 'status', status, 'at', updated_at) order by created_at desc), '[]'::jsonb)
    from (select * from public.email_deliveries where related_type = p_related_type and related_id = p_related_id
           order by created_at desc limit 10) d;
$$;

create or replace function public.email_purge_old(p_days integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.email_webhook_events where received_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'email\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
