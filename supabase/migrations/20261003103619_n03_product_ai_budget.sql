-- N03: all product providers share a user budget across companies. Candidate results are source-protected; general logs never contain source text.
create table app.product_ai_usage (
 tenant_id uuid not null references app.tenants(id), user_id uuid not null references auth.users(id),
 id uuid not null, channel text not null check(channel in ('semantic','vision','short_stt','long_stt')),
 source_id uuid, source_generation bigint, revision_id uuid,
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
 config jsonb not null check(jsonb_typeof(config)='object' and octet_length(config::text)<=4096),
 state text not null default 'reserved' check(state in ('reserved','submitted','settled','unknown','released')),
 reserved_krw bigint not null check(reserved_krw between 1 and 10000),
 actual_krw bigint check(actual_krw>=0), result jsonb check(octet_length(result::text)<=131072), evidence_withdrawn boolean not null default false,
 receipt text check(length(receipt)<=300), usage jsonb not null default '{}'::jsonb check(octet_length(usage::text)<=2048),
 created_at timestamptz not null default now(), submitted_at timestamptz, updated_at timestamptz not null default now(),
 primary key(tenant_id,user_id,id),
 foreign key(tenant_id,source_id) references app.capture_sources(tenant_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id) on delete set null (revision_id),
 check((source_id is null)=(source_generation is null)),
 check(source_id is not null or channel='short_stt')
);
create index product_ai_user_period on app.product_ai_usage(user_id,created_at);
alter table app.product_ai_usage enable row level security;
revoke all on app.product_ai_usage from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
grant select on app.product_ai_usage to sigongnote_api;
create policy product_ai_own_read on app.product_ai_usage for select to sigongnote_api
 using(user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant']));

create function app.product_ai_scope_allowed(p_tenant uuid,p_user uuid,p_source uuid,p_generation bigint,p_revision uuid,p_channel text,p_config jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare s record;
begin
 -- API routes enter inAuthorizedTransaction, which verifies the session then sets claim.sub.
 if session_user='sigongnote_api' and auth.uid() is distinct from p_user then return false; end if;
 if not exists(select 1 from app.memberships m where m.tenant_id=p_tenant and m.user_id=p_user and m.active and m.revoked_at is null and m.role in ('owner','operator','accountant')) then return false; end if;
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
 if p_channel='long_stt' and p_config->>'policy_provider' is distinct from 'clova_speech' then return false; end if;
 if p_revision is not null and not exists(select 1 from app.upload_intents i where i.tenant_id=p_tenant and i.completed_revision_id=p_revision and i.source_id=p_source and i.source_generation=p_generation) then return false; end if;
 if p_revision is not null and exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=p_tenant and w.revision_id=p_revision) then return false;end if;
 return true;
end $$;
revoke all on function app.product_ai_scope_allowed(uuid,uuid,uuid,bigint,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function app.product_ai_scope_allowed(uuid,uuid,uuid,bigint,uuid,text,jsonb) to sigongnote_api,sigongnote_worker;

create function app.reserve_product_ai(p_tenant uuid,p_user uuid,p_id uuid,p_channel text,p_source uuid,p_generation bigint,p_revision uuid,p_hash text,p_config jsonb,p_reserved bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing app.product_ai_usage; daily bigint; monthly bigint; day_start timestamptz; month_start timestamptz;
begin
 if p_channel is null or p_channel not in ('semantic','vision','short_stt','long_stt') or p_reserved is null or p_reserved not between 1 and 10000 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
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
revoke all on function app.reserve_product_ai(uuid,uuid,uuid,text,uuid,bigint,uuid,text,jsonb,bigint) from public,anon,authenticated,service_role;
grant execute on function app.reserve_product_ai(uuid,uuid,uuid,text,uuid,bigint,uuid,text,jsonb,bigint) to sigongnote_api,sigongnote_worker;

create function app.submit_product_ai(p_tenant uuid,p_user uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare r app.product_ai_usage;
begin
 select * into r from app.product_ai_usage where tenant_id=p_tenant and user_id=p_user and id=p_id;
 if not found or not app.product_ai_scope_allowed(r.tenant_id,r.user_id,r.source_id,r.source_generation,r.revision_id,r.channel,r.config) then return false; end if;
 update app.product_ai_usage set state='submitted',submitted_at=now(),updated_at=now() where tenant_id=p_tenant and user_id=p_user and id=p_id and state='reserved';
 return found;
end $$;
revoke all on function app.submit_product_ai(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function app.submit_product_ai(uuid,uuid,uuid) to sigongnote_api,sigongnote_worker;

create function app.finish_product_ai(p_tenant uuid,p_user uuid,p_id uuid,p_actual bigint,p_result jsonb,p_receipt text,p_usage jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare r app.product_ai_usage; allowed boolean;
begin
 select * into r from app.product_ai_usage where tenant_id=p_tenant and user_id=p_user and id=p_id;
 if not found then return false; end if;
 if session_user='sigongnote_api' and auth.uid() is distinct from p_user then return false; end if;
 allowed=not r.evidence_withdrawn and app.product_ai_scope_allowed(r.tenant_id,r.user_id,r.source_id,r.source_generation,r.revision_id,r.channel,r.config);
 if p_actual is not null and (p_actual<0 or p_actual>1000000) then raise exception 'invalid usage' using errcode='22023'; end if;
 update app.product_ai_usage set state=case when p_actual is null then 'unknown' else 'settled' end,
  actual_krw=p_actual,result=case when allowed and p_actual is not null then p_result else null end,
  receipt=p_receipt,usage=coalesce(p_usage,'{}'::jsonb),updated_at=now()
  where tenant_id=p_tenant and user_id=p_user and id=p_id and state='submitted';
 return found and allowed;
end $$;
revoke all on function app.finish_product_ai(uuid,uuid,uuid,bigint,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function app.finish_product_ai(uuid,uuid,uuid,bigint,jsonb,text,jsonb) to sigongnote_api,sigongnote_worker;

create function app.clear_product_ai_source_results() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not new.active or not new.external_ai_consent or new.generation<>old.generation then
  update app.product_ai_usage set result=null where tenant_id=new.tenant_id and source_id=new.id and result is not null;
 end if;
 return new;
end $$;
revoke all on function app.clear_product_ai_source_results() from public,anon,authenticated,service_role,sigongnote_api,sigongnote_worker;
create trigger product_ai_source_withdrawal after update of active,external_ai_consent,generation on app.capture_sources
 for each row execute function app.clear_product_ai_source_results();

-- Revoked source/device/session results cannot leak through a previous run's cache.
drop policy product_ai_own_read on app.product_ai_usage;
create policy product_ai_own_read on app.product_ai_usage for select to sigongnote_api
 using(not evidence_withdrawn and user_id=auth.uid() and app.product_ai_scope_allowed(tenant_id,user_id,source_id,source_generation,revision_id,channel,config));

create function app.audio_product_scope(t uuid,jid uuid,token uuid,policy jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record;
begin
 if not app.parse_source_allowed(t,jid,policy) then return null;end if;
 select c.id,c.user_id,c.generation,j.evidence_revision_id into r from app.jobs j
 join app.upload_intents u on u.tenant_id=j.tenant_id and u.completed_revision_id=j.evidence_revision_id
 join app.capture_sources c on c.tenant_id=u.tenant_id and c.id=u.source_id
 where j.tenant_id=t and j.id=jid and j.lease_token=token and j.state='leased' and j.lease_expires_at>now()
  and c.external_ai_consent and c.processing_policy=policy and c.generation=u.source_generation order by c.id limit 1;
 if not found then return null;end if;
 return jsonb_build_object('tenant',t,'user',r.user_id,'source',r.id,'generation',r.generation,'revision',r.evidence_revision_id);
end $$;
revoke all on function app.audio_product_scope(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,sigongnote_api;
grant execute on function app.audio_product_scope(uuid,uuid,uuid,jsonb) to sigongnote_worker;

create function app.product_ai_summary() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'daily_krw',coalesce(sum(case when coalesce(submitted_at,created_at)>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0)::text,
  'monthly_krw',coalesce(sum(case when coalesce(submitted_at,created_at)>=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' or state in ('reserved','submitted','unknown') then coalesce(actual_krw,reserved_krw) else 0 end),0)::text,
  'unknown_count',count(*) filter(where state in ('submitted','unknown')))
 from app.product_ai_usage where user_id=auth.uid() and state<>'released'
$$;
revoke all on function app.product_ai_summary() from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.product_ai_summary() to sigongnote_api;

-- Recovery inventory dynamically includes every app/auth/storage table; this durable ledger
-- is included in full-row/hash comparison. Restore must not replay submitted/unknown calls.
