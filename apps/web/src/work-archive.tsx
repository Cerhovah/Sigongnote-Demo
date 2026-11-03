import {ArchiveProcessing} from './archive-processing.js';
import {useEffect,useRef,useState} from 'react';
import type {WorkClient,WorkContext} from './work-client.js';
import {Screen,Notice,Icon,icons} from './work-shell.js';
import {selectedUploads,setupFileIssue,setupUploader,setupPolicyDescription,type SelectedUpload,type SetupPolicy} from './work-setup-upload.js';
/** The save action carries the current storage policy; site and files remain on one screen. */
export function WorkArchive({client,context,onExit,onAddProject,archive=false,initialProject='',initialFiles=[],setupFlow=false,onBackToSetup}:{client:WorkClient;context:WorkContext;onExit:(project?:string)=>void;onOpen:(id:string,project:string)=>void;onAddProject?:()=>void;archive?:boolean;initialProject?:string;initialFiles?:File[];setupFlow?:boolean;onBackToSetup?:()=>void}){
 const [policy,setPolicy]=useState<SetupPolicy|null>(null),[project,setProject]=useState(context.projects?.some(p=>p.id===initialProject)?initialProject:context.projects?.length===1?context.projects[0]!.id:''),[files,setFiles]=useState<SelectedUpload[]>(()=>selectedUploads(initialFiles)),[error,setError]=useState(''),[uploading,setUploading]=useState(false),[attempted,setAttempted]=useState(false);
 const [,redraw]=useState(0),folder=useRef<HTMLInputElement>(null),single=useRef<HTMLInputElement>(null),abort=useRef<AbortController|null>(null),upload=useRef<ReturnType<typeof setupUploader>|null>(null),alive=useRef(true),saving=useRef(false);
 useEffect(()=>{alive.current=true;void client.request<{policy:SetupPolicy|null}>({route:'setup.read'}).then(r=>{if(alive.current)setPolicy(r.policy);},()=>{if(alive.current)setError('저장 연결을 확인하지 못했어요. 다시 열어 주세요.');});return()=>{alive.current=false;abort.current?.abort();};},[client]);
 useEffect(()=>{if(initialProject&&!project&&context.projects?.some(p=>p.id===initialProject))setProject(initialProject);},[context.projects,initialProject,project]);
 const accepted=files.filter(f=>!setupFileIssue(f.file)),skipped=files.filter(f=>setupFileIssue(f.file)),done=files.filter(f=>f.done).length,remaining=accepted.some(f=>!f.done&&!f.terminal),site=context.projects?.find(p=>p.id===project)?.display_name;
 function choose(list:FileList|null){if(!list?.length)return;setFiles(selectedUploads(Array.from(list)));upload.current=null;setError('');setAttempted(false);}
 async function send(){if(!policy||!project||saving.current||!accepted.length)return;saving.current=true;setUploading(true);setError('');setAttempted(true);abort.current=new AbortController();upload.current??=setupUploader(client,project,policy,policy.external_processing,archive);
  try{await upload.current(files,abort.current.signal,()=>{if(alive.current)redraw(n=>n+1);});if(files.some(f=>f.done)){window.dispatchEvent(new Event('journal-changed'));window.dispatchEvent(new Event('photos-changed'));}}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'저장을 마치지 못했어요.');}finally{saving.current=false;if(alive.current)setUploading(false);}}
 const complete=attempted&&!uploading&&accepted.length>0&&done===accepted.length;
 return <div className="setup-layout"><Screen focusKey="add-material" title={complete?'저장했어요':initialFiles.length?'어느 현장 사진인가요?':archive?'기존 자료 정리':'자료 추가'} back={{label:'뒤로',onBack:()=>{if(!uploading)(onBackToSetup??onExit)();}}}>
 {archive&&context.can_maintain&&!attempted&&<ArchiveProcessing client={client}/>}
 {!complete?<>
 <label className="field">현장<select value={project} disabled={uploading||attempted} onChange={e=>{setProject(e.target.value);upload.current=null;}}><option value="">현장 선택</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
 {!context.projects?.length&&onAddProject?<button type="button" className="button-secondary" onClick={onAddProject}>현장 추가</button>:null}
 {!files.length?<div className="upload-choose"><button type="button" className="button-primary" onClick={()=>single.current?.click()}><Icon d={icons.plus} size={22}/>자료 선택</button>{archive&&<button type="button" className="text-button" onClick={()=>folder.current?.click()}>폴더째 선택</button>}</div>:<>
 <ul className="upload-file-list">{files.map(f=><li key={f.id}><Icon d={f.done?icons.check:icons.doc} size={22}/><span>{f.file.name}{f.error?<small role="alert">{f.error}</small>:setupFileIssue(f.file)?<small>{setupFileIssue(f.file)}</small>:null}</span></li>)}</ul>
 {!attempted&&<button type="button" className="text-button" onClick={()=>single.current?.click()}>다른 자료 선택</button>}
 {policy&&!attempted?<p className="upload-policy">저장하면 선택한 자료를 다음 조건으로 처리·보관합니다. {setupPolicyDescription(policy)}.</p>:null}
 <button type="button" className="button-primary" disabled={!project||!accepted.length||!policy||uploading||attempted&&!remaining} onClick={()=>void send()}>{uploading?`${done}/${accepted.length}개 저장 중…`:attempted?'못 보낸 자료 다시 저장':initialFiles.length?'이 현장에 저장':'저장하고 정리'}</button>
 {uploading?<button type="button" className="text-button" onClick={()=>abort.current?.abort()}>전송 중지</button>:null}
 {done>0&&!uploading&&<button type="button" className="button-secondary" onClick={()=>onExit(project)}>저장한 자료 보기</button>}
 </>}
 </>:<div className="upload-finished"><Icon d={icons.check} size={40}/><h2>{done}개 자료 · {site}</h2><p>업무일지에 기록했어요.</p><button type="button" className="button-primary" onClick={()=>onExit(project)}>{setupFlow?'자료 확인':'업무일지 보기'}</button></div>}
 {skipped.length>0&&<p className="muted">지원하지 않는 자료 {skipped.length}개는 제외합니다.</p>}
 {error&&<Notice tone="warn" role="alert">{error}</Notice>}
 <input hidden ref={folder} type="file" multiple {...{webkitdirectory:''}} onChange={e=>{choose(e.target.files);e.target.value='';}}/><input hidden ref={single} type="file" multiple onChange={e=>{choose(e.target.files);e.target.value='';}}/>
 </Screen></div>;
}
