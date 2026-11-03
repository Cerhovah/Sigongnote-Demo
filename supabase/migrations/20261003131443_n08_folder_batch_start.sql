-- One explicit batch correction; preserve original files, facts and confirmed accounting.
alter table app.site_folder_bindings drop constraint site_folder_bindings_scope_mode_check;
alter table app.site_folder_bindings add constraint site_folder_bindings_scope_mode_check check(scope_mode in ('project','company_common','unassigned'));
alter table app.site_folder_bindings add column display_name text check(length(display_name) between 1 and 180);
create table app.folder_binding_changes(
 tenant_id uuid not null,command_id uuid not null,binding_id uuid not null,actor_id uuid not null references auth.users(id),
 before_state jsonb not null,after_state jsonb not null,previous_organizations jsonb not null,created_at timestamptz not null default now(),
 primary key(tenant_id,command_id,binding_id),foreign key(tenant_id,binding_id) references app.site_folder_bindings(tenant_id,id)
);
alter table app.folder_binding_changes enable row level security;
revoke all on app.folder_binding_changes from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create function app.correct_folder_bindings(t uuid,command uuid,changes jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare actor uuid:=auth.uid();c jsonb;b app.site_folder_bindings%rowtype;o app.evidence_organizations%rowtype;result jsonb:='[]';previous jsonb;project uuid;context uuid;label text;mode text;bindings integer;
begin
 if not app.has_tenant_role(t,array['owner','operator']) then return jsonb_build_object('ok',false,'code','FORBIDDEN');end if;
 if jsonb_typeof(changes)<>'array' or jsonb_array_length(changes) not between 1 and 100 then return jsonb_build_object('ok',false,'code','INVALID_CONTRACT');end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(changes))<>jsonb_array_length(changes) then return jsonb_build_object('ok',false,'code','INVALID_CONTRACT');end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':folder-batch',0));
 -- Match device/source revocation lock order before taking any binding lock.
 perform d.id from app.devices d where d.tenant_id=t and d.id in(select b.device_id from app.site_folder_bindings b join jsonb_array_elements(changes) c on b.id=(c->>'id')::uuid where b.tenant_id=t and b.user_id=actor) order by d.id for share;
 perform s.id from app.capture_sources s where s.tenant_id=t and s.id in(select b.source_id from app.site_folder_bindings b join jsonb_array_elements(changes) c on b.id=(c->>'id')::uuid where b.tenant_id=t and b.user_id=actor) order by s.id for share;
 perform b.id from app.site_folder_bindings b join jsonb_array_elements(changes) c on b.id=(c->>'id')::uuid where b.tenant_id=t and b.user_id=actor order by b.id for update of b;
 -- Validate all rows before the first mutation: a stale row rejects the whole batch.
 for c in select value from jsonb_array_elements(changes) loop
  select * into b from app.site_folder_bindings where tenant_id=t and id=(c->>'id')::uuid and user_id=actor;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
  if b.version<>(c->>'expected_version')::int or b.source_generation<>(c->>'source_generation')::int then return jsonb_build_object('ok',false,'code','VERSION_CONFLICT');end if;
  if not exists(select 1 from app.capture_sources s join app.devices d on d.tenant_id=s.tenant_id and d.id=s.device_id where s.tenant_id=t and s.id=b.source_id and s.user_id=actor and s.active and d.active and s.local_selection_consent and s.generation=b.source_generation) then return jsonb_build_object('ok',false,'code','SOURCE_EXPIRED');end if;
  if c->>'scope_mode' not in ('project','company_common','unassigned') or ((c->>'scope_mode'='project')<>(c->>'project_id' is not null)) then return jsonb_build_object('ok',false,'code','INVALID_CONTRACT');end if;
  if c->>'project_id' is not null and not exists(select 1 from app.projects where tenant_id=t and id=(c->>'project_id')::uuid) then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
 end loop;
 for c in select value from jsonb_array_elements(changes) order by value->>'id' loop
  select * into b from app.site_folder_bindings where tenant_id=t and id=(c->>'id')::uuid;
  project:=(c->>'project_id')::uuid;mode:=c->>'scope_mode';
  select coalesce(jsonb_agg(to_jsonb(o)),'[]') into previous from app.evidence_organizations o where o.tenant_id=t and exists(select 1 from app.upload_intents i where i.tenant_id=t and i.completed_revision_id=o.revision_id and i.source_id=b.source_id and i.source_generation=b.source_generation);
  update app.site_folder_bindings set project_id=project,scope_mode=mode,version=version+1 where tenant_id=t and id=b.id;
  insert into app.folder_binding_changes values(t,command,b.id,actor,to_jsonb(b),to_jsonb(b)||jsonb_build_object('project_id',project,'scope_mode',mode,'version',b.version+1),previous,now());
  -- Folder correction updates automatic attribution only. Explicit per-document answers remain authoritative.
  for o in select o.* from app.evidence_organizations o where o.tenant_id=t
   and not exists(select 1 from app.organization_answers a where a.tenant_id=t and a.revision_id=o.revision_id)
   and exists(select 1 from app.upload_intents i where i.tenant_id=t and i.completed_revision_id=o.revision_id and i.source_id=b.source_id and i.source_generation=b.source_generation)
   order by o.revision_id for update loop
   if not app.revision_accessible(t,o.revision_id) then continue;end if;
   select count(*) into bindings from app.upload_intents i join app.site_folder_bindings f on f.tenant_id=i.tenant_id and f.source_id=i.source_id and f.source_generation=i.source_generation where i.tenant_id=t and i.completed_revision_id=o.revision_id;
   if bindings<>1 then continue;end if;
   context:=null;
   if project is not null then
    label:=null;select w.label into label from app.work_contexts w where w.tenant_id=t and w.id=o.context_id;
    if label is null then
     select min(captured[1]) into label from app.parse_results p cross join lateral jsonb_array_elements(p.output->'spans') s cross join lateral regexp_matches(s->>'text','(?:^|\n)\s*(?:이번 일|작업명|작업)\s*[:：]\s*([^\n]{2,100})','g') captured where p.tenant_id=t and p.job_id=o.job_id having count(distinct captured[1])=1;
    end if;
    if label is not null then
    insert into app.work_contexts(tenant_id,project_id,label) values(t,project,label) on conflict(tenant_id,project_id,label) do nothing;
    select w.id into context from app.work_contexts w where w.tenant_id=t and w.project_id=project and w.label=label;
    end if;
   end if;
   update app.evidence_organizations set project_id=project,context_id=context,state=case when mode='project' then 'linked' when mode='company_common' then 'common' else 'unassigned' end,
    project_candidates=case when project is null then '{}'::uuid[] else array[project] end,version=version+1 where tenant_id=t and revision_id=o.revision_id;
   update app.evidence_index set project_id=project,scope=case when mode='project' then 'project' when mode='company_common' then 'company_common' else 'unassigned' end where tenant_id=t and revision_id=o.revision_id and organization_span is not null;
  end loop;
  select result||jsonb_build_array(to_jsonb(f)) into result from app.site_folder_bindings f where f.tenant_id=t and f.id=b.id;
 end loop;
 return jsonb_build_object('ok',true,'bindings',result);
end $$;
revoke all on function app.correct_folder_bindings(uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant execute on function app.correct_folder_bindings(uuid,uuid,jsonb) to sigongnote_api;
