import {useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import {journalKind,localDate,useJournal} from './work-journal.js';
import {documentNames} from './work-draft.js';
import {workId} from './work-id.js';
import {Icon,icons,ListHead,Notice} from './work-shell.js';
/**
 * Making a document starts from real inputs: a read record of the site becomes the draft's basis,
 * or the request is handed to the assistant with the site fixed. Nothing here issues or sends anything.
 */
export function DocumentCreate({client,context,project,onProject,onDraft,onAsk,onAdd,onSite}:{client:WorkClient;context:WorkContext;project:string;onProject:(id:string)=>void;onDraft:(id:string)=>void;onAsk:(text:string,project:string)=>void;onAdd:(project:string)=>void;onSite:()=>void}){
 const [type,setType]=useState('estimate'),[busy,setBusy]=useState(''),[error,setError]=useState('');
 const pending=useRef<{body:string;command:string}|null>(null);
 const {data,error:loadError}=useJournal(client,{project});
 const readable=project?(data?.items??[]).filter(r=>r.organization_version&&r.reading_state==='readable'&&r.project_id===project):[];
 const name=documentNames[type]??'문서',canUseRecords=context.can_maintain!==false;
 async function prepare(item:(typeof readable)[number]){
  if(busy||!project)return;setBusy(item.id);setError('');
  const body=JSON.stringify({action:'draft',id:item.id,project_id:project,type,expected_version:item.organization_version});
  const command=pending.current?.body===body?pending.current.command:JSON.stringify({...JSON.parse(body),client_command_id:workId()});pending.current={body,command};
  try{const result=await client.request<{id:string}>({route:'journal.command',command});window.dispatchEvent(new Event('documents-changed'));onDraft(result.id);}
  catch(e){if(['VERSION_CONFLICT','NOT_FOUND'].includes((e as {code?:string}).code??'')){pending.current=null;setError('현장이나 기록이 바뀌었어요. 최신 기록을 다시 확인하고 있어요.');window.dispatchEvent(new Event('focus'));}else setError('초안을 준비하지 못했어요. 같은 기록을 다시 눌러도 중복 생성하지 않아요.');}
  finally{setBusy('');}
 }
 async function prepareNew(){if(busy||!project)return;setBusy('new');setError('');const body=JSON.stringify({project,type:'estimate'});if(pending.current?.body!==body)pending.current={body,command:workId()};try{const result=await client.request<{id:string}>({route:'documents.prepare',project_id:project,type:'estimate',client_command_id:pending.current.command});pending.current=null;window.dispatchEvent(new Event('documents-changed'));onDraft(result.id);}catch{setError('새 견적서를 준비하지 못했어요. 다시 눌러 주세요.');}finally{setBusy('');}}
 return <div className="document-create">
  <label className="field">현장<select disabled={Boolean(busy)} value={project} onChange={e=>onProject(e.target.value)}><option value="">현장 선택</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
  {!context.projects?.length?<button type="button" className="text-button" onClick={onSite}>현장 추가</button>:null}
  <fieldset className="chips" aria-label="문서 종류" disabled={Boolean(busy)}>{Object.entries(documentNames).map(([key,label])=><button key={key} type="button" className="chip" aria-pressed={type===key} onClick={()=>setType(key)}>{label}</button>)}</fieldset>
  {project&&canUseRecords?<section className="today-section" aria-labelledby="create-records-title"><ListHead id="create-records-title" title="근거로 쓸 기록" count={readable.length}/>
   {loadError?<Notice tone="warn" role="alert">기록을 확인하지 못했어요. 연결 후 다시 열어 주세요.</Notice>:!data?<p role="status" className="muted">기록을 확인하고 있어요…</p>:readable.length?<ul className="row-list">{readable.slice(0,20).map(r=><li key={r.id}><button type="button" className="row" disabled={Boolean(busy)} onClick={()=>void prepare(r)}><span className="row-icon" aria-hidden="true"><Icon d={icons.doc}/></span><span><strong>{localDate(r.received_at).slice(5).replace('-','.')} · {journalKind(r)}</strong><small>{busy===r.id?'초안을 준비하고 있어요…':r.excerpt.slice(0,80)||'읽은 기록'}</small></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ul>:<p className="muted">기록 없음</p>}
  </section>:null}
  {project&&canUseRecords&&data&&!readable.length?<button type="button" className="text-button" disabled={Boolean(busy)} onClick={()=>onAdd(project)}>자료 추가</button>:null}
  {error?<Notice tone="danger" role="alert">{error}</Notice>:null}
  <div className="screen-action"><button type="button" className="button-primary" disabled={!project||Boolean(busy)} onClick={()=>onAsk(`${name} 준비해줘`,project)}><Icon d={icons.pen} size={24}/><span>{name} 요청으로 준비</span></button></div>
  {type==='estimate'&&canUseRecords?<button type="button" className="button-secondary" disabled={!project||Boolean(busy)} onClick={()=>void prepareNew()}>견적서 직접 작성</button>:null}
 </div>;
}
