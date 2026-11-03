import {pinnedStrategiesAllowed} from './strategy-runtime.js';
import {randomUUID} from 'node:crypto';
import type {Tx,Principal} from './auth.js';
import {ApiFault} from './routes.js';
import {AgentPlanSchema} from './agent-tools.js';

// Serialize continuation, cancellation and tool effects on the original request.
export async function lockAgentChain(tx:Tx,tenant:string,id:string){
 const [r]=await tx`select coalesce(root_run_id,id) root from app.agent_runs where tenant_id=${tenant}::uuid and id=${id}::uuid`;
 if(!r)throw new ApiFault('NOT_FOUND');
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':agent-chain:'+r.root},0))`;return String(r.root);
}
export async function parkAgentContinuation(tx:Tx,r:any){
 if(Number(r.chain_depth)>=31){await tx`update app.agent_runs set status='needs_answer',error_code='CHAIN_LIMIT',lease_token=null,lease_until=null where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return;}
 const plan=r.plan?AgentPlanSchema.parse(r.plan):null;
 const remaining=plan&&Number(r.plan_cursor)<plan.calls.length?{...plan,calls:plan.calls.slice(Number(r.plan_cursor))}:null;
 const id=randomUUID();
 await tx`insert into app.agent_runs(tenant_id,id,user_id,session_id,client_turn_id,project_id,instruction,input_kind,evidence_refs,request_hash,answer_target,improvement_version,parent_run_id,root_run_id,chain_depth,status,error_code,plan,planner_mode,strategy_versions)
 values(${r.tenant_id}::uuid,${id}::uuid,${r.user_id}::uuid,${r.session_id}::uuid,${randomUUID()}::uuid,${r.project_id}::uuid,${r.instruction},${r.input_kind},${r.evidence_refs}::uuid[],${r.request_hash},${r.answer_target?tx.json(r.answer_target):null}::jsonb,${r.improvement_version}::uuid,${r.id}::uuid,${r.root_run_id??r.id}::uuid,${Number(r.chain_depth)+1},'needs_answer','CONTINUATION_READY',${remaining?tx.json(remaining):null}::jsonb,${r.planner_mode},${tx.json(r.strategy_versions)})
 on conflict(tenant_id,parent_run_id) do nothing`;
 await tx`update app.agent_runs set status='needs_answer',error_code='LIMIT',lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;
}
export async function continueAgentRun(tx:Tx,tenant:string,actor:Principal,id:string){
 const root=await lockAgentChain(tx,tenant,id);
 const [parent]=await tx`select * from app.agent_runs where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and id=${id}::uuid`;
 const [child]=await tx`select * from app.agent_runs where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and parent_run_id=${id}::uuid for update`;
 if(!parent||!child)throw new ApiFault('NOT_FOUND');
 if((await tx`select id from app.agent_runs where tenant_id=${tenant}::uuid and (id=${root}::uuid or root_run_id=${root}::uuid) and status='cancelled'`).length)throw new ApiFault('VERSION_CONFLICT');
 if(child.error_code!=='CONTINUATION_READY'){
  if((await tx`select id from app.agent_runs where tenant_id=${tenant}::uuid and parent_run_id=${child.id}::uuid`).length)throw new ApiFault('VERSION_CONFLICT');
  return String(child.id);
 }
 if(parent.error_code!=='LIMIT')throw new ApiFault('VERSION_CONFLICT');
 for(const ref of child.evidence_refs)if(!(await tx`select app.revision_accessible(${tenant}::uuid,${ref}::uuid) ok`)[0]?.ok)throw new ApiFault('NOT_FOUND');
 if(!await pinnedStrategiesAllowed(tx,tenant,child.strategy_versions))throw new ApiFault('VERSION_CONFLICT');
 if(child.improvement_version&&!(await tx`select app.improvement_version_allowed(${tenant}::uuid,${child.improvement_version}::uuid) ok`)[0]?.ok)throw new ApiFault('VERSION_CONFLICT');
 await tx`update app.agent_runs set status='queued',error_code=null,session_id=${actor.sessionId}::uuid,updated_at=clock_timestamp() where tenant_id=${tenant}::uuid and id=${child.id}::uuid`;
 return String(child.id);
}
export async function cancelAgentChain(tx:Tx,tenant:string,id:string){
 const root=await lockAgentChain(tx,tenant,id);
 await tx`update app.agent_runs set status='cancelled',lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=${tenant}::uuid and (id=${root}::uuid or root_run_id=${root}::uuid) and (status in ('queued','running') or error_code in ('LIMIT','CONTINUATION_READY'))`;
}
