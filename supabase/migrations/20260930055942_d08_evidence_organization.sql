-- D08 candidates only: no transaction identity, money approval or synthetic work order.
create table app.work_contexts (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),project_id uuid not null,
 label text not null check(length(label) between 2 and 100),bundle_id uuid,version bigint not null default 1,
 created_at timestamptz not null default now(),primary key(tenant_id,id),unique(tenant_id,project_id,label),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id),foreign key(tenant_id,bundle_id) references app.work_bundles(tenant_id,id)
);
create table app.evidence_organizations (
 tenant_id uuid not null,revision_id uuid not null,job_id uuid not null,source_root_id uuid not null,
 project_id uuid,context_id uuid,state text not null check(state in ('linked','conflict','unassigned','common')),
 categories text[] not null,project_candidates uuid[] not null,rule_version text not null,version bigint not null default 1,
 created_at timestamptz not null default now(),primary key(tenant_id,revision_id),
 foreign key(tenant_id,job_id) references app.parse_results(tenant_id,job_id) on delete cascade,
 foreign key(tenant_id,source_root_id) references app.evidence_blobs(tenant_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id),foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),
 check(categories <@ array['agreement','drawing_material','delivery_work','billing_payment','inspection_defect']),
 check((state='linked')=(project_id is not null))
);
create table app.fact_candidates (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),source_revision uuid not null,source_root_id uuid not null,
 span_id integer not null,locator text not null,source_text text not null,subject text not null,predicate text not null,
 value jsonb not null,unit text,effective_at timestamptz,recorded_at timestamptz not null default now(),
 assertion_kind text not null check(assertion_kind in ('observation','plan','request','proposal','acceptance','denial','condition','correction')),
 status text not null default 'candidate' check(status='candidate'),supersedes_id uuid,version bigint not null default 1,
 primary key(tenant_id,id),unique(tenant_id,source_revision,span_id),
 foreign key(tenant_id,source_revision) references app.evidence_organizations(tenant_id,revision_id) on delete cascade,
 foreign key(tenant_id,source_root_id) references app.evidence_blobs(tenant_id,id),foreign key(tenant_id,supersedes_id) references app.fact_candidates(tenant_id,id)
);
alter table app.evidence_index add column organization_span integer;
create unique index evidence_organization_span_once on app.evidence_index(tenant_id,revision_id,organization_span) where organization_span is not null;
create index fact_candidates_root on app.fact_candidates(tenant_id,source_root_id);
create index organizations_project on app.evidence_organizations(tenant_id,project_id,created_at desc);
do $$ declare t text;begin foreach t in array array['work_contexts','evidence_organizations','fact_candidates'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('revoke all on app.%I from public,anon,authenticated,service_role,sigongnote_worker',t);
 execute format('grant select on app.%I to sigongnote_api',t);
 execute format('create policy tenant_read on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''operator'',''accountant'']))',t);
end loop;end $$;

create table app.organization_attempts(tenant_id uuid not null,job_id uuid not null,attempts integer not null default 0,next_at timestamptz not null default now(),last_code text,primary key(tenant_id,job_id),foreign key(tenant_id,job_id) references app.parse_results(tenant_id,job_id) on delete cascade);
alter table app.organization_attempts enable row level security;revoke all on app.organization_attempts from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create function app.organization_failed(p_tenant uuid,p_job uuid) returns void language sql security definer set search_path='' as $$
 insert into app.organization_attempts(tenant_id,job_id,attempts,next_at,last_code) values(p_tenant,p_job,1,now()+interval '30 seconds','ORGANIZATION_RETRY') on conflict(tenant_id,job_id) do update set attempts=app.organization_attempts.attempts+1,next_at=now()+interval '30 seconds',last_code='ORGANIZATION_RETRY';
$$;
revoke all on function app.organization_failed(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_api;grant execute on function app.organization_failed(uuid,uuid) to sigongnote_worker;
create function app.organization_input(p_tenant uuid,p_job uuid,p_policy jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not app.parse_source_allowed(p_tenant,p_job,p_policy) then return null;end if;
 select jsonb_build_object('tenant_id',p.tenant_id,'job_id',p.job_id,'revision_id',p.revision_id,'output',p.output,'source_root_id',r.blob_id,
  'projects',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'display_name',pr.display_name) order by pr.id) from app.projects pr where pr.tenant_id=p_tenant),'[]'::jsonb),
  'bindings',coalesce((select jsonb_agg(distinct jsonb_build_object('project_id',f.project_id,'scope_mode',f.scope_mode)) from app.upload_intents i join app.site_folder_bindings f on f.tenant_id=i.tenant_id and f.source_id=i.source_id and f.source_generation=i.source_generation where i.tenant_id=p_tenant and i.completed_revision_id=p.revision_id and (select count(*) from app.site_folder_bindings f2 where f2.tenant_id=f.tenant_id and f2.source_id=f.source_id and f2.source_generation=f.source_generation)=1),'[]'::jsonb),
  'bundles',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'project_id',w.project_id,'display_name',b.display_name) order by b.id) from app.work_bundles b join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id where b.tenant_id=p_tenant),'[]'::jsonb)) into result
 from app.parse_results p join app.document_revisions r on r.tenant_id=p.tenant_id and r.id=p.revision_id
 where p.tenant_id=p_tenant and p.job_id=p_job;
 return result||jsonb_build_object('context_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;
create function app.next_organization_input(p_tenant uuid,p_policy jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record;result jsonb;
begin
 for r in select p.tenant_id,p.job_id from app.parse_results p
 where (p_tenant is null or p.tenant_id=p_tenant) and not exists(select 1 from app.evidence_organizations o where o.tenant_id=p.tenant_id and o.revision_id=p.revision_id)
 and not exists(select 1 from app.organization_attempts a where a.tenant_id=p.tenant_id and a.job_id=p.job_id and (a.attempts>=5 or a.next_at>now()))
 order by p.created_at,p.job_id limit 30 loop
 result:=app.organization_input(r.tenant_id,r.job_id,p_policy);if result is not null then return result;end if;
 insert into app.organization_attempts(tenant_id,job_id,next_at,last_code) values(r.tenant_id,r.job_id,now()+interval '1 hour','SOURCE_NOT_ALLOWED') on conflict(tenant_id,job_id) do update set next_at=excluded.next_at,last_code=excluded.last_code;
 end loop;return null;
end $$;
create function app.save_organization(p_tenant uuid,p_job uuid,p_hash text,p_proposal jsonb,p_policy jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;rev uuid;root_id uuid;project uuid;work_id uuid;f jsonb;s jsonb;tags text[];candidates uuid[];idx integer;bundle uuid;
begin
 ctx:=app.organization_input(p_tenant,p_job,p_policy);if ctx is null or ctx->>'context_hash'<>p_hash then return false;end if;
 rev:=(ctx->>'revision_id')::uuid;root_id:=(ctx->>'source_root_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':organize:'||rev::text,0));
 if exists(select 1 from app.evidence_organizations where tenant_id=p_tenant and revision_id=rev) then return true;end if;
 if p_proposal->>'version'<>'field-rules-v1' or jsonb_typeof(p_proposal->'facts')<>'array' or jsonb_array_length(p_proposal->'facts')>1000 then raise exception 'Invalid organization';end if;
 project:=(p_proposal->>'project_id')::uuid;bundle:=(p_proposal->>'bundle_id')::uuid;
 select coalesce(array_agg(value::uuid),'{}') into candidates from jsonb_array_elements_text(p_proposal->'project_candidates');
 if exists(select 1 from unnest(candidates) id where not exists(select 1 from app.projects p where p.tenant_id=p_tenant and p.id=id)) then raise exception 'Foreign candidate';end if;
 if project is not null and (not project=any(candidates) or cardinality(candidates)<>1) then raise exception 'Ambiguous project';end if;
 if bundle is not null and not exists(select 1 from app.work_bundles b join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id where b.tenant_id=p_tenant and b.id=bundle and w.project_id=project) then raise exception 'Foreign work';end if;
 if project is not null and p_proposal->>'work_label' is not null then
 insert into app.work_contexts(tenant_id,project_id,label,bundle_id) values(p_tenant,project,p_proposal->>'work_label',bundle) on conflict(tenant_id,project_id,label) do nothing;
 select id into work_id from app.work_contexts where tenant_id=p_tenant and project_id=project and label=p_proposal->>'work_label';end if;
 select coalesce(array_agg(value),'{}') into tags from jsonb_array_elements_text(p_proposal->'categories');
 insert into app.evidence_organizations(tenant_id,revision_id,job_id,source_root_id,project_id,context_id,state,categories,project_candidates,rule_version)
 values(p_tenant,rev,p_job,root_id,project,work_id,p_proposal->>'state',tags,candidates,p_proposal->>'version');
 for f in select value from jsonb_array_elements(p_proposal->'facts') loop
 idx:=(f->>'span_index')::integer;s:=ctx->'output'->'spans'->idx;
 if idx<0 or s is null or s->>'text' is distinct from f->>'text' or s->>'locator' is distinct from f->>'locator'
 or f->'value' is distinct from jsonb_build_object('kind','text','text',s->>'text') or f->>'predicate'<>'source_statement' then raise exception 'Source span mismatch';end if;
 insert into app.fact_candidates(tenant_id,source_revision,source_root_id,span_id,locator,source_text,subject,predicate,value,assertion_kind)
 values(p_tenant,rev,root_id,idx,s->>'locator',s->>'text',f->>'subject',f->>'predicate',f->'value',f->>'assertion_kind');
 if jsonb_array_length(f->'categories')>0 then
 insert into app.evidence_index(tenant_id,revision_id,project_id,scope,category,display_title,search_text,locator,source_kind,organization_span)
 values(p_tenant,rev,project,case when p_proposal->>'state'='common' then 'company_common' when project is null then 'unassigned' else 'project' end,f->'categories'->>0,left(s->>'text',180),s->>'text',jsonb_build_object('kind','parsed','position',jsonb_build_object('span',idx,'locator',s->>'locator')),'original',idx);
 end if;
 end loop;
 return true;
end $$;
revoke all on function app.organization_input(uuid,uuid,jsonb),app.next_organization_input(uuid,jsonb),app.save_organization(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant execute on function app.next_organization_input(uuid,jsonb),app.save_organization(uuid,uuid,text,jsonb,jsonb) to sigongnote_worker;

create function app.clean_organization_index() returns trigger language plpgsql security definer set search_path='' as $$ begin delete from app.evidence_index where tenant_id=old.tenant_id and revision_id=old.revision_id and organization_span is not null;return old;end $$;
revoke all on function app.clean_organization_index() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger organization_index_cleanup before delete on app.evidence_organizations for each row execute function app.clean_organization_index();
