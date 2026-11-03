-- Each bounded job retains its own paid reservations; effects use the original request key.
alter table app.agent_runs
 add column parent_run_id uuid,
 add column root_run_id uuid,
 add column chain_depth integer not null default 0,
 add column planner_mode text not null default 'pending' check(planner_mode in ('pending','explicit','model','local','blocked')),
 add unique(tenant_id,user_id,id),
 add unique(tenant_id,parent_run_id),
 add foreign key(tenant_id,user_id,parent_run_id) references app.agent_runs(tenant_id,user_id,id),
 add foreign key(tenant_id,user_id,root_run_id) references app.agent_runs(tenant_id,user_id,id),
 add check((parent_run_id is null and root_run_id is null and chain_depth=0) or (parent_run_id is not null and root_run_id is not null and parent_run_id<>id and root_run_id<>id and chain_depth between 1 and 31));
create index agent_chain on app.agent_runs(tenant_id,root_run_id,chain_depth);
