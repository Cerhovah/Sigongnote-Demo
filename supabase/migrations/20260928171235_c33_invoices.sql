-- C33: invoices are evidence and claims, never additional cost rows.
create table app.invoices (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  direction text not null check (direction in ('receivable','payable')),
  counterparty_id uuid,
  status text not null default 'draft' check (status in ('draft','approved','reversed')),
  stage text not null check (stage in ('advance','progress','final','other')),
  tax_mode text not null check (tax_mode in ('unknown','exclusive','inclusive','not_applicable')),
  version bigint not null default 1 check (version>=1),
  source_evidence_id uuid,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invoices_pkey primary key (tenant_id,id),
  constraint invoices_evidence_fk foreign key (tenant_id,source_evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict
);
create unique index invoices_source_once_idx on app.invoices(tenant_id,direction,source_evidence_id)
  where source_evidence_id is not null;
create table app.invoice_lines (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  invoice_id uuid not null,
  supply_minor numeric check (supply_minor=trunc(supply_minor)),
  vat_minor numeric check (vat_minor=trunc(vat_minor)),
  gross_minor numeric not null check (gross_minor=trunc(gross_minor) and
    abs(gross_minor)<10000000000000000000),
  reverses_invoice_line_id uuid,
  created_at timestamptz not null default now(),
  constraint invoice_lines_pkey primary key (tenant_id,id),
  constraint invoice_lines_invoice_fk foreign key (tenant_id,invoice_id)
    references app.invoices(tenant_id,id) on delete restrict,
  constraint invoice_lines_reversal_fk foreign key (tenant_id,reverses_invoice_line_id)
    references app.invoice_lines(tenant_id,id) on delete restrict,
  constraint invoice_lines_sign_check check
    ((gross_minor<0)=(reverses_invoice_line_id is not null)),
  constraint invoice_lines_tax_sum_check check
    (supply_minor is null or vat_minor is null or supply_minor+vat_minor=gross_minor)
);
create table app.invoice_charge_links (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  invoice_line_id uuid not null,
  charge_case_id uuid not null,
  charge_revision_id uuid not null,
  supply_minor numeric check (supply_minor=trunc(supply_minor)),
  vat_minor numeric check (vat_minor=trunc(vat_minor)),
  gross_minor numeric not null check (gross_minor=trunc(gross_minor) and
    abs(gross_minor)<10000000000000000000),
  reverses_link_id uuid,
  created_at timestamptz not null default now(),
  constraint invoice_charge_links_pkey primary key (tenant_id,id),
  constraint invoice_charge_links_line_fk foreign key (tenant_id,invoice_line_id)
    references app.invoice_lines(tenant_id,id) on delete restrict,
  constraint invoice_charge_links_charge_fk foreign key (tenant_id,charge_revision_id,charge_case_id)
    references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict,
  constraint invoice_charge_links_reversal_fk foreign key (tenant_id,reverses_link_id)
    references app.invoice_charge_links(tenant_id,id) on delete restrict,
  constraint invoice_charge_links_sign_check check
    ((gross_minor<0)=(reverses_link_id is not null)),
  constraint invoice_charge_links_tax_sum_check check
    (supply_minor is null or vat_minor is null or supply_minor+vat_minor=gross_minor)
);
create index invoice_charge_links_charge_idx on app.invoice_charge_links(tenant_id,charge_case_id);
create index invoice_charge_links_line_idx on app.invoice_charge_links(tenant_id,invoice_line_id);

create function app.guard_invoice_charge_link() returns trigger language plpgsql as $$
declare line_gross numeric; line_status text; line_direction text; prior_line numeric;
  charge_amount numeric; charge_version_id uuid; charge_tax_mode text; prior_charge numeric;
  original_gross numeric; original_case uuid; original_revision uuid; already_reversed numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.tenant_id::text||':invoice-charge:'||new.charge_case_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended(
    new.tenant_id::text||':invoice-line:'||new.invoice_line_id::text,0));
  select l.gross_minor,i.status,i.direction into line_gross,line_status,line_direction
    from app.invoice_lines l join app.invoices i on i.tenant_id=l.tenant_id and i.id=l.invoice_id
    where l.tenant_id=new.tenant_id and l.id=new.invoice_line_id;
  if line_status is distinct from 'draft' or line_direction is distinct from 'payable' or
     (line_gross>0 and new.gross_minor<0) or (line_gross<0 and new.gross_minor>=0) then
    raise exception 'invoice line/link scope mismatch' using errcode='23514'; end if;
  select coalesce(sum(gross_minor),0) into prior_line from app.invoice_charge_links
    where tenant_id=new.tenant_id and invoice_line_id=new.invoice_line_id;
  if (line_gross>0 and prior_line+new.gross_minor>line_gross) or
     (line_gross<0 and prior_line+new.gross_minor<line_gross) then
    raise exception 'overlinked invoice line' using errcode='23514'; end if;
  select c.current_revision_id,r.confirmed_actual_minor,r.tax_mode
    into charge_version_id,charge_amount,charge_tax_mode from app.charge_cases c
    join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id
    where c.tenant_id=new.tenant_id and c.id=new.charge_case_id;
  if charge_version_id is distinct from new.charge_revision_id then
    raise exception 'stale charge revision link' using errcode='23514'; end if;
  if new.reverses_link_id is not null then
    select gross_minor,charge_case_id,charge_revision_id into original_gross,original_case,original_revision
      from app.invoice_charge_links where tenant_id=new.tenant_id and id=new.reverses_link_id;
    if original_gross is null or original_gross<=0 or original_case<>new.charge_case_id or
       original_revision<>new.charge_revision_id then
      raise exception 'invalid invoice link reversal' using errcode='23514'; end if;
    select coalesce(-sum(gross_minor),0) into already_reversed from app.invoice_charge_links
      where tenant_id=new.tenant_id and reverses_link_id=new.reverses_link_id;
    if already_reversed-new.gross_minor>original_gross then
      raise exception 'over invoice link reversal' using errcode='23514'; end if;
  end if;
  select coalesce(sum(gross_minor),0) into prior_charge from app.invoice_charge_links
    where tenant_id=new.tenant_id and charge_case_id=new.charge_case_id;
  if prior_charge+new.gross_minor<0 or
     (charge_tax_mode<>'unknown' and prior_charge+new.gross_minor>charge_amount) then
    raise exception 'overlinked charge case' using errcode='23514'; end if;
  return new;
end $$;
create trigger invoice_charge_link_guard before insert on app.invoice_charge_links
  for each row execute function app.guard_invoice_charge_link();

alter table app.invoices enable row level security;
alter table app.invoice_lines enable row level security;
alter table app.invoice_charge_links enable row level security;
revoke all on app.invoices,app.invoice_lines,app.invoice_charge_links
  from public,anon,authenticated,service_role;
grant select,insert on app.invoices,app.invoice_lines,app.invoice_charge_links to sigongnote_api;
grant update (status,version) on app.invoices to sigongnote_api;
create policy invoices_read on app.invoices for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy invoices_insert on app.invoices for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy invoices_update on app.invoices for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy invoice_lines_read on app.invoice_lines for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy invoice_lines_insert on app.invoice_lines for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy invoice_charge_links_read on app.invoice_charge_links for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy invoice_charge_links_insert on app.invoice_charge_links for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
