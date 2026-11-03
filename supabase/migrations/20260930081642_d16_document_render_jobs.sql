-- Generated revisions are typed job subjects, never counterfeit source evidence.
alter table app.jobs alter column evidence_revision_id drop not null;
alter table app.jobs add column generated_revision_id uuid;
alter table app.jobs add constraint jobs_generated_fk foreign key(tenant_id,generated_revision_id) references app.business_document_revisions(tenant_id,id);
alter table app.jobs drop constraint jobs_job_type_check;
alter table app.jobs add constraint jobs_subject_check check((job_type='parse_original' and evidence_revision_id is not null and generated_revision_id is null) or(job_type='render_document' and generated_revision_id is not null and evidence_revision_id is null));
create unique index jobs_generated_once on app.jobs(tenant_id,generated_revision_id,processor_version,input_hash) where job_type='render_document';
alter table app.job_effects alter column evidence_revision_id drop not null;
alter table app.job_effects add column generated_revision_id uuid;
alter table app.job_effects add constraint effects_generated_fk foreign key(tenant_id,generated_revision_id) references app.business_document_revisions(tenant_id,id);
alter table app.job_effects add constraint effects_original_fk foreign key(tenant_id,evidence_revision_id) references app.document_revisions(tenant_id,id);
alter table app.job_effects add constraint effects_subject_check check((job_type='parse_original' and evidence_revision_id is not null and generated_revision_id is null) or(job_type='render_document' and generated_revision_id is not null and evidence_revision_id is null));
create unique index effects_generated_once on app.job_effects(tenant_id,generated_revision_id,processor_version,input_hash) where job_type='render_document';
alter table app.outbox drop constraint outbox_topic_check;
alter table app.outbox add constraint outbox_topic_check check(topic in ('parse_original_ready','render_document_ready'));
create table app.document_artifacts (
 tenant_id uuid not null,revision_id uuid not null,format text not null check(format in ('pdf','xlsx')),
 bytes bytea not null check(octet_length(bytes) between 1 and 5242880),sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 template_version text not null,created_at timestamptz not null default now(),
 primary key(tenant_id,revision_id,format),foreign key(tenant_id,revision_id) references app.business_document_revisions(tenant_id,id),
 check(encode(sha256(bytes),'hex')=sha256)
);
alter table app.document_artifacts enable row level security;
revoke all on app.document_artifacts from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.document_artifacts to sigongnote_api;
create policy document_artifacts_read on app.document_artifacts for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create function app.queue_document_render() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ declare job uuid;begin
 insert into app.jobs(tenant_id,job_type,generated_revision_id,processor_version,input_hash) values(new.tenant_id,'render_document',new.id,'kr-basic-v1',new.snapshot_hash) returning id into job;
 insert into app.outbox(tenant_id,job_id,topic,operation_key) values(new.tenant_id,job,'render_document_ready','render_document:'||job::text);return new;end $$;
create trigger business_revision_render after insert on app.business_document_revisions for each row execute function app.queue_document_render();
-- A narrowly scoped definer is required for the existing worker role, which has no table access.
create function app.render_authorized(p_tenant uuid,p_revision uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid;refs jsonb;old_sub text;ok boolean;
begin
 select d.actor_id,s.basis_snapshot->'references' into actor,refs from app.business_document_revisions r join app.business_documents d on d.tenant_id=r.tenant_id and d.id=r.document_id join app.document_drafts s on s.tenant_id=r.tenant_id and s.id=r.draft_id where r.tenant_id=p_tenant and r.id=p_revision and not exists(select 1 from app.document_lifecycle_events e where e.tenant_id=d.tenant_id and e.document_id=d.id);
 if actor is null or not exists(select 1 from app.memberships where tenant_id=p_tenant and user_id=actor and role='owner' and active and revoked_at is null) then return false;end if;
 old_sub:=current_setting('request.jwt.claim.sub',true);perform set_config('request.jwt.claim.sub',actor::text,true);
 select not exists(select 1 from jsonb_array_elements_text(refs) x where not app.revision_accessible(p_tenant,x::uuid)) into ok;
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);return ok;
end $$;
revoke all on function app.render_authorized(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create function app.claim_render_job(p_owner text,p_tenant uuid default null) returns table(tenant_id uuid,job_id uuid,lease_token uuid,revision_id uuid,input_hash text) language plpgsql security definer set search_path='' as $$ begin
 if length(p_owner) not between 1 and 128 then raise exception 'invalid owner';end if;
 update app.jobs j set state='dead',lease_expires_at=null,last_error_code='LEASE_EXHAUSTED' where j.job_type='render_document' and (p_tenant is null or j.tenant_id=p_tenant) and j.state='leased' and j.lease_expires_at<=now() and j.attempt_count>=5;
 return query with chosen as(select j.tenant_id,j.id from app.jobs j where j.job_type='render_document' and j.processor_version='kr-basic-v1' and(p_tenant is null or j.tenant_id=p_tenant) and j.attempt_count<5 and ((j.state in ('queued','retry_wait') and j.available_at<=now()) or(j.state='leased' and j.lease_expires_at<=now())) order by j.created_at,j.id for update skip locked limit 1)
 update app.jobs j set state='leased',attempt_count=j.attempt_count+1,lease_token=gen_random_uuid(),lease_owner=p_owner,lease_expires_at=now()+interval '60 seconds' from chosen c where j.tenant_id=c.tenant_id and j.id=c.id returning j.tenant_id,j.id,j.lease_token,j.generated_revision_id,j.input_hash;
end $$;
create function app.render_job_input(p_tenant uuid,p_job uuid,p_token uuid) returns table(snapshot jsonb,input_hash text) language plpgsql security definer set search_path='' as $$ begin
 return query select r.snapshot,j.input_hash from app.jobs j join app.business_document_revisions r on r.tenant_id=j.tenant_id and r.id=j.generated_revision_id where j.tenant_id=p_tenant and j.id=p_job and j.job_type='render_document' and j.processor_version='kr-basic-v1' and j.state='leased' and j.lease_token=p_token and j.lease_expires_at>now() and r.snapshot_hash=j.input_hash and app.render_authorized(j.tenant_id,r.id);
end $$;
create function app.complete_render_job(p_tenant uuid,p_job uuid,p_token uuid,p_hash text,p_pdf bytea,p_xlsx bytea) returns boolean language plpgsql security definer set search_path='' as $$ declare j app.jobs%rowtype;result_hash text;begin
 select * into j from app.jobs where tenant_id=p_tenant and id=p_job for update;
 if j.id is null or j.job_type<>'render_document' or j.lease_token is distinct from p_token or j.input_hash<>p_hash or not app.render_authorized(p_tenant,j.generated_revision_id) then return false;end if;
 if j.state='succeeded' then return exists(select 1 from app.document_artifacts where tenant_id=p_tenant and revision_id=j.generated_revision_id and format='pdf' and bytes=p_pdf) and exists(select 1 from app.document_artifacts where tenant_id=p_tenant and revision_id=j.generated_revision_id and format='xlsx' and bytes=p_xlsx);end if;
 if p_pdf is null or p_xlsx is null or p_hash is null or j.state<>'leased' or j.lease_expires_at<=now() or octet_length(p_pdf) not between 1 and 5242880 or octet_length(p_xlsx) not between 1 and 5242880 or substring(p_pdf from 1 for 5)<>convert_to('%PDF-','UTF8') or substring(p_xlsx from 1 for 2)<>decode('504b','hex') then return false;end if;
 insert into app.document_artifacts(tenant_id,revision_id,format,bytes,sha256,template_version) values(p_tenant,j.generated_revision_id,'pdf',p_pdf,encode(sha256(p_pdf),'hex'),'kr-basic-v1'),(p_tenant,j.generated_revision_id,'xlsx',p_xlsx,encode(sha256(p_xlsx),'hex'),'kr-basic-v1');
 result_hash:=encode(sha256(p_pdf||p_xlsx),'hex');
 insert into app.job_effects(tenant_id,job_id,job_type,generated_revision_id,processor_version,input_hash,result_hash) values(p_tenant,p_job,'render_document',j.generated_revision_id,j.processor_version,j.input_hash,result_hash);
 update app.jobs set state='succeeded',lease_expires_at=null,updated_at=now() where tenant_id=p_tenant and id=p_job;
 update app.outbox set state='published' where tenant_id=p_tenant and job_id=p_job;return true;
end $$;
revoke all on function app.claim_render_job(text,uuid),app.render_job_input(uuid,uuid,uuid),app.complete_render_job(uuid,uuid,uuid,text,bytea,bytea) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.claim_render_job(text,uuid),app.render_job_input(uuid,uuid,uuid),app.complete_render_job(uuid,uuid,uuid,text,bytea,bytea) to sigongnote_worker;

create function app.retry_document_render(p_tenant uuid,p_revision uuid) returns boolean language plpgsql security definer set search_path='' as $$ begin
 if not app.has_tenant_role(p_tenant,array['owner']) or not app.render_authorized(p_tenant,p_revision) then return false;end if;
 update app.jobs set state='queued',attempt_count=0,available_at=now(),last_error_code=null where tenant_id=p_tenant and generated_revision_id=p_revision and job_type='render_document' and state in ('dead','retry_wait');return found;end $$;
revoke all on function app.retry_document_render(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.retry_document_render(uuid,uuid) to sigongnote_api;

-- Preserve prior approved D15 revisions during an additive rollout.
with added as (
 insert into app.jobs(tenant_id,job_type,generated_revision_id,processor_version,input_hash)
 select r.tenant_id,'render_document',r.id,'kr-basic-v1',r.snapshot_hash from app.business_document_revisions r
 where not exists(select 1 from app.jobs j where j.tenant_id=r.tenant_id and j.generated_revision_id=r.id)
 returning tenant_id,id
) insert into app.outbox(tenant_id,job_id,topic,operation_key) select tenant_id,id,'render_document_ready','render_document:'||id::text from added;

-- Issued purchase quantities reserve the next draft; cancelling an unsent order releases them.
create function app.track_document_order() returns trigger language plpgsql security definer set search_path='' as $$
declare draft uuid;kind text;begin
 if tg_table_name='business_document_revisions' then
  select document_type into kind from app.business_documents where tenant_id=new.tenant_id and id=new.document_id;
  if kind<>'purchase_order' then return new;end if;
  update app.purchase_orders set state='approved',version=version+1 where tenant_id=new.tenant_id and draft_id=new.draft_id and state='draft';
  if not found then raise exception 'purchase order changed';end if;
 else
  select d.document_type,r.draft_id into kind,draft from app.business_documents d join app.business_document_revisions r on r.tenant_id=d.tenant_id and r.document_id=d.id where d.tenant_id=new.tenant_id and d.id=new.document_id order by r.version desc limit 1;
  if kind<>'purchase_order' then return new;end if;
  update app.purchase_orders set state='cancelled',version=version+1 where tenant_id=new.tenant_id and draft_id=draft and state='approved';
  if not found then raise exception 'confirmed delivery requires reconciliation';end if;
 end if;return new;end $$;
revoke all on function app.track_document_order() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger issued_purchase_quantities after insert on app.business_document_revisions for each row execute function app.track_document_order();
create trigger cancelled_purchase_quantities after insert on app.document_lifecycle_events for each row execute function app.track_document_order();
update app.purchase_orders p set state='approved',version=version+1 where state='draft' and exists(select 1 from app.business_document_revisions r where r.tenant_id=p.tenant_id and r.draft_id=p.draft_id and not exists(select 1 from app.document_lifecycle_events e where e.tenant_id=r.tenant_id and e.document_id=r.document_id));
