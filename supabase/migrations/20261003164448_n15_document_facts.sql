-- Document candidates reuse current semantic provenance and consent, then relink live identities in TS.
create function app.document_facts(t uuid,c uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if not app.has_tenant_role(t,array['owner','accountant']) then return null;end if;
 select coalesce(jsonb_agg(v order by id),'[]'::jsonb) into rows from (
  select f.id,jsonb_build_object('id',f.id,'revision',f.source_revision,'semantic',f.semantic,'version',b.value->>'version','identity',b.value->'identity') v
  from app.fact_candidates f join app.evidence_organizations o on o.tenant_id=f.tenant_id and o.revision_id=f.source_revision
  join app.product_ai_usage u on u.tenant_id=f.tenant_id and u.id=f.semantic_usage
  cross join lateral(select app.business_fact_basis(t,f.id,c,u.config->'policy') value)b
  where f.tenant_id=t and o.context_id=c and f.semantic is not null and b.value is not null
  and not exists(select 1 from app.audio_corrections a where a.tenant_id=t and a.revision_id=f.source_revision and exists(select 1 from jsonb_array_elements(f.semantic->'evidence') e where e->>'locator'=a.locator))
  order by f.id limit 201
 )s;
 return jsonb_build_object('facts',rows,'partial',jsonb_array_length(rows)>200);
end $$;
revoke all on function app.document_facts(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.document_facts(uuid,uuid) to sigongnote_api;
