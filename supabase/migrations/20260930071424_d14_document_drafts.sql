create table app.document_drafts (
 tenant_id uuid not null references app.tenants(id),id uuid not null,actor_id uuid not null references auth.users(id),project_id uuid not null,
 document_type text not null check(document_type in ('estimate','purchase_order','invoice','delivery_statement')),
 version integer not null default 1 check(version>0),supersedes_id uuid,request_hash text not null,as_of date not null,
 state text not null check(state in ('draft_ready','needs_inputs')),basis_hash text not null check(basis_hash ~ '^[0-9a-f]{64}$'),
 basis_snapshot jsonb not null,public_snapshot jsonb not null,internal_snapshot jsonb not null,
 quote_revision_id uuid,invoice_id uuid,created_at timestamptz not null default now(),
 primary key(tenant_id,id),foreign key(tenant_id,supersedes_id) references app.document_drafts(tenant_id,id),foreign key(tenant_id,project_id) references app.projects(tenant_id,id),
 foreign key(tenant_id,quote_revision_id) references app.quote_revisions(tenant_id,id),foreign key(tenant_id,invoice_id) references app.invoices(tenant_id,id)
);
create table app.purchase_orders (
 tenant_id uuid not null,id uuid not null,project_id uuid not null,draft_id uuid not null,
 state text not null default 'draft' check(state in ('draft','approved','delivery_unknown','order_confirmed','partial_received','received','cancelled')),
 version integer not null default 1 check(version>0),created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,draft_id),foreign key(tenant_id,project_id) references app.projects(tenant_id,id),foreign key(tenant_id,draft_id) references app.document_drafts(tenant_id,id)
);
create table app.purchase_order_lines (
 tenant_id uuid not null,id uuid not null,order_id uuid not null,item_key text not null,quantity numeric not null check(quantity>=0),returned_quantity numeric not null default 0 check(returned_quantity>=0 and returned_quantity<=quantity),
 primary key(tenant_id,id),unique(tenant_id,order_id,item_key),foreign key(tenant_id,order_id) references app.purchase_orders(tenant_id,id)
);
-- Draft preparation grants no order-confirmation or ledger mutation authority.
alter table app.document_drafts enable row level security;alter table app.purchase_orders enable row level security;alter table app.purchase_order_lines enable row level security;
revoke all on app.document_drafts,app.purchase_orders,app.purchase_order_lines from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert on app.document_drafts,app.purchase_orders,app.purchase_order_lines to sigongnote_api;
create policy document_drafts_read on app.document_drafts for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy document_drafts_insert on app.document_drafts for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and actor_id=(select auth.uid()));
create policy purchase_orders_read on app.purchase_orders for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy purchase_orders_insert on app.purchase_orders for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and state='draft');
create policy purchase_order_lines_read on app.purchase_order_lines for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy purchase_order_lines_insert on app.purchase_order_lines for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and exists(select 1 from app.purchase_orders p where p.tenant_id=purchase_order_lines.tenant_id and p.id=order_id and p.state='draft'));
-- Observed rate reuse does not require settlement closure, but keeps measured-cost checks.
alter table app.outcomes drop constraint outcomes_eligible_check;
alter table app.outcomes add constraint outcomes_eligible_check check(not learning_eligible or(scope_completed and actual_cost_minor is not null and unknown_cost_cases=0 and owner_labor_included is not null and quantity_value::numeric>0));

create unique index document_drafts_successor on app.document_drafts(tenant_id,supersedes_id) where supersedes_id is not null;
