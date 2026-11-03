-- C29: tenant-scoped work bundles and source-linked search records.
create table app.work_bundles (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  work_order_id uuid not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 180),
  trade_pack_id text not null check (length(trade_pack_id) between 1 and 80),
  trade_pack_version text not null check (trade_pack_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  trade_pack_hash text not null check (trade_pack_hash ~ '^[0-9a-f]{64}$'),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  constraint work_bundles_pkey primary key (tenant_id,id),
  constraint work_bundles_order_fk foreign key (tenant_id,work_order_id)
    references app.work_orders(tenant_id,id) on delete restrict
);
create index work_bundles_order_idx on app.work_bundles(tenant_id,work_order_id);

create table app.evidence_index (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  revision_id uuid not null,
  project_id uuid,
  bundle_id uuid,
  scope text not null check (scope in ('project','company_common','product_reference','unassigned')),
  category text not null check (category in ('agreement','drawing_material','delivery_work','billing_payment','inspection_defect')),
  display_title text not null check (length(btrim(display_title)) between 1 and 180),
  search_text text not null default '' check (length(search_text) <= 10000),
  locator jsonb not null check (jsonb_typeof(locator) = 'object' and locator ? 'kind'
    and locator ? 'position'),
  source_kind text not null check (source_kind in ('original','notification_fragment')),
  recorded_at timestamptz not null default now(),
  supersedes_id uuid,
  constraint evidence_index_pkey primary key (tenant_id,id),
  constraint evidence_index_revision_fk foreign key (tenant_id,revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint evidence_index_project_fk foreign key (tenant_id,project_id)
    references app.projects(tenant_id,id) on delete restrict,
  constraint evidence_index_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint evidence_index_supersedes_fk foreign key (tenant_id,supersedes_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint evidence_index_scope_binding_check check (
    (scope = 'project' and num_nonnulls(project_id,bundle_id) = 1) or
    (scope <> 'project' and project_id is null and bundle_id is null))
);
create index evidence_index_scope_idx on app.evidence_index(tenant_id,scope,project_id,recorded_at desc);
create index evidence_index_bundle_idx on app.evidence_index(tenant_id,bundle_id,recorded_at desc);
create index evidence_index_search_idx on app.evidence_index using gin
  (to_tsvector('simple', display_title || ' ' || search_text));

alter table app.work_bundles enable row level security;
alter table app.evidence_index enable row level security;
revoke all on app.work_bundles,app.evidence_index from public,anon,authenticated,service_role;
grant select,insert on app.work_bundles,app.evidence_index to sigongnote_api;
create policy work_bundles_read on app.work_bundles for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy work_bundles_insert on app.work_bundles for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy evidence_index_read on app.evidence_index for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy evidence_index_insert on app.evidence_index for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
