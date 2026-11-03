import {useEffect,useRef,useState} from "react";
import {Icon,icons,Notice} from "./work-shell.js";
import type {WorkClient,WorkContext} from "./work-client.js";
import {workId} from "./work-id.js";
import {CaptureStatusResponseSchema as storageSchema} from '@sigongnote/contracts';
import type {z} from 'zod';
const gb=(value:number)=>(value/1_000_000_000).toLocaleString('ko-KR',{maximumFractionDigits:2});

type FolderBinding={id:string;source_id:string;source_generation:number;scope_mode:"project"|"company_common"|"unassigned";project_id:string|null;version:number;display_name?:string|null};
type FolderBindings={bindings:FolderBinding[]};
function choice(binding:FolderBinding){return binding.scope_mode==="project"&&binding.project_id?binding.project_id:binding.scope_mode;}

/** Native apps keep each OS folder grant; the website never pretends to watch a phone's disk. */
export function WorkFolders({client,context}:{client:WorkClient;context:WorkContext}){
 const native=client.kind==="native",local=client.kind==="local",fixture=client.kind==="fixture";
 const href=native?(window.SigongnoteNative?"/assets/index.html#folders":"https://sigongnote.work/settings"):local?"/#today/folders":null;
 const [bindings,setBindings]=useState<FolderBinding[]>([]),[draft,setDraft]=useState<Record<string,string>>({}),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[message,setMessage]=useState("");
 const epoch=useRef(0),pending=useRef<{payload:string;key:string}|null>(null);
 const canEdit=context.can_resolve_site!==false;
 const [storage,setStorage]=useState<z.infer<typeof storageSchema>|null>(null),[storageError,setStorageError]=useState(false);
 // biome-ignore lint/correctness/useExhaustiveDependencies: A native client may retain identity while its account/company changes; reload within the new authorization scope.
 useEffect(()=>{let active=true;setStorage(null);setStorageError(false);
  client.request({route:'capture.status'}).then(value=>{const status=storageSchema.parse(value);if(active)setStorage(status);}).catch(()=>{if(active)setStorageError(true);});
  return()=>{active=false;};
 },[client,context.tenant_id,context.user_id]);
 // biome-ignore lint/correctness/useExhaustiveDependencies: Account/company transitions invalidate selections and pending commands even when the client is reused.
 useEffect(()=>{const current=++epoch.current;setBindings([]);setDraft({});setMessage("");setLoading(true);setSaving(false);pending.current=null;
  client.request<FolderBindings>({route:"folders.read"}).then(value=>{if(epoch.current===current){setBindings(value.bindings);setDraft(Object.fromEntries(value.bindings.map(binding=>[binding.id,choice(binding)])));}})
   .catch(()=>{if(epoch.current===current)setMessage("연결된 폴더 목록을 아직 못 가져왔어요. 잠시 후 다시 열어 주세요.");}).finally(()=>{if(epoch.current===current)setLoading(false);});
  return()=>{epoch.current++;};
 },[client,context.tenant_id,context.user_id]);
 const changes=bindings.filter(binding=>(draft[binding.id]??choice(binding))!==choice(binding)).map(binding=>{
  const value=draft[binding.id]!;return {id:binding.id,expected_version:binding.version,source_generation:binding.source_generation,
   scope_mode:value==="company_common"||value==="unassigned"?value:"project",project_id:value==="company_common"||value==="unassigned"?null:value};
 });
 async function save(){if(saving||!changes.length||!canEdit)return;const current=epoch.current,payload=JSON.stringify(changes);
  if(pending.current?.payload!==payload)pending.current={payload,key:workId()};setSaving(true);setMessage("");
  try{await client.request({route:"folders.correct",command:JSON.stringify({client_command_id:pending.current.key,changes})});
   const value=await client.request<FolderBindings>({route:"folders.read"});if(epoch.current!==current)return;
   setBindings(value.bindings);setDraft(Object.fromEntries(value.bindings.map(binding=>[binding.id,choice(binding)])));pending.current=null;
   setMessage("폴더 분류를 함께 저장했어요. 연결된 폴더는 계속 읽고 있어요.");
  }catch(error){if(epoch.current!==current)return;const conflict=(error as {code?:string}).code==="VERSION_CONFLICT";
   setMessage(conflict?"다른 기기에서 폴더 연결이 바뀌었어요. 최신 연결을 확인한 뒤 다시 선택해 주세요.":"아직 저장을 확인하지 못했어요. 연결을 확인한 뒤 같은 선택으로 다시 저장할 수 있어요.");
   if(conflict){pending.current=null;try{const value=await client.request<FolderBindings>({route:"folders.read"});if(epoch.current===current){setBindings(value.bindings);setDraft(Object.fromEntries(value.bindings.map(binding=>[binding.id,choice(binding)])));}}catch{/* Keep the current selection visible. */}}
  }finally{if(epoch.current===current)setSaving(false);}
 }
 return <div className="stack folder-help">
  <section className="card"><h2 className="card-title">폴더를 연결하면 새 자료가 따라와요</h2><p>견적, 사진, 문서가 모여 있는 업무 폴더를 선택하세요. 원본은 그대로 두고, 허용한 자료를 읽어 현장별로 정리해요.</p>
   <ol className="folder-steps"><li><strong>1. 위치 선택</strong><span>진행 중인 현장 자료가 모인 폴더 하나를 선택해요</span></li><li><strong>2. 한 번에 확인</strong><span>연결할 현장과 읽을 범위·서버 보관·외부 AI 처리를 확인해요</span></li><li><strong>3. 계속 자동 수집</strong><span>그 현장의 새 문서·사진·수정본을 계속 읽고 원장에서 확인해요</span></li></ol>
   <section aria-label="자료 저장 공간"><h3>연결 전에 저장 공간을 확인하세요</h3>
    {storage?<p>내 계정 전체 100 GB 중 저장 {gb(storage.used_bytes)} GB · 전송 예약 {gb(storage.reserved_bytes)} GB · 남은 공간 {gb(Math.max(0,storage.limit_bytes-storage.used_bytes-storage.reserved_bytes))} GB</p>:<p role="status">{storageError?'저장 공간을 확인하지 못했어요. 폴더는 연결할 수 있으며, 전송 전에 서버에서 한도를 다시 확인해요.':'저장 공간을 확인하고 있어요.'}</p>}
    <p className="muted">설치 앱은 한 파일 최대 200 MiB, 기기 내 전송 사본 최대 2 GiB로 나눠 처리해요. 원본 폴더는 그대로 유지해요. 위 용량은 서버 저장량이며 선택할 폴더의 전체 크기는 아니에요.</p>
    {storage&&storage.recovery.failed>0?<Notice tone="warn">내가 이 회사에 올린 자료 중 서버 사본 확인에 실패한 자료가 {storage.recovery.failed}개 있어요. 기기 사본은 보관하며 연결이 돌아오면 다시 확인해요.</Notice>:null}
    {storage?<p className="muted">서버 복원 확인 {storage.recovery.checked}개 · 사본 회수가 필요한 자료를 확인한 결과예요. 전체 자료 복원 검사는 별도예요.</p>:null}
   </section>
   {href?<a className={changes.length?"button-secondary":"button-primary"} href={href}><Icon d="M12 5v14 M5 12h14"/>업무 폴더 추가·관리</a>:<Notice tone="info">{fixture?"지금은 합성자료 체험 화면이에요. 실제 폴더 연결은 설치한 PC·스마트폰 앱에서 진행해 주세요.":"폴더의 변경을 계속 읽으려면 설치한 PC·스마트폰 앱에서 폴더를 연결해 주세요. 웹에서는 같은 계정·회사로 연결된 자료와 결과를 확인할 수 있어요."}</Notice>}
  </section>
  <section className="card" aria-labelledby="folder-binding-title"><h2 id="folder-binding-title" className="card-title">연결된 폴더 분류</h2>
   <p>정확한 현장이 아직 없으면 미확정으로 두세요. 자료 수집은 계속할 수 있어요.</p>
   {loading?<p role="status">연결된 폴더를 확인하고 있어요.</p>:bindings.length?<div className="stack">{bindings.map((binding,index)=><label key={binding.id} className="stack"><strong>{binding.display_name||`연결된 폴더 ${index+1}`}</strong><select aria-label={`${binding.display_name||`연결된 폴더 ${index+1}`} 분류`} value={draft[binding.id]??choice(binding)} disabled={!canEdit||saving} onChange={event=>setDraft(previous=>({...previous,[binding.id]:event.target.value}))}>
    <option value="unassigned">현장 미확정</option><option value="company_common">회사 공통 자료</option>{context.projects?.map(project=><option key={project.id} value={project.id}>{project.display_name}</option>)}
    {binding.project_id&&!context.projects?.some(project=>project.id===binding.project_id)?<option value={binding.project_id}>연결 현장 확인 필요</option>:null}
   </select></label>)}{canEdit?<button type="button" className={changes.length?"button-primary":"button-secondary"} disabled={saving||!changes.length} onClick={()=>void save()}>{saving?"함께 저장하는 중…":`변경한 폴더 ${changes.length}개 한 번에 저장`}</button>:<p className="muted">폴더 분류는 이 회사의 담당자가 변경할 수 있어요.</p>}</div>:<p>이 회사에 연결된 폴더가 아직 없어요.</p>}
   {message?<p role="status">{message}</p>:null}
  </section>
  <section><h2 className="section-title">이 회사의 현장</h2>{context.projects?.length?<ul className="row-list">{context.projects.map(p=><li key={p.id}><a className="row" href={`#/materials/site?project=${encodeURIComponent(p.id)}`}><span><strong>{p.display_name}</strong><small>이 현장에 모인 자료 확인</small></span><Icon d={icons.next} size={22}/></a></li>)}</ul>:<p>폴더를 연결하고 현장을 지정하면 여기에 나타나요.</p>}<p className="muted">현장 목록은 기기에 연결된 폴더 수와 다를 수 있어요. 폴더별 권한과 상태는 추가·관리 화면에서 확인하세요.</p></section>
 </div>;
}
