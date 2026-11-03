import {z} from 'zod';
import {WorkEffectSchema,type WorkEffect} from '@sigongnote/domain';
import type {Tx} from './auth.js';
import type {CapturePolicy} from './capture-scope.js';
import {issueCurrent,executeWorkCommand,workHash} from './work-decisions.js';
import {stableRunId} from './product-ai.js';

export type NormalFactOutcome='auto_apply'|'candidate_only'|'needs_answer'|'retryable'|'blocked_scope';
export type OperationalFact={id:string;revision:string;version:string;transaction_key:string|null;organization_version:number;context_id:string;project_id:string;semantic:any};
export const SemanticQualificationSchema=z.strictObject({evaluation_id:z.uuid(),approved_by:z.uuid(),approved_at:z.iso.datetime(),event_kinds:z.array(z.enum(['observation','request','proposal','acceptance','dispatch','receipt','inspection','correction','cancellation'])).min(1).max(9),sample_decisions:z.array(z.uuid()).min(1).max(20).optional(),note:z.string().max(1000).optional(),effect_kinds:z.array(z.enum(['schedule','acceptance','quality','liability','charge_adjustment','prepare_invoice'])).min(1).max(6)});
const units:Record<string,string[]>={ea:['ea','개'],sheet:['sheet','장'],m:['m','미터'],m2:['m2','㎡'],kg:['kg']};
const decimal=(v:string)=>{const [n='0',d='']=v.split('.');return BigInt(n)*1000000n+BigInt(d.padEnd(6,'0'));};
/** Explicit role labels only; a substring inside another party's name is not agreement. */
export function explicitLiabilityParties(quotes:string[]){
 const text=quotes.join('\n').normalize('NFKC');
 return ([['회사','company'],['고객','customer'],['공급처','supplier']] as const)
  .filter(([label])=>new RegExp(`(?<![\\p{L}\\p{N}_])${label}\\s+부담`,'u').test(text));
}
/** Include later corrections and duplicate/conflicting observations outside the saved basis. */
export function relatedNormalFacts(basis:OperationalFact[],current:OperationalFact[]){
 const keys=new Set(basis.map(f=>f.transaction_key).filter(Boolean));
 const subjects=new Set(basis.flatMap(f=>(f.semantic.entityLinks??[]).filter((l:any)=>l.status==='linked'&&l.mentionId===`${f.semantic.subject?.kind}:${f.semantic.subject?.mention}`).map((l:any)=>l.targetId)));
 return current.filter(f=>basis.some(b=>b.id===f.id)||keys.has(f.transaction_key)||['correction','cancellation'].includes(f.semantic.eventKind)&&(f.semantic.entityLinks??[]).some((l:any)=>l.status==='linked'&&subjects.has(l.targetId)));
}
/** Only server-loaded, current facts enter this gate. It has no model confidence threshold. */
export function normalFactEligibility(effects:WorkEffect[],facts:OperationalFact[],qualification:unknown):{state:NormalFactOutcome;reason:string}{
 if(!z.array(WorkEffectSchema).min(1).max(6).safeParse(effects).success)return {state:'candidate_only',reason:'invalid_effect'};
 const q=SemanticQualificationSchema.safeParse(qualification);if(!q.success)return {state:'candidate_only',reason:'type_not_qualified'};
 if(!facts.length||effects.some(e=>!q.data.effect_kinds.includes(e.kind)))return {state:'candidate_only',reason:'effect_not_qualified'};
 if(facts.some(f=>(effects.some(e=>['acceptance','liability','charge_adjustment'].includes(e.kind))&&!f.transaction_key)||f.semantic.assertionStatus!=='asserted'||!q.data.event_kinds.includes(f.semantic.eventKind)||f.semantic.eventKind==='correction'||f.semantic.eventKind==='cancellation'))return {state:'candidate_only',reason:'fact_not_qualified'};
 for(const e of effects){
  if(e.kind==='acceptance'){
   const receipts=facts.filter(f=>f.semantic.eventKind==='receipt');
   if(!receipts.length||receipts.some(f=>!f.semantic.quantity||!(units[f.semantic.quantity.unitCode]??[]).includes(e.unit)||!/^\d+(?:\.\d{1,6})?$/.test(f.semantic.quantity.value)))return {state:'candidate_only',reason:'receipt_not_proven'};
   const subjects=receipts.map(f=>{const s=f.semantic,links=(s.entityLinks??[]).filter((l:any)=>l.mentionId===`${s.subject?.kind}:${s.subject?.mention}`&&l.status==='linked');return s.entityCoverage==='complete'&&s.subject?.kind==='item_instance'&&links.length===1?links[0].targetId:null;});
   if(subjects.some(v=>!v)||new Set(subjects).size!==1)return {state:'candidate_only',reason:'item_identity_not_unique'};
   const orders=facts.filter(f=>f.semantic.eventKind==='acceptance'&&f.semantic.quantity&&!f.semantic.amount&&!f.semantic.effectiveAt);
   if(orders.length!==1||!(units[orders[0]!.semantic.quantity.unitCode]??[]).includes(e.unit)||!/^\d+(?:\.\d{1,6})?$/.test(orders[0]!.semantic.quantity.value)||decimal(orders[0]!.semantic.quantity.value)!==decimal(e.ordered)||!(orders[0]!.semantic.entityLinks??[]).some((l:any)=>l.status==='linked'&&l.mentionId===`${orders[0]!.semantic.subject?.kind}:${orders[0]!.semantic.subject?.mention}`&&l.targetId===subjects[0]))return {state:'candidate_only',reason:'order_not_proven'};
   const values=new Map<string,string>();for(const f of receipts){const old=values.get(f.transaction_key!);if(old&&decimal(old)!==decimal(f.semantic.quantity.value))return {state:'needs_answer',reason:'receipt_conflict'};values.set(f.transaction_key!,f.semantic.quantity.value);}
   if([...values.values()].reduce((sum,v)=>sum+decimal(v),0n)!==decimal(e.quantity))return {state:'needs_answer',reason:'receipt_total_changed'};
  }else if(e.kind==='charge_adjustment'){
   const financial=facts.filter(f=>f.semantic.eventKind==='acceptance'&&f.semantic.amount?.knowledge==='known'&&f.semantic.amount?.minor===e.amount_minor);
   if(financial.length!==1)return {state:'candidate_only',reason:'amount_agreement_not_proven'};
  }else if(e.kind==='liability'){
   const parties=explicitLiabilityParties(facts.filter(f=>f.semantic.eventKind==='acceptance').flatMap(f=>(f.semantic.evidence??[]).map((r:any)=>String(r.quote))));
   if(parties.length>1)return {state:'needs_answer',reason:'liability_party_conflict'};
   if(parties.length!==1||parties[0]![1]!==e.party)return {state:'candidate_only',reason:'liability_agreement_not_proven'};
  }else if(e.kind==='quality'){
   if(!facts.some(f=>f.semantic.eventKind==='inspection'))return {state:'candidate_only',reason:'inspection_not_proven'};
  }else return {state:'candidate_only',reason:'typed_adapter_required'};
 }
 return {state:'auto_apply',reason:'current_source_and_qualified_policy'};
}
export async function operationalFacts(tx:Tx,tenant:string,context:string,policy:CapturePolicy|undefined){
 const [r]=await tx`select app.operational_facts(${tenant}::uuid,${context}::uuid,${tx.json(policy??{})}) value`;return r?.value as {facts:OperationalFact[];partial:boolean}|null;
}
export async function validateNormalSources(tx:Tx,tenant:string,issue:any,policy:CapturePolicy|undefined,historical=false){
 if(!await issueCurrent(tx,tenant,issue,policy,!historical))return {state:'blocked_scope' as NormalFactOutcome,facts:[]};
 if(issue.proposal.semantic_basis){
  const current=await operationalFacts(tx,tenant,issue.context_id,policy),basis=z.array(z.strictObject({id:z.uuid(),version:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(100).safeParse(issue.proposal.semantic_basis);
  if(!current||current.partial||!basis.success)return {state:'retryable' as NormalFactOutcome,facts:[]};
  const facts=basis.data.map(b=>current.facts.find(f=>f.id===b.id&&f.version===b.version));
  if(facts.some(f=>!f))return {state:'blocked_scope' as NormalFactOutcome,facts:[]};return {state:'auto_apply' as NormalFactOutcome,facts:relatedNormalFacts(facts as OperationalFact[],current.facts)};
 }
 const evidence=await tx`select e.id from app.evidence_index e join app.evidence_organizations o on o.tenant_id=e.tenant_id and o.revision_id=e.revision_id join app.parse_results p on p.tenant_id=o.tenant_id and p.job_id=o.job_id
 where e.tenant_id=${tenant}::uuid and e.id=any(${issue.evidence_ids}::uuid[]) and o.context_id=${issue.context_id}::uuid and app.revision_accessible(e.tenant_id,e.revision_id)
 and p.output->'spans'->e.organization_span->>'text'=e.search_text and not exists(select 1 from app.audio_corrections a where a.tenant_id=e.tenant_id and a.revision_id=e.revision_id and a.locator=p.output->'spans'->e.organization_span->>'locator')`;
 return {state:evidence.length===issue.evidence_ids.length?'auto_apply':'blocked_scope' as NormalFactOutcome,facts:[] as OperationalFact[]};
}
/** Reuses the existing decision, money adapters and outbox atomically. No parallel financial ledger. */
export async function applyNormalWork(tx:Tx,tenant:string,user:string,issue:any,policy:any,effects:WorkEffect[],capturePolicy?:CapturePolicy){
 if(policy.semantic_qualification){const ids=policy.semantic_qualification.sample_decisions??[];
  const examples=await tx`select c.* from app.work_decision_cases c join app.decisions d on d.tenant_id=c.tenant_id and d.target_ids[1]=c.id where d.tenant_id=${tenant}::uuid and d.id=any(${ids}::uuid[]) and d.actor_kind='human'`;
  if(!ids.length||examples.length!==ids.length)return {state:'blocked_scope',reason:'qualification_source_changed'};
  for(const example of examples)if((await validateNormalSources(tx,tenant,example,capturePolicy,true)).state!=='auto_apply')return {state:'blocked_scope',reason:'qualification_source_changed'};
 }
 const source=await validateNormalSources(tx,tenant,issue,capturePolicy);if(source.state!=='auto_apply')return {state:source.state,reason:'source_changed'};
 if(!z.array(WorkEffectSchema).min(1).max(6).safeParse(effects).success)return {state:'candidate_only',reason:'invalid_effect'};
 if(issue.proposal.semantic_basis){const eligible=normalFactEligibility(effects,source.facts,policy.semantic_qualification);if(eligible.state!=='auto_apply')return eligible;}
 if(effects.some(e=>!policy.allowed_effects.includes(e.kind)||e.kind==='charge_adjustment'&&BigInt(e.amount_minor)>BigInt(policy.max_amount_minor)))return {state:'needs_answer',reason:'policy_limit'};
 return tx.savepoint(async nested=>{
  const [locked]=await nested`select id from app.owner_policies where tenant_id=${tenant}::uuid and id=${policy.id}::uuid and version=${policy.version} and revoked_at is null and valid_until>now() for share`;if(!locked)return {state:'blocked_scope',reason:'policy_changed'};
  await nested`select set_config('app.executing_policy',${String(policy.id)},true),set_config('app.executing_policy_version',${String(policy.version)},true),set_config('app.executing_issue',${String(issue.id)},true),set_config('app.executing_effects',${JSON.stringify(effects)},true)`;
  const id=stableRunId(workHash([tenant,issue.id,policy.id,policy.version]));
  const result=await executeWorkCommand(nested,tenant,user,{command_id:id,intent:'answer',targets:[{type:'work_issue',id:issue.id,version:issue.version}],evidence_refs:issue.source_refs,effects,policy_version:1},{effects},capturePolicy);
  await nested`select set_config('app.executing_policy','',true),set_config('app.executing_policy_version','',true),set_config('app.executing_issue','',true),set_config('app.executing_effects','',true)`;
  return {state:'auto_apply',reason:'applied',result:result.body};
 });
}
