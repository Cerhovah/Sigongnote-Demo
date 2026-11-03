-- Historical originals and jobs remain intact; bulk analysis is opt-in.
alter table app.jobs add column work_lane text not null default 'current' check(work_lane in ('current','archive'));
create table app.archive_processing (
 tenant_id uuid primary key references app.tenants(id),enabled boolean not null default false,
 version bigint not null default 1,actor_id uuid not null references auth.users(id),updated_at timestamptz not null default now()
);
alter table app.archive_processing enable row level security;
revoke all on app.archive_processing from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.archive_processing to sigongnote_api;
create policy archive_owner on app.archive_processing for all to sigongnote_api
 using(app.has_tenant_role(tenant_id,array['owner']))
 with check(app.has_tenant_role(tenant_id,array['owner']) and actor_id=(select auth.uid()));
-- Existing document imports move out of the daily-work lane, without removing data.
update app.jobs j set work_lane='archive' where j.job_type='parse_original' and exists(
 select 1 from app.upload_intents i join app.capture_sources s on s.tenant_id=i.tenant_id and s.id=i.source_id
 join app.document_revisions r on r.tenant_id=i.tenant_id and r.id=i.completed_revision_id
 where i.tenant_id=j.tenant_id and i.completed_revision_id=j.evidence_revision_id
 and coalesce(s.scope->>'processing_lane','')<>'current' and s.kind in ('folder','manual_share') and r.declared_mime not like 'audio/%' and r.declared_mime not like 'image/%'
 and r.declared_mime<>'application/vnd.sigongnote.message+json');
create index jobs_work_lane_pending on app.jobs(work_lane,available_at,created_at) where state in ('queued','retry_wait');
grant update(work_lane) on app.jobs to sigongnote_api;
create policy jobs_reference on app.jobs for update to sigongnote_api
 using(job_type='parse_original' and app.has_tenant_role(tenant_id,array['owner']) and app.revision_accessible(tenant_id,evidence_revision_id))
 with check(work_lane='current' and job_type='parse_original' and app.has_tenant_role(tenant_id,array['owner']) and app.revision_accessible(tenant_id,evidence_revision_id));

create or replace function app.claim_parse_job(p_worker text, p_lease_seconds integer, p_processor text)
returns table (tenant_id uuid, job_id uuid, lease_token uuid, revision_id uuid,
  expected_sha256 text, processor_version text, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if length(p_worker) not between 1 and 128 or p_lease_seconds not between 30 and 300 then
    raise exception 'Invalid worker lease request' using errcode = '23514';
  end if;
  update app.jobs j set state = 'dead', last_error_code = 'LEASE_EXHAUSTED',
    lease_expires_at = null, updated_at = now()
    where j.processor_version=p_processor and j.state = 'leased'
      and j.lease_expires_at <= now() and j.attempt_count >= 5;
  return query
    with chosen as (
      select j.tenant_id, j.id from app.jobs j
      where j.processor_version=p_processor and j.job_type = 'parse_original'
        and (j.work_lane='current' or exists(select 1 from app.archive_processing a where a.tenant_id=j.tenant_id and a.enabled))
        and j.attempt_count < 5 and (
          (j.state in ('queued','retry_wait') and j.available_at <= now()) or
          (j.state = 'leased' and j.lease_expires_at <= now()))
      order by (j.work_lane='current') desc,j.available_at,j.created_at,j.tenant_id,j.id
      for update skip locked limit 1
    )
    update app.jobs j set state = 'leased', attempt_count = j.attempt_count + 1,
      lease_owner = p_worker, lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from chosen c where j.tenant_id = c.tenant_id and j.id = c.id
    returning j.tenant_id, j.id, j.lease_token, j.evidence_revision_id,
      j.input_hash, j.processor_version, j.attempt_count;
end;
$$;

create or replace function app.claim_parse_job_for_tenant(p_worker text, p_lease_seconds integer, p_processor text, p_tenant uuid)
returns table (tenant_id uuid, job_id uuid, lease_token uuid, revision_id uuid,
  expected_sha256 text, processor_version text, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if length(p_worker) not between 1 and 128 or p_lease_seconds not between 30 and 300 then
    raise exception 'Invalid worker lease request' using errcode = '23514';
  end if;
  update app.jobs j set state = 'dead', last_error_code = 'LEASE_EXHAUSTED',
    lease_expires_at = null, updated_at = now()
    where j.tenant_id=p_tenant and j.processor_version=p_processor and j.state = 'leased'
      and j.lease_expires_at <= now() and j.attempt_count >= 5;
  return query
    with chosen as (
      select j.tenant_id, j.id from app.jobs j
      where j.tenant_id=p_tenant and j.processor_version=p_processor and j.job_type = 'parse_original'
        and (j.work_lane='current' or exists(select 1 from app.archive_processing a where a.tenant_id=j.tenant_id and a.enabled))
        and j.attempt_count < 5 and (
          (j.state in ('queued','retry_wait') and j.available_at <= now()) or
          (j.state = 'leased' and j.lease_expires_at <= now()))
      order by (j.work_lane='current') desc,j.available_at,j.created_at,j.tenant_id,j.id
      for update skip locked limit 1
    )
    update app.jobs j set state = 'leased', attempt_count = j.attempt_count + 1,
      lease_owner = p_worker, lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from chosen c where j.tenant_id = c.tenant_id and j.id = c.id
    returning j.tenant_id, j.id, j.lease_token, j.evidence_revision_id,
      j.input_hash, j.processor_version, j.attempt_count;
end;
$$;

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
  where (j.work_lane='current' or exists(select 1 from app.archive_processing a where a.tenant_id=j.tenant_id and a.enabled)) and i.published and i.chunk_count>0 and j.state='succeeded' and not(j.id=any(coalesce(p_deferred,'{}'))) and (p_tenant is null or i.tenant_id=p_tenant)
   and not exists(select 1 from app.evidence_retention_tasks withdrawn where withdrawn.tenant_id=i.tenant_id and withdrawn.revision_id=i.revision_id)
   and not exists(select 1 from app.evidence_chunk_indexes newer where newer.tenant_id=i.tenant_id and newer.revision_id=i.revision_id and newer.published and (newer.created_at,newer.job_id)>(i.created_at,i.job_id))
  order by (j.work_lane='current') desc,j.created_at desc,i.tenant_id,i.job_id
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

create or replace function app.claim_parse_job(p_worker text, p_lease_seconds integer default 60)
returns table (tenant_id uuid, job_id uuid, lease_token uuid, revision_id uuid,
  expected_sha256 text, processor_version text, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if length(p_worker) not between 1 and 128 or p_lease_seconds not between 30 and 300 then
    raise exception 'Invalid worker lease request' using errcode = '23514';
  end if;
  update app.jobs j set state = 'dead', last_error_code = 'LEASE_EXHAUSTED',
    lease_expires_at = null, updated_at = now()
    where j.state = 'leased'
      and j.lease_expires_at <= now() and j.attempt_count >= 5;
  return query
    with chosen as (
      select j.tenant_id, j.id from app.jobs j
      where j.job_type = 'parse_original'
        and (j.work_lane='current' or exists(select 1 from app.archive_processing a where a.tenant_id=j.tenant_id and a.enabled))
        and j.attempt_count < 5 and (
          (j.state in ('queued','retry_wait') and j.available_at <= now()) or
          (j.state = 'leased' and j.lease_expires_at <= now()))
      order by (j.work_lane='current') desc,j.available_at,j.created_at,j.tenant_id,j.id
      for update skip locked limit 1
    )
    update app.jobs j set state = 'leased', attempt_count = j.attempt_count + 1,
      lease_owner = p_worker, lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from chosen c where j.tenant_id = c.tenant_id and j.id = c.id
    returning j.tenant_id, j.id, j.lease_token, j.evidence_revision_id,
      j.input_hash, j.processor_version, j.attempt_count;
end;
$$;

create or replace function app.guard_site_folder_binding() returns trigger language plpgsql set search_path='' as $$
declare source app.capture_sources%rowtype; device_active boolean;
begin
  if new.user_id is distinct from nullif(current_setting('request.jwt.claim.sub',true),'')::uuid then
    raise exception 'Binding actor mismatch' using errcode='42501';
  end if;
  select d.active into device_active from app.devices d
    where d.tenant_id=new.tenant_id and d.id=new.device_id and d.user_id=new.user_id for share;
  select s.* into source from app.capture_sources s
    where s.tenant_id=new.tenant_id and s.id=new.source_id for share;
  if source.id is null or source.user_id<>new.user_id or source.device_id<>new.device_id or
    not source.active or not source.local_selection_consent or source.generation<>new.source_generation or
    source.kind not in ('folder','photos','call_recording','manual_share','sms') or device_active is distinct from true then
    raise exception 'Inactive or mismatched folder source' using errcode='23514';
  end if;
  return new;
end $$;

-- Resumed pages and corrected/reindexed evidence inherit the revision lane.
create function app.inherit_parse_work_lane() returns trigger language plpgsql set search_path='' as $$
declare lane text;
begin
 if new.job_type='parse_original' and new.evidence_revision_id is not null then
  select j.work_lane into lane from app.jobs j where j.tenant_id=new.tenant_id and j.evidence_revision_id=new.evidence_revision_id and j.job_type='parse_original' order by j.created_at desc,j.id desc limit 1;
  if lane is not null then new.work_lane=lane; end if;
 end if;
 return new;
end $$;
revoke all on function app.inherit_parse_work_lane() from public;
create trigger inherit_parse_work_lane before insert on app.jobs for each row execute function app.inherit_parse_work_lane();
