-- Read only metadata deliberately shared by this actor from their active original device.
-- Device bytes remain outside revision_accessible, parsing, model tools and original downloads.
-- Reused/promoted server bytes retain the existing server-original policy within the same provenance.
create or replace function app.field_metadata_readable(t uuid,e uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and app.has_tenant_role(t,array['owner','operator']) and exists(
  select 1 from app.field_captures f
  join app.capture_sources s on s.tenant_id=f.tenant_id and s.id=f.source_id
  join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id and d.user_id=s.user_id
  join app.document_revisions r on r.tenant_id=f.tenant_id and r.id=f.revision_id and r.document_id=f.document_id
  join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id and b.sha256=f.source_hash
  join app.evidence_index i on i.tenant_id=f.tenant_id and i.id=f.evidence_id and i.revision_id=f.revision_id
  where f.tenant_id=t and f.evidence_id=e and s.user_id=auth.uid() and s.kind='folder'
   and s.active and d.active and s.local_selection_consent and s.server_upload_consent and s.generation=f.source_generation
   and (b.storage_location='device' or b.storage_location='server' and app.revision_accessible(t,r.id)) and b.scan_state<>'quarantined'
   and not exists(select 1 from app.evidence_retention_tasks q where q.tenant_id=f.tenant_id and q.revision_id=f.revision_id))
$$;
revoke all on function app.field_metadata_readable(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.field_metadata_readable(uuid,uuid) to sigongnote_api;

drop policy if exists evidence_index_read on app.evidence_index;
create policy evidence_index_read on app.evidence_index for select to sigongnote_api
 using(app.revision_accessible(tenant_id,revision_id) or app.field_metadata_readable(tenant_id,id));
drop policy if exists field_captures_read on app.field_captures;
create policy field_captures_read on app.field_captures for select to sigongnote_api
 using(app.field_metadata_readable(tenant_id,evidence_id));
drop policy if exists field_questions_read on app.field_questions;
create policy field_questions_read on app.field_questions for select to sigongnote_api
 using(exists(select 1 from app.field_captures f where f.tenant_id=field_questions.tenant_id and f.id=field_questions.capture_id));
drop policy if exists field_questions_update on app.field_questions;
create policy field_questions_update on app.field_questions for update to sigongnote_api
 using(exists(select 1 from app.field_captures f where f.tenant_id=field_questions.tenant_id and f.id=field_questions.capture_id))
 with check(exists(select 1 from app.field_captures f where f.tenant_id=field_questions.tenant_id and f.id=field_questions.capture_id));
