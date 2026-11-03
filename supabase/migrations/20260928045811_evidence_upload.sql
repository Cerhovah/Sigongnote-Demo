-- C05: tenant-scoped immutable source bytes and explicit document revisions.
-- Only opaque server-generated object keys are stored; user filenames stay out.
insert into storage.buckets (id, name, public, file_size_limit)
values ('sigongnote-originals', 'sigongnote-originals', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

-- Store stable error receipts too, so a retried completion reports the same outcome.
alter table app.command_receipts drop constraint command_receipts_status_code_check;
alter table app.command_receipts add constraint command_receipts_status_code_check
  check (status_code between 200 and 499);

create table app.evidence_blobs (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint not null check (byte_length between 1 and 10485760),
  sniffed_mime text not null check (length(sniffed_mime) between 3 and 127),
  storage_key text not null unique,
  scan_state text not null default 'pending' check (scan_state in
    ('pending','clean','quarantined','unsupported')),
  created_at timestamptz not null default now(),
  constraint evidence_blobs_pkey primary key (tenant_id, id),
  constraint evidence_blobs_content_key unique (tenant_id, sha256, byte_length),
  constraint evidence_blobs_storage_key_tenant check (storage_key like tenant_id::text || '/%')
);

create table app.documents (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  constraint documents_pkey primary key (tenant_id, id)
);

create table app.document_revisions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  document_id uuid not null,
  revision_number bigint not null check (revision_number >= 1),
  predecessor_id uuid,
  blob_id uuid not null,
  declared_mime text not null check (length(declared_mime) between 3 and 127),
  parse_state text not null default 'pending' check (parse_state in
    ('pending','running','complete','partial','encrypted','corrupt','unsupported','quarantined','failed')),
  created_at timestamptz not null default now(),
  constraint document_revisions_pkey primary key (tenant_id, id),
  constraint document_revisions_doc_fk foreign key (tenant_id, document_id)
    references app.documents(tenant_id, id) on delete restrict,
  constraint document_revisions_blob_fk foreign key (tenant_id, blob_id)
    references app.evidence_blobs(tenant_id, id) on delete restrict,
  constraint document_revisions_predecessor_fk foreign key (tenant_id, predecessor_id)
    references app.document_revisions(tenant_id, id) on delete restrict,
  constraint document_revisions_number_key unique (tenant_id, document_id, revision_number)
);

create table app.upload_intents (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  source_id uuid,
  document_id uuid,
  predecessor_revision_id uuid,
  expected_version bigint,
  client_capture_id uuid not null,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  claimed_sha256 text not null check (claimed_sha256 ~ '^[0-9a-f]{64}$'),
  claimed_byte_length bigint not null check (claimed_byte_length between 1 and 10485760),
  declared_mime text not null check (length(declared_mime) between 3 and 127),
  storage_key text not null unique,
  status text not null default 'prepared' check (status in ('prepared','verified','rejected')),
  rejection_reason text check (rejection_reason in
    ('hash_mismatch','expired','stale_document')),
  deduplicated boolean not null default false,
  completed_revision_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  completed_at timestamptz,
  constraint upload_intents_pkey primary key (tenant_id, id),
  constraint upload_intents_command_key unique (tenant_id, actor_id, idempotency_key),
  constraint upload_intents_storage_key_tenant check (storage_key like tenant_id::text || '/%'),
  constraint upload_intents_revision_fk foreign key (tenant_id, completed_revision_id)
    references app.document_revisions(tenant_id, id) on delete restrict,
  constraint upload_intents_document_fk foreign key (tenant_id, document_id)
    references app.documents(tenant_id, id) on delete restrict,
  constraint upload_intents_predecessor_fk foreign key (tenant_id, predecessor_revision_id)
    references app.document_revisions(tenant_id, id) on delete restrict,
  constraint upload_intents_document_scope check
    ((document_id is null and predecessor_revision_id is null and expected_version is null) or
     (document_id is not null and predecessor_revision_id is not null and
      expected_version is not null and expected_version >= 1)),
  constraint upload_intents_status_consistent check
    ((status = 'verified') = (completed_revision_id is not null) and
     (status = 'rejected') = (rejection_reason is not null))
);
create index upload_intents_actor_status_idx on app.upload_intents(tenant_id, actor_id, status);
create unique index upload_intents_active_capture_key on app.upload_intents
  (tenant_id, actor_id, client_capture_id)
  where status in ('prepared','verified');

alter table app.evidence_blobs enable row level security;
alter table app.documents enable row level security;
alter table app.document_revisions enable row level security;
alter table app.upload_intents enable row level security;
revoke all on app.evidence_blobs, app.documents, app.document_revisions,
  app.upload_intents from public, anon, authenticated, service_role;
grant select, insert on app.evidence_blobs, app.document_revisions to sigongnote_api;
grant select, insert, update on app.documents to sigongnote_api;
grant select, insert, update on app.upload_intents to sigongnote_api;

create policy evidence_blobs_read on app.evidence_blobs for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy evidence_blobs_insert on app.evidence_blobs for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy documents_read on app.documents for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy documents_insert on app.documents for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy documents_update on app.documents for update to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator']))
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy revisions_read on app.document_revisions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id, array['owner','operator','accountant','viewer']));
create policy revisions_insert on app.document_revisions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id, array['owner','operator']));
create policy upload_intents_read on app.upload_intents for select to sigongnote_api
  using (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator']));
create policy upload_intents_insert on app.upload_intents for insert to sigongnote_api
  with check (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator']));
create policy upload_intents_update on app.upload_intents for update to sigongnote_api
  using (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator']))
  with check (actor_id = (select auth.uid()) and
    app.has_tenant_role(tenant_id, array['owner','operator']));
