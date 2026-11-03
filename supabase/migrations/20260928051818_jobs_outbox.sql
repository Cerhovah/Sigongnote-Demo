-- C06: durable parse queue and operation-keyed outbox. No original bytes or
-- customer text enter jobs; workers receive only scoped IDs and input hashes.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sigongnote_worker') then
    create role sigongnote_worker nologin noinherit nosuperuser nobypassrls;
  end if;
end $$;
grant usage on schema app to sigongnote_worker;
create table app.jobs (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  job_type text not null check (job_type = 'parse_original'),
  evidence_revision_id uuid not null,
  processor_version text not null check (length(processor_version) between 1 and 64),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'queued' check (state in
    ('queued','leased','retry_wait','succeeded','dead','cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  available_at timestamptz not null default now(),
  lease_owner text check (length(lease_owner) between 1 and 128),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text check (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_pkey primary key (tenant_id, id),
  constraint jobs_revision_fk foreign key (tenant_id, evidence_revision_id)
    references app.document_revisions(tenant_id, id) on delete restrict,
  constraint jobs_effect_key unique
    (tenant_id, job_type, evidence_revision_id, processor_version, input_hash),
  constraint jobs_lease_consistent check
    ((state = 'leased') = (lease_expires_at is not null) and
     (lease_expires_at is null or (lease_owner is not null and lease_token is not null)))
);
create index jobs_available_idx on app.jobs(tenant_id, available_at, created_at)
  where state in ('queued','retry_wait','leased');
create index jobs_global_claim_idx on app.jobs(available_at, created_at, tenant_id, id)
  where state in ('queued','retry_wait','leased');

create table app.job_effects (
  tenant_id uuid not null,
  job_id uuid not null,
  job_type text not null,
  evidence_revision_id uuid not null,
  processor_version text not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  result_hash text not null check (result_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint job_effects_pkey primary key (tenant_id, job_id),
  constraint job_effects_job_fk foreign key (tenant_id, job_id)
    references app.jobs(tenant_id, id) on delete restrict,
  constraint job_effects_operation_key unique
    (tenant_id, job_type, evidence_revision_id, processor_version, input_hash)
);

create table app.outbox (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  job_id uuid not null,
  topic text not null check (topic = 'parse_original_ready'),
  operation_key text not null check (length(operation_key) between 1 and 240),
  state text not null default 'pending' check (state in ('pending','published','cancelled')),
  created_at timestamptz not null default now(),
  constraint outbox_pkey primary key (tenant_id, id),
  constraint outbox_job_fk foreign key (tenant_id, job_id)
    references app.jobs(tenant_id, id) on delete restrict,
  constraint outbox_operation_key unique (tenant_id, operation_key)
);

alter table app.jobs enable row level security;
alter table app.job_effects enable row level security;
alter table app.outbox enable row level security;
revoke all on app.jobs, app.job_effects, app.outbox from public, anon, authenticated, service_role;
grant select, insert on app.jobs, app.outbox to sigongnote_api;
grant select on app.job_effects to sigongnote_api;

create policy jobs_read on app.jobs for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy jobs_insert on app.jobs for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy effects_read on app.job_effects for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy outbox_read on app.outbox for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy outbox_insert on app.outbox for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));

create function app.claim_parse_job(p_worker text, p_lease_seconds integer default 60)
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
        and j.attempt_count < 5 and (
          (j.state in ('queued','retry_wait') and j.available_at <= now()) or
          (j.state = 'leased' and j.lease_expires_at <= now()))
      order by j.available_at, j.created_at, j.tenant_id, j.id
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

create function app.extend_parse_job_lease(p_tenant uuid, p_job uuid,
  p_token uuid, p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_lease_seconds not between 30 and 300 then return false; end if;
  update app.jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    updated_at = now()
    where tenant_id = p_tenant and id = p_job and state = 'leased'
      and lease_token = p_token and lease_expires_at > now();
  return found;
end;
$$;

create function app.complete_parse_job(p_tenant uuid, p_job uuid,
  p_token uuid, p_result_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_job app.jobs%rowtype;
begin
  if p_result_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  select * into current_job from app.jobs where tenant_id = p_tenant and id = p_job
    for update;
  if not found or current_job.lease_token is distinct from p_token then return false; end if;
  if current_job.state = 'succeeded' then
    return exists (select 1 from app.job_effects e where e.tenant_id = p_tenant
      and e.job_id = p_job and e.result_hash = p_result_hash);
  end if;
  if current_job.state <> 'leased' or current_job.lease_expires_at <= now() then
    return false;
  end if;
  insert into app.job_effects (tenant_id,job_id,job_type,evidence_revision_id,
    processor_version,input_hash,result_hash)
    values (p_tenant,p_job,current_job.job_type,current_job.evidence_revision_id,
      current_job.processor_version,current_job.input_hash,p_result_hash)
    on conflict (tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
    do nothing;
  if not found then return false; end if;
  update app.jobs set state = 'succeeded', lease_expires_at = null,
    updated_at = now() where tenant_id = p_tenant and id = p_job;
  return true;
end;
$$;

create function app.fail_parse_job(p_tenant uuid, p_job uuid, p_token uuid,
  p_error_code text, p_retryable boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare current_job app.jobs%rowtype;
declare next_state text;
declare delay_minutes integer;
begin
  if p_error_code !~ '^[A-Z0-9_]{1,64}$' then return 'invalid'; end if;
  select * into current_job from app.jobs where tenant_id = p_tenant and id = p_job
    for update;
  if not found or current_job.state <> 'leased' or
     current_job.lease_token is distinct from p_token or
     current_job.lease_expires_at <= now() then return 'stale'; end if;
  next_state := case when p_retryable and current_job.attempt_count < 5
    then 'retry_wait' else 'dead' end;
  delay_minutes := case current_job.attempt_count
    when 1 then 1 when 2 then 5 when 3 then 30 else 120 end;
  update app.jobs set state = next_state, lease_expires_at = null,
    available_at = case when next_state = 'retry_wait'
      then now() + make_interval(mins => delay_minutes) else available_at end,
    last_error_code = p_error_code, updated_at = now()
    where tenant_id = p_tenant and id = p_job;
  return next_state;
end;
$$;

revoke all on function app.claim_parse_job(text,integer),
  app.extend_parse_job_lease(uuid,uuid,uuid,integer),
  app.complete_parse_job(uuid,uuid,uuid,text),
  app.fail_parse_job(uuid,uuid,uuid,text,boolean)
  from public, anon, authenticated, service_role, sigongnote_api;
grant execute on function app.claim_parse_job(text,integer),
  app.extend_parse_job_lease(uuid,uuid,uuid,integer),
  app.complete_parse_job(uuid,uuid,uuid,text),
  app.fail_parse_job(uuid,uuid,uuid,text,boolean) to sigongnote_worker;

-- Existing C05 verified revisions are queued without changing their original receipt.
insert into app.jobs (tenant_id,job_type,evidence_revision_id,processor_version,input_hash)
  select r.tenant_id,'parse_original',r.id,'fixture-v1',b.sha256
  from app.document_revisions r join app.evidence_blobs b
    on b.tenant_id = r.tenant_id and b.id = r.blob_id
  on conflict (tenant_id,job_type,evidence_revision_id,processor_version,input_hash) do nothing;
insert into app.outbox (tenant_id,job_id,topic,operation_key)
  select j.tenant_id,j.id,'parse_original_ready',
    'parse_original:' || j.id::text from app.jobs j
  on conflict (tenant_id,operation_key) do nothing;
