import {PhotoSheetPrepare} from './work-photo-sheet.js';
import {useEffect,useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import {workId} from './work-id.js';
import {Notice} from './work-shell.js';
export type PhotoSelection={revision_id:string;caption:string;location:string;taken_date:string|null;rotation:0|90|180|270};
type Photo={id:string;sha256:string;created_at:string;project_id:string|null;context_id:string|null;work_label:string|null};
export type PhotoGroup={id:string;version:number;project_id:string;project_name:string;context_id:string|null;title:string;photos:PhotoSelection[];snapshot_hash:string;context_conflict:boolean};
type Listing={photos:Photo[];next_cursor:string|null;groups:{id:string;title:string}[]};
export function WorkPhotos({client,context,project,setProject,id,onOpen,onPrepared,onCapture}:{client:WorkClient;context:WorkContext;project:string;setProject:(id:string)=>void;id?:string;onOpen:(id:string)=>void;onPrepared?:(id:string)=>void;onCapture?:()=>void}){
 const [data,setData]=useState<Listing>({photos:[],groups:[],next_cursor:null}),[selected,setSelected]=useState<PhotoSelection[]>([]),[group,setGroup]=useState<PhotoGroup|null>(null),[title,setTitle]=useState('현장 사진'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[images,setImages]=useState<Record<string,{base64:string;exif_date_hint:string|null}>>({});
 const pending=useRef<{body:string;key:string}|null>(null),saving=useRef(false);
 const projectName=context.projects?.find(p=>p.id===project)?.display_name??'현장';
 useEffect(()=>{const refreshPhotos=()=>{if(document.visibilityState==='visible'&&!saving.current&&!selected.length)setRefresh(v=>v+1);};window.addEventListener('focus',refreshPhotos);document.addEventListener('visibilitychange',refreshPhotos);return()=>{window.removeEventListener('focus',refreshPhotos);document.removeEventListener('visibilitychange',refreshPhotos);};},[selected.length]);
 // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the explicit reload action after saving or asking for new photos.
 useEffect(()=>{let live=true;setImages({});setGroup(null);setSelected([]);setData({photos:[],groups:[],next_cursor:null});setBusy(true);
  const load=async()=>{try{if(id){const g=await client.request<PhotoGroup>({route:'photos.group',id});if(!live)return;const clean={...g,photos:g.photos.map(p=>({revision_id:p.revision_id,caption:p.caption,location:p.location,taken_date:p.taken_date,rotation:p.rotation}))};setGroup(clean);setTitle(g.title);setSelected(clean.photos);setData({photos:g.photos.map(p=>({id:p.revision_id,sha256:'',created_at:'',project_id:g.project_id,context_id:g.context_id,work_label:null})),groups:[],next_cursor:null});}else if(project){const d=await client.request<Listing>({route:'photos.list',project_id:project});if(!live)return;setData(d);setTitle(projectName+' 사진');}}catch{if(live)setMessage('사진을 불러오지 못했어요. 연결과 자료 권한을 확인한 뒤 다시 열어 주세요.');}finally{if(live)setBusy(false);}};void load();return()=>{live=false;};
 },[client,id,project,refresh,projectName]);
 useEffect(()=>{let live=true;void(async()=>{for(const p of data.photos){if(!live)return;try{const image=await client.request<{base64:string;exif_date_hint:string|null}>({route:'photos.preview',id:p.id});if(live)setImages(v=>({...v,[p.id]:image}));}catch{/* An unreadable preview must not discard a selected original. */}}})();return()=>{live=false;};},[client,data.photos]);
 function toggle(p:Photo){setSelected(items=>items.some(x=>x.revision_id===p.id)?items.filter(x=>x.revision_id!==p.id):items.length<20?[...items,{revision_id:p.id,caption:'',location:'',taken_date:null,rotation:0}]:items);}
 function change(index:number,patch:Partial<PhotoSelection>){setSelected(items=>items.map((p,i)=>i===index?{...p,...patch}:p));}
 function move(index:number,delta:number){setSelected(items=>{const next=[...items],to=index+delta;if(to>=0&&to<next.length)[next[index],next[to]]=[next[to]!,next[index]!];return next;});}
 async function save(){if(saving.current||!selected.length||!(group?.project_id??project))return;saving.current=true;setBusy(true);setMessage('');
  const contexts=new Set(selected.map(p=>data.photos.find(x=>x.id===p.revision_id)?.context_id).filter(Boolean));
  const body={...(group?{id:group.id,expected_version:group.version}:{}),project_id:group?.project_id??project,context_id:group?.context_id??(contexts.size===1?[...contexts][0]:null),title,photos:selected};const serialized=JSON.stringify(body);
  if(pending.current?.body!==serialized)pending.current={body:serialized,key:workId()};
  try{const result=await client.request<{id:string}>({route:'photos.command',command:JSON.stringify({...body,client_command_id:pending.current.key})});pending.current=null;if(id===result.id)setRefresh(v=>v+1);else onOpen(result.id);setMessage('사진 순서와 설명을 저장했어요. 원본은 그대로예요.');}catch(e){const code=(e as {code?:string}).code;if(code==='VERSION_CONFLICT'){pending.current=null;setMessage('다른 기기에서 먼저 저장했어요. 새 사진 확인을 누르면 지금 편집한 내용 대신 최신 저장 내용을 불러옵니다.');}else setMessage(code==='SOURCE_SCOPE_MISMATCH'?'다른 현장이나 다른 일의 사진이 함께 있어요. 같은 일의 사진끼리 골라 주세요.':'저장 결과를 확인하지 못했어요. 같은 내용으로 다시 누르면 이어서 확인해요.');}finally{saving.current=false;setBusy(false);}
 }
 return <section className="photo-work">
  {!id?<label className="field">사진을 모을 현장<select value={project} onChange={e=>{setMessage('');setProject(e.target.value);}}><option value="">현장 선택</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>:<p>{group?.project_name}</p>}
  {onCapture||client.capturePhoto?<button type="button" className="button-secondary" onClick={onCapture??(()=>client.capturePhoto?.())}>사진 찍기</button>:null}
  <button type="button" className="button-quiet" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>새 사진 확인</button>
  {message?<Notice role="status">{message}</Notice>:null}{group?.context_conflict?<Notice tone="warn">사진의 현장 정보가 바뀌었어요. 같은 현장 사진을 다시 골라 주세요.</Notice>:null}
  {busy?<p role="status">사진을 확인하고 있어요…</p>:null}
  {!id&&data.groups.length?<div className="card"><h2 className="card-title">모아 둔 사진</h2>{data.groups.map(g=><button type="button" className="button-secondary" key={g.id} onClick={()=>onOpen(g.id)}>{g.title}</button>)}</div>:null}
  {!busy&&!data.photos.length&&project?<p>사진 없음</p>:null}
  <div className="photo-grid">{data.photos.map(p=>{const picked=selected.findIndex(x=>x.revision_id===p.id);return <label className="photo-card" key={p.id}>
   <input type="checkbox" checked={picked>=0} disabled={busy||picked<0&&selected.length>=20} onChange={()=>toggle(p)}/><span>{picked>=0?`${picked+1}번째 사진`:p.work_label??'현장 사진'}</span>
   {images[p.id]?<img alt={picked>=0?selected[picked]!.caption||`${picked+1}번째 현장 사진`:'선택할 현장 사진'} src={'data:image/jpeg;base64,'+images[p.id]!.base64}/>:<span className="photo-placeholder">미리보기 확인 중 · 원본 선택 가능</span>}
   <small>{p.project_id?'현장 연결됨':'현장 확인 전 · 선택한 현장에 모아요'}</small><small>{images[p.id]?.exif_date_hint?'사진에 기록된 시각: '+images[p.id]!.exif_date_hint:'촬영일 확인 전'}</small>
  </label>;})}</div>
  {data.next_cursor&&!id?<button type="button" className="button-secondary" disabled={busy} onClick={()=>{setBusy(true);void client.request<Listing>({route:'photos.list',project_id:project,cursor:data.next_cursor!}).then(d=>setData(v=>({...d,photos:[...v.photos,...d.photos]}))).catch(()=>setMessage('다음 사진을 가져오지 못했어요.')).finally(()=>setBusy(false));}}>사진 더 보기</button>:null}
  {selected.length?<><label className="field">제목<input value={title} maxLength={120} onChange={e=>setTitle(e.target.value)}/></label><p>{selected.length}장 선택 · 순서와 설명은 필요한 것만 바꾸세요.</p>
   {selected.map((p,i)=><details key={p.revision_id} className="card"><summary>{i+1}번째 사진 · {p.caption||'설명 추가·순서 바꾸기'}</summary><label className="field">짧은 설명<input value={p.caption} maxLength={180} onChange={e=>change(i,{caption:e.target.value})}/></label><label className="field">위치<input value={p.location} maxLength={100} onChange={e=>change(i,{location:e.target.value})}/></label><label className="field">확인한 촬영일<input type="date" value={p.taken_date??''} onChange={e=>change(i,{taken_date:e.target.value||null})}/></label><button type="button" className="button-quiet" onClick={()=>change(i,{rotation:((p.rotation+90)%360) as 0|90|180|270})}>오른쪽으로 돌리기 · {p.rotation}도</button><button type="button" className="button-quiet" disabled={i===0} onClick={()=>move(i,-1)}>앞으로</button><button type="button" className="button-quiet" disabled={i===selected.length-1} onClick={()=>move(i,1)}>뒤로</button></details>)}
   <div className="screen-action"><button type="button" className="button-primary" disabled={busy||!title.trim()} onClick={()=>void save()}>사진 순서·설명 저장</button></div>
  </>:null}
  {group&&onPrepared&&!busy&&JSON.stringify(selected)===JSON.stringify(group.photos)&&title===group.title?<PhotoSheetPrepare client={client} group={group} onOpen={onPrepared}/>:null}
 </section>;
}
