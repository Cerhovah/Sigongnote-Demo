-- C03: the API is the only business-table entry point. The app schema is not
-- exposed by PostgREST; its grants and RLS are a second tenant boundary.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sigongnote_api') then
    create role sigongnote_api nologin noinherit nobypassrls;
  end if;
end $$;
grant usage on schema app to sigongnote_api;
-- The migration administrator needs SET ROLE to run the isolation oracle.
-- Application connections use a separate non-bypass role (provisioned in C04).
grant sigongnote_api to postgres;

create table app.tenants (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.memberships (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('owner','operator','accountant','viewer')),
  active boolean not null default true,
  revoked_at timestamptz,
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_revocation_consistent check (active = (revoked_at is null)),
  constraint memberships_pkey primary key (tenant_id, id),
  constraint memberships_tenant_user_key unique (tenant_id, user_id)
);
create index memberships_active_user_idx on app.memberships (user_id, tenant_id)
  where active and revoked_at is null;

create table app.projects (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) between 1 and 180),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_pkey primary key (tenant_id, id)
);
create index projects_tenant_name_idx on app.projects (tenant_id, display_name);

create table app.work_orders (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  project_id uuid,
  display_name text not null check (length(btrim(display_name)) between 1 and 180),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_orders_pkey primary key (tenant_id, id),
  constraint work_orders_project_fk foreign key (tenant_id, project_id)
    references app.projects(tenant_id, id) on delete restrict
);
create index work_orders_tenant_project_idx on app.work_orders (tenant_id, project_id);

create function app.has_tenant_role(p_tenant_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from app.memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = auth.uid()
      and m.active and m.revoked_at is null
      and m.role = any(p_roles)
  );
$$;
revoke all on function app.has_tenant_role(uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function app.has_tenant_role(uuid, text[]) to sigongnote_api;

create function app.guard_membership_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and
     (new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id or
      new.user_id is distinct from old.user_id) then
    raise exception 'Membership identity is immutable' using errcode = '23514';
  end if;
  if old.role = 'owner' and old.active and old.revoked_at is null and
     (tg_op = 'DELETE' or new.role <> 'owner' or not new.active) then
    -- A real write forces a serialization failure if two REPEATABLE READ
    -- transactions try to retire the final two owners concurrently.
    update app.tenants set version = version + 1, updated_at = now()
      where id = old.tenant_id;
    if not exists (
      select 1 from app.memberships m
      where m.tenant_id = old.tenant_id and m.id <> old.id
        and m.role = 'owner' and m.active and m.revoked_at is null
    ) then
      raise exception 'Cannot remove the last active owner' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function app.guard_membership_change() from public, anon, authenticated, service_role;
create trigger memberships_guard before update or delete on app.memberships
  for each row execute function app.guard_membership_change();

create function app.guard_tenant_identity()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'Tenant identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_tenant_identity() from public, anon, authenticated, service_role;
create trigger projects_tenant_guard before update on app.projects
  for each row execute function app.guard_tenant_identity();
create trigger work_orders_tenant_guard before update on app.work_orders
  for each row execute function app.guard_tenant_identity();

alter table app.tenants enable row level security;
alter table app.memberships enable row level security;
alter table app.projects enable row level security;
alter table app.work_orders enable row level security;

revoke all on all tables in schema app from public, anon, authenticated, service_role;
grant select, update on app.tenants to sigongnote_api;
grant select, insert, update on app.memberships to sigongnote_api;
grant select, insert, update on app.projects, app.work_orders to sigongnote_api;

create policy tenants_read on app.tenants for select to sigongnote_api
  using (app.has_tenant_role(id, array['owner','operator','accountant','viewer']));
create policy tenants_update on app.tenants for update to sigongnote_api
  using (app.has_tenant_role(id, array['owner']))
  with check (app.has_tenant_role(id, array['owner']));

create policy memberships_read on app.memberships for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner']) or
    (active and revoked_at is null and user_id = (select auth.uid())));
create policy memberships_insert on app.memberships for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner']));
create policy memberships_update on app.memberships for update to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner']))
  with check (app.has_tenant_role(tenant_id, array['owner']));

create policy projects_read on app.projects for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy projects_insert on app.projects for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy projects_update on app.projects for update to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator']))
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));

create policy work_orders_read on app.work_orders for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy work_orders_insert on app.work_orders for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy work_orders_update on app.work_orders for update to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator']))
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
