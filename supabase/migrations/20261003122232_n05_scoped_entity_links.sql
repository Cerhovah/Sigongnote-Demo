-- Missing directory identities only; projects/work orders/bundles keep their existing IDs.
create table app.entity_objects (
 tenant_id uuid not null references app.tenants(id),id uuid not null default gen_random_uuid(),
 kind text not null check(kind in ('party','item_type','item_instance')),display_name text not null check(length(btrim(display_name)) between 1 and 180),
 project_id uuid,contract_id uuid,party_id uuid,role text check(length(role) between 1 and 80),item_type_id uuid,
 version bigint not null default 1,primary key(tenant_id,id),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 foreign key(tenant_id,contract_id) references app.work_orders(tenant_id,id),
 foreign key(tenant_id,party_id) references app.entity_objects(tenant_id,id),
 foreign key(tenant_id,item_type_id) references app.entity_objects(tenant_id,id),
 check((kind='item_instance')=(item_type_id is not null))
);
create view app.entity_catalog with(security_invoker=true) as
 select tenant_id,id,'project'::text kind,display_name,null::uuid project_id,null::uuid contract_id,null::uuid party_id,null::text role,null::uuid item_type_id from app.projects
 union all select tenant_id,id,'contract',display_name,project_id,null,null,null,null from app.work_orders
 union all select b.tenant_id,b.id,'bundle',b.display_name,w.project_id,b.work_order_id,null,null,null from app.work_bundles b join app.work_orders w on w.tenant_id=b.tenant_id and w.id=b.work_order_id
 union all select tenant_id,id,kind,display_name,project_id,contract_id,party_id,role,item_type_id from app.entity_objects;
revoke all on app.entity_catalog from public,anon,authenticated,service_role,sigongnote_worker;
grant select on app.entity_catalog to sigongnote_api;

-- Extend the existing owner-confirmed alias store; old aliases remain readable.
alter table app.entity_aliases alter column project_id drop not null;
alter table app.entity_aliases add column target_kind text not null default 'project' check(target_kind in ('project','contract','bundle','party','item_type','item_instance'));
alter table app.entity_aliases add column target_id uuid;
alter table app.entity_aliases add column scope text not null default 'company' check(scope in ('company','project','contract','party'));
alter table app.entity_aliases add column scope_id uuid;
alter table app.entity_aliases add column role text check(length(role) between 1 and 80);
alter table app.entity_aliases add column valid_from timestamptz;
alter table app.entity_aliases add column valid_until timestamptz;
alter table app.entity_aliases add column status text not null default 'active' check(status in ('active','conflict','retired'));
alter table app.entity_aliases add column evidence_revision uuid;
alter table app.entity_aliases add column evidence_locator text;
alter table app.entity_aliases add foreign key(tenant_id,evidence_revision) references app.document_revisions(tenant_id,id);
alter table app.entity_aliases add check(valid_from is null or valid_until is null or valid_from<valid_until);
alter table app.entity_aliases add check(evidence_revision is null or (target_id is not null and scope_id is not null and length(evidence_locator) between 1 and 1000));
drop index app.active_alias_once;
create unique index active_alias_once on app.entity_aliases(tenant_id,lower(alias)) where revoked_at is null and evidence_revision is null;
create index entity_alias_target on app.entity_aliases(tenant_id,target_kind,target_id);
create table app.entity_link_runs (
 tenant_id uuid not null,revision_id uuid not null,job_id uuid not null,context_hash text not null,
 result jsonb not null check(octet_length(result::text)<=2000000),version bigint not null default 1,updated_at timestamptz not null default now(),
 primary key(tenant_id,revision_id),foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id),
 foreign key(tenant_id,job_id) references app.parse_results(tenant_id,job_id) on delete cascade
);
do $$ declare t text;begin foreach t in array array['entity_objects','entity_link_runs'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('revoke all on app.%I from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker',t);
 execute format('grant select on app.%I to sigongnote_api',t);
 execute format('create policy tenant_read on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''operator'',''accountant'']))',t);
end loop;end $$;
grant insert,update on app.entity_objects,app.entity_aliases to sigongnote_api;
create policy entity_objects_write on app.entity_objects for all to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator'])) with check(app.has_tenant_role(tenant_id,array['owner','operator']));
create policy entity_aliases_write on app.entity_aliases for all to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator']) and app.revision_accessible(tenant_id,evidence_revision)) with check(app.has_tenant_role(tenant_id,array['owner','operator']) and app.revision_accessible(tenant_id,evidence_revision));
create policy alias_source on app.entity_aliases as restrictive for all to sigongnote_api using(evidence_revision is null or app.revision_accessible(tenant_id,evidence_revision)) with check(evidence_revision is null or app.revision_accessible(tenant_id,evidence_revision));
-- Cached aliases must be rechecked against current consent and directory content.
revoke select on app.entity_link_runs from sigongnote_api;

create function app.entity_link_input(t uuid,j uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;catalog jsonb;aliases jsonb;spans jsonb;result jsonb;
begin
 ctx:=app.organization_input(t,j,policy);if ctx is null or exists(select 1 from app.evidence_retention_tasks where tenant_id=t and revision_id=(ctx->>'revision_id')::uuid) then return null;end if;
 select coalesce(jsonb_agg(to_jsonb(c) order by c.kind,c.id),'[]') into catalog from (select * from app.entity_catalog where tenant_id=t order by kind,id limit 20001)c;
 select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('evidence_text',e.text) order by a.id),'[]') into aliases
 from (select a.*,a.alias alias_text from app.entity_aliases a where tenant_id=t and status<>'retired' and revoked_at is null and evidence_revision is not null and not exists(select 1 from app.evidence_retention_tasks e where e.tenant_id=t and e.revision_id=a.evidence_revision)
  and exists(select 1 from app.parse_results p where p.tenant_id=t and p.revision_id=a.evidence_revision and app.parse_source_allowed(t,p.job_id,policy)) order by id limit 20001)a
 join lateral(select s.text from app.revision_search_spans(t,a.evidence_revision) s where s.locator=a.evidence_locator limit 1)e on true;
 -- Use the complete N02 index. Only source segments containing directory clues travel to TS.
 select coalesce(jsonb_agg(jsonb_build_object('text',s.text,'locator',s.locator) order by s.locator,s.text),'[]') into spans
 from (select text,locator from app.revision_search_spans(t,(ctx->>'revision_id')::uuid) s where
  exists(select 1 from jsonb_array_elements(catalog)c where position(lower(c->>'display_name') in lower(s.text))>0)
  or exists(select 1 from jsonb_array_elements(aliases)a where position(lower(a->>'alias_text') in lower(s.text))>0)
  order by locator,text limit 1001)s;
 result:=ctx||jsonb_build_object('catalog',catalog,'aliases',aliases,'identity_spans',spans);
 return result||jsonb_build_object('context_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;
create function app.next_entity_link_input(t uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p record;v jsonb;
begin
 for p in select r.tenant_id,r.job_id from app.parse_results r where (t is null or r.tenant_id=t)
  and app.parse_source_allowed(r.tenant_id,r.job_id,policy) and not exists(select 1 from app.evidence_retention_tasks e where e.tenant_id=r.tenant_id and e.revision_id=r.revision_id)
  and not exists(select 1 from app.entity_link_runs l where l.tenant_id=r.tenant_id and l.revision_id=r.revision_id and l.updated_at>now()-interval '5 minutes')
  order by coalesce((select updated_at from app.entity_link_runs l where l.tenant_id=r.tenant_id and l.revision_id=r.revision_id),'-infinity'::timestamptz),r.created_at,r.job_id limit 1 loop
  v:=app.entity_link_input(p.tenant_id,p.job_id,policy);if v is null then continue;end if;
  if exists(select 1 from app.entity_link_runs l where l.tenant_id=p.tenant_id and l.revision_id=(v->>'revision_id')::uuid and l.context_hash=v->>'context_hash') then
   update app.entity_link_runs set updated_at=now() where tenant_id=p.tenant_id and revision_id=(v->>'revision_id')::uuid;
   continue;
  end if;
  return v;
 end loop;return null;
end $$;
create function app.save_entity_links(t uuid,j uuid,digest text,result jsonb,policy jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare ctx jsonb;rev uuid;link jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||':entity:'||j::text,0));
 ctx:=app.entity_link_input(t,j,policy);if ctx is null or ctx->>'context_hash'<>digest then return false;end if;
 rev:=(ctx->>'revision_id')::uuid;
 if result->>'version'<>'entity-links-v1' or result->>'revisionId'<>rev::text or jsonb_typeof(result->'links')<>'array' then raise exception 'Invalid identity result';end if;
 for link in select value from jsonb_array_elements(result->'links') loop
  if link->>'status'='linked' and not exists(select 1 from app.entity_catalog c where c.tenant_id=t and c.kind=link->>'targetKind' and c.id::text=link->>'targetId') then raise exception 'Foreign identity';end if;
 end loop;
 insert into app.entity_link_runs(tenant_id,revision_id,job_id,context_hash,result) values(t,rev,j,digest,result)
 on conflict(tenant_id,revision_id) do update set job_id=excluded.job_id,context_hash=excluded.context_hash,result=excluded.result,
 version=app.entity_link_runs.version+case when app.entity_link_runs.context_hash<>excluded.context_hash then 1 else 0 end,updated_at=now();
 return true;
end $$;
revoke all on function app.entity_link_input(uuid,uuid,jsonb),app.next_entity_link_input(uuid,jsonb),app.save_entity_links(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant execute on function app.next_entity_link_input(uuid,jsonb),app.save_entity_links(uuid,uuid,text,jsonb,jsonb) to sigongnote_worker;
grant execute on function app.entity_link_input(uuid,uuid,jsonb) to sigongnote_worker;

create function app.read_entity_links(t uuid,r uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare cached app.entity_link_runs;ctx jsonb;
begin
 if not app.has_tenant_role(t,array['owner','operator','accountant']) or not app.revision_accessible(t,r) then return null;end if;
 select * into cached from app.entity_link_runs where tenant_id=t and revision_id=r;
 if not found then return null;end if;
 ctx:=app.entity_link_input(t,cached.job_id,policy);
 if ctx is null or ctx->>'context_hash'<>cached.context_hash then return null;end if;
 return cached.result||jsonb_build_object('cacheVersion',cached.version);
end $$;
revoke all on function app.read_entity_links(uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.read_entity_links(uuid,uuid,jsonb) to sigongnote_api;
