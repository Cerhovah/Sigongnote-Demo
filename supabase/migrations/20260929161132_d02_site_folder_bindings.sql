-- D02a: explicit site mapping for a device's selected folder scope; no raw local paths.
create table app.site_folder_bindings (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  device_id uuid not null,
  source_id uuid not null,
  source_generation integer not null check (source_generation > 0),
  scope_fingerprint text not null check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  scope_mode text not null check (scope_mode in ('project','company_common')),
  project_id uuid,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id,id),
  foreign key (tenant_id,device_id) references app.devices(tenant_id,id) on delete restrict,
  foreign key (tenant_id,source_id) references app.capture_sources(tenant_id,id) on delete restrict,
  foreign key (tenant_id,project_id) references app.projects(tenant_id,id) on delete restrict,
  unique (tenant_id,source_id,source_generation,scope_fingerprint),
  check ((scope_mode='project') = (project_id is not null))
);
create index site_folder_bindings_owner_idx on app.site_folder_bindings(tenant_id,user_id,device_id);
create index site_folder_bindings_project_idx on app.site_folder_bindings(tenant_id,project_id);
alter table app.site_folder_bindings enable row level security;
revoke all on app.site_folder_bindings from public,anon,authenticated,service_role;
grant select,insert on app.site_folder_bindings to sigongnote_api;
create policy site_folder_bindings_read on app.site_folder_bindings for select to sigongnote_api
  using (user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']));
create policy site_folder_bindings_insert on app.site_folder_bindings for insert to sigongnote_api
  with check (user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator']));
create function app.guard_site_folder_binding() returns trigger language plpgsql set search_path='' as $$
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
    source.kind not in ('folder','photos','call_recording') or device_active is distinct from true then
    raise exception 'Inactive or mismatched folder source' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function app.guard_site_folder_binding() from public,anon,authenticated,service_role;
create trigger site_folder_bindings_guard before insert on app.site_folder_bindings
  for each row execute function app.guard_site_folder_binding();
