-- Photo sheets are immutable render subjects, independent of financial documents.
create table app.photo_sheets (
 tenant_id uuid not null,id uuid not null,group_id uuid not null,group_version integer not null,
 actor_id uuid not null references auth.users(id),snapshot jsonb not null,snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),primary key(tenant_id,id),
 unique(tenant_id,group_id,group_version,snapshot_hash),foreign key(tenant_id,group_id,group_version) references app.photo_group_versions(tenant_id,group_id,version)
);
create table app.photo_sheet_artifacts (
 tenant_id uuid not null,sheet_id uuid not null,bytes bytea not null check(octet_length(bytes) between 1 and 5242880),
 sha256 text not null check(encode(sha256(bytes),'hex')=sha256),pages integer not null check(pages between 1 and 10),created_at timestamptz not null default now(),
 primary key(tenant_id,sheet_id),foreign key(tenant_id,sheet_id) references app.photo_sheets(tenant_id,id)
);
alter table app.photo_sheets enable row level security;
alter table app.photo_sheet_artifacts enable row level security;
revoke all on app.photo_sheets,app.photo_sheet_artifacts from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert on app.photo_sheets to sigongnote_api;
grant select on app.photo_sheet_artifacts to sigongnote_api;
create policy sheets_read on app.photo_sheets for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy sheets_insert on app.photo_sheets for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and actor_id=auth.uid());
create policy sheet_artifacts_read on app.photo_sheet_artifacts for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
alter table app.jobs add column photo_sheet_id uuid;
alter table app.jobs add foreign key(tenant_id,photo_sheet_id) references app.photo_sheets(tenant_id,id);
alter table app.jobs drop constraint jobs_subject_check;
alter table app.jobs add constraint jobs_subject_check check((job_type='parse_original' and evidence_revision_id is not null and generated_revision_id is null and photo_sheet_id is null) or(job_type='render_document' and generated_revision_id is not null and evidence_revision_id is null and photo_sheet_id is null) or(job_type='render_photo_sheet' and photo_sheet_id is not null and evidence_revision_id is null and generated_revision_id is null));
create unique index jobs_photo_once on app.jobs(tenant_id,photo_sheet_id,processor_version,input_hash) where job_type='render_photo_sheet';
alter table app.job_effects add column photo_sheet_id uuid;
alter table app.job_effects add foreign key(tenant_id,photo_sheet_id) references app.photo_sheets(tenant_id,id);
alter table app.job_effects drop constraint effects_subject_check;
alter table app.job_effects add constraint effects_subject_check check((job_type='parse_original' and evidence_revision_id is not null and generated_revision_id is null and photo_sheet_id is null) or(job_type='render_document' and generated_revision_id is not null and evidence_revision_id is null and photo_sheet_id is null) or(job_type='render_photo_sheet' and photo_sheet_id is not null and evidence_revision_id is null and generated_revision_id is null));
create unique index job_effects_photo_once on app.job_effects(tenant_id,photo_sheet_id,processor_version,input_hash) where job_type='render_photo_sheet';
alter table app.outbox drop constraint outbox_topic_check;
alter table app.outbox add constraint outbox_topic_check check(topic in ('parse_original_ready','render_document_ready','work_observed_ready','render_photo_sheet_ready'));
create function app.photo_sheet_authorized(t uuid,s uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid;data jsonb;old_sub text;ok boolean;
begin
 select actor_id,snapshot into actor,data from app.photo_sheets where tenant_id=t and id=s;
 if actor is null or not exists(select 1 from app.memberships where tenant_id=t and user_id=actor and role='owner' and active and revoked_at is null) then return false;end if;
 old_sub:=current_setting('request.jwt.claim.sub',true);perform set_config('request.jwt.claim.sub',actor::text,true);
 select not exists(select 1 from jsonb_array_elements(data->'photos') p where not app.revision_accessible(t,(p->>'revision_id')::uuid) or not exists(select 1 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id left join app.evidence_organizations o on o.tenant_id=r.tenant_id and o.revision_id=r.id where r.tenant_id=t and r.id=(p->>'revision_id')::uuid and b.sha256=p->>'sha256' and (o.project_id is null or o.project_id=(data->>'project_id')::uuid) and (data->>'context_id' is null or o.context_id is null or o.context_id=(data->>'context_id')::uuid))) into ok;
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);return ok;
end $$;
revoke all on function app.photo_sheet_authorized(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create function app.claim_photo_sheet(p_owner text,p_tenant uuid default null) returns table(tenant_id uuid,job_id uuid,lease_token uuid,sheet_id uuid,input_hash text) language plpgsql security definer set search_path='' as $$ begin
 if length(p_owner) not between 1 and 128 then raise exception 'invalid owner';end if;
 update app.jobs j set state='dead',lease_expires_at=null,last_error_code='LEASE_EXHAUSTED' where j.job_type='render_photo_sheet' and(p_tenant is null or j.tenant_id=p_tenant) and j.state='leased' and j.lease_expires_at<=now() and j.attempt_count>=5;
 return query with chosen as(select j.tenant_id,j.id from app.jobs j where j.job_type='render_photo_sheet' and j.processor_version='photo-a4-v1' and(p_tenant is null or j.tenant_id=p_tenant) and j.attempt_count<5 and ((j.state in ('queued','retry_wait') and j.available_at<=now()) or(j.state='leased' and j.lease_expires_at<=now())) order by j.created_at,j.id for update skip locked limit 1)
 update app.jobs j set state='leased',attempt_count=j.attempt_count+1,lease_token=gen_random_uuid(),lease_owner=p_owner,lease_expires_at=now()+interval '120 seconds' from chosen c where j.tenant_id=c.tenant_id and j.id=c.id returning j.tenant_id,j.id,j.lease_token,j.photo_sheet_id,j.input_hash;
end $$;
create function app.photo_sheet_input(t uuid,j uuid,k uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('snapshot',s.snapshot,'input_hash',s.snapshot_hash,'sources',(select jsonb_agg(jsonb_build_object('revision_id',r.id,'storage_key',b.storage_key,'sha256',b.sha256,'byte_length',b.byte_length) order by p.ord) from jsonb_array_elements(s.snapshot->'photos') with ordinality p(item,ord) join app.document_revisions r on r.tenant_id=s.tenant_id and r.id=(p.item->>'revision_id')::uuid join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id)) from app.jobs q join app.photo_sheets s on s.tenant_id=q.tenant_id and s.id=q.photo_sheet_id where q.tenant_id=t and q.id=j and q.job_type='render_photo_sheet' and q.state='leased' and q.lease_token=k and q.lease_expires_at>now() and q.input_hash=s.snapshot_hash and app.photo_sheet_authorized(t,s.id)
$$;
create function app.complete_photo_sheet(t uuid,j uuid,k uuid,h text,pdf bytea,pages integer) returns boolean language plpgsql security definer set search_path='' as $$ declare q app.jobs%rowtype;begin
 select * into q from app.jobs where tenant_id=t and id=j for update;
 if q.id is null or q.job_type<>'render_photo_sheet' or q.lease_token is distinct from k or q.input_hash is distinct from h or not app.photo_sheet_authorized(t,q.photo_sheet_id) then return false;end if;
 if q.state='succeeded' then return exists(select 1 from app.photo_sheet_artifacts where tenant_id=t and sheet_id=q.photo_sheet_id and bytes=pdf);end if;
 if q.state<>'leased' or q.lease_expires_at<=now() or pdf is null or octet_length(pdf) not between 1 and 5242880 or substring(pdf from 1 for 5)<>convert_to('%PDF-','UTF8') or pages is null or pages not between 1 and 10 then return false;end if;
 insert into app.photo_sheet_artifacts values(t,q.photo_sheet_id,pdf,encode(sha256(pdf),'hex'),pages,now());
 insert into app.job_effects(tenant_id,job_id,job_type,photo_sheet_id,processor_version,input_hash,result_hash) values(t,j,'render_photo_sheet',q.photo_sheet_id,q.processor_version,h,encode(sha256(pdf),'hex'));
 update app.jobs set state='succeeded',lease_expires_at=null,updated_at=now() where tenant_id=t and id=j;
 update app.outbox set state='published' where tenant_id=t and job_id=j;return true;
end $$;
revoke all on function app.claim_photo_sheet(text,uuid),app.photo_sheet_input(uuid,uuid,uuid),app.complete_photo_sheet(uuid,uuid,uuid,text,bytea,integer) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.claim_photo_sheet(text,uuid),app.photo_sheet_input(uuid,uuid,uuid),app.complete_photo_sheet(uuid,uuid,uuid,text,bytea,integer) to sigongnote_worker;
