create table app.voice_consents (
 tenant_id uuid not null references app.tenants(id),user_id uuid not null references auth.users(id),provider_version text not null,allowed boolean not null,
 updated_at timestamptz not null default now(),primary key(tenant_id,user_id,provider_version)
);
create table app.voice_requests (
 tenant_id uuid not null references app.tenants(id),user_id uuid not null references auth.users(id),id uuid not null,request_hash text not null,
 state text not null check(state in ('working','completed','failed','cancelled')),transcript text check(length(transcript)<=2000),
 model_version text not null,provider_version text not null,reserved_seconds integer not null check(reserved_seconds between 1 and 31),duration_seconds integer check(duration_seconds between 1 and 31),
 cost_minor numeric,created_at timestamptz not null default now(),primary key(tenant_id,user_id,id)
);
create index voice_daily_usage on app.voice_requests(tenant_id,created_at);
alter table app.voice_consents enable row level security;alter table app.voice_requests enable row level security;
revoke all on app.voice_consents,app.voice_requests from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.voice_consents,app.voice_requests to sigongnote_api;
create policy own_voice_consent on app.voice_consents for all to sigongnote_api using(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant'])) with check(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
create policy own_voice_request on app.voice_requests for all to sigongnote_api using(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant'])) with check(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator','accountant']));
-- Aggregate only, never another user's transcript. All users share the company budget.
create function app.voice_used_seconds(p_tenant uuid) returns integer language sql stable security definer set search_path='' as $$
 select case when app.has_tenant_role(p_tenant,array['owner','operator','accountant']) then (select coalesce(sum(reserved_seconds),0)::int from app.voice_requests where tenant_id=p_tenant and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') else null end
$$;
revoke all on function app.voice_used_seconds(uuid) from public,anon,authenticated,service_role,sigongnote_worker;grant execute on function app.voice_used_seconds(uuid) to sigongnote_api;
