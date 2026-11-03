-- C30: decisions are append-only; projections carry independent versions.
create table app.decisions (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  scope text not null check (scope in ('project_attribution','economic_transaction_identity','exception_resolution')),
  choice text not null check (length(choice) between 1 and 80),
  target_ids uuid[] not null check (cardinality(target_ids) between 1 and 2),
  target_versions bigint[] not null check (cardinality(target_versions) = cardinality(target_ids)),
  evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 100),
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint decisions_pkey primary key (tenant_id,id)
);
create index decisions_scope_idx on app.decisions(tenant_id,scope,created_at desc);

create table app.evidence_attributions (
  tenant_id uuid not null,
  evidence_index_id uuid not null,
  project_id uuid,
  bundle_id uuid,
  state text not null check (state in ('confirmed','rejected')),
  version bigint not null check (version >= 2),
  decision_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint evidence_attributions_pkey primary key (tenant_id,evidence_index_id),
  constraint evidence_attributions_evidence_fk foreign key (tenant_id,evidence_index_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint evidence_attributions_project_fk foreign key (tenant_id,project_id)
    references app.projects(tenant_id,id) on delete restrict,
  constraint evidence_attributions_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint evidence_attributions_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint evidence_attributions_scope_check check (
    (state='confirmed' and num_nonnulls(project_id,bundle_id)=1) or
    (state='rejected' and project_id is null and bundle_id is null))
);

create table app.transaction_identities (
  tenant_id uuid not null,
  left_revision_id uuid not null,
  right_revision_id uuid not null,
  choice text not null check (choice in ('same_transaction','distinct_transaction')),
  version bigint not null check (version >= 2),
  decision_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint transaction_identities_pkey primary key (tenant_id,left_revision_id,right_revision_id),
  constraint transaction_identities_order_check check (left_revision_id < right_revision_id),
  constraint transaction_identities_left_fk foreign key (tenant_id,left_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint transaction_identities_right_fk foreign key (tenant_id,right_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint transaction_identities_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict
);

create table app.exception_cases (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  bundle_id uuid,
  cause_key text not null check (length(btrim(cause_key)) between 1 and 180),
  cause text not null check (cause in ('safety','today_blocked','payment_due','missing_evidence','amount_conflict','attribution_conflict','source_gap','other')),
  state text not null default 'open' check (state in ('open','awaiting_evidence','awaiting_decision','deferred','resolved','reopened')),
  version bigint not null default 1 check (version >= 1),
  due_at timestamptz,
  next_review_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exception_cases_pkey primary key (tenant_id,id),
  constraint exception_cases_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint exception_cases_deferred_check check ((state='deferred') = (next_review_at is not null))
);
create table app.exception_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  exception_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('deferred','decision','reopened')),
  decision_id uuid,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_at timestamptz not null default now(),
  constraint exception_events_pkey primary key (tenant_id,id),
  constraint exception_events_case_fk foreign key (tenant_id,exception_id)
    references app.exception_cases(tenant_id,id) on delete restrict,
  constraint exception_events_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict
);

alter table app.decisions enable row level security;
alter table app.evidence_attributions enable row level security;
alter table app.transaction_identities enable row level security;
alter table app.exception_cases enable row level security;
alter table app.exception_events enable row level security;
revoke all on app.decisions,app.evidence_attributions,app.transaction_identities,
  app.exception_cases,app.exception_events from public,anon,authenticated,service_role;
grant select,insert on app.decisions,app.exception_events to sigongnote_api;
grant select,insert,update on app.evidence_attributions,app.transaction_identities,
  app.exception_cases to sigongnote_api;
create policy decisions_read on app.decisions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy decisions_insert on app.decisions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']) and actor_id=auth.uid());
create policy attributions_read on app.evidence_attributions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy attributions_insert on app.evidence_attributions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy attributions_update on app.evidence_attributions for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator']))
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy identities_read on app.transaction_identities for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy identities_insert on app.transaction_identities for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy identities_update on app.transaction_identities for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator']))
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy exception_cases_read on app.exception_cases for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy exception_cases_insert on app.exception_cases for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy exception_cases_update on app.exception_cases for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator']))
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy exception_events_read on app.exception_events for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy exception_events_insert on app.exception_events for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']) and actor_id=auth.uid());
