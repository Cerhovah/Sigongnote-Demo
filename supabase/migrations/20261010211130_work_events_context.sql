-- Context restoration: Claude finds the meaning of a fragment (문자·자료 발췌) against existing work,
-- Sigongnote keeps the restored facts as work events and follow-ups. Events never confirm
-- money, delivery acceptance or payment; they are observations with evidence references.
alter table app.product_ai_usage drop constraint if exists product_ai_usage_channel_check;
alter table app.product_ai_usage add constraint product_ai_usage_channel_check check(channel in ('semantic','vision','short_stt','long_stt','agent','sms_triage','context'));
alter table app.product_ai_usage drop constraint if exists product_ai_agent_source;
alter table app.product_ai_usage add constraint product_ai_agent_source check(source_id is not null or channel in ('short_stt','agent','context'));

create table if not exists app.work_events (
 tenant_id uuid not null references app.tenants(id), id uuid not null default gen_random_uuid(),
 kind text not null check(kind in ('request','change','problem','fact','agreement','correction','question','note')),
 summary text not null check(length(summary) between 1 and 400),
 detail text not null default '' check(length(detail)<=2000),
 project_id uuid, context_id uuid, party text check(party is null or length(party)<=120),
 source_kind text not null check(source_kind in ('revision','local')), source_ref uuid not null,
 evidence_refs uuid[] not null default '{}' check(cardinality(evidence_refs)<=20),
 quantities jsonb not null default '[]'::jsonb check(jsonb_typeof(quantities)='array' and octet_length(quantities::text)<=4096),
 missing text[] not null default '{}', confidence text not null check(confidence in ('high','medium','low')),
 reasoning text not null default '' check(length(reasoning)<=1200),
 status text not null default 'open' check(status in ('open','resolved','superseded','dismissed')),
 supersedes uuid, model text check(model is null or length(model)<=100), usage_id uuid,
 actor_id uuid not null references auth.users(id), occurred_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 version bigint not null default 1 check(version>=1),
 primary key(tenant_id,id),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),
 foreign key(tenant_id,supersedes) references app.work_events(tenant_id,id)
);
create index if not exists work_events_tenant_created on app.work_events(tenant_id,created_at desc,id desc);
create index if not exists work_events_source on app.work_events(tenant_id,source_kind,source_ref);
create index if not exists work_events_open_project on app.work_events(tenant_id,project_id) where status='open';

create table if not exists app.work_followups (
 tenant_id uuid not null references app.tenants(id), id uuid not null default gen_random_uuid(), event_id uuid not null,
 title text not null check(length(title) between 1 and 200), due_on date, project_id uuid,
 state text not null default 'open' check(state in ('open','done','dismissed')),
 done_by uuid references auth.users(id), done_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 version bigint not null default 1 check(version>=1),
 primary key(tenant_id,id),
 foreign key(tenant_id,event_id) references app.work_events(tenant_id,id) on delete cascade,
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id)
);
create index if not exists work_followups_open on app.work_followups(tenant_id,state,created_at desc);

create table if not exists app.work_event_sources (
 tenant_id uuid not null references app.tenants(id), source_kind text not null check(source_kind in ('revision','local')), source_ref uuid not null,
 state text not null default 'leased' check(state in ('leased','done','failed','skipped')),
 attempts integer not null default 1 check(attempts between 1 and 10), lease_until timestamptz, error_code text check(error_code is null or length(error_code)<=80),
 usage_id uuid, events integer not null default 0, model text check(model is null or length(model)<=100),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(tenant_id,source_kind,source_ref)
);

alter table app.work_events enable row level security;
alter table app.work_followups enable row level security;
alter table app.work_event_sources enable row level security;
revoke all on app.work_events,app.work_followups,app.work_event_sources from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.work_events,app.work_event_sources to sigongnote_api;
grant select,update on app.work_followups to sigongnote_api;
drop policy if exists work_events_read on app.work_events;
create policy work_events_read on app.work_events for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
drop policy if exists work_followups_read on app.work_followups;
create policy work_followups_read on app.work_followups for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
drop policy if exists work_followups_update on app.work_followups;
create policy work_followups_update on app.work_followups for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator'])) with check(app.has_tenant_role(tenant_id,array['owner','operator']));
drop policy if exists work_event_sources_read on app.work_event_sources;
create policy work_event_sources_read on app.work_event_sources for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));

-- Background claim: one unprocessed, readable source per call. Returns the fragment text and the
-- actor whose session scope the API will impersonate (set_config claim.sub) while restoring context.
create or replace function app.next_context_input(scope_tenant uuid default null,lease_seconds integer default 180,external_allowed boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; txt text; n integer;
begin
 if not external_allowed then return null; end if;
 for r in
  with revisions as (
   select d.tenant_id,'revision'::text source_kind,d.id source_ref,d.created_at received_at,i.actor_id,i.source_id,s.kind capture_kind,
    coalesce(o.project_id,fb.project_id) project_id,d.declared_mime
   from app.document_revisions d
   join app.upload_intents i on i.tenant_id=d.tenant_id and i.completed_revision_id=d.id
   join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
   left join app.site_folder_bindings fb on fb.tenant_id=s.tenant_id and fb.source_id=s.id and fb.source_generation=i.source_generation
   left join app.evidence_organizations o on o.tenant_id=d.tenant_id and o.revision_id=d.id
   where (scope_tenant is null or d.tenant_id=scope_tenant) and not d.generated_output and s.external_ai_consent and s.active
    and exists(select 1 from app.parse_results p where p.tenant_id=d.tenant_id and p.revision_id=d.id and p.output->>'status' in ('complete','partial'))
    and not exists(select 1 from app.jobs a where a.tenant_id=d.tenant_id and a.evidence_revision_id=d.id and a.work_lane='archive')
    and not exists(select 1 from app.document_revisions nx where nx.tenant_id=d.tenant_id and nx.document_id=d.document_id and nx.revision_number>d.revision_number)
    and not exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=d.tenant_id and w.revision_id=d.id)
  ), locals as (
   select l.tenant_id,'local'::text source_kind,l.id source_ref,l.received_at,l.actor_id,null::uuid source_id,l.source_kind capture_kind,l.project_id,l.mime declared_mime
   from app.local_journal_entries l where (scope_tenant is null or l.tenant_id=scope_tenant) and l.excerpt<>''
  ), candidates as (select * from revisions union all select * from locals)
  select c.* from candidates c
  join app.memberships m on m.tenant_id=c.tenant_id and m.user_id=c.actor_id and m.active and m.revoked_at is null and m.role in ('owner','operator')
  left join app.work_event_sources x on x.tenant_id=c.tenant_id and x.source_kind=c.source_kind and x.source_ref=c.source_ref
  -- Budget pauses and provider outages are temporary: they back off for an hour and never consume an attempt.
  where x.source_ref is null
   or (x.state='failed' and (x.error_code like 'BUDGET_PAUSED%' or x.error_code like 'PROVIDER_UNAVAILABLE%') and x.updated_at<now()-interval '1 hour')
   or (x.state='failed' and not (x.error_code like 'BUDGET_PAUSED%' or x.error_code like 'PROVIDER_UNAVAILABLE%') and x.attempts<3)
   or (x.state='leased' and x.lease_until<now())
  order by c.received_at desc limit 20
 loop
  insert into app.work_event_sources(tenant_id,source_kind,source_ref,state,attempts,lease_until)
   values(r.tenant_id,r.source_kind,r.source_ref,'leased',1,now()+make_interval(secs=>lease_seconds))
   on conflict(tenant_id,source_kind,source_ref) do update set state='leased',
    attempts=case when app.work_event_sources.error_code like 'BUDGET_PAUSED%' or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%' then app.work_event_sources.attempts else least(app.work_event_sources.attempts+1,10) end,
    lease_until=now()+make_interval(secs=>lease_seconds),updated_at=now()
   where (app.work_event_sources.state='failed' and ((app.work_event_sources.error_code like 'BUDGET_PAUSED%' or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%') and app.work_event_sources.updated_at<now()-interval '1 hour'
     or not (app.work_event_sources.error_code like 'BUDGET_PAUSED%' or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%') and app.work_event_sources.attempts<3))
    or (app.work_event_sources.state='leased' and app.work_event_sources.lease_until<now());
  get diagnostics n=row_count; if n=0 then continue; end if;
  if r.source_kind='revision' then
   select string_agg(v->>'text',E'\n' order by i) filter(where length(trim(coalesce(v->>'text','')))>0) into txt
   from (select output from app.parse_results p where p.tenant_id=r.tenant_id and p.revision_id=r.source_ref order by created_at desc limit 1) q,
    jsonb_array_elements(coalesce(q.output->'spans','[]'::jsonb)) with ordinality a(v,i) where i<=60;
  else
   select file_name||E'\n'||excerpt into txt from app.local_journal_entries where tenant_id=r.tenant_id and id=r.source_ref;
  end if;
  return jsonb_build_object('tenant',r.tenant_id,'actor',r.actor_id,'source_kind',r.source_kind,'source_ref',r.source_ref,'capture_kind',r.capture_kind,
   'project_id',r.project_id,'received_at',r.received_at,'mime',r.declared_mime,'text',left(coalesce(txt,''),6000));
 end loop;
 return null;
end $$;
revoke all on function app.next_context_input(uuid,integer,boolean) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.next_context_input(uuid,integer,boolean) to sigongnote_api;

-- Persist validated events. project_id/context_id are checked against the tenant; unknown targets stay null
-- with 'site' recorded in missing. Never invents a project. Returns counts.
create or replace function app.save_work_events(p_tenant uuid,p_actor uuid,p_kind text,p_ref uuid,p_events jsonb,p_usage uuid,p_model text,p_code text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e jsonb; f jsonb; pid uuid; cid uuid; eid uuid; miss text[]; n_events integer:=0; n_follow integer:=0; conf text;
begin
 if auth.uid() is distinct from p_actor or not app.has_tenant_role(p_tenant,array['owner','operator']) then raise exception 'context scope' using errcode='42501'; end if;
 if p_code is not null then
  update app.work_event_sources set state='failed',error_code=left(p_code,80),usage_id=p_usage,model=left(p_model,100),updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref;
  return jsonb_build_object('events',0,'followups',0,'state','failed');
 end if;
 if jsonb_typeof(p_events)<>'array' then raise exception 'events array' using errcode='22023'; end if;
 for e in select * from jsonb_array_elements(p_events) loop
  pid:=null;cid:=null;miss:=coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(e->'missing','[]'::jsonb)) x),'{}');
  if e->>'project_id' is not null then select id into pid from app.projects where tenant_id=p_tenant and id=(e->>'project_id')::uuid; end if;
  if pid is null and not ('site'=any(miss)) then miss:=array_append(miss,'site'); end if;
  if pid is not null and e->>'context_id' is not null then select id into cid from app.work_contexts where tenant_id=p_tenant and id=(e->>'context_id')::uuid and project_id=pid; end if;
  conf:=case when e->>'confidence' in ('high','medium','low') then e->>'confidence' else 'low' end;
  insert into app.work_events(tenant_id,kind,summary,detail,project_id,context_id,party,source_kind,source_ref,evidence_refs,quantities,missing,confidence,reasoning,model,usage_id,actor_id,occurred_at)
  values(p_tenant,coalesce(nullif(e->>'kind',''),'note'),left(coalesce(e->>'summary','(내용 없음)'),400),left(coalesce(e->>'detail',''),2000),pid,cid,left(e->>'party',120),p_kind,p_ref,
   coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(e->'evidence_refs','[]'::jsonb)) x where x ~ '^[0-9a-f-]{36}$' and app.revision_accessible(p_tenant,x::uuid)),'{}'),
   coalesce(e->'quantities','[]'::jsonb),miss,conf,left(coalesce(e->>'reasoning',''),1200),left(p_model,100),p_usage,p_actor,
   case when e->>'occurred_at' ~ '^\d{4}-\d{2}-\d{2}' then (e->>'occurred_at')::timestamptz else null end)
  returning id into eid;
  n_events:=n_events+1;
  for f in select * from jsonb_array_elements(coalesce(e->'followups','[]'::jsonb)) loop
   if length(trim(coalesce(f->>'title','')))=0 then continue; end if;
   insert into app.work_followups(tenant_id,id,event_id,title,due_on,project_id)
   values(p_tenant,gen_random_uuid(),eid,left(f->>'title',200),case when f->>'due_on' ~ '^\d{4}-\d{2}-\d{2}$' then (f->>'due_on')::date else null end,pid);
   n_follow:=n_follow+1;
  end loop;
  -- Normal collection effect only: a PC journal entry without a site gets the unique, confidently restored site.
  if p_kind='local' and pid is not null and conf='high' then
   update app.local_journal_entries set project_id=pid,version=version+1,updated_at=now() where tenant_id=p_tenant and id=p_ref and project_id is null;
  end if;
 end loop;
 update app.work_event_sources set state='done',events=n_events,usage_id=p_usage,model=left(p_model,100),error_code=null,updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref;
 return jsonb_build_object('events',n_events,'followups',n_follow,'state','done');
end $$;
revoke all on function app.save_work_events(uuid,uuid,text,uuid,jsonb,uuid,text,text) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.save_work_events(uuid,uuid,text,uuid,jsonb,uuid,text,text) to sigongnote_api;

-- Product AI ledger: the 'context' channel is a background call on behalf of the source actor.
create or replace function app.product_ai_scope_allowed(p_tenant uuid,p_user uuid,p_source uuid,p_generation bigint,p_revision uuid,p_channel text,p_config jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare s record;
begin
 if session_user='sigongnote_api' and auth.uid() is distinct from p_user then return false; end if;
 if not exists(select 1 from app.memberships m where m.tenant_id=p_tenant and m.user_id=p_user and m.active and m.revoked_at is null and m.role in ('owner','operator','accountant')) then return false; end if;
 if p_channel='agent' then
  return p_source is null and p_generation is null and p_revision is null and exists(select 1 from app.agent_runs a where a.tenant_id=p_tenant and a.user_id=p_user and a.id::text=p_config->>'run_id' and a.status<>'cancelled' and app.session_is_active(a.user_id,a.session_id));
 end if;
 if p_channel='context' then
  -- 'revision'/'local': background restoration of a claimed source. 'summary': a PC-local document excerpt the
  -- owner explicitly consented to send once (the PC keeps the original; only masked spans reach the server).
  return p_source is null and p_generation is null and p_config->>'source_ref' ~ '^[0-9a-f-]{36}$'
   and ((p_config->>'source_kind' in ('revision','local') and exists(select 1 from app.work_event_sources x where x.tenant_id=p_tenant and x.source_kind=p_config->>'source_kind' and x.source_ref=(p_config->>'source_ref')::uuid))
     or (p_config->>'source_kind'='summary' and p_revision is null and app.has_tenant_role(p_tenant,array['owner','operator'])))
   and (p_revision is null or app.revision_accessible(p_tenant,p_revision));
 end if;
 if p_source is null then
  return p_channel='short_stt' and exists(select 1 from app.voice_consents c where c.tenant_id=p_tenant and c.user_id=p_user and c.provider_version='short-voice-v1' and c.allowed
   and (extract(epoch from c.updated_at)*1000000)::bigint::text=p_config->>'consent_generation');
 end if;
 if p_revision is null and p_channel<>'sms_triage' then return false;end if;
 select c.*,d.active device_active into s from app.capture_sources c join app.devices d on d.tenant_id=c.tenant_id and d.id=c.device_id
  where c.tenant_id=p_tenant and c.id=p_source and c.user_id=p_user for share of c;
 if not found or not s.active or not s.device_active or not s.local_selection_consent or not s.server_upload_consent or not s.external_ai_consent or s.generation is distinct from p_generation then return false; end if;
 if s.processing_policy is null or s.processing_policy is distinct from p_config->'policy'
  or s.processing_policy->'external_processing' is distinct from 'true'::jsonb
  or s.processing_policy->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 if p_channel='sms_triage' then
  return p_revision is null and s.kind='sms' and s.scope->>'scope_mode'='ai_screened'
   and s.scope->>'history_mode'='since' and p_config->>'provider'=p_config->>'policy_provider'
   and s.sms_activation->>'source_id'=s.id::text and s.sms_activation->>'generation'=s.generation::text
   and s.sms_activation->>'scope_fingerprint'=s.scope_fingerprint
   and (s.sms_activation->>'expires_at')::timestamptz>now() and s.sms_activation->'revoked_at'='null'::jsonb;
 end if;
 if p_channel in ('semantic','vision') and p_config->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 if p_channel='long_stt' and not coalesce((p_config->>'policy_provider'='clova_speech' and p_config->>'provider'='clova' and p_config->>'model'='clova-speech') or (p_config->>'policy_provider'='openai' and p_config->>'provider'='openai' and p_config->>'model'='whisper-1'),false) then return false; end if;
 if p_revision is not null and not exists(select 1 from app.upload_intents i where i.tenant_id=p_tenant and i.completed_revision_id=p_revision and i.source_id=p_source and i.source_generation=p_generation) then return false; end if;
 if p_revision is not null and exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=p_tenant and w.revision_id=p_revision) then return false;end if;
 return true;
end $$;

create or replace function app.reserve_product_ai(p_tenant uuid,p_user uuid,p_id uuid,p_channel text,p_source uuid,p_generation bigint,p_revision uuid,p_hash text,p_config jsonb,p_reserved bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing app.product_ai_usage; daily bigint; monthly bigint; day_start timestamptz; month_start timestamptz;
begin
 if p_channel is null or p_channel not in ('semantic','vision','short_stt','long_stt','agent','sms_triage','context') or p_reserved is null or p_reserved not between 1 and 10000 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(p_config)<>'object' or octet_length(p_config::text)>4096 or p_config is null then raise exception 'invalid AI reservation' using errcode='22023'; end if;
 if not app.product_ai_scope_allowed(p_tenant,p_user,p_source,p_generation,p_revision,p_channel,p_config) then return jsonb_build_object('state','scope_blocked'); end if;
 perform pg_advisory_xact_lock(hashtextextended('product-ai-user:'||p_user::text,0));
 select * into existing from app.product_ai_usage where tenant_id=p_tenant and user_id=p_user and id=p_id for update;
 if found then
  if existing.request_hash<>p_hash or existing.config<>p_config or existing.channel<>p_channel or existing.reserved_krw<>p_reserved
   or existing.source_id is distinct from p_source or existing.source_generation is distinct from p_generation or existing.revision_id is distinct from p_revision then raise exception 'AI idempotency conflict' using errcode='23505'; end if;
  return jsonb_build_object('state',existing.state,'id',p_id,'result',existing.result,'reused',true);
 end if;
 day_start=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 month_start=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 select coalesce(sum(case when coalesce(submitted_at,created_at)>=day_start or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0),
  coalesce(sum(case when coalesce(submitted_at,created_at)>=month_start or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0)
 into daily,monthly from app.product_ai_usage where user_id=p_user and state<>'released';
 if daily+p_reserved>10000 or monthly+p_reserved>50000 then return jsonb_build_object('state','budget_paused'); end if;
 insert into app.product_ai_usage(tenant_id,user_id,id,channel,source_id,source_generation,revision_id,request_hash,config,reserved_krw)
 values(p_tenant,p_user,p_id,p_channel,p_source,p_generation,p_revision,p_hash,p_config,p_reserved);
 return jsonb_build_object('state','reserved','id',p_id,'reused',false);
end $$;

-- Owner/operator checklist: a follow-up is a personal reminder, never approval, delivery acceptance or payment.
create or replace function app.mark_work_followup(t uuid,f uuid,expected bigint,done boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r app.work_followups;
begin
 if auth.uid() is null or not app.has_tenant_role(t,array['owner','operator']) then return null; end if;
 select * into r from app.work_followups where tenant_id=t and id=f for update;
 if not found then return null; end if;
 if r.version<>expected then return jsonb_build_object('conflict',true,'version',r.version); end if;
 update app.work_followups set state=case when done then 'done' else 'open' end,done_by=case when done then auth.uid() else null end,done_at=case when done then now() else null end,version=version+1,updated_at=now()
  where tenant_id=t and id=f returning * into r;
 if done and not exists(select 1 from app.work_followups w where w.tenant_id=t and w.event_id=r.event_id and w.state='open') then
  update app.work_events set status='resolved',updated_at=now(),version=version+1 where tenant_id=t and id=r.event_id and status='open';
 elsif not done then
  update app.work_events set status='open',updated_at=now(),version=version+1 where tenant_id=t and id=r.event_id and status='resolved';
 end if;
 return jsonb_build_object('done',r.state='done','version',r.version);
end $$;
revoke all on function app.mark_work_followup(uuid,uuid,bigint,boolean) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.mark_work_followup(uuid,uuid,bigint,boolean) to sigongnote_api;
