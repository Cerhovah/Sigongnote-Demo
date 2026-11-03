-- Device evidence handoff: local originals remain on the explicitly approved device.
create table app.field_captures (
 tenant_id uuid not null, id uuid not null default gen_random_uuid(), source_id uuid not null,
 local_document_id uuid not null, local_revision integer not null check(local_revision>0),
 source_generation integer not null check(source_generation>0), document_id uuid not null, revision_id uuid not null,
 evidence_id uuid not null, source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 parser_version text not null, content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), primary key(tenant_id,id),
 unique(tenant_id,source_id,local_document_id,content_hash),
 foreign key(tenant_id,source_id) references app.capture_sources(tenant_id,id),
 foreign key(tenant_id,document_id) references app.documents(tenant_id,id),
 foreign key(tenant_id,revision_id) references app.document_revisions(tenant_id,id),
 foreign key(tenant_id,evidence_id) references app.evidence_index(tenant_id,id)
);
create table app.field_questions (
 tenant_id uuid not null, id uuid not null, capture_id uuid not null, question text not null,
 answer jsonb, answered_by uuid references auth.users(id), actor_kind text check(actor_kind in ('human','agent_test')),
 updated_at timestamptz not null default now(), primary key(tenant_id,id),
 foreign key(tenant_id,id) references app.exception_cases(tenant_id,id),
 foreign key(tenant_id,capture_id) references app.field_captures(tenant_id,id)
);
create table app.field_events (
 tenant_id uuid not null, event_id uuid not null, schema_version integer not null default 1,
 user_id uuid not null references auth.users(id), device_id uuid not null,
 session_id uuid not null, task_id uuid, document_id uuid, operation_id uuid,
 actor text not null check(actor in ('human','system','ai','agent_test')),
 client_time timestamptz not null, received_at timestamptz not null default now(),
 device_sequence bigint not null check(device_sequence>=0), app_version text not null,
 screen_id text not null, control_id text not null, result_code text not null,
 active_ms integer not null check(active_ms between 0 and 60000), latency_ms integer not null check(latency_ms between 0 and 600000),
 consent_version integer not null check(consent_version=1), primary key(tenant_id,event_id),
 foreign key(tenant_id,device_id) references app.devices(tenant_id,id)
);
-- Service operators are explicitly provisioned by an administrator, never by client metadata.
create table app.field_operators(user_id uuid primary key references auth.users(id), active boolean not null default true);
create table app.field_observation_grants(tenant_id uuid not null references app.tenants(id),operator_id uuid not null references app.field_operators(user_id),
 active boolean not null default true,consent_version integer not null check(consent_version=1), primary key(tenant_id,operator_id));
create table app.field_operator_access(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),created_at timestamptz not null default now(),action text not null);
alter table app.field_captures enable row level security;
alter table app.field_questions enable row level security;
alter table app.field_events enable row level security;
alter table app.field_operators enable row level security;
alter table app.field_observation_grants enable row level security;
alter table app.field_operator_access enable row level security;
revoke all on app.field_captures,app.field_questions,app.field_events,app.field_operators,app.field_observation_grants,app.field_operator_access from public,anon,authenticated,service_role;
grant select,insert on app.field_captures,app.field_events to sigongnote_api;
grant select,insert,update on app.field_questions to sigongnote_api;
grant select on app.field_operators,app.field_observation_grants to sigongnote_api;
grant insert on app.field_operator_access to sigongnote_api;
create policy field_operators_self on app.field_operators for select to sigongnote_api using(user_id=auth.uid() and active);
create policy field_grants_self on app.field_observation_grants for select to sigongnote_api using(operator_id=auth.uid() and active);
create policy field_access_write on app.field_operator_access for insert to sigongnote_api with check(user_id=auth.uid() and exists(select 1 from app.field_operators where user_id=auth.uid() and active));
create policy field_captures_read on app.field_captures for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy field_captures_write on app.field_captures for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner','operator']));
create policy field_questions_read on app.field_questions for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy field_questions_write on app.field_questions for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner','operator']));
create policy field_questions_update on app.field_questions for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator'])) with check(app.has_tenant_role(tenant_id,array['owner','operator']));
create policy field_events_read on app.field_events for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','operator']) or
 (exists(select 1 from app.field_operators o where o.user_id=auth.uid() and o.active) and exists(select 1 from app.field_observation_grants g where g.tenant_id=field_events.tenant_id and g.operator_id=auth.uid() and g.active)));
create policy field_events_write on app.field_events for insert to sigongnote_api with check(user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator']));
