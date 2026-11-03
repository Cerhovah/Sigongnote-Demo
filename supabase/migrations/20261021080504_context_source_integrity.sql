-- Context results are tied to the exact input version. A definite, zero-cost provider
-- refusal gets a new run token; an ambiguous submitted request keeps its submission fence.
alter table app.work_event_sources add column if not exists source_version text;
alter table app.work_event_sources add column if not exists run_token uuid not null default gen_random_uuid();
alter table app.work_events add column if not exists source_version text;
alter table app.work_events add column if not exists interpretation_run uuid;
alter table app.work_events add column if not exists evidence_snapshots jsonb not null default '[]'::jsonb;
alter table app.local_journal_entries add column if not exists project_origin text not null default 'client' check(project_origin in ('client','manual','context'));
alter table app.local_journal_entries add column if not exists native_capture_id uuid;

-- A local metadata card and an original upload can represent one physical capture.
-- Equality of bytes alone proves neither source identity nor a business transaction.
-- The device supplies the native capture key; the verified server receipt must also
-- match its actor, device and bytes. Keep this identity after withdrawal so a local
-- metadata copy cannot revive a withdrawn native source.
create or replace function app.local_native_revision(t uuid,lid uuid)
returns uuid language sql stable security definer set search_path='' as $$
 select r.id from app.local_journal_entries l join app.upload_intents i on i.tenant_id=l.tenant_id and i.actor_id=l.actor_id and i.client_capture_id=l.native_capture_id and i.status='verified'
 join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id and s.user_id=l.actor_id and s.device_id=l.device_id
 join app.document_revisions r on r.tenant_id=i.tenant_id and r.id=i.completed_revision_id and not r.generated_output
 join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id and b.sha256=l.sha256
 where l.tenant_id=t and l.id=lid order by i.created_at,r.id limit 1
$$;
revoke all on function app.local_native_revision(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create or replace function app.local_native_revision_for_read(t uuid,lid uuid)
returns uuid language sql stable security definer set search_path='' as $$
 select case when app.has_tenant_role(t,array['owner','operator','accountant']) then app.local_native_revision(t,lid) else null end
$$;
revoke all on function app.local_native_revision_for_read(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.local_native_revision_for_read(uuid,uuid) to sigongnote_api;

-- An explicitly confirmed document can use owner-entered lines or a PC source.
-- Pin that immutable draft rather than inventing a server evidence-index row.
alter table app.decisions add column if not exists document_draft_id uuid;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='app.decisions'::regclass and conname='decisions_document_draft_fk') then
  alter table app.decisions add constraint decisions_document_draft_fk foreign key(tenant_id,document_draft_id) references app.document_drafts(tenant_id,id);
 end if;
end $$;
alter table app.decisions drop constraint if exists decisions_evidence_ids_check;
alter table app.decisions add constraint decisions_evidence_ids_check check(
 cardinality(evidence_ids) between 1 and 100 or scope='quote_cancel' and cardinality(evidence_ids)=0
 or scope='document_issue' and cardinality(evidence_ids)=0 and document_draft_id is not null);

-- Existing journal sharing is not external AI consent. This starts OFF for every
-- company/account and is changed once through the explicit account-scoped command.
create table if not exists app.local_context_consents (
 tenant_id uuid not null references app.tenants(id),user_id uuid not null references auth.users(id),allowed boolean not null default false,
 generation bigint not null default 1 check(generation>0),processing_policy jsonb not null,updated_at timestamptz not null default now(),
 primary key(tenant_id,user_id)
);
alter table app.local_context_consents enable row level security;
revoke all on app.local_context_consents from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.local_context_consents to sigongnote_api;
drop policy if exists own_read on app.local_context_consents;
create policy own_read on app.local_context_consents for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));

create or replace function app.set_local_context_consent(t uuid,expected bigint,p_allowed boolean,p_policy jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c app.local_context_consents;
begin
 if auth.uid() is null or not app.has_tenant_role(t,array['owner','operator']) then return null; end if;
 if p_allowed and (p_policy->'external_processing' is distinct from 'true'::jsonb or p_policy->>'provider' is distinct from 'anthropic') then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||auth.uid()::text||':local-context-consent',0));
 select * into c from app.local_context_consents where tenant_id=t and user_id=auth.uid() for update;
 if coalesce(c.generation,0)<>expected then return jsonb_build_object('conflict',true,'version',coalesce(c.generation,0)); end if;
 insert into app.local_context_consents(tenant_id,user_id,allowed,processing_policy)
 values(t,auth.uid(),p_allowed,coalesce(p_policy,'{}'::jsonb)) on conflict(tenant_id,user_id) do update set allowed=excluded.allowed,processing_policy=case when excluded.allowed then excluded.processing_policy else app.local_context_consents.processing_policy end,generation=app.local_context_consents.generation+1,updated_at=now() returning * into c;
 return jsonb_build_object('allowed',c.allowed,'version',c.generation,'policy_current',true);
end $$;
revoke all on function app.set_local_context_consent(uuid,bigint,boolean,jsonb) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.set_local_context_consent(uuid,bigint,boolean,jsonb) to sigongnote_api;

create table if not exists app.work_event_corrections (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),event_id uuid not null,actor_id uuid not null references auth.users(id),
 expected_version bigint not null,previous jsonb not null,replacement jsonb not null,reason text not null check(length(reason) between 1 and 1000),created_at timestamptz not null default now(),
 primary key(tenant_id,id),foreign key(tenant_id,event_id) references app.work_events(tenant_id,id) on delete cascade
);
alter table app.work_event_corrections enable row level security;
revoke all on app.work_event_corrections from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.work_event_corrections to sigongnote_api;
drop policy if exists tenant_read on app.work_event_corrections;
create policy tenant_read on app.work_event_corrections for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));

-- Reading ordinary PC source documents is independent of external model consent.
create or replace function app.local_document_source_readable(t uuid,r uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(t,array['owner','operator','accountant']) and exists(
  select 1 from app.local_journal_entries l join app.devices d on d.tenant_id=l.tenant_id and d.id=l.device_id and d.user_id=l.actor_id and d.active
  join app.memberships m on m.tenant_id=l.tenant_id and m.user_id=l.actor_id and m.active and m.revoked_at is null
  where l.tenant_id=t and l.id=r)
$$;
revoke all on function app.local_document_source_readable(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.local_document_source_readable(uuid,uuid) to sigongnote_api;

create or replace function app.render_authorized(p_tenant uuid,p_revision uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid;refs jsonb;locals jsonb;old_sub text;ok boolean;
begin
 old_sub:=current_setting('request.jwt.claim.sub',true);
 select d.actor_id,coalesce(s.basis_snapshot->'references','[]'::jsonb),coalesce(s.basis_snapshot->'local_sources','[]'::jsonb)
 into actor,refs,locals from app.business_document_revisions r join app.business_documents d on d.tenant_id=r.tenant_id and d.id=r.document_id
 join app.document_drafts s on s.tenant_id=r.tenant_id and s.id=r.draft_id
 where r.tenant_id=p_tenant and r.id=p_revision and not exists(select 1 from app.document_lifecycle_events e where e.tenant_id=d.tenant_id and e.document_id=d.id);
 if actor is null or not exists(select 1 from app.memberships where tenant_id=p_tenant and user_id=actor and role='owner' and active and revoked_at is null) then return false; end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 select not exists(select 1 from jsonb_array_elements_text(refs) x where not app.revision_accessible(p_tenant,x::uuid)) and
  not exists(select 1 from jsonb_array_elements(locals) ref where not app.local_document_source_readable(p_tenant,(ref->>'id')::uuid)
   or not exists(select 1 from app.local_journal_entries l where l.tenant_id=p_tenant and l.id=(ref->>'id')::uuid and l.sha256=ref->>'sha256'
    and l.local_revision::text=ref->>'local_revision' and l.version::text=ref->>'version' and l.project_id is not distinct from (ref->>'project_id')::uuid)) into ok;
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);return ok;
exception when others then
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);raise;
end $$;

-- Internal snapshot, without source text. Callers with API access must use the scoped
-- boolean wrapper. Capture generations, active devices and both upload/AI consents
-- are checked again at reserve, submission, settlement and event persistence.
create or replace function app.context_source_snapshot(t uuid,k text,r uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v jsonb; native uuid;
begin
 if k='local' then
  native:=app.local_native_revision(t,r);
  if native is not null and app.context_source_snapshot(t,'revision',native) is null then return null; end if;
  select jsonb_build_object('kind','local','id',l.id,'version',l.local_revision::text||':'||l.sha256||':'||c.generation::text,'actor',l.actor_id,'sha256',l.sha256,'revision',l.local_revision,'policy',c.processing_policy)
  into v from app.local_journal_entries l join app.devices d on d.tenant_id=l.tenant_id and d.id=l.device_id and d.user_id=l.actor_id and d.active
  join app.local_context_consents c on c.tenant_id=l.tenant_id and c.user_id=l.actor_id and c.allowed and c.processing_policy->'external_processing'='true'::jsonb and c.processing_policy->>'provider'='anthropic'
  join app.memberships m on m.tenant_id=l.tenant_id and m.user_id=l.actor_id and m.active and m.revoked_at is null and m.role in ('owner','operator')
  where l.tenant_id=t and l.id=r;
 elsif k='revision' then
  select jsonb_build_object('kind','revision','id',d.id,'version',d.revision_number::text||':'||b.sha256||':'||s.generation::text,'actor',i.actor_id,'sha256',b.sha256,'revision',d.revision_number,'source_id',s.id,'generation',s.generation,'policy',s.processing_policy)
  into v from app.document_revisions d join app.evidence_blobs b on b.tenant_id=d.tenant_id and b.id=d.blob_id
  join app.upload_intents i on i.tenant_id=d.tenant_id and i.completed_revision_id=d.id
  join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
  join app.devices dev on dev.tenant_id=s.tenant_id and dev.id=s.device_id and dev.active
  join app.memberships m on m.tenant_id=d.tenant_id and m.user_id=i.actor_id and m.active and m.revoked_at is null and m.role in ('owner','operator')
  where d.tenant_id=t and d.id=r and not d.generated_output and b.storage_location='server' and b.scan_state<>'quarantined'
   and s.active and s.local_selection_consent and s.server_upload_consent and s.external_ai_consent and s.generation=i.source_generation
   and (s.scope is null or s.processing_policy->'external_processing'='true'::jsonb and s.processing_policy->>'provider'='anthropic')
   and not exists(select 1 from app.evidence_retention_tasks q where q.tenant_id=t and q.revision_id=r)
  order by i.created_at limit 1;
 end if;
 return v;
end $$;
revoke all on function app.context_source_snapshot(uuid,text,uuid) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;

create or replace function app.context_source_readable(t uuid,k text,r uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(t,array['owner','operator','accountant']) and app.context_source_snapshot(t,k,r) is not null
$$;
revoke all on function app.context_source_readable(uuid,text,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.context_source_readable(uuid,text,uuid) to sigongnote_api;

create or replace function app.work_event_readable(t uuid,eid uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(t,array['owner','operator','accountant']) and exists(
  select 1 from app.work_events e where e.tenant_id=t and e.id=eid and app.context_source_snapshot(t,e.source_kind,e.source_ref) is not null
   and (e.source_kind<>'local' or e.status in ('superseded','dismissed') or app.local_native_revision(t,e.source_ref) is null)
   and not exists(select 1 from jsonb_array_elements(e.evidence_snapshots) ref
    where app.context_source_snapshot(t,ref->>'kind',(ref->>'id')::uuid) is null)
   and (e.status in ('superseded','dismissed') or
    (e.source_version=app.context_source_snapshot(t,e.source_kind,e.source_ref)->>'version'
     and not exists(select 1 from jsonb_array_elements(e.evidence_snapshots) ref
      where app.context_source_snapshot(t,ref->>'kind',(ref->>'id')::uuid)->>'version' is distinct from ref->>'version'))))
$$;
revoke all on function app.work_event_readable(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.work_event_readable(uuid,uuid) to sigongnote_api;

-- Replace old claims in place only when the exact source version changes. Keep all
-- prior events as superseded history after the replacement has actually been saved.
create or replace function app.next_context_input(scope_tenant uuid default null,lease_seconds integer default 180,external_allowed boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; txt text; n integer; token uuid;
begin
 if not external_allowed then return null; end if;
 for r in
  with revisions as (
   select d.tenant_id,'revision'::text source_kind,d.id source_ref,d.created_at received_at,i.actor_id,s.kind capture_kind,coalesce(o.project_id,fb.project_id) project_id,d.declared_mime
   from app.document_revisions d join app.upload_intents i on i.tenant_id=d.tenant_id and i.completed_revision_id=d.id
   join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
   left join app.site_folder_bindings fb on fb.tenant_id=s.tenant_id and fb.source_id=s.id and fb.source_generation=i.source_generation
   left join app.evidence_organizations o on o.tenant_id=d.tenant_id and o.revision_id=d.id
   where (scope_tenant is null or d.tenant_id=scope_tenant) and not d.generated_output
    and exists(select 1 from app.parse_results p where p.tenant_id=d.tenant_id and p.revision_id=d.id and p.output->>'status' in ('complete','partial'))
    and not exists(select 1 from app.jobs a where a.tenant_id=d.tenant_id and a.evidence_revision_id=d.id and a.work_lane='archive')
    and not exists(select 1 from app.document_revisions nx where nx.tenant_id=d.tenant_id and nx.document_id=d.document_id and nx.revision_number>d.revision_number)
    -- A metadata rendition with an unknown paid outcome is the same capture;
    -- prefer the original without silently paying to submit it again.
    and not exists(select 1 from app.local_journal_entries alias join app.product_ai_usage u on u.tenant_id=alias.tenant_id and u.channel='context' and u.config->>'source_kind'='local' and u.config->>'source_ref'=alias.id::text and u.state in ('submitted','unknown')
     where alias.tenant_id=d.tenant_id and app.local_native_revision(alias.tenant_id,alias.id)=d.id)
  ), locals as (
   select l.tenant_id,'local'::text source_kind,l.id source_ref,l.received_at,l.actor_id,l.source_kind capture_kind,l.project_id,l.mime declared_mime
   from app.local_journal_entries l where (scope_tenant is null or l.tenant_id=scope_tenant) and l.excerpt<>'' and app.local_native_revision(l.tenant_id,l.id) is null
  ), candidates as(select * from revisions union all select * from locals)
  select c.*,s.snapshot,deps.changed evidence_changed from candidates c cross join lateral(select app.context_source_snapshot(c.tenant_id,c.source_kind,c.source_ref) snapshot) s
  left join app.work_event_sources x on x.tenant_id=c.tenant_id and x.source_kind=c.source_kind and x.source_ref=c.source_ref
  cross join lateral(select coalesce(x.state='done' and exists(
   select 1 from app.work_events e cross join lateral jsonb_array_elements(e.evidence_snapshots) ref
   where e.tenant_id=c.tenant_id and e.source_kind=c.source_kind and e.source_ref=c.source_ref and e.status in ('open','resolved')
    and app.context_source_snapshot(c.tenant_id,ref->>'kind',(ref->>'id')::uuid)->>'version' is distinct from ref->>'version'),false) changed) deps
  where s.snapshot is not null and (x.source_ref is null or x.source_version is distinct from s.snapshot->>'version'
   or deps.changed
   or x.state='failed' and (x.error_code like 'BUDGET_PAUSED%' or x.error_code like 'PROVIDER_UNAVAILABLE%') and x.updated_at<now()-interval '1 hour'
   or x.state='failed' and x.error_code not like 'OUTCOME_UNKNOWN%' and x.error_code not like 'BUDGET_PAUSED%' and x.error_code not like 'PROVIDER_UNAVAILABLE%' and x.attempts<3
   or x.state='leased' and x.lease_until<now())
  order by c.received_at desc,c.source_ref limit 20
 loop
  token:=null;
  insert into app.work_event_sources(tenant_id,source_kind,source_ref,state,attempts,lease_until,source_version)
   values(r.tenant_id,r.source_kind,r.source_ref,'leased',1,now()+make_interval(secs=>lease_seconds),r.snapshot->>'version')
  on conflict(tenant_id,source_kind,source_ref) do update set state='leased',
   attempts=case when app.work_event_sources.source_version is distinct from excluded.source_version or app.work_event_sources.state='done' and r.evidence_changed then 1
    when app.work_event_sources.error_code like 'BUDGET_PAUSED%' or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%' then app.work_event_sources.attempts else least(app.work_event_sources.attempts+1,10) end,
   run_token=case when app.work_event_sources.source_version is distinct from excluded.source_version or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%' or app.work_event_sources.error_code='EVIDENCE_CHANGED' or app.work_event_sources.state='done' and r.evidence_changed then gen_random_uuid() else app.work_event_sources.run_token end,
   usage_id=case when app.work_event_sources.source_version is distinct from excluded.source_version or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%' or app.work_event_sources.error_code='EVIDENCE_CHANGED' or app.work_event_sources.state='done' and r.evidence_changed then null else app.work_event_sources.usage_id end,
   source_version=excluded.source_version,lease_until=excluded.lease_until,error_code=null,updated_at=now()
  where app.work_event_sources.source_version is distinct from excluded.source_version
   or app.work_event_sources.state='done' and r.evidence_changed
   or app.work_event_sources.state='failed' and (app.work_event_sources.error_code not like 'OUTCOME_UNKNOWN%' and (
    (app.work_event_sources.error_code like 'BUDGET_PAUSED%' or app.work_event_sources.error_code like 'PROVIDER_UNAVAILABLE%') and app.work_event_sources.updated_at<now()-interval '1 hour'
    or app.work_event_sources.error_code not like 'BUDGET_PAUSED%' and app.work_event_sources.error_code not like 'PROVIDER_UNAVAILABLE%' and app.work_event_sources.attempts<3))
   or app.work_event_sources.state='leased' and app.work_event_sources.lease_until<now()
  returning run_token into token;
  get diagnostics n=row_count; if n=0 then continue; end if;
  if r.source_kind='revision' then
   select string_agg(v->>'text',E'\n' order by i) filter(where length(trim(coalesce(v->>'text','')))>0) into txt
   from (select output from app.parse_results p where p.tenant_id=r.tenant_id and p.revision_id=r.source_ref order by created_at desc limit 1) q,
    jsonb_array_elements(coalesce(q.output->'spans','[]'::jsonb)) with ordinality a(v,i) where i<=60;
  else
   select file_name||E'\n'||excerpt into txt from app.local_journal_entries where tenant_id=r.tenant_id and id=r.source_ref;
  end if;
  return jsonb_build_object('tenant',r.tenant_id,'actor',r.actor_id,'source_kind',r.source_kind,'source_ref',r.source_ref,'capture_kind',r.capture_kind,
   'source_version',r.snapshot->>'version','processing_policy',r.snapshot->'policy','run_token',token,'project_id',r.project_id,'received_at',r.received_at,'mime',r.declared_mime,'text',left(coalesce(txt,''),6000));
 end loop;
 return null;
end $$;

create or replace function app.save_work_events(p_tenant uuid,p_actor uuid,p_kind text,p_ref uuid,p_events jsonb,p_usage uuid,p_model text,p_code text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e jsonb; f jsonb; ref text; snap jsonb; observed jsonb; refs jsonb; source jsonb; replaced_refs uuid[]; local_aliases uuid[]; claim app.work_event_sources; usage app.product_ai_usage;
 pid uuid; cid uuid; eid uuid; sid uuid; miss text[]; n_events integer:=0; n_follow integer:=0; conf text; unique_pid uuid; all_same boolean:=true;
begin
 if auth.uid() is distinct from p_actor or not app.has_tenant_role(p_tenant,array['owner','operator']) then raise exception 'context scope' using errcode='42501'; end if;
 select * into claim from app.work_event_sources where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref for update;
 if not found then return jsonb_build_object('state','stale','events',0,'followups',0); end if;
 if p_usage is not null then
  select * into usage from app.product_ai_usage where tenant_id=p_tenant and user_id=p_actor and id=p_usage and channel='context';
  if not found or usage.config->>'run_token' is distinct from claim.run_token::text or usage.config->>'source_version' is distinct from claim.source_version then
   return jsonb_build_object('state','stale','events',0,'followups',0);
  end if;
 end if;
 if claim.state='done' then return jsonb_build_object('state','done','events',claim.events,'followups',0); end if;
 if p_code is not null then
  update app.work_event_sources set state=case when p_code like 'OUTCOME_UNKNOWN%' then 'skipped' else 'failed' end,error_code=left(p_code,80),usage_id=p_usage,model=left(p_model,100),updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref;
  return jsonb_build_object('events',0,'followups',0,'state','failed');
 end if;
 source:=app.context_source_snapshot(p_tenant,p_kind,p_ref);
 if source is null or source->>'actor'<>p_actor::text or source->>'version' is distinct from claim.source_version
  or p_kind='local' and app.local_native_revision(p_tenant,p_ref) is not null
  or p_kind='revision' and exists(select 1 from app.document_revisions current join app.document_revisions newer on newer.tenant_id=current.tenant_id and newer.document_id=current.document_id and newer.revision_number>current.revision_number where current.tenant_id=p_tenant and current.id=p_ref)
  or p_usage is null or usage.state<>'settled' or usage.result is null or usage.evidence_withdrawn then
  update app.work_event_sources set state='skipped',error_code='SOURCE_CHANGED_OR_WITHDRAWN',updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref;
  return jsonb_build_object('state','stale','events',0,'followups',0);
 end if;
 if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>8 then raise exception 'events array' using errcode='22023'; end if;
 -- A citation keeps the version actually read by a scoped tool, not whatever
 -- happens to occupy that ID when the model returns. Changed/withdrawn evidence
 -- invalidates the whole interpretation before any replacement effects occur.
 for e in select * from jsonb_array_elements(p_events) loop
  for observed in select * from jsonb_array_elements(coalesce(e->'evidence_snapshots','[]'::jsonb)) loop
   snap:=app.context_source_snapshot(p_tenant,observed->>'kind',(observed->>'id')::uuid);
   if snap is null or snap->>'version' is distinct from observed->>'version' then
    update app.work_event_sources set state='failed',error_code='EVIDENCE_CHANGED',usage_id=p_usage,updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref;
    return jsonb_build_object('state','stale','events',0,'followups',0);
   end if;
  end loop;
 end loop;
 if p_kind='revision' then
  select array_agg(old.id) into replaced_refs from app.document_revisions current join app.document_revisions old on old.tenant_id=current.tenant_id and old.document_id=current.document_id and old.revision_number<=current.revision_number where current.tenant_id=p_tenant and current.id=p_ref;
 else replaced_refs:=array[p_ref]; end if;
 if p_kind='revision' then
  select array_agg(l.id) into local_aliases from app.local_journal_entries l where l.tenant_id=p_tenant and app.local_native_revision(p_tenant,l.id)=p_ref;
  update app.work_followups set state='dismissed',version=version+1,updated_at=now() where tenant_id=p_tenant and state='open' and event_id in (
   select old.id from app.work_events old where old.tenant_id=p_tenant and old.source_kind='local' and old.source_ref=any(local_aliases) and old.status in ('open','resolved'));
  update app.work_events set status='superseded',version=version+1,updated_at=now() where tenant_id=p_tenant and source_kind='local' and source_ref=any(local_aliases) and status in ('open','resolved');
 end if;
 -- A new file version replaces the previous interpretation, without destroying its history.
 update app.work_followups set state='dismissed',version=version+1,updated_at=now() where tenant_id=p_tenant and state='open' and event_id in (
  select old.id from app.work_events old where old.tenant_id=p_tenant and old.source_kind=p_kind and old.source_ref=any(replaced_refs) and old.status in ('open','resolved') and (old.source_ref<>p_ref or old.interpretation_run is distinct from claim.run_token));
 update app.work_events set status='superseded',version=version+1,updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=any(replaced_refs) and status in ('open','resolved') and (source_ref<>p_ref or interpretation_run is distinct from claim.run_token);
 for e in select * from jsonb_array_elements(p_events) loop
  pid:=null;cid:=null;sid:=null;refs:='[]';miss:=coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(e->'missing','[]'::jsonb)) x),'{}');
  if e->>'project_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then select id into pid from app.projects where tenant_id=p_tenant and id=(e->>'project_id')::uuid; end if;
  if pid is null and not ('site'=any(miss)) then miss:=array_append(miss,'site'); end if;
  if pid is not null then miss:=array_remove(miss,'site'); end if;
  if pid is not null and e->>'context_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then select id into cid from app.work_contexts where tenant_id=p_tenant and id=(e->>'context_id')::uuid and project_id=pid; end if;
  if e->>'supersedes_event_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   select id into sid from app.work_events where tenant_id=p_tenant and id=(e->>'supersedes_event_id')::uuid and status in ('open','resolved','superseded') and app.work_event_readable(p_tenant,id) for update;
  end if;
  conf:=case when e->>'confidence' in ('high','medium','low') then e->>'confidence' else 'low' end;
  for ref in select * from jsonb_array_elements_text(coalesce(e->'evidence_refs','[]'::jsonb)) loop
   if ref !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then continue; end if;
   select value into observed from jsonb_array_elements(coalesce(e->'evidence_snapshots','[]'::jsonb)) where value->>'id'=ref limit 1;
   if ref=p_ref::text then snap:=source;
   elsif observed is null then continue;
   else snap:=app.context_source_snapshot(p_tenant,observed->>'kind',ref::uuid); end if;
   if snap is not null and not refs @> jsonb_build_array(snap) then refs:=refs||jsonb_build_array(snap); end if;
  end loop;
  insert into app.work_events(tenant_id,kind,summary,detail,project_id,context_id,party,source_kind,source_ref,source_version,interpretation_run,evidence_refs,evidence_snapshots,quantities,missing,confidence,reasoning,model,usage_id,actor_id,occurred_at,supersedes)
  values(p_tenant,coalesce(nullif(e->>'kind',''),'note'),left(coalesce(e->>'summary','(내용 없음)'),400),left(coalesce(e->>'detail',''),2000),pid,cid,left(e->>'party',120),p_kind,p_ref,claim.source_version,claim.run_token,
   coalesce((select array_agg((x->>'id')::uuid) from jsonb_array_elements(refs) x),'{}'),refs,
   coalesce(e->'quantities','[]'::jsonb),miss,conf,left(coalesce(e->>'reasoning',''),1200),left(p_model,100),p_usage,p_actor,
   case when e->>'occurred_at' ~ '^\d{4}-\d{2}-\d{2}' then (e->>'occurred_at')::timestamptz else null end,sid) returning id into eid;
  n_events:=n_events+1;
  if sid is not null then
   update app.work_events set status='superseded',version=version+1,updated_at=now() where tenant_id=p_tenant and id=sid and status in ('open','resolved');
   update app.work_followups set state='dismissed',version=version+1,updated_at=now() where tenant_id=p_tenant and event_id=sid and state='open';
  end if;
  for f in select * from jsonb_array_elements(coalesce(e->'followups','[]'::jsonb)) loop
   if length(trim(coalesce(f->>'title','')))=0 then continue; end if;
   insert into app.work_followups(tenant_id,id,event_id,title,due_on,project_id) values(p_tenant,gen_random_uuid(),eid,left(f->>'title',200),case when f->>'due_on' ~ '^\d{4}-\d{2}-\d{2}$' then (f->>'due_on')::date else null end,pid);
   n_follow:=n_follow+1;
  end loop;
  if pid is null or conf<>'high' or unique_pid is not null and unique_pid<>pid then all_same:=false; end if;
  if unique_pid is null then unique_pid:=pid; end if;
 end loop;
 if p_kind='local' and all_same and n_events>0 and unique_pid is not null then
  update app.local_journal_entries set project_id=unique_pid,project_origin='context',version=version+1,updated_at=now() where tenant_id=p_tenant and id=p_ref and project_id is null;
 end if;
 update app.work_event_sources set state='done',events=n_events,usage_id=p_usage,model=left(p_model,100),error_code=null,updated_at=now() where tenant_id=p_tenant and source_kind=p_kind and source_ref=p_ref;
 return jsonb_build_object('events',n_events,'followups',n_follow,'state','done');
end $$;

create or replace function app.correct_work_event(t uuid,eid uuid,expected bigint,p_project uuid,p_summary text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e app.work_events;
begin
 if auth.uid() is null or not app.has_tenant_role(t,array['owner','operator']) then return null; end if;
 select * into e from app.work_events where tenant_id=t and id=eid and status in ('open','resolved') and app.work_event_readable(t,id) for update;
 if not found then return null; end if;
 if e.version<>expected then return jsonb_build_object('conflict',true,'version',e.version); end if;
 if p_project is not null and not exists(select 1 from app.projects where tenant_id=t and id=p_project) then return null; end if;
 if length(trim(p_summary)) not between 1 and 400 or length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid correction' using errcode='22023'; end if;
 insert into app.work_event_corrections(tenant_id,event_id,actor_id,expected_version,previous,replacement,reason)
 values(t,eid,auth.uid(),expected,jsonb_build_object('project_id',e.project_id,'summary',e.summary),jsonb_build_object('project_id',p_project,'summary',trim(p_summary)),trim(p_reason));
 update app.work_events set project_id=p_project,context_id=case when project_id is distinct from p_project then null else context_id end,
  summary=trim(p_summary),missing=case when p_project is null then array(select distinct x from unnest(missing||array['site']) x) else array_remove(missing,'site') end,
  version=version+1,updated_at=now() where tenant_id=t and id=eid;
 update app.work_followups set project_id=p_project,version=version+1,updated_at=now() where tenant_id=t and event_id=eid;
 return jsonb_build_object('version',expected+1);
end $$;
revoke all on function app.correct_work_event(uuid,uuid,bigint,uuid,text,text) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.correct_work_event(uuid,uuid,bigint,uuid,text,text) to sigongnote_api;

-- A dismissed or superseded reminder can never reopen its replaced business event.
create or replace function app.mark_work_followup(t uuid,f uuid,expected bigint,done boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r app.work_followups;
begin
 if auth.uid() is null or not app.has_tenant_role(t,array['owner','operator']) then return null; end if;
 select w.* into r from app.work_followups w join app.work_events e on e.tenant_id=w.tenant_id and e.id=w.event_id
  where w.tenant_id=t and w.id=f and w.state<>'dismissed' and e.status in ('open','resolved') and app.work_event_readable(t,e.id) for update of w;
 if not found then return null; end if;
 if r.version<>expected then return jsonb_build_object('conflict',true,'version',r.version); end if;
 update app.work_followups set state=case when done then 'done' else 'open' end,done_by=case when done then auth.uid() else null end,done_at=case when done then now() else null end,version=version+1,updated_at=now() where tenant_id=t and id=f returning * into r;
 if done and not exists(select 1 from app.work_followups w where w.tenant_id=t and w.event_id=r.event_id and w.state='open') then
  update app.work_events set status='resolved',updated_at=now(),version=version+1 where tenant_id=t and id=r.event_id and status='open';
 elsif not done then update app.work_events set status='open',updated_at=now(),version=version+1 where tenant_id=t and id=r.event_id and status='resolved'; end if;
 return jsonb_build_object('done',r.state='done','version',r.version);
end $$;
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
  if p_config->>'source_kind'='summary' then return p_source is null and p_generation is null and p_revision is null and app.has_tenant_role(p_tenant,array['owner','operator']); end if;
  return p_source is null and p_generation is null and exists(
   select 1 from app.work_event_sources x
   cross join lateral(select app.context_source_snapshot(x.tenant_id,x.source_kind,x.source_ref) value) src
   where x.tenant_id=p_tenant and x.source_kind=p_config->>'source_kind' and x.source_ref::text=p_config->>'source_ref'
    and src.value->>'actor'=p_user::text and src.value->>'version'=p_config->>'source_version' and src.value->'policy' is not distinct from p_config->'policy'
    and x.source_version=p_config->>'source_version' and x.run_token::text=p_config->>'run_token'
    and (p_revision is null and x.source_kind='local' or p_revision=x.source_ref and x.source_kind='revision'));
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
