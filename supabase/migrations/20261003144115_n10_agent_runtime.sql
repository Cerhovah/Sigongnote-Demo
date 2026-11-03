-- Durable authenticated conversation runs. Model output never grants tool authority.
create table app.agent_runs (
 tenant_id uuid not null references app.tenants(id),id uuid not null,user_id uuid not null references auth.users(id),session_id uuid not null,
 client_turn_id uuid not null,project_id uuid,instruction text not null check(length(instruction) between 1 and 2000),input_kind text not null check(input_kind in ('text','voice')),
 evidence_refs uuid[] not null default '{}',request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 status text not null default 'queued' check(status in ('queued','running','completed','needs_answer','cancelled','failed')),
 rounds integer not null default 0 check(rounds between 0 and 4),tool_count integer not null default 0 check(tool_count between 0 and 8),
 plan jsonb,plan_cursor integer not null default 0,lease_token uuid,lease_until timestamptz,error_code text,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,id),unique(tenant_id,user_id,client_turn_id),foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 check(cardinality(evidence_refs)<=10),check(octet_length(plan::text)<=32768)
);
create index agent_pending on app.agent_runs(status,lease_until,created_at) where status in ('queued','running');
create table app.agent_steps (
 tenant_id uuid not null,run_id uuid not null,sequence integer not null check(sequence between 1 and 8),tool text not null,
 input jsonb not null,result jsonb not null,input_hash text not null,result_hash text not null,
 created_at timestamptz not null default clock_timestamp(),primary key(tenant_id,run_id,sequence),foreign key(tenant_id,run_id) references app.agent_runs(tenant_id,id),
 check(octet_length(input::text)<=16384),check(octet_length(result::text)<=65536)
);
alter table app.agent_runs enable row level security;
alter table app.agent_steps enable row level security;
revoke all on app.agent_runs,app.agent_steps from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.agent_runs to sigongnote_api;
grant select,insert on app.agent_steps to sigongnote_api;
create policy agent_own on app.agent_runs to sigongnote_api using(user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant'])) with check(user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy agent_steps_own on app.agent_steps to sigongnote_api using(exists(select 1 from app.agent_runs r where r.tenant_id=agent_steps.tenant_id and r.id=run_id)) with check(exists(select 1 from app.agent_runs r where r.tenant_id=agent_steps.tenant_id and r.id=run_id));
-- Only the trusted API scheduler receives identity metadata for an already-authenticated durable request.
create function app.claim_agent_run(scope_tenant uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r app.agent_runs;
begin
 update app.agent_runs a set status='needs_answer',error_code='scope_blocked',lease_token=null,lease_until=null,updated_at=clock_timestamp()
 where (a.tenant_id,a.id) in (select x.tenant_id,x.id from app.agent_runs x where x.status in ('queued','running') and (scope_tenant is null or x.tenant_id=scope_tenant)
 and (not exists(select 1 from auth.sessions s where s.user_id=x.user_id and s.id=x.session_id and (s.not_after is null or s.not_after>now()))
 or not exists(select 1 from app.memberships m where m.tenant_id=x.tenant_id and m.user_id=x.user_id and m.active and m.revoked_at is null and m.role in ('owner','operator','accountant')))
 order by x.updated_at,x.id limit 50 for update skip locked);
 select a.* into r from app.agent_runs a where a.status in ('queued','running') and (a.lease_until is null or a.lease_until<clock_timestamp()) and (scope_tenant is null or a.tenant_id=scope_tenant)
 and exists(select 1 from auth.sessions s where s.user_id=a.user_id and s.id=a.session_id and (s.not_after is null or s.not_after>now())) and exists(select 1 from app.memberships m where m.tenant_id=a.tenant_id and m.user_id=a.user_id and m.active and m.revoked_at is null and m.role in ('owner','operator','accountant'))
 order by a.updated_at,a.id limit 1 for update skip locked;
 if not found then return null;end if;
 update app.agent_runs set status='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() where tenant_id=r.tenant_id and id=r.id returning * into r;
 return jsonb_build_object('tenant',r.tenant_id,'id',r.id,'userId',r.user_id,'sessionId',r.session_id,'token',r.lease_token);
end $$;
revoke all on function app.claim_agent_run(uuid) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.claim_agent_run(uuid) to sigongnote_api;

alter table app.product_ai_usage drop constraint product_ai_usage_channel_check;
alter table app.product_ai_usage add constraint product_ai_usage_channel_check check(channel in ('semantic','vision','short_stt','long_stt','agent'));
-- Name is pinned by the original migration; find only the exact source/channel constraint.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='app.product_ai_usage'::regclass and contype='c' and pg_get_constraintdef(oid) like '%source_id IS NOT NULL%short_stt%' loop
 execute format('alter table app.product_ai_usage drop constraint %I',c.conname);
 end loop;
end $$;
alter table app.product_ai_usage add constraint product_ai_agent_source check(source_id is not null or channel in ('short_stt','agent'));

create or replace function app.product_ai_scope_allowed(p_tenant uuid,p_user uuid,p_source uuid,p_generation bigint,p_revision uuid,p_channel text,p_config jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
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
 if p_channel='long_stt' and p_config->>'policy_provider' is distinct from 'clova_speech' then return false; end if;
 if p_revision is not null and not exists(select 1 from app.upload_intents i where i.tenant_id=p_tenant and i.completed_revision_id=p_revision and i.source_id=p_source and i.source_generation=p_generation) then return false; end if;
 if p_revision is not null and exists(select 1 from app.evidence_retention_tasks w where w.tenant_id=p_tenant and w.revision_id=p_revision) then return false;end if;
 return true;
end $$;

create or replace function app.reserve_product_ai(p_tenant uuid,p_user uuid,p_id uuid,p_channel text,p_source uuid,p_generation bigint,p_revision uuid,p_hash text,p_config jsonb,p_reserved bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing app.product_ai_usage; daily bigint; monthly bigint; day_start timestamptz; month_start timestamptz;
begin
 if p_channel is null or p_channel not in ('semantic','vision','short_stt','long_stt','agent') or p_reserved is null or p_reserved not between 1 and 10000 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
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
