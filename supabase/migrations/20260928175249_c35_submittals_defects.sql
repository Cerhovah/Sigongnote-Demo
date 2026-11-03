-- C35: product possession, submission and site reply are separate facts.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval',
    'billing_agreement','cash_identity','cash_application','noncash_settlement',
    'submittal_submission','submittal_reply','defect_link'));

create table app.product_documents (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  product_key text not null check (length(btrim(product_key)) between 1 and 120),
  revision_number integer not null check (revision_number>0),
  document_revision_id uuid not null,
  evidence_id uuid not null,
  created_at timestamptz not null default now(),
  constraint product_documents_pkey primary key (tenant_id,id),
  constraint product_documents_revision_fk foreign key (tenant_id,document_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict,
  constraint product_documents_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint product_documents_version_unique unique (tenant_id,product_key,revision_number),
  constraint product_documents_evidence_unique unique (tenant_id,evidence_id)
);
create function app.guard_product_document() returns trigger language plpgsql as $$
declare last_revision integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.tenant_id::text||':product:'||new.product_key,0));
  if not exists (select 1 from app.evidence_index e where e.tenant_id=new.tenant_id
      and e.id=new.evidence_id and e.revision_id=new.document_revision_id
      and e.source_kind='original' and e.category='drawing_material'
      and e.scope in ('product_reference','company_common')) then
    raise exception 'product source mismatch' using errcode='23514'; end if;
  select max(revision_number) into last_revision from app.product_documents
    where tenant_id=new.tenant_id and product_key=new.product_key;
  if new.revision_number<>coalesce(last_revision,0)+1 then
    raise exception 'product revision sequence mismatch' using errcode='23514'; end if;
  return new;
end $$;
create trigger product_document_guard before insert on app.product_documents
  for each row execute function app.guard_product_document();
create table app.submittals (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  bundle_id uuid not null,
  recipient_label text not null check (length(btrim(recipient_label)) between 1 and 180),
  version bigint not null default 1 check (version>=1),
  submitted_evidence_id uuid,
  submit_decision_id uuid,
  created_at timestamptz not null default now(),
  constraint submittals_pkey primary key (tenant_id,id),
  constraint submittals_bundle_fk foreign key (tenant_id,bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint submittals_submit_evidence_fk foreign key (tenant_id,submitted_evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint submittals_submit_decision_fk foreign key (tenant_id,submit_decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint submittals_submission_pair_check
    check ((submitted_evidence_id is null)=(submit_decision_id is null))
);
create unique index submittals_submission_evidence_once_idx on app.submittals
  (tenant_id,submitted_evidence_id) where submitted_evidence_id is not null;
create table app.submittal_items (
  tenant_id uuid not null,
  submittal_id uuid not null,
  product_document_id uuid not null,
  pinned_revision_id uuid not null,
  constraint submittal_items_pkey primary key (tenant_id,submittal_id,product_document_id),
  constraint submittal_items_submittal_fk foreign key (tenant_id,submittal_id)
    references app.submittals(tenant_id,id) on delete restrict,
  constraint submittal_items_product_fk foreign key (tenant_id,product_document_id)
    references app.product_documents(tenant_id,id) on delete restrict,
  constraint submittal_items_revision_fk foreign key (tenant_id,pinned_revision_id)
    references app.document_revisions(tenant_id,id) on delete restrict
);
create function app.guard_submittal_item() returns trigger language plpgsql as $$
declare actual_revision uuid; submitted uuid; product text;
begin
  select submitted_evidence_id into submitted from app.submittals
    where tenant_id=new.tenant_id and id=new.submittal_id for update;
  select document_revision_id,product_key into actual_revision,product from app.product_documents
    where tenant_id=new.tenant_id and id=new.product_document_id;
  if actual_revision is distinct from new.pinned_revision_id or submitted is not null then
    raise exception 'submittal item revision or status mismatch' using errcode='23514'; end if;
  if exists (select 1 from app.submittal_items item join app.product_documents p
    on p.tenant_id=item.tenant_id and p.id=item.product_document_id
    where item.tenant_id=new.tenant_id and item.submittal_id=new.submittal_id
      and p.product_key=product) then
    raise exception 'multiple revisions of one product in submission' using errcode='23514'; end if;
  return new;
end $$;
create trigger submittal_item_guard before insert on app.submittal_items
  for each row execute function app.guard_submittal_item();

create table app.submittal_replies (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  submittal_id uuid not null,
  version bigint not null check (version>=3),
  reply_status text not null check (reply_status in
    ('approved','conditionally_approved','revision_requested','rejected')),
  scope_product_document_ids uuid[] not null check (cardinality(scope_product_document_ids) between 1 and 20),
  conditions text check (length(conditions)<=2000),
  evidence_id uuid not null,
  observed_at timestamptz not null,
  decision_id uuid not null,
  created_at timestamptz not null default now(),
  constraint submittal_replies_pkey primary key (tenant_id,id),
  constraint submittal_replies_version_unique unique (tenant_id,submittal_id,version),
  constraint submittal_replies_evidence_unique unique (tenant_id,evidence_id),
  constraint submittal_replies_submittal_fk foreign key (tenant_id,submittal_id)
    references app.submittals(tenant_id,id) on delete restrict,
  constraint submittal_replies_evidence_fk foreign key (tenant_id,evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint submittal_replies_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint submittal_replies_conditional_check check
    (reply_status<>'conditionally_approved' or length(btrim(conditions))>0)
);
create function app.guard_submittal_reply() returns trigger language plpgsql as $$
declare current_version bigint; submitted uuid; bundle uuid;
  decision_scope text; decision_target uuid; decision_choice text;
  item_count integer;
begin
  select version,submitted_evidence_id,bundle_id into current_version,submitted,bundle from app.submittals
    where tenant_id=new.tenant_id and id=new.submittal_id for update;
  select scope,target_ids[1],choice into decision_scope,decision_target,decision_choice from app.decisions
    where tenant_id=new.tenant_id and id=new.decision_id;
  select count(*) into item_count from unnest(new.scope_product_document_ids) item
    join app.submittal_items s on s.tenant_id=new.tenant_id and s.submittal_id=new.submittal_id
      and s.product_document_id=item;
  if submitted is null or new.version<>current_version+1 or
     new.observed_at>now()+interval '5 minutes' or
     decision_scope is distinct from 'submittal_reply' or
     decision_target is distinct from new.submittal_id or
     decision_choice is distinct from new.reply_status or
     item_count<>cardinality(new.scope_product_document_ids) or
     item_count<>cardinality(array(select distinct unnest(new.scope_product_document_ids))) then
    raise exception 'reply exceeds pinned submission' using errcode='23514'; end if;
  if new.evidence_id=submitted or not exists (
    select 1 from app.evidence_index e join app.evidence_attributions a
      on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
    where e.tenant_id=new.tenant_id and e.id=new.evidence_id and e.source_kind='original'
      and e.category in ('drawing_material','agreement','inspection_defect')
      and a.state='confirmed' and a.bundle_id=bundle) then
    raise exception 'reply source is not independent site evidence' using errcode='23514'; end if;
  return new;
end $$;
create trigger submittal_reply_guard before insert on app.submittal_replies
  for each row execute function app.guard_submittal_reply();

create function app.guard_submittal_version() returns trigger language plpgsql as $$
declare decision_scope text; decision_target uuid;
begin
  if new.tenant_id<>old.tenant_id or new.id<>old.id or new.bundle_id<>old.bundle_id or
     new.recipient_label<>old.recipient_label or new.version<>old.version+1 then
    raise exception 'invalid submittal transition' using errcode='23514'; end if;
  if old.submitted_evidence_id is null then
    select scope,target_ids[1] into decision_scope,decision_target from app.decisions
      where tenant_id=new.tenant_id and id=new.submit_decision_id;
    if new.submitted_evidence_id is null or new.version<>2 or
       decision_scope is distinct from 'submittal_submission' or
       decision_target is distinct from new.id then
      raise exception 'submission decision absent' using errcode='23514'; end if;
    if not exists (select 1 from app.evidence_index e join app.evidence_attributions a
      on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
      where e.tenant_id=new.tenant_id and e.id=new.submitted_evidence_id
        and e.source_kind='original' and a.state='confirmed' and a.bundle_id=new.bundle_id)
      or exists (select 1 from app.submittal_items item join app.product_documents p
        on p.tenant_id=item.tenant_id and p.id=item.product_document_id
        where item.tenant_id=new.tenant_id and item.submittal_id=new.id
          and p.evidence_id=new.submitted_evidence_id) then
      raise exception 'submission evidence absent' using errcode='23514'; end if;
  elsif new.submitted_evidence_id is distinct from old.submitted_evidence_id or
        new.submit_decision_id is distinct from old.submit_decision_id or
        not exists (select 1 from app.submittal_replies r where r.tenant_id=new.tenant_id
          and r.submittal_id=new.id and r.version=new.version) then
    raise exception 'reply version absent' using errcode='23514'; end if;
  return new;
end $$;
create trigger submittal_version_guard before update on app.submittals
  for each row execute function app.guard_submittal_version();

create table app.defect_cases (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  original_bundle_id uuid not null,
  original_charge_case_id uuid,
  reported_evidence_id uuid not null,
  decision_id uuid not null,
  description text not null check (length(btrim(description)) between 10 and 1000),
  liability text not null default 'unknown' check (liability='unknown'),
  customer_charge_minor numeric,
  created_at timestamptz not null default now(),
  constraint defect_cases_pkey primary key (tenant_id,id),
  constraint defect_cases_bundle_fk foreign key (tenant_id,original_bundle_id)
    references app.work_bundles(tenant_id,id) on delete restrict,
  constraint defect_cases_charge_fk foreign key (tenant_id,original_charge_case_id)
    references app.charge_cases(tenant_id,id) on delete restrict,
  constraint defect_cases_evidence_fk foreign key (tenant_id,reported_evidence_id)
    references app.evidence_index(tenant_id,id) on delete restrict,
  constraint defect_cases_decision_fk foreign key (tenant_id,decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint defect_cases_no_auto_charge check (customer_charge_minor is null)
);
create function app.guard_defect_link() returns trigger language plpgsql as $$
declare decision_scope text; decision_target uuid; decision_bundle uuid;
begin
  select scope,target_ids[1],target_ids[2] into decision_scope,decision_target,decision_bundle
    from app.decisions where tenant_id=new.tenant_id and id=new.decision_id;
  if decision_scope is distinct from 'defect_link' or decision_target is distinct from new.id
     or decision_bundle is distinct from new.original_bundle_id or
     not exists (select 1 from app.evidence_index e join app.evidence_attributions a
       on a.tenant_id=e.tenant_id and a.evidence_index_id=e.id
       where e.tenant_id=new.tenant_id and e.id=new.reported_evidence_id
         and e.source_kind='original' and e.category='inspection_defect'
         and a.state='confirmed' and a.bundle_id=new.original_bundle_id) or
     (new.original_charge_case_id is not null and not exists (
       select 1 from app.charge_cases c where c.tenant_id=new.tenant_id
         and c.id=new.original_charge_case_id and c.bundle_id=new.original_bundle_id)) then
    raise exception 'defect original work mismatch' using errcode='23514'; end if;
  return new;
end $$;
create trigger defect_link_guard before insert on app.defect_cases
  for each row execute function app.guard_defect_link();

alter table app.product_documents enable row level security;
alter table app.submittals enable row level security;
alter table app.submittal_items enable row level security;
alter table app.submittal_replies enable row level security;
alter table app.defect_cases enable row level security;
revoke all on app.product_documents,app.submittals,app.submittal_items,
  app.submittal_replies,app.defect_cases from public,anon,authenticated,service_role;
grant select,insert on app.product_documents,app.submittals,app.submittal_items,
  app.submittal_replies,app.defect_cases to sigongnote_api;
grant update (version,submitted_evidence_id,submit_decision_id) on app.submittals to sigongnote_api;
create policy product_docs_read on app.product_documents for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy product_docs_insert on app.product_documents for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner','operator']));
create policy submittals_read on app.submittals for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy submittals_insert on app.submittals for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy submittals_update on app.submittals for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy submittal_items_read on app.submittal_items for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy submittal_items_insert on app.submittal_items for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy submittal_replies_read on app.submittal_replies for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy submittal_replies_insert on app.submittal_replies for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
create policy defects_read on app.defect_cases for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy defects_insert on app.defect_cases for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']));
