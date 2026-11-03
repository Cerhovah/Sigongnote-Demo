import {useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
export function ArchiveReference({client,id,onSaved}:{client:WorkClient;id:string;onSaved:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const pending=useRef<string|null>(null);
 const read=async()=>{if(busy)return;setBusy(true);setError('');pending.current??=JSON.stringify({revision_id:id,client_command_id:workId()});try{await client.request({route:'archive.command',command:pending.current});onSaved();}catch{setError('반영 여부를 확인하지 못했어요. 같은 버튼으로 다시 확인해 주세요.');}finally{setBusy(false);}};
 return <section className="notice"><p>과거 자료로 보관 중입니다. 지금 업무에 필요한 이 자료만 읽을 수 있어요. 기존 연결의 외부 처리 동의와 비용 한도가 적용됩니다.</p><button type="button" className="button-secondary" disabled={busy} onClick={()=>void read()}>{busy?'연결 중…':'이 자료만 현재 업무에 참고하기'}</button>{error&&<p role="alert">{error}</p>}</section>;
}
