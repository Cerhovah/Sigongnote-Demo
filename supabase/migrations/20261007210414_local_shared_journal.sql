create table if not exists app.local_journal_entries (
 tenant_id uuid not null references app.tenants(id),id uuid not null default gen_random_uuid(),
 device_id uuid not null,local_id uuid not null,actor_id uuid not null references auth.users(id),
 local_revision integer not null default 1 check(local_revision>0),file_name text not null check(length(file_name) between 1 and 255),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),mime text not null,received_at timestamptz not null,project_id uuid,categories text[] not null,
 excerpt text not null default '',source_kind text not null default 'local_file',
 version bigint not null default 1 check(version>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,device_id,local_id),foreign key(tenant_id,device_id) references app.devices(tenant_id,id),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 check(categories <@ array['agreement','drawing_material','delivery_work','billing_payment','inspection_defect'])
);
create index if not exists local_journal_received on app.local_journal_entries(tenant_id,received_at desc,id desc);
alter table app.local_journal_entries enable row level security;
revoke all on app.local_journal_entries from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.local_journal_entries to sigongnote_api;
drop policy if exists tenant_read on app.local_journal_entries;
create policy tenant_read on app.local_journal_entries for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
drop policy if exists tenant_insert on app.local_journal_entries;
create policy tenant_insert on app.local_journal_entries for insert to sigongnote_api with check(actor_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator']));
drop policy if exists tenant_update on app.local_journal_entries;
create policy tenant_update on app.local_journal_entries for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator'])) with check(app.has_tenant_role(tenant_id,array['owner','operator']));
