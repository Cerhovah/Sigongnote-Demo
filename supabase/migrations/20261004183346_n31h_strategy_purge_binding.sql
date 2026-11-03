create or replace function app.purge_strategies(t uuid default null,cid uuid default null) returns bigint language plpgsql security definer set search_path='' as $$
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
  where invalid_reason is distinct from 'source_unavailable' and exists(select 1 from jsonb_array_elements(v.members||v.shadow_members) m join app.strategy_cases sc on sc.tenant_id=v.tenant_id and sc.id=(m->>'id')::uuid where sc.state='deleted') returning tenant_id,id)
 update app.strategy_evaluations e set prediction=null from invalid v where e.tenant_id=v.tenant_id and e.version_id=v.id;
 return erased;
end $$;
