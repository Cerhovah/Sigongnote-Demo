import {JournalRows,useJournal} from './work-journal.js';
import {useEffect,useState} from 'react';
import {TaskRows,useTasks} from './work-tasks.js';
import {AgendaRows,useAgenda} from './work-ledger.js';
import {useQuestions} from "./work-questions.js";
import {WorkVoice} from "./work-voice.js";
import {Icon,icons,ListHead,Notice} from "./work-shell.js";
import type {WorkClient,WorkContext} from "./work-client.js";
import type {Ask} from "./work-ask.js";
import {documentNames} from "./work-draft.js";
import {EventRows} from './work-events.js';
export const todayTitle=()=>new Date().toLocaleDateString("ko-KR",{month:"long",day:"numeric",weekday:"long"});
type Prepared={id:string;type:string;project_id:string;work_label:string};
/**
 * One request entry, useful shortcuts, and the work that needs attention.
 */
export function WorkToday({onNavigate,onJournalOpen,onAdd,client,context,ask,issued,onQuestions,onSent,onOpenDraft,onWork}:{onNavigate:(path:string)=>void;onJournalOpen:(id:string,project?:string)=>void;onAdd:(project?:string)=>void;client:WorkClient;context:WorkContext;ask:Ask;issued:Record<string,string>;onQuestions:()=>void;onSent:()=>void;onOpenDraft:(id:string)=>void;onMaterials?:()=>void;onFolders?:()=>void;onWork:(id:string)=>void}){
 const {loaded,questions,error:questionError}=useQuestions(client,`${context.user_id}:${context.tenant_id}`);
 const tasks=useTasks(client),agenda=useAgenda(client),journal=useJournal(client,{});
 const [showDone,setShowDone]=useState(false),[expanded,setExpanded]=useState(false);
 const [preparedState,setPreparedState]=useState("loading"),[prepared,setPrepared]=useState<Prepared[]>([]);
 useEffect(()=>{let alive=true,running=false;const load=()=>{if(running||document.visibilityState==='hidden')return;running=true;void client.request<{prepared?:Prepared[]}>({route:'documents.list'}).then(r=>{if(alive){setPrepared(r.prepared??[]);setPreparedState("ready");}},()=>{if(alive){setPrepared([]);setPreparedState("error");}}).finally(()=>{running=false;});};load();window.addEventListener('documents-changed',load);document.addEventListener('visibilitychange',load);const fallback=setInterval(load,60000);return()=>{alive=false;clearInterval(fallback);window.removeEventListener('documents-changed',load);document.removeEventListener('visibilitychange',load);};},[client]);
 const first=questions[0],draft=ask.answer?.document_draft,pending=draft&&!issued[draft.id]?draft:null;
 const drafts=prepared.filter(d=>(!ask.project||d.project_id===ask.project)&&d.id!==pending?.id&&!issued[d.id]).slice(0,4);
 const send=(value?:string,turnId?:string)=>{onSent();void ask.submit(value,turnId,turnId?"voice":undefined);};
 const taskItems=(tasks.data?.items??[]).filter(t=>showDone||!t.done),doneCount=(tasks.data?.items??[]).filter(t=>t.done).length;
 const agendaCount=agenda.data?.items.length??0,todoCount=questions.length+agendaCount+taskItems.length;
 const todoLoading=(!loaded&&!questionError)||(!tasks.data&&!tasks.error)||(!agenda.data&&!agenda.error);
 const todoError=questionError||tasks.error||agenda.error;
 const broken=context.readiness?.capabilities.filter(c=>c.source_id&&c.state==='needs_reconnect')??[];
 const siteForAdd=ask.project||context.projects?.[0]?.id;
 return <>
  <form className="ask-dock today-composer" aria-labelledby="ask-dock-title" onSubmit={e=>{e.preventDefault();if(ask.text.trim()&&!ask.busy)send();}}>
   <h2 id="ask-dock-title">무엇을 도와드릴까요?</h2>
   <div className="composer-box">
    <label htmlFor="today-ask-input" className="sr-only">글로 요청</label>
    <input id="today-ask-input" value={ask.text} maxLength={2000} enterKeyHint="send" placeholder="견적서 찾아줘, 오늘 할 일 알려줘…" onChange={e=>ask.setText(e.target.value)}/>
    <div className="composer-toolbar">
     <div className="composer-tools">
      <button type="button" className="composer-attach" onClick={()=>onAdd(siteForAdd)} aria-label="파일 추가"><Icon d={icons.plus} size={24}/></button>
      <div className="today-voice"><WorkVoice client={client} label="말하기" tone="secondary" disabled={ask.busy} inputId="today-ask-input" onText={ask.setText} onRecognized={ask.setVoiceId}/></div>
     </div>
     <button type="submit" className="composer-send" aria-label="보내기" disabled={ask.busy||!ask.text.trim()}><Icon d={icons.send} size={24}/><span className="sr-only">보내기</span></button>
    </div>
   </div>
   <div className="composer-bottom">
    <label className="composer-scope"><Icon d={icons.site} size={20}/><span className="sr-only">요청할 현장</span><select aria-label="대화에서 찾을 현장" value={ask.project} disabled={ask.busy} onChange={e=>ask.setProject(e.target.value)}><option value="">전체 현장</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
    <button type="button" className="text-button" onClick={()=>onNavigate('journal')}>업무일지</button>
   </div>
   {ask.busy?<p role="status" className="muted">처리하고 있어요…</p>:null}
   {ask.error?<Notice tone="warn"><p>{ask.askedSite} 요청의 답을 아직 못 가져왔어요.</p><button type="button" className="text-button" onClick={()=>{onSent();void ask.retry();}}>같은 요청 이어서 확인</button></Notice>:null}
  </form>
  <div className="today-shortcuts">
   <button type="button" onClick={()=>onNavigate('materials/list')}><Icon d={icons.search} size={22}/><span>자료 찾기</span><Icon d={icons.next} size={18}/></button>
   <button type="button" onClick={()=>onNavigate('documents/new')}><Icon d={icons.doc} size={22}/><span>문서 만들기</span><Icon d={icons.next} size={18}/></button>
  </div>
  <section className="today-section today-arrivals"><ListHead title="들어온 자료" count={journal.data?.items.length} action={<button type="button" className="text-button" onClick={()=>onNavigate('journal')}>업무일지</button>}/>{journal.data?.items.length?<JournalRows items={journal.data.items.slice(0,5)} compact onOpen={onJournalOpen} onOpenSheet={id=>onNavigate('sheets/'+id)}/>:<p className="muted">{journal.error||'새로 들어온 자료가 여기에 모여요.'}</p>}</section>
  {broken[0]?<Notice tone="warn" role="alert"><span>{broken[0].label} · {broken[0].reason}</span><button type="button" className="text-button" onClick={()=>onNavigate('folders')}>연결 확인</button></Notice>:null}
  <section id="today-next" className="today-section" aria-labelledby="today-todo-title" aria-busy={todoLoading}>
   <ListHead id="today-todo-title" title="오늘 할 일" count={todoCount} action={doneCount?<button type="button" className="text-button" aria-pressed={showDone} onClick={()=>setShowDone(v=>!v)}>{showDone?'처리한 일 숨기기':`처리한 일 ${doneCount}개`}</button>:undefined}/>
   {first?<ul className="task-list"><li className="task-row is-question"><span className="task-badge" aria-hidden="true">{questions.length}</span><button type="button" className="task-open" onClick={onQuestions}><span className="task-text">{first.prompt}</span><span className="task-meta"><span>{first.project_name} · {first.work_label}</span><span className="task-cta">지금 확인하기{questions.length>1?` · ${questions.length}개`:''}</span></span><Icon d={icons.next} size={20}/></button></li></ul>:null}
   {agenda.data?<AgendaRows data={agenda.data} onOpen={onWork}/>:null}
   <TaskRows items={expanded?taskItems:taskItems.slice(0,5)} busy={tasks.busy} onMark={tasks.mark} onOpen={onJournalOpen} onEvent={id=>onNavigate('events/'+encodeURIComponent(id))}/>
   {taskItems.length>5?<button type="button" className="text-button" onClick={()=>setExpanded(v=>!v)}>{expanded?'접기':`챙길 일 ${taskItems.length}개 모두 보기`}</button>:null}
   {todoError?<Notice tone="warn" role="alert">{todoError}</Notice>:null}
   {!todoCount&&todoLoading&&!todoError?<p role="status" className="muted">불러오는 중…</p>:null}
   {!todoCount&&!todoLoading&&!todoError?<p className="today-clear"><Icon d={icons.check} size={20}/>새로 확인할 일이 없어요.</p>:null}
  </section>
  {tasks.data?.events?.length?<section className="today-section" aria-labelledby="today-events-title"><ListHead id="today-events-title" title="업무 기록" count={tasks.data.events.length} action={<button type="button" className="text-button" onClick={()=>onNavigate('events')}>모두 보기</button>}/><EventRows events={tasks.data.events.slice(0,5)} onEvent={id=>onNavigate('events/'+encodeURIComponent(id))}/></section>:null}
  {pending||drafts.length?<section className="today-section" aria-labelledby="today-drafts-title"><ListHead id="today-drafts-title" title="검토할 초안" count={drafts.length+(pending?1:0)} action={<button type="button" className="text-button" onClick={()=>onNavigate('documents')}>문서</button>}/>
   <ul className="row-list">
    {pending?<li><button type="button" className="row" onClick={()=>onOpenDraft(pending.latest_id??pending.id)}><span className="row-icon" aria-hidden="true"><Icon d={icons.doc}/></span><span><strong>준비한 {documentNames[pending.type??""]??"문서"} 이어서 보기</strong><small>{ask.askedSite}</small></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>:null}
    {drafts.map(d=><li key={d.id}><button type="button" className="row" onClick={()=>onOpenDraft(d.id)}><span className="row-icon" aria-hidden="true"><Icon d={icons.doc}/></span><span><strong>{documentNames[d.type]??'문서'} 초안 확인</strong><small>{context.projects?.find(p=>p.id===d.project_id)?.display_name??'현장 확인 필요'} · {d.work_label}</small></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}
   </ul></section>:null}
  {preparedState==="error"?<p className="muted">문서 불러오기 실패</p>:null}
 </>;
}
