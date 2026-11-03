-- An indexed device original is not an uploaded server object.
alter table app.evidence_blobs add column storage_location text not null default 'server'
 check(storage_location in ('device','server'));
update app.evidence_blobs set storage_location='device'
 where storage_key=tenant_id::text||'/device-only/'||sha256;
grant update(storage_key,storage_location,sniffed_mime,scan_state) on app.evidence_blobs to sigongnote_api;
create policy evidence_blobs_promote on app.evidence_blobs for update to sigongnote_api
 using(storage_location='device' and app.has_tenant_role(tenant_id,array['owner','operator']))
 with check(storage_location='server' and app.has_tenant_role(tenant_id,array['owner','operator']));
-- Repair the version contract used by the normal upload API.
update app.documents d set version=r.latest from
 (select tenant_id,document_id,max(revision_number) latest from app.document_revisions group by tenant_id,document_id) r
 where d.tenant_id=r.tenant_id and d.id=r.document_id and d.version<r.latest;
