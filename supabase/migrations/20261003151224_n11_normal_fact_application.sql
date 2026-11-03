-- Qualifications are explicit owner decisions, separate from model confidence.
alter table app.owner_policies add column semantic_qualification jsonb;
alter table app.work_decision_cases add column automatic_only boolean not null default false;
create function app.operational_facts(t uuid,c uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not app.has_tenant_role(t,array['owner','operator','accountant']) then return null;end if;
 if not exists(select 1 from app.work_contexts where tenant_id=t and id=c) then return null;end if;
 select coalesce(jsonb_agg(v order by id),'[]'::jsonb) into result from (
 select f.id,jsonb_build_object('id',f.id,'revision',f.source_revision,'organization_version',o.version,'context_id',o.context_id,'project_id',o.project_id,'semantic',f.semantic,'version',b.value->>'version','transaction_key',b.value->>'transactionKey') v
 from app.fact_candidates f join app.evidence_organizations o on o.tenant_id=f.tenant_id and o.revision_id=f.source_revision
 cross join lateral(select app.business_fact_basis(t,f.id,c,policy) value)b
 where f.tenant_id=t and o.context_id=c and f.semantic is not null and b.value is not null
 and not exists(select 1 from app.audio_corrections a where a.tenant_id=t and a.revision_id=f.source_revision and exists(select 1 from jsonb_array_elements(f.semantic->'evidence') e where e->>'locator'=a.locator))
 order by f.id limit 201)s;
 return jsonb_build_object('facts',result,'partial',jsonb_array_length(result)>200);
end $$;
revoke all on function app.operational_facts(uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.operational_facts(uuid,uuid,jsonb) to sigongnote_api;
