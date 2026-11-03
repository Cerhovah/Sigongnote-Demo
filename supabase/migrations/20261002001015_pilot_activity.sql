create table app.activity_consents (
 tenant_id uuid not null references app.tenants(id), user_id uuid not null references auth.users(id),
 consent_id uuid not null default gen_random_uuid(), allowed boolean not null,
 participant_no bigint generated always as identity,
 updated_at timestamptz not null default now(), primary key(tenant_id,user_id)
);
create table app.activity_events (
 seq bigint generated always as identity, tenant_id uuid not null references app.tenants(id),
 user_id uuid not null references auth.users(id), id uuid not null, session_id uuid not null,
 consent_id uuid not null, happened_at timestamptz not null, received_at timestamptz not null default now(),
 kind text not null check(kind in ('click','request','result','error','session','gap')),
 screen text not null check(length(screen)<=80), label text not null check(length(label)<=160),
 platform text not null check(platform in ('web','windows','android')),
 content text not null check(length(content)<=40000), truncated boolean not null default false,
 primary key(tenant_id,user_id,id)
);
create index activity_events_timeline on app.activity_events(tenant_id,seq desc);
alter table app.activity_consents enable row level security;
alter table app.activity_events enable row level security;
revoke all on app.activity_consents,app.activity_events from public,anon,authenticated,service_role;
grant select,insert,update on app.activity_consents to sigongnote_api;
grant select,insert,delete on app.activity_events to sigongnote_api;
grant usage on sequence app.activity_events_seq_seq,app.activity_consents_participant_no_seq to sigongnote_api;
create policy activity_consent_self on app.activity_consents to sigongnote_api
 using (user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']))
 with check (user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']));
create policy activity_owner_read on app.activity_events for select to sigongnote_api
 using (app.has_tenant_role(tenant_id,array['owner']) or (user_id=auth.uid() and app.has_tenant_role(tenant_id,array['operator','accountant','viewer'])));
create policy activity_self_write on app.activity_events for insert to sigongnote_api
 with check (user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']) and exists(
  select 1 from app.activity_consents c where c.tenant_id=activity_events.tenant_id
   and c.user_id=auth.uid() and c.allowed and c.consent_id=activity_events.consent_id));

create policy activity_self_delete on app.activity_events for delete to sigongnote_api
 using (user_id=auth.uid() and app.has_tenant_role(tenant_id,array['owner','operator','accountant','viewer']));
-- No inputs, no content returned, and fixed retention predicate. Runtime roles cannot erase current records through this function.
create function app.purge_expired_activity() returns bigint
language sql security definer set search_path='' as $$
 with gone as (delete from app.activity_events where received_at<now()-interval '90 days' returning 1)
 select count(*) from gone;
$$;
revoke all on function app.purge_expired_activity() from public,anon,authenticated,service_role;
grant execute on function app.purge_expired_activity() to sigongnote_api,sigongnote_worker;

create policy activity_consent_owner_read on app.activity_consents for select to sigongnote_api
 using (app.has_tenant_role(tenant_id,array['owner']));
