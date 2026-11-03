-- C34: observations are evidence, records are economic cash events, applications are separate.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval',
    'billing_agreement','cash_identity','cash_application','noncash_settlement'));

create table app.cash_observations (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  account_token text check (length(account_token) between 8 and 128),
  direction text not null check (direction in ('incoming','outgoing')),
  amount_minor numeric check (amount_minor>0 and amount_minor=trunc(amount_minor)
    and amount_minor<10000000000000000000),
  occurred_at timestamptz,
  time_precision text not null check (time_precision in ('instant','day','shorthand','unknown')),
  normalized_memo text check (length(normalized_memo)<=200),
  provider text check (length(provider)<=80),
  provider_txn_id text check (length(provider_txn_id)<=180),
  source text not null check (source in ('notification','bank','manual')),
  evidence_id uuid not null,
  source_revision_id uuid not null,
  source_locator jsonb not null,
  created_at timestamptz not null default now(),
  constraint cash_observations_pkey primary key (tenant_id,id),
  constraint cash_observations_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint cash_observations_revision_fk foreign key (tenant_id,source_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint cash_observations_source_unique unique (tenant_id,evidence_id),
  constraint cash_observations_source_row_unique unique
    (tenant_id,source_revision_id,source_locator)
);
create index cash_observations_lookup_idx on app.cash_observations
  (tenant_id,account_token,direction,amount_minor,occurred_at);

create table app.cash_records (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  account_token text not null check (length(account_token) between 8 and 128),
  direction text not null check (direction in ('incoming','outgoing')),
  amount_minor numeric not null check (amount_minor>0 and amount_minor=trunc(amount_minor)
    and amount_minor<10000000000000000000),
  occurred_at timestamptz not null,
  normalized_memo text,
  bank_reconciled boolean not null default false,
  version bigint not null default 1 check (version>=1),
  created_at timestamptz not null default now(),
  constraint cash_records_pkey primary key (tenant_id,id)
);
create index cash_records_candidate_idx on app.cash_records
  (tenant_id,account_token,direction,amount_minor,occurred_at);

create table app.cash_record_identifiers (
  tenant_id uuid not null,
  account_token text not null,
  provider text not null,
  transaction_id text not null,
  cash_record_id uuid not null,
  constraint cash_record_identifiers_pkey primary key
    (tenant_id,account_token,provider,transaction_id),
  constraint cash_record_identifiers_record_fk foreign key (tenant_id,cash_record_id)
    references app.cash_records(tenant_id,id) on delete restrict
);
create table app.cash_observation_links (
  tenant_id uuid not null,
  observation_id uuid not null,
  cash_record_id uuid not null,
  decision_id uuid not null,
  constraint cash_observation_links_pkey primary key (tenant_id,observation_id),
  constraint cash_observation_links_observation_fk foreign key (tenant_id,observation_id)
    references app.cash_observations(tenant_id,id) on delete restrict,
  constraint cash_observation_links_record_fk foreign key (tenant_id,cash_record_id)
    references app.cash_records(tenant_id,id) on delete restrict,
  constraint cash_observation_links_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict
);

create table app.cash_applications (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  cash_record_id uuid not null,
  invoice_id uuid not null,
  amount_minor numeric not null check (amount_minor>0 and amount_minor=trunc(amount_minor)
    and amount_minor<10000000000000000000),
  kind text not null check (kind in ('apply','reversal')),
  reverses_application_id uuid,
  decision_id uuid not null,
  created_at timestamptz not null default now(),
  constraint cash_applications_pkey primary key (tenant_id,id),
  constraint cash_applications_record_fk foreign key (tenant_id,cash_record_id)
    references app.cash_records(tenant_id,id) on delete restrict,
  constraint cash_applications_invoice_fk foreign key (tenant_id,invoice_id)
    references app.invoices(tenant_id,id) on delete restrict,
  constraint cash_applications_reversal_fk foreign key (tenant_id,reverses_application_id)
    references app.cash_applications(tenant_id,id) on delete restrict,
  constraint cash_applications_sign_check check ((kind='reversal')=(reverses_application_id is not null))
);
create index cash_applications_record_idx on app.cash_applications(tenant_id,cash_record_id);
create index cash_applications_invoice_idx on app.cash_applications(tenant_id,invoice_id);

create table app.noncash_settlements (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  receivable_invoice_id uuid not null,
  payable_invoice_id uuid not null,
  amount_minor numeric not null check (amount_minor>0 and amount_minor=trunc(amount_minor)),
  decision_id uuid not null,
  evidence_id uuid not null,
  created_at timestamptz not null default now(),
  constraint noncash_settlements_pkey primary key (tenant_id,id),
  constraint noncash_receivable_fk foreign key (tenant_id,receivable_invoice_id)
    references app.invoices(tenant_id,id) on delete restrict,
  constraint noncash_payable_fk foreign key (tenant_id,payable_invoice_id)
    references app.invoices(tenant_id,id) on delete restrict,
  constraint noncash_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint noncash_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict
);

alter table app.cash_observations enable row level security;
alter table app.cash_records enable row level security;
alter table app.cash_record_identifiers enable row level security;
alter table app.cash_observation_links enable row level security;
alter table app.cash_applications enable row level security;
alter table app.noncash_settlements enable row level security;
revoke all on app.cash_observations,app.cash_records,app.cash_record_identifiers,
  app.cash_observation_links,app.cash_applications,app.noncash_settlements
  from public,anon,authenticated,service_role;
grant select,insert on app.cash_observations,app.cash_records,app.cash_record_identifiers,
  app.cash_observation_links,app.cash_applications,app.noncash_settlements to sigongnote_api;
grant update (bank_reconciled,version) on app.cash_records to sigongnote_api;
create policy cash_observations_read on app.cash_observations for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy cash_observations_insert on app.cash_observations for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy cash_records_read on app.cash_records for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy cash_records_insert on app.cash_records for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy cash_records_update on app.cash_records for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy cash_identifiers_read on app.cash_record_identifiers for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy cash_identifiers_insert on app.cash_record_identifiers for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy cash_observation_links_read on app.cash_observation_links for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy cash_observation_links_insert on app.cash_observation_links for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy cash_applications_read on app.cash_applications for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy cash_applications_insert on app.cash_applications for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy noncash_settlements_read on app.noncash_settlements for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy noncash_settlements_insert on app.noncash_settlements for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
