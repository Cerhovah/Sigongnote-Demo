import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import type {CapturePolicy} from '@sigongnote/contracts';
export type SetupPolicy=CapturePolicy;
const providers:Record<string,string>={anthropic:'Anthropic Claude',openai:'OpenAI',clova_speech:'NAVER CLOVA Speech',local_fixture:'개발 PC'};
const providerName=(provider:string)=>providers[provider]??provider;
const retentionName=(retention:string)=>retention==='until_user_deletes'?'직접 삭제할 때까지':retention;
/** The displayed notice and the transmitted snapshot describe every declared processing purpose. */
export function setupPolicyDescription(policy:SetupPolicy){
 const primary=`${policy.external_processing?'현장·업무 정리: '+providerName(policy.provider):'외부 AI 전송 없이 처리'} · 처리 위치: ${policy.processing_location} · 저장 위치: ${policy.storage_location} · 보존: ${retentionName(policy.retention)}`;
 return [primary,...(policy.processors??[]).map(p=>`긴 녹음 전사: ${providerName(p.provider)} · 처리 위치: ${p.processing_location} · 저장 위치: ${p.storage_location} · 보존: ${retentionName(p.retention)}`)].join('. ');
}
const types:Record<string,string>={pdf:'application/pdf',txt:'text/plain',csv:'text/csv',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',hwpx:'application/hwp+zip',hwp:'application/x-hwp',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac',aac:'audio/aac',amr:'audio/amr', '3gp':'audio/3gpp'};
export function setupFileIssue(file:Pick<File,'name'|'size'>){return file.size===0?'빈 파일':file.size>209715200?'200 MiB 초과':!types[file.name.split('.').pop()?.toLowerCase()??'']?'지원하지 않는 형식':null;}
export type SelectedUpload={file:File;id:string;prepareKey:string;completeKey:string;hash?:string;ingestion?:string;uploaded?:boolean;done?:boolean;error?:string;terminal?:boolean;restart?:boolean;abandonKey?:string};
export function selectedUploads(files:File[]):SelectedUpload[]{return files.map(file=>({file,id:workId(),prepareKey:workId(),completeKey:workId()}));}
const hex=(value:ArrayBuffer)=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
/** One file at a time. Never sends local paths or credentials to storage. */
export function setupUploader(client:WorkClient,project:string,policy:SetupPolicy,external:boolean,archive=false){
 const policySnapshot=structuredClone(policy);
 const keys={device:workId(),manual_share:workId(),call_recording:workId(),manual_shareBinding:workId(),call_recordingBinding:workId()};
 let device:{id:string}|undefined,jwk:JsonWebKey|undefined,hmac:CryptoKey|undefined;
 const sources=new Map<string,{id:string;generation:number;fingerprint:string;bound:boolean}>();
 const fingerprints=new Map<string,string>();
 const call=<T,>(action:string,key:string,body:unknown,id?:string)=>client.request<T>({route:'setup.capture',command:JSON.stringify({action,key,body,...id?{id}:{}})});
 return async (items:SelectedUpload[],signal:AbortSignal,onChange:()=>void)=>{
  const check=()=>{if(signal.aborted)throw new Error('전송을 멈췄어요. 같은 자료로 다시 시작할 수 있어요.');};
  check();
  if(!jwk){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);}
  check();if(!device)device=await call('device',keys.device,{platform:'web',app_version:'site-setup-v1',public_key_jwk:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}});
  for(const item of items){
   check();if(item.done||item.terminal||setupFileIssue(item.file))continue;delete item.error;onChange();
   try{
    const mime=types[item.file.name.split('.').pop()!.toLowerCase()]!,kind=mime.startsWith('audio/')?'call_recording':'manual_share';
    if(!hmac)hmac=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
    if(!fingerprints.has(kind))fingerprints.set(kind,hex(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(project+':'+kind+':'+items.map(x=>x.id).join(',')))));
    let source=sources.get(kind);
    if(!source){const fingerprint=fingerprints.get(kind)!;const created=await call<{id:string;generation:number}>('source',keys[kind],{device_id:device!.id,kind,scope_fingerprint:fingerprint,consent_version:2,local_selection_consent:true,server_upload_consent:true,external_ai_consent:external&&policySnapshot.external_processing,processing_policy:policySnapshot,scope:{processing_lane:archive?'archive':'current',capture_method:'manual_share',history_mode:'selected',history_since:null,scope_mode:'selected_items',rule_version:1,processing_policy_id:policySnapshot.id,fingerprint_algorithm:'hmac-sha256-device-v1'}});source={...created,fingerprint,bound:false};sources.set(kind,source);}
    check();if(!source.bound){await call('binding',keys[kind==='manual_share'?'manual_shareBinding':'call_recordingBinding'],{source_id:source.id,source_generation:source.generation,scope_fingerprint:source.fingerprint,scope_mode:'project',project_id:project,display_name:'웹에서 보낸 자료 · 자동 감시 없음'});source.bound=true;}
    if(!item.hash)item.hash=hex(await crypto.subtle.digest('SHA-256',await item.file.arrayBuffer()));
    check();
    if(item.restart&&item.ingestion){
     item.abandonKey??=workId();
     await call('abandon',item.abandonKey,{sha256:item.hash,byte_length:item.file.size},item.ingestion);
     item.id=workId();item.prepareKey=workId();item.completeKey=workId();delete item.ingestion;delete item.uploaded;delete item.restart;delete item.abandonKey;
    }
    const prepared=await call<{ingestion_id:string;upload_url:string}>('prepare',item.prepareKey,{client_capture_id:item.id,sha256:item.hash,byte_length:item.file.size,declared_mime:mime,source_id:source.id,source_generation:source.generation});item.ingestion=prepared.ingestion_id;
    if(!item.uploaded){
     const url=new URL(prepared.upload_url);if(url.protocol!=='https:'||!url.pathname.startsWith('/storage/v1/object/upload/sign/')||!url.searchParams.has('token'))throw new Error('보관 연결을 다시 확인해 주세요.');
     const response=await fetch(url,{method:'PUT',body:item.file,headers:{'Content-Type':mime,'x-upsert':'false'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal});
     // A previous PUT can have succeeded before the browser lost its response.
     // The complete endpoint proves the existing object's length and digest.
     if(!response.ok&&response.status!==409){const body=await response.json().catch(()=>null) as {error?:string;statusCode?:string}|null;if(body?.error!=='Duplicate'&&body?.statusCode!=='409'){if(response.status>=400&&response.status<500)item.restart=true;throw new Error('전송 연결을 갱신해야 해요. 다시 보내기를 눌러 주세요.');}}
     item.uploaded=true;
    }
    check();await call('complete',item.completeKey,{sha256:item.hash,byte_length:item.file.size},item.ingestion);item.done=true;
   }catch(e){if(signal.aborted||['account_changed','login_required','ACCOUNT_CHANGED'].includes((e as {code?:string}).code??''))throw e;const code=(e as {code?:string}).code;
     if(code&&!['connection_wait','TEMPORARILY_UNAVAILABLE','RATE_LIMITED'].includes(code)){
      item.terminal=true;item.error=['SOURCE_EXPIRED','SOURCE_SCOPE_MISMATCH'].includes(code)?'연결 범위나 동의가 바뀌었어요. 자료를 다시 선택하고 현재 조건을 확인해 주세요.':'서버가 이 자료를 받지 못했어요. 원본과 연결 조건을 확인한 뒤 자료를 다시 선택해 주세요.';
     }else item.error=item.restart?'전송 주소가 만료되었거나 거부됐어요. 다시 보내면 새 주소로 연결해요.':'전송을 확인하지 못했어요. 연결을 확인한 뒤 다시 보내 주세요.';}
   onChange();
  }
 };
}
