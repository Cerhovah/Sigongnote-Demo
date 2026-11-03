-- D07: real parser output and job effect commit in one transaction.
create table app.parse_results (
 tenant_id uuid not null, job_id uuid not null, revision_id uuid not null,
 processor_version text not null, input_hash text not null,
 output jsonb not null check (jsonb_typeof(output)='object' and octet_length(output::text)<=4194304),
 created_at timestamptz not null default now(),
 primary key(tenant_id,job_id),
 foreign key(tenant_id,job_id) references app.jobs(tenant_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id),
 unique(tenant_id,revision_id,processor_version,input_hash)
);
alter table app.parse_results enable row level security;
revoke all on app.parse_results from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.parse_results to sigongnote_api;
create policy parse_results_read on app.parse_results for select to sigongnote_api
 using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));

-- Lock consent before the job, matching source revocation lock order.
create function app.parse_source_allowed(p_tenant uuid,p_job uuid,p_policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare r record;
begin
 for r in select s.*,i.source_generation from app.upload_intents i
 join app.jobs j on j.tenant_id=i.tenant_id and j.evidence_revision_id=i.completed_revision_id
 join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
 where j.tenant_id=p_tenant and j.id=p_job order by s.id for share of s
 loop
  if not r.active or not r.local_selection_consent or not r.server_upload_consent
   or r.generation<>r.source_generation or (r.scope is not null and r.processing_policy is distinct from p_policy)
   or not exists(select 1 from app.devices d where d.tenant_id=p_tenant and d.id=r.device_id and d.active)
   or not exists(select 1 from app.memberships m where m.tenant_id=p_tenant and m.user_id=r.user_id and m.active and m.revoked_at is null)
  then return false; end if;
 end loop;
 return true;
end $$;
revoke all on function app.parse_source_allowed(uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;

create function app.parse_job_input(p_tenant uuid,p_job uuid,p_token uuid,p_policy jsonb)
returns table(storage_key text,byte_length bigint,sha256 text,mime text)
language plpgsql security definer set search_path='' as $$
begin
 if not app.parse_source_allowed(p_tenant,p_job,p_policy) then return; end if;
 return query select b.storage_key,b.byte_length,b.sha256,r.declared_mime
 from app.jobs j join app.document_revisions r on r.tenant_id=j.tenant_id and r.id=j.evidence_revision_id
 join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
 where j.tenant_id=p_tenant and j.id=p_job and j.lease_token=p_token
 and j.state='leased' and j.lease_expires_at>now() and b.storage_location='server'
 and b.scan_state<>'quarantined' and b.sha256=j.input_hash;
end $$;

alter function app.complete_parse_job(uuid,uuid,uuid,text) rename to complete_parse_job_legacy;
revoke all on function app.complete_parse_job_legacy(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
-- Retain old fixture test interface. Real jobs cannot complete without output.
create function app.complete_parse_job(p_tenant uuid,p_job uuid,p_token uuid,p_result_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from app.jobs where tenant_id=p_tenant and id=p_job and processor_version='fixture-v1') then return false; end if;
 return app.complete_parse_job_legacy(p_tenant,p_job,p_token,p_result_hash);
end $$;

create function app.complete_parse_output(p_tenant uuid,p_job uuid,p_token uuid,p_output jsonb,p_policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j app.jobs%rowtype; result_hash text;
begin
 if not app.parse_source_allowed(p_tenant,p_job,p_policy) then return false; end if;
 select * into j from app.jobs where tenant_id=p_tenant and id=p_job for update;
 if not found or j.lease_token is distinct from p_token then return false; end if;
 if j.state='succeeded' then return exists(select 1 from app.parse_results where tenant_id=p_tenant and job_id=p_job and output=p_output); end if;
 if j.state<>'leased' or j.lease_expires_at<=now() then return false; end if;
 if jsonb_typeof(p_output) is distinct from 'object' or octet_length(p_output::text)>4194304
  or p_output->>'sourceHash' is distinct from j.input_hash
  or p_output->>'schemaVersion' is distinct from 'parse-output-v1'
  or p_output->>'processorVersion' is distinct from j.processor_version
  or coalesce(p_output->>'status','') not in ('complete','partial','encrypted','corrupt','unsupported','quarantined','failed')
  or jsonb_typeof(p_output->'spans') is distinct from 'array'
 then return false; end if;
 result_hash:=encode(sha256(convert_to(p_output::text,'UTF8')),'hex');
 if not app.complete_parse_job_legacy(p_tenant,p_job,p_token,result_hash) then return false; end if;
 insert into app.parse_results(tenant_id,job_id,revision_id,processor_version,input_hash,output)
 values(p_tenant,p_job,j.evidence_revision_id,j.processor_version,j.input_hash,p_output);
 update app.document_revisions set parse_state=p_output->>'status'
 where tenant_id=p_tenant and id=j.evidence_revision_id;
 update app.outbox set state='published' where tenant_id=p_tenant and job_id=p_job and state='pending';
 return true;
end $$;
revoke all on function app.parse_job_input(uuid,uuid,uuid,jsonb),app.complete_parse_output(uuid,uuid,uuid,jsonb,jsonb),app.complete_parse_job(uuid,uuid,uuid,text)
 from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.parse_job_input(uuid,uuid,uuid,jsonb),app.complete_parse_output(uuid,uuid,uuid,jsonb,jsonb),app.complete_parse_job(uuid,uuid,uuid,text) to sigongnote_worker;

create function app.claim_parse_job(p_worker text, p_lease_seconds integer, p_processor text)
returns table (tenant_id uuid, job_id uuid, lease_token uuid, revision_id uuid,
  expected_sha256 text, processor_version text, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if length(p_worker) not between 1 and 128 or p_lease_seconds not between 30 and 300 then
    raise exception 'Invalid worker lease request' using errcode = '23514';
  end if;
  update app.jobs j set state = 'dead', last_error_code = 'LEASE_EXHAUSTED',
    lease_expires_at = null, updated_at = now()
    where j.processor_version=p_processor and j.state = 'leased'
      and j.lease_expires_at <= now() and j.attempt_count >= 5;
  return query
    with chosen as (
      select j.tenant_id, j.id from app.jobs j
      where j.processor_version=p_processor and j.job_type = 'parse_original'
        and j.attempt_count < 5 and (
          (j.state in ('queued','retry_wait') and j.available_at <= now()) or
          (j.state = 'leased' and j.lease_expires_at <= now()))
      order by j.available_at, j.created_at, j.tenant_id, j.id
      for update skip locked limit 1
    )
    update app.jobs j set state = 'leased', attempt_count = j.attempt_count + 1,
      lease_owner = p_worker, lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from chosen c where j.tenant_id = c.tenant_id and j.id = c.id
    returning j.tenant_id, j.id, j.lease_token, j.evidence_revision_id,
      j.input_hash, j.processor_version, j.attempt_count;
end;
$$;


revoke all on function app.claim_parse_job(text,integer,text) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.claim_parse_job(text,integer,text) to sigongnote_worker;
-- Retain old effects as evidence, add real work for historical server originals.
insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
select r.tenant_id,'parse_original',r.id,'document-python-v1',b.sha256
from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
where b.storage_location='server' and b.scan_state<>'quarantined'
on conflict(tenant_id,job_type,evidence_revision_id,processor_version,input_hash) do nothing;
insert into app.outbox(tenant_id,job_id,topic,operation_key)
select tenant_id,id,'parse_original_ready','parse_original:'||id::text from app.jobs where processor_version='document-python-v1'
on conflict(tenant_id,operation_key) do nothing;
update app.jobs set state='cancelled',lease_expires_at=null,last_error_code='SUPERSEDED',updated_at=now()
where processor_version='fixture-v1' and state in ('queued','leased','retry_wait');
update app.outbox o set state='cancelled' from app.jobs j where j.tenant_id=o.tenant_id and j.id=o.job_id and j.last_error_code='SUPERSEDED';
