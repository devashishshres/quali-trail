-- ROLLBACK of 20261118100000_job_import.sql, ONLY while nothing has been imported.
-- It refuses (and changes nothing) if any import draft exists, any opportunity came from an import, any
-- requirement carries review fields, or any saved result is 'cannot_assess'. After real use, fix forward instead.
-- Runs in one transaction. Seeded opportunities, requirements and match results are untouched.
begin;

do $$
declare n bigint;
begin
  if to_regclass('public.opportunity_imports') is not null then
    select count(*) into n from public.opportunity_imports;
    if n > 0 then raise exception 'refusing rollback: public.opportunity_imports holds % row(s); fix forward instead', n; end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'opportunities' and column_name = 'source_kind') then
    select count(*) into n from public.opportunities where source_kind is not null or import_id is not null;
    if n > 0 then raise exception 'refusing rollback: % imported opportunit(ies); fix forward instead', n; end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'requirements' and column_name = 'priority') then
    select count(*) into n from public.requirements
     where priority is not null or original_priority is not null or display_text is not null or source_excerpt is not null or category is not null;
    if n > 0 then raise exception 'refusing rollback: % requirement(s) carry import fields; fix forward instead', n; end if;
  end if;
  select count(*) into n from public.requirement_results where assessment = 'cannot_assess';
  if n > 0 then raise exception 'refusing rollback: % result(s) are cannot_assess; fix forward instead', n; end if;
end $$;

drop function if exists public.opportunity_import_begin(uuid, text, text, integer);
drop function if exists public.opportunity_import_fetched(uuid, uuid, text, text, text, boolean, text, text[]);
drop function if exists public.opportunity_import_fail(uuid, uuid, text, text);
drop function if exists public.opportunity_import_lease(uuid, uuid);
drop function if exists public.opportunity_import_drafted(uuid, uuid, jsonb, text[]);
drop function if exists public.opportunity_import_save_review(uuid, uuid, integer, jsonb);
drop function if exists public.opportunity_import_confirm(uuid, uuid, integer, jsonb, jsonb);
drop function if exists public.opportunity_import_expire();

alter table public.requirement_results drop constraint if exists requirement_results_assessment_check;
alter table public.requirement_results
  add constraint requirement_results_assessment_check
  check (assessment in ('evidence_found', 'needs_review', 'no_sufficient_evidence'));

drop index if exists public.opportunities_import_once_idx;
alter table public.requirements
  drop column if exists priority, drop column if exists original_priority, drop column if exists display_text,
  drop column if exists source_excerpt, drop column if exists category;
alter table public.opportunities
  drop column if exists import_id, drop column if exists source_kind, drop column if exists location,
  drop column if exists retrieved_at, drop column if exists final_url, drop column if exists supersedes_id,
  drop column if exists import_warnings, drop column if exists removed_count, drop column if exists edited_count;
drop table if exists public.opportunity_imports;

commit;
