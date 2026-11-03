-- C34b: one confirmed cash event can only be applied once up to its amount.
alter table app.cash_observations add column counterparty_id uuid;
alter table app.cash_records add column counterparty_id uuid;
alter table app.cash_applications add constraint cash_applications_decision_fk
  foreign key (tenant_id,decision_id) references app.decisions(tenant_id,id) on delete restrict;
alter table app.cash_applications add constraint cash_applications_decision_unique
  unique (tenant_id,decision_id);
create function app.guard_cash_reconciled() returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' then
    if new.bank_reconciled then
      raise exception 'bank reconciliation requires linked observation' using errcode='23514'; end if;
    return new;
  end if;
  if new.version<>old.version+1 or (old.bank_reconciled and not new.bank_reconciled) then
    raise exception 'invalid cash record transition' using errcode='23514'; end if;
  if new.bank_reconciled and not old.bank_reconciled and not exists (
    select 1 from app.cash_observation_links l join app.cash_observations o
      on o.tenant_id=l.tenant_id and o.id=l.observation_id
    where l.tenant_id=new.tenant_id and l.cash_record_id=new.id and o.source='bank') then
    raise exception 'bank evidence absent' using errcode='23514'; end if;
  return new;
end $$;
create trigger cash_record_reconciliation_guard before insert or update on app.cash_records
  for each row execute function app.guard_cash_reconciled();

alter table app.noncash_settlements alter column receivable_invoice_id drop not null;
alter table app.noncash_settlements alter column payable_invoice_id drop not null;
alter table app.noncash_settlements add column kind text not null default 'offset'
  check (kind in ('offset','writeoff_receivable','writeoff_payable','reversal'));
alter table app.noncash_settlements add column basis_kind text not null default 'offset_agreement'
  check (basis_kind in ('offset_agreement','writeoff_agreement','writeoff_reason','reversal_basis'));
alter table app.noncash_settlements add column reverses_settlement_id uuid;
alter table app.noncash_settlements add constraint noncash_reversal_fk
  foreign key (tenant_id,reverses_settlement_id)
    references app.noncash_settlements(tenant_id,id) on delete restrict;
alter table app.noncash_settlements add constraint noncash_kind_targets_check check (
  (kind='offset' and receivable_invoice_id is not null and payable_invoice_id is not null
    and reverses_settlement_id is null) or
  (kind='writeoff_receivable' and receivable_invoice_id is not null
    and payable_invoice_id is null and reverses_settlement_id is null) or
  (kind='writeoff_payable' and payable_invoice_id is not null
    and receivable_invoice_id is null and reverses_settlement_id is null) or
  (kind='reversal' and reverses_settlement_id is not null));
alter table app.noncash_settlements add constraint noncash_decision_unique
  unique (tenant_id,decision_id);
alter table app.noncash_settlements add constraint noncash_amount_bound
  check (amount_minor<10000000000000000000);
create unique index noncash_full_reversal_once_idx on app.noncash_settlements
  (tenant_id,reverses_settlement_id) where reverses_settlement_id is not null;

create function app.invoice_settlement_remaining(p_tenant uuid,p_invoice uuid)
returns numeric language plpgsql stable as $$
declare gross numeric; cash_net numeric; noncash_net numeric;
begin
  select sum(l.gross_minor) into gross from app.invoice_lines l
    where l.tenant_id=p_tenant and l.invoice_id=p_invoice;
  select coalesce(sum(case when a.kind='apply' then a.amount_minor else -a.amount_minor end),0)
    into cash_net from app.cash_applications a
    where a.tenant_id=p_tenant and a.invoice_id=p_invoice;
  select coalesce(sum(case when s.kind='reversal' then -s.amount_minor else s.amount_minor end),0)
    into noncash_net from app.noncash_settlements s
    where s.tenant_id=p_tenant and
      (s.receivable_invoice_id=p_invoice or s.payable_invoice_id=p_invoice);
  return coalesce(gross,0)-cash_net-noncash_net;
end $$;

create function app.guard_cash_application() returns trigger language plpgsql as $$
declare cash_account text; cash_amount numeric; cash_direction text; cash_party uuid;
  invoice_direction text; invoice_status text; invoice_party uuid;
  cash_net numeric; invoice_remaining numeric;
  original app.cash_applications%rowtype; reversed numeric; decision_scope text;
  decision_targets uuid[]; decision_evidence uuid[];
begin
  select account_token into cash_account from app.cash_records
    where tenant_id=new.tenant_id and id=new.cash_record_id;
  if cash_account is null then raise exception 'cash absent' using errcode='23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    new.tenant_id::text||':cash-account:'||cash_account,0));
  select amount_minor,direction,counterparty_id into cash_amount,cash_direction,cash_party from app.cash_records
    where tenant_id=new.tenant_id and id=new.cash_record_id for update;
  select direction,status,counterparty_id into invoice_direction,invoice_status,invoice_party from app.invoices
    where tenant_id=new.tenant_id and id=new.invoice_id for update;
  if invoice_status is distinct from 'approved' or
     (cash_direction='incoming' and invoice_direction is distinct from 'receivable') or
     (cash_direction='outgoing' and invoice_direction is distinct from 'payable') or
     (cash_party is not null and cash_party is distinct from invoice_party) then
    raise exception 'cash invoice direction or approval mismatch' using errcode='23514'; end if;
  select scope,target_ids,evidence_ids into decision_scope,decision_targets,decision_evidence
    from app.decisions where tenant_id=new.tenant_id and id=new.decision_id;
  if decision_scope is distinct from 'cash_application' or
     decision_targets[1] is distinct from new.cash_record_id or
     decision_targets[2] is distinct from new.invoice_id or
     not exists (select 1 from unnest(decision_evidence) e
       join app.cash_observations o on o.tenant_id=new.tenant_id and o.evidence_id=e
       join app.cash_observation_links l on l.tenant_id=o.tenant_id and l.observation_id=o.id
       where l.cash_record_id=new.cash_record_id) then
    raise exception 'cash decision absent' using errcode='23514'; end if;
  if new.kind='reversal' then
    select * into original from app.cash_applications
      where tenant_id=new.tenant_id and id=new.reverses_application_id;
    if original.id is null or original.kind<>'apply' or
       original.cash_record_id<>new.cash_record_id or original.invoice_id<>new.invoice_id then
      raise exception 'invalid cash reversal target' using errcode='23514'; end if;
    select coalesce(sum(amount_minor),0) into reversed from app.cash_applications
      where tenant_id=new.tenant_id and reverses_application_id=original.id;
    if reversed+new.amount_minor>original.amount_minor then
      raise exception 'cash reversal exceeds original' using errcode='23514'; end if;
  end if;
  select coalesce(sum(case when kind='apply' then amount_minor else -amount_minor end),0)
    into cash_net from app.cash_applications
    where tenant_id=new.tenant_id and cash_record_id=new.cash_record_id;
  invoice_remaining:=app.invoice_settlement_remaining(new.tenant_id,new.invoice_id);
  if new.kind='apply' and (cash_net+new.amount_minor>cash_amount or
      new.amount_minor>invoice_remaining) then
    raise exception 'cash over-applied' using errcode='23514'; end if;
  return new;
end $$;
create trigger cash_application_guard before insert on app.cash_applications
  for each row execute function app.guard_cash_application();

create function app.guard_noncash_settlement() returns trigger language plpgsql as $$
declare target record; original app.noncash_settlements%rowtype; decision_scope text;
  first_id uuid; second_id uuid;
begin
  if new.kind='reversal' then
    select * into original from app.noncash_settlements
      where tenant_id=new.tenant_id and id=new.reverses_settlement_id;
    if original.id is null or original.kind='reversal' or
       original.amount_minor<>new.amount_minor or
       original.receivable_invoice_id is distinct from new.receivable_invoice_id or
       original.payable_invoice_id is distinct from new.payable_invoice_id then
      raise exception 'invalid noncash reversal' using errcode='23514'; end if;
  end if;
  select scope into decision_scope from app.decisions where tenant_id=new.tenant_id and id=new.decision_id;
  if decision_scope is distinct from 'noncash_settlement' then
    raise exception 'noncash decision absent' using errcode='23514'; end if;
  if (new.kind='offset' and new.basis_kind<>'offset_agreement') or
     (new.kind like 'writeoff%' and new.basis_kind not in ('writeoff_agreement','writeoff_reason')) or
     (new.kind='reversal' and new.basis_kind<>'reversal_basis') then
    raise exception 'noncash basis mismatch' using errcode='23514'; end if;
  if not exists (select 1 from app.evidence_index e where e.tenant_id=new.tenant_id
      and e.id=new.evidence_id and e.source_kind='original'
      and e.category in ('agreement','billing_payment')) then
    raise exception 'noncash agreement evidence absent' using errcode='23514'; end if;
  if exists (select 1 from app.invoices i where i.tenant_id=new.tenant_id
      and i.id in (new.receivable_invoice_id,new.payable_invoice_id)
      and i.source_evidence_id=new.evidence_id) then
    raise exception 'settlement evidence must differ from invoice evidence' using errcode='23514'; end if;
  if new.receivable_invoice_id is not null and not exists (
    select 1 from app.invoices i join app.evidence_attributions a
      on a.tenant_id=i.tenant_id and a.bundle_id=i.bundle_id and a.state='confirmed'
    where i.tenant_id=new.tenant_id and i.id=new.receivable_invoice_id
      and a.evidence_index_id=new.evidence_id) then
    raise exception 'settlement evidence not attributed to receivable work' using errcode='23514'; end if;
  first_id:=least(new.receivable_invoice_id,new.payable_invoice_id);
  second_id:=greatest(new.receivable_invoice_id,new.payable_invoice_id);
  if first_id is null then first_id:=coalesce(new.receivable_invoice_id,new.payable_invoice_id); end if;
  for target in select id from app.invoices where tenant_id=new.tenant_id
      and id in (first_id,second_id) order by id for update loop
    null;
  end loop;
  if new.receivable_invoice_id is not null then
    select i.direction,i.status,i.counterparty_id,
      app.invoice_settlement_remaining(new.tenant_id,i.id) as remaining
      into target from app.invoices i where i.tenant_id=new.tenant_id
        and i.id=new.receivable_invoice_id;
    if target.direction is distinct from 'receivable' or target.status is distinct from 'approved' or
       (new.kind<>'reversal' and new.amount_minor>target.remaining) then
      raise exception 'receivable settlement exceeds balance' using errcode='23514'; end if;
  end if;
  if new.payable_invoice_id is not null then
    select i.direction,i.status,i.counterparty_id,
      app.invoice_settlement_remaining(new.tenant_id,i.id) as remaining
      into target from app.invoices i where i.tenant_id=new.tenant_id
        and i.id=new.payable_invoice_id;
    if target.direction is distinct from 'payable' or target.status is distinct from 'approved' or
       (new.kind<>'reversal' and new.amount_minor>target.remaining) then
      raise exception 'payable settlement exceeds balance' using errcode='23514'; end if;
  end if;
  if new.kind='offset' then
    if not exists (select 1 from app.invoices r join app.invoices p
      on p.tenant_id=r.tenant_id and p.id=new.payable_invoice_id
      where r.tenant_id=new.tenant_id and r.id=new.receivable_invoice_id
        and r.counterparty_id is not null and r.counterparty_id=p.counterparty_id) then
      raise exception 'offset counterparty mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
create trigger noncash_settlement_guard before insert on app.noncash_settlements
  for each row execute function app.guard_noncash_settlement();
