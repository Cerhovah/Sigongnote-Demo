-- Multiple meanings from one immutable chunk; old source_statement rows remain intact.
alter table app.fact_candidates add column extraction_key text not null default 'source_statement';
alter table app.fact_candidates add column semantic jsonb;
alter table app.fact_candidates add column semantic_usage uuid;
alter table app.fact_candidates drop constraint fact_candidates_tenant_id_source_revision_span_id_key;
alter table app.fact_candidates add unique(tenant_id,source_revision,span_id,extraction_key);
create table app.semantic_promotions (
 tenant_id uuid not null,usage_id uuid not null,user_id uuid not null,revision_id uuid not null,context_hash text not null,
 status text not null check(status in ('stored','invalid')),candidate_count integer not null check(candidate_count between 0 and 100),
 schema_version text not null,reason text check(reason ~ '^[A-Z_]{1,80}$'),rejected_count integer not null default 0 check(rejected_count between 0 and 100),validator_version text not null default 'semantic-validator-v2',created_at timestamptz not null default now(),primary key(tenant_id,user_id,usage_id,validator_version),
 foreign key(tenant_id,user_id,usage_id) references app.product_ai_usage(tenant_id,user_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id) on delete cascade
);
alter table app.semantic_promotions enable row level security;
revoke all on app.semantic_promotions from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant select on app.semantic_promotions to sigongnote_api;
create policy source_read on app.semantic_promotions for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']) and app.revision_accessible(tenant_id,revision_id));
create function app.semantic_promotion_input(t uuid,u uuid,actor uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r app.product_ai_usage;chunks jsonb;identity jsonb;payload jsonb;
begin
 select * into r from app.product_ai_usage where tenant_id=t and id=u and user_id=actor and channel='semantic' and state='settled' and result is not null and not evidence_withdrawn;
 if not found or r.config->>'index_job' is null or not app.product_ai_scope_allowed(t,r.user_id,r.source_id,r.source_generation,r.revision_id,'semantic',r.config) or r.config->'policy' is distinct from policy then return null;end if;
 if not exists(select 1 from app.evidence_organizations where tenant_id=t and revision_id=r.revision_id) then return null;end if;
 if not exists(select 1 from app.evidence_chunk_indexes i where i.tenant_id=t and i.job_id=(r.config->>'index_job')::uuid and i.published
  and not exists(select 1 from app.evidence_chunk_indexes n where n.tenant_id=t and n.revision_id=i.revision_id and n.published and (n.created_at,n.job_id)>(i.created_at,i.job_id))) then return null;end if;
 identity:=app.entity_link_input(t,(r.config->>'index_job')::uuid,policy);if identity is null then return null;end if;
 select coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'contentHash',content_hash,'locator',locator,'text',text,'active',true) order by ordinal),'[]') into chunks
 from app.evidence_chunks where tenant_id=t and job_id=(r.config->>'index_job')::uuid and ordinal between (r.config->>'first_ordinal')::integer and (r.config->>'last_ordinal')::integer;
 if jsonb_array_length(chunks) not between 1 and 16 then return null;end if;
 payload:=jsonb_build_object('tenant',t,'usage',u,'user',actor,'revision',r.revision_id,'job',r.config->>'index_job','observedAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'model',r.config->>'model','prompt',r.config->>'prompt','output',r.result,'validator','semantic-validator-v2','chunks',chunks,'identity',identity);
 return payload||jsonb_build_object('context_hash',encode(sha256(convert_to(payload::text,'UTF8')),'hex'));
end $$;
create function app.next_semantic_promotion(t uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare row record;ctx jsonb;
begin
 for row in select u.tenant_id,u.id,u.user_id from app.product_ai_usage u where (t is null or u.tenant_id=t) and u.channel='semantic' and u.state='settled' and u.result is not null and not u.evidence_withdrawn and u.config->>'index_job' is not null
  and not exists(select 1 from app.evidence_retention_tasks e where e.tenant_id=u.tenant_id and e.revision_id=u.revision_id)
  and exists(select 1 from app.evidence_chunk_indexes i where i.tenant_id=u.tenant_id and i.job_id=(u.config->>'index_job')::uuid and i.published and not exists(select 1 from app.evidence_chunk_indexes newer where newer.tenant_id=i.tenant_id and newer.revision_id=i.revision_id and newer.published and (newer.created_at,newer.job_id)>(i.created_at,i.job_id)))
  and not exists(select 1 from app.semantic_promotions p where p.tenant_id=u.tenant_id and p.usage_id=u.id and p.user_id=u.user_id and p.validator_version='semantic-validator-v2') order by u.created_at,u.id loop
  ctx:=app.semantic_promotion_input(row.tenant_id,row.id,row.user_id,policy);if ctx is not null then return ctx;end if;
 end loop;return null;
end $$;
create function app.save_semantic_candidates(t uuid,u uuid,actor uuid,digest text,batch jsonb,policy jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare ctx jsonb;r uuid;c jsonb;e jsonb;s jsonb;root uuid;key text;assertion text;tags text[];
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||':semantic:'||u::text,0));
 ctx:=app.semantic_promotion_input(t,u,actor,policy);if ctx is null or ctx->>'context_hash'<>digest then return false;end if;
 if exists(select 1 from app.semantic_promotions where tenant_id=t and usage_id=u and user_id=actor and validator_version='semantic-validator-v2') then return true;end if;
 r:=(ctx->>'revision')::uuid;
 if batch is null or batch->>'invalidReason' is not null then insert into app.semantic_promotions(tenant_id,usage_id,user_id,revision_id,context_hash,status,candidate_count,schema_version,reason) values(t,u,actor,r,digest,'invalid',0,'semantic-candidates-v1',coalesce(batch->>'invalidReason','SCHEMA_INVALID'));return true;end if;
 if batch->>'schemaVersion' is distinct from 'semantic-candidates-v1' or batch->>'modelVersion' is distinct from ctx->>'model' or batch->>'promptVersion' is distinct from ctx->>'prompt' or jsonb_typeof(batch->'candidates') is distinct from 'array' or jsonb_array_length(batch->'candidates')>100 then raise exception 'Invalid semantic batch';end if;
 select source_root_id into root from app.evidence_organizations where tenant_id=t and revision_id=r;
 for c in select value from jsonb_array_elements(batch->'candidates') loop
  if c->>'tenantId' is distinct from t::text or c->>'revisionId' is distinct from r::text or c->>'status' is distinct from 'candidate_only' or jsonb_array_length(c->'evidence')<1 then raise exception 'Invalid semantic scope';end if;
  for e in select value from jsonb_array_elements(c->'evidence') loop
   select value into s from jsonb_array_elements(ctx->'chunks') where (value->>'ordinal')::integer=(e->>'ordinal')::integer;
   if s is null or e->>'indexJobId' is distinct from ctx->>'job' or e->>'contentHash' is distinct from s->>'contentHash' or e->>'locator' is distinct from s->>'locator' then raise exception 'Invalid semantic evidence';end if;
  end loop;
  e:=c->'evidence'->0;key:=u::text||':'||(c->>'key');
  assertion:=case when c#>>'{assertion,polarity}'='negative' then 'denial' when c#>>'{assertion,modality}'='conditional' then 'condition' when c#>>'{assertion,modality}'='planned' then 'plan' when c->>'eventKind' in ('request','proposal','acceptance','correction') then c->>'eventKind' else 'observation' end;
  insert into app.fact_candidates(tenant_id,source_revision,source_root_id,span_id,locator,source_text,subject,predicate,value,unit,effective_at,assertion_kind,extraction_key,semantic,semantic_usage)
  values(t,r,root,(e->>'ordinal')::integer,e->>'locator',e->>'quote',coalesce(c#>>'{subject,mention}','unresolved'),c->>'predicate',case when c->'quantity'<>'null'::jsonb then c->'quantity' else c->'amount' end,c#>>'{quantity,unitCode}',(c->>'effectiveAt')::timestamptz,assertion,key,c,u)
  on conflict(tenant_id,source_revision,span_id,extraction_key) do nothing;
 end loop;
 select coalesce(array_agg(distinct tag.value),'{}') into tags from jsonb_array_elements(batch->'candidates') entry,jsonb_array_elements_text(entry.value->'categories') tag;
 if not tags <@ array['agreement','drawing_material','delivery_work','billing_payment','inspection_defect'] then raise exception 'Invalid semantic categories';end if;
 update app.evidence_organizations set categories=array(select distinct unnest(categories||tags)),version=version+1 where tenant_id=t and revision_id=r;
 insert into app.semantic_promotions(tenant_id,usage_id,user_id,revision_id,context_hash,status,candidate_count,schema_version,rejected_count) values(t,u,actor,r,digest,'stored',jsonb_array_length(batch->'candidates'),'semantic-candidates-v1',coalesce(jsonb_array_length(batch->'rejected'),0));
 return true;
end $$;
revoke all on function app.semantic_promotion_input(uuid,uuid,uuid,jsonb),app.next_semantic_promotion(uuid,jsonb),app.save_semantic_candidates(uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant execute on function app.next_semantic_promotion(uuid,jsonb),app.save_semantic_candidates(uuid,uuid,uuid,text,jsonb,jsonb) to sigongnote_worker;

-- Changing the semantic schema does not silently buy another pass over already submitted chunks.
-- Model work is derived from published document jobs; the usage row is its durable call fence.
-- No parallel document or financial ledger. One configured model/prompt snapshot at a time.
create or replace function app.next_semantic_input(p_policy jsonb,p_model_key text,p_tenant uuid default null,p_headroom bigint default 1,p_deferred uuid[] default '{}')
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
    and u.config->>'index_job'=r.job_id::text and u.state<>'reserved'
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

