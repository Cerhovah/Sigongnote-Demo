create table app.strategy_cases(
 tenant_id uuid not null references app.tenants(id),id uuid not null default gen_random_uuid(),owner_id uuid not null references auth.users(id),consent_id uuid not null,
 scope text not null check(scope in ('search','tool_selection')),run_id uuid not null,sequence integer not null check(sequence between 1 and 8),context_id uuid not null,project_id uuid not null,
 instruction text not null,input jsonb not null,baseline jsonb not null,expected jsonb not null,relevant uuid[] not null,source_refs jsonb not null,
 state text not null default 'confirmed' check(state in ('confirmed','correction','deleted')),applied_version uuid,created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,id),unique(tenant_id,id,scope),foreign key(tenant_id,run_id) references app.agent_runs(tenant_id,id),foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 check(length(instruction)<=2000),check(octet_length(input::text)<=8192),check(octet_length(baseline::text)<=8192),check(octet_length(expected::text)<=8192),check(jsonb_typeof(source_refs)='array' and jsonb_array_length(source_refs)<=60),check(cardinality(relevant)<=30)
);
create table app.strategy_versions(
 tenant_id uuid not null references app.tenants(id),id uuid not null default gen_random_uuid(),scope text not null check(scope in ('search','tool_selection')),
 members jsonb not null,shadow_members jsonb not null default '[]',spec jsonb not null,metrics jsonb not null default '{}',fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),
 state text not null default 'evaluating' check(state in ('evaluating','awaiting_shadow','proposed','active','superseded','rejected','rolled_back')),
 invalid_reason text,approved_by uuid references auth.users(id),approved_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,id),unique(tenant_id,id,scope),unique(tenant_id,fingerprint),check(jsonb_typeof(members)='array' and jsonb_array_length(members) between 2 and 50),check(jsonb_typeof(shadow_members)='array'),check(octet_length(spec::text)<=65536)
);
create table app.strategy_heads(
 tenant_id uuid not null references app.tenants(id),scope text not null check(scope in ('search','tool_selection')),owner_id uuid not null references auth.users(id),active_id uuid,previous_id uuid,
 version integer not null default 1 check(version>0),delegated boolean not null default false,budget_hold_day text,
 primary key(tenant_id,scope),foreign key(tenant_id,active_id,scope) references app.strategy_versions(tenant_id,id,scope),foreign key(tenant_id,previous_id,scope) references app.strategy_versions(tenant_id,id,scope)
);
create table app.strategy_evaluations(
 tenant_id uuid not null references app.tenants(id),id uuid not null default gen_random_uuid(),version_id uuid not null,case_id uuid not null,
 phase text not null check(phase in ('test','shadow','promotion')),prediction jsonb,passed boolean not null,created_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,id),unique(tenant_id,version_id,case_id,phase),foreign key(tenant_id,version_id) references app.strategy_versions(tenant_id,id),foreign key(tenant_id,case_id) references app.strategy_cases(tenant_id,id),check(octet_length(prediction::text)<=16384)
);
create index strategy_case_scope on app.strategy_cases(tenant_id,scope,created_at);
create index strategy_daily on app.strategy_evaluations(tenant_id,created_at);
alter table app.agent_runs add column strategy_versions jsonb not null default '{}' check(jsonb_typeof(strategy_versions)='object' and octet_length(strategy_versions::text)<=200);
alter table app.strategy_cases enable row level security;
alter table app.strategy_versions enable row level security;
alter table app.strategy_heads enable row level security;
alter table app.strategy_evaluations enable row level security;
revoke all on app.strategy_cases,app.strategy_versions,app.strategy_heads,app.strategy_evaluations from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert on app.strategy_cases,app.strategy_evaluations to sigongnote_api;
grant select,insert,update on app.strategy_versions,app.strategy_heads to sigongnote_api;
create policy strategy_cases_owner on app.strategy_cases to sigongnote_api
 using(state<>'deleted' and created_at>now()-interval '90 days' and app.learning_scope_allowed(tenant_id,owner_id,consent_id,source_refs))
 with check(owner_id=auth.uid() and state<>'deleted' and app.learning_scope_allowed(tenant_id,owner_id,consent_id,source_refs));
create policy strategy_versions_owner on app.strategy_versions to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy strategy_heads_owner on app.strategy_heads to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy strategy_evaluations_owner on app.strategy_evaluations to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));

create function app.strategy_version_allowed(t uuid,v uuid) returns boolean language sql stable set search_path='' as $$
 select v is null or exists(select 1 from app.strategy_versions x where x.tenant_id=t and x.id=v and x.state in ('active','superseded')
 and not exists(select 1 from jsonb_array_elements(x.members||x.shadow_members) m where not exists(select 1 from app.strategy_cases c where c.tenant_id=t and c.id=(m->>'id')::uuid))
 and not exists(select 1 from app.strategy_cases c where c.tenant_id=t and c.applied_version=v and c.state='correction'));
$$;
revoke all on function app.strategy_version_allowed(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.strategy_version_allowed(uuid,uuid) to sigongnote_api;

-- Purpose/retention/source withdrawal scrub original requests, rules and predictions together.
create function app.purge_strategies(t uuid default null,cid uuid default null) returns bigint language plpgsql security definer set search_path='' as $$
declare c record;old_sub text;erased bigint:=0;
begin
 old_sub:=current_setting('request.jwt.claim.sub',true);
 if cid is not null and (t is null or not app.has_tenant_role(t,array['owner'])) then raise exception 'scope';end if;
 for c in select * from app.strategy_cases where state<>'deleted' and (t is null or tenant_id=t) and (cid is null or id=cid) loop
  perform set_config('request.jwt.claim.sub',c.owner_id::text,true);
  if cid is not null or c.created_at<now()-interval '90 days' or not app.learning_scope_allowed(c.tenant_id,c.owner_id,c.consent_id,c.source_refs) then
   update app.strategy_cases set state='deleted',instruction='',input='{}',baseline='{}',expected='{}',relevant='{}',source_refs='[]' where tenant_id=c.tenant_id and id=c.id;erased:=erased+1;
  end if;
 end loop;
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
 with invalid as(update app.strategy_versions v set state='rolled_back',invalid_reason='source_unavailable',spec='{}',metrics='{}'
  where invalid_reason is distinct from 'source_unavailable' and exists(select 1 from jsonb_array_elements(v.members||v.shadow_members) m join app.strategy_cases c on c.tenant_id=v.tenant_id and c.id=(m->>'id')::uuid where c.state='deleted') returning tenant_id,id)
 update app.strategy_evaluations e set prediction=null from invalid v where e.tenant_id=v.tenant_id and e.version_id=v.id;
 return erased;
end $$;
revoke all on function app.purge_strategies(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.purge_strategies(uuid,uuid) to sigongnote_api;
