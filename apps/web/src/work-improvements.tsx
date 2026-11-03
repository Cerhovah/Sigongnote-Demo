import {useCallback,useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import {WorkStrategies,type StrategyReport} from './work-strategies.js';
type Criteria={version:'work-eval-v1';min_test_groups:number;min_shadow_groups:number;max_errors:0;max_protected_changes:0;max_high_confidence_errors:0;min_improvement:number};
type Delegation={allowed:boolean;scope:'quality_interpretation';criteria_version:'work-eval-v1';max_calls:number;max_cost_minor:number};
type Score={samples:number;groups:number;errors:number;high_confidence_errors:string[];protected_changes:string[];passed:boolean;improvement:number};
type Version={id:string;state:string;spec:{rules:{from:string;to:string}[]};metrics:{test?:Score;shadow?:Score};invalid_reason:string|null};
type Report={strategies?:StrategyReport;criteria:Criteria;head:{version:number;active_id:string|null;previous_id:string|null;delegation:Delegation};versions:Version[];usage:{calls:number;cost:number;known_cost:number;unknown:number}};
type Case={id:string;state:string;prompt:string};
type Cases={cases:Case[];next_cursor:string|null};
const states:Record<string,string>={evaluating:'고정 표본 비교 중',awaiting_shadow:'이후 별도 업무의 확인 기다림',proposed:'승격 검토 가능',active:'사용 중',superseded:'이전 통과판',rejected:'기준 미달',rolled_back:'사용 중단'};
function Scores({name,score}:{name:string;score:Score|undefined}){return <div><p>{name}: {!score||score.samples===0?'확인 표본 없음 · 통과 아님':`${score.samples}건 / 독립 업무 ${score.groups}개 · 오류 ${score.errors}건 · 확신 높은 오류 ${score.high_confidence_errors.length}건 · 권한 범위 변경 ${score.protected_changes.length}건 · ${score.passed?'기준 통과':'기준 미달 또는 표본 대기'}`}</p>{score?.high_confidence_errors?.map((id,index)=><p key={id}><a href={'#/more/learning/'+id}>확신 높은 오류 사례 {index+1} 확인</a></p>)}</div>;}

export function WorkImprovements({client,strategiesOnly=false}:{client:WorkClient;strategiesOnly?:boolean}){
 const [report,setReport]=useState<Report|null>(null),[cases,setCases]=useState<Cases|null>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [confirm,setConfirm]=useState<{action:'promote';id:string}|{action:'delegation'}|{action:'rollback'}|null>(null);
 const epoch=useRef(0),alive=useRef(true),mutating=useRef(false),knownHead=useRef<number|null>(null),retry=useRef<{key:string;id:string}|null>(null);
 const load=useCallback(async(cursor?:string)=>{
  const generation=++epoch.current;setBusy(true);setError('');
  try{const [r,c]=await Promise.all([client.request<Report>({route:'improvements.list'}),client.request<Cases>({route:'learning.list',...(cursor?{cursor}:{})})]);
   if(generation!==epoch.current)return;setReport(r);setCases(old=>cursor&&old?{...c,cases:[...old.cases,...c.cases.filter(x=>!old.cases.some(y=>y.id===x.id))]}:c);if(!cursor)setSelected(old=>old.filter(id=>c.cases.some(x=>x.id===id&&(x.state==='confirmed'||x.state==='correction'))));if(knownHead.current!==r.head.version)setConfirm(null);knownHead.current=r.head.version;
  }catch{if(generation===epoch.current){setReport(null);setCases(null);setSelected([]);setConfirm(null);setError('권한·동의 또는 연결을 확인하지 못해 개선 기록을 가렸어요. 다시 확인해 주세요.');}}
  finally{if(generation===epoch.current)setBusy(false);}
 },[client]);
 useEffect(()=>{alive.current=true;void load();const refresh=()=>{if(document.visibilityState==='hidden'){epoch.current++;setReport(null);setCases(null);setSelected([]);setConfirm(null);}else if(!mutating.current)void load();};
  const timer=setInterval(()=>{if(document.visibilityState!=='hidden'&&!mutating.current)void load();},30000);document.addEventListener('visibilitychange',refresh);
  return()=>{alive.current=false;epoch.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[load]);
 async function send(payload:Record<string,unknown>){
  if(mutating.current)return;mutating.current=true;epoch.current++;setBusy(true);setError('');setNotice('');const key=JSON.stringify(payload);if(retry.current?.key!==key)retry.current={key,id:workId()};
  try{await client.request({route:'improvements.command',command:JSON.stringify({...payload,command_id:retry.current.id})});if(!alive.current)return;retry.current=null;setConfirm(null);setSelected([]);setNotice('저장했어요. 기존 업무 기록과 금액은 바뀌지 않았어요.');await load();}
  catch(e){if(!alive.current)return;const code=(e as {code?:string}).code;setConfirm(null);setReport(null);setCases(null);if(['VERSION_CONFLICT','DOMAIN_INVARIANT','INVALID_CONTRACT'].includes(code??''))retry.current=null;
   if(code==='VERSION_CONFLICT'){setNotice('사용판이나 위임 설정이 바뀌어 최신 기록을 가져왔어요. 다시 선택해 주세요.');await load();return;}
   setError(code==='VERSION_CONFLICT'?'사용판이나 위임 설정이 바뀌었어요. 다시 확인하고 선택해 주세요.':code==='DOMAIN_INVARIANT'?'독립 업무 수·근거 권한·평가 결과 또는 실험 한도를 충족하지 못했어요. 사례와 기준을 다시 확인해 주세요.':code==='INVALID_CONTRACT'?'입력 내용을 저장할 수 없어요. 다시 확인하고 선택을 고쳐 주세요.':'저장 결과를 확인하지 못했어요. 다시 확인한 뒤 같은 내용을 보내면 중복 처리하지 않아요.');
  }finally{mutating.current=false;if(alive.current)setBusy(false);}
 }
 if(strategiesOnly)return <section data-activity-ignore="true">{error&&<p role="alert">{error}</p>}<button type="button" disabled={busy} onClick={()=>void load()}>개선 기록 다시 확인</button>{report?.strategies&&<WorkStrategies client={client} report={report.strategies} reload={()=>load()}/>}</section>;
 const eligible=cases?.cases.filter(c=>c.state==='confirmed'||c.state==='correction')??[];
 return <section data-activity-ignore="true" aria-label="관리자 개선안 비교">
  <p>담당자가 확인한 보완 조치 문구를 비교합니다. 원문에 적힌 표현만 제안하며 금액·수신처·자동 처리 권한은 확대하지 않아요. 아직 실제 업무 전반의 정확도를 뜻하지 않습니다.</p>
  <p>같은 업무와 같은 원문은 한쪽 묶음에만 둡니다. 고정 평가와 이후 별도 업무 확인을 통과한 개선안만 사용합니다. 원문 철회나 확인된 오류가 생기면 사용을 중단하고 이전 통과판으로 돌아갑니다.</p>
  <p>현재 실험은 회사 안의 규칙 비교입니다. 로컬 모델은 그림자 비교 연결 규격만 준비됐으며 유료 모델은 연결하지 않았어요.</p>
  <a href="#/more/learning">판단 사례 확인·분류로 이동</a>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button type="button" disabled={busy} onClick={()=>void load()}>개선 기록 다시 확인</button>
  {report&&<>
   {report.strategies&&<a href="#/more/improvements/strategies">검색·조회 도구 개선으로 이동</a>}
   <h2>보완 문구를 비교할 사례</h2><p>맞음·오류로 직접 확인한 사례만 고를 수 있어요. 서로 다른 업무 2개 이상이 필요합니다. 기준 변경은 새 평가 묶음으로 보관합니다.</p>
   <p>고정 기준: 비교 업무 {report.criteria.min_test_groups}개 이상, 이후 업무 {report.criteria.min_shadow_groups}개 이상, 오류·권한 확대·확신 높은 오류 모두 0건, 기존보다 개선 {report.criteria.min_improvement}건 이상.</p>
   {!eligible.length&&<p>확인된 사례가 아직 없어요. 미분류나 이후 새 사실은 정답으로 사용하지 않습니다.</p>}
   <ul className="row-list">{eligible.map(c=><li key={c.id}><label><input type="checkbox" checked={selected.includes(c.id)} disabled={busy||(!selected.includes(c.id)&&selected.length>=50)} onChange={e=>setSelected(old=>e.target.checked?[...old,c.id]:old.filter(id=>id!==c.id))}/>{c.prompt} · {c.state==='correction'?'당시 제안 오류':'당시 판단 맞음'}</label></li>)}</ul>
   {cases?.next_cursor&&<button type="button" disabled={busy} onClick={()=>void load(cases.next_cursor!)}>이전 사례 더 보기</button>}
   <button type="button" disabled={busy||selected.length<2} onClick={()=>void send({action:'dataset',case_ids:[...selected].sort(),criteria:report.criteria})}>선택 {selected.length}건으로 평가 묶음 고정</button>
   <button type="button" disabled={busy} onClick={()=>void send({action:'evaluate'})}>이후 확인 사례와 비교</button>
   <h2>사용판과 위임</h2><p>{report.head.active_id?'평가를 통과한 개선판 사용 중':'기본 해석판 사용 중'} · 자동 승격 위임 {report.head.delegation.allowed?'켜짐':'꺼짐'}</p>
   <p>하루 비교 한도 {report.head.delegation.max_calls}건 · 오늘 {report.usage.calls}건, 비용 {report.usage.unknown?'미확정 포함':'확정'} · 확정분 {report.usage.known_cost.toLocaleString('ko-KR')}원, 결과·비용 미확정 {report.usage.unknown}건 (한도 계산액 {report.usage.cost.toLocaleString('ko-KR')}원). 실험 예산은 업무 처리 예산과 별도입니다.</p>
   <button type="button" disabled={busy} onClick={()=>report.head.delegation.allowed?void send({action:'delegation',head_version:report.head.version,delegation:{...report.head.delegation,allowed:false}}):setConfirm({action:'delegation'})}>{report.head.delegation.allowed?'자동 승격 위임 끄기':'기본 기준 안에서 자동 승격 위임'}</button>
   <button type="button" disabled={busy||!report.head.active_id} onClick={()=>setConfirm({action:'rollback'})}>이전 통과판으로 복귀</button>
   <h2>개선안</h2>{!report.versions.length&&<p>아직 제안된 개선안이 없어요. 원문에 정답 문구가 있고 고칠 표현이 일치하는 교정 사례가 필요합니다.</p>}
   {report.versions.map(v=><article key={v.id}><h3>{states[v.state]??'상태 확인 필요'}</h3><ul>{v.spec.rules.map(r=><li key={r.from}>{r.from} → {r.to} <small>(원문에 있을 때만)</small></li>)}</ul><Scores name="고정 평가" score={v.metrics.test}/><Scores name="이후 별도 업무" score={v.metrics.shadow}/>
    {v.invalid_reason&&<p>중단 사유: {v.invalid_reason==='experiment_budget'?'실험 한도 도달':v.invalid_reason==='evaluation_failed'?'평가 기준 미달':v.invalid_reason==='important_error'?'확인된 판단 오류':v.invalid_reason==='owner_rollback'?'관리자 복귀 선택':'근거·사례 또는 사용 권한 변경'}</p>}
    {v.state==='proposed'&&<button type="button" disabled={busy} onClick={()=>setConfirm({action:'promote',id:v.id})}>이 개선안 사용 검토</button>}
   </article>)}
   {confirm&&<fieldset><legend>{confirm.action==='promote'?'개선안 사용 확인':confirm.action==='rollback'?'이전판 복귀 확인':'자동 승격 위임 확인'}</legend>
    <p>{confirm.action==='promote'?'앞으로 시작하는 작업에 이 해석판을 사용합니다. 진행 중인 작업은 시작할 때의 판을 유지해요.':confirm.action==='rollback'?'이전 통과판이 유효하지 않으면 기본 해석판으로 돌아갑니다. 이미 반영한 업무 기록은 그대로 보존해요.':'위의 기본 평가 기준과 보완 문구 범위 안에서만 승격합니다. 하루 규칙 비교 100건·유료 호출 0원으로 고정하며 사업 정책은 바꾸지 않아요.'}</p>
    <button type="button" disabled={busy} onClick={()=>void send(confirm.action==='delegation'?{action:'delegation',head_version:report.head.version,delegation:{allowed:true,scope:'quality_interpretation',criteria_version:'work-eval-v1',max_calls:100,max_cost_minor:0}}:confirm.action==='promote'?{...confirm,head_version:report.head.version}:{action:'rollback',head_version:report.head.version,reason:'관리자가 이전 통과판 복귀 선택'})}>확인하고 적용</button>
    <button type="button" disabled={busy} onClick={()=>setConfirm(null)}>취소</button>
   </fieldset>}
  </>}
 </section>;
}
