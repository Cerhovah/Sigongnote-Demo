import {useState} from 'react';
import {ArchiveReference} from './archive-reference.js';
import {WorkObserved} from './work-observed.js';
import {WorkMessage} from "./work-message.js";
import {WorkEvidence} from './work-evidence.js';
import {WorkAudio,audioStatus} from "./work-audio.js";
import {Icon,icons,Notice} from "./work-shell.js";
import type {WorkClient,WorkContext,Material,MaterialDetail} from "./work-client.js";
export const categoryNames={agreement:"약속",drawing_material:"도면·자재",delivery_work:"납품·작업",billing_payment:"청구·지급",inspection_defect:"점검·하자"} as const;
export type Category=keyof typeof categoryNames;
const categoryIcons:Record<Category,string>={agreement:"M6 3h9l4 4v14H6z M9 12h6 M9 16h6",drawing_material:"M3 21h18 M5 21V5h6v16 M11 9h8v12",delivery_work:"M3 7h11v9H3z M14 10h4l3 3v3h-7 M7 19a2 2 0 1 0 0-.1 M17 19a2 2 0 1 0 0-.1",billing_payment:"M4 6h16v12H4z M4 10h16 M8 15h4",inspection_defect:"M12 3l8 4v5c0 5-4 8-8 9-4-1-8-4-8-9V7z M9 12l2 2 4-4"};
const statuses:Record<string,string>={pending:"읽을 차례를 기다려요",queued:"읽을 차례를 기다려요",leased:"내용을 읽고 있어요",retry_wait:"다시 읽기를 기다려요",dead:"읽기를 마치지 못했어요",cancelled:"읽기를 중지했어요",complete:"내용을 읽었어요",partial:"일부 내용만 읽었어요",failed:"읽지 못한 내용이 있어요",unsupported:"아직 읽을 수 없는 형식이에요",encrypted:"암호가 있어 읽지 못했어요"};
export const materialStatus=(m:Material)=>m.readable_spans===0&&["complete","partial"].includes(m.status)?"보관됨 · 읽은 내용 없음":m.audio?audioStatus(m.audio):statuses[m.job_state&&m.job_state!=="succeeded"?m.job_state:m.status]??"자료 상태를 확인하고 있어요";
/** Sites are the entry point: the list, a finder once it grows, and one way to add a site. Unassigned evidence stays reachable through 모든 현장. */
export function MaterialsSites({projects,onSite,onAll,onAdd}:{projects:NonNullable<WorkContext["projects"]>;onSite:(id:string)=>void;onAll:()=>void;onAdd:()=>void}){
 const [query,setQuery]=useState("");const q=query.trim(),list=projects.filter(p=>!q||p.display_name.includes(q));
 return <div className="sites-home">
  {projects.length>3?<div className="site-search"><label htmlFor="site-search" className="sr-only">현장 찾기</label><input id="site-search" type="search" placeholder="현장 이름으로 찾기" value={query} maxLength={80} onChange={e=>setQuery(e.target.value)}/></div>:null}
  <ul className="row-list row-list-plain">{list.map(project=><li key={project.id}><button type="button" className="row" onClick={()=>onSite(project.id)}><span className="row-icon" aria-hidden="true"><Icon d={icons.site} size={24}/></span><span><strong>{project.display_name}</strong></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ul>
  {!projects.length?<p className="muted">현장 없음</p>:q&&!list.length?<p className="muted">‘{q}’ 이름의 현장이 없어요.</p>:null}
  <div className="stack-actions"><button type="button" className="button-secondary" onClick={onAdd}><Icon d={icons.plus} size={22}/><span>현장 추가</span></button>{projects.length?<button type="button" className="text-button" onClick={onAll}>모든 현장의 기록 보기</button>:null}</div>
 </div>;
}
/** Within one site, search its contents or pick one of the five kinds. */
export function MaterialsHome({draft,setDraft,busy,onSearch,onCategory}:{draft:string;setDraft:(v:string)=>void;busy:boolean;onSearch:(q:string)=>void;onCategory:(c:Category|"")=>void}){
 return <div className="materials-home">
  <search><form className="search-form" onSubmit={e=>{e.preventDefault();if(!busy)onSearch(draft.trim());}}><label htmlFor="work-search" className="field-label">자료 내용으로 찾기</label><div className="search-row"><input id="work-search" type="search" value={draft} maxLength={80} placeholder="예: 석고보드, 납품" onChange={e=>setDraft(e.target.value)}/><button type="submit" className="button-primary" disabled={busy}><Icon d={icons.search} size={24}/><span>찾기</span></button></div></form></search>
  <h2 className="section-title">종류별로 보기</h2>
  <ul id="work-categories" className="row-list">{(Object.keys(categoryNames) as Category[]).map(id=><li key={id}><button type="button" className="row" onClick={()=>onCategory(id)}><span className="row-icon" aria-hidden="true"><Icon d={categoryIcons[id]}/></span><span><strong>{categoryNames[id]}</strong></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}
   <li><button type="button" className="row" onClick={()=>onCategory("")}><span className="row-icon" aria-hidden="true"><Icon d="M3 7h7l2 2h9v11H3z"/></span><span><strong>전체 자료</strong></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li></ul>
 </div>;
}
export function MaterialsList({items,busy,error,page,cursor,onOpen,onNext,onFirst,onRefresh}:{items:Material[];busy:boolean;error:string;query:string;page:string|undefined;cursor:string|null;onOpen:(m:Material)=>void;onNext:()=>void;onFirst:()=>void;onRefresh:()=>void}){
 return <div className="materials-list">
  {error?<Notice tone="warn" role="alert">{error}</Notice>:null}
  <p role="status" className="result-count">{busy?"자료를 확인하고 있어요…":`${items.length}개 자료${page?" · 다음 목록":""}`}</p>
  {!busy&&!error&&!items.length?<div id="work-empty" className="empty-state"><p>자료 없음</p></div>:null}
  <ul id="work-material-list" className="item-list">{items.map(item=><li key={item.id}><button type="button" className="item" onClick={()=>onOpen(item)}><span className="item-kicker">{item.categories?.map(c=>categoryNames[c as Category]).filter(Boolean).join(" · ")||"분류할 단서를 기다려요"}{item.work_label?` · ${item.work_label}`:""}</span><strong>{item.title}</strong><span className="item-meta">{item.project_name??"현장 확인 전"} · {materialStatus(item)}</span><small>{new Date(item.created_at).toLocaleString("ko-KR")}</small><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ul>
  <div className="stack">{cursor?<button type="button" className="button-secondary" disabled={busy} onClick={onNext}>다음 자료 보기</button>:null}{page?<button type="button" className="button-quiet" onClick={onFirst}>처음 목록으로</button>:null}<button type="button" className="button-quiet" disabled={busy} onClick={onRefresh}>새로 확인</button></div>
 </div>;
}
/** One material: what was read, the original, and the only question it may need. */
export function MaterialDetailView({client,context,id,detail,originalBusy,answerProject,answerBusy,setAnswerProject,onAnswer,onOriginal,onSaved,onLatest}:{client:WorkClient;context:WorkContext;id:string;detail:MaterialDetail|null;originalBusy:boolean;answerProject:string;answerBusy:boolean;setAnswerProject:(v:string)=>void;onAnswer:()=>void;onOriginal:(seconds?:number)=>void;onSaved:()=>void;onLatest?:(id:string)=>void}){
 const message=detail?.revision.declared_mime==="application/vnd.sigongnote.message+json";
 return <div className="material-detail">
  {detail?.revision.archived&&context.can_maintain&&<ArchiveReference key={id} client={client} id={id} onSaved={onSaved}/>}
  {detail?.revision.revision_number?<p>개정 {detail.revision.revision_number}</p>:null}
  {detail?.revision.latest_revision_id&&detail.revision.latest_revision_id!==id?<p role="status">새 수정본이 있어요. <button type="button" className="button-secondary" onClick={()=>onLatest?.(detail.revision.latest_revision_id!)}>최신 개정 열기</button></p>:null}
  {detail&&!message&&detail.revision.original_available!==false?<button id="work-original" type="button" className="button-primary" disabled={originalBusy} onClick={()=>onOriginal()}>{originalBusy?"원문을 준비해요…":"원문 열기"}</button>:null}
  {detail?.organization&&(detail.organization.state==="conflict"||client.kind==='local'||detail.local_record)&&context.can_resolve_site?<section className="card site-question"><h2 className="card-title">현장 지정</h2><label className="field"><span className="sr-only">이 자료의 현장</span><select value={answerProject} onChange={e=>setAnswerProject(e.target.value)}><option value="">현장 선택</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label><button type="button" className="button-secondary" disabled={!answerProject||answerBusy} onClick={onAnswer}>이 현장으로 정리</button></section>:null}
  {detail?.revision.original_available===false&&<p className="muted">원본은 PC에 보관되어 있어요.</p>}
  {detail?.observed_work?<WorkObserved value={detail.observed_work}/>:null}
  {message?<WorkMessage key={id} client={client} id={id}/>:null}
  {detail?.audio?<WorkAudio key={id} client={client} id={id} progress={detail.audio} spans={detail.result?.output.spans??[]} corrections={detail.corrections??[]} canCorrect={context.can_resolve_site===true} onSaved={onSaved} onOriginal={onOriginal}/>:null}
  {detail?.result&&!detail.audio?(client.kind==='local'||detail.local_record)?<section className="read-content"><h2 className="section-title">읽은 내용</h2><div className="work-spans">{detail.result.output.spans.map(span=><p key={span.locator+span.text}>{span.text}</p>)}</div>{!detail.result.output.spans.length&&<p className="muted">{detail.result.output.status==='pending'?'읽을 차례를 기다려요.':'이 자료는 원문으로 확인하세요.'}</p>}</section>:<WorkEvidence key={id} client={client} id={id} fallback={detail.result.output.spans}/>:detail&&!detail.audio?<p className="muted">읽은 내용을 기다리고 있어요.</p>:null}
  {!detail?<p role="status" className="muted">자료를 여는 중이에요…</p>:null}
 </div>;
}
