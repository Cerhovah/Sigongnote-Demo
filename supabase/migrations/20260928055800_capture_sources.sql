-- C07: consent is an append-only user decision. OS permission reports are a
-- separate, untrusted observation until the native client can attest them.
create table app.capture_sources (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  device_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in
    ('manual_share','folder','notifications','photos','call_recording','sms','call_log')),
  capability text not null check (capability in
    ('unsupported','manual_only','selected_items','passive','policy_gated')),
  permission text not null default 'not_requested' check (permission in
    ('not_requested','granted','denied','revoked','role_missing')),
  reported_permission text check (reported_permission in
    ('not_requested','granted','denied','revoked','role_missing')),
  permission_checked_at timestamptz,
  health text not null default 'not_started' check (health in
    ('not_started','scanning','current','delayed','source_offline','paused','error')),
  scope_fingerprint text not null check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  scope_version integer not null default 1 check (scope_version > 0),
  cursor_token text check (cursor_token ~ '^[0-9a-f]{64}$'),
  coverage_from timestamptz,
  last_successful_scan_at timestamptz,
  last_event_at timestamptz,
  last_server_ack_at timestamptz,
  pending_count integer not null default 0 check (pending_count >= 0),
  bytes_pending bigint not null default 0 check (bytes_pending >= 0),
  last_error_code text check (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  local_selection_consent boolean not null,
  server_upload_consent boolean not null,
  external_ai_consent boolean not null,
  consent_version integer not null check (consent_version > 0),
  generation integer not null default 1 check (generation > 0),
  active boolean not null default true,
  revoked_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_sources_pkey primary key (tenant_id,id),
  constraint capture_sources_device_fk foreign key (tenant_id,device_id)
    references app.devices(tenant_id,id) on delete restrict,
  constraint capture_sources_revocation check (active = (revoked_at is null)),
  constraint capture_sources_consent_scope check
    (not server_upload_consent or local_selection_consent)
);
create index capture_sources_device_idx on app.capture_sources(tenant_id,device_id,active);
create unique index capture_sources_active_scope_key on app.capture_sources
  (tenant_id,device_id,kind,scope_fingerprint) where active;

create table app.consent_grants (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  source_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  event text not null check (event in ('granted','revoked')),
  initiated_by text not null check (initiated_by in ('subject','owner','device_revoke')),
  generation integer not null check (generation > 0),
  consent_version integer not null check (consent_version > 0),
  scope_fingerprint text not null check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  local_selection boolean not null,
  server_upload boolean not null,
  external_ai boolean not null,
  recorded_at timestamptz not null default now(),
  constraint consent_grants_pkey primary key (tenant_id,id),
  constraint consent_grants_source_fk foreign key (tenant_id,source_id)
    references app.capture_sources(tenant_id,id) on delete restrict,
  constraint consent_grants_generation_key unique (tenant_id,source_id,generation),
  constraint consent_grants_revoked_scope check
    (event <> 'revoked' or
      (not local_selection and not server_upload and not external_ai))
);
create function app.reject_consent_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Consent history is append-only' using errcode = '23514';
end;
$$;
revoke all on function app.reject_consent_mutation()
  from public, anon, authenticated, service_role, sigongnote_api, sigongnote_worker;
create trigger consent_grants_immutable before update or delete on app.consent_grants
  for each row execute function app.reject_consent_mutation();

alter table app.capture_sources enable row level security;
alter table app.consent_grants enable row level security;
revoke all on app.capture_sources, app.consent_grants
  from public, anon, authenticated, service_role;
grant select,insert on app.capture_sources to sigongnote_api;
grant update (reported_permission,permission_checked_at,cursor_token,
  coverage_from,last_successful_scan_at,last_event_at,pending_count,bytes_pending,
  last_error_code,last_server_ack_at,version,updated_at)
  on app.capture_sources to sigongnote_api;
grant select,insert on app.consent_grants to sigongnote_api;
create policy capture_sources_read on app.capture_sources for select to sigongnote_api
  using (user_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']));
create policy capture_sources_insert on app.capture_sources for insert to sigongnote_api
  with check (user_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id,array['owner','operator']));
create policy capture_sources_update on app.capture_sources for update to sigongnote_api
  using (user_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']))
  with check (user_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']));
create policy consent_grants_read on app.consent_grants for select to sigongnote_api
  using (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']));
create policy consent_grants_insert on app.consent_grants for insert to sigongnote_api
  with check (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id,array['owner','operator']));

alter table app.upload_intents add column source_generation integer;
alter table app.upload_intents add constraint upload_intents_source_fk
  foreign key (tenant_id,source_id)
  references app.capture_sources(tenant_id,id) on delete restrict;
alter table app.upload_intents add constraint upload_intents_source_generation_check
  check ((source_id is null) = (source_generation is null));
alter table app.upload_intents drop constraint upload_intents_rejection_reason_check;
alter table app.upload_intents add constraint upload_intents_rejection_reason_check
  check (rejection_reason in
    ('hash_mismatch','expired','stale_document','source_revoked'));

-- Called only by the API after checking actor, source ownership and If-Match.
-- Its table changes are atomic with the consent ledger and command receipt.
create function app.stop_capture_source(p_tenant uuid,p_source uuid,p_actor uuid,
  p_reason text default 'direct')
returns integer language plpgsql security definer set search_path = '' as $$
declare current_source app.capture_sources%rowtype;
begin
  if p_actor is distinct from auth.uid() or not
    app.has_tenant_role(p_tenant,array['owner','operator','accountant','viewer']) then
    raise exception 'Forbidden source stop' using errcode = '42501';
  end if;
  select * into current_source from app.capture_sources
    where tenant_id = p_tenant and id = p_source and
      (user_id = p_actor or app.has_tenant_role(p_tenant,array['owner']))
    for update;
  if not found then raise exception 'Source missing' using errcode = '42501'; end if;
  if p_reason not in ('direct','device_revoke') then
    raise exception 'Invalid source stop reason' using errcode = '23514';
  end if;
  if not current_source.active then return current_source.version; end if;
  update app.capture_sources set active = false, revoked_at = now(),
    local_selection_consent = false,server_upload_consent = false,
    external_ai_consent = false,health = 'paused',
    generation = generation + 1,version = version + 1,updated_at = now()
    where tenant_id = p_tenant and id = p_source;
  insert into app.consent_grants (tenant_id,source_id,actor_id,event,initiated_by,generation,
    consent_version,scope_fingerprint,local_selection,server_upload,external_ai)
    values (p_tenant,p_source,p_actor,'revoked',
      case when p_reason = 'device_revoke' then 'device_revoke'
        when current_source.user_id = p_actor then 'subject' else 'owner' end,
      current_source.generation + 1,
      current_source.consent_version,current_source.scope_fingerprint,false,false,false);
  update app.upload_intents set status = 'rejected',rejection_reason = 'source_revoked'
    where tenant_id = p_tenant and source_id = p_source and status = 'prepared';
  update app.jobs j set state = 'cancelled',lease_expires_at = null,
    updated_at = now()
    from app.upload_intents i where i.tenant_id = p_tenant and
      i.source_id = p_source and i.completed_revision_id = j.evidence_revision_id and
      j.tenant_id = p_tenant and j.state in ('queued','retry_wait','leased');
  update app.outbox o set state = 'cancelled' from app.jobs j
    join app.upload_intents i on i.tenant_id = j.tenant_id and
      i.completed_revision_id = j.evidence_revision_id
    where o.tenant_id = p_tenant and o.job_id = j.id and
      j.tenant_id = p_tenant and i.source_id = p_source and o.state = 'pending';
  return current_source.version + 1;
end;
$$;
revoke all on function app.stop_capture_source(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role, sigongnote_worker;
grant execute on function app.stop_capture_source(uuid,uuid,uuid,text) to sigongnote_api;

create function app.stop_device_sources(p_tenant uuid,p_device uuid,p_actor uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare device_owner uuid;
declare source_row record;
declare stopped integer := 0;
begin
  if p_actor is distinct from auth.uid() or not
    app.has_tenant_role(p_tenant,array['owner','operator','accountant','viewer']) then
    raise exception 'Forbidden device stop' using errcode = '42501';
  end if;
  select user_id into device_owner from app.devices
    where tenant_id = p_tenant and id = p_device;
  if not found or (device_owner <> p_actor and not
    app.has_tenant_role(p_tenant,array['owner'])) then
    raise exception 'Device missing' using errcode = '42501';
  end if;
  for source_row in select id from app.capture_sources
    where tenant_id = p_tenant and device_id = p_device and active
    order by id
  loop
    perform app.stop_capture_source(p_tenant,source_row.id,p_actor,'device_revoke');
    stopped := stopped + 1;
  end loop;
  return stopped;
end;
$$;
revoke all on function app.stop_device_sources(uuid,uuid,uuid)
  from public, anon, authenticated, service_role, sigongnote_worker;
grant execute on function app.stop_device_sources(uuid,uuid,uuid) to sigongnote_api;

-- Worker completion is the durable boundary: a revoked source must never
-- produce an effect even if the lease was acquired before revocation.
create or replace function app.complete_parse_job(p_tenant uuid,p_job uuid,
  p_token uuid,p_result_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_job app.jobs%rowtype;
declare linked_source app.capture_sources%rowtype;
begin
  if p_result_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  select s.* into linked_source from app.capture_sources s
    join app.upload_intents i on i.tenant_id = s.tenant_id and i.source_id = s.id
    join app.jobs j on j.tenant_id = i.tenant_id and
      j.evidence_revision_id = i.completed_revision_id
    where j.tenant_id = p_tenant and j.id = p_job for share of s;
  if found and (not linked_source.active or not linked_source.server_upload_consent or
      not exists (select 1 from app.devices d where d.tenant_id = p_tenant and
        d.id = linked_source.device_id and d.active)) then return false; end if;
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
  update app.jobs set state = 'succeeded',lease_expires_at = null,
    updated_at = now() where tenant_id = p_tenant and id = p_job;
  return true;
end;
$$;
