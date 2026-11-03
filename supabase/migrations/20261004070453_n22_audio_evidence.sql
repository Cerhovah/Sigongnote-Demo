-- An unchanged paid audio window (including preceding context) needs no new model call.
create or replace function app.audio_semantic_window_current(t uuid,old_job uuid,new_job uuid,config jsonb) returns boolean
language sql stable set search_path='' as $$
 select coalesce((config->>'first_ordinal')::integer<=(config->>'last_ordinal')::integer,false)
 and exists(select 1 from app.evidence_chunk_indexes a join app.evidence_chunk_indexes b on b.tenant_id=a.tenant_id and b.revision_id=a.revision_id and b.source_hash=a.source_hash
 where a.tenant_id=t and a.job_id=old_job and b.job_id=new_job and a.published and b.published and b.parser_version='audio-corrected-v1' and a.chunk_count=b.chunk_count)
 and not exists(select 1 from app.evidence_chunks n left join app.evidence_chunks o on o.tenant_id=n.tenant_id and o.job_id=old_job and o.ordinal=n.ordinal
 where n.tenant_id=t and n.job_id=new_job and (n.ordinal between greatest(0,(config->>'first_ordinal')::integer-2) and (config->>'last_ordinal')::integer
 or n.ordinal in (select value::integer from jsonb_array_elements_text(coalesce(config->'context_ordinals','[]'))))
 and (n.locator,n.content_hash) is distinct from (o.locator,o.content_hash))
$$;
revoke all on function app.audio_semantic_window_current(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
-- N22 scoped delta, generated via local db pull; unrelated local drift excluded.
-- A correction publishes a new immutable evidence version on the same original.
-- Existing jobs/indexes/corrections/usage/events remain in the recovery manifest.
create or replace function app.reindex_audio_correction(t uuid,r uuid,command uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare prior app.evidence_chunk_indexes;result app.parse_results;correction app.audio_corrections;
 jid uuid;digest text;out jsonb;preview jsonb;manifest jsonb;
begin
 if not app.has_tenant_role(t,array['owner','operator']) or not app.revision_accessible(t,r) then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||r::text,11));
 select * into correction from app.audio_corrections where tenant_id=t and revision_id=r and command_id=command and actor_id=auth.uid();
 if not found then return null;end if;
 select * into prior from app.evidence_chunk_indexes where tenant_id=t and revision_id=r and published order by created_at desc,job_id desc limit 1;
 if not found or not exists(select 1 from app.document_revisions where tenant_id=t and id=r and declared_mime like 'audio/%') then return null;end if;
 digest:=encode(sha256(convert_to(prior.source_hash||command::text,'UTF8')),'hex');
 select id into jid from app.jobs where tenant_id=t and evidence_revision_id=r and processor_version='audio-corrected-v1' and input_hash=digest;
 if found then return jid;end if;
 select * into result from app.parse_results where tenant_id=t and revision_id=r order by created_at desc,job_id desc limit 1;
 if not found then return null;end if;
 jid:=gen_random_uuid();
 insert into app.jobs(tenant_id,id,job_type,evidence_revision_id,processor_version,input_hash,state)
 values(t,jid,'parse_original',r,'audio-corrected-v1',digest,'succeeded');
 manifest:=prior.manifest||jsonb_build_object('parserVersion','audio-corrected-v1','correction',command);
 insert into app.evidence_chunk_indexes(tenant_id,job_id,revision_id,source_hash,parser_version,manifest,source_generations,chunk_count,published,created_at)
 values(t,jid,r,prior.source_hash,'audio-corrected-v1',manifest,prior.source_generations,prior.chunk_count,true,clock_timestamp());
 insert into app.evidence_chunks(tenant_id,job_id,revision_id,ordinal,text,locator,position,content_hash)
 select t,jid,r,c.ordinal,coalesce(a.text,c.text),c.locator,
 c.position||case when a.command_id is null then '{}'::jsonb else jsonb_build_object('correction_id',a.command_id,'original_text',coalesce(c.position->>'original_text',c.text)) end,
 encode(sha256(convert_to(coalesce(a.text,c.text),'UTF8')),'hex')
 from app.evidence_chunks c left join lateral(select text,command_id from app.audio_corrections where tenant_id=t and revision_id=r and locator=c.locator order by created_at desc,command_id desc limit 1)a on true
 where c.tenant_id=t and c.job_id=prior.job_id;
 select coalesce(jsonb_agg(jsonb_build_object('text',text,'locator',locator,'speaker',position->'speaker') order by ordinal),'[]') into preview
 from (select * from app.evidence_chunks where tenant_id=t and job_id=jid order by ordinal limit 500)c;
 out:=result.output||jsonb_build_object('processorVersion','audio-corrected-v1','parserVersion','audio-corrected-v1','spans',preview,'evidence',manifest,'excerptTruncated',prior.chunk_count>500);
 insert into app.parse_results(tenant_id,job_id,revision_id,processor_version,input_hash,output,created_at)
 values(t,jid,r,'audio-corrected-v1',digest,out,clock_timestamp());
 return jid;
end $$;
revoke all on function app.reindex_audio_correction(uuid,uuid,uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.reindex_audio_correction(uuid,uuid,uuid) to sigongnote_api;

-- New candidates may refer to a corrected segment; pre-correction meaning stays fenced.
create or replace function app.audio_evidence_current(t uuid,r uuid,evidence jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from jsonb_array_elements(evidence) e
 join lateral(select text from app.audio_corrections where tenant_id=t and revision_id=r and locator=e->>'locator' order by created_at desc,command_id desc limit 1)a on true
 where e->>'contentHash' is distinct from encode(sha256(convert_to(a.text,'UTF8')),'hex'))
$$;
revoke all on function app.audio_evidence_current(uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;

create or replace function app.stage_audio_corrections(t uuid,j uuid,token uuid,policy jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not app.audio_allowed(t,j,policy) or not exists(select 1 from app.jobs where tenant_id=t and id=j and state='leased' and lease_token=token and lease_expires_at>now()) then return false;end if;
 if not exists(select 1 from app.evidence_chunk_indexes where tenant_id=t and job_id=j and not published) then return false;end if;
 update app.evidence_chunks c set text=a.text,content_hash=encode(sha256(convert_to(a.text,'UTF8')),'hex'),
 position=c.position||jsonb_build_object('original_text',coalesce(c.position->>'original_text',c.text),'correction_id',a.command_id)
 from (select distinct on(revision_id,locator) revision_id,locator,text,command_id from app.audio_corrections where tenant_id=t order by revision_id,locator,created_at desc,command_id desc)a
 where c.tenant_id=t and c.job_id=j and c.revision_id=a.revision_id and c.locator=a.locator;
 return true;
end $$;
revoke all on function app.stage_audio_corrections(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.stage_audio_corrections(uuid,uuid,uuid,jsonb) to sigongnote_worker;


CREATE OR REPLACE FUNCTION app.audio_load(t uuid, j uuid, token uuid, policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r uuid; result jsonb; reused jsonb; prior_state text;
begin
 if not app.audio_allowed(t,j,policy) then return null;end if;
 select evidence_revision_id into r from app.jobs where tenant_id=t and id=j and processor_version in ('long-audio-v1','long-audio-v2') and state='leased' and lease_token=token and lease_expires_at>now();
 if not found then return null;end if;
 -- Rebuild only unpublished derived audio chunks after an interrupted attempt.
 delete from app.evidence_chunks where tenant_id=t and job_id=j and exists(select 1 from app.evidence_chunk_indexes where tenant_id=t and job_id=j and not published);
 insert into app.audio_work(tenant_id,job_id,revision_id) values(t,j,r) on conflict do nothing;
 select a.state into reused from app.audio_work a join app.jobs prior on prior.tenant_id=a.tenant_id and prior.id=a.job_id join app.jobs current on current.tenant_id=t and current.id=j
 where a.tenant_id=t and a.job_id<>j and prior.input_hash=current.input_hash and a.state->>'phase' in ('complete','partial')
 and a.state->>'provider'=case when policy->>'external_processing'='true' then case when policy->>'provider'='openai' then 'openai' else 'clova' end else 'synthetic' end order by case when a.state->>'phase'='complete' then 0 else 1 end,a.updated_at desc,a.job_id limit 1;
 if reused is not null then update app.audio_work set state=reused,updated_at=now() where tenant_id=t and job_id=j;end if;
 select state into result from app.audio_work where tenant_id=t and job_id=j;
 if reused is null and result->>'backfillOnly'='true' then return result||jsonb_build_object('phase','held','reason','audio_provider_changed');end if;
 if reused is null and policy->>'external_processing'='true' then
  select prior.state into prior_state from app.audio_reservations a join app.jobs prior on prior.tenant_id=a.tenant_id and prior.id=a.job_id join app.jobs current on current.tenant_id=t and current.id=j
  where a.tenant_id=t and a.job_id<>j and prior.input_hash=current.input_hash order by prior.created_at,prior.id limit 1;
  if prior_state is not null then
   result:=jsonb_set(jsonb_set(result,'{phase}',to_jsonb(case when prior_state in ('queued','leased','retry_wait') then 'waiting'::text else 'held'::text end)),'{reason}',to_jsonb(case when prior_state in ('queued','leased','retry_wait') then 'audio_existing_wait'::text else 'audio_duplicate_held'::text end));
  end if;
 end if;
 return result;
end $function$
;

CREATE OR REPLACE FUNCTION app.audio_save(t uuid, j uuid, token uuid, policy jsonb, value jsonb, wait_seconds integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if not app.audio_allowed(t,j,policy) then return false;end if;
 perform 1 from app.jobs where tenant_id=t and id=j and state='leased' and lease_token=token and lease_expires_at>now() for update;
 if not found or jsonb_typeof(value)<>'object' or octet_length(value::text)>33554432 then return false;end if;
 update app.audio_work set state=value,updated_at=now() where tenant_id=t and job_id=j;
 if not found then return false;end if;
 if wait_seconds=-1 then
  update app.jobs set state='dead',lease_expires_at=null,last_error_code='AUDIO_HELD',updated_at=now() where tenant_id=t and id=j;
 elsif wait_seconds is not null then
  update app.jobs set state='retry_wait',lease_expires_at=null,attempt_count=greatest(0,attempt_count-1),available_at=now()+make_interval(secs=>greatest(1,least(wait_seconds,86400))),updated_at=now() where tenant_id=t and id=j;
 end if;return true;
end $function$
;

CREATE OR REPLACE FUNCTION app.audio_reserve(t uuid, j uuid, token uuid, policy jsonb, c integer, seconds integer, tenant_limit integer, global_limit integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if not coalesce((policy->>'external_processing')::boolean,false) or not app.audio_allowed(t,j,policy) then return 'stale';end if;
 perform 1 from app.jobs where tenant_id=t and id=j and state='leased' and lease_token=token and lease_expires_at>now() for update;if not found then return 'stale';end if;
 perform pg_advisory_xact_lock(110011);
 if exists(select 1 from app.audio_reservations where tenant_id=t and job_id=j and chunk=c) then
  if exists(select 1 from app.audio_work where tenant_id=t and job_id=j and state#>>array['chunks',c::text,'status'] is null) then
   update app.audio_work set state=jsonb_set(state,array['chunks',c::text,'status'],'"submitting"') where tenant_id=t and job_id=j;return 'ok';
  end if;return 'duplicate';
 end if;
 if exists(select 1 from app.audio_reservations r join app.jobs prior on prior.tenant_id=r.tenant_id and prior.id=r.job_id join app.jobs current on current.tenant_id=t and current.id=j where r.tenant_id=t and r.chunk=c and prior.input_hash=current.input_hash and prior.state in ('queued','leased','retry_wait')) then return 'duplicate_wait';end if;
 if exists(select 1 from app.audio_reservations r join app.jobs prior on prior.tenant_id=r.tenant_id and prior.id=r.job_id join app.jobs current on current.tenant_id=t and current.id=j where r.tenant_id=t and r.chunk=c and prior.input_hash=current.input_hash) then return 'duplicate';end if;
 if tenant_limit not between 1 and 7200 or global_limit not between 1 and 14400 or seconds not between 1 and 601 then return 'budget';end if;
 if (select coalesce(sum(r.seconds),0) from app.audio_reservations r where r.tenant_id=t and r.created_at>now()-interval '24 hours')+seconds>tenant_limit
 or (select coalesce(sum(r.seconds),0) from app.audio_reservations r where r.created_at>now()-interval '24 hours')+seconds>global_limit then return 'budget';end if;
 insert into app.audio_reservations(tenant_id,job_id,chunk,seconds) values(t,j,c,seconds);
 update app.audio_work set state=jsonb_set(jsonb_set(state,array['chunks',c::text,'status'],'"submitting"'),array['chunks',c::text,'submittedAt'],to_jsonb((extract(epoch from now())*1000)::bigint)) where tenant_id=t and job_id=j;return 'ok';
end $function$
;

CREATE OR REPLACE FUNCTION app.product_ai_scope_allowed(p_tenant uuid, p_user uuid, p_source uuid, p_generation bigint, p_revision uuid, p_channel text, p_config jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
 -- API routes enter inAuthorizedTransaction, which verifies the session then sets claim.sub.
 if session_user='sigongnote_api' and auth.uid() is distinct from p_user then return false; end if;
 if not exists(select 1 from app.memberships m where m.tenant_id=p_tenant and m.user_id=p_user and m.active and m.revoked_at is null and m.role in ('owner','operator','accountant')) then return false; end if;
 if p_channel='agent' then
  return p_source is null and p_generation is null and p_revision is null and exists(select 1 from app.agent_runs a where a.tenant_id=p_tenant and a.user_id=p_user and a.id::text=p_config->>'run_id' and a.status<>'cancelled' and app.session_is_active(a.user_id,a.session_id));
 end if;
 if p_source is null then
  return p_channel='short_stt' and exists(select 1 from app.voice_consents c where c.tenant_id=p_tenant and c.user_id=p_user and c.provider_version='short-voice-v1' and c.allowed
   and (extract(epoch from c.updated_at)*1000000)::bigint::text=p_config->>'consent_generation');
 end if;
 if p_revision is null then return false;end if;
 select c.*,d.active device_active into s from app.capture_sources c join app.devices d on d.tenant_id=c.tenant_id and d.id=c.device_id
  where c.tenant_id=p_tenant and c.id=p_source and c.user_id=p_user for share of c;
 if not found or not s.active or not s.device_active or not s.local_selection_consent or not s.server_upload_consent or not s.external_ai_consent or s.generation is distinct from p_generation then return false; end if;
 if s.processing_policy is null or s.processing_policy is distinct from p_config->'policy'
  or s.processing_policy->'external_processing' is distinct from 'true'::jsonb
  or s.processing_policy->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 if p_channel in ('semantic','vision') and p_config->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 if p_channel='long_stt' and not coalesce((p_config->>'policy_provider'='clova_speech' and p_config->>'provider'='clova' and p_config->>'model'='clova-speech') or (p_config->>'policy_provider'='openai' and p_config->>'provider'='openai' and p_config->>'model'='whisper-1'),false) then return false; end if;
 if p_revision is not null and not exists(select 1 from app.upload_intents i where i.tenant_id=p_tenant and i.completed_revision_id=p_revision and i.source_id=p_source and i.source_generation=p_generation) then return false; end if;
 if p_revision is not null and exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=p_tenant and w.revision_id=p_revision) then return false;end if;
 return true;
end $function$
;

CREATE OR REPLACE FUNCTION app.next_semantic_input(p_policy jsonb, p_model_key text, p_tenant uuid DEFAULT NULL::uuid, p_headroom bigint DEFAULT 1, p_deferred uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; s record; first_ordinal integer; spans jsonb;history jsonb; daily bigint; monthly bigint; inherited jsonb; boundary integer;
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
  select coalesce(jsonb_agg(jsonb_build_object('first',(u.config->>'first_ordinal')::integer,'last',(u.config->>'last_ordinal')::integer)),'[]') into inherited
  from app.product_ai_usage u join app.evidence_chunk_indexes prior on prior.tenant_id=u.tenant_id and prior.job_id::text=u.config->>'index_job'
  where r.parser_version='audio-corrected-v1' and prior.revision_id=r.revision_id and (prior.created_at,prior.job_id)<(r.created_at,r.job_id)
  and u.tenant_id=r.tenant_id and u.user_id=s.user_id and u.source_id=s.id and u.source_generation=s.generation and u.channel='semantic' and u.state<>'reserved' and not u.evidence_withdrawn
  and app.product_ai_scope_allowed(r.tenant_id,u.user_id,u.source_id,u.source_generation,u.revision_id,'semantic',u.config)
  and app.audio_semantic_window_current(r.tenant_id,prior.job_id,r.job_id,u.config);
  select min(e.ordinal) into first_ordinal from app.evidence_chunks e where e.tenant_id=r.tenant_id and e.job_id=r.job_id and not exists(
   select 1 from app.product_ai_usage u where u.tenant_id=r.tenant_id and u.user_id=s.user_id and u.source_id=s.id and u.source_generation=s.generation
    and u.config->>'index_job'=r.job_id::text and u.state<>'reserved'
    and e.ordinal between (u.config->>'first_ordinal')::integer and (u.config->>'last_ordinal')::integer)
    and not exists(select 1 from jsonb_array_elements(inherited) w where e.ordinal between (w->>'first')::integer and (w->>'last')::integer);
  if first_ordinal is null then continue; end if;
  select coalesce(min((w->>'first')::integer),2147483647) into boundary from jsonb_array_elements(inherited) w where (w->>'first')::integer>first_ordinal;
  -- Fetch ahead; the worker selects complete rows within the 32KiB provider envelope.
  select jsonb_agg(jsonb_build_object('ordinal',c.ordinal,'text',c.text,'locator',c.locator,'position',c.position,'content_hash',c.content_hash) order by c.ordinal) into spans
   from (select * from app.evidence_chunks e where e.tenant_id=r.tenant_id and e.job_id=r.job_id and e.ordinal>=first_ordinal and e.ordinal<boundary order by e.ordinal limit 128) c;
  select coalesce(jsonb_agg(jsonb_build_object('ordinal',c.ordinal,'text',c.text,'locator',c.locator,'position',c.position,'content_hash',c.content_hash) order by c.ordinal),'[]') into history from (select * from app.evidence_chunks e where e.tenant_id=r.tenant_id and e.job_id=r.job_id and e.ordinal<first_ordinal and ((e.locator like 'audio:%' and e.ordinal>=first_ordinal-2) or e.ordinal<32 or regexp_replace(e.text,'\s','','g') ~ '품명|규격|단위|수량|단가|금액|재료비|노무비|견적서|거래명세') order by e.ordinal desc limit 64) c;
  return jsonb_build_object('tenant',r.tenant_id,'user',s.user_id,'source',s.id,'generation',s.generation,'revision',r.revision_id,
   'source_hash',r.source_hash,'parser',r.parser_version,'scope',s.scope_fingerprint,'index_job',r.job_id,'mime',r.declared_mime,'chunks',spans,'context_chunks',history);
 end loop;
 return null;
end $function$
;

CREATE OR REPLACE FUNCTION app.business_fact_basis(t uuid, fid uuid, c uuid, policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare f app.fact_candidates;o app.evidence_organizations;identity jsonb;proof text;v text;latest app.evidence_chunk_indexes;usage_config jsonb;
begin
 select * into f from app.fact_candidates where tenant_id=t and id=fid;
 if not found or f.semantic is null or app.business_source_status(t,f.source_revision,c,policy)<>'current' then return null;end if;
 if not app.audio_evidence_current(t,f.source_revision,f.semantic->'evidence') then return null;end if;
 select * into o from app.evidence_organizations where tenant_id=t and revision_id=f.source_revision;
 if not exists(select 1 from app.product_ai_usage u where u.tenant_id=t and u.id=f.semantic_usage and u.state='settled' and not u.evidence_withdrawn and app.product_ai_scope_allowed(t,u.user_id,u.source_id,u.source_generation,u.revision_id,'semantic',u.config)) then return null;end if;
 select * into latest from app.evidence_chunk_indexes where tenant_id=t and revision_id=f.source_revision and published order by created_at desc,job_id desc limit 1;
 select config into usage_config from app.product_ai_usage where tenant_id=t and id=f.semantic_usage;
 if jsonb_array_length(f.semantic->'evidence')<1 or exists(select 1 from jsonb_array_elements(f.semantic->'evidence') e where not exists(
  select 1 from app.evidence_chunks ec join app.evidence_chunk_indexes ix on ix.tenant_id=ec.tenant_id and ix.job_id=ec.job_id where ec.tenant_id=t and ec.revision_id=f.source_revision
   and ec.job_id=(e->>'indexJobId')::uuid and ec.ordinal=(e->>'ordinal')::integer and ec.content_hash=e->>'contentHash' and ec.locator=e->>'locator' and ix.published
   and (ix.job_id=latest.job_id or app.audio_semantic_window_current(t,ix.job_id,latest.job_id,usage_config)))) then return null;end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION app.operational_facts(t uuid, c uuid, policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if not app.has_tenant_role(t,array['owner','operator','accountant']) then return null;end if;
 if not exists(select 1 from app.work_contexts where tenant_id=t and id=c) then return null;end if;
 select coalesce(jsonb_agg(v order by id),'[]'::jsonb) into result from (
 select f.id,jsonb_build_object('id',f.id,'revision',f.source_revision,'organization_version',o.version,'context_id',o.context_id,'project_id',o.project_id,'semantic',f.semantic,'version',b.value->>'version','transaction_key',b.value->>'transactionKey') v
 from app.fact_candidates f join app.evidence_organizations o on o.tenant_id=f.tenant_id and o.revision_id=f.source_revision
 cross join lateral(select app.business_fact_basis(t,f.id,c,policy) value)b
 where f.tenant_id=t and o.context_id=c and f.semantic is not null and b.value is not null
 and app.audio_evidence_current(t,f.source_revision,f.semantic->'evidence')
 order by f.id limit 201)s;
 return jsonb_build_object('facts',result,'partial',jsonb_array_length(result)>200);
end $function$
;

CREATE OR REPLACE FUNCTION app.document_facts(t uuid, c uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rows jsonb;
begin
 if not app.has_tenant_role(t,array['owner','accountant']) then return null;end if;
 select coalesce(jsonb_agg(v order by id),'[]'::jsonb) into rows from (
  select f.id,jsonb_build_object('id',f.id,'revision',f.source_revision,'semantic',f.semantic,'version',b.value->>'version','identity',b.value->'identity','transaction_key',b.value->>'transactionKey') v
  from app.fact_candidates f join app.evidence_organizations o on o.tenant_id=f.tenant_id and o.revision_id=f.source_revision
  join app.product_ai_usage u on u.tenant_id=f.tenant_id and u.id=f.semantic_usage
  cross join lateral(select app.business_fact_basis(t,f.id,c,u.config->'policy') value)b
  where f.tenant_id=t and o.context_id=c and f.semantic is not null and b.value is not null
  and app.audio_evidence_current(t,f.source_revision,f.semantic->'evidence')
  order by f.id limit 201
 )s;
 return jsonb_build_object('facts',rows,'partial',jsonb_array_length(rows)>200);
end $function$
;
alter table app.audio_work drop constraint audio_work_state_check;
alter table app.audio_work add constraint audio_work_state_check check(octet_length(state::text)<=33554432);
alter table app.audio_reservations drop constraint audio_reservations_seconds_check;
alter table app.audio_reservations add constraint audio_reservations_seconds_check check(seconds between 1 and 601);

-- Reuse the stored transcript/receipts; this creates no provider submissions.
insert into app.jobs(tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
select j.tenant_id,'parse_original',j.evidence_revision_id,'long-audio-v2',j.input_hash from app.jobs j
join app.audio_work a on a.tenant_id=j.tenant_id and a.job_id=j.id
where j.processor_version='long-audio-v1' and j.state='succeeded' and a.state->>'phase' in ('complete','partial')
and not exists(select 1 from app.evidence_chunk_indexes i where i.tenant_id=j.tenant_id and i.revision_id=j.evidence_revision_id and i.published)
on conflict do nothing;

insert into app.audio_work(tenant_id,job_id,revision_id,state)
select n.tenant_id,n.id,n.evidence_revision_id,jsonb_build_object('phase','waiting','chunks','[]'::jsonb,'backfillOnly',true)
from app.jobs n where n.processor_version='long-audio-v2' and n.state in ('queued','retry_wait')
and exists(select 1 from app.jobs p join app.audio_work a on a.tenant_id=p.tenant_id and a.job_id=p.id where p.tenant_id=n.tenant_id and p.evidence_revision_id=n.evidence_revision_id and p.processor_version='long-audio-v1' and p.state='succeeded' and a.state->>'phase' in ('complete','partial'))
on conflict do nothing;
