-- C32b: approved adjustments and version-pinned common-cost allocations.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation'));

create table app.charge_adjustments (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  charge_case_id uuid not null,
  previous_revision_id uuid not null,
  next_revision_id uuid not null,
  direction text not null check (direction in ('increase','reversal')),
  amount_minor numeric not null check (amount_minor>0 and amount_minor=trunc(amount_minor)
    and amount_minor<10000000000000000000),
  reason text not null check (reason in ('change','return','refund','defect','correction')),
  liability text not null check (liability in ('unknown','company','customer','supplier')),
  decision_id uuid not null,
  created_at timestamptz not null default now(),
  constraint charge_adjustments_pkey primary key (tenant_id,id),
  constraint charge_adjustments_case_fk foreign key (tenant_id,charge_case_id)
    references app.charge_cases(tenant_id,id) on delete restrict,
  constraint charge_adjustments_previous_fk foreign key (tenant_id,previous_revision_id,charge_case_id)
    references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict,
  constraint charge_adjustments_next_fk foreign key (tenant_id,next_revision_id,charge_case_id)
    references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict,
  constraint charge_adjustments_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint charge_adjustments_return_check check
    (reason not in ('return','refund') or direction='reversal'),
  constraint charge_adjustments_revision_unique unique (tenant_id,next_revision_id)
);
create table app.charge_adjustment_evidence_ownership (
  tenant_id uuid not null,
  evidence_id uuid not null,
  adjustment_id uuid not null,
  constraint charge_adjustment_evidence_ownership_pkey primary key (tenant_id,evidence_id),
  constraint charge_adjustment_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint charge_adjustment_evidence_adjustment_fk foreign key (tenant_id,adjustment_id)
    references app.charge_adjustments(tenant_id,id) on delete restrict
);

create table app.charge_allocation_batches (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  charge_case_id uuid not null,
  charge_revision_id uuid not null,
  charge_version bigint not null check (charge_version>=1),
  policy text not null check (policy in ('approved_weight','direct')),
  policy_version integer not null check (policy_version>0),
  total_minor numeric not null check (total_minor>=0 and total_minor=trunc(total_minor)
    and total_minor<10000000000000000000),
  decision_id uuid not null,
  evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 100),
  created_at timestamptz not null default now(),
  constraint charge_allocation_batches_pkey primary key (tenant_id,id),
  constraint charge_allocation_batches_once_per_version unique (tenant_id,charge_case_id,charge_version),
  constraint charge_allocation_batches_case_fk foreign key (tenant_id,charge_case_id)
    references app.charge_cases(tenant_id,id) on delete restrict,
  constraint charge_allocation_batches_revision_fk foreign key (tenant_id,charge_revision_id,charge_case_id)
    references app.charge_revisions(tenant_id,id,charge_case_id) on delete restrict,
  constraint charge_allocation_batches_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict
);
create table app.charge_allocation_rows (
  tenant_id uuid not null,
  batch_id uuid not null,
  bundle_id uuid not null,
  amount_minor numeric not null check (amount_minor>=0 and amount_minor=trunc(amount_minor)
    and amount_minor<10000000000000000000),
  constraint charge_allocation_rows_pkey primary key (tenant_id,batch_id,bundle_id),
  constraint charge_allocation_rows_batch_fk foreign key (tenant_id,batch_id)
    references app.charge_allocation_batches(tenant_id,id) on delete restrict,
  constraint charge_allocation_rows_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict
);

create function app.check_charge_allocation_sum() returns trigger language plpgsql as $$
declare selected_tenant uuid; selected_batch uuid; expected_amount numeric;
  actual_amount numeric; revision_amount numeric; revision_version bigint; batch_version bigint;
begin
  selected_tenant := new.tenant_id;
  if tg_table_name='charge_allocation_batches' then
    selected_batch := new.id;
  else
    selected_batch := new.batch_id;
  end if;
  select b.total_minor,r.confirmed_actual_minor,r.version,b.charge_version
    into expected_amount,revision_amount,revision_version,batch_version
    from app.charge_allocation_batches b join app.charge_revisions r
      on r.tenant_id=b.tenant_id and r.id=b.charge_revision_id
    where b.tenant_id=selected_tenant and b.id=selected_batch;
  select sum(amount_minor) into actual_amount from app.charge_allocation_rows
    where tenant_id=selected_tenant and batch_id=selected_batch;
  if expected_amount is distinct from actual_amount or expected_amount is distinct from revision_amount
     or batch_version is distinct from revision_version then
    raise exception 'allocation sum mismatch' using errcode='23514';
  end if;
  return null;
end $$;
create constraint trigger allocation_batch_sum after insert on app.charge_allocation_batches
  deferrable initially deferred for each row execute function app.check_charge_allocation_sum();
create constraint trigger allocation_row_sum after insert on app.charge_allocation_rows
  deferrable initially deferred for each row execute function app.check_charge_allocation_sum();

create view app.current_bundle_costs with (security_invoker=true) as
  select c.tenant_id,c.id as charge_case_id,r.bundle_id,
    r.amount_minor as allocated_minor,null::numeric as unallocated_minor,
    'allocated'::text as allocation_state
  from app.charge_cases c join app.charge_allocation_batches b
    on b.tenant_id=c.tenant_id and b.charge_case_id=c.id and b.charge_version=c.version
  join app.charge_allocation_rows r on r.tenant_id=b.tenant_id and r.batch_id=b.id
  where c.status in ('confirmed','adjusted')
  union all
  select c.tenant_id,c.id,null::uuid,null::numeric,rev.confirmed_actual_minor,
    'unallocated'::text
  from app.charge_cases c join app.charge_revisions rev
    on rev.tenant_id=c.tenant_id and rev.id=c.current_revision_id
  where c.status in ('confirmed','adjusted') and
    not exists (select 1 from app.charge_allocation_batches b
      where b.tenant_id=c.tenant_id and b.charge_case_id=c.id and b.charge_version=c.version)
    and (c.category='overhead' or exists (select 1 from app.charge_allocation_batches prior
      where prior.tenant_id=c.tenant_id and prior.charge_case_id=c.id))
  union all
  select c.tenant_id,c.id,c.bundle_id,rev.confirmed_actual_minor,null::numeric,
    'direct'::text
  from app.charge_cases c join app.charge_revisions rev
    on rev.tenant_id=c.tenant_id and rev.id=c.current_revision_id
  where c.status in ('confirmed','adjusted') and c.category<>'overhead' and
    not exists (select 1 from app.charge_allocation_batches b
      where b.tenant_id=c.tenant_id and b.charge_case_id=c.id);

create or replace function app.guard_charge_case_update() returns trigger language plpgsql as $$
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
     new.identity_decision_id is not distinct from old.identity_decision_id then return new; end if;
  if new.version<>old.version+1 then
    raise exception 'invalid charge version' using errcode='23514';
  end if;
  if old.status in ('candidate','documented','disputed') then
    if new.status<>'confirmed' or old.identity_state<>'unresolved' or
       new.identity_state<>'confirmed_distinct' or new.identity_decision_id is null then
      raise exception 'invalid confirmation' using errcode='23514';
    end if;
    select scope,target_ids[1] into selected_scope,selected_target from app.decisions
      where tenant_id=new.tenant_id and id=new.identity_decision_id;
    if selected_scope is distinct from 'charge_identity' or selected_target is distinct from new.id then
      raise exception 'missing identity decision' using errcode='23514'; end if;
  elsif old.status in ('confirmed','adjusted') then
    if new.status<>'adjusted' or new.identity_state<>old.identity_state or
       new.identity_decision_id is distinct from old.identity_decision_id then
      raise exception 'invalid adjustment' using errcode='23514'; end if;
  else raise exception 'invalid charge transition' using errcode='23514'; end if;
  return new;
end $$;

alter table app.charge_adjustments enable row level security;
alter table app.charge_adjustment_evidence_ownership enable row level security;
alter table app.charge_allocation_batches enable row level security;
alter table app.charge_allocation_rows enable row level security;
revoke all on app.charge_adjustments,app.charge_adjustment_evidence_ownership,
  app.charge_allocation_batches,app.charge_allocation_rows,app.current_bundle_costs
  from public,anon,authenticated,service_role;
grant select,insert on app.charge_adjustments,app.charge_allocation_batches,
  app.charge_allocation_rows,app.charge_adjustment_evidence_ownership to sigongnote_api;
grant select on app.current_bundle_costs to sigongnote_api;
create policy charge_adjustments_read on app.charge_adjustments for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_adjustments_insert on app.charge_adjustments for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy charge_adjustment_evidence_read on app.charge_adjustment_evidence_ownership for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_adjustment_evidence_insert on app.charge_adjustment_evidence_ownership for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy charge_allocation_batches_read on app.charge_allocation_batches for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_allocation_batches_insert on app.charge_allocation_batches for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy charge_allocation_rows_read on app.charge_allocation_rows for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy charge_allocation_rows_insert on app.charge_allocation_rows for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
