import {JournalDraft} from './journal-draft.js';
import {useEffect,useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import {Icon,icons,ListHead,Notice} from './work-shell.js';
import {categoryNames,type Category} from './work-materials.js';
export type JournalItem={id:string;title?:string;organization_version?:number;received_at:string;occurred_at:string|null;source_kind:string|null;declared_mime:string;project_id:string|null;project_name:string|null;categories:string[];excerpt:string;reading_state:string;parse_status:string;observations:{id:string;kind:string;text:string;locator:string}[]};
export type Journal={items:JournalItem[];next_cursor:string|null};
export const journalKind=(r:JournalItem)=>r.source_kind==='photo_sheet'?'사진대지':r.source_kind==='sms'||r.declared_mime.includes('message')?'문자':r.source_kind==='call_recording'||r.declared_mime.startsWith('audio/')?'통화 녹음':r.declared_mime.startsWith('image/')?'사진':'문서';
export const localDate=(v:string)=>new Date(v).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
const localTime=(v:string)=>new Date(v).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'});
const readingText=(r:JournalItem)=>r.excerpt;
const dayLabel=(v:string)=>{const today=localDate(new Date().toISOString());if(v===today)return '오늘';const [y,m,d]=v.split('-');return `${Number(m)}월 ${Number(d)}일${y!==today.slice(0,4)?` (${y})`:''}`;};
/** Arrival journal: every message, call, photo and file by the day it arrived, before and after classification. */
export function useJournal(client:WorkClient,filter:{project?:string;day?:string;category?:string;cursor?:string|undefined}){
 const [data,setData]=useState<Journal|null>(null),[error,setError]=useState('');
 const epoch=useRef(0);const {project='',day='',category='',cursor}=filter;
 useEffect(()=>{const mine=++epoch.current;let reading=false;
  const load=async()=>{if(reading)return;reading=true;try{const next=await client.request<Journal>({route:'journal.list',...(project?{project_id:project}:{}),...(day?{q:day}:{}),...(category?{category:category as Category}:{}),...(cursor?{cursor}:{})});if(epoch.current===mine){setData({items:next.items??[],next_cursor:next.next_cursor??null});setError('');}}catch{if(epoch.current===mine)setError('새 기록을 확인하지 못했어요.');}finally{reading=false;}};
  setData(null);void load();const tick=setInterval(()=>{if(document.visibilityState==='visible')void load();},client.kind==='local'?5000:30000);window.addEventListener('focus',load);window.addEventListener('journal-changed',load);window.addEventListener('photos-changed',load);
  return()=>{epoch.current++;clearInterval(tick);window.removeEventListener('focus',load);window.removeEventListener('journal-changed',load);window.removeEventListener('photos-changed',load);};
 },[client,project,day,category,cursor]);
 return {data,error};
}
/** Date-grouped rows. Compact rows are one line each; full rows add the found content and the document shortcut. */
export function JournalRows({items,compact=false,client,context,onOpen,onOpenDraft,onOpenSheet}:{items:JournalItem[];compact?:boolean;client?:WorkClient;context?:WorkContext;onOpen:(id:string,project?:string)=>void;onOpenDraft?:(id:string)=>void;onOpenSheet?:(id:string)=>void}){
 const open=(r:JournalItem)=>r.source_kind==='photo_sheet'&&onOpenSheet?onOpenSheet(r.id):onOpen(r.id,r.project_id??undefined);
 return <ol className="journal-list">{items.map((r,i)=><li key={r.id}>
  {(i===0||localDate(items[i-1]!.received_at)!==localDate(r.received_at))&&<h3 className="journal-date">{dayLabel(localDate(r.received_at))}</h3>}
  {compact?<button type="button" className="journal-row" onClick={()=>open(r)}><time className="journal-when" dateTime={r.received_at}>{localTime(r.received_at)}</time><span className="journal-row-body"><strong>{r.title||r.excerpt||journalKind(r)}</strong><small>{r.project_name??'현장 확인 전'}{r.categories.length?' · '+r.categories.map(c=>categoryNames[c as Category]??c).join(', '):''}</small></span><Icon d={icons.next} size={20}/></button>
  :<details className="journal-entry"><summary className="journal-meta"><time dateTime={r.received_at}>{localTime(r.received_at)}</time> · {journalKind(r)}{r.project_name?' · '+r.project_name:''}</summary>
   {readingText(r)?<p className="journal-excerpt">{readingText(r)}</p>:null}
   {r.observations.length>0&&<details><summary>찾은 내용 {r.observations.length}개</summary><ul>{r.observations.map(o=><li key={o.id}>{o.text}</li>)}</ul></details>}
   {r.categories.length?<div className="journal-tags">{r.categories.map(c=><span key={c}>{categoryNames[c as Category]??c}</span>)}</div>:null}
   <div className="journal-actions"><button type="button" className="text-button" onClick={()=>open(r)}>{r.source_kind==='photo_sheet'?'사진대지 열기':'자료 열기'}</button>{r.source_kind!=='photo_sheet'&&onOpenDraft&&client&&context&&(client.kind!=='local'||context.cloud_connected)&&<JournalDraft key={r.id+":"+r.organization_version} client={client} context={context} item={r} onOpen={onOpenDraft}/>}</div>
  </details>}
 </li>)}</ol>;
}
/** The full journal screen, or the dated record of one site when `project`/`category` are fixed by the screen above. */
export function WorkJournal({client,context,onOpen,onAdd,initialProject='',onOpenDraft,onNavigate,project:fixedProject,category:fixedCategory,title='도착 기록'}:{client:WorkClient;context:WorkContext;onOpen:(id:string,project?:string)=>void;onAdd:(project?:string)=>void;initialProject?:string;onNavigate?:(path:string)=>void;onOpenDraft?:(id:string)=>void;project?:string;category?:string;title?:string}){
 const fixed=fixedProject!==undefined;
 const [ownProject,setOwnProject]=useState(initialProject),[day,setDay]=useState(''),[ownCategory,setOwnCategory]=useState(''),[cursor,setCursor]=useState<string|undefined>();
 const project=fixed?fixedProject:ownProject,category=fixed?(fixedCategory??''):ownCategory;
 const {data,error}=useJournal(client,{project,day,category,cursor});
 const items=data?.items;const filtered=Boolean(project||day||category);
 return <section className="journal" aria-labelledby="journal-title"><ListHead id="journal-title" title={title} action={<button type="button" className="button-quiet journal-add" onClick={()=>onAdd(project||undefined)}><Icon d={icons.plus} size={20}/>자료 추가</button>}/>
 {!fixed&&<div className="journal-filters"><label>현장<select value={ownProject} onChange={e=>{setOwnProject(e.target.value);setCursor(undefined);}}><option value="">모든 현장 · 확인 전 포함</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label><label>도착 날짜<input type="date" value={day} onChange={e=>{setDay(e.target.value);setCursor(undefined);}}/></label><label>종류<select value={ownCategory} onChange={e=>{setOwnCategory(e.target.value);setCursor(undefined);}}><option value="">모든 종류</option>{Object.entries(categoryNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label></div>}
 {error&&<Notice tone="warn" role="alert">새 기록을 확인하지 못했어요. 보이던 기록은 유지하고 다시 연결할게요.</Notice>}
 {!data&&!error&&<p role="status" className="muted">도착한 기록을 확인하고 있어요…</p>}
 {data&&!items?.length&&<div className="journal-empty"><p>기록 없음</p>{!cursor&&filtered&&!fixed?<button type="button" className="text-button" onClick={()=>{setOwnProject('');setDay('');setOwnCategory('');setCursor(undefined);}}>모든 기록 보기</button>:null}</div>}
 {items?.length?<JournalRows items={items} client={client} context={context} onOpen={onOpen} {...(onNavigate?{onOpenSheet:(id:string)=>onNavigate('sheets/'+id)}:{})} {...(onOpenDraft?{onOpenDraft}:{})}/>:null}
 {data?.next_cursor&&<button type="button" className="button-secondary" onClick={()=>setCursor(data.next_cursor!)}>이전 기록 보기</button>}
 {cursor&&<button type="button" className="text-button" onClick={()=>setCursor(undefined)}>최근 기록으로</button>}
 </section>;
}
