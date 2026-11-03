-- D13: explicit reusable examples, bounded grants, policy history and aliases.
alter table app.owner_policies add column scope_type text not null default 'company' check(scope_type in ('work','project','party','company'));
alter table app.owner_policies add column scope_id uuid;
alter table app.owner_policies add column category text;
alter table app.owner_policies add column work_label text;
alter table app.owner_policies add column condition_hash text;
alter table app.owner_policies add column effects jsonb;
alter table app.owner_policies add column example_decision_id uuid;
alter table app.owner_policies add foreign key(tenant_id,example_decision_id) references app.decisions(tenant_id,id);
alter table app.owner_policies add constraint owner_policy_scope check((scope_type='company')=(scope_id is null));
create table app.decision_examples (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),decision_id uuid not null,
 scope_type text not null check(scope_type in ('once','work','project','party','company')),
 proposal jsonb not null,answer jsonb not null,result jsonb not null,created_at timestamptz not null default now(),
 primary key(tenant_id,id),foreign key(tenant_id,decision_id) references app.decisions(tenant_id,id)
);
create table app.owner_policy_versions (
 tenant_id uuid not null,policy_id uuid not null,version integer not null,snapshot jsonb not null,
 changed_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 primary key(tenant_id,policy_id,version),foreign key(tenant_id,policy_id) references app.owner_policies(tenant_id,id)
);
create table app.entity_aliases (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),project_id uuid not null,
 alias text not null check(length(btrim(alias)) between 2 and 100),version integer not null default 1,
 actor_id uuid not null references auth.users(id),revoked_at timestamptz,created_at timestamptz not null default now(),
 primary key(tenant_id,id),foreign key(tenant_id,project_id) references app.projects(tenant_id,id)
);
create unique index active_alias_once on app.entity_aliases(tenant_id,lower(alias)) where revoked_at is null;
do $$ declare t text;begin foreach t in array array['decision_examples','owner_policy_versions','entity_aliases'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('revoke all on app.%I from public,anon,authenticated,service_role,sigongnote_worker',t);
 execute format('grant select,insert on app.%I to sigongnote_api',t);
 execute format('create policy tenant_read on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''operator'',''accountant'']))',t);
 execute format('create policy owner_insert on app.%I for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array[''owner'']))',t);
end loop;end $$;
grant update(revoked_at,version) on app.entity_aliases to sigongnote_api;
create policy owner_update on app.entity_aliases for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
-- API-owned scheduler needs only the identities of explicit, unexpired grants. No original data is returned.
create function app.owner_policy_workspaces() returns table(tenant_id uuid,grantor_user_id uuid)
language sql security definer set search_path='' as $$
 select distinct p.tenant_id,p.grantor_user_id from app.owner_policies p join app.memberships m on m.tenant_id=p.tenant_id and m.user_id=p.grantor_user_id where p.revoked_at is null and p.valid_until>now() and p.effects is not null and m.active and m.revoked_at is null and m.role='owner' limit 100
$$;
revoke all on function app.owner_policy_workspaces() from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.owner_policy_workspaces() to sigongnote_api;
create function app.normalized_work_effects(effects jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(case when e->>'kind'='charge_adjustment' then e-'charge_id'-'version' else e end order by n),'[]') from jsonb_array_elements(effects) with ordinality as x(e,n)
$$;
revoke all on function app.normalized_work_effects(jsonb) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.normalized_work_effects(jsonb) to sigongnote_api;
create function app.guard_policy_decision() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare p app.owner_policies%rowtype; c app.work_decision_cases%rowtype; claim uuid; effect jsonb; permitted text; original app.work_decision_cases%rowtype; actual jsonb; party uuid;
begin
 if coalesce(current_setting('app.executing_policy',true),'')='' then
  if new.actor_kind<>'human' then raise exception 'explicit executor required' using errcode='23514';end if;return new;
 end if;
 claim:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
 select * into p from app.owner_policies where tenant_id=new.tenant_id and id=current_setting('app.executing_policy')::uuid for share;
 select * into c from app.work_decision_cases where tenant_id=new.tenant_id and id=current_setting('app.executing_issue')::uuid;
 if p.id is null or c.id is null or p.grantor_user_id is distinct from claim or p.revoked_at is not null or p.valid_until<=now() or p.version::text<>current_setting('app.executing_policy_version') or not app.has_tenant_role(new.tenant_id,array['owner']) or p.category<>c.category or new.scope not in ('exception_resolution','charge_adjustment') then raise exception 'policy no longer authorizes execution' using errcode='23514';end if;
 perform 1 from app.memberships where tenant_id=new.tenant_id and user_id=claim and active and revoked_at is null and role='owner' for share;
 if not found then raise exception 'grantor no longer active' using errcode='23514';end if;
 if (p.scope_type='work' and p.scope_id<>c.context_id) or (p.scope_type='project' and p.scope_id<>c.project_id) then raise exception 'policy outside work' using errcode='23514';end if;
 select x.* into original from app.work_decision_cases x join app.decisions d on d.tenant_id=x.tenant_id and d.target_ids[1]=x.id where d.tenant_id=p.tenant_id and d.id=p.example_decision_id;
 actual:=nullif(current_setting('app.executing_effects',true),'')::jsonb;
 if original.id is null or c.prompt is distinct from original.prompt or app.normalized_work_effects(c.proposal->'effects') is distinct from app.normalized_work_effects(original.proposal->'effects') or app.normalized_work_effects(actual) is distinct from app.normalized_work_effects(p.effects) or not exists(select 1 from app.work_contexts w where w.tenant_id=c.tenant_id and w.id=c.context_id and w.label=p.work_label) then raise exception 'policy condition changed' using errcode='23514';end if;
 if p.scope_type='party' then
  select r.payload->>'partyId' into party from app.charge_cases cc join app.charge_revisions r on r.tenant_id=cc.tenant_id and r.id=cc.current_revision_id where cc.tenant_id=c.tenant_id and cc.id=(select (v->>'charge_id')::uuid from jsonb_array_elements(c.proposal->'effects') v where v->>'kind'='charge_adjustment');
  if party is distinct from p.scope_id then raise exception 'policy outside party' using errcode='23514';end if;
 end if;
 if (select coalesce(jsonb_agg(v order by v::text),'[]') from jsonb_array_elements(app.normalized_work_effects(actual)) v where v->>'kind' in ('charge_adjustment','liability')) is distinct from (select coalesce(jsonb_agg(v order by v::text),'[]') from jsonb_array_elements(app.normalized_work_effects(c.proposal->'effects')) v where v->>'kind' in ('charge_adjustment','liability')) then raise exception 'policy cannot change observed cost or burden' using errcode='23514';end if;
 for effect in select value from jsonb_array_elements(actual) loop
  permitted:=effect->>'kind';if not permitted=any(p.allowed_effects) or (permitted='charge_adjustment' and (effect->>'amount_minor')::numeric>p.max_amount_minor) then raise exception 'policy effect outside grant' using errcode='23514';end if;
 end loop;
 new.actor_kind:='system';new.actor_id:=null;new.execution_principal:='owner-policy-v1';new.grantor_user_id:=claim;new.policy_id:=p.id;new.policy_version:=p.version;return new;
end $$;
revoke all on function app.guard_policy_decision() from public,anon,authenticated,service_role,sigongnote_worker,sigongnote_api;
create trigger decisions_policy_executor before insert on app.decisions for each row execute function app.guard_policy_decision();
drop policy decisions_insert on app.decisions;
create policy decisions_insert on app.decisions for insert to sigongnote_api with check(
 app.has_tenant_role(tenant_id,array['owner','operator']) and ((actor_kind='human' and actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid) or (actor_kind='system' and grantor_user_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid and execution_principal='owner-policy-v1')));

-- Only the current owner can grant; every edit advances the version and is append-only audited.
create function app.guard_owner_policy() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare claim uuid;begin
 claim:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
 if not app.has_tenant_role(new.tenant_id,array['owner']) or (new.revoked_at is null and new.grantor_user_id is distinct from claim) then raise exception 'current owner grant required' using errcode='23514';end if;
 if TG_OP='INSERT' then
  if new.version<>1 then raise exception 'initial policy version required' using errcode='23514';end if;
 else
  if old.revoked_at is not null or new.version<>old.version+1 or new.tenant_id<>old.tenant_id or new.id<>old.id or new.scope_type<>old.scope_type or new.scope_id is distinct from old.scope_id or new.condition_hash is distinct from old.condition_hash or new.example_decision_id is distinct from old.example_decision_id or new.allowed_effects<>old.allowed_effects then raise exception 'policy identity/version immutable' using errcode='23514';end if;
 end if;
 if new.effects is null or jsonb_typeof(new.effects)<>'array' or new.category is null or new.condition_hash is null or new.example_decision_id is null then raise exception 'explicit example required' using errcode='23514';end if;
 return new;
end $$;
revoke all on function app.guard_owner_policy() from public,anon,authenticated,service_role,sigongnote_worker,sigongnote_api;
create trigger owner_policy_guard before insert or update on app.owner_policies for each row execute function app.guard_owner_policy();
create function app.snapshot_owner_policy() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
begin insert into app.owner_policy_versions(tenant_id,policy_id,version,snapshot,changed_by) values(new.tenant_id,new.id,new.version,to_jsonb(new),nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);return new;end $$;
revoke all on function app.snapshot_owner_policy() from public,anon,authenticated,service_role,sigongnote_worker,sigongnote_api;
create trigger owner_policy_snapshot after insert or update on app.owner_policies for each row execute function app.snapshot_owner_policy();

-- Rotate eligible pending questions, including temporarily failing ones, without starving newer work.
alter table app.work_decision_cases add column last_policy_attempt_at timestamptz;
grant update(last_policy_attempt_at) on app.work_decision_cases to sigongnote_api;
create policy owner_policy_attempt on app.work_decision_cases for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
alter table app.work_decision_cases add column policy_hold_reason text check(policy_hold_reason in ('conflict','limit','retry'));
grant update(policy_hold_reason) on app.work_decision_cases to sigongnote_api;
