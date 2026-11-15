-- READ-ONLY snapshot of the demo workers' state. Run before and after applying migrations: the output must be
-- identical (the release migrations add objects only; they rewrite no existing rows). Changes nothing.
select w.name,
       w.is_synthetic,
       (select count(*) from public.evidence e where e.worker_id = w.id)                          as evidence,
       (select coalesce(sum(e.version), 0) from public.evidence e where e.worker_id = w.id)       as version_sum,
       (select string_agg(e.verification_status || ':' || e.index_status, ',' order by e.id)
          from public.evidence e where e.worker_id = w.id)                                        as statuses,
       w.evidence_revision,
       (select r.status from public.match_runs r where r.worker_id = w.id order by r.created_at desc limit 1) as latest_run,
       (select string_agg(x.assessment, ',' order by x.assessment)
          from public.requirement_results x
          join public.match_runs r on r.id = x.match_run_id
         where r.id = (select r2.id from public.match_runs r2 where r2.worker_id = w.id and r2.status = 'completed'
                        order by r2.created_at desc limit 1))                                     as latest_completed_assessments
  from public.workers w
 order by w.name;
