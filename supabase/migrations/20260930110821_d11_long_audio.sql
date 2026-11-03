-- Audio receipts are private worker state, never returned with source text to clients.
create table app.audio_work (
 tenant_id uuid not null,job_id uuid not null,revision_id uuid not null,
 state jsonb not null default '{"phase":"waiting","chunks":[]}',updated_at timestamptz not null default now(),
 primary key(tenant_id,job_id),foreign key(tenant_id,job_id) references app.jobs(tenant_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id),
 check(octet_length(state::text)<=4194304)
);
create table app.audio_reservations (
 tenant_id uuid not null,job_id uuid not null,chunk integer not null check(chunk between 0 and 12),
 seconds integer not null check(seconds between 1 and 600),created_at timestamptz not null default now(),
 primary key(tenant_id,job_id,chunk),foreign key(tenant_id,job_id) references app.jobs(tenant_id,id)
);
create table app.audio_corrections (
 tenant_id uuid not null,revision_id uuid not null,command_id uuid not null,locator text not null,
 text text not null check(length(text) between 1 and 1000),actor_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),primary key(tenant_id,command_id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id)
);
alter table app.audio_work enable row level security;
alter table app.audio_reservations enable row level security;
alter table app.audio_corrections enable row level security;
revoke all on app.audio_work,app.audio_reservations,app.audio_corrections from public,anon,authenticated,service_role,sigongnote_worker,sigongnote_api;
grant select,insert on app.audio_corrections to sigongnote_api;
create policy audio_corrections_read on app.audio_corrections for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy audio_corrections_write on app.audio_corrections for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner','operator']) and actor_id=auth.uid() and app.revision_accessible(tenant_id,revision_id));

create function app.audio_allowed(t uuid,j uuid,policy jsonb) returns boolean language sql security definer set search_path='' as $$
 select app.parse_source_allowed(t,j,policy) and exists(
 select 1 from app.upload_intents i join app.jobs x on x.tenant_id=i.tenant_id and x.evidence_revision_id=i.completed_revision_id
 join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
 where x.tenant_id=t and x.id=j and s.kind='call_recording' and s.active
 and s.scope->>'scope_mode' in ('work_dedicated','selected_items') and s.processing_policy=policy
 and (not coalesce((policy->>'external_processing')::boolean,true) or s.external_ai_consent))
$$;
create function app.audio_load(t uuid,j uuid,token uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r uuid; result jsonb; reused jsonb; prior_state text;
begin
 if not app.audio_allowed(t,j,policy) then return null;end if;
 select evidence_revision_id into r from app.jobs where tenant_id=t and id=j and processor_version='long-audio-v1' and state='leased' and lease_token=token and lease_expires_at>now();
 if not found then return null;end if;
 insert into app.audio_work(tenant_id,job_id,revision_id) values(t,j,r) on conflict do nothing;
 select a.state into reused from app.audio_work a join app.jobs prior on prior.tenant_id=a.tenant_id and prior.id=a.job_id join app.jobs current on current.tenant_id=t and current.id=j
 where a.tenant_id=t and a.job_id<>j and prior.input_hash=current.input_hash and a.state->>'phase' in ('complete','partial')
 and a.state->>'provider'=case when policy->>'external_processing'='true' then 'clova' else 'synthetic' end order by case when a.state->>'phase'='complete' then 0 else 1 end,a.updated_at desc,a.job_id limit 1;
 if reused is not null then update app.audio_work set state=reused,updated_at=now() where tenant_id=t and job_id=j;end if;
 select state into result from app.audio_work where tenant_id=t and job_id=j;
 if reused is null and policy->>'external_processing'='true' then
  select prior.state into prior_state from app.audio_reservations a join app.jobs prior on prior.tenant_id=a.tenant_id and prior.id=a.job_id join app.jobs current on current.tenant_id=t and current.id=j
  where a.tenant_id=t and a.job_id<>j and prior.input_hash=current.input_hash order by prior.created_at,prior.id limit 1;
  if prior_state is not null then
   result:=jsonb_set(jsonb_set(result,'{phase}',to_jsonb(case when prior_state in ('queued','leased','retry_wait') then 'waiting'::text else 'held'::text end)),'{reason}',to_jsonb(case when prior_state in ('queued','leased','retry_wait') then 'audio_existing_wait'::text else 'audio_duplicate_held'::text end));
  end if;
 end if;
 return result;
end $$;
create function app.audio_save(t uuid,j uuid,token uuid,policy jsonb,value jsonb,wait_seconds integer default null) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not app.audio_allowed(t,j,policy) then return false;end if;
 perform 1 from app.jobs where tenant_id=t and id=j and state='leased' and lease_token=token and lease_expires_at>now() for update;
 if not found or jsonb_typeof(value)<>'object' or octet_length(value::text)>4194304 then return false;end if;
 update app.audio_work set state=value,updated_at=now() where tenant_id=t and job_id=j;
 if not found then return false;end if;
 if wait_seconds=-1 then
  update app.jobs set state='dead',lease_expires_at=null,last_error_code='AUDIO_HELD',updated_at=now() where tenant_id=t and id=j;
 elsif wait_seconds is not null then
  update app.jobs set state='retry_wait',lease_expires_at=null,attempt_count=greatest(0,attempt_count-1),available_at=now()+make_interval(secs=>greatest(1,least(wait_seconds,86400))),updated_at=now() where tenant_id=t and id=j;
 end if;return true;
end $$;
create function app.audio_reserve(t uuid,j uuid,token uuid,policy jsonb,c integer,seconds integer,tenant_limit integer,global_limit integer) returns text language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((policy->>'external_processing')::boolean,false) or not app.audio_allowed(t,j,policy) then return 'stale';end if;
 perform 1 from app.jobs where tenant_id=t and id=j and state='leased' and lease_token=token and lease_expires_at>now() for update;if not found then return 'stale';end if;
 perform pg_advisory_xact_lock(110011);
 if exists(select 1 from app.audio_reservations where tenant_id=t and job_id=j and chunk=c) then
  if exists(select 1 from app.audio_work where tenant_id=t and job_id=j and state#>>array['chunks',c::text,'status'] is null) then
   update app.audio_work set state=jsonb_set(state,array['chunks',c::text,'status'],'"submitting"') where tenant_id=t and job_id=j;return 'ok';
  end if;return 'duplicate';
 end if;
 if exists(select 1 from app.audio_reservations r join app.jobs prior on prior.tenant_id=r.tenant_id and prior.id=r.job_id join app.jobs current on current.tenant_id=t and current.id=j where r.tenant_id=t and r.chunk=c and prior.input_hash=current.input_hash and prior.state in ('queued','leased','retry_wait')) then return 'duplicate_wait';end if;
 if exists(select 1 from app.audio_reservations r join app.jobs prior on prior.tenant_id=r.tenant_id and prior.id=r.job_id join app.jobs current on current.tenant_id=t and current.id=j where r.tenant_id=t and r.chunk=c and prior.input_hash=current.input_hash) then return 'duplicate';end if;
 if tenant_limit not between 1 and 7200 or global_limit not between 1 and 14400 or seconds not between 1 and 600 then return 'budget';end if;
 if (select coalesce(sum(r.seconds),0) from app.audio_reservations r where r.tenant_id=t and r.created_at>now()-interval '24 hours')+seconds>tenant_limit
 or (select coalesce(sum(r.seconds),0) from app.audio_reservations r where r.created_at>now()-interval '24 hours')+seconds>global_limit then return 'budget';end if;
 insert into app.audio_reservations(tenant_id,job_id,chunk,seconds) values(t,j,c,seconds);
 update app.audio_work set state=jsonb_set(jsonb_set(state,array['chunks',c::text,'status'],'"submitting"'),array['chunks',c::text,'submittedAt'],to_jsonb((extract(epoch from now())*1000)::bigint)) where tenant_id=t and job_id=j;return 'ok';
end $$;
create function app.audio_budget(t uuid,j uuid,token uuid,policy jsonb,tenant_limit integer,global_limit integer) returns integer language plpgsql security definer set search_path='' as $$
begin
 if tenant_limit not between 1 and 7200 or global_limit not between 1 and 14400 or not app.audio_allowed(t,j,policy) then return 0;end if;
 if not exists(select 1 from app.jobs where tenant_id=t and id=j and state='leased' and lease_token=token and lease_expires_at>now()) then return 0;end if;
 return greatest(0,least(tenant_limit-(select coalesce(sum(seconds),0) from app.audio_reservations where tenant_id=t and created_at>now()-interval '24 hours'),global_limit-(select coalesce(sum(seconds),0) from app.audio_reservations where created_at>now()-interval '24 hours')))::integer;
end $$;
-- Only opaque receipt metadata can be recorded after revocation, for provider cleanup/reconciliation.
create function app.audio_record_receipt(t uuid,j uuid,attempt uuid,c integer,receipt text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if receipt is null or length(receipt) not between 1 and 300 or receipt !~ '^[a-zA-Z0-9_-]+$' or c not between 0 and 11 then return false;end if;
 update app.audio_work a set state=jsonb_set(a.state,array['chunks',c::text,'receipt'],to_jsonb(receipt))
 where a.tenant_id=t and a.job_id=j and a.state#>>array['chunks',c::text,'attemptToken']=attempt::text and a.state#>>array['chunks',c::text,'receipt'] is null;
 return found;
end $$;
revoke all on function app.audio_budget(uuid,uuid,uuid,jsonb,integer,integer),app.audio_record_receipt(uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.audio_budget(uuid,uuid,uuid,jsonb,integer,integer),app.audio_record_receipt(uuid,uuid,uuid,integer,text) to sigongnote_worker;
create function app.audio_progress(t uuid,r uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('phase',case when j.state='dead' then 'held' else a.state->>'phase' end,'reason',case when j.state='dead' then coalesce(a.state->>'reason','audio_worker_stopped') else a.state->>'reason' end,'durationMs',a.state->'durationMs','chunks',jsonb_array_length(a.state->'chunks'),
 'completed',(select count(*) from jsonb_array_elements(a.state->'chunks') c where c->>'status'='completed'),'fixture',a.state->'fixture','truncated',coalesce((a.state->>'excerptTruncated')::boolean,false))
 from app.audio_work a join app.jobs j on j.tenant_id=a.tenant_id and j.id=a.job_id where a.tenant_id=t and a.revision_id=r and app.has_tenant_role(t,array['owner','operator','accountant']) and app.revision_accessible(t,r) order by a.updated_at desc,a.job_id limit 1
$$;
revoke all on function app.audio_allowed(uuid,uuid,jsonb),app.audio_load(uuid,uuid,uuid,jsonb),app.audio_save(uuid,uuid,uuid,jsonb,jsonb,integer),app.audio_reserve(uuid,uuid,uuid,jsonb,integer,integer,integer,integer),app.audio_progress(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant execute on function app.audio_load(uuid,uuid,uuid,jsonb),app.audio_save(uuid,uuid,uuid,jsonb,jsonb,integer),app.audio_reserve(uuid,uuid,uuid,jsonb,integer,integer,integer,integer) to sigongnote_worker;
grant execute on function app.audio_progress(uuid,uuid) to sigongnote_api;

-- Existing audio remains the same original/revision. Only previously unreadable audio is queued.
insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
select r.tenant_id,'parse_original',r.id,'long-audio-v1',b.sha256 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
where r.declared_mime like 'audio/%' and not r.generated_output and not exists(select 1 from app.evidence_organizations o where o.tenant_id=r.tenant_id and o.revision_id=r.id)
on conflict do nothing;
update app.jobs j set state='cancelled',lease_expires_at=null,last_error_code='AUDIO_ROUTED',updated_at=now() where j.processor_version='document-python-v1' and j.state in ('queued','retry_wait') and exists(select 1 from app.document_revisions r where r.tenant_id=j.tenant_id and r.id=j.evidence_revision_id and r.declared_mime like 'audio/%');
