import {activeStrategies,pinnedStrategiesAllowed,improveAgentPlan} from './strategy-runtime.js';
import {lockAgentChain,parkAgentContinuation,continueAgentRun,cancelAgentChain} from './agent-continuation.js';
import {readDelivery} from './deliveries.js';
import {activeImprovement} from './improvement-runtime.js';
import {localPhotoPlan,readPhotoSheet} from './photo-sheets.js';
import {localArtifactPlan} from './agent-artifacts.js';
import {documentReceipt,localDocumentPlan} from './document-readiness.js';
import {issueCurrent,readWorkIssues} from './work-decisions.js';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {inAuthorizedTransaction,type Tx,type Principal} from './auth.js';
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from './routes.js';
import {AgentPlanSchema,executeAgentTool,agentFeedback,type AgentScope} from './agent-tools.js';
import {agentModelRequest,callAgentModel,type AgentModel,type AgentModelInput} from './agent-provider.js';
import {searchPlan,searchEvidence} from './evidence-search.js';
import {reserveProductAi,submitProductAi,finishProductAi,stableRunId,type ProductReservation} from './product-ai.js';
import {tokenCostKrw,type ProductAiConfig} from './product-ai-config.js';
import {SemanticInvalidOutput,SemanticNotAccepted} from './semantic-provider.js';

export const AgentRequestSchema=z.strictObject({client_turn_id:z.uuid(),project_id:z.uuid().optional(),instruction:z.string().trim().min(1).max(2000),input_kind:z.enum(['text','voice']),answer_to:z.strictObject({id:z.uuid(),version:z.number().int().positive()}).optional(),document_request:z.strictObject({type:z.enum(['estimate','purchase_order','invoice','delivery_statement']),context_id:z.uuid()}).optional(),evidence_refs:z.array(z.uuid()).max(10).default([])});
export type AgentOptions={config?:ProductAiConfig;model?:AgentModel;configurationBlocked?:boolean;interactiveMs?:number;background?:Set<Promise<unknown>>};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const active=(s:string)=>s==='queued'||s==='running';
const scopeOf=(r:any):AgentScope=>({tenant:r.tenant_id,user:r.user_id,project:r.project_id,run:r.root_run_id??r.id,instruction:r.instruction,answerTo:r.answer_target,improvementVersion:r.improvement_version??null});
export async function createAgentRun(tx:Tx,tenant:string,actor:Principal,input:unknown){
 const p=AgentRequestSchema.safeParse(input);if(!p.success)throw new ApiFault('INVALID_CONTRACT');const b=p.data;
 if(await membership(tx,tenant,actor.userId)==='viewer')throw new ApiFault('NOT_FOUND');
 if(b.project_id&&!(await tx`select id from app.projects where tenant_id=${tenant}::uuid and id=${b.project_id}::uuid`).length)throw new ApiFault('NOT_FOUND');
 for(const id of b.evidence_refs)if(!(await tx`select app.revision_accessible(${tenant}::uuid,${id}::uuid) ok`)[0]?.ok)throw new ApiFault('NOT_FOUND');
 await tx`select pg_advisory_xact_lock(hashtextextended(${tenant+':agent:'+actor.userId+':'+b.client_turn_id},0))`;
 const [old]=await tx`select id,request_hash from app.agent_runs where tenant_id=${tenant}::uuid and user_id=${actor.userId}::uuid and client_turn_id=${b.client_turn_id}::uuid`;
 if(old){if(old.request_hash!==hash(b))throw new ApiFault('IDEMPOTENCY_CONFLICT');return String(old.id);}
 if(b.document_request&&(!b.project_id||b.answer_to||await membership(tx,tenant,actor.userId)!=='owner'))throw new ApiFault('INVALID_CONTRACT');
 if(b.answer_to){if(await membership(tx,tenant,actor.userId)!=='owner')throw new ApiFault('NOT_FOUND');
  const [q]=await tx`select e.version,c.project_id from app.work_decision_cases c join app.exception_cases e on e.tenant_id=c.tenant_id and e.id=c.id where c.tenant_id=${tenant}::uuid and c.id=${b.answer_to.id}::uuid and e.state<>'resolved'`;
  if(!q||b.project_id&&q.project_id!==b.project_id)throw new ApiFault('NOT_FOUND');if(Number(q.version)!==b.answer_to.version)throw new ApiFault('VERSION_CONFLICT');
 }
 const improvementVersion=await activeImprovement(tx,tenant),strategyVersions=await activeStrategies(tx,tenant);const id=randomUUID();await tx`insert into app.agent_runs(tenant_id,id,user_id,session_id,client_turn_id,project_id,instruction,input_kind,evidence_refs,request_hash,answer_target,improvement_version,strategy_versions) values(${tenant}::uuid,${id}::uuid,${actor.userId}::uuid,${actor.sessionId}::uuid,${b.client_turn_id}::uuid,${b.project_id??null}::uuid,${b.instruction},${b.input_kind},${b.evidence_refs}::uuid[],${hash(b)},${b.answer_to?tx.json(b.answer_to):null}::jsonb,${improvementVersion}::uuid,${tx.json(strategyVersions)})`;if(b.document_request)await tx`update app.agent_runs set plan=${tx.json({calls:[{tool:'prepare_document',input:JSON.stringify(b.document_request)}],done:true,missing:'none'})} where tenant_id=${tenant}::uuid and id=${id}::uuid`;return id;
}
const messages:Record<string,string>={delivery_input:'전달 요청을 처리하지 못했어요. 보낼 문서를 열고 받는 곳을 다시 확인해 주세요.',photo_conflict:'사진 묶음의 현장 연결이 바뀌었어요. 현장 사진에서 같은 현장 사진끼리 다시 골라 주세요.',answer_changed:'답변을 반영하기 전에 자료나 질문이 바뀌었어요. 현재 확인할 일을 다시 열어 주세요.',scope:'어느 현장에서 진행할지 알려 주세요.',unsupported_action:'이 요청의 발송 기능은 아직 연결 중이에요. 관련 자료는 계속 찾아볼 수 있어요.',more_evidence:'확인할 자료가 더 필요해요.',budget_paused:'오늘 또는 이번 달 AI 처리 한도에 도달했어요. 이미 찾은 자료는 볼 수 있어요.',unknown:'AI 응답 여부를 확인하지 못했어요. 같은 유료 요청을 다시 보내지 않았어요.',rejected:'AI가 요청을 처리하지 못했어요.',interpretation_changed:'해석 기준이 바뀌어 멈췄어요. 새 요청으로 이어가 주세요.',scope_blocked:'처리 권한이 바뀌었어요. 연결 범위를 확인해 주세요.',configuration_blocked:'AI 연결 설정을 확인해야 해요. 설정 오류로 다른 처리 방식으로 바꾸지 않았어요.',CHAIN_LIMIT:'여러 단계의 확인을 마쳤어요. 찾은 결과에서 새 요청으로 범위를 좁혀 주세요.',LIMIT:'이번 처리 한도까지 확인했어요. 찾은 결과를 유지하고 남은 확인을 이어갈 수 있어요.'};
export async function readAgentRun(tx:Tx,tenant:string,user:string,id:string,services:Pick<Services,'capturePolicy'>){
 const [requested]=await tx`select * from app.agent_runs where tenant_id=${tenant}::uuid and user_id=${user}::uuid and id=${id}::uuid`;if(!requested)throw new ApiFault('NOT_FOUND');
 const root=requested.root_run_id??requested.id;
 const chain=await tx`select * from app.agent_runs where tenant_id=${tenant}::uuid and user_id=${user}::uuid and (id=${root}::uuid or root_run_id=${root}::uuid) order by chain_depth`;
 const r=chain.filter(c=>c.error_code!=='CONTINUATION_READY').at(-1)!;
 const next=r.status!=='cancelled'?chain.find(c=>c.parent_run_id===r.id&&c.status==='needs_answer'&&c.error_code==='CONTINUATION_READY'):undefined;
 const ids=chain.filter(c=>c.error_code!=='CONTINUATION_READY').map(c=>String(c.id));
 const steps=await tx`select s.tool,s.input,s.result from app.agent_steps s join app.agent_runs a on a.tenant_id=s.tenant_id and a.id=s.run_id where s.tenant_id=${tenant}::uuid and s.run_id=any(${ids}::uuid[]) order by a.chain_depth,s.sequence`;
 const cards=new Map<string,any>();const results:unknown[]=[];let unavailable=0;
 for(const step of steps){if(step.result.error_code){unavailable++;continue;}try{
  // Re-run read tools against current scope: saved quotes or snapshots are never returned as current facts.
  const result=step.tool==='request_delivery'?step.result.delivery?{delivery:await readDelivery(tx,tenant,step.result.delivery.id)}:{delivery_choices:true}:step.tool==='prepare_photo_sheet'?step.result.photo_sheet?{photo_sheet:await (async()=>{const s=await readPhotoSheet(tx,tenant,step.result.photo_sheet.id);return {id:s.id,title:s.snapshot.title,state:s.state};})()}:{photo_choices:true}:step.tool==='get_artifact'?{artifacts:await (async()=>{const found=[];for(const a of step.result.artifacts??[]){try{const current=await executeAgentTool(tx,scopeOf(r),{tool:'get_artifact',input:JSON.stringify({id:a.id,...(step.input.format?{format:step.input.format}:{})})},services);found.push(...('artifacts' in current?current.artifacts:[]));}catch(e){if(!(e instanceof ApiFault)||e.code!=='NOT_FOUND')throw e;}}return found;})()}:step.tool==='prepare_document'?step.result.document?await documentReceipt(tx,tenant,step.result.document.id):{document_choices:{...step.result.document_choices,contexts:await tx`select id,label from app.work_contexts where tenant_id=${tenant}::uuid and project_id=${step.result.document_choices.project_id}::uuid and id=any(${step.result.document_choices.contexts.map((c:any)=>c.id)}::uuid[]) order by label,id`}}:step.tool==='list_exceptions'?await currentQuestions(tx,tenant,user,r.project_id,services):step.tool==='answer_exception'?await currentReceipt(tx,tenant,r.answer_target,step.result,services):['search_evidence','get_evidence'].includes(step.tool)?{cards:await searchEvidence(tx,tenant,{...(step.tool==='search_evidence'?step.input:{query:'',versions:'history'}),project_id:r.project_id??step.input.project_id},(step.result.cards??[]).map((c:any)=>c.revision_id))}:await executeAgentTool(tx,scopeOf(r),{tool:step.tool,input:JSON.stringify(step.input)} as never,services);
  for(const card of (result as any).cards??[])cards.set(card.revision_id,card);results.push(result);
 }catch{unavailable++;}}
 if(r.answer_target&&results.some((v:any)=>v.receipt?.needs_answer)){const current=await currentQuestions(tx,tenant,user,r.project_id,services);results.push({questions:current.questions.filter((q:any)=>q.id===r.answer_target.id)});}
 const usage=await tx`select app.agent_chain_usage(${tenant}::uuid,${root}::uuid) value`;
 const choices=results.flatMap((v:any)=>v.document_choices?[v.document_choices]:[]);
 const artifacts=results.flatMap((v:any)=>v.artifacts??[]),readyArtifacts=artifacts.filter(a=>a.files.length>0).length;
 const documents=results.flatMap((v:any)=>v.document?[v.document]:[]);
 const questions=results.flatMap((v:any)=>v.questions??[]),receipts=results.flatMap((v:any)=>v.receipt?[v.receipt]:[]);
 const missing=r.status==='cancelled'?null:r.error_code??(r.plan?.missing!=='none'?r.plan?.missing:null),status=active(r.status)||r.status==='cancelled'?String(r.status):choices.length?'needs_answer':String(r.status);
 const deliveries=results.flatMap((v:any)=>v.delivery?[v.delivery]:[]),deliveryChoices=results.some((v:any)=>v.delivery_choices);
 const sheets=results.flatMap((v:any)=>v.photo_sheet?[v.photo_sheet]:[]),photoChoices=results.some((v:any)=>v.photo_choices);
 // The model's own explanation is shown when it finished, or when it says more evidence is needed (it then explains what is missing); other stops keep the fixed guidance.
 const explanation=typeof r.plan?.answer==='string'&&r.plan.answer.trim()&&!active(status)&&status!=='cancelled'&&(!missing||missing==='more_evidence')?r.plan.answer.trim():null;
 const answer=explanation??(status==='cancelled'?'남은 처리를 취소했어요. 이미 확인한 결과는 유지해요.':active(status)?'서버에서 자료를 확인하고 있어요. 화면을 닫아도 처리는 이어져요.':messages[missing]??(missing==='price_expired'?'AI 요금 설정을 갱신해야 처리를 이어갈 수 있어요.':missing?'처리를 마치지 못했어요. 오류를 확인한 뒤 새 요청으로 이어가 주세요.':deliveries.length?'전달 내용을 준비했어요. 문서와 받는 곳을 확인하고 보내기를 눌러 주세요.':deliveryChoices?'보낼 문서를 열고 팩스 받는 곳을 선택해 주세요. PDF 공유도 사용할 수 있어요.':sheets.length?'사진대지를 준비했어요. 사진과 PDF를 확인해 주세요.':photoChoices?'현장 사진에서 사용할 사진을 고르면 사진대지를 만들 수 있어요.':choices.length?(choices[0].contexts.length?'어느 일의 문서를 준비할지 골라 주세요.':'아직 연결된 업무가 없어요. 현장 자료를 먼저 연결해 주세요.'):artifacts.length?(readyArtifacts?`${artifacts.length}개 발행 문서를 찾았어요. 그중 ${readyArtifacts}개 문서의 파일을 열 수 있어요.`:'발행 문서를 찾았지만 지금 열 수 있는 파일은 없어요. 문서별 상태를 확인해 주세요.'):results.some((v:any)=>v.artifacts)?'선택한 범위에서 확인 가능한 발행 문서를 찾지 못했어요. 현장을 확인하거나 새 문서를 준비해 주세요.':documents.length?(documents[0].stale?'자료가 바뀌어 새 초안이 있어요. 최신 문서로 이어서 확인해 주세요.':documents[0].missing.length?`${documents[0].missing[0]}을 확인하면 초안을 이어서 준비할 수 있어요.`:`${documents.length}개 문서 초안을 준비했어요. 받는 곳과 금액을 확인해 주세요.`):receipts.length?(receipts.at(-1)?.text??(receipts.at(-1)?.deferred?'다시 확인할 날을 기록했어요.':'답변을 반영했어요. 실제 송금이나 발송은 실행하지 않았어요.')):questions.length?`${questions.length}가지 확인할 일이 있어요.`:results.some((v:any)=>v.questions)?'현재 확인할 중요한 질문이 없어요.':cards.size?`${cards.size}개 자료를 현재 근거로 찾았어요.`:'조건에 맞는 현재 자료를 찾지 못했어요. 아직 판독·의미 확인 중인 자료는 포함되지 않을 수 있어요.'));
 return {run_id:r.id,root_run_id:root,next_job:next?{id:next.id,status:"ready"}:null,planner_mode:r.planner_mode,planner_notice:r.planner_mode==="local"?"AI 연결이 꺼져 있거나 아직 없어 기본 자료 찾기로 처리했어요.":r.planner_mode==="blocked"?messages.configuration_blocked:null,turn_id:chain[0]!.client_turn_id,project_id:r.project_id,status,answer,text:answer,cards:[...cards.values()].slice(0,30),document_choices:choices[0]??null,artifacts,deliveries,delivery_choices:deliveryChoices,photo_sheets:sheets,photo_choices:photoChoices,document_refs:documents,document_draft:documents[0]??null,effects:receipts,questions,results,coverage:{tools:chain.reduce((n,c)=>n+Number(c.tool_count),0),model_rounds:chain.reduce((n,c)=>n+Number(c.rounds),0),unavailable,meaning:'현재 확인 가능한 근거 범위'},missing:missing?[missing]:[],usage_summary:usage[0]?.value??null};
}
const tasks=new WeakMap<Services,Set<Promise<unknown>>>();
export async function drainAgentTasks(services:Services){await Promise.allSettled([...(tasks.get(services)??[])]);}
export async function runAgentOnce(services:Services,options:AgentOptions={},tenantScope?:string){
 let pending=tasks.get(services);if(!pending){pending=new Set();tasks.set(services,pending);}if(pending.size>=3)return 'busy';
 const task=executeAgentRun(services,options,tenantScope);pending.add(task);options.background?.add(task);
 void task.finally(()=>{pending!.delete(task);options.background?.delete(task);}).catch(()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([task,new Promise<'inflight'>(resolve=>{timer=setTimeout(()=>resolve('inflight'),Math.min(30_000,Math.max(1,options.interactiveMs??30_000)));})]);}finally{if(timer)clearTimeout(timer);}
}
async function executeAgentRun(services:Services,options:AgentOptions,tenantScope?:string){
 const [claimed]=await services.db`select app.claim_agent_run(${tenantScope??null}::uuid) value`;const lease=claimed?.value;if(!lease)return 'idle';
 const actor={userId:lease.userId,sessionId:lease.sessionId};
 const withRun=async<T>(fn:(tx:Tx,r:any)=>Promise<T>)=>{const value=await inAuthorizedTransaction(services.db,actor,async tx=>{
  await lockAgentChain(tx,lease.tenant,lease.id);
  const [r]=await tx`select * from app.agent_runs where tenant_id=${lease.tenant}::uuid and id=${lease.id}::uuid and lease_token=${lease.token}::uuid and lease_until>clock_timestamp() and status='running' for update`;
  return {status:200,body:r?await fn(tx,r):null};});return value?.body as T|null;};
 const stop=async(code:string)=>withRun(async(tx,r)=>{await tx`update app.agent_runs set status='needs_answer',error_code=${code},lease_token=null,lease_until=null,updated_at=clock_timestamp() where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return true;});
 const deadline=Date.now()+Math.min(30_000,Math.max(1,options.interactiveMs??30_000));
 try{while(Date.now()<deadline){
  const r=await withRun(async(_tx,r)=>r);if(!r)return 'stale';
  if(r.improvement_version&&!await withRun(async(tx,r)=>(await tx`select app.improvement_version_allowed(${r.tenant_id}::uuid,${r.improvement_version}::uuid) ok`)[0]?.ok)){await stop('interpretation_changed');return 'blocked';}
   if(r.evidence_refs.length&&!await withRun(async(tx,r)=>{for(const id of r.evidence_refs)if(!(await tx`select app.revision_accessible(${r.tenant_id}::uuid,${id}::uuid) ok`)[0]?.ok)return false;return true;})){await stop("scope_blocked");return "blocked";}
  if(!await withRun(async(tx,r)=>pinnedStrategiesAllowed(tx,r.tenant_id,r.strategy_versions))){await stop('interpretation_changed');return 'blocked';}
  if(!r.plan){
   if(Number(r.rounds)>=4||Number(r.tool_count)>=8){await withRun(parkAgentContinuation);return 'limited';}
   let plan:z.infer<typeof AgentPlanSchema>;
   await withRun(async(tx,r)=>{await tx`update app.agent_runs set planner_mode=${r.answer_target?"explicit":options.configurationBlocked?"blocked":options.config?"model":"local"} where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;});
   if(r.answer_target){plan={calls:[{tool:'answer_exception',input:JSON.stringify(r.answer_target)}],done:true,missing:'none'};
   }else if(options.configurationBlocked){await stop("configuration_blocked");return "blocked";
   }else if(!options.config){
    if(/전달|보내|발송/u.test(r.instruction)&&!/팩스/u.test(r.instruction)){await stop('unsupported_action');return 'blocked';}
    plan={calls:[(/팩스/u.test(r.instruction)&&/보내|보내줘|전달|발송/u.test(r.instruction)&&!/사진.*대지.*만들|사진.*대지.*준비/u.test(r.instruction)?{tool:'request_delivery' as const,input:'{}'}:localPhotoPlan(r.instruction)??localArtifactPlan(r.instruction)??localDocumentPlan(r.instruction))??(/오늘|할 일|확인할|질문/u.test(r.instruction)?{tool:'list_exceptions',input:'{}'}:{tool:'search_evidence',input:JSON.stringify({...searchPlan(r.instruction),project_id:r.project_id})})],done:true,missing:'none'};
   }else{
    const config=options.config;if(Date.parse(config.price.valid_until)<=Date.now()){await stop('price_expired');return 'blocked';}
    const feedback=await withRun(async(tx,r)=>{
     const refs=r.evidence_refs.length?await searchEvidence(tx,r.tenant_id,{query:'',project_id:r.project_id,versions:'history'},r.evidence_refs):[];
     return [{tool:'requested_evidence',...agentFeedback({cards:refs})},...(await tx`select tool,result from app.agent_steps where tenant_id=${r.tenant_id}::uuid and run_id in (select id from app.agent_runs where tenant_id=${r.tenant_id}::uuid and (id=${r.root_run_id??r.id}::uuid or root_run_id=${r.root_run_id??r.id}::uuid)) order by created_at,sequence`).map(v=>({tool:v.tool,...agentFeedback(v.result)}))];
    });
    const input:AgentModelInput={instruction:r.instruction,project_id:r.project_id,feedback:feedback??[],remaining_tools:8-Number(r.tool_count),remaining_rounds:4-Number(r.rounds),scope:{...scopeOf(r),session:lease.sessionId}};
    const snapshot={run_id:r.id,provider:config.provider,model:config.model,price:config.price,prompt:'agent-tools-v1',round:Number(r.rounds),effort:'high'};
    const reservation:ProductReservation={tenant:r.tenant_id,user:r.user_id,source:null,generation:null,revision:null,id:stableRunId(r.id+':round:'+r.rounds),channel:'agent',hash:hash({input,snapshot}),config:snapshot,krw:Math.max(1,tokenCostKrw(config.price,agentModelRequest(input,config).inputTokenBound,config.maxOutputTokens))};
    const reserved=await withRun(tx=>reserveProductAi(tx,reservation));if(!reserved)return 'stale';
    if(reserved.state==='settled'&&reserved.result)plan=AgentPlanSchema.parse(reserved.result);
    else if(reserved.state!=='reserved'){await stop(reserved.state==='submitted'?'unknown':reserved.state);return 'blocked';}
    else {
     if(!await withRun(async(tx,r)=>{await tx`update app.agent_runs set lease_until=clock_timestamp()+interval '120 seconds' where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return submitProductAi(tx,reservation);}))return 'stale';
     try{
      const result=await (options.model??callAgentModel)(input,config,AbortSignal.timeout(90_000));
      // Settle even if the run was cancelled in flight; cancellation never turns billable usage into zero.
      const settled=await inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await finishProductAi(tx,reservation,tokenCostKrw(config.price,result.inputTokens,result.outputTokens),result.value,result.receipt,{input_tokens:result.inputTokens,output_tokens:result.outputTokens})}));
      if(!settled?.body)return 'stale';plan=AgentPlanSchema.parse(result.value);
     }catch(error){
      const invalid=error instanceof SemanticInvalidOutput,rejected=error instanceof SemanticNotAccepted;
      await inAuthorizedTransaction(services.db,actor,async tx=>({status:200,body:await finishProductAi(tx,reservation,invalid?tokenCostKrw(config.price,error.inputTokens,error.outputTokens):rejected?0:null,null,invalid?error.receipt:null,{error_code:invalid?'MODEL_RESPONSE_INVALID':rejected?'PROVIDER_NOT_ACCEPTED':'PROVIDER_OUTCOME_UNKNOWN'})}));
      await stop(rejected||invalid?'rejected':'unknown');return 'blocked';
     }
    }
   }
   if(!await withRun(async(tx,r)=>{plan=await improveAgentPlan(tx,r.tenant_id,r.project_id,r.instruction,plan,r.strategy_versions);await tx`update app.agent_runs set plan=${tx.json(plan)},plan_cursor=0,rounds=rounds+1 where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return true;}))return 'stale';
   continue;
  }
  const plan=AgentPlanSchema.parse(r.plan),cursor=Number(r.plan_cursor);
  if(cursor>=plan.calls.length){
   await withRun(async(tx,r)=>{await tx`update app.agent_runs set status=${plan.done?(plan.missing==='none'?'completed':'needs_answer'):'running'},plan=${plan.done?tx.json(plan):null}::jsonb,plan_cursor=0,updated_at=clock_timestamp() where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return true;});
   if(plan.done)return 'stored';continue;
  }
  if(Number(r.tool_count)>=8){await withRun(parkAgentContinuation);return 'limited';}
  await withRun(async(tx,r)=>{
   const call=plan.calls[cursor]!;let result:unknown,parsed:unknown={};
   try{parsed=JSON.parse(call.input);result=await tx.savepoint(nested=>executeAgentTool(nested,scopeOf(r),call,services));}catch(error){result={error_code:error instanceof ApiFault?error.code:'INVALID_TOOL_INPUT'};}
   if(['answer_exception','prepare_document','get_artifact','prepare_photo_sheet','request_delivery'].includes(call.tool)&&(result as any).error_code)await tx`update app.agent_runs set status='needs_answer',error_code=${r.answer_target?'answer_changed':call.tool==='request_delivery'?'delivery_input':['prepare_document','get_artifact','prepare_photo_sheet'].includes(call.tool)?((result as any).error_code==='SOURCE_SCOPE_MISMATCH'?'photo_conflict':(result as any).error_code==='NOT_FOUND'?'scope_blocked':'scope'):'unsupported_action'},lease_token=null,lease_until=null where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;
   const sequence=Number(r.tool_count)+1;await tx`insert into app.agent_steps(tenant_id,run_id,sequence,tool,input,result,input_hash,result_hash) values(${r.tenant_id}::uuid,${r.id}::uuid,${sequence},${call.tool},${tx.json(parsed as never)},${tx.json(result as never)},${hash(call.input)},${hash(result)})`;
   await tx`update app.agent_runs set tool_count=tool_count+1,plan_cursor=plan_cursor+1,updated_at=clock_timestamp() where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return true;
  });
 }
 await withRun(async(tx,r)=>{await tx`update app.agent_runs set status='queued',lease_token=null,lease_until=null where tenant_id=${r.tenant_id}::uuid and id=${r.id}::uuid`;return true;});return 'yielded';
 }catch{await stop('RUN_FAILED').catch(()=>{});return 'failed';}
}
export function registerAgentRuns(app:FastifyInstance,services:Services){
 app.post('/v1/agent/runs',async(req,reply)=>execute(reply,async()=>{const actor=await principal(req,services),tenant=tenantHeader(req);return inAuthorizedTransaction(services.db,actor,async tx=>{const id=await createAgentRun(tx,tenant,actor,req.body);return {status:202,body:await readAgentRun(tx,tenant,actor.userId,id,services)};});}));
 app.post<{Params:{id:string}}>('/v1/agent/runs/:id/continue',async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success||!z.strictObject({}).safeParse(req.body).success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{const next=await continueAgentRun(tx,tenant,actor,id.data);return {status:202,body:await readAgentRun(tx,tenant,actor.userId,next,services)};});
 }));
 for(const cancel of [false,true])app.route<{Params:{id:string}}>({method:cancel?'POST':'GET',url:'/v1/agent/runs/:id'+(cancel?'/cancel':''),handler:async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault('INVALID_CONTRACT');
  return inAuthorizedTransaction(services.db,actor,async tx=>{if(cancel)await cancelAgentChain(tx,tenant,id.data);return {status:200,body:await readAgentRun(tx,tenant,actor.userId,id.data,services)};});
 })});
}
export function startAgentWorker(app:FastifyInstance,services:Services,options:AgentOptions={}){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<unknown>=Promise.resolve();
 const tick=()=>{running=runAgentOnce(services,options).catch(()=>{}).finally(()=>{if(!stopped){timer=setTimeout(tick,750);timer.unref();}});};
 app.addHook('onReady',async()=>{tick();});app.addHook('onClose',async()=>{stopped=true;if(timer)clearTimeout(timer);await running;await drainAgentTasks(services);});
}

async function currentReceipt(tx:Tx,tenant:string,target:any,result:any,services:Pick<Services,'capturePolicy'>){
 const [issue]=await tx`select * from app.work_decision_cases where tenant_id=${tenant}::uuid and id=${target?.id??null}::uuid`;
 if(issue&&await issueCurrent(tx,tenant,issue,services.capturePolicy))return result;
 return {receipt:{decision_id:result.receipt?.decision_id??null,text:'답변 처리 기록은 유지해요. 원문이 바뀌었거나 접근 범위가 달라 현재 내용은 다시 확인해야 해요.',payment_confirmed:false,delivery_confirmed:false,work_completed:false}};
}

async function currentQuestions(tx:Tx,tenant:string,user:string,project:string|null,services:Pick<Services,'capturePolicy'>){const value=await readWorkIssues(tx,tenant,user,false,services.capturePolicy,false);return {questions:value.questions.filter(q=>!project||q.project_id===project).slice(0,30).map(q=>({id:q.id,version:q.version,project_id:q.project_id,project_name:q.project_name,work_label:q.work_label,prompt:q.prompt,can_defer:!['safety','today_blocked','payment_due'].includes(q.cause),blocked:q.proposal.blocked??null})),coverage:value.coverage};}
