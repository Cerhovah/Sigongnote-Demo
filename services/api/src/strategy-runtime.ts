import {StrategySpecSchema,applyStrategyCalls,type StrategyScope} from '@sigongnote/domain';
import type {Tx} from './auth.js';
import {ApiFault} from './routes.js';
import type {AgentPlan} from './agent-tools.js';
export type StrategyPins=Partial<Record<StrategyScope,string>>;
export async function strategyAllowed(tx:Tx,t:string,id:string){return (await tx`select app.strategy_version_allowed(${t}::uuid,${id}::uuid) ok`)[0]?.ok===true;}
export async function rollbackStrategy(tx:Tx,t:string,h:any,reason:string){
 if(h.active_id)await tx`update app.strategy_versions set state='rolled_back',invalid_reason=${reason} where tenant_id=${t}::uuid and id=${h.active_id}::uuid`;
 const previous=h.previous_id&&await strategyAllowed(tx,t,h.previous_id)?String(h.previous_id):null;
 if(previous)await tx`update app.strategy_versions set state='active' where tenant_id=${t}::uuid and id=${previous}::uuid`;
 await tx`update app.strategy_heads set active_id=${previous}::uuid,previous_id=null,version=version+1 where tenant_id=${t}::uuid and scope=${h.scope}`;
}
export async function activeStrategies(tx:Tx,t:string):Promise<StrategyPins>{
 const heads=await tx`select * from app.strategy_heads where tenant_id=${t}::uuid order by scope for update`,pins:StrategyPins={};
 for(const h of heads){if(h.active_id&&!await strategyAllowed(tx,t,h.active_id))await rollbackStrategy(tx,t,h,'version_unavailable');
  const [now]=await tx`select active_id from app.strategy_heads where tenant_id=${t}::uuid and scope=${h.scope}`;if(now?.active_id)pins[h.scope as StrategyScope]=String(now.active_id);
 }return pins;
}
export async function pinnedStrategiesAllowed(tx:Tx,t:string,pins:StrategyPins){for(const id of Object.values(pins))if(!await strategyAllowed(tx,t,id))return false;return true;}
export async function improveAgentPlan(tx:Tx,t:string,project:string|null,instruction:string,plan:AgentPlan,pins:StrategyPins):Promise<AgentPlan>{
 if(!await pinnedStrategiesAllowed(tx,t,pins))throw new ApiFault('VERSION_CONFLICT');let calls=plan.calls;
 for(const scope of ['tool_selection','search'] as const){const id=pins[scope];if(!id)continue;
  const [v]=await tx`select spec from app.strategy_versions where tenant_id=${t}::uuid and id=${id}::uuid and scope=${scope}`;if(!v)throw new ApiFault('VERSION_CONFLICT');
  calls=applyStrategyCalls(instruction,calls,StrategySpecSchema.parse(v.spec),project);
 }return {...plan,calls};
}
