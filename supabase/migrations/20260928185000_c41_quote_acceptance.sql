-- C41: approved quote scope is immutable and acceptance has one contract effect.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval',
    'billing_agreement','cash_identity','cash_application','noncash_settlement',
    'submittal_submission','submittal_reply','defect_link','internal_export',
    'external_handoff','outcome_record','rate_observation','quote_approval',
    'quote_acceptance','quote_cancel'));
alter table app.decisions drop constraint decisions_evidence_ids_check;
alter table app.decisions add constraint decisions_evidence_ids_check check
  ((scope='quote_cancel' and cardinality(evidence_ids)=0) or
   cardinality(evidence_ids) between 1 and 100);

create table app.quote_approvals (
  tenant_id uuid not null,
  id uuid not null,
  quote_id uuid not null,
  revision_id uuid not null,
  decision_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  snapshot jsonb not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint quote_approvals_pkey primary key (tenant_id,id),
  constraint quote_approvals_quote_fk foreign key (tenant_id,quote_id)
    references app.quotes(tenant_id,id) on delete restrict,
  constraint quote_approvals_revision_fk foreign key (tenant_id,revision_id)
    references app.quote_revisions(tenant_id,id) on delete restrict,
  constraint quote_approvals_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint quote_approvals_revision_unique unique (tenant_id,revision_id)
);
create table app.quote_scope_lines (
  tenant_id uuid not null,
  id uuid not null,
  approval_id uuid not null,
  position integer not null check (position>=1),
  display_name text not null check (length(trim(display_name)) between 1 and 180),
  quantity_value text not null,
  unit_code text not null,
  operation text not null check (operation in ('add','delta','replace','remove')),
  target_contract_line_id uuid,
  expected_line_version bigint,
  cost_line_ids uuid[] not null,
  cost_minor numeric not null check (cost_minor>=0),
  supply_minor numeric not null check (supply_minor>=0),
  constraint quote_scope_lines_pkey primary key (tenant_id,id),
  constraint quote_scope_lines_approval_fk foreign key (tenant_id,approval_id)
    references app.quote_approvals(tenant_id,id) on delete restrict,
  constraint quote_scope_lines_position unique (tenant_id,approval_id,position),
  constraint quote_scope_lines_target_check check
    ((operation='add' and target_contract_line_id is null and expected_line_version is null) or
     (operation<>'add' and target_contract_line_id is not null and expected_line_version>=1))
);
create table app.quote_acceptances (
  tenant_id uuid not null,
  id uuid not null,
  approval_id uuid not null,
  quote_id uuid not null,
  revision_id uuid not null,
  decision_id uuid not null,
  acceptance_evidence_id uuid not null,
  acceptance_source_revision_id uuid not null,
  acceptance_source_blob_sha256 text not null check
    (acceptance_source_blob_sha256 ~ '^[0-9a-f]{64}$'),
  work_order_id uuid not null,
  work_bundle_id uuid,
  created_at timestamptz not null default now(),
  constraint quote_acceptances_pkey primary key (tenant_id,id),
  constraint quote_acceptances_approval_fk foreign key (tenant_id,approval_id)
    references app.quote_approvals(tenant_id,id) on delete restrict,
  constraint quote_acceptances_quote_fk foreign key (tenant_id,quote_id)
    references app.quotes(tenant_id,id) on delete restrict,
  constraint quote_acceptances_revision_fk foreign key (tenant_id,revision_id)
    references app.quote_revisions(tenant_id,id) on delete restrict,
  constraint quote_acceptances_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint quote_acceptances_evidence_fk foreign key (tenant_id,acceptance_evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint quote_acceptances_source_fk foreign key (tenant_id,acceptance_source_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint quote_acceptances_order_fk foreign key (tenant_id,work_order_id)
    references app.work_orders(tenant_id,id) on delete restrict,
  constraint quote_acceptances_bundle_fk foreign key (tenant_id,work_bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint quote_acceptances_once unique (tenant_id,approval_id)
  ,constraint quote_acceptances_evidence_once unique (tenant_id,acceptance_evidence_id)
);
create table app.contract_lines (
  tenant_id uuid not null,
  id uuid not null,
  work_order_id uuid not null,
  work_bundle_id uuid,
  display_name text not null,
  unit_code text not null,
  quantity_value text not null,
  supply_minor numeric not null check (supply_minor>=0),
  version bigint not null default 1 check (version>=1),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint contract_lines_pkey primary key (tenant_id,id),
  constraint contract_lines_order_fk foreign key (tenant_id,work_order_id)
    references app.work_orders(tenant_id,id) on delete restrict,
  constraint contract_lines_bundle_fk foreign key (tenant_id,work_bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict
);
create index contract_lines_order_idx on app.contract_lines(tenant_id,work_order_id);
create table app.contract_line_revisions (
  tenant_id uuid not null,
  id uuid not null,
  contract_line_id uuid not null,
  version bigint not null check (version>=1),
  acceptance_id uuid not null,
  operation text not null check (operation in ('add','delta','replace','remove')),
  previous_quantity_value text,
  previous_supply_minor numeric,
  quantity_value text not null,
  supply_minor numeric not null check (supply_minor>=0),
  created_at timestamptz not null default now(),
  constraint contract_line_revisions_pkey primary key (tenant_id,id),
  constraint contract_line_revisions_line_fk foreign key (tenant_id,contract_line_id)
    references app.contract_lines(tenant_id,id) on delete restrict,
  constraint contract_line_revisions_acceptance_fk foreign key (tenant_id,acceptance_id)
    references app.quote_acceptances(tenant_id,id) on delete restrict,
  constraint contract_line_revisions_version unique (tenant_id,contract_line_id,version)
);

alter table app.quote_approvals enable row level security;
alter table app.quote_scope_lines enable row level security;
alter table app.quote_acceptances enable row level security;
alter table app.contract_lines enable row level security;
alter table app.contract_line_revisions enable row level security;
revoke all on app.quote_approvals,app.quote_scope_lines,app.quote_acceptances,
  app.contract_lines,app.contract_line_revisions from public,anon,authenticated,service_role;
grant select,insert on app.quote_approvals,app.quote_scope_lines,app.quote_acceptances,
  app.contract_line_revisions to sigongnote_api;
grant select,insert,update on app.contract_lines to sigongnote_api;
grant insert on app.work_orders,app.work_bundles to sigongnote_api;
grant update on app.work_orders to sigongnote_api;
create policy quote_approvals_read on app.quote_approvals for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy quote_approvals_insert on app.quote_approvals for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']) and
    actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
create policy quote_scope_lines_read on app.quote_scope_lines for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy quote_scope_lines_insert on app.quote_scope_lines for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy quote_acceptances_read on app.quote_acceptances for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy quote_acceptances_insert on app.quote_acceptances for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy contract_lines_read on app.contract_lines for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy contract_lines_insert on app.contract_lines for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy contract_lines_update on app.contract_lines for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy contract_line_revisions_read on app.contract_line_revisions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy contract_line_revisions_insert on app.contract_line_revisions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy work_orders_quote_insert on app.work_orders for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy work_orders_quote_update on app.work_orders for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy work_bundles_quote_insert on app.work_bundles for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
