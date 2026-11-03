import {useCallback,useEffect,useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import {workId} from './work-id.js';
import {Icon,icons,ListHead,Notice} from './work-shell.js';
import type {WorkEvent} from './work-tasks.js';

const kinds:Record<string,string>={request:'요청',change:'변경',problem:'문제',fact:'사실',agreement:'합의',correction:'정정',question:'질문',note:'기록'};
const statuses:Record<string,string>={open:'진행 중',resolved:'처리함',superseded:'후속 내용으로 바뀜',dismissed:'제외함'};
const missingLabel:Record<string,string>={site:'현장',quantity:'수량',date:'날짜',party:'거래처',item:'품목',price:'단가'};
export type EventSource={id:string;kind:string;text?:string|null;file_name?:string|null;source_version?:string|number;available:boolean;reason?:string};
export type EventDetail={event:WorkEvent;source:EventSource|null;evidence:EventSource[];usage:{state:string;actual_krw:string|number|null;model:string|null;tool_calls:unknown[]|number|null}|null;corrections:{id?:string;summary?:string;reason?:string;created_at:string}[]};

export function EventRows({events,onEvent}:{events:WorkEvent[];onEvent:(id:string)=>void}){
 return <ol className="row-list event-list">{events.map(e=><li key={e.id}><button type="button" className="row" onClick={()=>onEvent(e.id)}><span className="row-icon" aria-hidden="true"><Icon d={icons.doc}/></span><span><strong>{e.summary}</strong><small>{e.project_name??'현장 미특정'} · {kinds[e.kind]??e.kind} · {statuses[e.status]??e.status}</small></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ol>;
}

/** Facts and notes stay visible even when no checklist action was created. */
export function WorkEvents({client,project,onEvent}:{client:WorkClient;project?:string;onEvent:(id:string)=>void}){
 const [events,setEvents]=useState<WorkEvent[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;const load=()=>client.request<{items:EventDetail[]}>({route:'events.list',limit:100,...(project?{project_id:project}:{})}).then(r=>{if(alive){setEvents(r.items.map(r=>r.event));setError('');}},()=>{if(alive)setError('업무 기록을 불러오지 못했어요.');});setEvents(null);void load();window.addEventListener('work-events-changed',load);return()=>{alive=false;window.removeEventListener('work-events-changed',load);};},[client,project]);
 return <section className="today-section" aria-labelledby="work-events-title"><ListHead id="work-events-title" title="업무 기록" count={events?.length}/>{error?<Notice tone="warn" role="alert">{error}</Notice>:null}{!events&&!error?<p role="status" className="muted">업무 기록을 확인하고 있어요…</p>:null}{events&&!events.length?<p className="muted">아직 모인 업무 기록이 없어요.</p>:null}<EventRows events={events??[]} onEvent={onEvent}/>{events?.length===100?<p className="muted">최근 업무 기록 100개를 표시했어요.</p>:null}</section>;
}

export function WorkEventDetail({client,context,id,onOpen,onEvent}:{client:WorkClient;context:WorkContext;id:string;onOpen:(id:string,project?:string)=>void;onEvent:(id:string)=>void}){
 const [data,setData]=useState<EventDetail|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false);
 const [project,setProject]=useState(''),[summary,setSummary]=useState(''),[reason,setReason]=useState('');
 const pending=useRef<{body:string;command:string}|null>(null);
 const generation=useRef(0);
 const load=useCallback(async()=>{const mine=++generation.current;const next=await client.request<EventDetail>({route:'events.read',id});if(mine!==generation.current)return;setData(next);setProject(next.event.project_id??'');setSummary(next.event.summary);},[client,id]);
 useEffect(()=>{setData(null);setError('');void load().catch(()=>setError('업무 기록을 열지 못했어요. 연결과 자료 접근 권한을 확인해 주세요.'));return()=>{generation.current++;};},[load]);
 async function correct(){if(!data||busy)return;setBusy(true);setError('');const body=JSON.stringify({action:'event',id,expected_version:data.event.version,project_id:project||null,summary:summary.trim(),reason:reason.trim()});if(pending.current?.body!==body)pending.current={body,command:JSON.stringify({...JSON.parse(body),client_command_id:workId()})};
  try{await client.request({route:'journal.command',command:pending.current.command});pending.current=null;setEditing(false);setReason('');await load();window.dispatchEvent(new Event('work-events-changed'));}
  catch(e){if((e as {code?:string}).code==='VERSION_CONFLICT'){pending.current=null;try{await load();setError('다른 기기에서 바뀌었어요. 최신 기록을 확인한 뒤 수정해 주세요.');}catch{setError('최신 기록을 불러오지 못했어요.');}}else setError('저장을 확인하지 못했어요. 다시 누르면 같은 수정을 이어서 확인합니다.');}finally{setBusy(false);}}
 if(!data)return error?<Notice tone="warn" role="alert">{error}</Notice>:<p role="status" className="muted">업무 기록을 열고 있어요…</p>;
 const e=data.event;
 const source=(s:EventSource,index?:number)=><section key={s.id} className="event-source"><h3>{index===undefined?'이번 원문':`선행 근거 ${index+1}`}{s.file_name?` · ${s.file_name}`:''}</h3>{s.available?<><p className="event-source-text">{s.text||'읽은 본문이 없어요.'}</p><button type="button" className="text-button" onClick={()=>onOpen(s.id,e.project_id??undefined)}>자료 열기</button></>:<p className="muted">{s.reason==='SOURCE_CHANGED'?'기록 이후 바뀐 자료예요.':'현재 접근할 수 없는 자료예요.'}</p>}</section>;
 return <article className="work-event-detail"><header><p className="muted">{e.project_name??'현장 미특정'} · {kinds[e.kind]??e.kind} · {statuses[e.status]??e.status}</p><h2>{e.summary}</h2><time className="muted" dateTime={e.created_at}>{new Date(e.created_at).toLocaleString('ko-KR')}</time></header>{error?<Notice tone="warn" role="alert">{error}</Notice>:null}{e.detail?<p className="event-source-text">{e.detail}</p>:null}{e.reasoning?<section><h3>연결 근거</h3><p className="event-source-text">{e.reasoning}</p></section>:null}{e.missing.length?<p className="muted">확인할 내용: {e.missing.map(m=>missingLabel[m]??m).join(', ')}</p>:null}{e.supersedes?<button type="button" className="text-button" onClick={()=>onEvent(e.supersedes!)}>앞선 업무 기록 보기</button>:null}
 {data.source?source(data.source):<p className="muted">이번 원문에 접근할 수 없어요.</p>}{data.evidence.map((s,i)=>source(s,i))}
 {e.followups.length?<section><h3>이어 할 일</h3><ul>{e.followups.map(f=><li key={f.id}>{f.title} · {f.state==='done'?'처리함':f.state==='dismissed'?'제외함':'챙길 일'}{f.due_on?` · ${f.due_on}`:''}</li>)}</ul></section>:null}
 {context.can_maintain!==false?<section>{!editing?<button type="button" className="button-secondary" onClick={()=>setEditing(true)}>현장·내용 수정</button>:<form className="stack" onSubmit={ev=>{ev.preventDefault();void correct();}}><label className="field">현장<select disabled={busy} value={project} onChange={ev=>setProject(ev.target.value)}><option value="">현장 미특정</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label><label className="field">업무 내용<textarea required maxLength={400} disabled={busy} value={summary} onChange={ev=>setSummary(ev.target.value)}/></label><label className="field">수정 이유<input required maxLength={500} disabled={busy} value={reason} onChange={ev=>setReason(ev.target.value)}/></label><div className="work-actions"><button type="submit" className="button-primary" disabled={busy||!summary.trim()||!reason.trim()}>수정 저장</button><button type="button" className="button-quiet" disabled={busy} onClick={()=>setEditing(false)}>취소</button></div></form>}</section>:null}
 {data.corrections.length?<section><h3>수정 이력</h3><ol>{data.corrections.map((c,i)=><li key={c.id??i}><time dateTime={c.created_at}>{new Date(c.created_at).toLocaleString('ko-KR')}</time> · {c.reason||c.summary||'수정 기록'}</li>)}</ol></section>:null}
 </article>;
}

/** Uses the operator-scoped API; the exported rows are exactly the rows shown. */
export function WorkEventActivity({client,onEvent}:{client:WorkClient;onEvent:(id:string)=>void}){
 const [data,setData]=useState<EventDetail[]|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{let alive=true;void client.request<{items:EventDetail[]}>({route:'events.list',limit:100}).then(r=>{if(alive){setData(r.items);setError('');}},()=>{if(alive)setError('업무 처리 기록을 불러오지 못했어요. 운영자 권한과 연결을 확인해 주세요.');});return()=>{alive=false;};},[client,tick]);
 function download(){if(!data)return;const blob=new Blob([data.map(r=>JSON.stringify(r)).join('\n')+'\n'],{type:'application/x-ndjson;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='sigongnote-work-events.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <section className="today-section work-event-activity"><ListHead title="업무 처리 기록" count={data?.length} action={<button type="button" className="text-button" onClick={()=>setTick(v=>v+1)}>새로고침</button>}/>{error?<Notice tone="warn" role="alert">{error}</Notice>:null}{!data&&!error?<p role="status">불러오는 중…</p>:null}{data?<><button type="button" className="button-secondary" onClick={download} disabled={!data.length}>JSONL 내보내기</button>{!data.length?<p className="muted">아직 처리 기록이 없어요.</p>:<ol className="event-observations">{data.map(r=><li key={r.event.id}><button type="button" className="text-button" onClick={()=>onEvent(r.event.id)}>{r.event.summary}</button><p className="muted">{r.event.project_name??'현장 미특정'} · 선행 근거 {r.evidence.length}개 · 교정 {r.corrections.length}회</p><p className="muted">{r.usage?.model??'모델 정보 없음'} · 비용 {r.usage?.actual_krw===null||r.usage?.actual_krw===undefined?'확인 중':`${Number(r.usage.actual_krw).toLocaleString('ko-KR')}원`} · 도구 호출 {Array.isArray(r.usage?.tool_calls)?r.usage.tool_calls.length:r.usage?.tool_calls??'확인 중'}</p>{Array.isArray(r.usage?.tool_calls)&&r.usage.tool_calls.length?<details><summary>도구 호출 보기</summary><pre className="event-source-text">{JSON.stringify(r.usage.tool_calls,null,2)}</pre></details>:null}</li>)}</ol>}</>:null}</section>;
}
