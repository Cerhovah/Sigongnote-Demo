-- N02 repair: a PDF page window is a durable checkpoint, not a completed parse.
-- Existing index RLS hides every staging/checkpoint row until atomic publication.
alter table app.evidence_chunk_indexes
 add column checkpoint_page integer not null default 1 check(checkpoint_page>=1),
 add column checkpoint_chunks integer not null default 0 check(checkpoint_chunks>=0),
 add column checkpoint_output jsonb check(checkpoint_output is null or
  (jsonb_typeof(checkpoint_output)='object' and octet_length(checkpoint_output::text)<=4194304));

create function app.pdf_parse_progress(t uuid,jid uuid,token uuid,policy jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare idx app.evidence_chunk_indexes%rowtype;
begin
 if not exists(select 1 from app.parse_job_input(t,jid,token,policy) where mime='application/pdf') then return null;end if;
 select * into idx from app.evidence_chunk_indexes where tenant_id=t and job_id=jid;
 if found and idx.published then return null;end if;
 return jsonb_build_object('nextPage',coalesce(idx.checkpoint_page,1),'chunkCount',coalesce(idx.checkpoint_chunks,0),'output',idx.checkpoint_output);
end $$;

create function app.begin_pdf_evidence_batch(t uuid,jid uuid,token uuid,start_page integer,m jsonb,policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j app.jobs%rowtype;idx app.evidence_chunk_indexes%rowtype;total integer;processed integer;
begin
 if not exists(select 1 from app.parse_job_input(t,jid,token,policy) where mime='application/pdf') then return false;end if;
 select * into j from app.jobs where tenant_id=t and id=jid for update;
 if not found or j.state<>'leased' or j.lease_token is distinct from token or j.lease_expires_at<=now() then return false;end if;
 select * into idx from app.evidence_chunk_indexes where tenant_id=t and job_id=jid;
 if idx.published or start_page is distinct from coalesce(idx.checkpoint_page,1) then return false;end if;
 if m->>'schemaVersion' is distinct from 'evidence-chunks-v1' or jsonb_typeof(m->'chunkCount') is distinct from 'number'
  or (m->>'chunkCount')::numeric not between coalesce(idx.checkpoint_chunks,0) and 2147483647
  or (m->>'chunkCount')::numeric<>trunc((m->>'chunkCount')::numeric)
  or length(coalesce(m->>'parserVersion','')) not between 1 and 100
  or jsonb_typeof(m->'coverage') is distinct from 'object'
  or coalesce(m->>'sourceStatus','') not in ('complete','partial','encrypted','corrupt','unsupported','quarantined','failed')
  or m->>'completeExtractedText' is distinct from 'true' then return false;end if;
 total:=coalesce((m#>>'{coverage,pages_seen}')::integer,0);
 processed:=coalesce((m#>>'{coverage,pages_processed}')::integer,0);
 if total<0 or processed<0 or processed>total or processed>start_page+199
  or (total>0 and processed<start_page) or (total=0 and start_page<>1)
  or (processed<total and (m#>>'{coverage,next_page}')::integer is distinct from processed+1)
  or (processed=total and coalesce(m#>>'{coverage,next_page}','')<>'') then return false;end if;
 if idx.checkpoint_output is not null and (
  total is distinct from (idx.checkpoint_output#>>'{coverage,pages_seen}')::integer
  or m->>'parserVersion' is distinct from idx.manifest->>'parserVersion') then return false;end if;
 if idx.job_id is null then return app.begin_evidence_index(t,jid,token,m,policy);end if;
 -- Discard only this job's uncommitted tail left by a failed/expired lease.
 delete from app.evidence_chunks where tenant_id=t and job_id=jid and ordinal>=idx.checkpoint_chunks;
 update app.evidence_chunk_indexes set manifest=m,parser_version=m->>'parserVersion',chunk_count=(m->>'chunkCount')::integer
 where tenant_id=t and job_id=jid;
 return true;
end $$;

create function app.checkpoint_pdf_parse(t uuid,jid uuid,token uuid,start_page integer,o jsonb,policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j app.jobs%rowtype;idx app.evidence_chunk_indexes%rowtype;n bigint;last_ordinal integer;next_page integer;
begin
 if not exists(select 1 from app.parse_job_input(t,jid,token,policy) where mime='application/pdf') then return false;end if;
 select * into j from app.jobs where tenant_id=t and id=jid for update;
 if not found or j.state<>'leased' or j.lease_token is distinct from token or j.lease_expires_at<=now() then return false;end if;
 select * into idx from app.evidence_chunk_indexes where tenant_id=t and job_id=jid;
 if not found or idx.published or idx.checkpoint_page is distinct from start_page
  or idx.manifest is distinct from o->'evidence' or o->'coverage' is distinct from idx.manifest->'coverage'
  or o->>'sourceHash' is distinct from j.input_hash or o->>'processorVersion' is distinct from j.processor_version
  or o->>'schemaVersion' is distinct from 'parse-output-v1' or jsonb_typeof(o->'spans') is distinct from 'array'
  or jsonb_array_length(o->'spans')>1000 or octet_length(o::text)>4194304 then return false;end if;
 select count(*),max(ordinal) into n,last_ordinal from app.evidence_chunks where tenant_id=t and job_id=jid;
 if n<>idx.chunk_count or (n>0 and last_ordinal<>n-1) then return false;end if;
 next_page:=(o#>>'{coverage,next_page}')::integer;
 if next_page is null then return app.complete_parse_output(t,jid,token,o,policy);end if;
 if next_page<=start_page or next_page>start_page+200 or next_page>(o#>>'{coverage,pages_seen}')::integer
  or next_page is distinct from (o#>>'{coverage,pages_processed}')::integer+1 then return false;end if;
 update app.evidence_chunk_indexes set checkpoint_page=next_page,checkpoint_chunks=chunk_count,checkpoint_output=o
 where tenant_id=t and job_id=jid;
 -- Successful progress is not a failed attempt. Yield the job so other files can run.
 update app.jobs set state='queued',attempt_count=0,available_at=now(),lease_owner=null,lease_token=null,
  lease_expires_at=null,last_error_code=null,updated_at=now() where tenant_id=t and id=jid;
 return true;
end $$;

revoke all on function app.pdf_parse_progress(uuid,uuid,uuid,jsonb),
 app.begin_pdf_evidence_batch(uuid,uuid,uuid,integer,jsonb,jsonb),
 app.checkpoint_pdf_parse(uuid,uuid,uuid,integer,jsonb,jsonb)
 from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.pdf_parse_progress(uuid,uuid,uuid,jsonb),
 app.begin_pdf_evidence_batch(uuid,uuid,uuid,integer,jsonb,jsonb),
 app.checkpoint_pdf_parse(uuid,uuid,uuid,integer,jsonb,jsonb) to sigongnote_worker;

-- Expose only processing counters, never unpublished source text.
create function app.read_pdf_parse_progress(t uuid,r uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('pages_processed',coalesce(i.checkpoint_page-1,0),
  'pages_seen',coalesce((i.manifest#>>'{coverage,pages_seen}')::integer,0),'state',j.state)
 from (select * from app.jobs where tenant_id=t and evidence_revision_id=r and job_type='parse_original'
  and processor_version in ('document-python-v1','document-evidence-v1','document-pdf-pages-v1')
  order by created_at desc,id desc limit 1) j
 join app.document_revisions d on d.tenant_id=j.tenant_id and d.id=j.evidence_revision_id
 left join app.evidence_chunk_indexes i on i.tenant_id=j.tenant_id and i.job_id=j.id
 where j.tenant_id=t and j.evidence_revision_id=r and d.declared_mime='application/pdf'
  and j.job_type='parse_original' and j.processor_version in ('document-python-v1','document-evidence-v1','document-pdf-pages-v1')
  and j.state<>'succeeded' and app.revision_accessible(t,r)
 order by j.created_at desc,j.id desc limit 1
$$;
revoke all on function app.read_pdf_parse_progress(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.read_pdf_parse_progress(uuid,uuid) to sigongnote_api;

-- Preserve previous effects and excerpts; re-index only PDFs stopped by the old page cap.
insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
select distinct p.tenant_id,'parse_original',p.revision_id,'document-pdf-pages-v1',p.input_hash
from app.parse_results p join app.document_revisions r on r.tenant_id=p.tenant_id and r.id=p.revision_id
where r.declared_mime='application/pdf' and not r.generated_output
 and ((p.output->'coverage') ? 'next_page' or p.output->'issues' ? 'page_limit_exceeded')
 and not exists(select 1 from app.jobs active where active.tenant_id=p.tenant_id and active.evidence_revision_id=p.revision_id
  and active.job_type='parse_original' and active.processor_version in ('document-python-v1','document-evidence-v1','document-pdf-pages-v1')
  and active.state in ('queued','retry_wait','leased'))
on conflict(tenant_id,job_type,evidence_revision_id,processor_version,input_hash) do nothing;
insert into app.outbox(tenant_id,job_id,topic,operation_key)
select tenant_id,id,'parse_original_ready','parse_original:'||id::text from app.jobs where processor_version='document-pdf-pages-v1'
on conflict(tenant_id,operation_key) do nothing;
