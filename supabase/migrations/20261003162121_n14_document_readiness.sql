create table app.document_readiness_checks (
 tenant_id uuid not null,context_id uuid not null,checked_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,context_id),foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id)
);
create table app.document_readiness (
 tenant_id uuid not null,context_id uuid not null,document_type text not null check(document_type in ('estimate','purchase_order','invoice','delivery_statement')),
 draft_id uuid not null,version bigint not null default 1,
 primary key(tenant_id,context_id,document_type),foreign key(tenant_id,context_id) references app.work_contexts(tenant_id,id),foreign key(tenant_id,draft_id) references app.document_drafts(tenant_id,id)
);
alter table app.document_readiness enable row level security;
alter table app.document_readiness_checks enable row level security;
revoke all on app.document_readiness,app.document_readiness_checks from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.document_readiness,app.document_readiness_checks to sigongnote_api;
create policy readiness_read on app.document_readiness for select to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner','accountant']));
create policy readiness_write on app.document_readiness for all to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
create policy readiness_check on app.document_readiness_checks for all to sigongnote_api using(app.has_tenant_role(tenant_id,array['owner'])) with check(app.has_tenant_role(tenant_id,array['owner']));
-- Only the API scheduler may enumerate consenting workspaces. No source text crosses this boundary.
create function app.document_readiness_targets() returns table(tenant_id uuid,context_id uuid,user_id uuid)
language sql security definer set search_path='' as $$
 select c.tenant_id,c.id,m.user_id from app.work_contexts c
 join lateral(select user_id from app.memberships where tenant_id=c.tenant_id and role='owner' and active and revoked_at is null order by user_id limit 1)m on true
 left join app.document_readiness_checks ck on ck.tenant_id=c.tenant_id and ck.context_id=c.id
 where c.project_id is not null and (exists(select 1 from app.evidence_organizations e join app.parse_results p on p.tenant_id=e.tenant_id and p.revision_id=e.revision_id where e.tenant_id=c.tenant_id and e.context_id=c.id and e.state<>'conflict') or ck.context_id is not null)
 order by ck.checked_at nulls first,c.tenant_id,c.id limit 8
$$;
revoke all on function app.document_readiness_targets() from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.document_readiness_targets() to sigongnote_api;
