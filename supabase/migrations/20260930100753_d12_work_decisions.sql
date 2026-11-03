-- D12: typed work decisions share one transaction with existing cost adjustments.
create table app.owner_policies (
 tenant_id uuid not null references app.tenants(id),id uuid not null default gen_random_uuid(),
 grantor_user_id uuid not null references auth.users(id),version integer not null default 1 check(version>0),
 allowed_effects text[] not null check(cardinality(allowed_effects)>0 and allowed_effects <@ array['schedule','acceptance','quality','liability','charge_adjustment','prepare_invoice']),
 max_amount_minor numeric not null check(max_amount_minor>=0 and max_amount_minor=trunc(max_amount_minor)),
 valid_until timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default now(),
 primary key(tenant_id,id)
);
alter table app.decisions alter column actor_id drop not null;
alter table app.decisions add column actor_kind text not null default 'human' check(actor_kind in ('human','system'));
alter table app.decisions add column execution_principal text;
alter table app.decisions add column grantor_user_id uuid references auth.users(id);
alter table app.decisions add column policy_id uuid;
alter table app.decisions add column policy_version integer;
alter table app.decisions add foreign key(tenant_id,policy_id) references app.owner_policies(tenant_id,id);
alter table app.decisions add constraint decision_executor_check check(
 (actor_kind='human' and actor_id is not null and execution_principal is null and grantor_user_id is null and policy_id is null and policy_version is null) or
 (actor_kind='system' and actor_id is null and execution_principal='owner-policy-v1' and grantor_user_id is not null and policy_id is not null and policy_version is not null));
-- System inserts stay closed until D13 adds a scope-checked executor guard.
create table app.work_decision_cases (
 tenant_id uuid not null,id uuid not null,context_id uuid not null,project_id uuid not null,
 category text not null check(category in ('schedule','material','defect','change','billing')),
 issue_key text not null,basis_hash text not null,source_refs jsonb not null,evidence_ids uuid[] not null,
 prompt text not null,proposal jsonb not null,created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,issue_key,basis_hash),
 foreign key(tenant_id,id) references app.exception_cases(tenant_id,id),
 foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),
 foreign key(tenant_id,project_id) references app.projects(tenant_id,id)
);
create table app.work_projections (
 tenant_id uuid not null,context_id uuid not null,version bigint not null default 1,
 state jsonb not null default '{}',decision_id uuid,
 primary key(tenant_id,context_id),foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),
 foreign key(tenant_id,decision_id) references app.decisions(tenant_id,id)
);
create table app.work_command_effects (
 tenant_id uuid not null,id uuid not null default gen_random_uuid(),command_id uuid not null,decision_id uuid not null,
 context_id uuid not null,before_state jsonb not null,after_state jsonb not null,effects jsonb not null,
 created_at timestamptz not null default now(),primary key(tenant_id,id),unique(tenant_id,command_id),
 foreign key(tenant_id,decision_id) references app.decisions(tenant_id,id),
 foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id)
);
create table app.work_decision_outbox (
 tenant_id uuid not null,decision_id uuid not null,payload jsonb not null,created_at timestamptz not null default now(),
 primary key(tenant_id,decision_id),foreign key(tenant_id,decision_id) references app.decisions(tenant_id,id)
);
do $$ declare t text;begin foreach t in array array['owner_policies','work_decision_cases','work_projections','work_command_effects','work_decision_outbox'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('revoke all on app.%I from public,anon,authenticated,service_role,sigongnote_worker',t);
 execute format('grant select,insert on app.%I to sigongnote_api',t);
 execute format('create policy tenant_read on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''operator'',''accountant'']))',t);
 execute format('create policy owner_insert on app.%I for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array[''owner'']))',t);
end loop;end $$;
grant update on app.work_projections,app.owner_policies to sigongnote_api;
create policy owner_update on app.work_projections for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy owner_update on app.owner_policies for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create trigger sync_work_decision after insert on app.work_command_effects for each row execute function app.record_sync_change('reset','context_id');
