-- C04: current Auth session and device scope. Only the Fastify role can
-- access these private tables/functions; browser clients cannot query them.
create table app.devices (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  platform text not null check (platform in ('android', 'windows')),
  public_key_jwk jsonb not null,
  public_key_sha256 text not null check (public_key_sha256 ~ '^[0-9a-f]{64}$'),
  app_version text not null check (length(app_version) between 1 and 64),
  registration_key uuid not null,
  registration_hash text not null check (registration_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  revoked_at timestamptz,
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_pkey primary key (tenant_id, id),
  constraint devices_member_fk foreign key (tenant_id, user_id)
    references app.memberships(tenant_id, user_id) on delete restrict,
  constraint devices_registration_key unique (tenant_id, user_id, registration_key),
  constraint devices_public_key_key unique (tenant_id, user_id, public_key_sha256),
  constraint devices_revocation_consistent check (active = (revoked_at is null))
);
create index devices_tenant_user_idx on app.devices(tenant_id, user_id);

create table app.command_receipts (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  route text not null check (length(route) between 1 and 180),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status_code integer not null check (status_code between 200 and 299),
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint command_receipts_pkey primary key (tenant_id, id),
  constraint command_receipts_operation_key unique (tenant_id, actor_id, route, idempotency_key)
);

create function app.session_is_active(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_user_id = auth.uid() and exists (
    select 1 from auth.sessions s
    where s.id = p_session_id and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
  );
$$;
revoke all on function app.session_is_active(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.session_is_active(uuid, uuid) to sigongnote_api;

create function app.guard_device_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or
     new.user_id is distinct from old.user_id or new.platform is distinct from old.platform or
     new.public_key_jwk is distinct from old.public_key_jwk or
     new.public_key_sha256 is distinct from old.public_key_sha256 or
     new.registration_key is distinct from old.registration_key or
     new.registration_hash is distinct from old.registration_hash or
     new.created_at is distinct from old.created_at or
     (not old.active and new.active) or new.version <> old.version + 1 then
    raise exception 'Device identity or revocation is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_device_change() from public, anon, authenticated, service_role;
create trigger devices_change_guard before update on app.devices
  for each row execute function app.guard_device_change();

alter table app.devices enable row level security;
alter table app.command_receipts enable row level security;
revoke all on app.devices, app.command_receipts from public, anon, authenticated, service_role;
grant select, insert, update on app.devices to sigongnote_api;
grant select, insert on app.command_receipts to sigongnote_api;

create policy devices_read on app.devices for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner']) or
    (user_id = (select auth.uid()) and
     app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer'])));
create policy devices_insert on app.devices for insert to sigongnote_api
  with check (user_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy devices_update on app.devices for update to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner']) or
    (user_id = (select auth.uid()) and
     app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer'])))
  with check (app.has_tenant_role(tenant_id, array['owner']) or
    (user_id = (select auth.uid()) and
     app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer'])));

create policy command_receipts_read on app.command_receipts for select to sigongnote_api
  using (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy command_receipts_insert on app.command_receipts for insert to sigongnote_api
  with check (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
