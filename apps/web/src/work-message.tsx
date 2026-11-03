import {useEffect,useState} from 'react';
import type {WorkClient} from './work-client.js';
type Message={source_kind:'sms'|'manual_share';kind:'sms'|'mms';direction:'received'|'sent';occurred_at:string;body:string;missing_parts:number;parts:{id:string;mime:string;bytes_base64:string}[]};
export function WorkMessage({client,id}:{client:WorkClient;id:string}){
 const [message,setMessage]=useState<Message|null>(null),[error,setError]=useState(''),[requested,setRequested]=useState(false);
 useEffect(()=>{if(!requested)return;let live=true;void client.request<Message>({route:'materials.message',id}).then(value=>{if(live)setMessage(value);},()=>{if(live)setError('문자를 열지 못했어요. 연결과 자료 허용을 확인해 주세요.');});return()=>{live=false;};},[client,id,requested]);
 return <section aria-label="문자와 첨부사진"><h3>문자와 첨부사진</h3>{!requested?<button type="button" className="button-secondary" onClick={()=>setRequested(true)}>문자·첨부사진 함께 보기</button>:null}{error?<p role="alert">{error}</p>:null}{requested&&!message&&!error?<p role="status">문자와 사진을 가져오고 있어요…</p>:null}{message?<>
  <p>{message.source_kind==='sms'?'휴대폰에서 연결한 문자':'가져온 문자 (자동 수집 아님)'}</p>
  <p>{message.source_kind==='sms'?'':'자료에 기재된 '}{message.direction==='received'?'받은 시각':'보낸 시각'} · {new Date(message.occurred_at).toLocaleString('ko-KR')}</p>
  <p style={{whiteSpace:'pre-wrap'}}>{message.body||'본문이 없는 사진 문자입니다.'}</p>
  {message.missing_parts>0?<p role="status">첨부 {message.missing_parts}개를 읽지 못했습니다. 휴대폰 문자앱에서 다운로드 상태를 확인해 주세요.</p>:null}
  {message.parts.filter(p=>['image/jpeg','image/png','image/webp'].includes(p.mime)).map((p,i)=><figure key={p.id}><img src={`data:${p.mime};base64,${p.bytes_base64}`} alt={`문자 첨부사진 ${i+1}`} style={{maxWidth:'100%',maxHeight:600,objectFit:'contain'}}/><figcaption>첨부사진 {i+1} · 문자 원문과 함께 보관</figcaption></figure>)}
 </>:null}</section>;
}
