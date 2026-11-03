import {useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import {canonicalReadInput} from '@sigongnote/domain/read-input';
type Scope='search'|'tool_selection';
type Tool='search_evidence'|'resolve_entities'|'list_exceptions'|'get_artifact';
type Score={samples:number;groups:number;errors:number;improvement:number;passed:boolean};
export type StrategyReport={heads:{scope:Scope;active_id:string|null;previous_id:string|null;version:number;delegated:boolean}[];usage:{calls:number;limit:number};contexts:{id:string;project_id:string;label:string;project_name:string}[];runs:{id:string;instruction:string;project_id:string|null;sequence:number;tool:Tool;input:{query?:string;context_id?:string|null;[key:string]:unknown}}[];cases:{id:string;scope:Scope;instruction:string;baseline:{tool:Tool;query:string};expected:{tool:Tool;query:string};state:string}[];versions:{id:string;scope:Scope;state:string;spec:null|{rules:{from:string;to:string;instruction?:string}[]};metrics:{test?:Score|null;shadow?:Score|null};invalid_reason:string|null}[]};
const names:Record<Tool,string>={search_evidence:'자료 찾기',resolve_entities:'현장·업체·업무 찾기',list_exceptions:'확인할 일 보기',get_artifact:'발행 문서 찾기'};
const states:Record<string,string>={evaluating:'고정 사례 비교 중',awaiting_shadow:'이후 별도 업무 확인 대기',proposed:'사용 검토 가능',active:'사용 중',superseded:'이전 통과판',rejected:'평가 기준 미달',rolled_back:'사용 중단'};
export function WorkStrategies({client,report,reload}:{client:WorkClient;report:StrategyReport;reload:()=>Promise<void>}){
 const [scope,setScope]=useState<Scope>('search'),[runKey,setRunKey]=useState(''),[context,setContext]=useState(''),[query,setQuery]=useState(''),[tool,setTool]=useState<Tool>('search_evidence');
 const [sources,setSources]=useState<{revision_id:string;title:string;excerpt:string}[]>([]),[selectedSources,setSelectedSources]=useState<string[]>([]),[selectedCases,setSelectedCases]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState<{action:'strategy.promote'|'strategy.rollback'|'strategy.delegation';id?:string}|null>(null);
 const running=useRef(false),retry=useRef<{key:string;id:string}|null>(null),alive=useRef(true),epoch=useRef(0);const head=report.heads.find(h=>h.scope===scope)!;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 useEffect(()=>{setConfirm(null);setSelectedCases(old=>old.filter(id=>report.cases.some(c=>c.id===id&&c.scope===scope)));},[report,scope]);
 const runs=report.runs.filter(r=>scope==='search'?r.tool==='search_evidence':!!canonicalReadInput(r.tool,r.input,r.project_id)),run=runs.find(r=>r.id+':'+r.sequence===runKey);
 const resetSources=()=>{epoch.current++;setSources([]);setSelectedSources([]);setConfirmed(false);};
 async function send(payload:Record<string,unknown>){if(running.current)return;running.current=true;setBusy(true);setError('');setNotice('');const key=JSON.stringify(payload);if(retry.current?.key!==key)retry.current={key,id:workId()};
  try{const result=await client.request<{saved:boolean}>({route:'improvements.command',command:JSON.stringify({...payload,command_id:retry.current.id})});if(!alive.current)return;retry.current=null;setConfirm(null);setSelectedCases([]);setConfirmed(false);setNotice(result.saved?'저장했어요. 업무 기록과 금액은 바뀌지 않았어요.':'평가 또는 비교 한도를 충족하지 못했어요. 현재 결과를 확인해 주세요.');await reload();}
  catch(e){if(!alive.current)return;const code=(e as {code?:string}).code;if(['VERSION_CONFLICT','DOMAIN_INVARIANT','INVALID_CONTRACT','NOT_FOUND'].includes(code??''))retry.current=null;setConfirm(null);setError(code==='VERSION_CONFLICT'?'사용판이 바뀌었어요. 다시 확인하고 선택해 주세요.':code==='NOT_FOUND'?'원문·요청·동의 또는 처리 범위를 다시 확인해 주세요.':code==='DOMAIN_INVARIANT'?'같은 업무·원문이 겹치거나 평가 기준을 충족하지 못했어요.':code==='INVALID_CONTRACT'?'선택한 도구와 검색어를 다시 확인해 주세요.':'저장 결과를 확인하지 못했어요. 같은 내용을 다시 저장하면 중복 처리하지 않아요.');await reload();}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 async function preview(){if(running.current||!run||!query.trim())return;running.current=true;setBusy(true);setError('');const version=++epoch.current;setSources([]);setSelectedSources([]);setConfirmed(false);
  try{const result=await client.request<{cards:typeof sources}>({route:'improvements.command',command:JSON.stringify({action:'strategy.preview',command_id:workId(),query:query.trim(),run_id:run.id,sequence:run.sequence,scope})});if(alive.current&&version===epoch.current){setSources(result.cards);if(scope==='search')setSelectedSources([...new Set(result.cards.map(c=>c.revision_id))]);}}
  catch{if(alive.current&&version===epoch.current)setError('자료를 확인하지 못했어요. 연결·접근 권한을 확인해 주세요.');}finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const cases=report.cases.filter(c=>c.scope===scope),versions=report.versions.filter(v=>v.scope===scope);
 return <section className="work-strategies stack" aria-label="검색과 조회 도구 개선" data-activity-ignore="true">
  <h2>검색과 조회 도구 개선</h2><p>직접 확인한 사례로 자료 찾기와 조회 도구 선택을 비교합니다. 금액·승인·발송 권한과 검색 범위는 바꾸지 않아요.</p>
  <p>서로 다른 업무·원문으로 고정 평가를 하고, 개선안이 만들어진 뒤의 별도 업무 확인까지 오류 0건이어야 사용할 수 있어요. 실제 업무 전반의 정확도는 별도 확인이 필요합니다.</p>
  <div>{(['search','tool_selection'] as const).map(s=><button className="button-quiet" key={s} type="button" disabled={busy} aria-pressed={scope===s} onClick={()=>{setScope(s);setRunKey('');setContext('');setQuery('');resetSources();}}>{s==='search'?'검색 결과':'조회 도구 선택'}</button>)}</div>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <p>오늘 두 유형의 규칙 비교 {report.usage.calls} / {report.usage.limit}건 · 유료 모델 호출 없음</p>
  <details><summary>실제 요청을 확인 사례로 남기기</summary>
   <label className="field">확인한 요청<select disabled={busy} value={runKey} onChange={e=>{const found=runs.find(r=>r.id+':'+r.sequence===e.target.value);setRunKey(e.target.value);setContext(found?.input.context_id??'');setQuery(found?.input.query??'');setTool(found?.tool??'search_evidence');resetSources();}}><option value="">요청 선택</option>{runs.map(r=><option key={r.id+':'+r.sequence} value={r.id+':'+r.sequence}>{r.instruction.slice(0,100)} · {names[r.tool]} {r.sequence}</option>)}</select></label>
   {!runs.length&&<p>아직 비교할 실제 조회 요청이 없어요. 업무 화면에서 자료나 문서를 찾은 뒤 돌아와 주세요.</p>}
   {run&&<><p>현재 선택: {names[run.tool]}{run.input.query?' · '+run.input.query:''}</p>
    <label className="field">어느 업무의 사례인가요<select disabled={busy} value={context} onChange={e=>{setContext(e.target.value);setConfirmed(false);}}><option value="">업무 선택</option>{report.contexts.filter(c=>(!run.project_id||c.project_id===run.project_id)&&(!run.input.context_id||c.id===run.input.context_id)).map(c=><option key={c.id} value={c.id}>{c.project_name} · {c.label}</option>)}</select></label>
    {scope==='tool_selection'&&<label className="field">이 요청에서 사용할 조회<select disabled={busy} value={tool} onChange={e=>{setTool(e.target.value as Tool);setConfirmed(false);}}>{Object.entries(names).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>}
    <label className="field">{scope==='search'?'올바른 자료를 찾은 검색어':'판단 근거를 확인할 자료 검색어'}<input disabled={busy} value={query} maxLength={500} onChange={e=>{setQuery(e.target.value);resetSources();}}/></label>
    <button className="button-quiet" type="button" disabled={busy||!query.trim()} onClick={()=>void preview()}>원문 근거 찾아보기</button>
    {scope==='search'&&sources.length>0&&<p>찾은 결과 전체를 정답으로 비교합니다. 다른 자료가 섞였다면 검색어를 고쳐 다시 찾아주세요.</p>}
    <ul className="row-list">{sources.map(c=><li key={c.revision_id}><label><input type="checkbox" disabled={busy||scope==='search'} checked={selectedSources.includes(c.revision_id)} onChange={e=>{setSelectedSources(old=>e.target.checked?[...old,c.revision_id]:old.filter(id=>id!==c.revision_id));setConfirmed(false);}}/>{c.title}</label><p>{c.excerpt}</p></li>)}</ul>
    <label><input type="checkbox" checked={confirmed} disabled={busy||!selectedSources.length} onChange={e=>setConfirmed(e.target.checked)}/>요청과 원문을 확인했고, 선택한 결과가 맞습니다.</label>
    <button className="button-quiet" type="button" disabled={busy||!context||!confirmed||!selectedSources.length} onClick={()=>void send({action:'strategy.case',scope,run_id:run.id,sequence:run.sequence,context_id:context,expected:{tool:scope==='search'?'search_evidence':tool,query:scope==='search'?query.trim():tool==='search_evidence'||tool==='resolve_entities'?run.input.query??'':''},evidence_refs:selectedSources,confirmed:true})}>확인 사례로 저장</button>
   </>}
  </details>
  <h3>고정 비교에 사용할 사례</h3><ul>{cases.map(c=><li key={c.id}><label><input type="checkbox" disabled={busy} checked={selectedCases.includes(c.id)} onChange={e=>setSelectedCases(old=>e.target.checked?[...old,c.id]:old.filter(id=>id!==c.id))}/>{c.instruction} · {scope==='search'?c.baseline.query+' → '+c.expected.query:names[c.baseline.tool]+' → '+names[c.expected.tool]}</label><button className="button-quiet" type="button" disabled={busy} onClick={()=>void send({action:'strategy.delete',id:c.id})}>이 확인 사례 삭제</button></li>)}</ul>
  {!cases.length&&<p>직접 확인한 사례가 아직 없어요. 판단 기록에서 개선 목적 동의 후 확인 사례를 남길 수 있습니다.</p>}
  <button className="button-quiet" type="button" disabled={busy||selectedCases.length<2} onClick={()=>void send({action:'strategy.dataset',scope,case_ids:[...selectedCases].sort()})}>선택 사례로 평가 고정</button>
  <button className="button-quiet" type="button" disabled={busy} onClick={()=>void send({action:'strategy.evaluate'})}>이후 별도 업무와 비교</button>
  <h3>사용판</h3><p>{head.active_id?'평가 통과판 사용 중':'기본판 사용 중'} · 자동 승격 {head.delegated?'위임함':'위임하지 않음'}</p>
  <button className="button-quiet" type="button" disabled={busy} onClick={()=>head.delegated?void send({action:'strategy.delegation',scope,head_version:head.version,allowed:false}):setConfirm({action:'strategy.delegation'})}>{head.delegated?'자동 승격 위임 끄기':'이 범위의 자동 승격 위임'}</button>
  <button className="button-quiet" type="button" disabled={busy||!head.active_id} onClick={()=>setConfirm({action:'strategy.rollback'})}>이전 통과판으로 복귀</button>
  {versions.map(v=><article className="card" key={v.id}><h3>{states[v.state]??'상태 확인 필요'}</h3>{v.spec?.rules.map(r=><p key={JSON.stringify([r.instruction,r.from,r.to])}>{r.instruction?`${r.instruction} · ${names[r.from as Tool]} → ${names[r.to as Tool]}`:`${r.from} → ${r.to}`}</p>)}{(['test','shadow'] as const).map(phase=>{const score=v.metrics[phase];return <p key={phase}>{phase==='test'?'고정 평가':'이후 별도 업무'}: {score?`${score.groups}개 업무 · 오류 ${score.errors}건 · ${score.passed?'통과':'확인 대기'}`:'아직 비교하지 못했어요'}</p>;})}{v.invalid_reason&&<p>중단 이유: {v.invalid_reason==='experiment_budget'?'비교 한도 도달':v.invalid_reason==='evaluation_failed'?'평가 기준 미달':v.invalid_reason==='owner_rollback'?'관리자 복귀 선택':'근거·동의 또는 확인된 오류 변경'}</p>}{v.state==='proposed'&&<button className="button-quiet" type="button" disabled={busy} onClick={()=>setConfirm({action:'strategy.promote',id:v.id})}>이 개선안 사용 검토</button>}</article>)}
  {confirm&&<fieldset className="card"><legend>사용 기준 변경 확인</legend><p>{confirm.action==='strategy.rollback'?'유효한 이전 통과판이 없으면 기본판으로 돌아갑니다.':confirm.action==='strategy.delegation'?'이 유형의 고정 평가·이후 업무 비교를 통과한 개선안만 자동 승격합니다. 두 유형 합계 하루 규칙 비교 100건, 유료 모델 호출 없음으로 제한합니다.':'앞으로 시작하는 요청에 이 개선판을 적용합니다. 진행 중인 요청은 시작할 때의 판을 유지하며, 철회나 오류가 확인되면 중단합니다.'}</p><button className="button-quiet" type="button" disabled={busy} onClick={()=>void send({...confirm,scope,head_version:head.version,...(confirm.action==='strategy.delegation'?{allowed:true}:{})})}>확인하고 적용</button><button className="button-quiet" type="button" disabled={busy} onClick={()=>setConfirm(null)}>취소</button></fieldset>}
 </section>;
}
