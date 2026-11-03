-- N02: extracted source text is durable independently of the <=1000 screen excerpt.
-- All three tables are covered by recovery-drill's app-schema inventory and row hash manifest.
create table app.evidence_chunk_indexes (
 tenant_id uuid not null,job_id uuid not null,revision_id uuid not null,
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 parser_version text not null check(length(parser_version) between 1 and 100),
 manifest jsonb not null check(jsonb_typeof(manifest)='object' and octet_length(manifest::text)<=65536),
 source_generations jsonb not null,chunk_count integer not null check(chunk_count>=0),
 published boolean not null default false,created_at timestamptz not null default now(),
 primary key(tenant_id,job_id),foreign key(tenant_id,job_id) references app.jobs(tenant_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id)
);
create index evidence_chunk_indexes_revision on app.evidence_chunk_indexes(tenant_id,revision_id,created_at desc,job_id);
create table app.evidence_chunks (
 tenant_id uuid not null,job_id uuid not null,revision_id uuid not null,ordinal integer not null check(ordinal>=0),
 text text not null check(length(text) between 1 and 1000),locator text not null check(length(locator) between 1 and 1000),
 "position" jsonb not null check(jsonb_typeof("position")='object' and octet_length("position"::text)<=16384),
 content_hash text not null check(content_hash=encode(sha256(convert_to(text,'UTF8')),'hex')),
 primary key(tenant_id,job_id,ordinal),
 foreign key(tenant_id,job_id) references app.evidence_chunk_indexes(tenant_id,job_id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id)
);
create index evidence_chunks_revision on app.evidence_chunks(tenant_id,revision_id,job_id,ordinal);
create index evidence_chunks_text_search on app.evidence_chunks using gin(to_tsvector('simple',text));
create table app.evidence_retention_tasks (
 tenant_id uuid not null,revision_id uuid not null,source_id uuid not null,source_generation integer not null,
 evidence_status text not null default 'withdrawn' check(evidence_status='withdrawn'),
 state text not null default 'awaiting_retention_policy' check(state in ('awaiting_retention_policy','deletion_requested','purged')),
 created_at timestamptz not null default now(),
 primary key(tenant_id,revision_id),foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id),
 foreign key(tenant_id,source_id) references app.capture_sources(tenant_id,id)
);
alter table app.evidence_chunk_indexes enable row level security;
alter table app.evidence_chunks enable row level security;
alter table app.evidence_retention_tasks enable row level security;
revoke all on app.evidence_chunk_indexes,app.evidence_chunks,app.evidence_retention_tasks from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant select on app.evidence_chunk_indexes,app.evidence_chunks,app.evidence_retention_tasks to sigongnote_api;
create policy evidence_index_read on app.evidence_chunk_indexes for select to sigongnote_api
 using(published and app.revision_accessible(tenant_id,revision_id));
create policy evidence_chunk_read on app.evidence_chunks for select to sigongnote_api
 using(app.revision_accessible(tenant_id,revision_id) and exists(select 1 from app.evidence_chunk_indexes i where i.tenant_id=evidence_chunks.tenant_id and i.job_id=evidence_chunks.job_id and i.published));
create policy evidence_retention_owner on app.evidence_retention_tasks for select to sigongnote_api
 using(app.has_tenant_role(tenant_id,array['owner']));

-- The worker has no table privileges. Every write is fenced by the existing source policy + job lease.
create function app.begin_evidence_index(t uuid,jid uuid,token uuid,m jsonb,policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j app.jobs%rowtype; old app.evidence_chunk_indexes%rowtype; generations jsonb;
begin
 if not app.parse_source_allowed(t,jid,policy) then return false;end if;
 select * into j from app.jobs where tenant_id=t and id=jid for update;
 if not found or j.state<>'leased' or j.lease_token is distinct from token or j.lease_expires_at<=now() then return false;end if;
 if m->>'schemaVersion' is distinct from 'evidence-chunks-v1' or jsonb_typeof(m->'chunkCount') is distinct from 'number'
  or (m->>'chunkCount')::numeric not between 0 and 2147483647 or (m->>'chunkCount')::numeric<>trunc((m->>'chunkCount')::numeric)
  or length(coalesce(m->>'parserVersion','')) not between 1 and 100 or jsonb_typeof(m->'coverage') is distinct from 'object'
  or m->>'sourceStatus' not in ('complete','partial','encrypted','corrupt','unsupported','quarantined','failed')
  or m->>'completeExtractedText' is distinct from 'true' then return false;end if;
 select coalesce(jsonb_agg(jsonb_build_object('source_id',i.source_id,'generation',i.source_generation) order by i.source_id),'[]'::jsonb)
 into generations from app.upload_intents i where i.tenant_id=t and i.completed_revision_id=j.evidence_revision_id and i.source_id is not null;
 select * into old from app.evidence_chunk_indexes where tenant_id=t and job_id=jid;
 if found then
  if old.published then return false;end if;
  if old.manifest is distinct from m or old.source_generations is distinct from generations then
   delete from app.evidence_chunks where tenant_id=t and job_id=jid;
   update app.evidence_chunk_indexes set manifest=m,source_generations=generations,parser_version=m->>'parserVersion',chunk_count=(m->>'chunkCount')::integer where tenant_id=t and job_id=jid;
  end if;
 else
  insert into app.evidence_chunk_indexes(tenant_id,job_id,revision_id,source_hash,parser_version,manifest,source_generations,chunk_count)
  values(t,jid,j.evidence_revision_id,j.input_hash,m->>'parserVersion',m,generations,(m->>'chunkCount')::integer);
 end if;
 return true;
end $$;
create function app.stage_evidence_chunks(t uuid,jid uuid,token uuid,batch jsonb,policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j app.jobs%rowtype; idx app.evidence_chunk_indexes%rowtype; c jsonb;old app.evidence_chunks%rowtype;
begin
 if not app.parse_source_allowed(t,jid,policy) then return false;end if;
 select * into j from app.jobs where tenant_id=t and id=jid for update;
 if not found or j.state<>'leased' or j.lease_token is distinct from token or j.lease_expires_at<=now() then return false;end if;
 select * into idx from app.evidence_chunk_indexes where tenant_id=t and job_id=jid;
 if not found or idx.published then return false;end if;
 if jsonb_typeof(batch) is distinct from 'array' or jsonb_array_length(batch)>200 or octet_length(batch::text)>2097152 then return false;end if;
 for c in select value from jsonb_array_elements(batch) loop
  if (c->>'ordinal')::numeric<>trunc((c->>'ordinal')::numeric) or (c->>'ordinal')::integer not between 0 and idx.chunk_count-1
   or jsonb_typeof(c->'text') is distinct from 'string' or jsonb_typeof(c->'locator') is distinct from 'string'
   or jsonb_typeof(c->'position') is distinct from 'object' or c->>'contentHash' is distinct from encode(sha256(convert_to(c->>'text','UTF8')),'hex') then
   raise exception 'EVIDENCE_CHUNK_INVALID' using errcode='23514';end if;
  select * into old from app.evidence_chunks where tenant_id=t and job_id=jid and ordinal=(c->>'ordinal')::integer;
  if found then
   if old.text is distinct from c->>'text' or old.locator is distinct from c->>'locator' or old.position is distinct from c->'position' then
    raise exception 'EVIDENCE_CHUNK_CONFLICT' using errcode='23514';end if;
  else
   insert into app.evidence_chunks(tenant_id,job_id,revision_id,ordinal,text,locator,"position",content_hash)
   values(t,jid,j.evidence_revision_id,(c->>'ordinal')::integer,c->>'text',c->>'locator',c->'position',c->>'contentHash');
  end if;
 end loop;
 return true;
end $$;
revoke all on function app.begin_evidence_index(uuid,uuid,uuid,jsonb,jsonb),app.stage_evidence_chunks(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.begin_evidence_index(uuid,uuid,uuid,jsonb,jsonb),app.stage_evidence_chunks(uuid,uuid,uuid,jsonb,jsonb) to sigongnote_worker;

alter function app.complete_parse_output(uuid,uuid,uuid,jsonb,jsonb) rename to complete_parse_output_before_n02;
revoke all on function app.complete_parse_output_before_n02(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create function app.complete_parse_output(p_tenant uuid,p_job uuid,p_token uuid,p_output jsonb,p_policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare idx app.evidence_chunk_indexes%rowtype; n bigint; last_ordinal integer; ok boolean;
begin
 if not app.parse_source_allowed(p_tenant,p_job,p_policy) then return false;end if;
 perform 1 from app.jobs where tenant_id=p_tenant and id=p_job for update;
 if p_output ? 'evidence' then
  select * into idx from app.evidence_chunk_indexes where tenant_id=p_tenant and job_id=p_job;
  if not found or idx.manifest is distinct from p_output->'evidence' or idx.source_hash is distinct from p_output->>'sourceHash' then return false;end if;
  select count(*),max(ordinal) into n,last_ordinal from app.evidence_chunks where tenant_id=p_tenant and job_id=p_job;
  if n<>idx.chunk_count or (n>0 and last_ordinal<>n-1) then return false;end if;
 end if;
 ok:=app.complete_parse_output_before_n02(p_tenant,p_job,p_token,p_output,p_policy);
 if ok and p_output ? 'evidence' then update app.evidence_chunk_indexes set published=true where tenant_id=p_tenant and job_id=p_job;end if;
 return ok;
end $$;
revoke all on function app.complete_parse_output(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.complete_parse_output(uuid,uuid,uuid,jsonb,jsonb) to sigongnote_worker;

-- Legacy readers keep the short output. Search/readers opt into the complete published text.
create function app.revision_search_spans(t uuid,r uuid)
returns table(text text,locator text,ordinal integer,"position" jsonb) language sql stable security invoker set search_path='' as $$
 with latest as(select job_id from app.evidence_chunk_indexes where tenant_id=t and revision_id=r and published order by created_at desc,job_id desc limit 1)
 select c.text,c.locator,c.ordinal,c.position from app.evidence_chunks c join latest i on i.job_id=c.job_id where c.tenant_id=t and c.revision_id=r
 union all
 select s.value->>'text',s.value->>'locator',(s.ordinality-1)::integer,'{}'::jsonb
 from lateral(select output from app.parse_results where tenant_id=t and revision_id=r and app.revision_accessible(t,r) order by created_at desc,job_id desc limit 1)p,
 lateral jsonb_array_elements(p.output->'spans') with ordinality s(value,ordinality)
 where not exists(select 1 from latest)
$$;
revoke all on function app.revision_search_spans(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.revision_search_spans(uuid,uuid) to sigongnote_api;

-- A bounded worker read with current source generation and processing-policy checks.
create function app.evidence_chunk_batch(t uuid,r uuid,after_ordinal integer,page_limit integer,policy jsonb)
returns table(ordinal integer,text text,locator text,"position" jsonb,source_hash text,parser_version text,index_job_id uuid,chunk_count integer)
language plpgsql security definer set search_path='' as $$
declare idx app.evidence_chunk_indexes%rowtype;
begin
 if page_limit not between 1 and 200 or after_ordinal < -1 then return;end if;
 select i.* into idx from app.evidence_chunk_indexes i where i.tenant_id=t and i.revision_id=r and i.published order by i.created_at desc,i.job_id desc limit 1;
 if not found or not app.parse_source_allowed(t,idx.job_id,policy)
  or exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=t and w.revision_id=r)
  or not exists(select 1 from app.document_revisions d join app.evidence_blobs b on b.tenant_id=d.tenant_id and b.id=d.blob_id where d.tenant_id=t and d.id=r and b.scan_state<>'quarantined') then return;end if;
 return query select c.ordinal,c.text,c.locator,c.position,idx.source_hash,idx.parser_version,idx.job_id,idx.chunk_count
 from app.evidence_chunks c where c.tenant_id=t and c.job_id=idx.job_id and c.ordinal>after_ordinal order by c.ordinal limit page_limit;
end $$;
revoke all on function app.evidence_chunk_batch(uuid,uuid,integer,integer,jsonb) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.evidence_chunk_batch(uuid,uuid,integer,integer,jsonb) to sigongnote_worker;

-- Withdrawal is not an amount correction. Preserve business effects and only block source reuse.
alter table app.document_drafts add column evidence_stale boolean not null default false;
create function app.withdraw_source_evidence() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.active and (not new.active or not new.server_upload_consent or new.generation<>old.generation) then
  insert into app.evidence_retention_tasks(tenant_id,revision_id,source_id,source_generation)
  select distinct i.tenant_id,i.completed_revision_id,new.id,old.generation from app.upload_intents i
  where i.tenant_id=new.tenant_id and i.source_id=new.id and i.completed_revision_id is not null
  on conflict(tenant_id,revision_id) do nothing;
  update app.document_drafts d set evidence_stale=true where d.tenant_id=new.tenant_id and exists(
   select 1 from app.evidence_retention_tasks e where e.tenant_id=d.tenant_id and d.basis_snapshot->'references' ? e.revision_id::text);
 end if;return new;
end $$;
revoke all on function app.withdraw_source_evidence() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger source_evidence_withdrawn after update on app.capture_sources for each row execute function app.withdraw_source_evidence();
create or replace function app.revision_accessible(p_tenant uuid,p_revision uuid) returns boolean language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(p_tenant,array['owner','operator','accountant']) and exists(
 select 1 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
 where r.tenant_id=p_tenant and r.id=p_revision and b.storage_location='server' and b.scan_state<>'quarantined'
 and not exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=r.tenant_id and w.revision_id=r.id)
 and not exists(select 1 from app.upload_intents i join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
 where i.tenant_id=r.tenant_id and i.completed_revision_id=r.id and (not s.active or not s.server_upload_consent or s.generation<>i.source_generation)))
$$;
drop policy parse_results_read on app.parse_results;
create policy parse_results_read on app.parse_results for select to sigongnote_api using(app.revision_accessible(tenant_id,revision_id));
drop policy evidence_index_read on app.evidence_index;
create policy evidence_index_read on app.evidence_index for select to sigongnote_api using(app.revision_accessible(tenant_id,revision_id));
drop policy tenant_read on app.fact_candidates;
create policy tenant_read on app.fact_candidates for select to sigongnote_api using(app.revision_accessible(tenant_id,source_revision));

-- Reparse historical text locally, using the existing durable job queue and immutable effects.
insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
select distinct p.tenant_id,'parse_original',p.revision_id,'document-evidence-v1',p.input_hash
from app.parse_results p join app.document_revisions r on r.tenant_id=p.tenant_id and r.id=p.revision_id
where p.processor_version='document-python-v1' and not r.generated_output and r.declared_mime not like 'audio/%'
and not exists(select 1 from app.evidence_chunk_indexes i where i.tenant_id=p.tenant_id and i.revision_id=p.revision_id and i.published)
on conflict(tenant_id,job_type,evidence_revision_id,processor_version,input_hash) do nothing;
insert into app.outbox(tenant_id,job_id,topic,operation_key)
select tenant_id,id,'parse_original_ready','parse_original:'||id::text from app.jobs where processor_version='document-evidence-v1'
on conflict(tenant_id,operation_key) do nothing;
