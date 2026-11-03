-- C33b: explicit owner approval and durable reconciliation exceptions.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval','billing_agreement'));
create table app.billing_agreements (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  bundle_id uuid not null,
  source_evidence_id uuid not null,
  approved_gross_minor numeric not null check (approved_gross_minor>0 and
    approved_gross_minor=trunc(approved_gross_minor) and approved_gross_minor<10000000000000000000),
  decision_id uuid not null,
  created_at timestamptz not null default now(),
  constraint billing_agreements_pkey primary key (tenant_id,id),
  constraint billing_agreements_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint billing_agreements_evidence_fk foreign key (tenant_id,source_evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint billing_agreements_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint billing_agreements_evidence_unique unique (tenant_id,source_evidence_id)
);
alter table app.billing_agreements enable row level security;
revoke all on app.billing_agreements from public,anon,authenticated,service_role;
grant select,insert on app.billing_agreements to sigongnote_api;
create policy billing_agreements_read on app.billing_agreements for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy billing_agreements_insert on app.billing_agreements for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));

drop index app.invoices_source_once_idx;
create unique index invoices_payable_source_once_idx on app.invoices(tenant_id,source_evidence_id)
  where direction='payable' and source_evidence_id is not null;
alter table app.invoices add column bundle_id uuid;
alter table app.invoices add column agreement_id uuid;
alter table app.invoices add column sequence integer check (sequence>0);
alter table app.invoices add column approval_decision_id uuid;
alter table app.invoices add constraint invoices_bundle_fk foreign key (tenant_id,bundle_id)
  references app.work_bundles(tenant_id,id) on delete restrict;
alter table app.invoices add constraint invoices_agreement_fk foreign key (tenant_id,agreement_id)
  references app.billing_agreements(tenant_id,id) on delete restrict;
alter table app.invoices add constraint invoices_approval_decision_fk foreign key (tenant_id,approval_decision_id)
  references app.decisions(tenant_id,id) on delete restrict;
alter table app.invoices add constraint invoices_receivable_scope_check
  check (direction<>'receivable' or bundle_id is not null and agreement_id is not null and sequence is not null);
create unique index invoices_receivable_stage_sequence_idx on app.invoices
  (tenant_id,agreement_id,stage,sequence) where direction='receivable';
alter table app.invoices add constraint invoices_approved_check
  check (status<>'approved' or approval_decision_id is not null);
grant update (approval_decision_id) on app.invoices to sigongnote_api;

create function app.guard_invoice_approval() returns trigger language plpgsql as $$
declare decision_scope text; decision_target uuid;
begin
  if new.tenant_id<>old.tenant_id or new.id<>old.id or new.direction<>old.direction or
     new.counterparty_id is distinct from old.counterparty_id or new.stage<>old.stage or
     new.tax_mode<>old.tax_mode or new.source_evidence_id is distinct from old.source_evidence_id or
     new.due_at is distinct from old.due_at or new.bundle_id is distinct from old.bundle_id or
     new.agreement_id is distinct from old.agreement_id or new.sequence is distinct from old.sequence then
    raise exception 'immutable invoice fields' using errcode='23514'; end if;
  if old.status<>'draft' or new.status<>'approved' or new.version<>old.version+1 or
     new.approval_decision_id is null then
    raise exception 'invalid invoice approval transition' using errcode='23514'; end if;
  select scope,target_ids[1] into decision_scope,decision_target from app.decisions
    where tenant_id=new.tenant_id and id=new.approval_decision_id;
  if decision_scope is distinct from 'invoice_approval' or decision_target is distinct from new.id then
    raise exception 'invoice approval decision mismatch' using errcode='23514'; end if;
  return new;
end $$;
create trigger invoices_guard before update on app.invoices
  for each row execute function app.guard_invoice_approval();

create table app.invoice_reconciliation_exceptions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  invoice_line_id uuid not null,
  expected_gross_minor numeric not null check (expected_gross_minor=trunc(expected_gross_minor)),
  linked_gross_minor numeric not null check (linked_gross_minor=trunc(linked_gross_minor)),
  state text not null default 'open' check (state in ('open','resolved')),
  version bigint not null default 1 check (version>=1),
  updated_at timestamptz not null default now(),
  constraint invoice_reconciliation_exceptions_pkey primary key (tenant_id,id),
  constraint invoice_reconciliation_line_unique unique (tenant_id,invoice_line_id),
  constraint invoice_reconciliation_line_fk foreign key (tenant_id,invoice_line_id)
    references app.invoice_lines(tenant_id,id) on delete restrict
);
create function app.guard_invoice_reconciliation_write() returns trigger language plpgsql as $$
declare parent_status text;
begin
  select i.status into parent_status from app.invoice_lines l join app.invoices i
    on i.tenant_id=l.tenant_id and i.id=l.invoice_id
    where l.tenant_id=new.tenant_id and l.id=new.invoice_line_id for update of i;
  if parent_status is distinct from 'draft' then
    raise exception 'approved invoice reconciliation is immutable' using errcode='23514'; end if;
  return new;
end $$;
create trigger invoice_reconciliation_guard before insert or update on app.invoice_reconciliation_exceptions
  for each row execute function app.guard_invoice_reconciliation_write();
alter table app.invoice_reconciliation_exceptions enable row level security;
revoke all on app.invoice_reconciliation_exceptions from public,anon,authenticated,service_role;
grant select,insert on app.invoice_reconciliation_exceptions to sigongnote_api;
grant update (linked_gross_minor,state,version,updated_at) on app.invoice_reconciliation_exceptions
  to sigongnote_api;
create policy invoice_reconciliation_read on app.invoice_reconciliation_exceptions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy invoice_reconciliation_insert on app.invoice_reconciliation_exceptions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy invoice_reconciliation_update on app.invoice_reconciliation_exceptions for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
