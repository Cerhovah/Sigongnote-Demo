-- Preserve frozen v1 documents; record the actual template from each immutable snapshot.
create or replace function app.complete_render_job(p_tenant uuid,p_job uuid,p_token uuid,p_hash text,p_pdf bytea,p_xlsx bytea) returns boolean language plpgsql security definer set search_path='' as $$ declare j app.jobs%rowtype;result_hash text;form_version text;begin
 select * into j from app.jobs where tenant_id=p_tenant and id=p_job for update;
 if j.id is null or j.job_type<>'render_document' or j.lease_token is distinct from p_token or j.input_hash<>p_hash or not app.render_authorized(p_tenant,j.generated_revision_id) then return false;end if;
 if j.state='succeeded' then return exists(select 1 from app.document_artifacts where tenant_id=p_tenant and revision_id=j.generated_revision_id and format='pdf' and bytes=p_pdf) and exists(select 1 from app.document_artifacts where tenant_id=p_tenant and revision_id=j.generated_revision_id and format='xlsx' and bytes=p_xlsx);end if;
 if p_pdf is null or p_xlsx is null or p_hash is null or j.state<>'leased' or j.lease_expires_at<=now() or octet_length(p_pdf) not between 1 and 5242880 or octet_length(p_xlsx) not between 1 and 5242880 or substring(p_pdf from 1 for 5)<>convert_to('%PDF-','UTF8') or substring(p_xlsx from 1 for 2)<>decode('504b','hex') then return false;end if;
 select snapshot->>'template_version' into form_version from app.business_document_revisions where tenant_id=p_tenant and id=j.generated_revision_id and snapshot_hash=p_hash;
 if form_version is null or form_version not in ('kr-basic-v1','kr-business-v2') then return false;end if;
 insert into app.document_artifacts(tenant_id,revision_id,format,bytes,sha256,template_version) values(p_tenant,j.generated_revision_id,'pdf',p_pdf,encode(sha256(p_pdf),'hex'),form_version),(p_tenant,j.generated_revision_id,'xlsx',p_xlsx,encode(sha256(p_xlsx),'hex'),form_version);
 result_hash:=encode(sha256(p_pdf||p_xlsx),'hex');
 insert into app.job_effects(tenant_id,job_id,job_type,generated_revision_id,processor_version,input_hash,result_hash) values(p_tenant,p_job,'render_document',j.generated_revision_id,j.processor_version,j.input_hash,result_hash);
 update app.jobs set state='succeeded',lease_expires_at=null,updated_at=now() where tenant_id=p_tenant and id=p_job;
 update app.outbox set state='published' where tenant_id=p_tenant and job_id=p_job;return true;
end $$;

-- Queue/effect versions follow the frozen template; both versions remain renderable.
create or replace function app.queue_document_render() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ declare job uuid;begin
 insert into app.jobs(tenant_id,job_type,generated_revision_id,processor_version,input_hash) values(new.tenant_id,'render_document',new.id,new.snapshot->>'template_version',new.snapshot_hash) returning id into job;
 insert into app.outbox(tenant_id,job_id,topic,operation_key) values(new.tenant_id,job,'render_document_ready','render_document:'||job::text);return new;end $$;
create or replace function app.claim_render_job(p_owner text,p_tenant uuid default null) returns table(tenant_id uuid,job_id uuid,lease_token uuid,revision_id uuid,input_hash text) language plpgsql security definer set search_path='' as $$ begin
 if length(p_owner) not between 1 and 128 then raise exception 'invalid owner';end if;
 update app.jobs j set state='dead',lease_expires_at=null,last_error_code='LEASE_EXHAUSTED' where j.job_type='render_document' and (p_tenant is null or j.tenant_id=p_tenant) and j.state='leased' and j.lease_expires_at<=now() and j.attempt_count>=5;
 return query with chosen as(select j.tenant_id,j.id from app.jobs j where j.job_type='render_document' and j.processor_version in ('kr-basic-v1','kr-business-v2') and(p_tenant is null or j.tenant_id=p_tenant) and j.attempt_count<5 and ((j.state in ('queued','retry_wait') and j.available_at<=now()) or(j.state='leased' and j.lease_expires_at<=now())) order by j.created_at,j.id for update skip locked limit 1)
 update app.jobs j set state='leased',attempt_count=j.attempt_count+1,lease_token=gen_random_uuid(),lease_owner=p_owner,lease_expires_at=now()+interval '60 seconds' from chosen c where j.tenant_id=c.tenant_id and j.id=c.id returning j.tenant_id,j.id,j.lease_token,j.generated_revision_id,j.input_hash;
end $$;
create or replace function app.render_job_input(p_tenant uuid,p_job uuid,p_token uuid) returns table(snapshot jsonb,input_hash text) language plpgsql security definer set search_path='' as $$ begin
 return query select r.snapshot,j.input_hash from app.jobs j join app.business_document_revisions r on r.tenant_id=j.tenant_id and r.id=j.generated_revision_id where j.tenant_id=p_tenant and j.id=p_job and j.job_type='render_document' and j.processor_version in ('kr-basic-v1','kr-business-v2') and j.state='leased' and j.lease_token=p_token and j.lease_expires_at>now() and r.snapshot_hash=j.input_hash and app.render_authorized(j.tenant_id,r.id);
end $$;
