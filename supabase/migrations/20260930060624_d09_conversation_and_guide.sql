create table app.conversations (
 tenant_id uuid not null,id uuid not null,user_id uuid not null references auth.users(id),created_at timestamptz not null default now(),primary key(tenant_id,id),foreign key(tenant_id) references app.tenants(id)
);
create table app.conversation_turns (
 tenant_id uuid not null,conversation_id uuid not null,id uuid not null,request_hash text not null,text text not null check(length(text) between 1 and 2000),
 response jsonb not null,engine_version text not null,model_version text,prompt_version text,tool_calls integer not null default 1,token_count integer not null default 0,cost_minor integer not null default 0,
 created_at timestamptz not null default now(),primary key(tenant_id,conversation_id,id),foreign key(tenant_id,conversation_id) references app.conversations(tenant_id,id) on delete cascade
);
create table app.work_guide_progress (
 tenant_id uuid not null,user_id uuid not null references auth.users(id),guide_version text not null,step integer not null check(step between 0 and 2),completed boolean not null,
 updated_at timestamptz not null default now(),primary key(tenant_id,user_id,guide_version),foreign key(tenant_id) references app.tenants(id)
);
alter table app.conversations enable row level security;alter table app.conversation_turns enable row level security;alter table app.work_guide_progress enable row level security;
revoke all on app.conversations,app.conversation_turns,app.work_guide_progress from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert on app.conversations,app.conversation_turns to sigongnote_api;grant select,insert,update on app.work_guide_progress to sigongnote_api;
create policy conversations_owned on app.conversations for all to sigongnote_api using(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant'])) with check(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy turns_owned on app.conversation_turns for all to sigongnote_api using(exists(select 1 from app.conversations c where c.tenant_id=conversation_turns.tenant_id and c.id=conversation_turns.conversation_id and c.user_id=(select auth.uid()))) with check(exists(select 1 from app.conversations c where c.tenant_id=conversation_turns.tenant_id and c.id=conversation_turns.conversation_id and c.user_id=(select auth.uid())));
create policy guide_owned on app.work_guide_progress for all to sigongnote_api using(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant'])) with check(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
-- Human resolution is an auditable projection; money and transaction identity are unchanged.
create table app.organization_answers (
 tenant_id uuid not null,revision_id uuid not null,version bigint not null,actor_id uuid not null references auth.users(id),project_id uuid not null,previous jsonb not null,created_at timestamptz not null default now(),
 primary key(tenant_id,revision_id,version),foreign key(tenant_id,revision_id) references app.evidence_organizations(tenant_id,revision_id) on delete cascade,foreign key(tenant_id,project_id) references app.projects(tenant_id,id)
);
alter table app.organization_answers enable row level security;revoke all on app.organization_answers from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.organization_answers to sigongnote_api;create policy answers_read on app.organization_answers for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
-- One current access predicate for lists, conversations, answers and original opening.
create function app.revision_accessible(p_tenant uuid,p_revision uuid) returns boolean language sql stable security definer set search_path='' as $$
 select app.has_tenant_role(p_tenant,array['owner','operator','accountant']) and exists(
 select 1 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id
 where r.tenant_id=p_tenant and r.id=p_revision and b.storage_location='server' and b.scan_state<>'quarantined'
 and not exists(select 1 from app.upload_intents i join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id where i.tenant_id=r.tenant_id and i.completed_revision_id=r.id and (not s.active or not s.server_upload_consent or s.generation<>i.source_generation)))
$$;
revoke all on function app.revision_accessible(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.revision_accessible(uuid,uuid) to sigongnote_api;
create function app.answer_organization(p_tenant uuid,p_revision uuid,p_version bigint,p_project uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare old app.evidence_organizations%rowtype;
begin
 if not app.has_tenant_role(p_tenant,array['owner','operator']) then return false;end if;
 select * into old from app.evidence_organizations where tenant_id=p_tenant and revision_id=p_revision for update;
 if not found or not exists(select 1 from app.projects where tenant_id=p_tenant and id=p_project) then return false;end if;
 if exists(select 1 from app.document_revisions newer join app.document_revisions current on current.tenant_id=newer.tenant_id and current.document_id=newer.document_id where current.tenant_id=p_tenant and current.id=p_revision and newer.revision_number>current.revision_number) then return false;end if;
 if not app.revision_accessible(p_tenant,p_revision) then return false;end if;
 if old.version<>p_version then
   return old.version=p_version+1 and old.project_id=p_project and exists(select 1 from app.organization_answers a where a.tenant_id=p_tenant and a.revision_id=p_revision and a.version=p_version+1 and a.project_id=p_project and a.actor_id=auth.uid());
 end if;
 insert into app.organization_answers(tenant_id,revision_id,version,actor_id,project_id,previous) values(p_tenant,p_revision,p_version+1,auth.uid(),p_project,to_jsonb(old));
 update app.evidence_organizations set project_id=p_project,context_id=null,state='linked',version=version+1 where tenant_id=p_tenant and revision_id=p_revision;
 update app.evidence_index set project_id=p_project,scope='project' where tenant_id=p_tenant and revision_id=p_revision and organization_span is not null;
 return true;
end $$;
revoke all on function app.answer_organization(uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role,sigongnote_worker;grant execute on function app.answer_organization(uuid,uuid,bigint,uuid) to sigongnote_api;
