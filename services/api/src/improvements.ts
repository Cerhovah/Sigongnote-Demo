import {StrategyCommandSchema,strategyPreview,strategyCommand,strategyReport,processStrategies} from './strategy-improvements.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {EvaluationCriteriaSchema,ImprovementSpecSchema,EvalPredictionSchema,WorkEffectSchema,partitionLearning,learningGroups,proposeImprovement,interpretImprovement,scoreImprovement,withinImprovementScope,type LearningDatum,type LocalEvaluationPort} from '@sigongnote/domain';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {workHash} from './work-decisions.js';
import {activeImprovement} from './improvement-runtime.js';
const defaultDelegation={allowed:false,scope:'quality_interpretation',criteria_version:'work-eval-v1',max_calls:100,max_cost_minor:0} as const;
const criteria=EvaluationCriteriaSchema.parse({version:'work-eval-v1',min_test_groups:1,min_shadow_groups:1,max_errors:0,max_protected_changes:0,max_high_confidence_errors:0,min_improvement:1});
const delegation=z.strictObject({allowed:z.boolean(),scope:z.literal('quality_interpretation'),criteria_version:z.literal('work-eval-v1'),max_calls:z.number().int().min(2).max(200),max_cost_minor:z.number().int().min(0).max(10000)});
const command=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('dataset'),command_id:z.uuid(),case_ids:z.array(z.uuid()).min(2).max(50),criteria:EvaluationCriteriaSchema}),
 z.strictObject({action:z.literal('promote'),command_id:z.uuid(),id:z.uuid(),head_version:z.number().int().positive()}),
 z.strictObject({action:z.literal('rollback'),command_id:z.uuid(),head_version:z.number().int().positive(),reason:z.string().trim().min(3).max(200)}),
 z.strictObject({action:z.literal('delegation'),command_id:z.uuid(),head_version:z.number().int().positive(),delegation}),
 z.strictObject({action:z.literal('evaluate'),command_id:z.uuid()})
]);
const member=z.object({id:z.uuid(),version:z.number().int().positive(),group:z.string(),split:z.enum(['test','train'])});
const members=z.array(member);
async function owner(tx:Tx,t:string,u:string){if(await membership(tx,t,u)!=='owner')throw new ApiFault('NOT_FOUND');}
async function head(tx:Tx,t:string,u:string){await tx`insert into app.improvement_heads(tenant_id,owner_id) values(${t}::uuid,${u}::uuid) on conflict do nothing`;await activeImprovement(tx,t);return (await tx`select * from app.improvement_heads where tenant_id=${t}::uuid for update`)[0]!;}

export async function learningDatum(tx:Tx,t:string,id:string,version?:number):Promise<LearningDatum|null>{
 const [e]=await tx`select e.*,c.created_at proposed_at,c.context_id,c.project_id from app.decision_examples e join app.decisions d on d.tenant_id=e.tenant_id and d.id=e.decision_id join app.work_decision_cases c on c.tenant_id=d.tenant_id and c.id=d.target_ids[1] where e.tenant_id=${t}::uuid and e.id=${id}::uuid and e.learning_state in ('confirmed','correction') and e.created_at>now()-interval '90 days' and (${version??null}::integer is null or e.learning_version=${version??null})`;
 if(!e)return null;
 const refs=z.array(z.object({revision:z.uuid(),span:z.number().int().nonnegative()})).parse(e.learning_snapshot.source_refs),texts:string[]=[],hashes:string[]=[];
 for(const ref of refs){const [source]=await tx`select b.sha256,p.output->'spans'->${ref.span}::int text from app.document_revisions r join app.evidence_blobs b on b.tenant_id=r.tenant_id and b.id=r.blob_id join lateral(select output from app.parse_results where tenant_id=r.tenant_id and revision_id=r.id and created_at<=${e.proposed_at} order by created_at desc,job_id desc limit 1)p on true where r.tenant_id=${t}::uuid and r.id=${ref.revision}::uuid and app.revision_accessible(r.tenant_id,r.id)`;if(!source?.text?.text)return null;texts.push(String(source.text.text));hashes.push(String(source.sha256));}
 const sourceText=texts.join('\n');if(sourceText.length>20000)return null;
 return {id,version:e.learning_version,tenant:t,project:e.project_id,group:e.context_id,period:e.learning_snapshot.period,sourceHashes:[...new Set(hashes)].sort(),sourceText,proposal:z.array(WorkEffectSchema).parse(e.proposal.effects),expected:z.array(WorkEffectSchema).parse(e.answer),state:e.learning_state,createdAt:new Date(e.created_at).toISOString()};
}
async function dataFor(tx:Tx,t:string,items:{id:string;version?:number}[]){const data:LearningDatum[]=[];for(const m of items){const d=await learningDatum(tx,t,m.id,m.version);if(!d)return null;data.push(d);}return data;}
async function rollback(tx:Tx,t:string,h:any,reason:string){
 if(h.active_id)await tx`update app.improvement_versions set state='rolled_back',invalid_reason=${reason} where tenant_id=${t}::uuid and id=${h.active_id}::uuid`;
 const previous=h.previous_id&&(await tx`select app.improvement_version_allowed(${t}::uuid,${h.previous_id}::uuid) ok`)[0]?.ok===true?h.previous_id:null;
 if(previous)await tx`update app.improvement_versions set state='active' where tenant_id=${t}::uuid and id=${previous}::uuid`;
 await tx`update app.improvement_heads set active_id=${previous}::uuid,previous_id=null,version=version+1 where tenant_id=${t}::uuid`;
}
async function promote(tx:Tx,t:string,u:string,id:string,h:any){
 const budget=delegation.parse(h.delegation),[spent]=await tx`select app.improvement_budget_usage(${t}::uuid) value`;if(spent!.value.calls>budget.max_calls||spent!.value.cost>budget.max_cost_minor)throw new ApiFault('DOMAIN_INVARIANT');
 const [v]=await tx`select * from app.improvement_versions where tenant_id=${t}::uuid and id=${id}::uuid for update`;if(!v||v.state!=='proposed'||!v.metrics.test?.passed||!v.metrics.shadow?.passed)throw new ApiFault('DOMAIN_INVARIANT');
 if(h.active_id)await tx`update app.improvement_versions set state='superseded' where tenant_id=${t}::uuid and id=${h.active_id}::uuid`;
 await tx`update app.improvement_versions set state='active',approved_by=${u}::uuid,approved_at=now() where tenant_id=${t}::uuid and id=${id}::uuid`;
 await tx`update app.improvement_heads set active_id=${id}::uuid,previous_id=${h.active_id}::uuid,version=version+1 where tenant_id=${t}::uuid`;
}

/** Durable attempts are committed before any optional local model invocation. */
export async function runLocalShadow(services:Services,t:string,u:string,id:string,caseId:string,port:LocalEvaluationPort,signal:AbortSignal){
 if(port.kind!=='local'||!/^[a-zA-Z0-9_.-]{1,100}$/.test(port.name))throw new ApiFault('INVALID_CONTRACT');
 const reserved=await services.db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${u},true)`;await owner(tx,t,u);const h=await head(tx,t,u),budget=delegation.parse(h.delegation);
  const [v]=await tx`select * from app.improvement_versions where tenant_id=${t}::uuid and id=${id}::uuid`;if(!v)throw new ApiFault('NOT_FOUND');const d=await learningDatum(tx,t,caseId);if(!d)throw new ApiFault('NOT_FOUND');
  const old=await tx`select state from app.improvement_experiments where tenant_id=${t}::uuid and version_id=${id}::uuid and case_id=${caseId}::uuid and case_version=${d.version} and phase='local_shadow' and adapter=${port.name}`;if(old.length)return null;
  const [spent]=await tx`select app.improvement_budget_usage(${t}::uuid) value`;
  if(spent!.value.calls>=budget.max_calls||spent!.value.cost>budget.max_cost_minor)throw new ApiFault('DOMAIN_INVARIANT');
  const attempt=randomUUID();await tx`insert into app.improvement_experiments(tenant_id,id,version_id,case_id,case_version,phase,adapter,state) values(${t}::uuid,${attempt}::uuid,${id}::uuid,${caseId}::uuid,${d.version},'local_shadow',${port.name},'submitted')`;
  return {attempt,version:d.version,input:{sourceText:d.sourceText,proposal:d.proposal},spec:ImprovementSpecSchema.parse(v.spec)};
 });if(!reserved)return 'not_repeated';
 let prediction:unknown=null,state='unknown';const bounded=AbortSignal.any([signal,AbortSignal.timeout(15000)]);let onAbort:()=>void=()=>{};
 try{bounded.throwIfAborted();const cancelled=new Promise<never>((_,reject)=>{onAbort=()=>reject(Error('CANCELLED'));bounded.addEventListener('abort',onAbort,{once:true});});
  const value=EvalPredictionSchema.parse(await Promise.race([port.predict(structuredClone(reserved.input),structuredClone(reserved.spec),bounded),cancelled]));bounded.throwIfAborted();state=withinImprovementScope(reserved.input,value)?'completed':'rejected';if(state==='completed')prediction=value;
 }catch{/* An interrupted local attempt is retained and is not automatically repeated. */}finally{bounded.removeEventListener('abort',onAbort);}
 return services.db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${u},true)`;if(!await learningDatum(tx,t,caseId,reserved.version))return 'withdrawn';await tx`update app.improvement_experiments set state=${state},prediction=${prediction?tx.json(prediction as never):null}::jsonb,actual_minor=${state==='completed'?0:null} where tenant_id=${t}::uuid and id=${reserved.attempt}::uuid`;return state;});
}

export async function processImprovements(tx:Tx,t:string,u:string){
 await owner(tx,t,u);await tx`select pg_advisory_xact_lock(hashtextextended(${t+':improvement'},0))`;let h=await head(tx,t,u);const budget=delegation.parse(h.delegation);
 const [today]=await tx`select app.improvement_budget_usage(${t}::uuid) value,(now() at time zone 'Asia/Seoul')::date::text budget_day`;
 // One budget incident restores the prior pass; subsequent ticks keep that fallback usable.
 if(h.budget_hold_day!==today!.budget_day&&(today!.value.calls>budget.max_calls||today!.value.cost>budget.max_cost_minor)){if(h.active_id)await rollback(tx,t,h,'experiment_budget');await tx`update app.improvement_heads set budget_hold_day=${today!.budget_day} where tenant_id=${t}::uuid`;h=await head(tx,t,u);}
 if(h.active_id){const [bad]=await tx`select id from app.decision_examples where tenant_id=${t}::uuid and learning_state='correction' and learning_snapshot->>'improvement_version'=${h.active_id}::text limit 1`;if(bad)await rollback(tx,t,h,'important_error');}
 const datasets=await tx`select * from app.improvement_datasets where tenant_id=${t}::uuid order by created_at desc limit 10`;
 for(const dataset of datasets){const ms=members.parse(dataset.members),data=await dataFor(tx,t,ms);if(!data)continue;
  const spec=proposeImprovement(data.filter(d=>ms.find(m=>m.id===d.id)!.split==='train')),fingerprint=workHash([dataset.fingerprint,spec]);if(!spec.rules.length)continue;
  await tx`insert into app.improvement_versions(tenant_id,dataset_id,spec,fingerprint) values(${t}::uuid,${dataset.id}::uuid,${tx.json(spec)},${fingerprint}) on conflict(tenant_id,fingerprint) do nothing`;
 }
 const versions=await tx`select v.*,d.members,d.criteria from app.improvement_versions v join app.improvement_datasets d on d.tenant_id=v.tenant_id and d.id=v.dataset_id where v.tenant_id=${t}::uuid and v.state in ('evaluating','awaiting_shadow') order by v.created_at limit 10`;
 for(const v of versions){const ms=members.parse(v.members),data=await dataFor(tx,t,ms);if(!data)continue;const spec=ImprovementSpecSchema.parse(v.spec),rules=EvaluationCriteriaSchema.parse(v.criteria);
  const test=data.filter(d=>ms.find(m=>m.id===d.id)!.split==='test').map(d=>({...d,group:ms.find(m=>m.id===d.id)!.group}));const score=scoreImprovement(test,test.map(d=>interpretImprovement(d,spec)),rules);
  const [usageRow]=await tx`select app.improvement_budget_usage(${t}::uuid) value`;const usage=usageRow!.value;
  const existing=await tx`select case_id from app.improvement_experiments where tenant_id=${t}::uuid and version_id=${v.id}::uuid and phase='test'`;const missing=test.filter(d=>!existing.some(e=>e.case_id===d.id));
  if(usage.calls+missing.length>budget.max_calls||usage.cost>budget.max_cost_minor){await tx`update app.improvement_versions set state='rejected',invalid_reason='experiment_budget' where tenant_id=${t}::uuid and id=${v.id}::uuid`;continue;}
  for(const d of missing)await tx`insert into app.improvement_experiments(tenant_id,version_id,case_id,case_version,phase,adapter,state,prediction,actual_minor) values(${t}::uuid,${v.id}::uuid,${d.id}::uuid,${d.version},'test','builtin-evidence-quality-v1','completed',${tx.json(interpretImprovement(d,spec))},0) on conflict do nothing`;
  if(!score.passed){await tx`update app.improvement_versions set state='rejected',metrics=${tx.json({test:score})},invalid_reason='evaluation_failed' where tenant_id=${t}::uuid and id=${v.id}::uuid`;continue;}
  // Only later, independently reviewed work can provide shadow correctness labels.
  const later=await tx`select id,learning_version version from app.decision_examples where tenant_id=${t}::uuid and created_at>${v.created_at} and learning_state in ('confirmed','correction') order by created_at,id limit 50`;
  const shadow:LearningDatum[]=[];for(const row of later){const d=await learningDatum(tx,t,row.id,row.version);if(d&&!data.some(old=>old.group===d.group||old.sourceHashes.some(hash=>d.sourceHashes.includes(hash))))shadow.push(d);}
  const groupedShadow=learningGroups(shadow).flatMap(g=>g.map(d=>({...d,group:g[0]!.id}))),predictions=groupedShadow.map(d=>interpretImprovement(d,spec));
  const shadowCriteria={...rules,min_test_groups:rules.min_shadow_groups},shadowScore={...scoreImprovement(groupedShadow,predictions,shadowCriteria,true),applied_samples:predictions.filter(p=>p.confidence===1).length};shadowScore.passed&&=shadowScore.applied_samples>0;
  const beforeShadow=await tx`select case_id from app.improvement_experiments where tenant_id=${t}::uuid and version_id=${v.id}::uuid and phase='shadow'`;const newShadow=shadow.filter(d=>!beforeShadow.some(x=>x.case_id===d.id));
  if(usage.calls+missing.length+newShadow.length>budget.max_calls){await tx`update app.improvement_versions set state='rejected',invalid_reason='experiment_budget' where tenant_id=${t}::uuid and id=${v.id}::uuid`;continue;}
  for(const d of newShadow)await tx`insert into app.improvement_experiments(tenant_id,version_id,case_id,case_version,phase,adapter,state,prediction,actual_minor) values(${t}::uuid,${v.id}::uuid,${d.id}::uuid,${d.version},'shadow','builtin-evidence-quality-v1','completed',${tx.json(interpretImprovement(d,spec))},0) on conflict do nothing`;
  await tx`update app.improvement_versions set state=${shadowScore.passed?'proposed':'awaiting_shadow'},metrics=${tx.json({test:score,shadow:shadowScore})},shadow_members=${tx.json(shadow.map(d=>({id:d.id,version:d.version})))} where tenant_id=${t}::uuid and id=${v.id}::uuid`;
  const grantor=await tx`select user_id from app.memberships where tenant_id=${t}::uuid and user_id=${h.owner_id}::uuid and active and revoked_at is null and role='owner'`;
  if(shadowScore.passed&&budget.allowed&&workHash(rules)===workHash(criteria)&&grantor.length)await promote(tx,t,String(h.owner_id),v.id,await head(tx,t,u));
 }
 await processStrategies(tx,t,u);return head(tx,t,u);
}
export function startImprovements(app:FastifyInstance,services:Services){let running=false;const tick=async()=>{if(running)return;running=true;try{await services.db`select app.purge_improvements()`;await services.db`select app.purge_strategies()`;for(const row of await services.db`select * from app.improvement_workspaces()`)try{await services.db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${String(row.owner_id)},true)`;await processImprovements(tx,String(row.tenant_id),String(row.owner_id));});}catch{/* Each workspace retries independently without model submissions. */}}finally{running=false;}};const timer=setInterval(()=>{void tick().catch(()=>{});},60000);timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);});}
export function registerImprovements(app:FastifyInstance,services:Services){
 app.get('/v1/improvements',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),t=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{await owner(tx,t,actor.userId);const [stored]=await tx`select * from app.improvement_heads where tenant_id=${t}::uuid`;const h=stored?await head(tx,t,actor.userId):{active_id:null,previous_id:null,version:1,delegation:defaultDelegation};return {status:200,body:{head:{active_id:h.active_id,previous_id:h.previous_id,version:h.version,delegation:h.delegation},criteria,usage:(await tx`select app.improvement_budget_usage(${t}::uuid) value`)[0]!.value,datasets:await tx`select id,criteria,created_at,jsonb_array_length(members) samples from app.improvement_datasets where tenant_id=${t}::uuid order by created_at desc limit 20`,versions:await tx`select id,dataset_id,state,spec,metrics,invalid_reason,created_at,approved_at from app.improvement_versions where tenant_id=${t}::uuid order by created_at desc limit 20`,strategies:await strategyReport(tx,t,actor.userId),scope:'quality_interpretation',local_port:'shadow_only',paid_model_connection:'not_configured'}};});}));
 app.post('/v1/improvements/commands',async(req,reply)=>execute(reply.header('Cache-Control','no-store'),async()=>{const actor=await principal(req,services),t=tenantHeader(req);const strategy=StrategyCommandSchema.safeParse(req.body);
 if(strategy.success){const b=strategy.data;return inAuthorizedTransaction(services.db,actor,async tx=>{await owner(tx,t,actor.userId);if(b.action==='strategy.preview')return {status:200,body:await strategyPreview(tx,t,actor.userId,b)};
  return once(tx,t,actor.userId,'POST /v1/improvements/commands',b.command_id,workHash(b),async()=>{await head(tx,t,actor.userId);return {status:200,body:await strategyCommand(tx,t,actor.userId,b)};});});}
 const p=command.safeParse(req.body);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;return inAuthorizedTransaction(services.db,actor,async tx=>{await owner(tx,t,actor.userId);return once(tx,t,actor.userId,'POST /v1/improvements/commands',b.command_id,workHash(b),async()=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${t+':improvement'},0))`;const h=await head(tx,t,actor.userId);
  if(b.action==='dataset'){const data=await dataFor(tx,t,[...b.case_ids].sort().map(id=>({id})));if(!data)throw new ApiFault('DOMAIN_INVARIANT');let ms:ReturnType<typeof partitionLearning>;try{ms=partitionLearning(data);}catch{throw new ApiFault('DOMAIN_INVARIANT');}const fingerprint=workHash({members:ms,answers:data.map(d=>[d.id,d.expected,d.sourceHashes]),criteria:b.criteria});
   await tx`insert into app.improvement_datasets(tenant_id,owner_id,members,criteria,fingerprint) values(${t}::uuid,${actor.userId}::uuid,${tx.json(ms)},${tx.json(b.criteria)},${fingerprint}) on conflict(tenant_id,fingerprint) do nothing`;await processImprovements(tx,t,actor.userId);
  }else if(b.action==='evaluate')await processImprovements(tx,t,actor.userId);
  else{if(h.version!==b.head_version)throw new ApiFault('VERSION_CONFLICT');if(b.action==='delegation')await tx`update app.improvement_heads set delegation=${tx.json(b.delegation)},budget_hold_day=case when ${b.delegation.max_calls}>coalesce((delegation->>'max_calls')::int,0) or ${b.delegation.max_cost_minor}>coalesce((delegation->>'max_cost_minor')::int,0) then null else budget_hold_day end,owner_id=${actor.userId}::uuid,version=version+1 where tenant_id=${t}::uuid`;else if(b.action==='promote')await promote(tx,t,actor.userId,b.id,h);else await rollback(tx,t,h,'owner_rollback');}
  return {status:200,body:{saved:true,business_effects_changed:false}};
 });});}));
}
