import {useEffect,useRef,useState} from 'react';
import type {WorkClient,WorkContext,NativeSetupStatus,SetupSourceKind} from './work-client.js';
import {Notice,Screen} from './work-shell.js';
import {workId} from './work-id.js';
import {platformOf,windowsFolderSetup,windowsRecordingSetup} from './work-platform.js';
import {WorkArchive} from './work-archive.js';

type Setup={project_id:string|null;version:number;dismissed:boolean;completed:boolean};
const sourceNames={photos:'사진 폴더',call_recording:'통화 녹음',sms:'업무 문자'};
/** Optional connections and site creation. Neither is a prerequisite for opening work. */
export function WorkSetup({client,context,onExit,onAdd,onBack,mode='onboarding'}:{client:WorkClient;context:WorkContext;onExit:(project?:string)=>void;onOpen?:(id:string,project:string)=>void;onAdd?:(project:string)=>void;onBack?:()=>void;mode?:'onboarding'|'site'}){
 const platform=platformOf(client),siteMode=mode==='site',desktop=platform==='windows'||platform==='local'&&Boolean(window.chrome?.webview);
 const [setup,setSetup]=useState<Setup|null>(null),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[upload,setUpload]=useState(false);
 const [native,setNative]=useState<NativeSetupStatus|null>(null),[connecting,setConnecting]=useState<SetupSourceKind|null>(null),[message,setMessage]=useState('');
 const pending=useRef<{body:string;key:string}|null>(null),alive=useRef(true),saving=useRef(false);
 useEffect(()=>{alive.current=true;if(siteMode)void client.request<Setup>({route:'setup.read'}).then(s=>{if(alive.current)setSetup(s);},()=>{if(alive.current)setError('현장을 불러오지 못했어요.');});
  else if(client.nativeSetup)void client.nativeSetup.status().then(s=>{if(alive.current)setNative(s);},()=>{});
  return()=>{alive.current=false;};
 },[client,siteMode]);
 async function createSite(){
  if(!setup||saving.current||!name.trim())return;saving.current=true;setBusy(true);setError('');
  const data={action:'select',expected_version:setup.version,display_name:name.trim()},body=JSON.stringify(data);
  if(pending.current?.body!==body)pending.current={body,key:workId()};
  try{const result=await client.request<Setup>({route:'setup.command',command:JSON.stringify({...data,client_command_id:pending.current.key})});if(alive.current){pending.current=null;onExit(result.project_id??undefined);}}
  catch(e){if(alive.current){setError('저장하지 못했어요. 다시 눌러 주세요.');if((e as {code?:string}).code==='VERSION_CONFLICT'){pending.current=null;try{const latest=await client.request<Setup>({route:'setup.read'});if(alive.current){setSetup(latest);setError('현장 목록이 바뀌었어요. 다시 눌러 주세요.');}}catch{/* Retry keeps the entered name. */}}}}
  finally{saving.current=false;if(alive.current)setBusy(false);}
 }
 async function connect(kind:SetupSourceKind){
  if(!client.nativeSetup||connecting)return;setConnecting(kind);setMessage('');
  try{await client.nativeSetup.connect(kind);if(alive.current){const status=await client.nativeSetup.status();if(alive.current){setNative(status);setMessage((status.folderCloudReady??0)>0?'연결한 자료를 불러옵니다.':'연결을 마치지 못했어요. 다시 눌러 주세요.');}}}
  catch(e){if(alive.current)setMessage(['folder_cancelled','folder_not_selected'].includes((e as {code?:string}).code??'')?'취소했어요.':'연결하지 못했어요. 다시 눌러 주세요.');}
  finally{if(alive.current)setConnecting(null);}
 }
 const leave=onBack??(()=>onExit());
 if(upload)return <WorkArchive client={client} context={context} initialProject="" onExit={id=>onExit(id)} onOpen={()=>{}} setupFlow onBackToSetup={()=>setUpload(false)}/>;
 return <div className="setup-layout"><Screen focusKey={siteMode?'new-site':'connections'} title={siteMode?'현장 추가':'자료 연결'} back={{label:'뒤로',onBack:leave}}>
  {siteMode?<form className="setup-fields" onSubmit={event=>{event.preventDefault();void createSite();}}>
   <label>현장 이름<input maxLength={180} placeholder="현장 이름" value={name} onChange={event=>setName(event.target.value)}/></label>
   <button type="submit" className="button-primary" disabled={busy||!setup||!name.trim()}>{busy?'저장 중…':'이 현장 추가'}</button>
  </form>:<div className="connection-actions">
   {client.kind!=='native'?<button type="button" className="button-primary" onClick={()=>onAdd?onAdd(''):setUpload(true)}>파일 추가</button>:client.capturePhoto?<button type="button" className="button-primary" onClick={()=>client.capturePhoto?.()}>사진 찍기</button>:<button type="button" className="button-primary" onClick={()=>onExit()}>업무로 돌아가기</button>}
   {(desktop||platform==='android')&&<details className="quiet-details"><summary>자동 수집 연결</summary>
    {desktop?<><a className="button-secondary" href={windowsFolderSetup}>폴더 연결</a><a className="button-secondary" href={windowsRecordingSetup}>녹음 폴더 연결</a></>:<>{(['photos','call_recording',...(native?.smsOriginal==='policy_gated'?['sms']:[])] as SetupSourceKind[]).map(kind=><button key={kind} type="button" className="button-secondary" disabled={Boolean(connecting)||!client.nativeSetup} onClick={()=>void connect(kind)}>{connecting===kind?'연결 중…':sourceNames[kind]}</button>)}{native&&(native.folderCloudReady??0)>0&&<p className="muted">연결한 폴더 {native.folderCloudReady}개</p>}</>}
   </details>}
   {message&&<Notice role="status">{message}</Notice>}
  </div>}
  {error&&<Notice tone="warn" role="alert">{error}{!setup&&siteMode&&<button type="button" className="text-button" onClick={()=>void client.request<Setup>({route:'setup.read'}).then(value=>{setSetup(value);setError('');},()=>{})}>다시 확인</button>}</Notice>}
 </Screen></div>;
}
