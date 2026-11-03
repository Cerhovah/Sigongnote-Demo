import {requestAgentDelivery} from './deliveries.js';
import {preparePhotoSheet} from './photo-sheets.js';
import {getAgentArtifacts,ArtifactReceiptSchema} from './agent-artifacts.js';
import {prepareAgentDocument} from './document-readiness.js';
import {readWorkIssues} from './work-decisions.js';
import {replyOnce} from './work-replies.js';
import {z} from 'zod';
import {EntityKindSchema} from '@sigongnote/contracts';
import type {Tx} from './auth.js';
import {ApiFault,type Services} from './routes.js';
import {EvidenceSearchSchema,searchEvidence} from './evidence-search.js';
import {readBusinessWork} from './business-events.js';

export const agentToolNames=['search_evidence','get_evidence','resolve_entities','get_work_state','get_run_status','list_exceptions','answer_exception','prepare_document','get_artifact','prepare_photo_sheet','request_delivery'] as const;
export const AgentCallSchema=z.strictObject({tool:z.enum(agentToolNames),input:z.string().min(2).max(5000)});
/** `answer` is the model's explanation for the person (facts·unknowns·next step). It never grants an effect; effects come only from executed tool calls. */
export const AgentPlanSchema=z.strictObject({calls:z.array(AgentCallSchema).max(8),done:z.boolean(),missing:z.enum(['none','scope','unsupported_action','more_evidence']),answer:z.string().max(1200).nullable().optional()});
export type AgentPlan=z.infer<typeof AgentPlanSchema>;
export type AgentScope={tenant:string;user:string;project:string|null;run:string;instruction:string;answerTo?:{id:string;version:number}|null;improvementVersion?:string|null};
const object=z.strictObject({id:z.uuid()});
export const AgentQuestionSchema=z.strictObject({id:z.uuid(),version:z.number().int().positive(),project_id:z.uuid(),project_name:z.string(),work_label:z.string(),prompt:z.string(),can_defer:z.boolean(),blocked:z.string().nullable()});
export const AgentToolResultSchema=z.union([
 z.strictObject({delivery_choices:z.boolean()}),z.strictObject({delivery:z.object({id:z.uuid(),state:z.string(),scope_hash:z.string()}).passthrough()}),
 z.strictObject({photo_choices:z.boolean()}),z.strictObject({photo_sheet:z.strictObject({id:z.uuid(),title:z.string(),state:z.string()})}),
 z.strictObject({artifacts:z.array(z.lazy(()=>ArtifactReceiptSchema)).max(5)}),
 z.strictObject({cards:z.array(z.object({revision_id:z.uuid(),title:z.string().max(100),excerpt:z.string().max(400)}).passthrough()).max(30)}),
 z.strictObject({entities:z.array(z.object({id:z.uuid(),kind:EntityKindSchema,display_name:z.string()}).passthrough()).max(20),contexts:z.array(z.object({id:z.uuid(),label:z.string()}).passthrough()).max(20),coverage:z.enum(['partial','complete'])}),
 z.strictObject({questions:z.array(AgentQuestionSchema).max(30),coverage:z.string()}),
 z.strictObject({document_choices:z.strictObject({type:z.enum(['estimate','purchase_order','invoice','delivery_statement']),project_id:z.uuid(),contexts:z.array(z.strictObject({id:z.uuid(),label:z.string()})).max(20),partial:z.boolean()})}),
 z.strictObject({document:z.strictObject({id:z.uuid(),type:z.enum(['estimate','purchase_order','invoice','delivery_statement']),state:z.string(),stale:z.boolean(),latest_id:z.uuid(),missing:z.array(z.string()),label:z.string()})}),
 z.strictObject({receipt:z.record(z.string(),z.unknown())}),
 z.strictObject({work:z.record(z.string(),z.unknown()).nullable()}),
 z.strictObject({run:z.object({id:z.uuid(),status:z.string()}).passthrough()}),
]);
export async function executeAgentTool(tx:Tx,scope:AgentScope,call:z.infer<typeof AgentCallSchema>,services:Pick<Services,'capturePolicy'>){
 const result=await runTool(tx,scope,call,services);if(Buffer.byteLength(JSON.stringify(result))>60000)throw new ApiFault('PAYLOAD_TOO_LARGE');return AgentToolResultSchema.parse(result);
}
async function runTool(tx:Tx,scope:AgentScope,call:z.infer<typeof AgentCallSchema>,services:Pick<Services,'capturePolicy'>){
 let input:unknown;try{input=JSON.parse(call.input);}catch{throw new ApiFault('INVALID_CONTRACT');}
 const {tenant,project}=scope;
 if(call.tool==='request_delivery')return requestAgentDelivery(tx,scope,input);
 if(call.tool==='prepare_photo_sheet')return preparePhotoSheet(tx,scope,input);
 if(call.tool==='get_artifact')return getAgentArtifacts(tx,scope,input);
 if(call.tool==='prepare_document'){const b=z.strictObject({type:z.enum(['estimate','purchase_order','invoice','delivery_statement']),context_id:z.uuid().optional(),project_id:z.uuid().optional()}).parse(input);return prepareAgentDocument(tx,scope,b.type,b.context_id,b.project_id);}
 if(call.tool==='list_exceptions'){
  z.strictObject({}).parse(input);const result=await readWorkIssues(tx,tenant,scope.user,false,services.capturePolicy,true,scope.improvementVersion);
  return {questions:result.questions.filter(q=>!project||q.project_id===project).slice(0,30).map(q=>({id:q.id,version:q.version,project_id:q.project_id,project_name:q.project_name,work_label:q.work_label,prompt:q.prompt,can_defer:!['safety','today_blocked','payment_due'].includes(q.cause),blocked:q.proposal.blocked??null})),coverage:result.coverage};
 }
 if(call.tool==='answer_exception'){
  const b=z.strictObject({id:z.uuid(),version:z.number().int().positive()}).parse(input);
  if(!scope.answerTo||b.id!==scope.answerTo.id||b.version!==scope.answerTo.version)throw new ApiFault('INVALID_CONTRACT');
  const [q]=await tx`select project_id from app.work_decision_cases where tenant_id=${tenant}::uuid and id=${b.id}::uuid`;if(!q||project&&q.project_id!==project)throw new ApiFault('NOT_FOUND');
  const result=await replyOnce(tx,tenant,scope.user,{command_id:scope.run,question_id:b.id,question_version:b.version,text:scope.instruction},services.capturePolicy);return {receipt:result.body};
 }
 if(call.tool==='search_evidence'){

  const q=EvidenceSearchSchema.parse(input);if(project&&q.project_id&&q.project_id!==project)throw new ApiFault('NOT_FOUND');
  return {cards:await searchEvidence(tx,tenant,{...q,project_id:project??q.project_id})};
 }
 if(call.tool==='get_evidence'){
  const b=object.parse(input);return {cards:await searchEvidence(tx,tenant,{query:'',project_id:project,versions:'history'},[b.id])};
 }
 if(call.tool==='resolve_entities'){
  const b=z.strictObject({query:z.string().trim().min(1).max(100),kind:EntityKindSchema.optional()}).parse(input);
  const rows=await tx`select c.* from app.entity_catalog c where c.tenant_id=${tenant}::uuid and (${project}::uuid is null or c.project_id=${project}::uuid or c.kind='project' and c.id=${project}::uuid)
   and (${b.kind??null}::text is null or c.kind=${b.kind??null}) and (c.display_name ilike ${'%'+b.query+'%'} or exists(select 1 from app.entity_aliases a where a.tenant_id=c.tenant_id and a.target_kind=c.kind and a.target_id=c.id and a.alias ilike ${'%'+b.query+'%'} and a.status='active' and a.revoked_at is null and (a.valid_from is null or a.valid_from<=now()) and (a.valid_until is null or a.valid_until>now()) and (a.scope='company' or a.scope='project' and a.scope_id=${project}::uuid) and (a.evidence_revision is null or app.revision_accessible(a.tenant_id,a.evidence_revision)))) order by c.kind,c.id limit 21`;
  const contexts=await tx`select id,label,project_id from app.work_contexts where tenant_id=${tenant}::uuid and (${project}::uuid is null or project_id=${project}::uuid) and label ilike ${'%'+b.query+'%'} order by id limit 21`;
  return {entities:rows.slice(0,20),contexts:contexts.slice(0,20),coverage:rows.length>20||contexts.length>20?'partial':'complete'};
 }
 if(call.tool==='get_work_state'){
  const b=object.parse(input);const [context]=await tx`select id from app.work_contexts where tenant_id=${tenant}::uuid and id=${b.id}::uuid and (${project}::uuid is null or project_id=${project}::uuid)`;
  if(!context)throw new ApiFault('NOT_FOUND');return {work:await readBusinessWork(tx,tenant,b.id,services.capturePolicy)};
 }
 const b=object.parse(input);const [run]=await tx`select id,status,project_id,tool_count,rounds from app.agent_runs where tenant_id=${tenant}::uuid and id=${b.id}::uuid and user_id=${scope.user}::uuid and (${project}::uuid is null or project_id=${project}::uuid)`;
 if(!run)throw new ApiFault('NOT_FOUND');return {run};
}
/** Provider sees counts and opaque IDs only. Source text never becomes a second instruction channel. */
export function agentFeedback(result:any){return {delivery_id:result.delivery?.id??null,delivery_choices:result.delivery_choices??false,photo_sheet_id:result.photo_sheet?.id??null,photo_choices:result.photo_choices??false,artifact_ids:result.artifacts?.map((a:any)=>({id:a.id,revision_id:a.revision_id,state:a.state,formats:a.files.map((f:any)=>f.format)}))??[],count:result.questions?.length??result.cards?.length??result.entities?.length??0,question_ids:result.questions?.map((q:any)=>({id:q.id,version:q.version}))??[],applied:!!result.receipt?.decision_id,document_id:result.document?.id??null,document_state:result.document?.state??null,revision_ids:result.cards?.map((c:any)=>c.revision_id)??[],entity_ids:result.entities?.map((e:any)=>({id:e.id,kind:e.kind}))??[],context_ids:result.contexts?.map((c:any)=>c.id)??[],context_id:result.work?.context_id??null,status:result.run?.status??null,error_code:result.error_code??null};}
