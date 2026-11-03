-- Model work is derived from published document jobs; the usage row is its durable call fence.
-- No parallel document or financial ledger. One configured model/prompt snapshot at a time.
create function app.next_semantic_input(p_policy jsonb,p_model_key text,p_tenant uuid default null,p_headroom bigint default 1,p_deferred uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; s record; first_ordinal integer; spans jsonb; daily bigint; monthly bigint;
begin
 if p_headroom is null or p_headroom not between 1 and 10000 or p_model_key !~ '^[a-f0-9]{64}$' or p_model_key is null or p_policy->'external_processing' is distinct from 'true'::jsonb
  or p_policy->>'provider' not in ('openai','anthropic') then return null; end if;
 for r in select i.*,j.created_at job_created,rev.declared_mime from app.evidence_chunk_indexes i
  join app.jobs j on j.tenant_id=i.tenant_id and j.id=i.job_id
  join app.document_revisions rev on rev.tenant_id=i.tenant_id and rev.id=i.revision_id
  where i.published and i.chunk_count>0 and j.state='succeeded' and not(j.id=any(coalesce(p_deferred,'{}'))) and (p_tenant is null or i.tenant_id=p_tenant)
   and not exists(select 1 from app.evidence_retention_tasks withdrawn where withdrawn.tenant_id=i.tenant_id and withdrawn.revision_id=i.revision_id)
   and not exists(select 1 from app.evidence_chunk_indexes newer where newer.tenant_id=i.tenant_id and newer.revision_id=i.revision_id and newer.published and (newer.created_at,newer.job_id)>(i.created_at,i.job_id))
  order by j.created_at desc,i.tenant_id,i.job_id
 loop
  if not app.parse_source_allowed(r.tenant_id,r.job_id,p_policy) then continue; end if;
  select c.id,c.user_id,c.generation,c.scope_fingerprint into s from app.upload_intents u join app.capture_sources c on c.tenant_id=u.tenant_id and c.id=u.source_id
   where u.tenant_id=r.tenant_id and u.completed_revision_id=r.revision_id and u.source_generation=c.generation
    and c.processing_policy=p_policy and c.external_ai_consent order by c.created_at,c.id limit 1;
  if not found or not app.product_ai_scope_allowed(r.tenant_id,s.user_id,s.id,s.generation,r.revision_id,'semantic',jsonb_build_object('policy',p_policy,'policy_provider',p_policy->>'provider','provider',p_policy->>'provider')) then continue; end if;
  -- A paused account must not prevent other accounts' independent work.
  select coalesce(sum(case when coalesce(submitted_at,created_at)>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0),
   coalesce(sum(case when coalesce(submitted_at,created_at)>=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0)
  into daily,monthly from app.product_ai_usage where user_id=s.user_id and state<>'released';
  if daily+p_headroom>10000 or monthly+p_headroom>50000 then continue;end if;
  select min(e.ordinal) into first_ordinal from app.evidence_chunks e where e.tenant_id=r.tenant_id and e.job_id=r.job_id and not exists(
   select 1 from app.product_ai_usage u where u.tenant_id=r.tenant_id and u.user_id=s.user_id and u.source_id=s.id and u.source_generation=s.generation
    and u.config->>'index_job'=r.job_id::text and u.config->>'model_key'=p_model_key and u.state<>'reserved'
    and e.ordinal between (u.config->>'first_ordinal')::integer and (u.config->>'last_ordinal')::integer);
  if first_ordinal is null then continue; end if;
  -- A maximum of eight 1000-character chunks fits the 32KiB provider envelope.
  select jsonb_agg(jsonb_build_object('ordinal',c.ordinal,'text',c.text,'locator',c.locator,'position',c.position,'content_hash',c.content_hash) order by c.ordinal) into spans
   from (select * from app.evidence_chunks e where e.tenant_id=r.tenant_id and e.job_id=r.job_id and e.ordinal>=first_ordinal order by e.ordinal limit 8) c;
  return jsonb_build_object('tenant',r.tenant_id,'user',s.user_id,'source',s.id,'generation',s.generation,'revision',r.revision_id,
   'source_hash',r.source_hash,'parser',r.parser_version,'scope',s.scope_fingerprint,'index_job',r.job_id,'mime',r.declared_mime,'chunks',spans);
 end loop;
 return null;
end $$;
revoke all on function app.next_semantic_input(jsonb,text,uuid,bigint,uuid[]) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.next_semantic_input(jsonb,text,uuid,bigint,uuid[]) to sigongnote_worker;

create function app.withdraw_product_ai_evidence() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update app.product_ai_usage set result=null,evidence_withdrawn=true where tenant_id=new.tenant_id and revision_id=new.revision_id;
 return new;
end $$;
revoke all on function app.withdraw_product_ai_evidence() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger product_ai_evidence_withdrawal after insert or update on app.evidence_retention_tasks
 for each row execute function app.withdraw_product_ai_evidence();
