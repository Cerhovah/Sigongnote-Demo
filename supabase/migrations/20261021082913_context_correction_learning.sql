-- Context corrections are separate from financial/quality decision examples.
create table if not exists app.context_learning_cases (
 tenant_id uuid not null references app.tenants(id) on delete cascade,id uuid not null default gen_random_uuid(),
 correction_id uuid not null,event_id uuid not null,actor_id uuid not null references auth.users(id),consent_id uuid not null,
 source_kind text not null check(source_kind in ('local','revision')),source_ref uuid not null,source_version text not null,event_version bigint not null,
 snapshot jsonb not null,snapshot_hash text not null check(snapshot_hash~'^[a-f0-9]{64}$'),eligible boolean not null,
 state text not null default 'unreviewed' check(state in ('unreviewed','adopted','excluded')),version bigint not null default 1,
 reviewed_by uuid references auth.users(id),reviewed_at timestamptz,review_reason text,created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,correction_id),foreign key(tenant_id,correction_id) references app.work_event_corrections(tenant_id,id) on delete cascade
);
create table if not exists app.context_reading_procedures (
 tenant_id uuid not null references app.tenants(id) on delete cascade,id uuid not null default gen_random_uuid(),owner_id uuid not null references auth.users(id),consent_id uuid not null,
 rule text not null check(rule='recent-project-consensus-v1'),train_ids uuid[] not null check(cardinality(train_ids) between 1 and 20),train_families text[] not null,
 state text not null default 'shadow' check(state in ('shadow','promoted','withdrawn')),version bigint not null default 1,
 promoted_at timestamptz,created_at timestamptz not null default now(),primary key(tenant_id,id)
);
create table if not exists app.context_reading_shadows (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),procedure_id uuid not null,actor_id uuid not null references auth.users(id),consent_id uuid not null,
 source_kind text not null check(source_kind in ('local','revision')),source_ref uuid not null,source_version text not null,
 source_received_at timestamptz not null,prediction uuid,observations jsonb not null,observed_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,procedure_id,source_kind,source_ref,source_version),
 foreign key(tenant_id,procedure_id) references app.context_reading_procedures(tenant_id,id) on delete cascade
);
create table if not exists app.context_reading_evaluations (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),procedure_id uuid not null,owner_id uuid not null references auth.users(id),report jsonb not null,
 created_at timestamptz not null default now(),primary key(tenant_id,id),foreign key(tenant_id,procedure_id) references app.context_reading_procedures(tenant_id,id) on delete cascade
);

create or replace function app.context_learning_source_version(t uuid,k text,r uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare v text;
begin
 if not app.has_tenant_role(t,array['owner','operator']) or not app.context_source_readable(t,k,r) then return null;end if;
 if k='local' then
  select l.local_revision::text||':'||l.sha256||':'||c.generation::text into v from app.local_journal_entries l join app.local_context_consents c on c.tenant_id=l.tenant_id and c.user_id=l.actor_id where l.tenant_id=t and l.id=r;
 elsif k='revision' then
  select d.revision_number::text||':'||b.sha256||':'||s.generation::text into v from app.document_revisions d join app.evidence_blobs b on b.tenant_id=d.tenant_id and b.id=d.blob_id join app.upload_intents i on i.tenant_id=d.tenant_id and i.completed_revision_id=d.id join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id where d.tenant_id=t and d.id=r limit 1;
 end if;return v;
end $$;
-- Learning split identity only: revisions of one document are never independent held-outs.
-- Equal SHA256 values are also excluded by the domain/evaluation checks; no source records are merged.
create or replace function app.context_learning_source_family(t uuid,k text,r uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare v text;
begin
 if not app.has_tenant_role(t,array['owner','operator']) or not app.context_source_readable(t,k,r) then return null;end if;
 if k='local' then select 'local:'||l.id::text into v from app.local_journal_entries l where l.tenant_id=t and l.id=r;
 elsif k='revision' then select 'document:'||d.document_id::text into v from app.document_revisions d where d.tenant_id=t and d.id=r;
 end if;return v;
end $$;
create or replace function app.context_learning_case_current(t uuid,c uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(t,array['owner','operator']) and exists(
  select 1 from app.context_learning_cases x join app.activity_consents a on a.tenant_id=x.tenant_id and a.user_id=x.actor_id
  join app.work_events e on e.tenant_id=x.tenant_id and e.id=x.event_id
  join app.work_event_corrections correction on correction.tenant_id=x.tenant_id and correction.id=x.correction_id and correction.event_id=x.event_id
  where x.tenant_id=t and x.id=c and a.learning_allowed and a.learning_consent_id=x.consent_id and x.created_at>now()-interval '90 days'
   -- Task completion/reopening advances the event version without changing the correction.
   -- Correction expected_version is monotone under the event lock, so no timestamp ordering is needed.
   and correction.expected_version+1=x.event_version
   and not exists(select 1 from app.work_event_corrections newer where newer.tenant_id=t and newer.event_id=x.event_id and newer.expected_version>correction.expected_version)
   and e.project_id is not distinct from (x.snapshot->'replacement'->>'project_id')::uuid and e.summary=x.snapshot->'replacement'->>'summary'
   and e.source_kind=x.source_kind and e.source_ref=x.source_ref and e.source_version=x.source_version
   and app.context_learning_source_version(t,x.source_kind,x.source_ref)=x.source_version
   and x.snapshot->>'source_family'=app.context_learning_source_family(t,x.source_kind,x.source_ref)
   and not exists(select 1 from jsonb_array_elements(x.snapshot->'evidence') p where app.context_learning_source_version(t,p->>'kind',(p->>'id')::uuid) is distinct from p->>'version'))
$$;
create or replace function app.context_learning_procedure_current(t uuid,p uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(t,array['owner','operator']) and exists(
  select 1 from app.context_reading_procedures x join app.activity_consents a on a.tenant_id=x.tenant_id and a.user_id=x.owner_id
  join app.memberships m on m.tenant_id=x.tenant_id and m.user_id=x.owner_id and m.role='owner'
  where x.tenant_id=t and x.id=p and x.state in ('shadow','promoted') and a.learning_allowed and a.learning_consent_id=x.consent_id
   and x.created_at>now()-interval '90 days' and cardinality(x.train_families)=2*cardinality(x.train_ids)
   and not exists(select 1 from unnest(x.train_ids) c where not app.context_learning_case_current(t,c) or not exists(select 1 from app.context_learning_cases lc where lc.tenant_id=t and lc.id=c and lc.state='adopted' and lc.snapshot->>'source_family'=any(x.train_families) and 'sha256:'||split_part(lc.source_version,':',2)=any(x.train_families)))
   and (x.state<>'promoted' or exists(select 1 from app.context_reading_evaluations ev where ev.tenant_id=t and ev.procedure_id=x.id and (ev.report->>'canPromote')::boolean
    and jsonb_array_length(ev.report->'caseIds')>=3
    and not exists(select 1 from jsonb_array_elements_text(ev.report->'caseIds') ca join app.context_learning_cases a on a.tenant_id=t and a.id=ca::uuid
     join app.context_learning_cases b on b.tenant_id=t and b.id<>a.id and ev.report->'caseIds' ? b.id::text
     where a.snapshot->>'source_family'=b.snapshot->>'source_family' or split_part(a.source_version,':',2)=split_part(b.source_version,':',2))
    and not exists(select 1 from jsonb_array_elements_text(ev.report->'caseIds') v where
     not app.context_learning_case_current(t,v::uuid) or not exists(select 1 from app.context_learning_cases lc where lc.tenant_id=t and lc.id=v::uuid and lc.state='adopted' and not(lc.id=any(x.train_ids)) and not(lc.snapshot->>'source_family'=any(x.train_families)) and not('sha256:'||split_part(lc.source_version,':',2)=any(x.train_families))
      and exists(select 1 from app.context_reading_shadows s join app.activity_consents sa on sa.tenant_id=s.tenant_id and sa.user_id=s.actor_id and sa.learning_allowed and sa.learning_consent_id=s.consent_id
       where s.tenant_id=t and s.procedure_id=x.id and s.source_kind=lc.source_kind and s.source_ref=lc.source_ref and s.source_version=lc.source_version and s.observations->>'source_family'=lc.snapshot->>'source_family' and s.observed_at<lc.created_at and s.source_received_at>x.created_at
       and not exists(select 1 from jsonb_array_elements(s.observations->'evidence') proof where app.context_learning_source_version(t,proof->>'kind',(proof->>'id')::uuid) is distinct from proof->>'version')))))))
$$;

alter table app.context_learning_cases enable row level security;
alter table app.context_reading_procedures enable row level security;
alter table app.context_reading_shadows enable row level security;
alter table app.context_reading_evaluations enable row level security;
revoke all on app.context_learning_cases,app.context_reading_procedures,app.context_reading_shadows,app.context_reading_evaluations from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.context_learning_cases,app.context_reading_procedures to sigongnote_api;
grant select,insert on app.context_reading_shadows,app.context_reading_evaluations to sigongnote_api;
revoke update on app.context_learning_cases,app.context_reading_procedures from sigongnote_api;
grant update(state,version,reviewed_by,reviewed_at,review_reason) on app.context_learning_cases to sigongnote_api;
grant update(state,version,promoted_at) on app.context_reading_procedures to sigongnote_api;
drop policy if exists case_read on app.context_learning_cases;
drop policy if exists case_insert on app.context_learning_cases;
drop policy if exists case_update on app.context_learning_cases;
drop policy if exists procedure_read on app.context_reading_procedures;
drop policy if exists procedure_insert on app.context_reading_procedures;
drop policy if exists procedure_update on app.context_reading_procedures;
drop policy if exists shadow_read on app.context_reading_shadows;
drop policy if exists shadow_insert on app.context_reading_shadows;
drop policy if exists evaluation_read on app.context_reading_evaluations;
drop policy if exists evaluation_insert on app.context_reading_evaluations;
create policy case_read on app.context_learning_cases for select to sigongnote_api using((app.has_tenant_role(tenant_id,array['owner']) or (actor_id=auth.uid() and app.has_tenant_role(tenant_id,array['operator']))) and app.context_learning_case_current(tenant_id,id));
create policy case_insert on app.context_learning_cases for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner','operator']) and actor_id=auth.uid() and exists(select 1 from app.activity_consents c where c.tenant_id=context_learning_cases.tenant_id and c.user_id=auth.uid() and c.learning_allowed and c.learning_consent_id=context_learning_cases.consent_id));
create policy case_update on app.context_learning_cases for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner']) and app.context_learning_case_current(tenant_id,id)) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy procedure_read on app.context_reading_procedures for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator']));
create policy procedure_insert on app.context_reading_procedures for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and owner_id=auth.uid());
create policy procedure_update on app.context_reading_procedures for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy shadow_read on app.context_reading_shadows for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner']) and app.context_learning_procedure_current(tenant_id,procedure_id));
create policy shadow_insert on app.context_reading_shadows for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner','operator']) and actor_id=auth.uid() and app.context_learning_procedure_current(tenant_id,procedure_id) and exists(select 1 from app.activity_consents c where c.tenant_id=context_reading_shadows.tenant_id and c.user_id=auth.uid() and c.learning_allowed and c.learning_consent_id=context_reading_shadows.consent_id));
create policy evaluation_read on app.context_reading_evaluations for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner']));
create policy evaluation_insert on app.context_reading_evaluations for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and owner_id=auth.uid());

create or replace function app.purge_context_learning(t uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not app.has_tenant_role(t,array['owner']) then raise exception 'owner required' using errcode='42501';end if;
 delete from app.context_learning_cases x where x.tenant_id=t and not app.context_learning_case_current(t,x.id);
 delete from app.context_reading_procedures x where x.tenant_id=t and (x.created_at<now()-interval '90 days' or not exists(select 1 from app.activity_consents a where a.tenant_id=t and a.user_id=x.owner_id and a.learning_allowed and a.learning_consent_id=x.consent_id));
 delete from app.context_reading_shadows s where s.tenant_id=t and (s.observed_at<now()-interval '90 days' or not exists(select 1 from app.activity_consents a where a.tenant_id=t and a.user_id=s.actor_id and a.learning_allowed and a.learning_consent_id=s.consent_id));
end $$;
create or replace function app.revoke_context_learning() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='DELETE' or not new.learning_allowed or old.learning_consent_id is distinct from new.learning_consent_id then
  delete from app.context_learning_cases where tenant_id=old.tenant_id and actor_id=old.user_id;
  delete from app.context_reading_shadows where tenant_id=old.tenant_id and actor_id=old.user_id;
  delete from app.context_reading_procedures where tenant_id=old.tenant_id and owner_id=old.user_id;
 end if;return null;
end $$;
drop trigger if exists context_learning_withdrawal on app.activity_consents;
create trigger context_learning_withdrawal after update or delete on app.activity_consents for each row execute function app.revoke_context_learning();

create or replace function app.correct_work_event(t uuid,eid uuid,expected bigint,p_project uuid,p_summary text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e app.work_events;cid uuid;
begin
 if auth.uid() is null or not app.has_tenant_role(t,array['owner','operator']) then return null;end if;
 select * into e from app.work_events where tenant_id=t and id=eid and status in ('open','resolved') and app.work_event_readable(t,id) for update;
 if not found then return null;end if;
 if e.version<>expected then return jsonb_build_object('conflict',true,'version',e.version);end if;
 if p_project is not null and not exists(select 1 from app.projects where tenant_id=t and id=p_project) then return null;end if;
 if length(trim(p_summary)) not between 1 and 400 or length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid correction' using errcode='22023';end if;
 insert into app.work_event_corrections(tenant_id,event_id,actor_id,expected_version,previous,replacement,reason) values(t,eid,auth.uid(),expected,jsonb_build_object('project_id',e.project_id,'summary',e.summary),jsonb_build_object('project_id',p_project,'summary',trim(p_summary)),trim(p_reason)) returning id into cid;
 update app.work_events set project_id=p_project,context_id=case when project_id is distinct from p_project then null else context_id end,summary=trim(p_summary),missing=case when p_project is null then array(select distinct x from unnest(missing||array['site']) x) else array_remove(missing,'site') end,version=version+1,updated_at=now() where tenant_id=t and id=eid;
 update app.work_followups set project_id=p_project,version=version+1,updated_at=now() where tenant_id=t and event_id=eid;
 return jsonb_build_object('version',expected+1,'correction_id',cid);
end $$;
revoke all on function app.context_learning_source_version(uuid,text,uuid),app.context_learning_source_family(uuid,text,uuid),app.context_learning_case_current(uuid,uuid),app.context_learning_procedure_current(uuid,uuid),app.purge_context_learning(uuid),app.revoke_context_learning() from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.context_learning_source_version(uuid,text,uuid),app.context_learning_source_family(uuid,text,uuid),app.context_learning_case_current(uuid,uuid),app.context_learning_procedure_current(uuid,uuid),app.purge_context_learning(uuid) to sigongnote_api;
