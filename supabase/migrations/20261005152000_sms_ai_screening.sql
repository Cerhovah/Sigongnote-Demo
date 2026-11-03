-- Explicit all-new SMS consent. Raw screening text is never stored in shared documents or AI usage.
alter table app.product_ai_usage drop constraint product_ai_usage_channel_check;
alter table app.product_ai_usage add constraint product_ai_usage_channel_check check(channel in ('semantic','vision','short_stt','long_stt','agent','sms_triage'));
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
 if p_revision is null and p_channel<>'sms_triage' then return false;end if;
 select c.*,d.active device_active into s from app.capture_sources c join app.devices d on d.tenant_id=c.tenant_id and d.id=c.device_id
  where c.tenant_id=p_tenant and c.id=p_source and c.user_id=p_user for share of c;
 if not found or not s.active or not s.device_active or not s.local_selection_consent or not s.server_upload_consent or not s.external_ai_consent or s.generation is distinct from p_generation then return false; end if;
 if s.processing_policy is null or s.processing_policy is distinct from p_config->'policy'
  or s.processing_policy->'external_processing' is distinct from 'true'::jsonb
  or s.processing_policy->>'provider' is distinct from p_config->>'policy_provider' then return false; end if;
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
end $function$
;


create or replace function app.reserve_product_ai(p_tenant uuid,p_user uuid,p_id uuid,p_channel text,p_source uuid,p_generation bigint,p_revision uuid,p_hash text,p_config jsonb,p_reserved bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing app.product_ai_usage; daily bigint; monthly bigint; day_start timestamptz; month_start timestamptz;
begin
 if p_channel is null or p_channel not in ('semantic','vision','short_stt','long_stt','agent','sms_triage') or p_reserved is null or p_reserved not between 1 and 10000 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(p_config)<>'object' or octet_length(p_config::text)>4096 or p_config is null then raise exception 'invalid AI reservation' using errcode='22023'; end if;
 if not app.product_ai_scope_allowed(p_tenant,p_user,p_source,p_generation,p_revision,p_channel,p_config) then return jsonb_build_object('state','scope_blocked'); end if;
 perform pg_advisory_xact_lock(hashtextextended('product-ai-user:'||p_user::text,0));
 select * into existing from app.product_ai_usage where tenant_id=p_tenant and user_id=p_user and id=p_id for update;
 if found then
  if existing.request_hash<>p_hash or existing.config<>p_config or existing.channel<>p_channel or existing.reserved_krw<>p_reserved
   or existing.source_id is distinct from p_source or existing.source_generation is distinct from p_generation or existing.revision_id is distinct from p_revision then raise exception 'AI idempotency conflict' using errcode='23505'; end if;
  return jsonb_build_object('state',existing.state,'id',p_id,'result',existing.result,'reused',true);
 end if;
 day_start=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 month_start=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 -- Unknown or unfinished requests retain their reservation even over a date boundary.
 select coalesce(sum(case when coalesce(submitted_at,created_at)>=day_start or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0),
  coalesce(sum(case when coalesce(submitted_at,created_at)>=month_start or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0)
 into daily,monthly from app.product_ai_usage where user_id=p_user and state<>'released';
 if daily+p_reserved>10000 or monthly+p_reserved>50000 then return jsonb_build_object('state','budget_paused'); end if;
 insert into app.product_ai_usage(tenant_id,user_id,id,channel,source_id,source_generation,revision_id,request_hash,config,reserved_krw)
 values(p_tenant,p_user,p_id,p_channel,p_source,p_generation,p_revision,p_hash,p_config,p_reserved);
 return jsonb_build_object('state','reserved','id',p_id,'reused',false);
end $$;

alter table app.capture_sources drop constraint capture_scope_version;
alter table app.capture_sources add constraint capture_scope_version check (
 (consent_version=1 and scope is null and processing_policy is null) or
 (consent_version=2 and scope is not null and processing_policy is not null
  and jsonb_typeof(scope)='object' and jsonb_typeof(processing_policy)='object'
  and coalesce(scope->>'rule_version'='1'
   and scope->>'fingerprint_algorithm'='hmac-sha256-device-v1'
   and scope->>'scope_mode' in ('work_dedicated','selected_items','mixed_hold','ai_screened')
   and scope->>'history_mode' in ('all','since','selected')
   and ((scope->>'history_mode'='since')=(scope->>'history_since' is not null))
   and scope->>'processing_policy_id'=processing_policy->>'id'
   and processing_policy->>'purpose'='work_records'
   and (not external_ai_consent or processing_policy->>'external_processing'='true')
   and (scope->>'scope_mode'<>'mixed_hold' or not server_upload_consent)
   and (scope->>'scope_mode'<>'ai_screened' or (kind='sms' and scope->>'history_mode'='since' and external_ai_consent and server_upload_consent))
   and case kind
    when 'folder' then scope->>'capture_method' in ('saf_tree','filesystem')
    when 'photos' then scope->>'capture_method' in ('saf_tree','filesystem','selected_media')
    when 'call_recording' then (scope->>'capture_method' in ('saf_tree','filesystem') or (scope->>'capture_method'='manual_share' and scope->>'history_mode'='selected' and scope->>'scope_mode'='selected_items'))
    when 'notifications' then scope->>'capture_method'='notification'
    when 'manual_share' then scope->>'capture_method'='manual_share'
    else scope->>'capture_method'='sms_provider' end,false)));
