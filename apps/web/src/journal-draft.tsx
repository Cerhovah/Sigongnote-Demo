import {useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import type {JournalItem} from './work-journal.js';
import {documentNames} from './work-draft.js';
import {workId} from './work-id.js';
import {Notice} from './work-shell.js';
export function JournalDraft({client,context,item,onOpen}:{client:WorkClient;context:WorkContext;item:JournalItem;onOpen:(id:string)=>void}){
 const [open,setOpen]=useState(false),[project,setProject]=useState(item.project_id??''),[type,setType]=useState('estimate'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef<{body:string;command:string}|null>(null);
 if(!item.organization_version||item.reading_state!=='readable'||context.can_maintain===false)return null;
 const prepare=async()=>{if(busy||!project)return;setBusy(true);setError('');const body=JSON.stringify({action:'draft',id:item.id,project_id:project,type,expected_version:item.organization_version});
  const command=pending.current?.body===body?pending.current.command:JSON.stringify({...JSON.parse(body),client_command_id:workId()});pending.current={body,command};
  try{const result=await client.request<{id:string}>({route:'journal.command',command});window.dispatchEvent(new Event('documents-changed'));onOpen(result.id);}
  catch(e){if(['VERSION_CONFLICT','NOT_FOUND'].includes((e as {code?:string}).code??'')){pending.current=null;setError('현장이나 기록이 바뀌었어요. 최신 일지를 다시 확인하고 있어요.');window.dispatchEvent(new Event('focus'));}else setError('초안을 준비하지 못했어요. 같은 요청을 다시 확인해도 중복 생성하지 않아요.');}finally{setBusy(false);}
 };
 return <div className="journal-draft">{!open?<button type="button" className="text-button" onClick={()=>setOpen(true)}>이 기록으로 문서 준비</button>:<form onSubmit={e=>{e.preventDefault();void prepare();}}>
 <p>이 기록이 속한 업무와 근거를 사용해 초안을 준비해요. 추가 견적·계약서는 필요한 것만 자료로 넣어 주세요.</p>
 <label className="field">현장<select value={project} disabled={busy||Boolean(item.project_id)} onChange={e=>setProject(e.target.value)}><option value="">현장 선택</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
 <label className="field">준비할 문서<select value={type} disabled={busy} onChange={e=>setType(e.target.value)}>{Object.entries(documentNames).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
 {error&&<Notice tone="warn" role="alert">{error}</Notice>}
 <button type="submit" className="button-secondary" disabled={busy||!project}>{busy?'준비 중…':'초안 준비하고 내용 확인'}</button><button type="button" className="text-button" disabled={busy} onClick={()=>setOpen(false)}>접기</button>
 </form>}</div>;
}
