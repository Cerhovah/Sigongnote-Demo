import {useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import {Icon,icons} from './work-shell.js';
type Format='pdf'|'xlsx';
type Share={id:string;own:boolean;format:Format;state:string};
type Payload={base64:string;sha256:string;name:string;mime:string};
export async function toFile(f:Payload){
 const bytes=Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0));
 if(crypto.subtle){const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');if(hash!==f.sha256)throw new Error('FILE_INTEGRITY');}
 return new File([bytes],f.name,{type:f.mime});
}
function save(file:File){const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export function DocumentFiles({client,id,shares=[],onRefresh}:{client:WorkClient;id:string;shares?:Share[];onRefresh:()=>void}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[ready,setReady]=useState<{intent:string;file:File}|null>(null);
 const active=useRef(false),alive=useRef(true),keys=useRef(new Map<string,string>());
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 function key(name:string){let value=keys.current.get(name);if(!value){value=workId();keys.current.set(name,value);}return value;}
 async function outcome(intent:string,value:'unknown'|'cancelled'|'user_confirmed'){
  await client.request({route:'documents.shareOutcome',id,intent_id:intent,client_command_id:key(`${intent}:${value}`),outcome:value});
  if(alive.current)onRefresh();
 }
 async function act(format:Format,action:'open'|'save'|'share'){
  if(active.current)return;active.current=true;setBusy(true);setMessage('');
  let intent:string|undefined;
  try{
   if(action==='share'){const i=await client.request<{id:string;sha256:string}>({route:'documents.share',id,format,client_command_id:key(`share:${format}`)});intent=i.id;}
   if(client.kind==='native'){
    const result=await client.request<{outcome:'unknown'|'cancelled';message?:string}>({route:'documents.file',id,format,action});
    if(intent){await outcome(intent,result.outcome);keys.current.delete(`share:${format}`);}
    if(alive.current)setMessage(result.message??'문서 공유를 취소했어요.');
   }else{
    const payload=await client.request<Payload>({route:'documents.file',id,format}),file=await toFile(payload);
    if(!alive.current)return;
    if(intent)setReady({intent,file});else{save(file);setMessage('다운로드를 요청했어요. 브라우저의 다운로드 목록에서 열어 주세요.');}
   }
  }catch{if(alive.current)setMessage('파일 준비나 결과 저장을 마치지 못했어요. 연결 후 다시 눌러주세요. 문서를 재발행하지 않습니다.');}
  finally{active.current=false;if(alive.current)setBusy(false);}
 }
 async function shareReady(){
  if(!ready||active.current)return;active.current=true;setBusy(true);
  let state:'unknown'|'cancelled'='unknown';
  try{
   // Called directly from a second user activation: asynchronous preparation cannot preserve it.
   if(navigator.canShare?.({files:[ready.file]}))await navigator.share({files:[ready.file]});
   else save(ready.file);
   if(alive.current)setMessage('파일을 공유하거나 저장하도록 요청했어요. 상대가 받았는지는 별도로 확인해 주세요.');
  }catch(e){if(e instanceof Error&&e.name==='AbortError')state='cancelled';if(alive.current)setMessage(state==='cancelled'?'공유를 취소했어요.':'공유 결과를 확인하지 못했어요. 파일을 저장해 직접 첨부할 수 있어요.');}
  try{await outcome(ready.intent,state);keys.current.delete(`share:${ready.file.name.endsWith('.pdf')?'pdf':'xlsx'}`);}catch{if(alive.current)setMessage('공유 결과를 저장하지 못했어요. 다시 연결되면 아래 발행 내역에서 확인해 주세요.');}
  finally{active.current=false;if(alive.current){setBusy(false);setReady(null);}}
 }
 async function confirm(intent:string){if(active.current)return;active.current=true;setBusy(true);try{await outcome(intent,'user_confirmed');if(alive.current)setMessage('보냈다는 확인을 기록했어요. 상대 수신·입금 확인과는 구분됩니다.');}catch{if(alive.current)setMessage('확인을 저장하지 못했어요. 연결 후 다시 눌러주세요.');}finally{active.current=false;if(alive.current)setBusy(false);}}
 const latest=shares[0];
 const unconfirmed=shares.filter(s=>s.own&&s.state==='unknown').slice(0,1);
 return <section className="document-files" aria-label="문서 보내기" data-guide="document-share">
  {ready?<div className="card share-ready"><p><strong>{ready.file.name}</strong><br/>보낼 파일을 준비했어요.</p><button type="button" className="button-primary" disabled={busy} onClick={()=>void shareReady()}><Icon d={icons.share} size={24}/><span>{navigator.canShare?.({files:[ready.file]})?'공유창 열기':'저장해서 메일·메신저에 첨부'}</span></button></div>:<button type="button" className="button-primary" disabled={busy} onClick={()=>void act('pdf','share')}><Icon d={icons.share} size={24}/><span>{client.kind==='native'?'PDF 공유':'PDF 공유 준비'}</span></button>}
  {unconfirmed.map(s=><button key={s.id} type="button" className="button-secondary" disabled={busy} onClick={()=>void confirm(s.id)}>이 문서를 보냈어요</button>)}
  {message?<p role="status" className="notice notice-info">{message}</p>:null}
  {latest?<p className="muted">최근 공유: {latest.state==='user_confirmed'?'보냈다고 확인했어요':latest.state==='cancelled'?'공유를 취소했어요':'상대가 받았는지는 아직 몰라요'}</p>:null}
  <details className="quiet-details"><summary>PDF·엑셀 열기, 저장</summary><div className="stack">{(['pdf','xlsx'] as const).map(format=><div key={format} className="stack">{client.kind==='native'?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void act(format,'open')}>{format==='pdf'?'PDF 열기':'엑셀 열기'}</button>:null}<button type="button" className="button-secondary" disabled={busy} onClick={()=>void act(format,'save')}>{format==='pdf'?'PDF 받기':'엑셀 받기'}</button>{format==='xlsx'?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void act(format,'share')}>{client.kind==='native'?'엑셀 공유':'엑셀 공유 준비'}</button>:null}</div>)}</div></details>
  <p className="muted">공유창을 열어도 전달·입금 완료로 표시하지 않아요.</p>
 </section>;
}
