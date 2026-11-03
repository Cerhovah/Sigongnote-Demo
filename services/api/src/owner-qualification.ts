import {z} from 'zod';
import type {Tx} from './auth.js';
import type {CapturePolicy} from './capture-scope.js';
import {workHash} from './work-decisions.js';
import {ApiFault} from './routes.js';
import {normalFactEligibility,validateNormalSources,SemanticQualificationSchema} from './normal-facts.js';
import type {WorkEffect} from '@sigongnote/domain';
export function normalizedPolicyEffects(effects:WorkEffect[]){return effects.map(e=>e.kind==='charge_adjustment'?{...e,charge_id:undefined,version:undefined}:e);}
export function policyCondition(issue:{category:string;proposal:{effects:WorkEffect[];semantic_basis?:unknown;semantic_subject?:string};prompt?:string}){
 return issue.proposal.semantic_basis?workHash(['semantic-v1',issue.category,issue.proposal.semantic_subject,normalizedPolicyEffects(issue.proposal.effects)]):workHash([issue.category,issue.prompt,normalizedPolicyEffects(issue.proposal.effects)]);
}
export function qualifyCommandSchema(){return z.strictObject({action:z.literal('qualify'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive(),sample_decisions:z.array(z.uuid()).min(1).max(20),note:z.string().trim().min(10).max(1000)});}
/** H06 is an explicit owner's evaluation of actual decisions, never model self-approval. */
export async function qualifyOwnerPolicy(tx:Tx,tenant:string,user:string,current:any,b:z.infer<ReturnType<typeof qualifyCommandSchema>>,policy?:CapturePolicy){
 const ids=[...new Set(b.sample_decisions)];if(!ids.includes(current.example_decision_id))throw new ApiFault('INVALID_CONTRACT');
 const rows=await tx`select c.*,d.id decision_id,e.effects from app.decisions d join app.work_command_effects e on e.tenant_id=d.tenant_id and e.decision_id=d.id join app.work_decision_cases c on c.tenant_id=d.tenant_id and c.id=d.target_ids[1] where d.tenant_id=${tenant}::uuid and d.id=any(${ids}::uuid[]) and d.actor_kind='human'`;
 if(rows.length!==ids.length||rows.some(r=>!r.proposal.semantic_basis||policyCondition(r as any)!==current.condition_hash||workHash(normalizedPolicyEffects(r.effects))!==workHash(normalizedPolicyEffects(current.effects))))throw new ApiFault('DOMAIN_INVARIANT');
 const sources=[];for(const r of rows){const source=await validateNormalSources(tx,tenant,r,policy,true);if(source.state!=='auto_apply')throw new ApiFault('VERSION_CONFLICT');sources.push(source);}
 const qualification=SemanticQualificationSchema.parse({evaluation_id:b.command_id,approved_by:user,approved_at:new Date().toISOString(),event_kinds:[...new Set(sources.flatMap(s=>s.facts.map(f=>f.semantic.eventKind)))],effect_kinds:[...new Set(current.effects.map((e:WorkEffect)=>e.kind))],sample_decisions:ids,note:b.note});
 if(sources.some(s=>normalFactEligibility(current.effects,s.facts,qualification).state!=='auto_apply'))throw new ApiFault('DOMAIN_INVARIANT');
 await tx`update app.owner_policies set version=version+1,grantor_user_id=${user}::uuid,semantic_qualification=${tx.json(qualification)} where tenant_id=${tenant}::uuid and id=${current.id}::uuid`;
 return {status:200,body:{id:current.id,version:Number(current.version)+1,qualified:true,sample_count:ids.length}};
}
