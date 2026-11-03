import {z} from 'zod';
import {canonicalReadInput,StrategyScopeSchema,StrategyValueSchema,StrategySpecSchema,partitionStrategy,proposeStrategy,predictStrategy,strategyScore,type StrategyDatum,type StrategyScope} from '@sigongnote/domain';
import type {Tx} from './auth.js';
import {ApiFault} from './routes.js';
import {searchEvidence,EvidenceSearchSchema} from './evidence-search.js';
import {workHash} from './work-decisions.js';
import {activeStrategies,rollbackStrategy} from './strategy-runtime.js';

const scope=StrategyScopeSchema,ids=z.array(z.uuid()).min(1).max(30),value=StrategyValueSchema.extend({query:z.string().trim().max(500)});
export const StrategyCommandSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('strategy.preview'),command_id:z.uuid(),query:z.string().trim().min(1).max(500),run_id:z.uuid(),sequence:z.number().int().min(1).max(8),scope}),
 z.strictObject({action:z.literal('strategy.case'),command_id:z.uuid(),scope,run_id:z.uuid(),sequence:z.number().int().min(1).max(8),context_id:z.uuid(),expected:value,evidence_refs:ids,confirmed:z.literal(true)}),
 z.strictObject({action:z.literal('strategy.dataset'),command_id:z.uuid(),scope,case_ids:z.array(z.uuid()).min(2).max(50)}),
 z.strictObject({action:z.literal('strategy.evaluate'),command_id:z.uuid()}),
 z.strictObject({action:z.literal('strategy.promote'),command_id:z.uuid(),scope,id:z.uuid(),head_version:z.number().int().positive()}),
 z.strictObject({action:z.literal('strategy.rollback'),command_id:z.uuid(),scope,head_version:z.number().int().positive()}),
 z.strictObject({action:z.literal('strategy.delegation'),command_id:z.uuid(),scope,head_version:z.number().int().positive(),allowed:z.boolean()}),
 z.strictObject({action:z.literal('strategy.delete'),command_id:z.uuid(),id:z.uuid()})
]);
type Command=z.infer<typeof StrategyCommandSchema>;
type Datum=StrategyDatum&{scope:StrategyScope;input:Record<string,unknown>};
type Member={id:string;split:'train'|'test';group:string};
const memberSchema=z.array(z.object({id:z.uuid(),split:z.enum(['train','test']),group:z.string()}));
const shadowSchema=z.array(z.object({id:z.uuid()}));
async function lock(tx:Tx,t:string){await tx`select pg_advisory_xact_lock(hashtextextended(${t+':strategy'},0))`;}
async function heads(tx:Tx,t:string,u:string){for(const s of ['search','tool_selection'])await tx`insert into app.strategy_heads(tenant_id,scope,owner_id) values(${t}::uuid,${s},${u}::uuid) on conflict do nothing`;await activeStrategies(tx,t);return tx`select * from app.strategy_heads where tenant_id=${t}::uuid order by scope for update`;}
async function loadCase(tx:Tx,t:string,id:string):Promise<Datum|null>{
 const [c]=await tx`select * from app.strategy_cases where tenant_id=${t}::uuid and id=${id}::uuid`;if(!c)return null;
 const hashes:string[]=[];for(const ref of c.source_refs){const [r]=await tx`select b.sha256 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id where r.tenant_id=${t}::uuid and r.id=${ref.revision}::uuid and app.revision_accessible(r.tenant_id,r.id)`;if(!r||r.sha256!==ref.sha256)return null;hashes.push(String(r.sha256));}
 if(!hashes.length)return null;
 return {id:String(c.id),tenant:t,group:String(c.context_id),project:String(c.project_id),scope:StrategyScopeSchema.parse(c.scope),sourceHashes:[...new Set(hashes)],createdAt:new Date(c.created_at).toISOString(),instruction:String(c.instruction),baseline:StrategyValueSchema.parse(c.baseline),expected:StrategyValueSchema.parse(c.expected),relevant:c.relevant,input:c.input};
}
async function loadCases(tx:Tx,t:string,ids:string[]){const result:Datum[]=[];for(const id of ids){const d=await loadCase(tx,t,id);if(!d)return null;result.push(d);}return result;}
async function usage(tx:Tx,t:string){const [r]=await tx`select coalesce(sum(attempts),0)::int calls,(now() at time zone 'Asia/Seoul')::date::text budget_day from app.strategy_evaluations where tenant_id=${t}::uuid and attempt_day=(now() at time zone 'Asia/Seoul')::date`;return {calls:Number(r!.calls),day:String(r!.budget_day),limit:100,cost_minor:0};}
async function budget(tx:Tx,t:string,u:string,needed:number){const spent=await usage(tx,t);if(spent.calls+needed<=spent.limit)return true;
 for(const h of await heads(tx,t,u))if(h.budget_hold_day!==spent.day){if(h.active_id)await rollbackStrategy(tx,t,h,'experiment_budget');await tx`update app.strategy_heads set budget_hold_day=${spent.day} where tenant_id=${t}::uuid and scope=${h.scope}`;}return false;
}
async function compare(tx:Tx,t:string,u:string,v:any,data:Datum[],phase:'test'|'shadow'|'promotion'){
 if(!await budget(tx,t,u,data.length))return null;
 const spec=StrategySpecSchema.parse(v.spec),predictions:{value:z.infer<typeof value>;ids:string[]}[]=[],baselineIds:string[][]=[];
 for(const d of data){const p=predictStrategy(d.instruction,d.baseline,spec);
  const before=v.scope==='search'?(await searchEvidence(tx,t,d.input)).map(c=>String(c.revision_id)):[];
  const found=v.scope==='search'?(await searchEvidence(tx,t,{...d.input,query:p.query})).map(c=>String(c.revision_id)):[];
  predictions.push({value:p,ids:found});baselineIds.push(before);
 }
 const score=strategyScore(data,predictions,spec.scope,baselineIds,phase==='shadow');
 for(const d of data){const prediction=predictions[data.indexOf(d)]!;await tx`insert into app.strategy_evaluations(tenant_id,version_id,case_id,phase,prediction,passed) values(${t}::uuid,${v.id}::uuid,${d.id}::uuid,${phase},${tx.json(prediction)},${score.passed}) on conflict(tenant_id,version_id,case_id,phase) do update set prediction=excluded.prediction,passed=excluded.passed,attempts=case when app.strategy_evaluations.attempt_day=excluded.attempt_day then app.strategy_evaluations.attempts+1 else 1 end,attempt_day=excluded.attempt_day`;}
 return score;
}
async function evaluateVersion(tx:Tx,t:string,u:string,v:any){
 const members=memberSchema.parse(v.members),data=await loadCases(tx,t,members.map(m=>m.id));if(!data||data.some(d=>d.scope!==v.scope))return null;
 const test=data.filter(d=>members.find(m=>m.id===d.id)!.split==='test');const fixed=v.metrics.test??await compare(tx,t,u,v,test,'test');
 if(!fixed||!fixed.passed){await tx`update app.strategy_versions set state='rejected',invalid_reason=${fixed?'evaluation_failed':'experiment_budget'},metrics=${tx.json({test:fixed})} where tenant_id=${t}::uuid and id=${v.id}::uuid`;return null;}
 const candidates=await tx`select id from app.strategy_cases where tenant_id=${t}::uuid and scope=${v.scope} and created_at>${v.created_at} order by created_at,id limit 50`,shadow:Datum[]=[];
 for(const row of candidates){const d=await loadCase(tx,t,row.id);if(d&&!data.some(old=>old.group===d.group||old.sourceHashes.some(h=>d.sourceHashes.includes(h))))shadow.push(d);}
 const same=workHash(shadow.map(d=>d.id).sort())===workHash(shadowSchema.parse(v.shadow_members).map(d=>d.id).sort());
 const compared=same&&v.metrics.shadow?v.metrics.shadow:await compare(tx,t,u,v,shadow,'shadow');
 await tx`update app.strategy_versions set state=${!compared?'rejected':compared.passed?'proposed':'awaiting_shadow'},invalid_reason=${!compared?'experiment_budget':null},metrics=${tx.json({test:fixed,shadow:compared})},shadow_members=${tx.json(shadow.map(d=>({id:d.id})))} where tenant_id=${t}::uuid and id=${v.id}::uuid`;
 return compared?.passed?{data,test,shadow}:null;
}
async function promote(tx:Tx,t:string,u:string,v:any,h:any){
 if(v.state!=='proposed')throw new ApiFault('DOMAIN_INVARIANT');const checked=await evaluateVersion(tx,t,u,v);if(!checked)return false;
 // Verify the current corpus again at the application boundary; fixed labels are never regenerated.
 const combined=[...checked.test,...checked.shadow];const final=await compare(tx,t,u,v,combined,'promotion');if(!final?.passed)return false;
 if(h.active_id)await tx`update app.strategy_versions set state='superseded' where tenant_id=${t}::uuid and id=${h.active_id}::uuid`;
 await tx`update app.strategy_versions set state='active',approved_by=${u}::uuid,approved_at=clock_timestamp() where tenant_id=${t}::uuid and id=${v.id}::uuid`;
 await tx`update app.strategy_heads set active_id=${v.id}::uuid,previous_id=${h.active_id}::uuid,version=version+1 where tenant_id=${t}::uuid and scope=${v.scope}`;return true;
}
export async function processStrategies(tx:Tx,t:string,u:string){
 await lock(tx,t);await tx`select app.purge_strategies(${t}::uuid,null)`;await activeStrategies(tx,t);
 const versions=await tx`select * from app.strategy_versions where tenant_id=${t}::uuid and state in ('evaluating','awaiting_shadow') order by created_at,id limit 10`;
 for(const v of versions){const result=await evaluateVersion(tx,t,u,v);if(result){const [h]=await tx`select * from app.strategy_heads where tenant_id=${t}::uuid and scope=${v.scope} for update`;if(h?.delegated&&(await tx`select user_id from app.memberships where tenant_id=${t}::uuid and user_id=${h.owner_id}::uuid and role='owner' and active and revoked_at is null`).length){const [current]=await tx`select * from app.strategy_versions where tenant_id=${t}::uuid and id=${v.id}::uuid`;await promote(tx,t,u,current,h);}}}
}
export async function strategyPreview(tx:Tx,t:string,u:string,b:Extract<Command,{action:'strategy.preview'}>){
 const [r]=await tx`select r.project_id,s.tool,s.input from app.agent_runs r join app.agent_steps s on s.tenant_id=r.tenant_id and s.run_id=r.id where r.tenant_id=${t}::uuid and r.id=${b.run_id}::uuid and r.user_id=${u}::uuid and s.sequence=${b.sequence}`;
 if(!r||b.scope==='search'&&r.tool!=='search_evidence')throw new ApiFault('NOT_FOUND');
 return {cards:await searchEvidence(tx,t,{...(b.scope==='search'?r.input:{}),query:b.query,project_id:r.project_id??r.input.project_id})};
}
export async function strategyCommand(tx:Tx,t:string,u:string,b:Exclude<Command,{action:'strategy.preview'}>){
 await lock(tx,t);const hs=await heads(tx,t,u);
 if(b.action==='strategy.case'){
  const [r]=await tx`select * from app.agent_runs where tenant_id=${t}::uuid and user_id=${u}::uuid and id=${b.run_id}::uuid`,[step]=await tx`select * from app.agent_steps where tenant_id=${t}::uuid and run_id=${b.run_id}::uuid and sequence=${b.sequence}`;
  const [context]=await tx`select id,project_id from app.work_contexts where tenant_id=${t}::uuid and id=${b.context_id}::uuid`,[consent]=await tx`select learning_consent_id from app.activity_consents where tenant_id=${t}::uuid and user_id=${u}::uuid and learning_allowed for share`;
  if(!r||!step||step.result.error_code||!context||!consent||r.project_id&&r.project_id!==context.project_id||step.input.context_id&&step.input.context_id!==context.id)throw new ApiFault('NOT_FOUND');
  const baseline=StrategyValueSchema.safeParse({tool:step.tool,query:typeof step.input.query==='string'?step.input.query:''});if(!baseline.success)throw new ApiFault('INVALID_CONTRACT');
  const refs=[];for(const id of [...new Set(b.evidence_refs)].sort()){const [row]=await tx`select b.sha256 from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id where r.tenant_id=${t}::uuid and r.id=${id}::uuid and app.revision_accessible(r.tenant_id,r.id)`;if(!row)throw new ApiFault('NOT_FOUND');refs.push({revision:id,sha256:String(row.sha256)});}
  let input:Record<string,unknown>=step.input,relevant:string[]=[];
  if(b.scope==='search'){
   if(baseline.data.tool!=='search_evidence'||b.expected.tool!=='search_evidence'||!b.expected.query)throw new ApiFault('INVALID_CONTRACT');
   input=EvidenceSearchSchema.parse({...step.input,project_id:r.project_id??step.input.project_id});
   const found=await searchEvidence(tx,t,{...input,query:b.expected.query});if(b.evidence_refs.some(id=>!found.some(c=>c.revision_id===id)))throw new ApiFault('NOT_FOUND');relevant=[...new Set(b.evidence_refs)].sort();if(workHash(relevant)!==workHash([...new Set(found.map(c=>c.revision_id))].sort()))throw new ApiFault('INVALID_CONTRACT');
  }else if(!canonicalReadInput(step.tool,input,r.project_id)||b.expected.query!==(b.expected.tool==='search_evidence'||b.expected.tool==='resolve_entities'?baseline.data.query:''))throw new ApiFault('INVALID_CONTRACT');
  const correction=workHash(baseline.data)!==workHash(b.expected),[saved]=await tx`insert into app.strategy_cases(tenant_id,owner_id,consent_id,scope,run_id,sequence,context_id,project_id,instruction,input,baseline,expected,relevant,source_refs,state,applied_version)
  values(${t}::uuid,${u}::uuid,${consent.learning_consent_id}::uuid,${b.scope},${b.run_id}::uuid,${b.sequence},${b.context_id}::uuid,${context.project_id}::uuid,${r.instruction},${tx.json(input as never)},${tx.json(baseline.data)},${tx.json(b.expected)},${relevant}::uuid[],${tx.json(refs)},${correction?'correction':'confirmed'},${r.strategy_versions?.[b.scope]??null}::uuid) returning id`;
  await activeStrategies(tx,t);return {saved:true,id:saved!.id};
 }
 if(b.action==='strategy.delete'){await tx`select app.purge_strategies(${t}::uuid,${b.id}::uuid)`;await activeStrategies(tx,t);return {saved:true};}
 if(b.action==='strategy.dataset'){
  const data=await loadCases(tx,t,[...new Set(b.case_ids)].sort());if(!data||data.some(d=>d.scope!==b.scope))throw new ApiFault('DOMAIN_INVARIANT');
  let members:ReturnType<typeof partitionStrategy>;try{members=partitionStrategy(data);}catch{throw new ApiFault('DOMAIN_INVARIANT');}
  const spec=proposeStrategy(b.scope,data.filter(d=>members.find(m=>m.id===d.id)!.split==='train'));if(!spec)throw new ApiFault('DOMAIN_INVARIANT');
  const fingerprint=workHash({scope:b.scope,members,labels:data.map(d=>[d.id,d.expected,d.relevant,d.sourceHashes]),criteria:'strategy-eval-v1',spec});
  await tx`insert into app.strategy_versions(tenant_id,scope,members,spec,fingerprint) values(${t}::uuid,${b.scope},${tx.json(members)},${tx.json(spec)},${fingerprint}) on conflict(tenant_id,fingerprint) do nothing`;
  await processStrategies(tx,t,u);return {saved:true};
 }
 if(b.action==='strategy.evaluate'){await processStrategies(tx,t,u);return {saved:true};}
 const h=hs.find(h=>h.scope===b.scope)!;if(h.version!==b.head_version)throw new ApiFault('VERSION_CONFLICT');
 if(b.action==='strategy.delegation'){await tx`update app.strategy_heads set delegated=${b.allowed},owner_id=${u}::uuid,version=version+1 where tenant_id=${t}::uuid and scope=${b.scope}`;return {saved:true};}
 if(b.action==='strategy.rollback'){await rollbackStrategy(tx,t,h,'owner_rollback');return {saved:true};}
 const [v]=await tx`select * from app.strategy_versions where tenant_id=${t}::uuid and id=${b.id}::uuid and scope=${b.scope} for update`;if(!v)throw new ApiFault('NOT_FOUND');return {saved:await promote(tx,t,u,v,h)};
}
export async function strategyReport(tx:Tx,t:string,u:string){
 await lock(tx,t);await tx`select app.purge_strategies(${t}::uuid,null)`;const hs=await heads(tx,t,u);
 const cases=await tx`select id,scope,context_id,project_id,instruction,baseline,expected,state,created_at from app.strategy_cases where tenant_id=${t}::uuid order by created_at desc,id limit 50`;
 const versions=[];for(const v of await tx`select * from app.strategy_versions where tenant_id=${t}::uuid order by created_at desc,id limit 20`){const all=[...memberSchema.parse(v.members),...shadowSchema.parse(v.shadow_members)];const current=await loadCases(tx,t,all.map(m=>m.id));versions.push({id:v.id,scope:v.scope,state:current?v.state:'rolled_back',spec:current?StrategySpecSchema.safeParse(v.spec).data??null:null,metrics:current?v.metrics:{},invalid_reason:current?v.invalid_reason:'source_unavailable'});}
 const runs=await tx`select r.id,r.instruction,r.project_id,s.sequence,s.tool,s.input from app.agent_runs r join app.agent_steps s on s.tenant_id=r.tenant_id and s.run_id=r.id where r.tenant_id=${t}::uuid and r.user_id=${u}::uuid and r.created_at>now()-interval '90 days' and s.tool in ('search_evidence','resolve_entities','list_exceptions','get_artifact') and not s.result ? 'error_code' order by r.created_at desc,s.sequence desc limit 30`;
 const contexts=await tx`select c.id,c.project_id,c.label,p.display_name project_name from app.work_contexts c join app.projects p on p.tenant_id=c.tenant_id and p.id=c.project_id where c.tenant_id=${t}::uuid order by c.created_at desc,c.id limit 100`;
 return {heads:hs.map(h=>({scope:h.scope,active_id:h.active_id,previous_id:h.previous_id,version:h.version,delegated:h.delegated})),cases,versions,runs,contexts,usage:await usage(tx,t),criteria:'strategy-eval-v1',scope:'owner_confirmed_read_only',paid_model_calls:0};
}
