-- C38: exact owner-approved OS handoff artifact, not a claim of delivery.
alter table app.decisions drop constraint decisions_scope_check;
alter table app.decisions add constraint decisions_scope_check check
  (scope in ('project_attribution','economic_transaction_identity','exception_resolution',
    'charge_identity','charge_adjustment','charge_allocation','invoice_approval',
    'billing_agreement','cash_identity','cash_application','noncash_settlement',
    'submittal_submission','submittal_reply','defect_link','internal_export',
    'external_handoff'));

create table app.external_handoffs (
  tenant_id uuid not null references app.tenants(id) on delete restrict,
  id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  approval_decision_id uuid not null,
  channel text not null check (channel in ('sms','email','os_share')),
  recipient_label text check (recipient_label is null or length(btrim(recipient_label)) between 1 and 180),
  recipient_address text check (recipient_address is null or length(btrim(recipient_address)) between 3 and 254),
  recipient_bound boolean not null,
  payload_text text not null check (length(btrim(payload_text)) between 1 and 4000),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 20),
  disclosure_scope text not null check (disclosure_scope in
    ('work_status','product_documents','approved_quote')),
  expires_at timestamptz not null,
  state text not null default 'prepared' check (state in ('prepared','handoff_unknown','cancelled')),
  handoff_count integer not null default 0 check (handoff_count in (0,1)),
  created_at timestamptz not null default now(),
  constraint external_handoffs_pkey primary key (tenant_id,id),
  constraint external_handoffs_approval_fk foreign key (tenant_id,approval_decision_id)
    references app.decisions(tenant_id,id) on delete restrict,
  constraint external_handoffs_state_count check
    ((state='prepared' and handoff_count=0) or
     (state='handoff_unknown' and handoff_count=1) or state='cancelled'),
  constraint external_handoffs_recipient_scope check
    ((channel='os_share' and recipient_label is null and recipient_address is null and
      not recipient_bound) or
     (channel<>'os_share' and recipient_address is not null and recipient_bound))
);
create function app.guard_external_handoff() returns trigger language plpgsql as $$
declare approval_scope text; approval_actor uuid; approval_target uuid;
begin
  if tg_op='UPDATE' then
    if new.tenant_id<>old.tenant_id or new.id<>old.id or new.actor_id<>old.actor_id or
       new.approval_decision_id<>old.approval_decision_id or new.channel<>old.channel or
       new.recipient_label is distinct from old.recipient_label or
       new.recipient_address is distinct from old.recipient_address or
       new.recipient_bound<>old.recipient_bound or new.payload_text<>old.payload_text or
       new.payload_sha256<>old.payload_sha256 or new.evidence_ids<>old.evidence_ids or
       new.disclosure_scope<>old.disclosure_scope or new.expires_at<>old.expires_at or
       new.created_at<>old.created_at or
       (old.state='prepared' and new.state not in ('handoff_unknown','cancelled')) or
       (old.state='handoff_unknown' and new.state<>'cancelled') or
       old.state='cancelled' then
      raise exception 'invalid external handoff transition' using errcode='23514'; end if;
  end if;
  select scope,actor_id,target_ids[1] into approval_scope,approval_actor,approval_target
    from app.decisions where tenant_id=new.tenant_id and id=new.approval_decision_id;
  if approval_scope is distinct from 'external_handoff' or
     approval_actor is distinct from new.actor_id or approval_target is distinct from new.id or
     new.actor_id is distinct from nullif(current_setting('request.jwt.claim.sub',true),'')::uuid then
    raise exception 'external handoff approval mismatch' using errcode='23514'; end if;
  return new;
end $$;
create trigger external_handoffs_guard before insert or update on app.external_handoffs
  for each row execute function app.guard_external_handoff();
alter table app.external_handoffs enable row level security;
revoke all on app.external_handoffs from public,anon,authenticated,service_role;
grant select,insert on app.external_handoffs to sigongnote_api;
grant update (state,handoff_count) on app.external_handoffs to sigongnote_api;
create policy external_handoffs_read on app.external_handoffs for select to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']));
create policy external_handoffs_insert on app.external_handoffs for insert to sigongnote_api
  with check (app.has_tenant_role(tenant_id,array['owner']) and
    actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid);
create policy external_handoffs_update on app.external_handoffs for update to sigongnote_api
  using (app.has_tenant_role(tenant_id,array['owner']))
  with check (app.has_tenant_role(tenant_id,array['owner']));
