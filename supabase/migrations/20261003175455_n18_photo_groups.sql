-- Photo selections reference original revisions; bytes and EXIF never change here.
create table app.photo_groups (
 tenant_id uuid not null references app.tenants(id),id uuid not null,
 project_id uuid not null,context_id uuid,actor_id uuid not null references auth.users(id),
 version integer not null default 1 check(version>0),created_at timestamptz not null default now(),
 primary key(tenant_id,id),foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id)
);
create table app.photo_group_versions (
 tenant_id uuid not null,group_id uuid not null,version integer not null check(version>0),
 title text not null check(length(title) between 1 and 120),photos jsonb not null check(jsonb_typeof(photos)='array' and jsonb_array_length(photos) between 1 and 20),
 snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),actor_id uuid not null references auth.users(id),created_at timestamptz not null default now(),
 primary key(tenant_id,group_id,version),foreign key(tenant_id,group_id) references app.photo_groups(tenant_id,id)
);
create index photo_groups_project on app.photo_groups(tenant_id,project_id,created_at desc,id);
do $$declare t text;begin foreach t in array array['photo_groups','photo_group_versions'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('revoke all on app.%I from public,anon,authenticated,service_role,sigongnote_worker',t);
 execute format('grant select,insert on app.%I to sigongnote_api',t);
 execute format('create policy scoped_read on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''accountant'']))',t);
 execute format('create policy scoped_insert on app.%I for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array[''owner'']) and actor_id=auth.uid())',t);
end loop;end $$;
grant update(version) on app.photo_groups to sigongnote_api;
create policy scoped_update on app.photo_groups for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
