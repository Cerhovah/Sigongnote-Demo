-- C37b: immutable owner-approved internal export intent; worker cannot approve money.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval',
    'billing_agreement','cash_identity','cash_application','noncash_settlement',
    'submittal_submission','submittal_reply','defect_link','internal_export'));

create table app.export_batches (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null,
  approval_decision_id uuid not null,
  adapter_version text not null check (adapter_version='labor-ledger-v1/1.0.0'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  header_fingerprint text not null check (header_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object'),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  charge_case_ids uuid[] not null check (cardinality(charge_case_ids) between 1 and 100),
  charge_revision_ids uuid[] not null check (cardinality(charge_revision_ids)=cardinality(charge_case_ids)),
  audience text not null default 'internal' check (audience='internal'),
  state text not null default 'prepared' check (state in ('prepared','published','void')),
  output_sha256 text check (output_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint export_batches_pkey primary key (tenant_id,id),
  constraint export_batches_approval_fk foreign key (tenant_id,approval_decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint export_batches_published_hash check (state<>'published' or output_sha256 is not null)
);
create function app.guard_export_batch() returns trigger language plpgsql as $$
declare scope_value text; actor_value uuid;
begin
  if tg_op='UPDATE' then
    if new.tenant_id<>old.tenant_id or new.id<>old.id or
       new.approval_decision_id<>old.approval_decision_id or
       new.adapter_version<>old.adapter_version or new.source_sha256<>old.source_sha256 or
       new.header_fingerprint<>old.header_fingerprint or new.snapshot<>old.snapshot or
       new.snapshot_sha256<>old.snapshot_sha256 or new.charge_case_ids<>old.charge_case_ids or
       new.charge_revision_ids<>old.charge_revision_ids or new.audience<>old.audience or
       old.state<>'prepared' or new.state not in ('published','void') then
      raise exception 'immutable export batch' using errcode='23514'; end if;
  end if;
  select scope,actor_id into scope_value,actor_value from app.decisions
    where tenant_id=new.tenant_id and id=new.approval_decision_id;
  if scope_value is distinct from 'internal_export' or actor_value is distinct from
      nullif(current_setting('request.jwt.claim.sub',true),'')::uuid then
    raise exception 'export approval mismatch' using errcode='23514'; end if;
  return new;
end $$;
create trigger export_batches_guard before insert or update on app.export_batches
  for each row execute function app.guard_export_batch();
create table app.export_batch_lines (
  tenant_id uuid not null,
  batch_id uuid not null,
  charge_case_id uuid not null,
  charge_revision_id uuid not null,
  active boolean not null default true,
  constraint export_batch_lines_pkey primary key (tenant_id,batch_id,charge_case_id),
  constraint export_batch_lines_batch_fk foreign key (tenant_id,batch_id)
    references app.export_batches(tenant_id,id) on delete restrict,
  constraint export_batch_lines_revision_fk foreign key (tenant_id,charge_revision_id,charge_case_id)
    references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict
);
create unique index export_batch_lines_active_once on app.export_batch_lines
  (tenant_id,charge_revision_id) where active;
create function app.guard_export_batch_line() returns trigger language plpgsql as $$
declare batch_state text;
begin
  if tg_op='INSERT' then
    if not new.active then raise exception 'inactive new export line' using errcode='23514'; end if;
    return new;
  end if;
  select state into batch_state from app.export_batches
    where tenant_id=old.tenant_id and id=old.batch_id;
  if new.tenant_id<>old.tenant_id or new.batch_id<>old.batch_id or
     new.charge_case_id<>old.charge_case_id or new.charge_revision_id<>old.charge_revision_id or
     not old.active or new.active or batch_state<>'void' then
    raise exception 'invalid export line retirement' using errcode='23514'; end if;
  return new;
end $$;
create trigger export_batch_lines_guard before insert or update on app.export_batch_lines
  for each row execute function app.guard_export_batch_line();
alter table app.export_batches enable row level security;
alter table app.export_batch_lines enable row level security;
revoke all on app.export_batches,app.export_batch_lines from public,anon,authenticated,service_role;
grant select,insert on app.export_batches to sigongnote_api;
grant update (state,output_sha256) on app.export_batches to sigongnote_api;
grant select,insert on app.export_batch_lines to sigongnote_api;
grant update (active) on app.export_batch_lines to sigongnote_api;
create policy export_batches_read on app.export_batches for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy export_batches_insert on app.export_batches for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy export_batches_update on app.export_batches for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy export_batch_lines_read on app.export_batch_lines for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy export_batch_lines_insert on app.export_batch_lines for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy export_batch_lines_update on app.export_batch_lines for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
