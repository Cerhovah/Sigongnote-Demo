-- A named processor authorizes only its declared channel. Existing policy snapshots and grants stay unchanged.
create or replace function app.capture_policy_processor(p_policy jsonb,p_purpose text)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare processor jsonb; field text;
begin
 if p_purpose is distinct from 'long_stt' or jsonb_typeof(p_policy) is distinct from 'object' or p_policy->'external_processing' is distinct from 'true'::jsonb then return null; end if;
 if p_policy ? 'processors' then
  if jsonb_typeof(p_policy->'processors') is distinct from 'array' then return null; end if;
  if jsonb_array_length(p_policy->'processors')<>1 then return null; end if;
  processor:=p_policy->'processors'->0;
  if jsonb_typeof(processor) is distinct from 'object' or processor->>'purpose' is distinct from p_purpose
   or not coalesce(processor->>'provider' in ('openai','clova_speech'),false)
   or (select count(*) from jsonb_object_keys(processor))<>5 then return null; end if;
  foreach field in array array['processing_location','storage_location','retention'] loop
   if jsonb_typeof(processor->field) is distinct from 'string' or length(btrim(processor->>field)) not between 1 and 200 then return null; end if;
  end loop;
  return processor;
 end if;
 if not coalesce(p_policy->>'provider' in ('openai','clova_speech'),false) then return null; end if;
 return jsonb_build_object('purpose',p_purpose,'provider',p_policy->>'provider','processing_location',p_policy->>'processing_location',
  'storage_location',p_policy->>'storage_location','retention',p_policy->>'retention');
end $$;
revoke all on function app.capture_policy_processor(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function app.capture_policy_processor(jsonb,text) to sigongnote_api,sigongnote_worker;

create or replace function app.product_ai_scope_allowed(p_tenant uuid,p_user uuid,p_source uuid,p_generation bigint,p_revision uuid,p_channel text,p_config jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare s record;
begin
 if session_user='sigongnote_api' and auth.uid() is distinct from p_user then return false; end if;
 if not exists(select 1 from app.memberships m where m.tenant_id=p_tenant and m.user_id=p_user and m.active and m.revoked_at is null and m.role in ('owner','operator','accountant')) then return false; end if;
 if p_channel='agent' then
  return p_source is null and p_generation is null and p_revision is null and exists(select 1 from app.agent_runs a where a.tenant_id=p_tenant and a.user_id=p_user and a.id::text=p_config->>'run_id' and a.status<>'cancelled' and app.session_is_active(a.user_id,a.session_id));
 end if;
 if p_channel='context' then
  if p_config->>'source_kind'='summary' then return p_source is null and p_generation is null and p_revision is null and app.has_tenant_role(p_tenant,array['owner','operator']); end if;
  return p_source is null and p_generation is null and exists(
   select 1 from app.work_event_sources x
   cross join lateral(select app.context_source_snapshot(x.tenant_id,x.source_kind,x.source_ref) value) src
   where x.tenant_id=p_tenant and x.source_kind=p_config->>'source_kind' and x.source_ref::text=p_config->>'source_ref'
    and src.value->>'actor'=p_user::text and src.value->>'version'=p_config->>'source_version' and src.value->'policy' is not distinct from p_config->'policy'
    and x.source_version=p_config->>'source_version' and x.run_token::text=p_config->>'run_token'
    and (p_revision is null and x.source_kind='local' or p_revision=x.source_ref and x.source_kind='revision'));
 end if;
 if p_source is null then
  return p_channel='short_stt' and exists(select 1 from app.voice_consents c where c.tenant_id=p_tenant and c.user_id=p_user and c.provider_version='short-voice-v1' and c.allowed
   and (extract(epoch from c.updated_at)*1000000)::bigint::text=p_config->>'consent_generation');
 end if;
 if p_revision is null and p_channel<>'sms_triage' then return false;end if;
 select c.*,d.active device_active into s from app.capture_sources c join app.devices d on d.tenant_id=c.tenant_id and d.id=c.device_id
  where c.tenant_id=p_tenant and c.id=p_source and c.user_id=p_user for share of c;
 if not found or not s.active or not s.device_active or not s.local_selection_consent or not s.server_upload_consent or not s.external_ai_consent or s.generation is distinct from p_generation then return false; end if;
 if s.processing_policy is null or s.processing_policy is distinct from p_config->'policy'
  or s.processing_policy->'external_processing' is distinct from 'true'::jsonb then return false; end if;
 if p_channel='long_stt' then
  if app.capture_policy_processor(s.processing_policy,'long_stt') is null or
   app.capture_policy_processor(s.processing_policy,'long_stt')->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 elsif s.processing_policy->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 if p_channel='sms_triage' then
  return p_revision is null and s.kind='sms' and s.scope->>'scope_mode'='ai_screened'
   and s.scope->>'history_mode'='since' and p_config->>'provider'=p_config->>'policy_provider'
   and s.sms_activation->>'source_id'=s.id::text and s.sms_activation->>'generation'=s.generation::text
   and s.sms_activation->>'scope_fingerprint'=s.scope_fingerprint
   and (s.sms_activation->>'expires_at')::timestamptz>now() and s.sms_activation->'revoked_at'='null'::jsonb;
 end if;
 if p_channel in ('semantic','vision') and p_config->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
 if p_channel='long_stt' and not coalesce((p_config->>'policy_provider'='clova_speech' and p_config->>'provider'='clova' and p_config->>'model'='clova-speech') or (p_config->>'policy_provider'='openai' and p_config->>'provider'='openai' and p_config->>'model'='whisper-1'),false) then return false; end if;
 if p_revision is not null and not exists(select 1 from app.upload_intents i where i.tenant_id=p_tenant and i.completed_revision_id=p_revision and i.source_id=p_source and i.source_generation=p_generation) then return false; end if;
 if p_revision is not null and exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=p_tenant and w.revision_id=p_revision) then return false;end if;
 return true;
end $$;

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
 and a.state->>'provider'=case when policy->>'external_processing'='true' then case app.capture_policy_processor(policy,'long_stt')->>'provider' when 'openai' then 'openai' when 'clova_speech' then 'clova' else null end else 'synthetic' end order by case when a.state->>'phase'='complete' then 0 else 1 end,a.updated_at desc,a.job_id limit 1;
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
