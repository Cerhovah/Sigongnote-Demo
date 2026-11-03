import {ImprovementSpecSchema,interpretImprovement,type WorkEffect} from '@sigongnote/domain';
import type {Tx} from './auth.js';

/** Atomic head repair. A revoked version is never silently reused by a pinned run. */
export async function activeImprovement(tx:Tx,tenant:string){
 const [head]=await tx`select * from app.improvement_heads where tenant_id=${tenant}::uuid for update`;
 if(!head)return null;
 if(head.active_id&&(await tx`select app.improvement_version_allowed(${tenant}::uuid,${head.active_id}::uuid) ok`)[0]?.ok!==true){
  const previous=head.previous_id&&(await tx`select app.improvement_version_allowed(${tenant}::uuid,${head.previous_id}::uuid) ok`)[0]?.ok===true?head.previous_id:null;
  await tx`update app.improvement_versions set state='rolled_back',invalid_reason='version_unavailable' where tenant_id=${tenant}::uuid and id=${head.active_id}::uuid`;
  if(previous)await tx`update app.improvement_versions set state='active' where tenant_id=${tenant}::uuid and id=${previous}::uuid`;
  await tx`update app.improvement_heads set active_id=${previous}::uuid,previous_id=null,version=version+1 where tenant_id=${tenant}::uuid`;return previous as string|null;
 }
 return head.active_id as string|null;
}
export async function improvedEffects(tx:Tx,tenant:string,input:{sourceText:string;proposal:WorkEffect[]},pinned?:string|null){
 const id=pinned===undefined?await activeImprovement(tx,tenant):pinned;if(!id)return {effects:input.proposal,version:null};
 const [v]=await tx`select spec from app.improvement_versions where tenant_id=${tenant}::uuid and id=${id}::uuid and app.improvement_version_allowed(tenant_id,id)`;
 if(!v)return {effects:input.proposal,version:null,unavailable:true};
 const result=interpretImprovement(input,ImprovementSpecSchema.parse(v.spec));
 return {effects:result.effects,version:result.confidence===1?id:null};
}
