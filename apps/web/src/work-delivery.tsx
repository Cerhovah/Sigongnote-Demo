import {useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import {toFile} from './work-document-files.js';

type Delivery={id:string;title:string;pages:number;recipient_name:string;recipient_number:string;scope_hash:string;state:string;cancel_reason:string|null;available:boolean;attempts:number;submitted_attempts:number;pending_cost_krw:number;known_cost_krw:number;reserved_krw:number|null;actual_krw:number|null};
type Listing={deliveries:Delivery[];recipients:{id:string;name:string;number:string}[];project_id:string;ready:boolean;max_cost_krw:number|null;gate:string|null};
const states:Record<string,string>={prepared:'아직 보내지 않았어요',authorized:'전송 대기 중 · 취소할 수 있어요',submitted:'팩스 업체가 처리 중이에요',delivered:'팩스 전송 완료 · 상대 열람은 별도 확인',failed:'팩스 전송 실패',unknown:'전송 결과를 확인 중이에요. 다시 보내기 전 상대에게 도착 여부를 확인해 주세요.',cancelled:'전송 취소됨'};
const reasons:Record<string,string>={expired:'전송 승인 시간이 지났어요. 문서와 받는 곳을 확인하고 다시 보내 주세요.',price_over_cap:'팩스 요금이 승인한 상한보다 높아요. 관리자에게 요금 설정 확인을 요청해 주세요.',source_changed:'문서 또는 연결 권한이 바뀌었어요. 현재 문서를 다시 열어 주세요.',account_changed:'팩스 계정 또는 시험·실운영 설정이 바뀌었어요. 연결 상태를 확인하고 다시 승인해 주세요.',user_cancelled:'요청하신 대로 보내기 전에 취소했어요.'};
const faxNumber=(v:string)=>v.replace(/^(02)(\d{3,4})(\d{4})$/,'$1-$2-$3').replace(/^(0[1-9]\d)(\d{3,4})(\d{4})$/,'$1-$2-$3');
export function DeliveryPanel({client,kind,id}:{client:WorkClient;kind:'document'|'photo_sheet';id:string}){
 const [data,setData]=useState<Listing|null>(null),[name,setName]=useState(''),[number,setNumber]=useState(''),[picked,setPicked]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[refresh,setRefresh]=useState(0),[risk,setRisk]=useState(''),[open,setOpen]=useState(false),[confirm,setConfirm]=useState<string|null>(null);
 const active=useRef(false),pending=useRef<{body:string;key:string}|null>(null);
 const needsPoll=data?.deliveries.some(d=>['authorized','submitted','unknown'].includes(d.state)||(d.reserved_krw!==null&&d.actual_krw===null))??false;
 // biome-ignore lint/correctness/useExhaustiveDependencies: Changing source or client must discard the old authorization and idempotency intent.
 useEffect(()=>{setData(null);setPicked('');setRisk('');setConfirm(null);setMessage('');pending.current=null;},[client,kind,id]);
 // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads persisted delivery state after a command.
 useEffect(()=>{if(!open)return;let live=true;async function load(){try{const d=await client.request<Listing>({route:'deliveries.list',source_kind:kind,source_id:id});if(live)setData(d);}catch{if(live){setData(null);setMessage('전달 내용을 열지 못했어요. 문서 상태와 연결을 확인해 주세요.');}}}void load();const timer=needsPoll?setInterval(()=>void load(),15000):undefined;return()=>{live=false;if(timer)clearInterval(timer);};},[client,kind,id,refresh,open,needsPoll]);
 async function prepare(){if(!data||active.current)return;active.current=true;setBusy(true);try{await client.request<{delivery:Delivery}>({route:'deliveries.prepare',command:JSON.stringify({project_id:data.project_id,source_kind:kind,source_id:id,...(picked?{recipient_id:picked}:{recipient_name:name.trim(),recipient_number:number.replace(/[\s-]/g,'')})})});setMessage('받는 곳과 문서를 준비했어요. 확인하고 보내기를 누르면 전송합니다.');setRefresh(v=>v+1);setRisk('');setConfirm(null);}catch{setMessage('받는 곳 이름과 팩스번호를 확인해 주세요.');}finally{active.current=false;setBusy(false);}}
 async function authorize(d:Delivery,retry=false){if(active.current||!data?.ready||!data.max_cost_krw)return;active.current=true;setBusy(true);const body={id:d.id,scope_hash:d.scope_hash,max_cost_krw:data.max_cost_krw,retry,duplicate_risk_ack:retry&&risk===d.id},text=JSON.stringify(body);if(pending.current?.body!==text)pending.current={body:text,key:workId()};try{await client.request({route:'deliveries.authorize',command:JSON.stringify({...body,client_command_id:pending.current.key})});pending.current=null;setMessage('전송 요청을 저장했어요. 화면을 닫아도 결과를 확인합니다.');setRisk('');setConfirm(null);setRefresh(v=>v+1);}catch{setMessage('전송 승인을 마치지 못했어요. 발송 한도·문서·연결 상태를 확인하고 다시 눌러 주세요.');}finally{active.current=false;setBusy(false);}}
 async function cancel(d:Delivery){if(active.current)return;active.current=true;setBusy(true);try{const r=await client.request<{cancelled:boolean;message?:string}>({route:'deliveries.cancel',command:JSON.stringify({id:d.id,scope_hash:d.scope_hash})});setMessage(r.message??'전송을 취소했어요.');setConfirm(null);setRefresh(v=>v+1);}catch{setMessage('취소 결과를 확인하지 못했어요. 상태를 다시 확인해 주세요.');}finally{active.current=false;setBusy(false);}}
 return <details className="quiet-details" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>팩스로 보내기 · 전달 내역</summary>
  {message?<p role="status">{message}</p>:null}{data?<>
   <p>{data.gate??`이 문서 발송비 상한 ${data.max_cost_krw?.toLocaleString('ko-KR')}원. 결과 확인 전에는 비용을 예약합니다.`}</p>
   <form onSubmit={e=>{e.preventDefault();void prepare();}}>
    {data.recipients.length?<label className="field">전에 보낸 곳<select value={picked} onChange={e=>{setPicked(e.target.value);setMessage('');}}><option value="">새 받는 곳</option>{data.recipients.map(r=><option key={r.id} value={r.id}>{r.name} · {faxNumber(r.number)}</option>)}</select></label>:null}
    {!picked?<><label className="field">받는 곳<input required maxLength={30} value={name} onChange={e=>setName(e.target.value)}/></label><label className="field">팩스번호<input required inputMode="tel" value={number} maxLength={16} onChange={e=>setNumber(e.target.value)} placeholder="지역번호부터 입력"/></label></>:null}
    <button type="submit" className="button-secondary" disabled={busy}>받는 곳 확인</button>
   </form>
   {data.deliveries.map(d=>{const retry=d.state!=='prepared',needsAck=retry&&d.submitted_attempts>0,canSend=['prepared','delivered','failed','unknown','cancelled'].includes(d.state)&&d.available&&d.submitted_attempts<3;return <article className="card" key={d.id}>
    <h3>{d.title} · {d.pages}쪽</h3><p>{d.recipient_name} · {faxNumber(d.recipient_number)}</p>
    <p role="status">{states[d.state]??'결과 확인 중'}</p>{d.cancel_reason?<p>{reasons[d.cancel_reason]}</p>:null}
    {d.attempts>0?<p>접수 요청 {d.submitted_attempts}회 · 확인된 비용 {d.known_cost_krw.toLocaleString('ko-KR')}원{d.pending_cost_krw>0?` · 확인 중인 비용 ${d.pending_cost_krw.toLocaleString('ko-KR')}원 예약`:''}</p>:null}
    {canSend?<>
     {needsAck?<label><input type="checkbox" checked={risk===d.id} onChange={e=>{setRisk(e.target.checked?d.id:'');setConfirm(null);}}/> 상대에게 중복 도착할 수 있음을 확인했고 다시 보내겠습니다.</label>:null}
     <button type="button" className="button-secondary" disabled={busy||!data.ready||(needsAck&&risk!==d.id)} onClick={()=>setConfirm(d.id)}>{needsAck?'다시 보내기 확인':`이 문서를 ${d.recipient_name}에 팩스 보내기`}</button>
     {confirm===d.id?<section className="card" aria-label="보내기 전 확인"><h3>이 내용으로 보낼까요?</h3><p>{d.title} · {d.pages}쪽</p><p>{d.recipient_name}</p><h3>{faxNumber(d.recipient_number)}</h3><p>이번 발송비는 최대 {data.max_cost_krw?.toLocaleString('ko-KR')}원입니다.</p><button type="button" className="button-primary" disabled={busy||!data.ready||(needsAck&&risk!==d.id)} onClick={()=>void authorize(d,retry)}>네, 보냅니다</button><button type="button" className="button-quiet" disabled={busy} onClick={()=>setConfirm(null)}>아니요</button></section>:null}
    </>:null}
    {['prepared','authorized'].includes(d.state)?<button type="button" className="button-quiet" disabled={busy} onClick={()=>void cancel(d)}>전송 취소</button>:null}
   </article>;})}
  </>:null}
 </details>;
}
export function PhotoSheetShare({client,id}:{client:WorkClient;id:string}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[ready,setReady]=useState<{file:File;intent:string}|null>(null);const running=useRef(false),pending=useRef<string|null>(null);
 const record=(intent:string,outcome:'prepared'|'unknown'|'cancelled')=>client.request({route:'sheets.share',command:JSON.stringify({id,intent_id:intent,outcome})});
 async function prepare(){if(running.current)return;running.current=true;setBusy(true);const intent=pending.current??workId();pending.current=intent;try{await record(intent,'prepared');if(client.kind==='native'){const r=await client.request<{outcome:'unknown'|'cancelled';message?:string}>({route:'sheets.file',id,format:'pdf',action:'share'});await record(intent,r.outcome);pending.current=null;setMessage(r.message??'공유창을 열었어요. 상대 수신은 아직 확인되지 않았어요.');}else{const f=await client.request<{base64:string;sha256:string;name:string;mime:string}>({route:'sheets.file',id,format:'pdf'});setReady({file:await toFile(f),intent});}}catch{setMessage('공유 준비 또는 결과 기록을 마치지 못했어요. 연결 후 다시 확인해 주세요.');}finally{running.current=false;setBusy(false);}}
 async function share(){if(!ready||running.current)return;running.current=true;setBusy(true);let outcome:'unknown'|'cancelled'='unknown';try{if(navigator.canShare?.({files:[ready.file]}))await navigator.share({files:[ready.file]});else{const url=URL.createObjectURL(ready.file),a=document.createElement('a');a.href=url;a.download=ready.file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}}catch(e){if(e instanceof Error&&e.name==='AbortError')outcome='cancelled';}try{await record(ready.intent,outcome);pending.current=null;setMessage(outcome==='cancelled'?'공유를 취소했어요.':'파일 공유·저장을 요청했어요. 상대가 받았는지는 따로 확인해 주세요.');}catch{setMessage('공유 결과를 저장하지 못했어요. 상대 수신은 확인되지 않았어요.');}finally{setReady(null);running.current=false;setBusy(false);}}
 return <section><button type="button" className="button-secondary" disabled={busy} onClick={()=>void(ready?share():prepare())}>{ready?'공유창 열기 · 미지원 브라우저는 파일 저장':client.kind==='native'?'사진대지 공유':'사진대지 공유 준비'}</button>{message?<p role="status">{message}</p>:null}</section>;
}
