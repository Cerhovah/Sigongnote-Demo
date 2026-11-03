import {useEffect,useRef,useState} from 'react';
import {WorkFailure,type WorkClient} from './work-client.js';
export type ChangePage={changes:{kind:string;id:string|null;tombstone:boolean;sequence:string}[];next_cursor:string;has_more:boolean};
/** Persist only an identity-scoped cursor, never private materials or bearer tokens. */
export async function catchUp(client:WorkClient,cursor:string|undefined,apply:(page:ChangePage)=>Promise<void>,save:(cursor:string)=>void){
 const page=await client.request<ChangePage>({route:'sync.changes',sync_version:2,...(cursor?{cursor}:{})});
 await apply(page);save(page.next_cursor);return page;
}
/** Polls the change feed. Only a lost connection is shown in the header; a healthy link stays out of the way (still announced to readers). */
export function WorkSync({client,scope,onChange,localOnly=false}:{client:WorkClient;scope:string;onChange:(reset:boolean)=>void;localOnly?:boolean}){
 const [message,setMessage]=useState('변경된 자료를 확인하고 있어요…'),[state,setState]=useState<'wait'|'ok'|'off'>('wait'),callback=useRef(onChange);callback.current=onChange;
 useEffect(()=>{
  let live=true,running=false,cursor:string|undefined,timer:ReturnType<typeof setTimeout>;
  let changed=false,reset=false,photos=false;const documents=new Set<string>();
  const key=`sigongnote:sync:v2:${scope}`;
  try{cursor=localStorage.getItem(key)??undefined;}catch{/* Restricted browser storage: replay from start. */}
  async function poll(){
   if(!live||running)return;running=true;let more=false;
   try{
    const page=await catchUp(client,cursor,async data=>{if(!live)throw new Error('closed');for(const c of data.changes){if(c.kind==='reset')reset=true;if(c.kind==='material')changed=true;if(c.kind==='photo_sheet')photos=true;if(c.kind==='document'&&c.id)documents.add(c.id);}},value=>{if(live){cursor=value;try{localStorage.setItem(key,value);}catch{/* Safe replay on restart. */}}});
    more=page.has_more;if(!more&&live){if(changed||reset)callback.current(reset);if(photos||reset)window.dispatchEvent(new Event('photos-changed'));if(documents.size||reset)window.dispatchEvent(new CustomEvent('documents-changed',{detail:{ids:[...documents],reset}}));changed=false;reset=false;photos=false;documents.clear();}if(live){setState(more?'wait':'ok');setMessage(more?'그동안 바뀐 자료를 이어 받고 있어요…':'연결됨 · 다른 기기의 변경도 자동으로 확인해요');}
   }catch(e){if(live){if(e instanceof WorkFailure&&['INVALID_CONTRACT','DOMAIN_INVARIANT'].includes(e.code)){cursor=undefined;try{localStorage.removeItem(key);}catch{}}setState('off');setMessage('연결 대기 · 마지막으로 확인한 자료예요. 연결되면 자동으로 이어 받아요.');}}
   finally{running=false;if(live)timer=setTimeout(()=>void poll(),more?50:5000);}
  }
  const wake=()=>{clearTimeout(timer);void poll();};window.addEventListener('online',wake);window.addEventListener('focus',wake);void poll();
  return()=>{live=false;clearTimeout(timer);window.removeEventListener('online',wake);window.removeEventListener('focus',wake);};
 },[client,scope]);
 const label=state==='ok'?(localOnly?'이 PC에 연결됨':'연결됨'):state==='off'?'연결 대기':'확인 중';
 const description=state==='ok'&&localOnly?'이 PC의 작업실에 연결됨 · 운영·휴대폰 자료와 별도로 저장돼요':message;
 return <p className={`sync-pill sync-${state}${state==='off'?'':' sr-only'}`} role="status" title={description}><span className="sync-dot" aria-hidden="true"/><span aria-hidden="true">{label}</span><span className="sr-only">{description}</span></p>;
}
