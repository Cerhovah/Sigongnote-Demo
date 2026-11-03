create table app.deliveries (
 tenant_id uuid not null references app.tenants(id),id uuid not null,actor_id uuid not null references auth.users(id),project_id uuid not null,
 source_kind text not null check(source_kind in ('document','photo_sheet')),source_id uuid not null,revision_id uuid not null,
 document_hash text not null check(document_hash ~ '^[a-f0-9]{64}$'),title text not null check(length(title)<=200),pages integer not null check(pages between 1 and 100),
 recipient_name text not null check(length(recipient_name) between 1 and 30),recipient_number text not null check(recipient_number ~ '^0[0-9]{8,11}$'),
 channel text not null default 'fax' check(channel='fax'),scope_hash text not null check(scope_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'prepared' check(state in ('prepared','authorized','submitted','delivered','failed','unknown','cancelled')),current_attempt uuid,
 created_at timestamptz not null default now(),primary key(tenant_id,id),unique(tenant_id,actor_id,scope_hash),foreign key(tenant_id,project_id) references app.projects(tenant_id,id)
);
create table app.delivery_attempts (
 tenant_id uuid not null,delivery_id uuid not null,id uuid not null,actor_id uuid not null references auth.users(id),
 state text not null check(state in ('authorized','submitted','delivered','failed','unknown','cancelled')),approved_hash text not null,
 expires_at timestamptz not null,provider_account_hash text not null,price jsonb not null,reserved_krw integer not null check(reserved_krw>0),actual_krw integer check(actual_krw>=0),
 cancel_reason text check(cancel_reason in ('expired','price_over_cap','source_changed','account_changed','user_cancelled')),
 receipt text check(length(receipt)<=100),submitted_at timestamptz,finished_at timestamptz,created_at timestamptz not null default now(),
 primary key(tenant_id,id),unique(tenant_id,delivery_id,id),foreign key(tenant_id,delivery_id) references app.deliveries(tenant_id,id)
);
alter table app.deliveries add foreign key(tenant_id,id,current_attempt) references app.delivery_attempts(tenant_id,delivery_id,id);
create table app.delivery_webhooks(tenant_id uuid not null,attempt_id uuid not null,event_id text not null check(length(event_id) between 1 and 120),received_at timestamptz not null default now(),primary key(tenant_id,event_id),foreign key(tenant_id,attempt_id) references app.delivery_attempts(tenant_id,id));
create index deliveries_project on app.deliveries(tenant_id,project_id,created_at desc,id);
create index delivery_costs on app.delivery_attempts(tenant_id,actor_id,created_at);
do $$declare t text;begin foreach t in array array['deliveries','delivery_attempts','delivery_webhooks'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('revoke all on app.%I from public,anon,authenticated,service_role,sigongnote_worker',t);
 execute format('grant select,insert on app.%I to sigongnote_api',t);
 execute format('create policy delivery_read on app.%I for select to sigongnote_api using(app.has_tenant_role(tenant_id,array[''owner'',''accountant'']))',t);
 execute format('create policy delivery_insert on app.%I for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array[''owner'']))',t);
end loop;end $$;
grant update(state,current_attempt) on app.deliveries to sigongnote_api;
grant update(state,cancel_reason,actual_krw,receipt,submitted_at,finished_at,price) on app.delivery_attempts to sigongnote_api;
create policy delivery_update on app.deliveries for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy attempts_update on app.delivery_attempts for update to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
alter table app.outbox add column delivery_id uuid;
alter table app.outbox add column delivery_attempt_id uuid;
alter table app.outbox add foreign key(tenant_id,delivery_id,delivery_attempt_id) references app.delivery_attempts(tenant_id,delivery_id,id);
alter table app.outbox add foreign key(tenant_id,delivery_id) references app.deliveries(tenant_id,id);
alter table app.outbox drop constraint outbox_topic_check;
alter table app.outbox add constraint outbox_topic_check check(topic in ('parse_original_ready','render_document_ready','work_observed_ready','render_photo_sheet_ready','delivery_ready'));
alter table app.outbox drop constraint outbox_business_scope;
alter table app.outbox add constraint outbox_business_scope check((topic='work_observed_ready' and job_id is null and delivery_id is null and delivery_attempt_id is null and business_context_id is not null and business_version>0) or(topic='delivery_ready' and job_id is null and business_context_id is null and delivery_id is not null and delivery_attempt_id is not null) or(topic not in ('work_observed_ready','delivery_ready') and job_id is not null and business_context_id is null and delivery_id is null and delivery_attempt_id is null));
create index delivery_outbox_pending on app.outbox(business_available_at,created_at) where topic='delivery_ready' and state='pending';
create function app.claim_delivery(t uuid) returns jsonb language plpgsql security definer set search_path='' as $$ declare q app.outbox%rowtype;d app.deliveries%rowtype;k uuid;begin
 select * into q from app.outbox where tenant_id=t and topic='delivery_ready' and state='pending' and business_available_at<=now() and (business_lease_until is null or business_lease_until<=now()) order by created_at,id for update skip locked limit 1;
 if q.id is null then return null;end if;select * into d from app.deliveries where tenant_id=t and id=q.delivery_id;
 k:=gen_random_uuid();update app.outbox set business_lease=k,business_lease_until=now()+interval '120 seconds',business_attempts=business_attempts+1 where tenant_id=t and id=q.id;
 return jsonb_build_object('tenant',t,'id',d.id,'actor',d.actor_id,'outbox',q.id,'attempt',q.delivery_attempt_id,'token',k);
end $$;
create function app.finish_delivery_tick(t uuid,q uuid,k uuid,done boolean) returns boolean language plpgsql security definer set search_path='' as $$ begin
 if not app.has_tenant_role(t,array['owner']) then return false;end if;
 update app.outbox set state=case when done then 'published' else 'pending' end,business_lease=null,business_lease_until=null,business_available_at=now()+interval '60 seconds' where tenant_id=t and id=q and topic='delivery_ready' and business_lease=k;return found;
end $$;
create function app.wake_delivery(t uuid,request_id uuid,event_id text) returns boolean language plpgsql security definer set search_path='' as $$ declare d uuid;begin
 select delivery_id into d from app.delivery_attempts where tenant_id=t and id=request_id and submitted_at is not null;
 if d is null or length(event_id) not between 1 and 120 then return false;end if;
 insert into app.delivery_webhooks(tenant_id,attempt_id,event_id) values(t,request_id,event_id) on conflict do nothing;
 if not found then return true;end if;
 update app.outbox set business_available_at=now() where tenant_id=t and delivery_id=d and delivery_attempt_id=request_id and topic='delivery_ready' and state='pending';return true;
end $$;
revoke all on function app.claim_delivery(uuid),app.finish_delivery_tick(uuid,uuid,uuid,boolean),app.wake_delivery(uuid,uuid,text) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.claim_delivery(uuid),app.finish_delivery_tick(uuid,uuid,uuid,boolean),app.wake_delivery(uuid,uuid,text) to sigongnote_api;
create table app.delivery_recipients(tenant_id uuid not null references app.tenants(id),id uuid not null,project_id uuid not null,name text not null check(length(name) between 1 and 30),number text not null check(number ~ '^0[0-9]{8,11}$'),actor_id uuid not null references auth.users(id),created_at timestamptz not null default now(),primary key(tenant_id,id),unique(tenant_id,project_id,name,number),foreign key(tenant_id,project_id) references app.projects(tenant_id,id));
alter table app.delivery_recipients enable row level security;
revoke all on app.delivery_recipients from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert on app.delivery_recipients to sigongnote_api;
create policy recipients_read on app.delivery_recipients for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy recipients_insert on app.delivery_recipients for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner']) and actor_id=auth.uid());
create table app.photo_share_events(tenant_id uuid not null,id uuid not null,sheet_id uuid not null,actor_id uuid not null references auth.users(id),intent_id uuid not null,outcome text not null check(outcome in ('prepared','cancelled','unknown')),sha256 text not null,created_at timestamptz not null default now(),primary key(tenant_id,id),unique(tenant_id,intent_id,outcome),foreign key(tenant_id,sheet_id) references app.photo_sheets(tenant_id,id));
alter table app.photo_share_events enable row level security;
revoke all on app.photo_share_events from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert on app.photo_share_events to sigongnote_api;
create policy photo_shares_read on app.photo_share_events for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy photo_shares_insert on app.photo_share_events for insert to sigongnote_api with check(app.has_tenant_role(tenant_id,array['owner','accountant']) and actor_id=auth.uid());
