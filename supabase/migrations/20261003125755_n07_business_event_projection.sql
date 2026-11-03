-- N07 keeps confirmed state and financial ledgers intact. Journal writes are worker-only adapters.
alter table app.work_projections add column observed_state jsonb not null default '{}';
alter table app.work_projections add column observed_version bigint not null default 0;
alter table app.work_projections add column event_watermark bigint not null default 0;
alter table app.work_projections add column observed_hash text;
alter table app.work_projections add column observed_coverage jsonb not null default '{}';
create table app.business_events(
 tenant_id uuid not null,id uuid not null,context_id uuid not null,sequence bigint not null check(sequence>0),
 adapter_kind text not null check(adapter_kind in ('semantic_fact','work_command','charge_adjustment')),adapter_id uuid not null,
 source_revision uuid,source_version text not null,source_refs uuid[] not null default '{}',event_key text not null check(event_key ~ '^[a-f0-9]{64}$'),
 event jsonb not null check(jsonb_typeof(event)='object'),created_at timestamptz not null default now(),
 actor_kind text not null check(actor_kind in ('model_candidate','human_approved','policy_applied')),actor_id uuid,
 policy_version text not null,expected_projection_version bigint not null check(expected_projection_version>=0),
 primary key(tenant_id,id),unique(tenant_id,context_id,adapter_kind,adapter_id,source_version),unique(tenant_id,context_id,sequence),
 foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),
 foreign key(tenant_id,source_revision) references app.document_revisions(tenant_id,id)
);
create index business_events_context on app.business_events(tenant_id,context_id,sequence);
create index business_events_source on app.business_events(tenant_id,source_revision);
create index business_facts_scan on app.fact_candidates(tenant_id,recorded_at,id) where semantic is not null;
create index business_commands_scan on app.work_command_effects(tenant_id,context_id,created_at,id);
alter table app.business_events enable row level security;
revoke all on app.business_events from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create function app.business_event_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Immutable business event';end $$;
revoke all on function app.business_event_immutable() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger immutable_business_event before update or delete on app.business_events for each row execute function app.business_event_immutable();

-- This helper runs inside scoped worker/API functions, not with a fabricated JWT actor.
create function app.business_source_status(t uuid,r uuid,c uuid,policy jsonb) returns text language plpgsql set search_path='' as $$
declare o app.evidence_organizations;rev app.document_revisions;
begin
 select * into rev from app.document_revisions where tenant_id=t and id=r;
 if not found or exists(select 1 from app.evidence_retention_tasks where tenant_id=t and revision_id=r) then return 'withdrawn';end if;
 select * into o from app.evidence_organizations where tenant_id=t and revision_id=r;
 if not found or not app.parse_source_allowed(t,o.job_id,policy) or not exists(select 1 from app.evidence_blobs b where b.tenant_id=t and b.id=rev.blob_id and b.storage_location='server' and b.scan_state<>'quarantined') then return 'withdrawn';end if;
 if rev.generated_output or o.state<>'linked' or o.context_id is distinct from c or exists(select 1 from app.document_revisions n where n.tenant_id=t and n.document_id=rev.document_id and n.revision_number>rev.revision_number) then return 'stale';end if;
 return 'current';
end $$;
revoke all on function app.business_source_status(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;

create function app.business_event_id(t uuid,c uuid,k text,i uuid,v text) returns uuid language sql immutable set search_path='' as $$
 select (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid from (select md5(t::text||c::text||k||i::text||v) h)s;
$$;
create function app.business_transaction_key(t uuid,r uuid) returns text language sql stable set search_path='' as $$
 with recursive component(id) as (
  select r union select case when x.left_revision_id=c.id then x.right_revision_id else x.left_revision_id end
  from component c join app.transaction_identities x on x.tenant_id=t and x.choice='same_transaction' and c.id in (x.left_revision_id,x.right_revision_id)
 ), proof as (select array_agg(id) ids,min(id::text) first from component)
 select case when exists(select 1 from app.transaction_identities x where x.tenant_id=t and x.choice='distinct_transaction' and x.left_revision_id=any(p.ids) and x.right_revision_id=any(p.ids)) then null
  when cardinality(p.ids)>1 or exists(select 1 from app.transaction_identities x where x.tenant_id=t and x.choice='distinct_transaction' and (x.left_revision_id=any(p.ids) or x.right_revision_id=any(p.ids))) then 'transaction:'||p.first else null end from proof p;
$$;
create function app.business_fact_basis(t uuid,fid uuid,c uuid,policy jsonb) returns jsonb language plpgsql set search_path='' as $$
declare f app.fact_candidates;o app.evidence_organizations;identity jsonb;proof text;v text;
begin
 select * into f from app.fact_candidates where tenant_id=t and id=fid;
 if not found or f.semantic is null or app.business_source_status(t,f.source_revision,c,policy)<>'current' then return null;end if;
 select * into o from app.evidence_organizations where tenant_id=t and revision_id=f.source_revision;
 if not exists(select 1 from app.product_ai_usage u where u.tenant_id=t and u.id=f.semantic_usage and u.state='settled' and not u.evidence_withdrawn and app.product_ai_scope_allowed(t,u.user_id,u.source_id,u.source_generation,u.revision_id,'semantic',u.config)) then return null;end if;
 if jsonb_array_length(f.semantic->'evidence')<1 or exists(select 1 from jsonb_array_elements(f.semantic->'evidence') e where not exists(
  select 1 from app.evidence_chunks ec join app.evidence_chunk_indexes ix on ix.tenant_id=ec.tenant_id and ix.job_id=ec.job_id where ec.tenant_id=t and ec.revision_id=f.source_revision
   and ec.job_id=(e->>'indexJobId')::uuid and ec.ordinal=(e->>'ordinal')::integer and ec.content_hash=e->>'contentHash' and ec.locator=e->>'locator' and ix.published
   and not exists(select 1 from app.evidence_chunk_indexes n where n.tenant_id=t and n.revision_id=f.source_revision and n.published and (n.created_at,n.job_id)>(ix.created_at,ix.job_id)))) then return null;end if;
 identity:=app.entity_link_input(t,o.job_id,policy);if identity is null then return null;end if;
 proof:=app.business_transaction_key(t,f.source_revision);
 -- A transaction can contain several receipts. A file-level decision cannot identify those events.
 -- Fence the whole copy component when any source has multiple compatible observations.
 if proof is not null and exists(
  with recursive component(id) as (
   select f.source_revision union select case when x.left_revision_id=p.id then x.right_revision_id else x.left_revision_id end
   from component p join app.transaction_identities x on x.tenant_id=t and x.choice='same_transaction' and p.id in (x.left_revision_id,x.right_revision_id)
  ) select 1 from app.fact_candidates other join component p on p.id=other.source_revision
   where other.tenant_id=t and other.semantic->>'eventKind'=f.semantic->>'eventKind'
    and other.semantic#>>'{quantity,unitCode}' is not distinct from f.semantic#>>'{quantity,unitCode}'
   group by other.source_revision having count(*)>1
 ) then proof:=null;end if;
 v:=encode(sha256(convert_to(jsonb_build_array(o.version,identity->>'context_hash',proof,f.semantic)::text,'UTF8')),'hex');
 return jsonb_build_object('version',v,'identity',identity,'transactionKey',proof);
end $$;
revoke all on function app.business_event_id(uuid,uuid,text,uuid,text),app.business_transaction_key(uuid,uuid),app.business_fact_basis(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;

create function app.business_context_input(t uuid,c uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w app.work_contexts;p app.work_projections;facts jsonb;commands jsonb;adjustments jsonb;journal jsonb;result jsonb;
begin
 select * into w from app.work_contexts where tenant_id=t and id=c;if not found then return null;end if;
 select * into p from app.work_projections where tenant_id=t and context_id=c;
 select coalesce(jsonb_agg(x.value order by x.recorded_at,x.id),'[]') into facts from (
  select f.id,f.recorded_at,jsonb_build_object('id',f.id,'eventId',app.business_event_id(t,c,'semantic_fact',f.id,basis.value->>'version'),'sourceVersion',basis.value->>'version','revision',f.source_revision,'semantic',f.semantic,'recordedAt',to_char(f.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'identity',basis.value->'identity','transactionKey',basis.value->'transactionKey','organizationVersion',o.version) value
  from app.fact_candidates f join app.evidence_organizations o on o.tenant_id=f.tenant_id and o.revision_id=f.source_revision
  join app.product_ai_usage u on u.tenant_id=f.tenant_id and u.id=f.semantic_usage
  cross join lateral(select app.business_fact_basis(t,f.id,c,policy) value) basis
  where f.tenant_id=t and o.context_id=c and f.semantic is not null and u.state='settled' and not u.evidence_withdrawn
   and app.product_ai_scope_allowed(t,u.user_id,u.source_id,u.source_generation,u.revision_id,'semantic',u.config)
   and app.business_source_status(t,f.source_revision,c,policy)='current'
   and basis.value is not null and not exists(select 1 from app.business_events b where b.tenant_id=t and b.context_id=c and b.adapter_kind='semantic_fact' and b.adapter_id=f.id and b.source_version=basis.value->>'version')
   -- Evidence casts stay inside business_fact_basis, after its procedural tenant/context guard.
   -- SQL WHERE order cannot guard casts against malformed facts belonging to another context.
  order by f.recorded_at,f.id limit 100)x;
 select coalesce(jsonb_agg(x.value order by x.created_at,x.id),'[]') into commands from (
  select e.id,e.created_at,jsonb_build_object('id',e.id,'eventId',app.business_event_id(t,c,'work_command',e.id,'legacy-v1'),'sourceVersion','legacy-v1','command',e.command_id,'decision',e.decision_id,'actorKind',d.actor_kind,'policyId',d.policy_id,'policyVersion',d.policy_version,
   'recordedAt',to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceRefs',coalesce((select jsonb_agg(distinct ei.revision_id) from app.evidence_index ei where ei.tenant_id=t and ei.id=any(d.evidence_ids)),'[]'::jsonb)) value
  from app.work_command_effects e join app.decisions d on d.tenant_id=e.tenant_id and d.id=e.decision_id
  where e.tenant_id=t and e.context_id=c and d.scope='exception_resolution' and d.choice='apply_work_answer' and d.target_ids[2]=c
   and not exists(select 1 from app.business_events b where b.tenant_id=t and b.adapter_kind='work_command' and b.adapter_id=e.id)
  order by e.created_at,e.id limit 100)x;
 select coalesce(jsonb_agg(x.value order by x.created_at,x.id),'[]') into adjustments from (
  select a.id,a.created_at,jsonb_build_object('id',a.id,'eventId',app.business_event_id(t,c,'charge_adjustment',a.id,'legacy-v1'),'sourceVersion','legacy-v1','charge',a.charge_case_id,'decision',a.decision_id,'revision',a.next_revision_id,'actorKind',d.actor_kind,'policyId',d.policy_id,'policyVersion',d.policy_version,
   'recordedAt',to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceRefs',coalesce((select jsonb_agg(distinct ei.revision_id) from app.evidence_index ei where ei.tenant_id=t and ei.id=any(d.evidence_ids)),'[]'::jsonb)) value
  from app.charge_adjustments a join app.charge_cases cc on cc.tenant_id=a.tenant_id and cc.id=a.charge_case_id
  join app.decisions d on d.tenant_id=a.tenant_id and d.id=a.decision_id
  where a.tenant_id=t and cc.bundle_id=w.bundle_id
   and (select count(*) from app.work_contexts wc where wc.tenant_id=t and wc.bundle_id=w.bundle_id)=1
   and not exists(select 1 from app.business_events b where b.tenant_id=t and b.adapter_kind='charge_adjustment' and b.adapter_id=a.id)
  order by a.created_at,a.id limit 100)x;
 select coalesce(jsonb_agg(b.event||jsonb_build_object('evidenceWithdrawn',b.adapter_kind='semantic_fact' and
   (app.business_fact_basis(t,b.adapter_id,c,policy)->>'version' is distinct from b.source_version)) order by b.sequence),'[]') into journal
 from app.business_events b where b.tenant_id=t and b.context_id=c;
 result:=jsonb_build_object('tenant',t,'context',c,'project',w.project_id,'contextVersion',w.version,'confirmedVersion',coalesce(p.version,1),'observedVersion',coalesce(p.observed_version,0),
  'watermark',coalesce((select max(sequence) from app.business_events where tenant_id=t and context_id=c),0),'facts',facts,'commands',commands,'adjustments',adjustments,'events',journal);
 return result||jsonb_build_object('context_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

create function app.next_business_event_input(t uuid,policy jsonb,schedule jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare w record;v jsonb;
begin
 for w in select wc.tenant_id,wc.id from app.work_contexts wc where (t is null or wc.tenant_id=t) and (
  exists(select 1 from app.evidence_organizations o join app.fact_candidates f on f.tenant_id=o.tenant_id and f.source_revision=o.revision_id where o.tenant_id=wc.tenant_id and o.context_id=wc.id and f.semantic is not null)
  or exists(select 1 from app.work_command_effects e where e.tenant_id=wc.tenant_id and e.context_id=wc.id)
  or exists(select 1 from app.business_events b where b.tenant_id=wc.tenant_id and b.context_id=wc.id)
  or exists(select 1 from app.charge_cases cc join app.charge_adjustments ca on ca.tenant_id=cc.tenant_id and ca.charge_case_id=cc.id where cc.tenant_id=wc.tenant_id and cc.bundle_id=wc.bundle_id))
  order by case when (wc.tenant_id,wc.id)>((schedule#>>'{after,tenant}')::uuid,(schedule#>>'{after,context}')::uuid) then 0 else 1 end,wc.tenant_id,wc.id loop
  begin
   v:=app.business_context_input(w.tenant_id,w.id,policy);
  exception when others then
   -- Bad source shapes cannot stop unrelated contexts. Hash only the affected source state.
   select jsonb_build_object('tenant',w.tenant_id,'context',w.id,'failure','BUSINESS_CONTEXT_INPUT_INVALID','context_hash',
    encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(f.id,f.semantic,o.version,o.context_id) order by f.id),'[]')::text,'UTF8')),'hex')) into v
    from app.evidence_organizations o join app.fact_candidates f on f.tenant_id=o.tenant_id and f.source_revision=o.revision_id
    where o.tenant_id=w.tenant_id and o.context_id=w.id;
  end;
  if exists(select 1 from jsonb_array_elements(coalesce(schedule->'excluded','[]')) x where x->>'tenant'=w.tenant_id::text and x->>'context'=w.id::text and x->>'hash'=v->>'context_hash') then continue;end if;
  if v->>'failure' is not null then return v;end if;
  if v is not null and (jsonb_array_length(v->'facts')+jsonb_array_length(v->'commands')+jsonb_array_length(v->'adjustments')>0
   or (jsonb_array_length(v->'events')>0 and (select observed_hash from app.work_projections where tenant_id=w.tenant_id and context_id=w.id) is distinct from v->>'context_hash')) then return v;end if;
 end loop;return null;
end $$;

alter table app.outbox alter column job_id drop not null;
alter table app.outbox add column business_context_id uuid;
alter table app.outbox add column business_version bigint;
alter table app.outbox add column business_lease uuid;
alter table app.outbox add column business_lease_until timestamptz;
alter table app.outbox add column business_attempts integer not null default 0;
alter table app.outbox add column business_available_at timestamptz not null default now();
alter table app.outbox add column business_error text;
alter table app.outbox add foreign key(tenant_id,business_context_id) references app.work_contexts(tenant_id,id);
alter table app.outbox drop constraint outbox_topic_check;
alter table app.outbox add constraint outbox_topic_check check(topic in ('parse_original_ready','render_document_ready','work_observed_ready'));
alter table app.outbox add constraint outbox_business_scope check((topic='work_observed_ready' and job_id is null and business_context_id is not null and business_version>0) or (topic<>'work_observed_ready' and job_id is not null and business_context_id is null));
create index business_outbox_pending on app.outbox(business_available_at,created_at) where topic='work_observed_ready' and state='pending';

create function app.save_business_event_projection(t uuid,c uuid,digest text,expected bigint,records jsonb,reduced jsonb,policy jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare ctx jsonb;r jsonb;source jsonb;seq bigint;rev uuid;refs uuid[];origin text;source_id uuid;after_input jsonb;v bigint;business_actor uuid;business_actor_kind text;business_policy text;
begin
 perform pg_advisory_xact_lock(hashtextextended(t::text||':business:'||c::text,0));
 ctx:=app.business_context_input(t,c,policy);if ctx is null or ctx->>'context_hash'<>digest or (ctx->>'observedVersion')::bigint<>expected then return false;end if;
 if jsonb_typeof(records)<>'array' or jsonb_array_length(records)<>jsonb_array_length(ctx->'facts')+jsonb_array_length(ctx->'commands')+jsonb_array_length(ctx->'adjustments') then raise exception 'Invalid business batch';end if;
 seq:=(ctx->>'watermark')::bigint;
 for r in select value from jsonb_array_elements(records) loop
  origin:=r->>'adapter_kind';source_id:=(r->>'adapter_id')::uuid;source:=null;rev:=null;refs:='{}';
  if origin='semantic_fact' then select value into source from jsonb_array_elements(ctx->'facts') where value->>'id'=source_id::text;rev:=(source->>'revision')::uuid;refs:=array[rev];
  elsif origin='work_command' then select value into source from jsonb_array_elements(ctx->'commands') where value->>'id'=source_id::text;
  elsif origin='charge_adjustment' then select value into source from jsonb_array_elements(ctx->'adjustments') where value->>'id'=source_id::text;end if;
  if source is null or r#>>'{event,tenantId}'<>t::text or r#>>'{event,contextId}'<>c::text or r#>>'{event,id}'<>source->>'eventId' then raise exception 'Business source mismatch';end if;
  seq:=seq+1;if (r#>>'{event,sequence}')::bigint<>seq then raise exception 'Business sequence mismatch';end if;
  if origin='semantic_fact' then
   select u.user_id into business_actor from app.fact_candidates f join app.product_ai_usage u on u.tenant_id=f.tenant_id and u.id=f.semantic_usage where f.tenant_id=t and f.id=(source->>'id')::uuid;
   business_actor_kind:='model_candidate';business_policy:='n07-adapter-v1';
   if r#>>'{event,mode}'<>'observed' or r#>'{event,existingEffect}'<>'null'::jsonb or (r#>'{event,transactionKey}'<>'null'::jsonb and r#>'{event,transactionKey}' is distinct from source->'transactionKey')
    or r#>>'{event,kind}'<>source#>>'{semantic,eventKind}' or r#>'{event,quantity}' is distinct from source#>'{semantic,quantity}' or r#>'{event,amount}' is distinct from source#>'{semantic,amount}' then raise exception 'Invalid observed event';end if;
  else
   select d.actor_id,case when d.actor_kind='system' then 'policy_applied' else 'human_approved' end,
    case when d.policy_id is null then 'n07-adapter-v1' else 'owner-policy-v1:'||d.policy_id::text||':'||d.policy_version::text end
    into business_actor,business_actor_kind,business_policy from app.decisions d where d.tenant_id=t and d.id=(source->>'decision')::uuid;
   select coalesce(array_agg(value::uuid),'{}') into refs from jsonb_array_elements_text(source->'sourceRefs');
   if r#>>'{event,mode}'<>'applied' or r#>>'{event,existingEffect,id}'<>source_id::text or r#>>'{event,existingEffect,kind}'<>origin or r#>'{event,quantity}'<>'null'::jsonb or r#>'{event,amount}'<>'null'::jsonb then raise exception 'Invalid applied pointer';end if;
  end if;
  insert into app.business_events(tenant_id,id,context_id,sequence,adapter_kind,adapter_id,source_revision,source_version,source_refs,event_key,event,actor_kind,actor_id,policy_version,expected_projection_version)
   values(t,(source->>'eventId')::uuid,c,seq,origin,source_id,rev,source->>'sourceVersion',refs,r->>'event_key',r->'event',business_actor_kind,business_actor,business_policy,expected);
 end loop;
 if jsonb_typeof(reduced->'observed_state')<>'object' or (reduced->>'watermark')::bigint<>seq or jsonb_typeof(reduced->'coverage')<>'object' then raise exception 'Invalid observed projection';end if;
 insert into app.work_projections(tenant_id,context_id) values(t,c) on conflict do nothing;
 update app.work_projections set observed_state=reduced->'observed_state',observed_coverage=reduced->'coverage',event_watermark=seq,observed_version=observed_version+1 where tenant_id=t and context_id=c and observed_version=expected returning observed_version into v;
 if not found then raise exception 'Observed version conflict';end if;
 after_input:=app.business_context_input(t,c,policy);
 update app.work_projections set observed_hash=after_input->>'context_hash' where tenant_id=t and context_id=c;
 insert into app.outbox(tenant_id,job_id,topic,operation_key,business_context_id,business_version)
 values(t,null,'work_observed_ready','work_observed:'||c::text||':'||v::text,c,v) on conflict(tenant_id,operation_key) do nothing;
 return true;
end $$;

create function app.claim_business_outbox(t uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r app.outbox;token uuid:=gen_random_uuid();
begin
 select * into r from app.outbox where (t is null or tenant_id=t) and topic='work_observed_ready' and state='pending' and business_available_at<=now() and (business_lease_until is null or business_lease_until<=now()) order by business_available_at,created_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update app.outbox set business_lease=token,business_lease_until=now()+interval '30 seconds',business_attempts=business_attempts+1 where tenant_id=r.tenant_id and id=r.id;
 return jsonb_build_object('tenant',r.tenant_id,'id',r.id,'token',token);
end $$;
create function app.finish_business_outbox(t uuid,i uuid,token uuid,success boolean) returns boolean language plpgsql security definer set search_path='' as $$
declare r app.outbox;pos bigint;
begin
 select * into r from app.outbox where tenant_id=t and id=i and topic='work_observed_ready' for update;
 if not found or r.state<>'pending' or r.business_lease is distinct from token or r.business_lease_until<=now() then return false;end if;
 if not success then update app.outbox set business_lease=null,business_lease_until=null,business_available_at=now()+interval '30 seconds',business_error='BUSINESS_SYNC_RETRY' where tenant_id=t and id=i;return true;end if;
 insert into app.sync_heads(tenant_id,position) values(t,1) on conflict(tenant_id) do update set position=app.sync_heads.position+1 returning position into pos;
 insert into app.sync_changes values(t,pos,'reset',r.business_context_id,false);
 update app.outbox set state='published',business_lease=null,business_lease_until=null,business_error=null where tenant_id=t and id=i;return true;
end $$;

create function app.read_business_work(t uuid,c uuid,policy jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;events jsonb;
begin
 if not app.has_tenant_role(t,array['owner','operator','accountant']) then return null;end if;
 result:=app.business_context_input(t,c,policy);if result is null then return null;end if;
 -- Retain opaque subject identity so a withdrawn correction still suppresses its old parent.
 select coalesce(jsonb_agg(case when (e->>'evidenceWithdrawn')::boolean then e||jsonb_build_object('quantity',null,'amount',null,'evidenceIds','[]'::jsonb) else e end order by (e->>'sequence')::bigint),'[]') into events from jsonb_array_elements(result->'events') e;
 return jsonb_build_object('tenant',t,'context',c,'events',events,'observedVersion',result->'observedVersion','confirmedVersion',result->'confirmedVersion','watermark',result->'watermark');
end $$;
revoke all on function app.business_context_input(uuid,uuid,jsonb),app.next_business_event_input(uuid,jsonb,jsonb),app.save_business_event_projection(uuid,uuid,text,bigint,jsonb,jsonb,jsonb),app.claim_business_outbox(uuid),app.finish_business_outbox(uuid,uuid,uuid,boolean),app.read_business_work(uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant execute on function app.next_business_event_input(uuid,jsonb,jsonb),app.save_business_event_projection(uuid,uuid,text,bigint,jsonb,jsonb,jsonb),app.claim_business_outbox(uuid),app.finish_business_outbox(uuid,uuid,uuid,boolean) to sigongnote_worker;
grant execute on function app.read_business_work(uuid,uuid,jsonb) to sigongnote_api;
