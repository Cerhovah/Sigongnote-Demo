import {ReadinessReportSchema} from '@sigongnote/contracts';
import {effectiveCaptureCapability} from './sms-activation.js';
import type {Tx} from './auth.js';
import {workerHealth} from './worker-health.js';
import {productAiConfig,agentConfiguration} from './product-ai-config.js';

type Source = {id:string;kind:string;active:boolean;device_active:boolean;server_upload_consent:boolean;
 reported_permission:string|null;permission:string;capability:string;last_successful_scan_at:Date|string|null;
 permission_checked_at:Date|string|null;last_error_code:string|null;pending_count:number;platform?:string};
type Capability = {id:string;label:string;state:'ready'|'needs_setup'|'needs_reconnect'|'waiting'|'unverified';
 reason:string;action:'none'|'connect_folder'|'restore_permission'|'configure_provider'|'check_worker';
 source_id:string|null;evidence:'server_observed'|'device_report'|'configuration_only'|'not_verified'};
const iso=(value:Date|string|null)=>value instanceof Date?value.toISOString():value;
export function buildReadiness(sources:Source[],env:NodeJS.ProcessEnv=process.env,now=new Date(),worker=workerHealth(env,now.getTime())) {
 const capabilities:Capability[]=[];
 const planner=agentConfiguration(env,now.getTime());
 const claude=planner.mode==='model'&&planner.config?.runtime==='claude-agent-sdk';
 capabilities.push({id:'agent_planner',label:'요청 이해',state:planner.mode==='model'?(claude?'ready':'unverified'):planner.mode==='blocked'?'needs_setup':'waiting',reason:planner.mode==='blocked'?'AI 연결 설정에 오류가 있어요. 기본 처리로 자동 전환하지 않고 연결 확인을 기다립니다.':planner.mode==='local'?'AI 연결이 꺼져 있거나 아직 없어 기본 자료 찾기를 사용해요.':claude?`Claude(${planner.config?.model})가 요청을 읽고 자료를 찾아 답해요. 새 문자·자료의 맥락 복원도 같은 연결로 처리해요.`:'AI 연결 설정이 있어요. 실제 요청 처리는 별도 확인이 필요해요.',action:claude?'none':'configure_provider',source_id:null,evidence:'configuration_only'});
 capabilities.unshift({id:'worker',label:'서버 자료 처리',state:worker.enabled?(worker.ready?(worker.state==='retry_wait'?'waiting':'ready'):'unverified'):'unverified',
  reason:worker.enabled?(worker.ready?'서버 처리기가 응답하고 있어요.':'서버 처리기 연결을 확인하고 있어요.'):'서버 처리기 상태를 아직 확인하지 못했어요.',
  action:worker.enabled&&worker.ready?'none':'check_worker',source_id:null,evidence:worker.enabled?'server_observed':'not_verified'});
 for(const [id,label,configured] of [
  ['semantic','자료 의미 이해',claude||(env.SEMANTIC_ENABLED===undefined||env.SEMANTIC_ENABLED==='true')&&Boolean(env.SEMANTIC_API_KEY&&env.SEMANTIC_MODEL)],
  ['ocr','사진·스캔 판독',Boolean(env.SIGONGNOTE_TESSERACT&&env.SIGONGNOTE_TESSDATA_DIR)],
  ['short_stt','짧은 음성 요청',env.SHORT_STT_ENABLED==='true'&&Boolean(env.SHORT_STT_API_KEY)],
  ['long_stt','녹음파일 판독',env.LONG_STT_CONFIGURED==='true'||env.LONG_STT_ENABLED==='true'&&Boolean(env.LONG_STT_PROVIDER==='openai'?env.LONG_STT_API_KEY&&env.LONG_STT_MODEL==='whisper-1'&&env.LONG_STT_PRICE_JSON:env.CLOVA_SPEECH_KEY&&env.CLOVA_SPEECH_INVOKE_URL)],
 ] as const){
  let invalidPrice=false;if(id==='semantic'&&configured){try{invalidPrice=!productAiConfig(env,now.getTime());}catch{invalidPrice=true;}}
  capabilities.push({id,label,state:configured&&!invalidPrice?'unverified':'needs_setup',reason:invalidPrice?'자료 처리 모델의 가격표와 연결 설정을 갱신해야 해요. 다른 자료 처리는 계속됩니다.':configured?'연결 설정이 있어요. 실제 자료 처리 확인이 필요해요.':'서비스 연결을 준비하고 있어요. 다른 자료는 계속 사용할 수 있어요.',action:'configure_provider',source_id:null,evidence:configured?'configuration_only':'not_verified'});
 }
 for(const source of sources){
  const stopped=!source.active,disconnected=!source.device_active;
  const revoked=['denied','revoked','role_missing'].includes(source.reported_permission??source.permission)||source.last_error_code==='PERMISSION_LOST';
  const setup=!source.server_upload_consent||source.capability==='policy_gated'||source.capability==='unsupported';
  const reportedAt=source.permission_checked_at?Date.parse(iso(source.permission_checked_at)!):NaN;
  const recent=Number.isFinite(reportedAt)&&now.getTime()-reportedAt>=0&&now.getTime()-reportedAt<86400000;
  const state=stopped||disconnected?'needs_setup':revoked?'needs_reconnect':setup?'needs_setup':!recent?'unverified':source.pending_count>0?'waiting':'ready';
  const device=source.platform==='android'?'휴대폰 · ':source.platform==='windows'?'PC · ':'';
  const label=source.kind==='call_recording'?'녹음 위치':source.kind==='sms'?'문자 연결':source.kind==='photos'?'사진 위치':'업무 자료 위치';
  capabilities.push({id:`source:${source.id}`,label:device+label,state,
   reason:stopped?'이 연결은 중지했어요. 다시 쓰려면 폴더를 다시 연결해 주세요.':disconnected?'이 기기 연결이 끊겼어요. 기기에서 다시 로그인해 주세요.':revoked?'이 기기에서 권한을 다시 연결해 주세요. 다른 연결은 계속 처리합니다.':setup?'이 연결의 전송 동의 또는 지원 조건을 확인해 주세요.':!recent?'기기의 최근 권한 상태를 확인하지 못했어요.':source.pending_count>0?'기기에 전송할 자료가 남아 있어요.':'기기가 자료 접근 권한을 보고했어요. 전체 판독 완료와는 다릅니다.',
   action:stopped?'connect_folder':disconnected?'none':revoked?'restore_permission':setup?'connect_folder':'none',source_id:source.id,evidence:recent?'device_report':'not_verified'});
 }
 if(!sources.length)capabilities.push({id:'folders',label:'업무 폴더',state:'needs_setup',reason:'업무 폴더를 한 번 연결하면 새 자료를 계속 읽습니다.',action:'connect_folder',source_id:null,evidence:'not_verified'});
 const dates=sources.map(s=>iso(s.last_successful_scan_at)).filter((s):s is string=>Boolean(s)).sort();
 return ReadinessReportSchema.parse({checked_at:now.toISOString(),capabilities,
  coverage:{source_count:sources.length,reported_scanned_count:sources.filter(s=>s.last_successful_scan_at).length,last_scan_at:dates.at(-1)??null,full_content:'not_verified'},
  limits:{daily_krw:10000,monthly_krw:50000,source_bytes:'100000000000',scope:'per_user',budget_enforced:false},
  formats:[
   {label:'PDF·엑셀·한글·텍스트',extensions:['pdf','xls','xlsx','hwp','hwpx','txt','csv'],status:'parser_available'},
   {label:'사진',extensions:['jpg','jpeg','png','webp'],status:'provider_required'},
   {label:'녹음파일 · 전사 공급자 연결 필요',extensions:['wav','mp3','m4a'],status:'provider_required'},
   {label:'추가 Office·이미지·영상·압축',extensions:['doc','docx','ppt','pptx','tif','tiff','heic','heif','mp4','mov','avi','zip','7z','egg'],status:'discovery_only'},
   {label:'CAD',extensions:['dwg','dxf','dgn'],status:'excluded'},
  ]});
}
export async function readReadiness(tx:Tx,tenant:string,user:string){
 const sources=await tx<Source[]>`select s.*,d.active device_active,d.platform from app.capture_sources s join app.devices d
  on d.tenant_id=s.tenant_id and d.id=s.device_id where s.tenant_id=${tenant}::uuid and s.user_id=${user}::uuid
  order by s.created_at,s.id`;
 const readiness=buildReadiness(sources.map(s=>({...s,capability:effectiveCaptureCapability(s)})));
 const [installed]=await tx`select to_regprocedure('app.product_ai_summary()') is not null available`;
 if(installed?.available){
  const [row]=await tx`select app.product_ai_summary() value`;
  if(row?.value){const spent=row.value;readiness.limits.budget_enforced=true;
   readiness.capabilities.push({id:'product_budget',label:'자료·음성 처리 예산',state:BigInt(spent.daily_krw)>=10000n||BigInt(spent.monthly_krw)>=50000n?'waiting':'ready',
    reason:`내 계정의 전체 회사 합계 · 오늘 ${spent.daily_krw}원 / 1만원 · 이번 달 ${spent.monthly_krw}원 / 5만원. 처리 중 예약 포함, 결과 미확정 ${spent.unknown_count}건. 공급자 실제 청구액과 환율 차이가 있을 수 있어요.`,action:'none',source_id:null,evidence:'server_observed'});
  }
 }
 return readiness;
}
