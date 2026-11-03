import type {AudioProgress,AudioCorrection} from './work-audio.js';
import {workId} from "./work-id.js";
import { ApiErrorSchema, workHttp, WorkRequestSchema, type ReadinessReport,type CapturePolicy } from "@sigongnote/contracts";
import type { z } from "zod";
import { ensurePaired, localRequest } from "./local-api.js";
export type WorkRequest=z.infer<typeof WorkRequestSchema>;
export type VoiceEvent={id:string;phase:"partial"|"final"|"error";text?:string;code?:string};
export type SetupSourceKind='photos'|'call_recording'|'sms';
export type NativeSetupStatus={smsOriginal?:string;folderReadable?:number;folderCloudReady?:number;folderCloudAttention?:number};
export interface WorkClient {nativeSetup?:{status():Promise<NativeSetupStatus>;connect(kind:SetupSourceKind):Promise<string>};openAccount?:()=>void;capturePhoto?:()=>void;startVoice?:(event:(value:VoiceEvent)=>void)=>{id:string;cancel:()=>void};request<T>(request:WorkRequest):Promise<T>;dispose():void;kind:"local"|"native"|"remote"|"fixture";createMessageFixture?:()=>Promise<void>;createAudioFixture?:()=>Promise<void>;createFixture?:()=>Promise<void>}
export type Material={readable_spans?:number;audio?:AudioProgress|null;id:string;title:string;status:string;job_state:string|null;project_name:string|null;created_at:string;processed_at:string|null;sha256:string;processor_version:string|null;categories?:string[];organization_state?:string;organization_version?:number;project_id?:string|null;work_label?:string|null;matched_text?:string|null};
export type MaterialList={materials:Material[];next_cursor:string|null};
export type ObservedWork={observed_state:Record<string,{subject:string;quantity:string|null;unitCode:string|null;eventIds:string[];uncertain:boolean}[]>;coverage:{auditCount:number;unassertedCount:number;withdrawnCount:number;conflictCount:number}};
export type MaterialDetail={local_record?:boolean;observed_work?:ObservedWork|null;audio?:AudioProgress|null;corrections?:AudioCorrection[];organization?:null|{state:string;version:number;categories:string[];work_label?:string|null};facts?:{span_id:number;assertion_kind:string}[];revision:{id:string;original_available?:boolean;archived?:boolean;revision_number?:number;latest_revision_id?:string;status:string;declared_mime?:string};result:null|{created_at:string;processor_version:string;output:{status:string;spans:{text:string;locator:string}[];issues:string[];excerptTruncated:boolean;sourceHash:string}}};
export type WorkContext={ai_consent?:{allowed:boolean;version:number;policy_current:boolean;processing_policy?:CapturePolicy|null};cloud_connected?:boolean;cloud_status?:'connected'|'offline'|'local';setup?:{project_id:string|null;version:number;dismissed:boolean;completed:boolean}|null;user_id:string;tenant_id:string;company:string;can_maintain?:boolean;can_resolve_site?:boolean;projects?:{id:string;display_name:string}[];readiness?:ReadinessReport};
export class WorkFailure extends Error {constructor(readonly code:string){super(code==="login_required"?"로그인이 필요해요. 같은 계정으로 연결하면 휴대폰과 PC의 업무를 이어 볼 수 있어요.":code==="account_changed"?"계정이 바뀌었어요. 업무 화면을 다시 열어 주세요.":"최신 자료를 아직 못 가져왔어요. 연결되면 다시 확인할게요.");}}
type Bridge={postMessage(message:string):void;onmessage?:((event:MessageEvent)=>void)|null};
type EdgeBridge={postMessage(message:unknown):void;addEventListener(type:string,handler:(event:MessageEvent)=>void):void;removeEventListener(type:string,handler:(event:MessageEvent)=>void):void};
declare global {interface Window {SigongnoteNative?:Bridge;chrome?:{webview?:EdgeBridge}}}
export function nativeWorkClient():WorkClient{
 const android=window.SigongnoteNative,edge=window.chrome?.webview;
 if(!android&&!edge)throw new Error("앱에서 다시 열어 주세요.");
 const voices=new Map<string,(event:VoiceEvent)=>void>();
 const pending=new Map<string,{method:string;resolve:(value:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const waiting:{id:string;wire:string;deadline:number}[]=[],activeWork=new Set<string>();let disposed=false;
 // Android has two HTTP workers and four admission slots. Normal Today reads wait here
 // before entering the bridge. A submitted command is sent once.
 function expireWork(id:string){const item=pending.get(id);if(!item)return;pending.delete(id);const queued=waiting.findIndex(value=>value.id===id);if(queued>=0)waiting.splice(queued,1);const wasActive=activeWork.delete(id);item.reject(new WorkFailure('connection_wait'));if(wasActive)dispatch();}
 function dispatch(){while(android&&!disposed&&activeWork.size<2&&waiting.length){const next=waiting.shift()!,item=pending.get(next.id);if(!item)continue;if(next.deadline<=Date.now()){expireWork(next.id);continue;}clearTimeout(item.timer);item.timer=setTimeout(()=>expireWork(next.id),45000);activeWork.add(next.id);try{android.postMessage(next.wire);}catch{activeWork.delete(next.id);pending.delete(next.id);clearTimeout(item.timer);item.reject(new WorkFailure('connection_wait'));}}}
 const receive=(event:MessageEvent)=>{
  try{const value=typeof event.data==="string"?JSON.parse(event.data):event.data;
   if(value.bridgeVersion===1&&value.method==="startVoiceInput"){
    const callback=voices.get(value.requestId);if(!callback)return;const result=typeof value.result==="string"?JSON.parse(value.result):value.result;
    if(!["partial","final","error"].includes(result?.phase))return;
    if(result.phase!=="partial")voices.delete(value.requestId);callback({id:value.requestId,...result});return;
   }
    if(value.bridgeVersion!==1)return;
    // A late acknowledgement cannot replay an expired request or affect another request's slot.
    if(value.method==='workRequest'&&activeWork.delete(value.requestId))dispatch();
    const item=pending.get(value.requestId);if(!item||item.method!==value.method)return;
   pending.delete(value.requestId);clearTimeout(item.timer);
    if(!value.ok)item.reject(new WorkFailure(String(value.result)));
    else if(item.method==='connectSource')item.resolve(value.result);
    else item.resolve(typeof value.result==="string"?JSON.parse(value.result):value.result);
  }catch{/* Ignore a message which is not a matching response. */}
 };
 if(android)android.onmessage=receive;else edge?.addEventListener("message",receive);
 function command<T>(method:string,payload:unknown,timeout=45000):Promise<T>{
  const id=workId();return new Promise<T>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(new WorkFailure('connection_wait'));},timeout);
   pending.set(id,{method,resolve:value=>resolve(value as T),reject,timer});
   try{const message={bridgeVersion:1,requestId:id,method,payload};if(android)android.postMessage(JSON.stringify(message));else edge?.postMessage(message);}
   catch{clearTimeout(timer);pending.delete(id);reject(new WorkFailure('connection_wait'));}
  });
 }
 const cancelVoice=(id:string)=>{voices.delete(id);android?.postMessage(JSON.stringify({bridgeVersion:1,requestId:workId(),method:"cancelVoiceInput",payload:{voice_request_id:id}}));};
 return {kind:"native",...(android?{nativeSetup:{status:()=>command<NativeSetupStatus>('getConnectionState',{}),connect:(kind:SetupSourceKind)=>command<string>('connectSource',{kind},180000)},capturePhoto(){android.postMessage(JSON.stringify({bridgeVersion:1,requestId:workId(),method:"openPhotoCapture",payload:{}}));},openAccount(){android.postMessage(JSON.stringify({bridgeVersion:1,requestId:workId(),method:"openAccount",payload:{}}));},startVoice(callback:(value:VoiceEvent)=>void){const id=workId();voices.set(id,callback);android.postMessage(JSON.stringify({bridgeVersion:1,requestId:id,method:"startVoiceInput",payload:{}}));return {id,cancel:()=>cancelVoice(id)};}}:{}),request<T>(input:WorkRequest){const payload=WorkRequestSchema.parse(input),id=workId();if(disposed)return Promise.reject(new WorkFailure('account_changed'));if(android&&waiting.length+activeWork.size>=32)return Promise.reject(new WorkFailure('work_busy'));return new Promise<T>((resolve,reject)=>{
  const timer=setTimeout(()=>{if(android)expireWork(id);else{pending.delete(id);reject(new WorkFailure('connection_wait'));}},45000);
  pending.set(id,{method:'workRequest',resolve:value=>resolve(value as T),reject,timer});
  const message={bridgeVersion:1,requestId:id,method:"workRequest",payload};
  if(android){waiting.push({id,wire:JSON.stringify(message),deadline:Date.now()+45000});dispatch();}else edge?.postMessage(message);
 });},dispose(){disposed=true;waiting.length=0;activeWork.clear();for(const id of voices.keys())cancelVoice(id);if(android)android.onmessage=null;else edge?.removeEventListener("message",receive);for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error("화면을 닫았어요."));}pending.clear();}};
}
export function localWorkClient():WorkClient{return {kind:"local",async request<T>(request:WorkRequest){await ensurePaired();try{return await localRequest<T>("work",WorkRequestSchema.parse(request));}catch(e){const code=(e as {code?:string}).code;if(code==='FIELD_ANSWER_CHANGED')throw new WorkFailure('VERSION_CONFLICT');if(code==='FIELD_DOCUMENT_INVALID')throw new WorkFailure('DOMAIN_INVARIANT');throw e;}},dispose(){}};}
async function responseError(response:Response){const parsed=ApiErrorSchema.safeParse(await response.json().catch(()=>null));return new WorkFailure(parsed.success?parsed.data.error.code:response.status===409?'VERSION_CONFLICT':response.status===422?'DOMAIN_INVARIANT':'connection_wait');}
export function fixtureWorkClient():WorkClient {
 const post=async(path:string,body:unknown)=>{const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-Sigongnote-Fixture":"1"},body:JSON.stringify(body),cache:"no-store"});if(!response.ok)throw await responseError(response);return response.json();};
 return {kind:"fixture",request:input=>post("/fixture/work",WorkRequestSchema.parse(input)),async createMessageFixture(){await post("/fixture/message",{});},async createAudioFixture(){await post("/fixture/audio",{});},async createFixture(){await post("/fixture/create",{});},dispose(){}};
}
/** Web authentication supplies its own in-memory session; native tokens never enter this adapter. */
export function remoteWorkClient(origin:string,session:()=>Promise<{accessToken:string;tenantId:string;userId:string}>):WorkClient {
 const url=new URL(origin);if(url.protocol!=="https:"||url.pathname!=="/"||url.username||url.password||url.search||url.hash)throw new Error("업무 서버 주소를 확인해 주세요.");
 let disposed=false,bound="";
 return {kind:"remote",async request<T>(input:WorkRequest){const before=await session();const identity=`${before.userId}:${before.tenantId}`;if(bound&&bound!==identity)throw new WorkFailure("account_changed");bound=identity;const call=workHttp(input);const response=await fetch(new URL(call.path,url),{method:call.method,...(call.body?{body:JSON.stringify(call.body)}:{}),headers:{...(call.body?{"Content-Type":"application/json"}:{}),...(call.key?{"Idempotency-Key":call.key}:{}),...{Authorization:`Bearer ${before.accessToken}`,"X-Tenant-ID":before.tenantId}},redirect:"error",credentials:"omit",cache:"no-store",signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw response.status===401||response.status===403?new WorkFailure("login_required"):await responseError(response);const data=await response.json();const after=await session();
  if(disposed||after.userId!==before.userId||after.tenantId!==before.tenantId)throw new WorkFailure("account_changed");return data as T;
 },dispose(){disposed=true;}};
}
