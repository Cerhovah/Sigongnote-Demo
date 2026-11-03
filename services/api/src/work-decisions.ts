import type {CapturePolicy} from './capture-scope.js';
import {refreshSemanticIssues,semanticIssueCurrent} from './semantic-issues.js';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx} from './auth.js';
import {ApiFault,execute,membership,once,principal,tenantHeader,type Services} from './routes.js';
import {WorkEffectSchema,workSignals,type WorkEffect,type WorkSignal} from '@sigongnote/domain';
import {applyCostAdjustment} from './cost-adjustments.js';
import {prepareDocument} from './document-drafts.js';
import {activeImprovement,improvedEffects} from './improvement-runtime.js';
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):v;
export const workHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const refsSchema=z.array(z.strictObject({revision:z.uuid(),span:z.number().int().nonnegative(),organization_version:z.number().int().positive()})).min(1).max(100);
export const WorkCommandSchema=z.strictObject({command_id:z.uuid(),intent:z.enum(['answer','defer']),targets:z.array(z.strictObject({type:z.literal('work_issue'),id:z.uuid(),version:z.number().int().positive()})).length(1),evidence_refs:refsSchema,effects:z.array(WorkEffectSchema).max(6),policy_version:z.literal(1),cost_choice:z.enum(['change','defect']).optional(),next_review_at:z.iso.datetime({offset:true}).optional()});
export async function refreshWorkIssues(tx:Tx,tenant:string,user:string,capturePolicy?:CapturePolicy,improvementVersion?:string|null){
 if(await membership(tx,tenant,user)!=='owner')return;
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':work-issues'},0))`;
 const pinned=improvementVersion===undefined?await activeImprovement(tx,tenant):improvementVersion;
 const [clock]=await tx`select (now() at time zone 'Asia/Seoul')::date::text today`;
 const sources=await tx`select o.*,p.output,w.label,pr.display_name project_name from app.evidence_organizations o join app.parse_results p on p.tenant_id=o.tenant_id and p.job_id=o.job_id join app.work_contexts w on w.tenant_id=o.tenant_id and w.id=o.context_id join app.projects pr on pr.tenant_id=o.tenant_id and pr.id=o.project_id join app.document_revisions r on r.tenant_id=o.tenant_id and r.id=o.revision_id where o.tenant_id=${tenant}::uuid and o.state='linked' and not r.generated_output and not (coalesce(p.output->'issues','[]'::jsonb) ? 'stt_unconfirmed') and app.revision_accessible(o.tenant_id,o.revision_id) and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number) order by o.created_at desc,o.revision_id limit 200`;
 for(const source of sources){
  const bundle=await tx`select b.id from app.work_bundles b join app.work_orders wo on wo.tenant_id=b.tenant_id and wo.id=b.work_order_id where b.tenant_id=${tenant}::uuid and wo.project_id=${source.project_id}::uuid and (b.id=(select bundle_id from app.work_contexts where tenant_id=${tenant}::uuid and id=${source.context_id}::uuid) or b.display_name=${source.label}) order by b.id limit 2`;
  for(const signal of workSignals(source.output.spans,String(clock!.today))){
   const indices=[...new Set(signal.indices)].sort((a,b)=>a-b);
   for(const index of indices){const span=source.output.spans[index];if(!span)continue;
    await tx`insert into app.evidence_index(tenant_id,revision_id,project_id,scope,category,display_title,search_text,locator,source_kind,organization_span)
     values(${tenant}::uuid,${source.revision_id}::uuid,${source.project_id}::uuid,'project',${signal.category==='defect'?'inspection_defect':signal.category==='material'?'delivery_work':'agreement'},${String(span.text).slice(0,180)},${span.text},${tx.json({kind:'parsed',position:{span:index,locator:span.locator}})},'original',${index}) on conflict do nothing`;
   }
   const evidence=await tx`select id from app.evidence_index where tenant_id=${tenant}::uuid and revision_id=${source.revision_id}::uuid and organization_span=any(${indices}::integer[]) and source_kind='original' order by id`;
   if(evidence.length!==indices.length)continue;
   let blocked:string|null=null;const costOptions:Record<string,WorkEffect>={};
   if(signal.cost){
    const burden=signal.effects.find(e=>e.kind==='liability');
    for(const reason of signal.ambiguousCost?['change','defect'] as const:[signal.category==='defect'?'defect':'change'] as const){
     const charges=bundle.length===1?await tx`select id,version from app.charge_cases where tenant_id=${tenant}::uuid and bundle_id=${bundle[0]!.id}::uuid and status in ('confirmed','adjusted') and category=${reason} order by id limit 2`:[];
     if(charges.length===1&&burden?.kind==='liability'){const effect:WorkEffect={kind:'charge_adjustment',charge_id:String(charges[0]!.id),version:Number(charges[0]!.version),amount_minor:signal.cost,liability:burden.party,reason};if(signal.ambiguousCost)costOptions[reason]=effect;else signal.effects.push(effect);}
    }
    if(signal.ambiguousCost?!Object.keys(costOptions).length:!signal.effects.some(e=>e.kind==='charge_adjustment'))blocked='추가비를 반영할 기존 비용과 부담을 아직 하나로 연결하지 못했어요. 원문을 확인해 주세요.';
   }
   const improved=await improvedEffects(tx,tenant,{sourceText:indices.map(i=>String(source.output.spans[i]?.text??'')).join('\n'),proposal:signal.effects},pinned);
   if(improved.version){signal.effects=improved.effects;signal.prompt='기록에 적힌 보완 조치를 확인해 주세요: '+signal.effects.filter(e=>e.kind==='quality').map(e=>e.action).join(' · ');}
   await saveIssue(tx,tenant,{...source,improvement_version:improved.version},signal,evidence.map(e=>String(e.id)),indices,bundle.length===1?String(bundle[0]!.id):null,blocked,'',costOptions);
  }
 }
 // A confirmed completion and explicit billing agreement, never absence of receipt data, establish an unbilled balance.
 const billing=await tx`select a.id agreement_id,a.bundle_id,a.source_evidence_id,e.revision_id,e.organization_span,o.version organization_version,w.id context_id,w.project_id,w.label,pr.display_name project_name,
 (a.approved_gross_minor-coalesce((select sum(l.gross_minor) from app.invoices i join app.invoice_lines l on l.tenant_id=i.tenant_id and l.invoice_id=i.id where i.tenant_id=a.tenant_id and i.agreement_id=a.id and i.status='approved'),0)-coalesce((select sum(r.amount_minor) from app.billing_reservations r where r.tenant_id=a.tenant_id and r.billing_basis_id=a.id and r.state='held'),0))::text remaining
 from app.billing_agreements a join app.work_bundles b on b.tenant_id=a.tenant_id and b.id=a.bundle_id join app.work_orders wo on wo.tenant_id=b.tenant_id and wo.id=b.work_order_id join app.work_contexts w on w.tenant_id=b.tenant_id and w.project_id=wo.project_id and (w.bundle_id=b.id or w.label=b.display_name) join app.projects pr on pr.tenant_id=w.tenant_id and pr.id=w.project_id join app.evidence_index e on e.tenant_id=a.tenant_id and e.id=a.source_evidence_id join app.evidence_organizations o on o.tenant_id=e.tenant_id and o.revision_id=e.revision_id
 where a.tenant_id=${tenant}::uuid and e.organization_span is not null and app.revision_accessible(e.tenant_id,e.revision_id) and exists(select 1 from app.outcomes x where x.tenant_id=a.tenant_id and x.bundle_id=a.bundle_id and x.scope_completed and not exists(select 1 from app.outcomes n where n.tenant_id=x.tenant_id and n.bundle_id=x.bundle_id and n.version>x.version)) limit 100`;
 for(const row of billing)if(BigInt(row.remaining)>0n)await saveIssue(tx,tenant,{...row,version:row.organization_version,source_root_id:row.agreement_id}, {category:'billing',prompt:`완료 기록이 있고 ${BigInt(row.remaining).toLocaleString('ko-KR')}원이 아직 청구되지 않았어요. 청구서 초안을 준비할까요?`,effects:[{kind:'prepare_invoice'}],indices:[Number(row.organization_span)],due:null,cost:null},[String(row.source_evidence_id)],[Number(row.organization_span)],String(row.bundle_id),null,row.remaining);
 return refreshSemanticIssues(tx,tenant,capturePolicy);
}
async function saveIssue(tx:Tx,tenant:string,source:Record<string,any>,signal:WorkSignal,evidence:string[],indices:number[],bundle:string|null,blocked:string|null,extra='',costOptions:Record<string,WorkEffect>={}){
 const refs=indices.map(span=>({revision:String(source.revision_id),span,organization_version:Number(source.version)}));
 // Root/source identity is stable across repeated polling and same-byte copies. Price corrections require a new source/version.
 const key=workHash([signal.category==='billing'?null:source.context_id,signal.category,source.source_root_id]);
 const stableEffects=signal.effects.map(e=>e.kind==='charge_adjustment'?{...e,version:undefined}:e);
 const basis=workHash([stableEffects,signal.ambiguousCost?signal.cost:null,extra,...(source.improvement_version?[source.improvement_version]:[])]);
 // A new interpretation must not reopen an already answered source.
 if(source.improvement_version&&(await tx`select c.id from app.work_decision_cases c join app.exception_cases e on e.tenant_id=c.tenant_id and e.id=c.id where c.tenant_id=${tenant}::uuid and c.issue_key=${key} and e.state='resolved' and exists(select 1 from jsonb_array_elements(c.source_refs) r where r->>'revision'=${String(source.revision_id)})`).length)return;
 if((await tx`select id from app.work_decision_cases where tenant_id=${tenant}::uuid and issue_key=${key} and basis_hash=${basis}`).length)return;
 const id=randomUUID();
 await tx`insert into app.exception_cases(tenant_id,id,bundle_id,cause_key,cause,state,due_at) values(${tenant}::uuid,${id}::uuid,${bundle}::uuid,${key},${signal.category==='schedule'?'today_blocked':'other'},'awaiting_decision',${signal.due?signal.due+'T23:59:59+09:00':null}::timestamptz)`;
 await tx`insert into app.work_decision_cases(tenant_id,id,context_id,project_id,category,issue_key,basis_hash,source_refs,evidence_ids,prompt,proposal,improvement_version) values(${tenant}::uuid,${id}::uuid,${source.context_id}::uuid,${source.project_id}::uuid,${signal.category},${key},${basis},${tx.json(refs)},${evidence}::uuid[],${signal.prompt},${tx.json({effects:signal.effects,blocked,bundle_id:bundle,remaining:extra||null,cost_options:costOptions})},${source.improvement_version??null}::uuid)`;
 await tx`insert into app.work_projections(tenant_id,context_id) values(${tenant}::uuid,${source.context_id}::uuid) on conflict do nothing`;
}
export async function issueCurrent(tx:Tx,tenant:string,issue:Record<string,any>,capturePolicy?:CapturePolicy,currentSignal=true){
 if(issue.improvement_version&&(await tx`select app.improvement_version_allowed(${tenant}::uuid,${issue.improvement_version}::uuid) ok`)[0]?.ok!==true)return false;
 const refs=refsSchema.parse(issue.source_refs);
 if((await tx`select c.id from app.work_decision_cases c join app.exception_cases e on e.tenant_id=c.tenant_id and e.id=c.id where c.tenant_id=${tenant}::uuid and c.issue_key=${issue.issue_key} and c.id<>${issue.id}::uuid and e.state='resolved' and (c.improvement_version is not null or ${!!issue.improvement_version}) and c.source_refs->0->>'revision'=${refs[0]!.revision} limit 1`).length)return false;
 for(const ref of refs){
  const [row]=await tx`select o.version from app.evidence_organizations o join app.document_revisions r on r.tenant_id=o.tenant_id and r.id=o.revision_id where o.tenant_id=${tenant}::uuid and o.revision_id=${ref.revision}::uuid and o.context_id=${issue.context_id}::uuid and o.project_id=${issue.project_id}::uuid and app.revision_accessible(o.tenant_id,o.revision_id) and not exists(select 1 from app.document_revisions n where n.tenant_id=r.tenant_id and n.document_id=r.document_id and n.revision_number>r.revision_number)`;
  if(!row)return false;ref.organization_version=Number(row.version);
 }
 issue.source_refs=refs;return !currentSignal||semanticIssueCurrent(tx,tenant,issue,capturePolicy);
}
export async function readWorkIssues(tx:Tx,tenant:string,user:string,automatic=false,capturePolicy?:CapturePolicy,refresh=true,improvementVersion?:string|null){
 const viewVersion=improvementVersion===undefined?await activeImprovement(tx,tenant):improvementVersion;
 const coverage=refresh?await refreshWorkIssues(tx,tenant,user,capturePolicy,viewVersion):null;
 const rows=await tx`select c.*,e.version,e.state,e.next_review_at,e.cause,p.display_name project_name,w.label work_label from app.work_decision_cases c join app.exception_cases e on e.tenant_id=c.tenant_id and e.id=c.id join app.projects p on p.tenant_id=c.tenant_id and p.id=c.project_id join app.work_contexts w on w.tenant_id=c.tenant_id and w.id=c.context_id where c.tenant_id=${tenant}::uuid and e.state<>'resolved' and app.improvement_version_allowed(c.tenant_id,c.improvement_version) and (c.improvement_version is null or c.improvement_version=${viewVersion}::uuid) and (not ${automatic} or c.improvement_version is null) and not exists(select 1 from app.work_decision_cases newer where newer.tenant_id=c.tenant_id and newer.issue_key=c.issue_key and app.improvement_version_allowed(newer.tenant_id,newer.improvement_version) and (newer.improvement_version is null or newer.improvement_version=${viewVersion}::uuid) and (newer.improvement_version is not null,newer.created_at,newer.id)>(c.improvement_version is not null,c.created_at,c.id)) and (${automatic} or not c.automatic_only) and (e.state<>'deferred' or e.next_review_at<=now() or e.cause in ('safety','today_blocked','payment_due')) and (not ${automatic} or (c.policy_hold_reason is null or c.policy_hold_reason not in ('retry','source','candidate','qualification') or c.last_policy_attempt_at<clock_timestamp()-interval '1 minute')) and (not ${automatic} or (e.cause<>'today_blocked' and c.proposal->>'blocked' is null and coalesce(c.proposal->'cost_options','{}'::jsonb)='{}'::jsonb and exists(select 1 from app.owner_policies p join app.decisions d on d.tenant_id=p.tenant_id and d.id=p.example_decision_id join app.work_decision_cases x on x.tenant_id=d.tenant_id and x.id=d.target_ids[1] where p.tenant_id=c.tenant_id and p.revoked_at is null and p.valid_until>now() and p.category=c.category and p.work_label=w.label and app.same_work_condition(x.category,x.prompt,x.proposal,c.category,c.prompt,c.proposal)))) order by (e.cause='today_blocked') desc,case when ${automatic} then c.last_policy_attempt_at else null end asc nulls first,c.created_at,c.id limit 100`;
 const questions:Record<string,any>[]=[];for(const row of rows)if(await issueCurrent(tx,tenant,row,capturePolicy)){
  const hasCost=row.proposal.effects.some((e:WorkEffect)=>e.kind==='charge_adjustment')||Object.keys(row.proposal.cost_options??{}).length>0;
  if(hasCost&&(await tx`select 1 from app.charge_adjustment_evidence_ownership where tenant_id=${tenant}::uuid and evidence_id=any(${row.evidence_ids}::uuid[]) limit 1`).length)continue;
  questions.push({...row,version:Number(row.version),automation_note:row.policy_hold_reason==='qualification'?'기억한 기준에서 실제 사례를 확인하고 이 유형을 허용해 주세요.':row.policy_hold_reason==='source'?'기준의 원문이 바뀌었거나 접근이 중지되어 자동 반영을 멈췄어요.':row.policy_hold_reason==='candidate'?'기준에 필요한 근거나 조건을 아직 충분히 확인하지 못했어요.':row.policy_hold_reason==='conflict'?'기억한 기준끼리 달라서 직접 여쭤봐요.':row.policy_hold_reason==='limit'?'직전 자동 확인에서 정한 추가비 한도를 넘었어요.':row.policy_hold_reason==='retry'?'자동 반영을 마치지 못했어요. 원문과 현재 내용을 다시 확인해 주세요.':null});
 }
 return {questions,can_answer:await membership(tx,tenant,user)==='owner',coverage:`${coverage?.partial_contexts?`자료가 많은 ${coverage.partial_contexts}개 업무는 추가 확인이 필요해요. `:''}${coverage?.limited?'이번 조회는 200개 업무까지 확인했어요. ':''}${!refresh?'저장된 질문의 현재 근거를 다시 확인했어요. ':''}명확한 날짜·수량·조치·추가비 기록과 확인된 청구 기준을 검사했어요. 기록이 없는 일을 완료·미납으로 단정하지 않아요.`};
}
export function validWorkAnswer(expected:WorkEffect[],actual:WorkEffect[],automatic=false){
 if(expected.length!==actual.length)return false;
 return expected.every((e,i)=>{const a=actual[i]!;if(e.kind!==a.kind)return false;
  if(e.kind==='charge_adjustment'&&a.kind==='charge_adjustment')return workHash({...e,version:0})===workHash({...a,version:0});
  if(automatic)return workHash(e)===workHash(a);
  if(e.kind==='acceptance'&&a.kind==='acceptance')return e.unit===a.unit&&e.ordered===a.ordered;
  if(e.kind==='schedule'||e.kind==='quality')return true;
  return workHash(e)===workHash(a);
 });
}
export async function executeWorkCommand(tx:Tx,tenant:string,user:string,input:unknown,internal?:{effects:WorkEffect[]},capturePolicy?:CapturePolicy){
 const parsed=WorkCommandSchema.safeParse(input);if(!parsed.success)throw new ApiFault('INVALID_CONTRACT');const body=parsed.data,target=body.targets[0]!;
 if(await membership(tx,tenant,user)!=='owner')throw new ApiFault('NOT_FOUND');
 return once(tx,tenant,user,'POST /v1/work-commands',body.command_id,workHash(body),async()=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':work-issues'},0))`;
  const [issue]=await tx`select c.*,e.version,e.state,e.cause from app.work_decision_cases c join app.exception_cases e on e.tenant_id=c.tenant_id and e.id=c.id where c.tenant_id=${tenant}::uuid and c.id=${target.id}::uuid for update of e`;
  if(!issue)throw new ApiFault('NOT_FOUND');if(Number(issue.version)!==target.version||issue.state==='resolved'||!await issueCurrent(tx,tenant,issue,capturePolicy))throw new ApiFault('VERSION_CONFLICT');
  if(workHash(body.evidence_refs)!==workHash(issue.source_refs))throw new ApiFault('INVALID_CONTRACT');
  if(body.intent==='defer'){
   if(body.effects.length||!body.next_review_at||Date.parse(body.next_review_at)<=Date.now()||Date.parse(body.next_review_at)>Date.now()+30*86400000||['safety','today_blocked','payment_due'].includes(String(issue.cause)))throw new ApiFault('DOMAIN_INVARIANT');
   await tx`update app.exception_cases set state='deferred',version=version+1,next_review_at=${body.next_review_at}::timestamptz where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;
   await tx`insert into app.exception_events(tenant_id,exception_id,actor_id,kind,reason) values(${tenant}::uuid,${issue.id}::uuid,${user}::uuid,'deferred','내일 다시 확인하기로 보류했습니다.')`;
   return {status:200,body:{deferred:true,payment_confirmed:false}};
  }
  const selected=body.cost_choice?issue.proposal.cost_options?.[body.cost_choice]:null;const expectedEffects=internal?.effects??(selected?[...issue.proposal.effects,selected]:issue.proposal.effects);
  if(body.next_review_at||issue.proposal.blocked||(body.cost_choice&&!selected)||(!body.cost_choice&&Object.keys(issue.proposal.cost_options??{}).length>0)||!validWorkAnswer(expectedEffects,body.effects,!!internal)||!!internal&&!validWorkAnswer(issue.proposal.effects,body.effects,false))throw new ApiFault('VERSION_CONFLICT');
  const [projection]=await tx`select * from app.work_projections where tenant_id=${tenant}::uuid and context_id=${issue.context_id}::uuid for update`;
  if(!projection)throw new ApiFault('DOMAIN_INVARIANT');
  const decision=randomUUID(),after={...projection.state},changed:string[]=[],drafts:string[]=[];
  await tx`insert into app.decisions(tenant_id,id,actor_id,scope,choice,target_ids,target_versions,evidence_ids,reason,payload_hash) values(${tenant}::uuid,${decision}::uuid,${user}::uuid,'exception_resolution','apply_work_answer',${[issue.id,issue.context_id]}::uuid[],${[target.version,Number(projection.version)]}::bigint[],${issue.evidence_ids}::uuid[],${String(issue.prompt).slice(0,1000)},${workHash(body)})`;
  for(const effect of body.effects){
   if(effect.kind==='schedule'){after.schedule=effect.date;changed.push(`다음 일정 ${effect.date}`);}
   if(effect.kind==='acceptance'){after.acceptance={quantity:effect.quantity,unit:effect.unit,ordered:effect.ordered};changed.push(`인수 ${effect.quantity}${effect.unit} · 발주 ${effect.ordered}${effect.unit}`);}
   if(effect.kind==='quality'){after.quality={action:effect.action,complete:false};changed.push(`보완할 일: ${effect.action}`);}
   if(effect.kind==='liability'){after.liability=effect.party;changed.push('확인한 비용 부담 기록');}
   if(effect.kind==='prepare_invoice'){const draft=await prepareDocument(tx,tenant,user,String(issue.project_id),'invoice',body.command_id,{});drafts.push(String(draft.id));changed.push('현재 자료로 청구서 초안 준비');}
   if(effect.kind==='charge_adjustment'){
    if((await tx`select 1 from app.charge_adjustment_evidence_ownership where tenant_id=${tenant}::uuid and evidence_id=any(${issue.evidence_ids}::uuid[]) limit 1`).length)throw new ApiFault('VERSION_CONFLICT');
    // The answer explicitly confirms the linked work for the cost evidence; no synthetic contract is created.
    const [charge]=await tx`select bundle_id,version from app.charge_cases where tenant_id=${tenant}::uuid and id=${effect.charge_id}::uuid`;
    if(!charge||charge.bundle_id!==issue.proposal.bundle_id)throw new ApiFault('VERSION_CONFLICT');
    for(const eid of issue.evidence_ids as string[]){
     const [old]=await tx`select bundle_id,state from app.evidence_attributions where tenant_id=${tenant}::uuid and evidence_index_id=${eid}::uuid`;
     if(old&&(old.bundle_id!==charge.bundle_id||old.state!=='confirmed'))throw new ApiFault('VERSION_CONFLICT');
     if(!old)await tx`insert into app.evidence_attributions(tenant_id,evidence_index_id,bundle_id,state,version,decision_id) values(${tenant}::uuid,${eid}::uuid,${charge.bundle_id}::uuid,'confirmed',2,${decision}::uuid)`;
    }
    await applyCostAdjustment(tx,tenant,user,effect.charge_id,Number(charge.version),{id:randomUUID(),direction:'increase',amount_minor:effect.amount_minor,reason:effect.reason,liability:effect.liability,evidence_ids:issue.evidence_ids,explanation:'대표가 원문 근거와 추가 비용 및 부담을 함께 확인했습니다.'});changed.push(`원가 ${BigInt(effect.amount_minor).toLocaleString('ko-KR')}원 추가`);
   }
  }
  await tx`update app.work_projections set version=version+1,state=${tx.json(after)},decision_id=${decision}::uuid where tenant_id=${tenant}::uuid and context_id=${issue.context_id}::uuid`;
  await tx`insert into app.work_command_effects(tenant_id,command_id,decision_id,context_id,before_state,after_state,effects) values(${tenant}::uuid,${body.command_id}::uuid,${decision}::uuid,${issue.context_id}::uuid,${tx.json(projection.state)},${tx.json(after)},${tx.json(body.effects)})`;
  await tx`update app.exception_cases set state='resolved',version=version+1,next_review_at=null where tenant_id=${tenant}::uuid and id=${issue.id}::uuid`;
  await tx`insert into app.exception_events(tenant_id,exception_id,actor_id,kind,decision_id,reason) values(${tenant}::uuid,${issue.id}::uuid,${user}::uuid,'decision',${decision}::uuid,'확인한 답변을 관련 업무에 함께 반영했습니다.')`;
  const result={decision_id:decision,memory_cost_minor:body.effects.find(e=>e.kind==='charge_adjustment')?.amount_minor??'0',changed,document_draft_ids:drafts,payment_confirmed:false,delivery_confirmed:false,work_completed:false};
  await tx`insert into app.work_decision_outbox(tenant_id,decision_id,payload) values(${tenant}::uuid,${decision}::uuid,${tx.json(result)})`;
  return {status:200,body:result};
 });
}
export function registerWorkDecisions(app:FastifyInstance,services:Services){
 app.get('/v1/work/questions',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');return {status:200,body:await readWorkIssues(tx,tenant,actor.userId,false,services.capturePolicy)};});}));
 app.post('/v1/work-commands',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,tx=>executeWorkCommand(tx,tenant,actor.userId,req.body,undefined,services.capturePolicy));}));
}
