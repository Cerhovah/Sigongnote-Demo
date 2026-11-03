import {createAgentRun,readAgentRun} from './agent-runs.js';
import {searchPlan,searchEvidence,refreshSearchResponse} from './evidence-search.js';
import {createHash} from "node:crypto";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import {inAuthorizedTransaction,type Tx} from "./auth.js";
import {ApiFault,execute,membership,principal,tenantHeader,type Services} from "./routes.js";
import {documentIntent} from "@sigongnote/domain";
import {prepareDocument,documentNames} from "./document-drafts.js";
const body=z.strictObject({client_turn_id:z.uuid(),text:z.string().trim().min(1).max(2000),selected_project_id:z.uuid().optional(),attachment_refs:z.array(z.uuid()).max(0),input_kind:z.enum(["text","voice"]).optional()});
export function isUnsupportedAction(text:string){return !/찾|보여|검색|열어/.test(text)&&/(만들어|작성해|발행해|보내|공유해|송금해|지급해|취소해|바꿔)\s*(줘|주세요|줄래|달라|$)/.test(text);}
type SavedResponse={cards:{revision_id:string;[key:string]:unknown}[];text:string;[key:string]:unknown};
async function accessibleResponse(tx:Tx,tenant:string,response:SavedResponse){
 return refreshSearchResponse(tx,tenant,response);
}
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function searchTerms(text:string,projectNames:string[]){let q=text;for(const name of projectNames)q=q.replaceAll(name,"");return q.replace(/찾아\s*줘(?:요)?|찾아주세요|보여\s*줘(?:요)?|보여주세요|검색해\s*줘(?:요)?|검색|열어\s*줘(?:요)?|업체가|지난번|보내준|만든|작성된|공유받은|지급해준|최근|최신|자료|문서|원문|관련|좀|주세요|부탁해요/g," ").replace(/[?!.，,]/g," ").split(/\s+/).map(t=>t.replace(/(?:에서|으로|부터|까지|의|을|를)$/u,"")).filter(t=>t.length>=2).slice(0,8);}
export function registerConversationRoutes(app:FastifyInstance,services:Services){
 app.post<{Params:{id:string}}>("/v1/conversations/:id/turns",async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id),p=body.safeParse(req.body);if(!id.success||!p.success)throw new ApiFault("INVALID_CONTRACT");const b=p.data;
  return inAuthorizedTransaction(services.db,actor,async tx=>{
   if(await membership(tx,tenant,actor.userId)==="viewer")throw new ApiFault("NOT_FOUND");
   await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:conversation:${id.data}`},0))`;
   await tx`insert into app.conversations(tenant_id,id,user_id) values(${tenant}::uuid,${id.data}::uuid,${actor.userId}::uuid) on conflict do nothing`;
   if(!(await tx`select id from app.conversations where tenant_id=${tenant}::uuid and id=${id.data}::uuid and user_id=${actor.userId}::uuid`).length)throw new ApiFault("NOT_FOUND");
   const [old]=await tx`select request_hash,response from app.conversation_turns where tenant_id=${tenant}::uuid and conversation_id=${id.data}::uuid and id=${b.client_turn_id}::uuid`;
   if(old){if(old.request_hash!==hash(b))throw new ApiFault("IDEMPOTENCY_CONFLICT");return {status:200,body:old.response.run_id?await readAgentRun(tx,tenant,actor.userId,old.response.run_id,services):await accessibleResponse(tx,tenant,old.response)};}
   const projects=await tx`select id,display_name from app.projects where tenant_id=${tenant}::uuid order by id limit 1000`;
   if(b.selected_project_id&&!projects.some(p=>p.id===b.selected_project_id))throw new ApiFault("NOT_FOUND");
   const aliases=await tx`select project_id,alias from app.entity_aliases where tenant_id=${tenant}::uuid and revoked_at is null and target_kind='project' and status='active' and (valid_from is null or valid_from<=now()) and (valid_until is null or valid_until>now()) and (evidence_revision is null or app.revision_accessible(tenant_id,evidence_revision))`;
   const names=[...projects,...aliases.map(a=>({id:a.project_id,display_name:a.alias}))];
   const matches=names.filter(p=>b.text.includes(String(p.display_name)));const mentioned=matches.filter(p=>!matches.some(other=>other.display_name!==p.display_name&&String(other.display_name).includes(String(p.display_name))));const scope=b.selected_project_id??(new Set(mentioned.map(p=>p.id)).size===1?String(mentioned[0]?.id):null);
   const intent=documentIntent(b.text);
   if(intent&&!services.agentRuntime){
    const project=scope??(projects.length===1?String(projects[0]!.id):null);
    const instruction=projects.reduce((text,p)=>text.replaceAll(String(p.display_name),''),b.text);
    const margin=/마진\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(instruction);
    // The legacy document adapter accepts only its explicitly supported current-source request.
    // Quantities, dates and changes are handled by the typed agent/document tools as they are connected.
    const currentRequest=z.strictObject({scope:z.literal('current_sources'),margin_bps:z.number().int().min(0).max(9999).optional()});
    const remainder=instruction.replace(margin?.[0]??'','').replace(/견적서?|발주서?|청구서?|거래명세서?|준비해\s*줘(?:요)?|준비해주세요|만들어\s*줘(?:요)?|작성해\s*줘(?:요)?|현재|이번|자료로|초안|현장|이|의|을|를|[.!?]/gu,'').trim();
    const request=currentRequest.safeParse({scope:remainder?'unsupported':'current_sources',...(margin?{margin_bps:Math.round(Number(margin[1])*100)}:{})});
    const unsupportedScope=!request.success;
    const canPrepare=await membership(tx,tenant,actor.userId)==='owner';
    const draft=canPrepare&&project&&!unsupportedScope?await prepareDocument(tx,tenant,actor.userId,project,intent,b.client_turn_id,margin?{margin_bps:Math.round(Number(margin[1])*100)}:{}):null;
    const response={turn_id:b.client_turn_id,status:draft?'completed':'needs_answer',text:draft?`${documentNames[intent]} 초안을 준비했어요. 내용을 확인해 주세요.`:!canPrepare?'대표 계정에서 문서를 준비할 수 있어요. 자료 검색은 계속 이용하실 수 있어요.':unsupportedScope?'요청하신 수량·기간·변경 범위를 지금 자동으로 적용할 수는 없어요. 현재 자료로 준비하려면 문서 이름과 준비해줘를 입력해 주세요.':'어느 현장의 문서를 준비할까요? 현장을 하나 골라 주세요.',cards:[],document_draft:draft,action_receipts:[],job_refs:[],engine:'document-draft-v1'};
    await tx`insert into app.conversation_turns(tenant_id,conversation_id,id,request_hash,text,response,engine_version) values(${tenant}::uuid,${id.data}::uuid,${b.client_turn_id}::uuid,${hash(b)},${b.text},${tx.json(response)},'document-draft-v1')`;
    return {status:200,body:response};
   }

   if(services.agentRuntime){
    const run=await createAgentRun(tx,tenant,actor,{client_turn_id:b.client_turn_id,instruction:b.text,input_kind:b.input_kind??'text',...(scope?{project_id:scope}:{})});
    const response=await readAgentRun(tx,tenant,actor.userId,run,services);
    await tx`insert into app.conversation_turns(tenant_id,conversation_id,id,request_hash,text,response,engine_version) values(${tenant}::uuid,${id.data}::uuid,${b.client_turn_id}::uuid,${hash(b)},${b.text},${tx.json(response as never)},'agent-v1')`;
    return {status:200,body:response};
   }
   const unsupported=isUnsupportedAction(b.text);
   const ambiguous=!b.selected_project_id&&new Set(mentioned.map(p=>p.id)).size>1;
   const retrieval_request={...searchPlan(b.text,mentioned.map(p=>String(p.display_name))),project_id:scope};
   const unique=unsupported||ambiguous?[]:await searchEvidence(tx,tenant,retrieval_request);
   const response={turn_id:b.client_turn_id,status:unsupported||ambiguous?"needs_answer":"completed",text:unsupported?"지금은 자료를 찾아 열 수 있어요. 문서 작성·발행은 다음 단계에서 연결해요.":ambiguous?"어느 현장 자료를 찾을까요? 현장을 하나 골라 다시 찾아주세요.":unique.length?`${unique.length}개 자료를 찾았어요. 최신 자료부터 보여드려요.`:retrieval_request.event_kinds.length||retrieval_request.quantity?"확인된 업무 의미 기록에서 찾지 못했어요. 아직 의미를 확인하지 못한 자료도 있으니 자재 이름으로 본문을 찾아보세요.":"읽은 내용에서 찾지 못했어요. 현장 이름이나 자재 이름으로 다시 찾아보세요. 아직 읽는 중인 자료는 포함되지 않아요.",cards:unique,retrieval_request,action_receipts:[],job_refs:[],engine:"evidence-search-v2"};
   await tx`insert into app.conversation_turns(tenant_id,conversation_id,id,request_hash,text,response,engine_version) values(${tenant}::uuid,${id.data}::uuid,${b.client_turn_id}::uuid,${hash(b)},${b.text},${tx.json(response)},'evidence-search-v2')`;
   return {status:200,body:response};
  });
 }));
 app.get<{Params:{id:string}}>("/v1/conversations/:id/turns",async(req,reply)=>execute(reply,async()=>{
  const actor=await principal(req,services),tenant=tenantHeader(req),id=z.uuid().safeParse(req.params.id);if(!id.success)throw new ApiFault("INVALID_CONTRACT");
  return inAuthorizedTransaction(services.db,actor,async tx=>{await membership(tx,tenant,actor.userId);const turns=await tx`select id,text,response,created_at from app.conversation_turns where tenant_id=${tenant}::uuid and conversation_id=${id.data}::uuid order by created_at desc,id desc limit 20`;return {status:200,body:{turns:await Promise.all(turns.reverse().map(async turn=>({...turn,response:turn.response.run_id?await readAgentRun(tx,tenant,actor.userId,turn.response.run_id,services):await accessibleResponse(tx,tenant,turn.response)})))}};});
 }));
}
