import {useEffect,useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import {workId} from './work-id.js';
import {Notice} from './work-shell.js';
import {setupPolicyDescription,type SetupPolicy} from './work-setup-upload.js';
import {canonicalCapturePolicy} from '@sigongnote/contracts';

export function WorkAiConsent({client,context,onChanged,settings=false}:{client:WorkClient;context:WorkContext;onChanged:()=>void;settings?:boolean}){
 const [state,setState]=useState(context.ai_consent),[busy,setBusy]=useState(false),[error,setError]=useState(''),[policy,setPolicy]=useState<SetupPolicy|null>(null);
 const pending=useRef<{allowed:boolean;version:number;command:string;policy?:SetupPolicy}|null>(null);
 const contextPolicy=canonicalCapturePolicy(context.ai_consent?.processing_policy);
 useEffect(()=>setState(context.ai_consent),[context.ai_consent]);
 useEffect(()=>{let alive=true;setPolicy(null);pending.current=null;if(context.ai_consent&&(client.kind!=='local'||context.cloud_connected)){if(contextPolicy)setPolicy(JSON.parse(contextPolicy) as SetupPolicy);else void client.request<{policy:SetupPolicy|null}>({route:'setup.read'}).then(r=>{if(alive)setPolicy(r.policy);},()=>{if(alive)setError('현재 자료 처리 조건을 확인하지 못했어요. 다시 열어 주세요.');});}return()=>{alive=false;};},[client,context.user_id,context.tenant_id,context.cloud_connected,contextPolicy,!!context.ai_consent]);
 if(!state||(client.kind==='local'&&!context.cloud_connected))return null;
 const allowed=state.allowed&&state.policy_current;
 if(allowed&&!settings)return null;
 async function decide(next=!allowed){if(!state||busy||(next&&!policy))return;setBusy(true);setError('');if(pending.current?.allowed!==next||pending.current?.version!==state.version)pending.current={allowed:next,version:state.version,command:workId(),...(next&&policy?{policy:structuredClone(policy)}:{})};try{const value=await client.request<NonNullable<WorkContext['ai_consent']>>({route:'ai.consent',allowed:next,expected_version:state.version,client_command_id:pending.current.command,...pending.current.policy?{processing_policy:pending.current.policy}:{}});setState(value);pending.current=null;onChanged();window.dispatchEvent(new Event('work-events-changed'));}catch(e){const code=(e as {code?:string}).code;if(code==='VERSION_CONFLICT'){pending.current=null;onChanged();setError('동의 상태가 바뀌었어요. 최신 상태에서 다시 선택해 주세요.');}else if(code==='SOURCE_EXPIRED'){pending.current=null;setPolicy(null);try{const current=await client.request<{policy:SetupPolicy|null}>({route:'setup.read'});setPolicy(current.policy);}catch{/* A failed refresh cannot authorize the old policy. */}onChanged();setError('자료 처리 조건이 바뀌었어요. 현재 조건을 읽고 다시 선택해 주세요.');}else setError('동의 상태를 저장하지 못했어요. 다시 눌러 주세요.');}finally{setBusy(false);}}
 return <section className="today-section ai-consent" aria-label="자료 AI 정리"><h2>이 회사 자료 AI 정리{allowed?' · 켜짐':''}</h2><p className="muted">이 회사에서 내가 연결한 연락·자료를 다음 조건으로 정리합니다. {policy?setupPolicyDescription(policy)+'.':'현재 처리 조건을 확인하고 있어요.'} 설정에서 언제든 철회할 수 있어요.</p>{error?<Notice tone="warn" role="alert">{error}</Notice>:null}<button type="button" className={allowed?'button-secondary':'button-primary'} disabled={busy||(!allowed&&!policy)} onClick={()=>void decide()}>{busy?'저장 중…':allowed?'AI 정리 허용 철회':'자료 AI 정리 허용'}</button>{state.allowed&&!state.policy_current?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void decide(false)}>AI 정리 허용 철회</button>:null}</section>;
}
