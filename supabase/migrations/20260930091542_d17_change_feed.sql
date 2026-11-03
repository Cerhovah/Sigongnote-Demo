-- A transactional tenant counter, not a sequence: cursors cannot skip late commits.
create table app.sync_heads(tenant_id uuid primary key references app.tenants(id) on delete cascade,position bigint not null default 0);
create table app.sync_changes(tenant_id uuid not null references app.tenants(id) on delete cascade,position bigint not null,
 kind text not null check(kind in ('material','document','reset')),target_id uuid,removed boolean not null,
 primary key(tenant_id,position));
alter table app.sync_heads enable row level security;
alter table app.sync_changes enable row level security;
revoke all on app.sync_heads,app.sync_changes from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant select on app.sync_heads,app.sync_changes to sigongnote_api;
create policy sync_head_read on app.sync_heads for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy sync_change_read on app.sync_changes for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create function app.record_sync_change() returns trigger language plpgsql security definer set search_path='' as $$
declare data jsonb; tenant uuid; target uuid; pos bigint; kind text;
begin
 data=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 tenant=(data->>'tenant_id')::uuid;kind=tg_argv[0];target=(data->>tg_argv[1])::uuid;
 if tg_table_name='document_artifacts' then
  select document_id into target from app.business_document_revisions where tenant_id=tenant and id=target;
 end if;
 if kind<>'reset' and target is null then kind='reset';end if;
 insert into app.sync_heads(tenant_id,position) values(tenant,1) on conflict(tenant_id) do update set position=app.sync_heads.position+1 returning position into pos;
 insert into app.sync_changes values(tenant,pos,kind,target,tg_op='DELETE');
 return null;
end $$;
revoke all on function app.record_sync_change() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger sync_material after insert or update or delete on app.document_revisions for each row execute function app.record_sync_change('material','id');
create trigger sync_parse after insert or update or delete on app.parse_results for each row execute function app.record_sync_change('material','revision_id');
create trigger sync_organization after insert or update or delete on app.evidence_organizations for each row execute function app.record_sync_change('material','revision_id');
create trigger sync_document after insert or update or delete on app.business_document_revisions for each row execute function app.record_sync_change('document','document_id');
create trigger sync_artifact after insert or delete on app.document_artifacts for each row execute function app.record_sync_change('document','revision_id');
create trigger sync_lifecycle after insert or update or delete on app.document_lifecycle_events for each row execute function app.record_sync_change('document','document_id');
create trigger sync_source after update of active,generation,server_upload_consent,scope,processing_policy,capability or delete on app.capture_sources for each row execute function app.record_sync_change('reset','');
create trigger sync_consent after update or delete on app.consent_grants for each row execute function app.record_sync_change('reset','');
create trigger sync_work after update of project_id,label,bundle_id or delete on app.work_contexts for each row execute function app.record_sync_change('reset','');
create trigger sync_member after update of active,revoked_at,role or delete on app.memberships for each row execute function app.record_sync_change('reset','');
-- Existing originals/documents become the initial feed, without modifying evidence.
insert into app.sync_changes(tenant_id,position,kind,target_id,removed)
select tenant_id,row_number() over(partition by tenant_id order by kind,id),'material',id,false
from (select tenant_id,id,'material' kind from app.document_revisions) initial;
insert into app.sync_heads select tenant_id,max(position) from app.sync_changes group by tenant_id;
do $$ declare r record; pos bigint;begin
 for r in select tenant_id,id from app.business_documents order by tenant_id,id loop
  insert into app.sync_heads values(r.tenant_id,1) on conflict(tenant_id) do update set position=app.sync_heads.position+1 returning position into pos;
  insert into app.sync_changes values(r.tenant_id,pos,'document',r.id,false);
 end loop;
end $$;

create trigger sync_blob after update of scan_state or delete on app.evidence_blobs for each row execute function app.record_sync_change('reset','');
create trigger sync_device after update of active,revoked_at or delete on app.devices for each row execute function app.record_sync_change('reset','');
create trigger sync_project after update of display_name or delete on app.projects for each row execute function app.record_sync_change('reset','');

create index sync_reset_lookup on app.sync_changes(tenant_id,position desc) where kind='reset';

-- Origin-channel policy applies even when another user uploaded the source (actor RLS must not hide it).
create function app.mirror_copy_allowed(p_tenant uuid,p_revision uuid) returns boolean language sql stable security definer set search_path='' as $$
 select app.revision_accessible(p_tenant,p_revision) and not exists(
  select 1 from app.upload_intents u join app.capture_sources s on s.tenant_id=u.tenant_id and s.id=u.source_id
  where u.tenant_id=p_tenant and u.completed_revision_id=p_revision and s.kind in ('sms','call_recording','notifications'))
$$;
revoke all on function app.mirror_copy_allowed(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.mirror_copy_allowed(uuid,uuid) to sigongnote_api;
