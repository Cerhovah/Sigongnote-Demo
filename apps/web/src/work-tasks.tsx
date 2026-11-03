import {useCallback,useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import {Icon,icons,ListHead,Notice} from './work-shell.js';
export type Task={id:string;revision_id:string;text:string;project_name:string|null;project_id:string|null;done:boolean;version:number;kind?:string;event_id?:string;event_summary?:string|null;missing?:string[]|null;confidence?:string|null};
export type WorkEvent={id:string;kind:string;summary:string;detail:string;project_id:string|null;project_name:string|null;party:string|null;source_kind?:string;source_ref?:string;evidence_refs?:string[];supersedes?:string|null;version?:number;missing:string[];confidence:string;status:string;reasoning:string;created_at:string;followups:{id:string;title:string;due_on:string|null;state:string;version:number}[]};
export type Tasks={items:Task[];partial:boolean;events?:WorkEvent[]};
/** Requests and plans read from messages and calls. Marking one done changes only the owner's own checklist, never delivery or payment. */
export function useTasks(client:WorkClient){
 const [data,setData]=useState<Tasks|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState('');
 const pending=useRef<Record<string,string>>({}),generation=useRef(0),marking=useRef(false);
 useEffect(()=>{let alive=true,running=false;const load=async()=>{if(running)return;running=true;const mine=generation.current;try{const next=await client.request<Tasks>({route:'journal.tasks'});if(alive&&mine===generation.current){setData({items:next.items??[],partial:next.partial??false,events:next.events??[]});setError('');}}catch{if(alive)setError('챙길 일을 갱신하지 못했어요. 기존 표시는 유지됩니다.');}finally{running=false;}};void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},30000);window.addEventListener('focus',load);window.addEventListener('work-events-changed',load);return()=>{alive=false;generation.current++;clearInterval(timer);window.removeEventListener('focus',load);window.removeEventListener('work-events-changed',load);};},[client]);
 const mark=useCallback(async(t:Task)=>{if(marking.current)return;marking.current=true;setBusy(t.id);setError('');generation.current++;const key=t.id+':'+t.version;const command=pending.current[key]??JSON.stringify({action:'task',id:t.id,done:!t.done,expected_version:t.version,client_command_id:workId()});pending.current[key]=command;
  try{const r=await client.request<{done:boolean;version:number}>({route:'journal.command',command});setData(old=>old?{...old,items:old.items.map(x=>x.id===t.id?{...x,...r}:x)}:old);delete pending.current[key];window.dispatchEvent(new Event('work-events-changed'));}
  catch(e){if(['VERSION_CONFLICT','NOT_FOUND'].includes((e as {code?:string}).code??'')){delete pending.current[key];generation.current++;try{const next=await client.request<Tasks>({route:'journal.tasks'});setData({items:next.items??[],partial:next.partial??false,events:next.events??[]});setError('다른 기기에서 바뀌었거나 원문 접근이 변경됐어요. 최신 상태를 불러왔어요.');}catch{setError('자료 상태가 바뀌었어요. 다시 연결되면 최신 상태를 확인할게요.');}}else setError('반영 여부를 확인하지 못했어요. 같은 버튼으로 다시 확인할 수 있어요.');}finally{marking.current=false;setBusy('');}
 },[client]);
 return {data,error,busy,mark};
}
/** Compact checklist rows: one check, the request, where it came from, and the original. */
export function TaskRows({items,busy,onMark,onOpen,onEvent}:{items:Task[];busy:string;onMark:(t:Task)=>void|Promise<void>;onOpen:(id:string,project?:string)=>void;onEvent?:(id:string)=>void}){
 if(!items.length)return null;
 return <ul className="task-list">{items.map(t=><li key={t.id} className={`task-row${t.done?' is-done':''}`}>
  <button type="button" className="task-check" aria-pressed={t.done} title="내 할 일에만 반영" disabled={Boolean(busy)} onClick={()=>void onMark(t)}><Icon d={icons.check} size={18}/><span className="sr-only">{busy===t.id?'저장 중…':t.done?'다시 챙기기':'내 처리 완료'}</span></button>
  <div className="task-body"><p className="task-text">{t.text}</p>{t.kind==='followup'&&t.event_summary?<p className="task-event muted">{t.event_summary}</p>:null}<p className="task-meta"><span>{t.project_name??(t.missing?.includes('site')?'현장 미특정':'현장 확인 전')}</span>{t.done?<span>처리함</span>:null}<button type="button" className="text-button" onClick={()=>onOpen(t.revision_id,t.project_id??undefined)}>원문</button>{t.event_id&&onEvent?<button type="button" className="text-button" onClick={()=>onEvent(t.event_id!)}>연결 근거</button>:null}</p></div>
 </li>)}</ul>;
}
/** Standalone checklist with its own heading and the done filter. */
export function WorkTasks({client,onOpen}:{client:WorkClient;onOpen:(id:string,project?:string)=>void}){
 const {data,error,busy,mark}=useTasks(client);
 const [showDone,setShowDone]=useState(false),[expanded,setExpanded]=useState(false);
 const items=(data?.items??[]).filter(t=>showDone||!t.done);
 return <section aria-labelledby="journal-tasks-title" className="today-section journal-tasks">
  <ListHead id="journal-tasks-title" title="챙길 일" count={items.length} action={<label className="journal-done-filter"><input type="checkbox" checked={showDone} onChange={e=>setShowDone(e.target.checked)}/> 처리한 일도 보기</label>}/>
  {error&&<Notice tone="warn" role="alert">{error}</Notice>}
  {!data&&!error&&<p role="status" className="muted">요청과 예정을 확인하고 있어요…</p>}
  {data&&!items.length&&<p className="muted">{data.items.length?'모인 요청·예정을 모두 처리했어요.':'모인 요청·예정이 없어요.'}</p>}
  <TaskRows items={expanded?items:items.slice(0,5)} busy={busy} onMark={mark} onOpen={onOpen}/>
  {items.length>5&&<button type="button" className="text-button" onClick={()=>setExpanded(!expanded)}>{expanded?'접기':`챙길 일 ${items.length}개 모두 보기`}</button>}
  {data?.partial&&<p className="muted">최근 100개를 표시했어요. 나머지는 날짜별 일지에서 확인하세요.</p>}
 </section>;
}
