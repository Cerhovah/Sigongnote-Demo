-- Contract scopes and typed conditions reuse explicit owner grants; no new ledger.
alter table app.owner_policies drop constraint owner_policies_scope_type_check;
alter table app.owner_policies add constraint owner_policies_scope_type_check check(scope_type in ('work','project','contract','party','company'));
alter table app.decision_examples drop constraint decision_examples_scope_type_check;
alter table app.decision_examples add constraint decision_examples_scope_type_check check(scope_type in ('once','work','project','contract','party','company'));
alter table app.work_decision_cases drop constraint work_decision_cases_policy_hold_reason_check;
alter table app.work_decision_cases add constraint work_decision_cases_policy_hold_reason_check check(policy_hold_reason in ('conflict','limit','retry','qualification','source','candidate'));
create function app.same_work_condition(c1 text,prompt1 text,p1 jsonb,c2 text,prompt2 text,p2 jsonb) returns boolean language sql immutable set search_path='' as $$
 select c1=c2 and app.normalized_work_effects(p1->'effects')=app.normalized_work_effects(p2->'effects') and
 case when p1?'semantic_basis' and p2?'semantic_basis' then p1->>'semantic_subject' is not null and p1->>'semantic_subject'=p2->>'semantic_subject'
 when not(p1?'semantic_basis') and not(p2?'semantic_basis') then prompt1=prompt2 else false end
$$;
revoke all on function app.same_work_condition(text,text,jsonb,text,text,jsonb) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.same_work_condition(text,text,jsonb,text,text,jsonb) to sigongnote_api;

create or replace function app.guard_policy_decision() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
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
 if (p.scope_type='contract' and not exists(select 1 from app.work_contexts w join app.work_bundles b on b.tenant_id=w.tenant_id and b.id=w.bundle_id join app.work_orders o on o.tenant_id=b.tenant_id and o.id=b.work_order_id and o.project_id=c.project_id where w.tenant_id=c.tenant_id and w.id=c.context_id and b.work_order_id=p.scope_id)) or (p.scope_type='work' and p.scope_id<>c.context_id) or (p.scope_type='project' and p.scope_id<>c.project_id) then raise exception 'policy outside work' using errcode='23514';end if;
 select x.* into original from app.work_decision_cases x join app.decisions d on d.tenant_id=x.tenant_id and d.target_ids[1]=x.id where d.tenant_id=p.tenant_id and d.id=p.example_decision_id;
 if c.proposal?'semantic_basis' and (p.semantic_qualification is null or p.semantic_qualification->>'approved_by' is distinct from p.grantor_user_id::text) then raise exception 'semantic type qualification required' using errcode='23514';end if;
 actual:=nullif(current_setting('app.executing_effects',true),'')::jsonb;
 if original.id is null or not app.same_work_condition(c.category,c.prompt,c.proposal,original.category,original.prompt,original.proposal) or app.normalized_work_effects(actual) is distinct from app.normalized_work_effects(p.effects) or not exists(select 1 from app.work_contexts w where w.tenant_id=c.tenant_id and w.id=c.context_id and w.label=p.work_label) then raise exception 'policy condition changed' using errcode='23514';end if;
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
create or replace function app.guard_owner_policy() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare claim uuid;begin
 claim:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
 if not app.has_tenant_role(new.tenant_id,array['owner']) or (new.revoked_at is null and new.grantor_user_id is distinct from claim) then raise exception 'current owner grant required' using errcode='23514';end if;
 if TG_OP='INSERT' then
  if new.version<>1 then raise exception 'initial policy version required' using errcode='23514';end if;
 else
  if old.revoked_at is not null or new.version<>old.version+1 or new.tenant_id<>old.tenant_id or new.id<>old.id or new.scope_type<>old.scope_type or new.scope_id is distinct from old.scope_id or new.condition_hash is distinct from old.condition_hash or new.example_decision_id is distinct from old.example_decision_id or new.allowed_effects<>old.allowed_effects then raise exception 'policy identity/version immutable' using errcode='23514';end if;
 end if;
 if new.effects is null or jsonb_typeof(new.effects)<>'array' or new.category is null or new.condition_hash is null or new.example_decision_id is null then raise exception 'explicit example required' using errcode='23514';end if;
 if new.scope_type='contract' and not exists(select 1 from app.work_orders where tenant_id=new.tenant_id and id=new.scope_id) then raise exception 'contract outside company' using errcode='23514';end if;
 if new.semantic_qualification is not null and (new.semantic_qualification->>'approved_by' is distinct from new.grantor_user_id::text or jsonb_typeof(new.semantic_qualification->'sample_decisions') is distinct from 'array' or jsonb_array_length(new.semantic_qualification->'sample_decisions')<1) then raise exception 'explicit qualification examples required' using errcode='23514';end if;
 return new;
end $$;
