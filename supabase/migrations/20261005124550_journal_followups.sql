-- Personal follow-up state; never approval, delivery acceptance, billing or payment.
create table app.journal_task_marks (
 tenant_id uuid not null, user_id uuid not null references auth.users(id), fact_id uuid not null,
 done boolean not null, version bigint not null check(version>0), updated_at timestamptz not null default now(),
 primary key(tenant_id,user_id,fact_id), foreign key(tenant_id,fact_id) references app.fact_candidates(tenant_id,id) on delete cascade
);
alter table app.journal_task_marks enable row level security;
revoke all on app.journal_task_marks from public,anon,authenticated,service_role,sigongnote_worker;
grant select,insert,update on app.journal_task_marks to sigongnote_api;
create policy own_journal_tasks on app.journal_task_marks for all to sigongnote_api
 using(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator']))
 with check(user_id=(select auth.uid()) and app.has_tenant_role(tenant_id,array['owner','operator']));

-- Only the explicit document action can create a work context for an ungrouped receipt.
-- Existing contexts are reused. The operation grants no business/financial effect.
create function app.journal_document_context(t uuid,r uuid,p uuid,v bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare old app.evidence_organizations%rowtype; result uuid; title text; base_title text; suffix integer:=1;
begin
 if not app.has_tenant_role(t,array['owner']) or not app.revision_accessible(t,r) then return null;end if;
 select * into old from app.evidence_organizations where tenant_id=t and revision_id=r for update;
 if not found or old.version<>v or (old.project_id is not null and old.project_id<>p)
 or not exists(select 1 from app.projects where tenant_id=t and id=p)
 or exists(select 1 from app.document_revisions n join app.document_revisions cur on cur.tenant_id=n.tenant_id and cur.document_id=n.document_id where cur.tenant_id=t and cur.id=r and n.revision_number>cur.revision_number)
 then return null;end if;
 if old.context_id is not null then return old.context_id;end if;
 if old.project_id is null and not app.answer_organization(t,r,v,p) then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':journal-context:'||p::text,0));
 select '일지 '||to_char(d.created_at at time zone 'Asia/Seoul','MM.DD HH24:MI')||' · '||left(regexp_replace(coalesce(q.output->'spans'->0->>'text','기록에서 준비'),E'[\n\r]+',' ','g'),40)
 into base_title from app.document_revisions d left join lateral(select output from app.parse_results where tenant_id=t and revision_id=r order by created_at desc limit 1)q on true where d.tenant_id=t and d.id=r;
 title:=base_title;
 while exists(select 1 from app.work_contexts where tenant_id=t and project_id=p and label=title) loop suffix:=suffix+1;title:=base_title||' ('||suffix::text||')';end loop;
 insert into app.work_contexts(tenant_id,project_id,label) values(t,p,title) returning id into result;
 insert into app.organization_answers(tenant_id,revision_id,version,actor_id,project_id,previous)
 select t,r,o.version+1,auth.uid(),p,to_jsonb(o) from app.evidence_organizations o where tenant_id=t and revision_id=r;
 update app.evidence_organizations set context_id=result,version=version+1 where tenant_id=t and revision_id=r;
 return result;
end $$;
revoke all on function app.journal_document_context(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role,sigongnote_worker;
grant execute on function app.journal_document_context(uuid,uuid,uuid,bigint) to sigongnote_api;
