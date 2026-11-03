import {createHash} from 'node:crypto';
import type postgres from 'postgres';
import type {Db,Tx} from './auth.js';
import {callSemantic,semanticRequest,SemanticNotAccepted,SemanticInvalidOutput} from './semantic-provider.js';
import {tokenCostKrw,type ProductAiConfig} from './product-ai-config.js';
import {CandidateRouter,type ClaimInput,type ModelResponse} from '@sigongnote/domain';
import type {SemanticValidationContext} from '@sigongnote/domain';
export type ProductScope={tenant:string;user:string;source:string|null;generation:number|null;revision:string|null};
export type ProductReservation=ProductScope&{id:string;channel:'semantic'|'vision'|'short_stt'|'long_stt'|'agent'|'sms_triage'|'context';hash:string;config:Record<string,postgres.JSONValue>;krw:number};
export function stableRunId(key:string){const hex=createHash('sha256').update(key).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
export async function reserveProductAi(db:Db|Tx,r:ProductReservation){
 const [row]=await db`select app.reserve_product_ai(${r.tenant}::uuid,${r.user}::uuid,${r.id}::uuid,${r.channel},${r.source}::uuid,${r.generation}::bigint,${r.revision}::uuid,${r.hash},${db.json(r.config)},${r.krw}::bigint) value`;
 return row?.value as {state:string;result?:ModelResponse|null;reused?:boolean};
}
export async function submitProductAi(db:Db|Tx,r:Pick<ProductReservation,'tenant'|'user'|'id'>){
 const [row]=await db`select app.submit_product_ai(${r.tenant}::uuid,${r.user}::uuid,${r.id}::uuid) ok`;return row?.ok===true;
}
export async function finishProductAi(db:Db|Tx,r:Pick<ProductReservation,'tenant'|'user'|'id'>,actual:number|null,result:unknown,receipt:string|null,usage:Record<string,postgres.JSONValue>){
 const [row]=await db`select app.finish_product_ai(${r.tenant}::uuid,${r.user}::uuid,${r.id}::uuid,${actual}::bigint,${result==null?null:db.json(result as never)}::jsonb,${receipt},${db.json(usage)}) ok`;return row?.ok===true;
}
/** One persisted reservation is the cache and submission fence. Never retry an ambiguous paid request. */
export async function runSemantic(db:Db,scope:ProductScope,input:ClaimInput,config:ProductAiConfig,trace:Record<string,postgres.JSONValue>,signal:AbortSignal,transport?:typeof fetch,context?:SemanticValidationContext){
 if(Date.parse(config.price.valid_until)<=Date.now())return {state:'price_expired',runId:null,value:null};
 if(!input.externalAiConsent||input.tenantId!==scope.tenant||input.revisionId!==scope.revision||input.sourceGeneration!==scope.generation)return {state:'scope_blocked',runId:null,value:null};
 const request=semanticRequest(input,config,context);
 const snapshot={...trace,provider:config.provider,model:config.model,price:config.price,prompt:input.promptVersion,schema:input.schemaVersion,parser:input.parserVersion,source_hash:input.sourceHash,scope:input.scopeFingerprint,generation:input.sourceGeneration};
 const hash=createHash('sha256').update(JSON.stringify({scope,input:request.serialized,snapshot})).digest('hex');
 const reservation:ProductReservation={...scope,id:stableRunId(hash),channel:'semantic',hash,config:snapshot,krw:Math.max(1,tokenCostKrw(config.price,request.inputTokenBound,config.maxOutputTokens))};
 const reserved=await reserveProductAi(db,reservation);
 if(reserved.state==='settled')return {state:reserved.result?'cached':'rejected',runId:reservation.id,value:reserved.result??null};
 if(reserved.state!=='reserved'||signal.aborted)return {state:reserved.state,runId:reservation.id,value:null};
 if(!await submitProductAi(db,reservation))return {state:'not_submitted',runId:reservation.id,value:null};
 try{
  const response=await callSemantic(input,config,signal,transport,context);
  const krw=tokenCostKrw(config.price,response.inputTokens,response.outputTokens);
  const allowed=await finishProductAi(db,reservation,krw,response.value,response.receipt,{input_tokens:response.inputTokens,output_tokens:response.outputTokens,pricing:'conservative_conversion',input_token_bound:request.inputTokenBound});
  return {state:allowed?'candidate':'withdrawn',runId:reservation.id,value:allowed?response.value:null};
 }catch(error){
  if(error instanceof SemanticInvalidOutput){
   await finishProductAi(db,reservation,tokenCostKrw(config.price,error.inputTokens,error.outputTokens),null,error.receipt,{error_code:'MODEL_RESPONSE_INVALID',input_tokens:error.inputTokens,output_tokens:error.outputTokens,pricing:'conservative_conversion'});
   return {state:'rejected',runId:reservation.id,value:null};
  }
  const rejected=error instanceof SemanticNotAccepted;
  await finishProductAi(db,reservation,rejected?0:null,null,null,rejected?{error_code:'PROVIDER_NOT_ACCEPTED',http_status:error.status}:{error_code:'PROVIDER_OUTCOME_UNKNOWN'});
  return {state:rejected?'rejected':'unknown',runId:reservation.id,value:null};
 }
}
export function budgetedCandidateRouter(db:Db,scope:ProductScope,config:ProductAiConfig,trace:Record<string,postgres.JSONValue>,signal:AbortSignal,transport?:typeof fetch){
 return new CandidateRouter({name:config.model,kind:'external',async generate(){throw Error('BUDGET_PORT_REQUIRED');}},async input=>{
  const result=await runSemantic(db,scope,input,config,trace,signal,transport);
  return result.value?{status:'candidate',value:result.value,cacheHit:result.state==='cached',tier:'small'}:{status:result.state==='unknown'?'rejected':'budget_paused',reason:result.state};
 });
}
