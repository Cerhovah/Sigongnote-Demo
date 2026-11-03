-- A share attempt records preparation/observation, never payment or confirmed delivery.
create table app.document_share_intents (
 tenant_id uuid not null,id uuid not null,actor_id uuid not null references auth.users(id),
 document_id uuid not null,revision_id uuid not null,format text not null check(format in ('pdf','xlsx')),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz not null default now(),
 primary key(tenant_id,id),foreign key(tenant_id,document_id) references app.business_documents(tenant_id,id),
 foreign key(tenant_id,revision_id,format) references app.document_artifacts(tenant_id,revision_id,format)
);
create table app.document_share_outcomes (
 tenant_id uuid not null,intent_id uuid not null,id uuid not null,
 outcome text not null check(outcome in ('cancelled','unknown','user_confirmed')),
 created_at timestamptz not null default now(),primary key(tenant_id,id),
 foreign key(tenant_id,intent_id) references app.document_share_intents(tenant_id,id),
 unique(tenant_id,intent_id,outcome)
);
alter table app.document_share_intents enable row level security;
alter table app.document_share_outcomes enable row level security;
revoke all on app.document_share_intents,app.document_share_outcomes from public,anon,authenticated,service_role;
grant select,insert on app.document_share_intents,app.document_share_outcomes to sigongnote_api;
create policy share_read on app.document_share_intents for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy share_insert on app.document_share_intents for insert to sigongnote_api with check(actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid and app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy outcome_read on app.document_share_outcomes for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy outcome_insert on app.document_share_outcomes for insert to sigongnote_api with check(exists(select 1 from app.document_share_intents i where i.tenant_id=document_share_outcomes.tenant_id and i.id=intent_id and i.actor_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid) and app.has_tenant_role(tenant_id,array['owner','accountant']));

-- Cross-platform recapture guard, including copies saved through external apps.
alter table app.document_revisions add column generated_output boolean not null default false;
create function app.is_generated_document(p_tenant uuid,p_sha text) returns boolean language sql security definer set search_path='' as $$
 select app.has_tenant_role(p_tenant,array['owner','operator','accountant']) and exists(select 1 from app.document_artifacts where tenant_id=p_tenant and sha256=p_sha)
$$;
revoke all on function app.is_generated_document(uuid,text) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.is_generated_document(uuid,text) to sigongnote_api;
create index document_artifacts_hash on app.document_artifacts(tenant_id,sha256);
