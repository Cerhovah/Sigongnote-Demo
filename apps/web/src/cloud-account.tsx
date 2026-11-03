import {useCallback,useEffect,useRef,useState} from 'react';
import {cloudJson} from './cloud-connection.js';
import {WorkFailure} from './work-client.js';
/** Keep the work tree mounted; the browser/device back key closes this screen first. */
export function useAccountHistory(){
 const [open,setOpen]=useState(false);
 useEffect(()=>{const sync=()=>setOpen(window.history.state?.cloudAccount===true);window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync);},[]);
 const show=()=>{if(!open){window.history.pushState({...window.history.state,cloudAccount:true},'');setOpen(true);}};
 const close=()=>{if(window.history.state?.cloudAccount)window.history.back();else setOpen(false);};
 const reset=useCallback(()=>{if(window.history.state?.cloudAccount){const {cloudAccount:_,...state}=window.history.state;window.history.replaceState(state,'');}setOpen(false);},[]);
 return {open,show,close,reset};
}
const labels:Record<string,string>={'custom:naver':'네이버','custom:kakao':'카카오',google:'Google'};
export function CloudAccountPanel({user,providers,onClose,onChanged}:{user:string;providers:string[];onClose:()=>void;onChanged:()=>void}){
 const [linked,setLinked]=useState<string[]|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),heading=useRef<HTMLHeadingElement>(null),active=useRef(true);
 useEffect(()=>{active.current=true;heading.current?.focus();return()=>{active.current=false;};},[]);
 // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries the same connection lookup after an outage.
 useEffect(()=>{let alive=true;void cloudJson('/web/session?connections=1').then(p=>{if(!alive)return;if(p.user_id!==user){onChanged();return;}setLinked(p.linked_providers);setMessage('');},()=>{if(alive)setMessage('로그인 수단을 확인하지 못했어요. 연결 상태를 확인한 뒤 다시 눌러 주세요.');});return()=>{alive=false;};},[user,refresh,onChanged]);
 async function link(provider:string){setBusy(true);setMessage('');try{const r=await cloudJson('/web/auth/start',{provider,expected_user_id:user});if(active.current)location.assign(r.url);}catch(e){if(!active.current)return;if(e instanceof WorkFailure&&['login_required','account_changed'].includes(e.code))onChanged();else setMessage('계정 연결을 시작하지 못했어요. 공급자 설정을 확인해야 할 수 있어요. 기존 회사와 자료는 그대로예요.');setBusy(false);}}
 return <main className="card" aria-labelledby="cloud-account-title"><h1 id="cloud-account-title" tabIndex={-1} ref={heading}>내 로그인 수단</h1><p>지금 사용 중인 계정에 본인 로그인 수단을 추가합니다. 회사와 자료는 그대로 이어집니다. 브라우저에서 본인 계정인지 확인해 주세요.</p>{message?<p role="status">{message}</p>:null}{linked===null?<button type="button" className="button-secondary" onClick={()=>setRefresh(v=>v+1)}>연결 다시 확인</button>:providers.map(p=><p key={p}>{linked.includes(p)?<span>{labels[p]} · 연결됨</span>:<button type="button" className="button-secondary" disabled={busy} onClick={()=>void link(p)}>내 {labels[p]}로도 로그인하기</button>}</p>)}<button type="button" className="button-quiet" onClick={onClose}>회사로 돌아가기</button></main>;
}
