-- Smaller PDF windows survive worker restarts. A resume addresses one observed generation.
alter table app.jobs add column pdf_page_limit integer check(pdf_page_limit between 1 and 200),
 add column resume_generation integer not null default 0 check(resume_generation>=0);

create function app.fail_pdf_timeout(t uuid,jid uuid,token uuid,used_limit integer,policy jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_limit integer; reduced integer;
begin
 if used_limit is null or used_limit not between 1 and 200 or not exists(
  select 1 from app.parse_job_input(t,jid,token,policy) where mime='application/pdf') then return false;end if;
 select coalesce(pdf_page_limit,used_limit) into current_limit from app.jobs
 where tenant_id=t and id=jid and state='leased' and lease_token=token and lease_expires_at>now() for update;
 if not found then return false;end if;
 reduced:=greatest(1,least(current_limit,used_limit)/2);
 -- A finite reduction is progress; after reaching one page the ordinary retry limit applies.
 if reduced<least(current_limit,used_limit) then
  update app.jobs set pdf_page_limit=reduced,attempt_count=1 where tenant_id=t and id=jid;
 end if;
 perform app.fail_parse_job(t,jid,token,'PARSER_RETRY',true);
 if reduced<least(current_limit,used_limit) then
  update app.jobs set attempt_count=0,available_at=now()+interval '5 seconds' where tenant_id=t and id=jid;
 end if;
 return true;
end $$;
revoke all on function app.fail_pdf_timeout(uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.fail_pdf_timeout(uuid,uuid,uuid,integer,jsonb) to sigongnote_worker;

create or replace function app.pdf_parse_progress(t uuid,jid uuid,token uuid,policy jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('nextPage',coalesce(i.checkpoint_page,1),'chunkCount',coalesce(i.checkpoint_chunks,0),
  'output',i.checkpoint_output,'pageLimit',j.pdf_page_limit)
 from app.jobs j left join app.evidence_chunk_indexes i on i.tenant_id=j.tenant_id and i.job_id=j.id
 where j.tenant_id=t and j.id=jid and not coalesce(i.published,false)
  and exists(select 1 from app.parse_job_input(t,jid,token,policy) where mime='application/pdf')
$$;

create or replace function app.read_pdf_parse_progress(t uuid,r uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('pages_processed',coalesce(i.checkpoint_page-1,0),
  'pages_seen',coalesce((i.manifest#>>'{coverage,pages_seen}')::integer,0),'state',j.state,
  'job_id',j.id,'resume_generation',j.resume_generation,'can_resume',j.state='dead'
   and j.last_error_code in ('PARSER_RETRY','SOURCE_UNAVAILABLE')
   and exists(select 1 from app.memberships where tenant_id=t and user_id=auth.uid() and role in ('owner','operator')))
 from (select * from app.jobs where tenant_id=t and evidence_revision_id=r and job_type='parse_original'
  and processor_version in ('document-python-v1','document-evidence-v1','document-pdf-pages-v1')
  order by created_at desc,id desc limit 1) j
 join app.document_revisions d on d.tenant_id=j.tenant_id and d.id=j.evidence_revision_id
 left join app.evidence_chunk_indexes i on i.tenant_id=j.tenant_id and i.job_id=j.id
 where d.declared_mime='application/pdf' and j.state<>'succeeded' and app.revision_accessible(t,r)
$$;

create function app.resume_pdf_parse(t uuid,r uuid,jid uuid,expected_generation integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare j app.jobs%rowtype;
begin
 if not exists(select 1 from app.memberships where tenant_id=t and user_id=auth.uid() and role in ('owner','operator'))
  or not app.revision_accessible(t,r) then return false;end if;
 select * into j from app.jobs where tenant_id=t and evidence_revision_id=r and job_type='parse_original'
  and processor_version in ('document-python-v1','document-evidence-v1','document-pdf-pages-v1')
  order by created_at desc,id desc limit 1 for update;
 if not found or j.id<>jid or expected_generation is null or expected_generation<0
  or not exists(select 1 from app.document_revisions where tenant_id=t and id=r and declared_mime='application/pdf') then return false;end if;
 -- Retransmission never starts a later failed attempt again.
 if j.resume_generation=expected_generation+1 then return true;end if;
 if j.resume_generation<>expected_generation or j.state<>'dead' or coalesce(j.last_error_code not in ('PARSER_RETRY','SOURCE_UNAVAILABLE'),true) then return false;end if;
 update app.jobs set state='queued',attempt_count=0,available_at=now(),lease_owner=null,lease_token=null,
  lease_expires_at=null,last_error_code=null,resume_generation=resume_generation+1,updated_at=now()
 where tenant_id=t and id=jid;
 return true;
end $$;
revoke all on function app.resume_pdf_parse(uuid,uuid,uuid,integer) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.resume_pdf_parse(uuid,uuid,uuid,integer) to sigongnote_api;

-- This metric means a performed recovery check failed, not that every object was audited.
alter table app.upload_intents add column recovery_checked_at timestamptz,
 add column recovery_check_ok boolean;
create function app.record_capture_recovery(t uuid,i uuid,ok boolean) returns void
language sql security definer set search_path='' as $$
 update app.upload_intents set recovery_checked_at=now(),recovery_check_ok=ok
 where tenant_id=t and id=i and actor_id=auth.uid() and status='verified'
  and exists(select 1 from app.memberships where tenant_id=t and user_id=auth.uid() and role in ('owner','operator'))
  and app.revision_accessible(t,completed_revision_id)
$$;
create function app.capture_recovery_status(t uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('checked',count(*) filter(where recovery_checked_at is not null),
  'failed',count(*) filter(where recovery_check_ok=false),'last_checked_at',max(recovery_checked_at))
 from app.upload_intents where tenant_id=t and actor_id=auth.uid() and status='verified'
  and app.revision_accessible(t,completed_revision_id)
$$;
revoke all on function app.record_capture_recovery(uuid,uuid,boolean),app.capture_recovery_status(uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.record_capture_recovery(uuid,uuid,boolean),app.capture_recovery_status(uuid) to sigongnote_api;
