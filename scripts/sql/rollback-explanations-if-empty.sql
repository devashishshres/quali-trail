-- ROLLBACK of 20261119100000_match_run_explanations.sql, ONLY while no explanation exists.
-- Refuses (and changes nothing) if any row exists. After real use, fix forward instead. One transaction.
-- Checked results (requirement_results, evidence_matches) are never touched by this script.
begin;

do $$
declare n bigint;
begin
  if to_regclass('public.match_run_explanations') is not null then
    select count(*) into n from public.match_run_explanations;
    if n > 0 then raise exception 'refusing rollback: public.match_run_explanations holds % row(s); fix forward instead', n; end if;
  end if;
end $$;

drop function if exists public.explanation_claim(uuid, uuid, integer);
drop function if exists public.explanation_save(uuid, uuid, text, text, integer, jsonb);
drop function if exists public.explanation_fail(uuid, uuid, text);
drop table if exists public.match_run_explanations;

commit;
