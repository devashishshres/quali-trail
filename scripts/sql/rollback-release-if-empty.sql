-- ROLLBACK of the three release migrations (20261116100000, 20261117090000, 20261117100000), ONLY while empty.
-- Use only if the release must be withdrawn BEFORE any real use. It refuses (and changes nothing) if any release
-- table other than the rate-limit counters holds a row: acknowledgments, reviews, relationships, deliveries and
-- opt-outs are never dropped. After real use, fix forward with a new migration instead.
-- Runs in one transaction; existing tables, columns other than workers.employment_arrangement, and data are untouched.
begin;

do $$
declare t text; n bigint;
begin
  foreach t in array array['review_events', 'review_responses', 'review_requests', 'supervisor_relationships', 'supervisor_profiles', 'email_webhook_events', 'email_deliveries', 'signoff_events', 'signoff_responses', 'signoff_sessions', 'signoff_codes', 'signoff_requests', 'signoff_suppressions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'refusing rollback: public.% holds % row(s); fix forward instead', t, n; end if;
    end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workers'
             and column_name = 'employment_arrangement')
     and exists (select 1 from public.workers where employment_arrangement is not null) then
    raise exception 'refusing rollback: workers.employment_arrangement holds data; fix forward instead';
  end if;
end $$;

-- The one trigger the release adds to an existing table.
drop trigger if exists evidence_supersede_signoffs on public.evidence;

drop table if exists public.review_events;
drop table if exists public.review_responses;
drop table if exists public.review_requests;
drop table if exists public.supervisor_relationships;
drop table if exists public.supervisor_profiles;
drop table if exists public.email_webhook_events;
drop table if exists public.email_deliveries;
drop table if exists public.signoff_events;
drop table if exists public.signoff_responses;
drop table if exists public.signoff_sessions;
drop table if exists public.signoff_codes;
drop table if exists public.signoff_requests;
drop table if exists public.signoff_suppressions;
drop table if exists public.signoff_rate_limits;

alter table public.workers drop column if exists employment_arrangement;

drop function if exists public.signoff_requests_frozen;
drop function if exists public.signoff_responses_frozen;
drop function if exists public.evidence_supersede_signoffs;
drop function if exists public.signoff_create_request;
drop function if exists public.signoff_gate;
drop function if exists public.signoff_issue_code;
drop function if exists public.signoff_verify_code;
drop function if exists public.signoff_read_snapshot;
drop function if exists public.signoff_respond;
drop function if exists public.signoff_revoke_request;
drop function if exists public.signoff_rotate_token;
drop function if exists public.signoff_expire_due;
drop function if exists public.signoff_purge_pii;
drop function if exists public.signoff_add_suppression;
drop function if exists public.signoff_opt_out;
drop function if exists public.signoff_hit_rate_limit;
drop function if exists public.email_delivery_begin;
drop function if exists public.email_delivery_finish;
drop function if exists public.email_webhook_first_seen;
drop function if exists public.email_delivery_event;
drop function if exists public.email_delivery_latest;
drop function if exists public.email_purge_old;
drop function if exists public.review_requests_frozen;
drop function if exists public.review_responses_frozen;
drop function if exists public.account_onboard_worker;
drop function if exists public.account_onboard_supervisor;
drop function if exists public.account_has_pending_invite;
drop function if exists public.sup_invite_create;
drop function if exists public.sup_invite_peek;
drop function if exists public.sup_invite_answer;
drop function if exists public.sup_relationship_revoke;
drop function if exists public.sup_invite_rotate;
drop function if exists public.review_create;
drop function if exists public.review_list_for_supervisor;
drop function if exists public.review_get;
drop function if exists public.review_document_path;
drop function if exists public.review_respond;
drop function if exists public.review_revoke;
drop function if exists public.review_remind;
drop function if exists public.review_expire_due;
drop function if exists public.sup_purge_pii;

delete from supabase_migrations.schema_migrations where version in ('20261116100000', '20261117090000', '20261117100000');

commit;
