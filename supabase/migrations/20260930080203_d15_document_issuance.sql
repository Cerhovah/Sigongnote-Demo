-- Explicit document approval, immutable revisions, and a shared ledger limit guard.
create table app.business_documents (
 tenant_id uuid not null references app.tenants(id),id uuid not null,actor_id uuid not null references auth.users(id),
 command_id uuid not null,document_type text not null check(document_type in ('estimate','purchase_order','invoice','delivery_statement')),
 document_number text not null,created_at timestamptz not null default now(),primary key(tenant_id,id),unique(tenant_id,document_number)
);
create table app.business_document_revisions (
 tenant_id uuid not null,id uuid not null,document_id uuid not null,draft_id uuid not null,version integer not null check(version>0),
 snapshot jsonb not null,snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),basis_hash text not null,
 approval_decision_id uuid not null,created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,document_id,version),unique(tenant_id,draft_id),
 foreign key(tenant_id,document_id) references app.business_documents(tenant_id,id),
 foreign key(tenant_id,draft_id) references app.document_drafts(tenant_id,id),
 foreign key(tenant_id,approval_decision_id) references app.decisions(tenant_id,id)
);
create table app.receivable_basis_links (
 tenant_id uuid not null,invoice_id uuid not null,billing_basis_id uuid not null,document_revision_id uuid not null,
 evidence_revision_id uuid not null,amount_minor numeric check(amount_minor>0 and amount_minor=trunc(amount_minor)),
 primary key(tenant_id,invoice_id,evidence_revision_id),
 foreign key(tenant_id,invoice_id) references app.invoices(tenant_id,id),
 foreign key(tenant_id,billing_basis_id) references app.billing_agreements(tenant_id,id),
 foreign key(tenant_id,document_revision_id) references app.business_document_revisions(tenant_id,id),
 foreign key(tenant_id,evidence_revision_id) references app.document_revisions(tenant_id,id)
);
create table app.billing_reservations (
 tenant_id uuid not null,id uuid not null,command_id uuid not null,billing_basis_id uuid not null,invoice_id uuid not null,
 document_revision_id uuid not null,approval_decision_id uuid not null,
 amount_minor numeric not null check(amount_minor>0 and amount_minor=trunc(amount_minor)),supply_minor numeric not null check(supply_minor>=0 and supply_minor=trunc(supply_minor)),
 state text not null check(state in ('held','consumed','released')),created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,invoice_id),
 foreign key(tenant_id,billing_basis_id) references app.billing_agreements(tenant_id,id),
 foreign key(tenant_id,invoice_id) references app.invoices(tenant_id,id),
 foreign key(tenant_id,document_revision_id) references app.business_document_revisions(tenant_id,id),
 foreign key(tenant_id,approval_decision_id) references app.decisions(tenant_id,id)
);
create table app.document_lifecycle_events (
 tenant_id uuid not null,id uuid not null,document_id uuid not null,command_id uuid not null,
 kind text not null check(kind in ('cancelled','replaced')),replacement_document_id uuid,decision_id uuid not null,
 primary key(tenant_id,id),unique(tenant_id,document_id),
 foreign key(tenant_id,document_id) references app.business_documents(tenant_id,id),
 foreign key(tenant_id,replacement_document_id) references app.business_documents(tenant_id,id),
 foreign key(tenant_id,decision_id) references app.decisions(tenant_id,id)
);
create table app.billing_recipients (
 tenant_id uuid not null,billing_basis_id uuid not null,counterparty_id uuid not null,display_name text not null,
 decision_id uuid not null,version integer not null default 1 check(version>0),primary key(tenant_id,billing_basis_id,version),
 foreign key(tenant_id,billing_basis_id) references app.billing_agreements(tenant_id,id),
 foreign key(tenant_id,decision_id) references app.decisions(tenant_id,id)
);
-- Every old approved invoice has unknown delivery, never presumed sent.
alter table app.invoices add column delivery_state text not null default 'unknown' check(delivery_state in ('unknown','prepared','cancelled','user_confirmed','provider_confirmed'));
alter table app.invoices add column reversal_decision_id uuid;
alter table app.invoices add constraint invoice_reversal_decision_fk foreign key(tenant_id,reversal_decision_id) references app.decisions(tenant_id,id);
grant update(reversal_decision_id) on app.invoices to sigongnote_api;
-- New scopes preserve all previously supported decisions.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check(scope in (
 'project_attribution','economic_transaction_identity','exception_resolution','charge_identity','charge_adjustment','charge_allocation',
 'invoice_approval','billing_agreement','cash_identity','cash_application','noncash_settlement','submittal_submission','submittal_reply','defect_link',
 'internal_export','external_handoff','outcome_record','rate_observation','quote_approval','quote_acceptance','quote_cancel','document_issue','invoice_reversal'));

do $$ declare t text; begin
 foreach t in array array['business_documents','business_document_revisions','receivable_basis_links','billing_reservations','document_lifecycle_events','billing_recipients'] loop
  execute format('alter table app.%I enable row level security',t);
  execute format('revoke all on app.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on app.%I to sigongnote_api',t);
  execute format('create policy %I on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''accountant'']))',t||'_read',t);
  execute format('create policy %I on app.%I for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array[''owner'']))',t||'_insert',t);
 end loop;
end $$;
grant update(state) on app.billing_reservations to sigongnote_api;
create policy billing_reservations_update on app.billing_reservations for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));

create function app.check_billing_capacity(p_tenant uuid,p_agreement uuid,p_invoice uuid,p_gross numeric,p_supply numeric)
returns void language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare order_id uuid; limit_gross numeric; used_gross numeric; held_gross numeric; contract_supply numeric; billed_supply numeric; held_supply numeric; unknown_supply integer;
begin
 select b.work_order_id,a.approved_gross_minor into order_id,limit_gross from app.billing_agreements a join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=a.bundle_id where a.tenant_id=p_tenant and a.id=p_agreement;
 if order_id is null or p_gross<=0 then raise exception 'billing scope absent' using errcode='23514'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':contract-order:'||order_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':billing-agreement:'||p_agreement::text,0));
 select coalesce(sum(l.gross_minor),0) into used_gross from app.invoices i join app.invoice_lines l on l.tenant_id=i.tenant_id and l.invoice_id=i.id where i.tenant_id=p_tenant and i.agreement_id=p_agreement and i.status='approved' and i.id<>p_invoice;
 select coalesce(sum(amount_minor),0) into held_gross from app.billing_reservations where tenant_id=p_tenant and billing_basis_id=p_agreement and state='held' and invoice_id<>p_invoice;
 if used_gross+held_gross+p_gross>limit_gross then raise exception 'billing capacity exceeded' using errcode='23514'; end if;
 select sum(supply_minor) into contract_supply from app.contract_lines where tenant_id=p_tenant and work_order_id=order_id and active;
 if contract_supply is not null then
  select coalesce(sum(l.supply_minor),0),count(*) filter(where l.supply_minor is null) into billed_supply,unknown_supply from app.invoices i join app.invoice_lines l on l.tenant_id=i.tenant_id and l.invoice_id=i.id join app.work_bundles b on b.tenant_id=i.tenant_id and b.id=i.bundle_id where i.tenant_id=p_tenant and b.work_order_id=order_id and i.status='approved' and i.direction='receivable' and i.id<>p_invoice;
  select coalesce(sum(r.supply_minor),0) into held_supply from app.billing_reservations r join app.billing_agreements a on a.tenant_id=r.tenant_id and a.id=r.billing_basis_id join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=a.bundle_id where r.tenant_id=p_tenant and b.work_order_id=order_id and r.state='held' and r.invoice_id<>p_invoice;
  if unknown_supply>0 or p_supply is null or billed_supply+held_supply+p_supply>contract_supply then raise exception 'contract capacity exceeded' using errcode='23514'; end if;
 end if;
end $$;
revoke all on function app.check_billing_capacity(uuid,uuid,uuid,numeric,numeric) from public,anon,authenticated,service_role;
grant execute on function app.check_billing_capacity(uuid,uuid,uuid,numeric,numeric) to sigongnote_api;
create function app.guard_billing_reservation() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare i app.invoices%rowtype; gross numeric; supply numeric;
begin
 select * into i from app.invoices where tenant_id=new.tenant_id and id=new.invoice_id;
 select sum(gross_minor),sum(supply_minor) into gross,supply from app.invoice_lines where tenant_id=new.tenant_id and invoice_id=new.invoice_id;
 if i.direction is distinct from 'receivable' or i.agreement_id is distinct from new.billing_basis_id or gross is distinct from new.amount_minor or supply is distinct from new.supply_minor then raise exception 'reservation invoice mismatch' using errcode='23514'; end if;
 if tg_op='INSERT' then
  if new.state<>'held' or i.status<>'draft' then raise exception 'reservation must start held' using errcode='23514'; end if;
  perform app.check_billing_capacity(new.tenant_id,new.billing_basis_id,new.invoice_id,new.amount_minor,new.supply_minor);
 else
  if (to_jsonb(new)-'state')<>(to_jsonb(old)-'state') or old.state<>'held' or new.state not in ('consumed','released') or (new.state='consumed' and i.status<>'approved') or (new.state='released' and i.status<>'draft') then raise exception 'invalid reservation transition' using errcode='23514'; end if;
 end if;
 return new;
end $$;
create trigger billing_reservations_guard before insert or update on app.billing_reservations for each row execute function app.guard_billing_reservation();
create or replace function app.guard_invoice_approval() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare d app.decisions%rowtype; gross numeric; supply numeric;
begin
 if (to_jsonb(new)-array['status','version','approval_decision_id','reversal_decision_id'])<>(to_jsonb(old)-array['status','version','approval_decision_id','reversal_decision_id']) or new.version<>old.version+1 then raise exception 'immutable invoice fields' using errcode='23514'; end if;
 if old.status='draft' and new.status='approved' and new.reversal_decision_id is null then
  select * into d from app.decisions where tenant_id=new.tenant_id and id=new.approval_decision_id;
  if d.scope is distinct from 'invoice_approval' or d.target_ids[1] is distinct from new.id or d.target_versions[1]<>old.version or d.actor_id is distinct from nullif(current_setting('request.jwt.claim.sub',true),'')::uuid then raise exception 'invoice approval decision mismatch' using errcode='23514'; end if;
  if new.direction='receivable' then
   select sum(gross_minor),sum(supply_minor) into gross,supply from app.invoice_lines where tenant_id=new.tenant_id and invoice_id=new.id;
   perform app.check_billing_capacity(new.tenant_id,new.agreement_id,new.id,gross,supply);
  end if;
 elsif old.status='approved' and new.status='reversed' and new.direction='receivable' and new.approval_decision_id=old.approval_decision_id then
  select * into d from app.decisions where tenant_id=new.tenant_id and id=new.reversal_decision_id;
  if d.scope is distinct from 'invoice_reversal' or d.target_ids[1] is distinct from new.id or d.target_versions[1]<>old.version or d.actor_id is distinct from nullif(current_setting('request.jwt.claim.sub',true),'')::uuid then raise exception 'invoice reversal decision mismatch' using errcode='23514'; end if;
  select sum(gross_minor) into gross from app.invoice_lines where tenant_id=new.tenant_id and invoice_id=new.id;
  if app.invoice_settlement_remaining(new.tenant_id,new.id)<>gross then raise exception 'settlements must be reconciled first' using errcode='23514'; end if;
 else raise exception 'invalid invoice transition' using errcode='23514'; end if;
 return new;
end $$;

create function app.consume_invoice_reservation() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ begin
 if new.status='approved' then update app.billing_reservations set state='consumed' where tenant_id=new.tenant_id and invoice_id=new.id and state='held'; end if;return new;end $$;
create trigger invoices_consume_reservation after update on app.invoices for each row execute function app.consume_invoice_reservation();
create function app.invoice_lines_draft_only() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ declare invoice_state text;begin
 select status into invoice_state from app.invoices where tenant_id=new.tenant_id and id=new.invoice_id for update;
 if invoice_state is distinct from 'draft' or exists(select 1 from app.billing_reservations where tenant_id=new.tenant_id and invoice_id=new.invoice_id and state='held') then raise exception 'invoice lines already fixed' using errcode='23514'; end if;return new;end $$;
create trigger invoice_lines_draft_only before insert on app.invoice_lines for each row execute function app.invoice_lines_draft_only();

comment on column app.receivable_basis_links.amount_minor is 'Claim amount stored on one representative source only; additional evidence links are NULL. Never multiply invoice amount by reference count.';
create function app.invoice_starts_draft() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ begin if new.status<>'draft' or new.approval_decision_id is not null then raise exception 'invoice starts as draft' using errcode='23514';end if;return new;end $$;
create trigger invoice_starts_draft before insert on app.invoices for each row execute function app.invoice_starts_draft();
