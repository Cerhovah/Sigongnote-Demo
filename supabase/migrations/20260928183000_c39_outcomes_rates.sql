-- C39: outcomes are versioned observations; unsettled cost never becomes a learned rate.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval',
    'billing_agreement','cash_identity','cash_application','noncash_settlement',
    'submittal_submission','submittal_reply','defect_link','internal_export',
    'external_handoff','outcome_record','rate_observation'));

create table app.outcomes (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null,
  bundle_id uuid not null,
  version bigint not null check (version>=1),
  supersedes_id uuid,
  decision_id uuid not null,
  source_charge_revision_ids uuid[] not null,
  source_allocation_batch_ids uuid[] not null,
  source_state_sha256 text not null check (source_state_sha256 ~ '^[0-9a-f]{64}$'),
  actual_cost_minor numeric check (actual_cost_minor>=0 and actual_cost_minor=trunc(actual_cost_minor)),
  unknown_cost_cases integer not null check (unknown_cost_cases>=0),
  settlement_state text not null check (settlement_state in ('unknown','open','closed')),
  scope_completed boolean not null,
  quantity_value text not null check (quantity_value ~ '^[1-9][0-9]{0,11}(\.[0-9]{1,6})?$'),
  unit_code text not null check (unit_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  owner_labor_included boolean,
  revisit_count integer not null check (revisit_count>=0),
  transport_count integer not null check (transport_count>=0),
  defect_count integer not null check (defect_count>=0),
  condition_tags text[] not null,
  learning_eligible boolean not null,
  created_at timestamptz not null default now(),
  constraint outcomes_pkey primary key (tenant_id,id),
  constraint outcomes_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint outcomes_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint outcomes_supersedes_fk foreign key (tenant_id,supersedes_id)
    references app.outcomes(tenant_id,id) on delete restrict,
  constraint outcomes_version_unique unique (tenant_id,bundle_id,version),
  constraint outcomes_eligible_check check
    (not learning_eligible or (scope_completed and actual_cost_minor is not null and
      unknown_cost_cases=0 and settlement_state='closed' and owner_labor_included is not null))
);
create table app.rate_observations (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  decision_id uuid not null,
  evidence_id uuid not null,
  source_revision_id uuid not null,
  source_blob_sha256 text not null check (source_blob_sha256 ~ '^[0-9a-f]{64}$'),
  trade_pack_id text not null,
  trade_pack_version text not null,
  category text not null check (category in ('material','labor','transport','equipment','revisit','other')),
  unit_code text not null check (unit_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  rate_minor numeric not null check (rate_minor>=0 and rate_minor=trunc(rate_minor) and
    rate_minor<1000000000000000),
  tax_mode text not null check (tax_mode in ('unknown','exclusive','inclusive','not_applicable')),
  external_origin_attested boolean not null check (external_origin_attested),
  observed_on date not null,
  valid_until date not null,
  delivery_included boolean,
  processing_included boolean,
  condition_tags text[] not null,
  created_at timestamptz not null default now(),
  constraint rate_observations_pkey primary key (tenant_id,id),
  constraint rate_observations_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint rate_observations_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint rate_observations_revision_fk foreign key (tenant_id,source_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint rate_observations_evidence_once unique (tenant_id,evidence_id,category,unit_code),
  constraint rate_observations_dates check (valid_until>=observed_on)
);
create index rate_observations_match_idx on app.rate_observations
  (tenant_id,trade_pack_id,trade_pack_version,category,unit_code,valid_until desc);

alter table app.outcomes enable row level security;
alter table app.rate_observations enable row level security;
revoke all on app.outcomes,app.rate_observations from public,anon,authenticated,service_role;
grant select,insert on app.outcomes,app.rate_observations to sigongnote_api;
create policy outcomes_read on app.outcomes for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy outcomes_insert on app.outcomes for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy rate_observations_read on app.rate_observations for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy rate_observations_insert on app.rate_observations for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']) and
    actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
