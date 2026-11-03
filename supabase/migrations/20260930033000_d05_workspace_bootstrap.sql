-- D05: first company creation is a narrow, authenticated bootstrap capability.
create table app.workspace_bootstraps (
  user_id uuid primary key references auth.users(id) on delete restrict,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid not null unique references app.tenants(id) on delete restrict,
  response jsonb not null,
  created_at timestamptz not null default now()
);
alter table app.workspace_bootstraps enable row level security;
revoke all on app.workspace_bootstraps from public,anon,authenticated,service_role,sigongnote_api;

create function app.bootstrap_workspace(p_session uuid,p_key uuid,p_name text,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
  prior app.workspace_bootstraps%rowtype;
  company uuid;
  receipt jsonb;
begin
  if actor is null or not app.session_is_active(actor,p_session) then
    raise exception 'No active session' using errcode='42501';
  end if;
  if p_key is null or p_name is null or length(btrim(p_name)) not between 1 and 120
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid bootstrap request' using errcode='23514';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Retry bootstrap in read committed' using errcode='40001';
  end if;
  -- Future invitation acceptance uses this same actor lock.
  perform pg_advisory_xact_lock(hashtextextended('workspace:'||actor::text,0));
  select * into prior from app.workspace_bootstraps where user_id=actor;
  if found then
    if prior.request_key<>p_key or prior.request_hash<>p_hash then
      raise exception 'Bootstrap request conflicts' using errcode='23505';
    end if;
    if not exists(select 1 from app.memberships where tenant_id=prior.tenant_id and user_id=actor and active and revoked_at is null) then
      raise exception 'Workspace unavailable' using errcode='42501';
    end if;
    return prior.response;
  end if;
  if exists(select 1 from app.memberships where user_id=actor) then
    return jsonb_build_object('requires_invitation',true);
  end if;
  insert into app.tenants(display_name) values(btrim(p_name)) returning id into company;
  insert into app.memberships(tenant_id,user_id,role) values(company,actor,'owner');
  receipt:=jsonb_build_object('tenant_id',company,'display_name',btrim(p_name),'role','owner','version',1);
  insert into app.workspace_bootstraps(user_id,request_key,request_hash,tenant_id,response) values(actor,p_key,p_hash,company,receipt);
  return receipt;
end $$;
revoke all on function app.bootstrap_workspace(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function app.bootstrap_workspace(uuid,uuid,text,text) to sigongnote_api;
