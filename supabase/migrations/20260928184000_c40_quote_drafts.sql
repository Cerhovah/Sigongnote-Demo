-- C40: versioned, tenant-isolated quote drafts; C41 adds approval and contract effects.
alter table app.rate_observations drop constraint rate_observations_category_check;
alter table app.rate_observations add constraint rate_observations_category_check check
  (category in ('material','labor','transport','equipment','revisit','other',
    'defect','waste','owner_labor','allocated_overhead'));
create table app.quotes (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  bundle_id uuid not null,
  trade_pack_id text not null,
  trade_pack_version text not null,
  trade_pack_hash text not null check (trade_pack_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('new','additional','amendment')),
  target_order_id uuid,
  expected_order_version bigint,
  current_revision_id uuid,
  version bigint not null default 1 check (version>=1),
  status text not null default 'draft' check (status in ('draft','approved','accepted','cancelled')),
  created_at timestamptz not null default now(),
  constraint quotes_pkey primary key (tenant_id,id),
  constraint quotes_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint quotes_target_fk foreign key (tenant_id,target_order_id)
    references app.work_orders(tenant_id,id) on delete restrict,
  constraint quotes_target_check check
    ((kind='new' and target_order_id is null and expected_order_version is null) or
     (kind in ('additional','amendment') and target_order_id is not null and
      expected_order_version is not null and expected_order_version>=1))
);
create table app.quote_revisions (
  tenant_id uuid not null,
  id uuid not null,
  quote_id uuid not null,
  version bigint not null check (version>=1),
  supersedes_id uuid,
  actor_id uuid not null references auth.users(id) on delete restrict,
  state text not null check (state in ('needs_inputs','draft_ready','approved')),
  margin_bps integer not null check (margin_bps>=0 and margin_bps<10000),
  vat_mode text not null check (vat_mode in ('exclusive','inclusive','not_applicable','unknown')),
  condition_tags text[] not null,
  cost_coverage jsonb not null,
  missing jsonb not null,
  basis_sha256 text not null check (basis_sha256 ~ '^[0-9a-f]{64}$'),
  base_cost_minor numeric,
  supply_minor numeric,
  vat_minor numeric,
  total_minor numeric,
  created_at timestamptz not null default now(),
  constraint quote_revisions_pkey primary key (tenant_id,id),
  constraint quote_revisions_quote_fk foreign key (tenant_id,quote_id)
    references app.quotes(tenant_id,id) on delete restrict,
  constraint quote_revisions_supersedes_fk foreign key (tenant_id,supersedes_id)
    references app.quote_revisions(tenant_id,id) on delete restrict,
  constraint quote_revisions_unique unique (tenant_id,quote_id,version),
  constraint quote_revisions_amounts check
    ((state='needs_inputs' and base_cost_minor is null and supply_minor is null and
      vat_minor is null and total_minor is null) or
     (state in ('draft_ready','approved') and base_cost_minor>=0 and supply_minor>=0 and
      vat_minor>=0 and total_minor=supply_minor+vat_minor))
);
alter table app.quotes add constraint quotes_current_revision_fk
  foreign key (tenant_id,current_revision_id) references app.quote_revisions(tenant_id,id)
  on delete restrict;
create table app.quote_lines (
  tenant_id uuid not null,
  id uuid not null,
  revision_id uuid not null,
  position integer not null check (position>=1),
  category text not null,
  quantity_value text not null,
  unit_code text not null,
  included boolean not null,
  exclusion_reason text,
  source_rate_id uuid,
  source_revision_id uuid,
  source_blob_sha256 text,
  rate_minor numeric,
  cost_minor numeric,
  operation text,
  target_contract_line_id uuid,
  expected_line_version bigint,
  constraint quote_lines_pkey primary key (tenant_id,id),
  constraint quote_lines_revision_fk foreign key (tenant_id,revision_id)
    references app.quote_revisions(tenant_id,id) on delete restrict,
  constraint quote_lines_rate_fk foreign key (tenant_id,source_rate_id)
    references app.rate_observations(tenant_id,id) on delete restrict,
  constraint quote_lines_unique unique (tenant_id,revision_id,position),
  constraint quote_lines_exclusion check
    (included or (exclusion_reason is not null and length(trim(exclusion_reason))>0)),
  constraint quote_lines_cost check (cost_minor is null or cost_minor>=0)
);
create index quote_lines_revision_idx on app.quote_lines(tenant_id,revision_id);
alter table app.quotes enable row level security;
alter table app.quote_revisions enable row level security;
alter table app.quote_lines enable row level security;
revoke all on app.quotes,app.quote_revisions,app.quote_lines from public,anon,authenticated,service_role;
grant select,insert,update on app.quotes to sigongnote_api;
grant select,insert on app.quote_revisions,app.quote_lines to sigongnote_api;
create policy quotes_read on app.quotes for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy quotes_insert on app.quotes for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']) and
    actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
create policy quotes_update on app.quotes for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy quote_revisions_read on app.quote_revisions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy quote_revisions_insert on app.quote_revisions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']) and
    actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
create policy quote_lines_read on app.quote_lines for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy quote_lines_insert on app.quote_lines for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
