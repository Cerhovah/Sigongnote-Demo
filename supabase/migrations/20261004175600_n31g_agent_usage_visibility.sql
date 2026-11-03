-- Cancellation/revocation hides result payloads through RLS, not already-incurred costs.
-- Return only the current actor's aggregate, never cached model inputs/results.
create function app.agent_chain_usage(t uuid,root uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('krw',coalesce(sum(coalesce(u.actual_krw,u.reserved_krw)),0)::text,'calls',count(*)::integer)
 from app.product_ai_usage u
 where u.tenant_id=t and u.user_id=auth.uid() and u.channel='agent'
 and app.has_tenant_role(t,array['owner','operator','accountant'])
 and exists(select 1 from app.agent_runs r where r.tenant_id=t and r.user_id=auth.uid()
  and (r.id=root or r.root_run_id=root) and r.id::text=u.config->>'run_id');
$$;
revoke all on function app.agent_chain_usage(uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.agent_chain_usage(uuid,uuid) to sigongnote_api;
