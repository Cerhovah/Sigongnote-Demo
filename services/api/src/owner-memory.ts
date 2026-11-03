import {normalizedPolicyEffects,policyCondition,qualifyCommandSchema,qualifyOwnerPolicy} from './owner-qualification.js';
import {applyNormalWork,validateNormalSources,normalFactEligibility} from './normal-facts.js';
import type {CapturePolicy} from './capture-scope.js';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {WorkEffectSchema,type WorkEffect} from '@sigongnote/domain';
import {inAuthorizedTransaction,type Db,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {executeWorkCommand,readWorkIssues,workHash} from './work-decisions.js';
const scope=z.enum(['once','work','project','contract','party','company']);
const days=z.number().int().min(1).max(365);
const money=z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
const command=z.discriminatedUnion('action',[
 qualifyCommandSchema(),
 z.strictObject({action:z.literal('remember'),command_id:z.uuid(),decision_id:z.uuid(),scope,valid_days:days,max_amount_minor:money}),
 z.strictObject({action:z.literal('revise'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive(),valid_days:days,max_amount_minor:money,effects:z.array(WorkEffectSchema).min(1).max(6).optional()}),
 z.strictObject({action:z.literal('revoke'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive()}),
 z.strictObject({action:z.literal('alias'),command_id:z.uuid(),project_id:z.uuid(),alias:z.string().trim().min(2).max(100)}),
 z.strictObject({action:z.literal('revoke_alias'),command_id:z.uuid(),id:z.uuid(),version:z.number().int().positive()})
]);
export const normalizedEffects=normalizedPolicyEffects;
export const memoryCondition=policyCondition;
async function partyFor(tx:Tx,tenant:string,effects:WorkEffect[]){const ids=effects.filter(e=>e.kind==='charge_adjustment').map(e=>e.charge_id);if(ids.length!==1)return null;const [row]=await tx`select r.payload->>'partyId' id from app.charge_cases c join app.charge_revisions r on r.tenant_id=c.tenant_id and r.id=c.current_revision_id where c.tenant_id=${tenant}::uuid and c.id=${ids[0]!}::uuid`;return row?.id?String(row.id):null;}
export async function memoryCommand(tx:Tx,tenant:string,user:string,input:unknown,capturePolicy?:CapturePolicy){
 const p=command.safeParse(input);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;
 if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');
 return once(tx,tenant,user,'POST /v1/owner-policies/commands',b.command_id,workHash(b),async()=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':work-issues'},0))`;
  if(b.action==='alias'){
   const [prior]=await tx`select id,version,project_id from app.entity_aliases where tenant_id=${tenant}::uuid and lower(alias)=lower(${b.alias}) and revoked_at is null and evidence_revision is null`;if(prior){if(prior.project_id!==b.project_id)throw new ApiFault('DOMAIN_INVARIANT');return {status:200,body:prior};}
   if(!(await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${b.project_id}::uuid`).length)throw new ApiFault('NOT_FOUND');
   if((await tx`select id from app.projects where tenant_id=${tenant}::uuid and lower(display_name)=lower(${b.alias}) and id<>${b.project_id}::uuid`).length)throw new ApiFault('DOMAIN_INVARIANT');
   const [r]=await tx`insert into app.entity_aliases(tenant_id,project_id,alias,actor_id) values(${tenant}::uuid,${b.project_id}::uuid,${b.alias},${user}::uuid) returning id,version`;return {status:200,body:r};
  }
  if(b.action==='revoke_alias'){const [r]=await tx`update app.entity_aliases set revoked_at=now(),version=version+1 where tenant_id=${tenant}::uuid and id=${b.id}::uuid and version=${b.version} and revoked_at is null returning id,version`;if(!r)throw new ApiFault('VERSION_CONFLICT');return {status:200,body:r};}
  if(b.action==='remember'){
   const [record]=await tx`select e.*,c.id issue_id,c.category,c.prompt,c.proposal,c.project_id,w.label, d.actor_kind from app.work_command_effects e join app.decisions d on d.tenant_id=e.tenant_id and d.id=e.decision_id join app.work_decision_cases c on c.tenant_id=d.tenant_id and c.id=d.target_ids[1] join app.work_contexts w on w.tenant_id=c.tenant_id and w.id=c.context_id where e.tenant_id=${tenant}::uuid and e.decision_id=${b.decision_id}::uuid`;
   if(!record||record.actor_kind!=='human')throw new ApiFault('NOT_FOUND');
   const effects=z.array(WorkEffectSchema).parse(record.effects);if(effects.some(e=>e.kind==='charge_adjustment'&&BigInt(e.amount_minor)>BigInt(b.max_amount_minor)))throw new ApiFault('DOMAIN_INVARIANT');
   await tx`insert into app.decision_examples(tenant_id,decision_id,scope_type,proposal,answer,result) values(${tenant}::uuid,${b.decision_id}::uuid,${b.scope},${tx.json(record.proposal)},${tx.json(effects)},${tx.json(record.after_state)})`;
   if(b.scope==='once')return {status:200,body:{scope:'once',automatic:false}};
   if(Object.keys(record.proposal.cost_options??{}).length)throw new ApiFault('DOMAIN_INVARIANT');
   const scopeId=b.scope==='company'?null:b.scope==='project'?String(record.project_id):b.scope==='work'?String(record.context_id):b.scope==='contract'?await contractFor(tx,tenant,record.context_id):await partyFor(tx,tenant,effects);if(b.scope!=='company'&&!scopeId)throw new ApiFault('DOMAIN_INVARIANT');
   const [same]=await tx`select id,version from app.owner_policies where tenant_id=${tenant}::uuid and example_decision_id=${b.decision_id}::uuid and grantor_user_id=${user}::uuid and scope_type=${b.scope} and scope_id is not distinct from ${scopeId}::uuid and revoked_at is null and valid_until>now() and max_amount_minor=${b.max_amount_minor}::numeric and effects=${tx.json(effects)}::jsonb`;if(same)return {status:200,body:{...same,automatic:!record.proposal.semantic_basis,qualification_required:!!record.proposal.semantic_basis}};
   const [policy]=await tx`insert into app.owner_policies(tenant_id,grantor_user_id,allowed_effects,max_amount_minor,valid_until,scope_type,scope_id,category,work_label,condition_hash,effects,example_decision_id) values(${tenant}::uuid,${user}::uuid,${effects.map(e=>e.kind)}::text[],${b.max_amount_minor}::numeric,now()+${b.valid_days}*interval '1 day',${b.scope},${scopeId}::uuid,${record.category},${record.label},${memoryCondition(record as any)},${tx.json(effects)},${b.decision_id}::uuid) returning id,version`;
   return {status:200,body:{...policy,automatic:!record.proposal.semantic_basis,qualification_required:!!record.proposal.semantic_basis}};
  }
  const [current]=await tx`select * from app.owner_policies where tenant_id=${tenant}::uuid and id=${b.id}::uuid for update`;
  if(!current)throw new ApiFault('NOT_FOUND');if(Number(current.version)!==b.version||current.revoked_at)throw new ApiFault('VERSION_CONFLICT');
  if(b.action==='qualify')return qualifyOwnerPolicy(tx,tenant,user,current,b,capturePolicy);
  if(b.action==='revoke')await tx`update app.owner_policies set version=version+1,revoked_at=now() where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;
  else {
   const [example]=await tx`select c.proposal from app.work_decision_cases c join app.decisions d on d.tenant_id=c.tenant_id and d.target_ids[1]=c.id where d.tenant_id=${tenant}::uuid and d.id=${current.example_decision_id}::uuid`;
   if(example?.proposal.semantic_basis&&b.effects&&workHash(b.effects)!==workHash(current.effects))throw new ApiFault('INVALID_CONTRACT');
   const effects=b.effects??z.array(WorkEffectSchema).parse(current.effects),old=z.array(WorkEffectSchema).parse(current.effects);
   if(effects.length!==old.length||effects.some((e,i)=>e.kind!==old[i]!.kind||(e.kind==='charge_adjustment'||e.kind==='liability')&&workHash(e)!==workHash(old[i])||e.kind==='acceptance'&&old[i]!.kind==='acceptance'&&(e.unit!==old[i]!.unit||e.ordered!==old[i]!.ordered)))throw new ApiFault('INVALID_CONTRACT');
   await tx`update app.owner_policies set version=version+1,grantor_user_id=${user}::uuid,valid_until=now()+${b.valid_days}*interval '1 day',max_amount_minor=${b.max_amount_minor}::numeric,effects=${tx.json(effects)},semantic_qualification=case when grantor_user_id=${user}::uuid and effects=${tx.json(effects)}::jsonb then semantic_qualification else null end where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;
  }
  return {status:200,body:{id:b.id,version:b.version+1,revoked:b.action==='revoke'}};
 });
}
export async function applyOwnerMemory(tx:Tx,tenant:string,user:string,capturePolicy?:CapturePolicy){
 if(await membership(tx,tenant,user)!=='owner')return {applied:0,conflicts:[] as string[]};
 const {questions}=await readWorkIssues(tx,tenant,user,true,capturePolicy);const conflicts:string[]=[];let applied=0;
 for(const issue of questions.slice(0,20)){
  await tx`update app.work_decision_cases set last_policy_attempt_at=clock_timestamp(),policy_hold_reason=null where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;
  if(issue.proposal.blocked||Object.keys(issue.proposal.cost_options??{}).length||issue.cause==='today_blocked')continue;
  const party=await partyFor(tx,tenant,issue.proposal.effects),contract=await contractFor(tx,tenant,issue.context_id);
  const rules=await tx`select * from app.owner_policies where tenant_id=${tenant}::uuid and revoked_at is null and valid_until>now() and category=${issue.category} and work_label=${issue.work_label} and condition_hash=${memoryCondition(issue as any)} and ((scope_type='work' and scope_id=${issue.context_id}::uuid) or (scope_type='project' and scope_id=${issue.project_id}::uuid) or (scope_type='contract' and scope_id=${contract}::uuid) or (scope_type='party' and scope_id=${party}::uuid) or scope_type='company') order by case scope_type when 'work' then 0 when 'contract' then 1 when 'project' then 2 when 'party' then 3 else 4 end,id`;
  const valid=[];for(const r of rules){const [grant]=await tx`select role from app.memberships where tenant_id=${tenant}::uuid and user_id=${r.grantor_user_id}::uuid and active and revoked_at is null`;if(grant?.role==='owner')valid.push(r);}
  const selected=valid[0];if(!selected)continue;const rank=selected.scope_type;const peers=valid.filter(r=>r.scope_type===rank);
  if(peers.some(r=>workHash(normalizedEffects(r.effects))!==workHash(normalizedEffects(selected.effects)))){conflicts.push(String(issue.id));await tx`update app.work_decision_cases set policy_hold_reason='conflict' where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;continue;}
  // The scheduler runs as the explicit grantor, never as an invented auth user.
  if(selected.grantor_user_id!==user)continue;
  const effects:WorkEffect[]=selected.effects.map((e:WorkEffect,i:number)=>e.kind==='charge_adjustment'?{...e,charge_id:issue.proposal.effects[i].charge_id,version:issue.proposal.effects[i].version}:e);
  if(effects.some(e=>!selected.allowed_effects.includes(e.kind)||e.kind==='charge_adjustment'&&BigInt(e.amount_minor)>BigInt(selected.max_amount_minor))){await tx`update app.work_decision_cases set policy_hold_reason='limit' where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;continue;}
  try{const result=await applyNormalWork(tx,tenant,user,issue,selected,effects,capturePolicy);if(result.state==='auto_apply')applied++;else await tx`update app.work_decision_cases set policy_hold_reason=${result.reason==='type_not_qualified'?'qualification':result.state==='retryable'?'retry':result.state==='blocked_scope'?'source':'candidate'} where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;}
  catch{await tx`update app.work_decision_cases set policy_hold_reason='retry' where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;}
 }
 return {applied,conflicts};
}
export async function runOwnerMemory(db:Db,stopped=()=>false,capturePolicy?:CapturePolicy){
 const rows=await db`select * from app.owner_policy_workspaces()`;
 for(const row of rows){if(stopped())break;try{await db.begin(async tx=>{await tx`select set_config('request.jwt.claim.sub',${String(row.grantor_user_id)},true)`;await tx`select pg_advisory_xact_lock(hashtextextended(${String(row.tenant_id)+':work-issues'},0))`;await applyOwnerMemory(tx,String(row.tenant_id),String(row.grantor_user_id),capturePolicy);});}catch{/* Retry independently next tick. */}}
}
export function registerOwnerMemory(app:FastifyInstance,services:Services){
 app.get('/v1/owner-policies',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');const policies=await tx`select p.*,c.prompt condition_prompt,c.proposal semantic_proposal,pr.display_name project_name from app.owner_policies p join app.decisions d on d.tenant_id=p.tenant_id and d.id=p.example_decision_id join app.work_decision_cases c on c.tenant_id=d.tenant_id and c.id=d.target_ids[1] left join app.projects pr on pr.tenant_id=p.tenant_id and pr.id=p.scope_id where p.tenant_id=${tenant}::uuid order by p.created_at desc limit 100`;const aliases=await tx`select a.*,p.display_name project_name from app.entity_aliases a join app.projects p on p.tenant_id=a.tenant_id and p.id=a.project_id where a.tenant_id=${tenant}::uuid and a.revoked_at is null order by a.created_at desc limit 100`;const recent=await tx`select d.id,d.created_at,d.policy_id,d.policy_version,d.target_ids[1] issue_id,e.effects from app.decisions d join app.work_command_effects e on e.tenant_id=d.tenant_id and e.decision_id=d.id where d.tenant_id=${tenant}::uuid and d.actor_kind='system' order by d.created_at desc limit 10`;return {status:200,body:{policies:await qualificationViews(tx,tenant,policies,services.capturePolicy),aliases,recent:await currentMemoryReceipts(tx,tenant,recent,services.capturePolicy),can_edit:await membership(tx,tenant,actor.userId)==='owner'}};});}));
 app.post('/v1/owner-policies/commands',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,tx=>memoryCommand(tx,tenant,actor.userId,req.body,services.capturePolicy));}));
}

/** Serialized server timer survives clients closing; horizontal replicas serialize per tenant. */
export function startOwnerMemory(app:FastifyInstance,db:Db,capturePolicy?:CapturePolicy){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>=Promise.resolve();
 const tick=()=>{running=runOwnerMemory(db,()=>stopped,capturePolicy).catch(()=>{}).finally(()=>{if(!stopped){timer=setTimeout(tick,15000);timer.unref();}});};
 app.addHook('onReady',async()=>{tick();});
 app.addHook('onClose',async()=>{stopped=true;if(timer)clearTimeout(timer);await running;});
}

async function contractFor(tx:Tx,tenant:string,context:string){const [r]=await tx`select b.work_order_id id from app.work_contexts w join app.work_bundles b on b.tenant_id=w.tenant_id and b.id=w.bundle_id join app.work_orders o on o.tenant_id=b.tenant_id and o.id=b.work_order_id and o.project_id=w.project_id where w.tenant_id=${tenant}::uuid and w.id=${context}::uuid`;return r?.id?String(r.id):null;}
async function qualificationViews(tx:Tx,tenant:string,policies:any[],capturePolicy?:CapturePolicy){
 const result=[];for(const p of policies){let samples:any[]=[];
  const [original]=await tx`select c.* from app.work_decision_cases c join app.decisions d on d.tenant_id=c.tenant_id and d.target_ids[1]=c.id where d.tenant_id=${tenant}::uuid and d.id=${p.example_decision_id}::uuid`;
  const available=!!original&&(await validateNormalSources(tx,tenant,original,capturePolicy,true)).state==='auto_apply';
  if(available&&p.semantic_proposal?.semantic_basis&&!p.revoked_at){const rows=await tx`select c.*,d.id decision_id,e.effects from app.work_decision_cases c join app.decisions d on d.tenant_id=c.tenant_id and d.target_ids[1]=c.id join app.work_command_effects e on e.tenant_id=d.tenant_id and e.decision_id=d.id where c.tenant_id=${tenant}::uuid and d.actor_kind='human' and app.same_work_condition(c.category,c.prompt,c.proposal,${p.category},${p.condition_prompt},${tx.json(p.semantic_proposal)}) order by (d.id=${p.example_decision_id}::uuid) desc,d.created_at desc limit 20`;
   for(const row of rows){if(policyCondition(row as any)!==p.condition_hash||workHash(normalizedEffects(row.effects))!==workHash(normalizedEffects(p.effects)))continue;const source=await validateNormalSources(tx,tenant,row,capturePolicy,true);if(source.state!=='auto_apply')continue;
    const qualification={evaluation_id:p.id,approved_by:p.grantor_user_id,approved_at:new Date().toISOString(),event_kinds:[...new Set(source.facts.map(f=>f.semantic.eventKind))],effect_kinds:p.effects.map((e:WorkEffect)=>e.kind)};
    if(normalFactEligibility(p.effects,source.facts,qualification).state==='auto_apply')samples.push({id:row.decision_id,prompt:row.prompt,quotes:source.facts.flatMap(f=>(f.semantic.evidence??[]).map((r:any)=>String(r.quote).slice(0,400))).slice(0,8)});
   }
  }
  const {semantic_proposal,...visible}=p;result.push({...visible,semantic_policy:!!semantic_proposal?.semantic_basis,evidence_available:available,condition_prompt:available?p.condition_prompt:'근거가 바뀌었거나 접근이 중지된 기준',effects:available?p.effects:[],semantic_qualification:available?p.semantic_qualification:null,qualification_required:!!semantic_proposal?.semantic_basis&&!p.semantic_qualification,qualification_samples:samples,qualification_ready:samples.some(s=>s.id===p.example_decision_id)});
 }return result;
}

async function currentMemoryReceipts(tx:Tx,tenant:string,receipts:any[],policy?:CapturePolicy){
 const output=[];for(const r of receipts){const [issue]=await tx`select * from app.work_decision_cases where tenant_id=${tenant}::uuid and id=${r.issue_id}::uuid`;const available=!!issue&&(await validateNormalSources(tx,tenant,issue,policy,true)).state==='auto_apply';const {issue_id,...receipt}=r;output.push({...receipt,effects:available?r.effects:[],evidence_available:available});}return output;
}
