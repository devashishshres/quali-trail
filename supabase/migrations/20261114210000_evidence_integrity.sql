-- Draft provenance is trusted by confirmation, so workers may read but cannot
-- forge draft source_kind/hash/storage_path or replace model output directly.
-- The authenticated API checks ownership before using its server-only client.
revoke insert, update, delete on public.evidence_drafts from authenticated;

-- Changes to original-source provenance invalidate qualification packets too.
create or replace function public.evidence_bump_version()
returns trigger
language plpgsql
as $$
begin
  if (new.type, new.title, new.source_date, new.issuer, new.structured_data, new.verification_status, new.source_kind, new.storage_path, new.mime_type, new.file_hash)
     is distinct from
     (old.type, old.title, old.source_date, old.issuer, old.structured_data, old.verification_status, old.source_kind, old.storage_path, old.mime_type, old.file_hash)
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

-- A record losing searchable status can change retrieval results just as a
-- record becoming indexed can. One trigger handles both directions.
drop trigger if exists evidence_stale_on_indexed on public.evidence;
create trigger evidence_stale_on_indexed
  after update of index_status on public.evidence
  for each row
  when (old.index_status is distinct from new.index_status
        and (old.index_status = 'indexed' or new.index_status = 'indexed'))
  execute function public.evidence_mark_matches_stale();
