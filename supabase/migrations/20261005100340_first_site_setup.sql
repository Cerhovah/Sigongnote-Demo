-- One shared starting point per person/company; material state is read from evidence.
create table app.first_site_setup (
 tenant_id uuid not null references app.tenants(id), user_id uuid not null references auth.users(id),
 project_id uuid, version bigint not null default 1 check(version>0),
 dismissed boolean not null default false, completed boolean not null default false,
 updated_at timestamptz not null default now(), primary key(tenant_id,user_id),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id)
);
alter table app.first_site_setup enable row level security;
revoke all on app.first_site_setup from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.first_site_setup to sigongnote_api;
create policy setup_owned on app.first_site_setup for all to sigongnote_api
 using(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator']))
 with check(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator']));
alter table app.devices drop constraint devices_platform_check;
alter table app.devices add constraint devices_platform_check check(platform in ('android','windows','web'));

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
    source.kind not in ('folder','photos','call_recording','manual_share') or device_active is distinct from true then
    raise exception 'Inactive or mismatched folder source' using errcode='23514';
  end if;
  return new;
end $$;

alter table app.capture_sources drop constraint capture_scope_version;
alter table app.capture_sources add constraint capture_scope_version check (
 (consent_version=1 and scope is null and processing_policy is null) or
 (consent_version=2 and scope is not null and processing_policy is not null
  and jsonb_typeof(scope)='object' and jsonb_typeof(processing_policy)='object'
  and coalesce(scope->>'rule_version'='1'
   and scope->>'fingerprint_algorithm'='hmac-sha256-device-v1'
   and scope->>'scope_mode' in ('work_dedicated','selected_items','mixed_hold')
   and scope->>'history_mode' in ('all','since','selected')
   and ((scope->>'history_mode'='since')=(scope->>'history_since' is not null))
   and scope->>'processing_policy_id'=processing_policy->>'id'
   and processing_policy->>'purpose'='work_records'
   and (not external_ai_consent or processing_policy->>'external_processing'='true')
   and (scope->>'scope_mode'<>'mixed_hold' or not server_upload_consent)
   and case kind
    when 'folder' then scope->>'capture_method' in ('saf_tree','filesystem')
    when 'photos' then scope->>'capture_method' in ('saf_tree','filesystem','selected_media')
    when 'call_recording' then (scope->>'capture_method' in ('saf_tree','filesystem') or (scope->>'capture_method'='manual_share' and scope->>'history_mode'='selected' and scope->>'scope_mode'='selected_items'))
    when 'notifications' then scope->>'capture_method'='notification'
    when 'manual_share' then scope->>'capture_method'='manual_share'
    else scope->>'capture_method'='sms_provider' end,false)));
