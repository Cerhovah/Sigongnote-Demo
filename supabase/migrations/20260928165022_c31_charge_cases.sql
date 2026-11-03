-- C31b: one economic cost case; revisions preserve corrections without summing versions.
create table app.charge_cases (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  bundle_id uuid not null,
  category text not null check (category in
    ('material','labor','transport','equipment','revisit','defect','change','overhead')),
  identity_state text not null check (identity_state in ('unresolved','confirmed_distinct','confirmed_same')),
  canonical_case_id uuid,
  status text not null check (status in ('candidate','documented','confirmed','disputed','adjusted','reversed')),
  version bigint not null default 1 check (version>=1),
  current_revision_id uuid,
  identity_decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint charge_cases_pkey primary key (tenant_id,id),
  constraint charge_cases_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint charge_cases_canonical_fk foreign key (tenant_id,canonical_case_id)
    references app.charge_cases(tenant_id,id) on delete restrict,
  constraint charge_cases_identity_decision_fk foreign key (tenant_id,identity_decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint charge_cases_confirmed_identity_check check
    (status<>'confirmed' or identity_state='confirmed_distinct'),
  constraint charge_cases_canonical_check check
    ((identity_state='confirmed_same')=(canonical_case_id is not null)
     and canonical_case_id is distinct from id)
);
create index charge_cases_bundle_idx on app.charge_cases(tenant_id,bundle_id,status);

create table app.charge_revisions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  charge_case_id uuid not null,
  version bigint not null check (version>=1),
  previous_revision_id uuid,
  actor_id uuid not null references auth.users(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 100),
  confirmed_actual_minor numeric check (confirmed_actual_minor>=0 and
    confirmed_actual_minor=trunc(confirmed_actual_minor) and confirmed_actual_minor<10000000000000000000),
  tax_mode text not null check (tax_mode in ('unknown','exclusive','inclusive','not_applicable')),
  created_at timestamptz not null default now(),
  constraint charge_revisions_pkey primary key (tenant_id,id),
  constraint charge_revisions_case_id_unique unique (tenant_id,id,charge_case_id),
  constraint charge_revisions_case_fk foreign key (tenant_id,charge_case_id)
    references app.charge_cases(tenant_id,id) on delete restrict,
  constraint charge_revisions_previous_fk foreign key (tenant_id,previous_revision_id,charge_case_id)
    references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict,
  constraint charge_revisions_case_version_unique unique (tenant_id,charge_case_id,version)
);
alter table app.charge_cases add constraint charge_cases_current_revision_fk
  foreign key (tenant_id,current_revision_id,id)
  references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict;

create table app.charge_evidence_ownership (
  tenant_id uuid not null,
  evidence_id uuid not null,
  charge_case_id uuid not null,
  identity_decision_id uuid not null,
  constraint charge_evidence_ownership_pkey primary key (tenant_id,evidence_id),
  constraint charge_evidence_ownership_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint charge_evidence_ownership_case_fk foreign key (tenant_id,charge_case_id)
    references app.charge_cases(tenant_id,id) on delete restrict,
  constraint charge_evidence_ownership_decision_fk foreign key (tenant_id,identity_decision_id)
    references app.decisions(tenant_id,id) on delete restrict
);
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution','charge_identity'));

create function app.guard_charge_case_update() returns trigger language plpgsql as $$
declare selected_version bigint; selected_scope text; selected_target uuid;
begin
  if new.tenant_id<>old.tenant_id or new.id<>old.id or new.bundle_id<>old.bundle_id or
     new.category<>old.category or new.canonical_case_id is distinct from old.canonical_case_id then
    raise exception 'immutable charge case fields' using errcode='23514';
  end if;
  select version into selected_version from app.charge_revisions
    where tenant_id=new.tenant_id and id=new.current_revision_id and charge_case_id=new.id;
  if selected_version is distinct from new.version then
    raise exception 'charge revision/version mismatch' using errcode='23514';
  end if;
  if old.current_revision_id is null and new.version=old.version and
     new.status=old.status and new.identity_state=old.identity_state and
     new.identity_decision_id is not distinct from old.identity_decision_id then
    return new;
  end if;
  if new.version<>old.version+1 or old.status not in ('candidate','documented','disputed') or
     new.status<>'confirmed' or old.identity_state<>'unresolved' or
     new.identity_state<>'confirmed_distinct' or new.identity_decision_id is null then
    raise exception 'invalid charge case transition' using errcode='23514';
  end if;
  select scope,target_ids[1] into selected_scope,selected_target from app.decisions
    where tenant_id=new.tenant_id and id=new.identity_decision_id;
  if selected_scope is distinct from 'charge_identity' or selected_target is distinct from new.id then
    raise exception 'missing charge identity decision' using errcode='23514';
  end if;
  return new;
end $$;
create trigger charge_cases_guard before update on app.charge_cases
  for each row execute function app.guard_charge_case_update();

alter table app.charge_cases enable row level security;
alter table app.charge_revisions enable row level security;
alter table app.charge_evidence_ownership enable row level security;
revoke all on app.charge_cases,app.charge_revisions,app.charge_evidence_ownership
  from public,anon,authenticated,service_role;
grant select,insert on app.charge_cases to sigongnote_api;
grant update (version,current_revision_id,status,identity_state,identity_decision_id,updated_at)
  on app.charge_cases to sigongnote_api;
grant select,insert on app.charge_revisions to sigongnote_api;
grant select,insert on app.charge_evidence_ownership to sigongnote_api;
create policy charge_cases_read on app.charge_cases for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_cases_insert on app.charge_cases for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy charge_cases_update on app.charge_cases for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy charge_revisions_read on app.charge_revisions for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_revisions_insert on app.charge_revisions for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']) and actor_id=auth.uid());
create policy charge_evidence_ownership_read on app.charge_evidence_ownership for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_evidence_ownership_insert on app.charge_evidence_ownership for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
