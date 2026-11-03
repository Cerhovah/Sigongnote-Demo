import {useCallback,useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';
import {WorkContextLearning} from './work-context-learning.js';
type Case={id:string;version:number;state:string;reason:string|null;prompt:string;created_at:string};
type Report={consent:{allowed:boolean};summary:{available:number;unreviewed:number;corrections:number;new_facts:number};cases:Case[];next_cursor:string|null};
type Detail={id:string;version:number;state:string;reason:string|null;snapshot:Record<string,unknown>;proposal:unknown;answer:unknown;result:unknown;history:unknown;current:unknown;trace:unknown;evidence:{id:string;revision_number:number;source_hash:string}[];ground_truth:boolean};
const labels:Record<string,string>={unreviewed:'아직 분류하지 않음',confirmed:'당시 판단이 맞음',correction:'당시 판단 오류',new_fact:'이후 새 사실',excluded:'평가에서 제외'};
const show=(v:unknown)=>JSON.stringify(v,null,2);
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const array=(v:unknown)=>Array.isArray(v)?v:[];
const money=(v:unknown)=>typeof v==='string'&&/^\d+$/.test(v)?BigInt(v).toLocaleString('ko-KR')+'원':'알 수 없음';
function effects(v:unknown){return array(v).map(value=>{const e=record(value);switch(e.kind){case 'quality':return '보완 조치: '+String(e.action);case 'schedule':return '다음 일정: '+String(e.date);case 'acceptance':return `인수 ${e.quantity??'알 수 없음'}${e.unit??''} / 발주 ${e.ordered??'알 수 없음'}${e.unit??''}`;case 'liability':return '비용 부담: '+(e.party==='company'?'우리 회사':e.party==='customer'?'고객':e.party==='supplier'?'공급처':'별도 확인');case 'charge_adjustment':return '원가 조정: '+money(e.amount_minor);case 'prepare_invoice':return '청구서 초안 준비 (발행·송금 아님)';default:return '별도 업무 결과';}});}
function state(v:unknown){const s=record(v),a=record(s.acceptance),q=record(s.quality);return [s.schedule?'다음 일정: '+String(s.schedule):null,a.quantity!==undefined?`인수 ${a.quantity}${a.unit??''} / 발주 ${a.ordered??'알 수 없음'}${a.unit??''}`:null,q.action?'보완 조치: '+String(q.action)+(q.complete===true?' · 완료 확인':' · 완료 미확인'):null,s.liability?'비용 부담: '+(s.liability==='company'?'우리 회사':s.liability==='supplier'?'공급처':s.liability==='customer'?'고객':'별도 확인'):null].filter((v):v is string=>!!v);}
function Lines({values}:{values:string[]}){const counts=new Map<string,number>();for(const v of values)counts.set(v,(counts.get(v)??0)+1);return values.length?<ul>{[...counts].map(([v,n])=><li key={v}>{v}{n>1?' · '+n+'건':''}</li>)}</ul>:<p>기록 없음 · 완료나 0으로 보지 않아요.</p>;}
function CaseReading({detail}:{detail:Detail}){const current=record(detail.current);return <>
 <details><summary>당시 근거와 버전</summary><dl><dt>판단 기간</dt><dd>{String(detail.snapshot.period??'알 수 없음')}</dd><dt>판단 주체</dt><dd>{detail.snapshot.actor_kind==='system'?'기억한 기준에 따른 자동 처리':'담당자 확인'}</dd><dt>규칙판</dt><dd>{detail.snapshot.rule_version==='work-command-v1'?'업무 판단 1판':'별도 처리판'}</dd><dt>판단 전 상태</dt><dd><Lines values={state(detail.snapshot.before_state)}/></dd></dl></details>
 <details><summary>당시 제안</summary><Lines values={effects(record(detail.proposal).effects)}/></details>
 <details open><summary>실제로 반영한 답</summary><Lines values={effects(detail.answer)}/></details>
 <details><summary>당시 결과</summary><Lines values={state(detail.result)}/></details>
 <details><summary>현재 결과와 후속 반영</summary>{current.available===false?<p>현재 결과의 근거 접근을 확인하지 못했어요.</p>:<><Lines values={state(current.state)}/><p>후속 반영 최대 100건</p><Lines values={array(current.effects).flatMap(e=>effects(record(e).effects))}/></>}</details>
 <details><summary>모델·비용 기록 (최대 100개)</summary>{array(detail.trace).length?array(detail.trace).map(v=>{const t=record(v);return <dl key={String(t.id??show(v))}><dt>모델</dt><dd>{String(t.model??'알 수 없음')}</dd><dt>처리판</dt><dd>{[t.prompt_version,t.schema_version,t.parser_version].filter(Boolean).map(String).join(' · ')||'알 수 없음'}</dd><dt>확정 비용</dt><dd>{t.cost_known===true?money(t.cost_minor):'알 수 없음 (예약액은 확정 청구가 아님)'}</dd></dl>;}):<p>연결된 모델 호출 기록이 없어요.</p>}</details>
 <details><summary>분류 변경 이력</summary><Lines values={array(detail.history).map(v=>{const h=record(v);return `${h.version}판 · ${labels[String(h.state)]??'미분류'}${h.reason?' · '+String(h.reason):''}`;})}/></details>
 </>;}
export function WorkLearning({client,id,onSelect}:{client:WorkClient;id?:string|null;onSelect?:(id:string|null)=>void}){
 const [report,setReport]=useState<Report|null>(null),[detail,setDetail]=useState<Detail|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [classification,setClassification]=useState(''),[reason,setReason]=useState(''),[confirmDelete,setConfirmDelete]=useState(false),[confirmRevoke,setConfirmRevoke]=useState(false);
 const generation=useRef(0),selected=useRef<string|null>(id??null),seenVersion=useRef<number|null>(null),mutation=useRef(false),alive=useRef(true),retry=useRef<{key:string;id:string}|null>(null);
 const load=useCallback(async(cursor?:string)=>{
  const epoch=++generation.current;setBusy(true);setError('');
  try{const value=await client.request<Report>({route:'learning.list',...(cursor?{cursor}:{})});
   const target=id??selected.current,next=target?await client.request<Detail>({route:'learning.read',id:target}):null;
   if(epoch!==generation.current)return;if(next&&seenVersion.current!==null&&seenVersion.current!==next.version){setClassification('');setReason('');setNotice('분류가 바뀌어 최신 기록을 가져왔어요. 다시 확인해 주세요.');}seenVersion.current=next?.version??null;setReport(old=>cursor&&old?{...value,cases:[...old.cases,...value.cases]}:value);setDetail(next);
  }catch{if(epoch===generation.current){selected.current=null;seenVersion.current=null;setClassification('');setReason('');setReport(null);setDetail(null);setError('권한·동의 또는 연결 상태를 확인하지 못해 기록을 가렸어요. 다시 확인해 주세요.');}}
  finally{if(epoch===generation.current)setBusy(false);}
 },[client,id]);
 useEffect(()=>{alive.current=true;void load();const refresh=()=>{if(document.visibilityState==='hidden'){generation.current++;setReport(null);setDetail(null);}else if(!mutation.current)void load();};
  const timer=setInterval(()=>{if(document.visibilityState!=='hidden'&&!mutation.current)void load();},30000);
  document.addEventListener('visibilitychange',refresh);return()=>{alive.current=false;generation.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[load]);
 async function choose(id:string|null){if(onSelect){onSelect(id);return;}selected.current=id;seenVersion.current=null;setDetail(null);setClassification('');setReason('');setConfirmDelete(false);setNotice('');await load();}
 async function send(payload:Record<string,unknown>){
  if(mutation.current)return;mutation.current=true;generation.current++;setBusy(true);setError('');setNotice('');
  const key=show(payload);if(retry.current?.key!==key)retry.current={key,id:workId()};
  const command={...payload,command_id:retry.current.id};
  // Protected content never stays visible while consent/deletion is being changed.
  setDetail(null);if(payload.action!=='review'){setReport(null);selected.current=null;}
  try{await client.request({route:'learning.command',command:JSON.stringify(command)});if(!alive.current)return;retry.current=null;setReason('');setClassification('');setConfirmDelete(false);setConfirmRevoke(false);setNotice('저장했어요. 업무 기록과 금액은 바뀌지 않았어요.');if(id&&payload.action!=='review'&&onSelect){onSelect(null);return;}await load();}
  catch(e){if(!alive.current)return;const code=(e as {code?:string}).code;if(['VERSION_CONFLICT','INVALID_CONTRACT','DOMAIN_INVARIANT'].includes(code??''))retry.current=null;
   setReport(null);setError(code==='VERSION_CONFLICT'?'다른 변경이 있어요. 다시 확인한 뒤 분류해 주세요.':code==='DOMAIN_INVARIANT'?'이 사례의 분류 변경 한도에 도달했어요. 다시 보내도 저장되지 않아요.':code==='INVALID_CONTRACT'?'입력 내용을 저장할 수 없어요. 기록을 다시 확인하고 내용을 고쳐 주세요.':'저장 결과를 확인하지 못했어요. 다시 확인한 뒤 같은 내용을 다시 보내면 중복 저장하지 않아요.');}
  finally{mutation.current=false;if(alive.current)setBusy(false);}
 }
 return <section data-activity-ignore="true" aria-label="관리자 판단 개선 기록">
  <p>판단 당시의 근거·제안·실제 반영 결과를 회사 안에서 비교합니다. 클릭은 정답이 아니며, 이후 새 사실은 당시 오류와 따로 구분해요.</p>
  <p>별도 동의 이후의 판단만 최대 90일 보관합니다. 원문 권한이 철회되면 사용을 막고 삭제합니다. 회사 밖 학습 공유는 하지 않아요.</p>
  {!id&&<p><a href="#/more/improvements">확인한 사례로 개선안 비교</a></p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button type="button" disabled={busy} onClick={()=>void load()}>기록 다시 확인</button>
  {report&&!id&&<>
   <p>내 개선 기록 수집: {report.consent.allowed?'켜짐':'꺼짐'} · 일반 사용 기록 동의와 별도예요.</p>
   <button type="button" disabled={busy} onClick={()=>report.consent.allowed?setConfirmRevoke(true):void send({action:'consent',allowed:true,purpose:'company-improvement-v1'})}>{report.consent.allowed?'개선 동의 철회하고 내 사례 삭제':'회사 내부 개선에 동의하고 수집 시작'}</button>
   {confirmRevoke&&<fieldset><legend>개선 동의 철회 확인</legend><p>내 개선 사례와 분류 이력을 모두 삭제하며 복구되지 않아요. 원래 업무 기록·금액·기억한 정책은 보존합니다.</p><button type="button" disabled={busy} onClick={()=>void send({action:'consent',allowed:false,purpose:'company-improvement-v1'})}>동의 철회·삭제 확인</button><button type="button" disabled={busy} onClick={()=>setConfirmRevoke(false)}>철회 취소</button></fieldset>}
   <p>사용 가능 {report.summary.available}건 · 미분류 {report.summary.unreviewed}건 · 당시 오류 {report.summary.corrections}건 · 새 사실 {report.summary.new_facts}건</p>
   {!report.cases.length&&<p>아직 사용할 판단 사례가 없어요. 동의 후 실제 업무에서 반영한 판단이 여기에 쌓입니다.</p>}
   <ul className="row-list">{report.cases.map(c=><li key={c.id}><button type="button" className="row" disabled={busy} onClick={()=>void choose(c.id)}><span><strong>{c.prompt}</strong><small>{labels[c.state]} · {new Date(c.created_at).toLocaleString('ko-KR')}</small></span></button></li>)}</ul>
   {report.next_cursor&&<button type="button" disabled={busy} onClick={()=>void load(report.next_cursor!)}>이전 사례 더 보기</button>}
  </>}
  {!id&&report?.consent.allowed&&<WorkContextLearning client={client}/>}
  {detail&&<article aria-label="판단 사례 상세">
   <h2>{String(detail.snapshot.prompt??'판단 사례')}</h2><p>{labels[detail.state]} · {detail.ground_truth?'관리자가 평가용으로 확인함':'평가 정답으로 사용하지 않음'}</p>
   {detail.reason&&<p>분류 이유: {detail.reason}</p>}
   <p>원문판 {detail.evidence.map(e=>e.revision_number).join(', ')} · 아래 기록은 당시와 현재를 구분합니다.</p>
   {detail.evidence.map(e=><p key={e.id}><a href={'#/materials/item/'+e.id}>원문 {e.revision_number}판 확인</a></p>)}
   <CaseReading detail={detail}/>
   <p>맞음·오류 분류는 위의 ‘실제로 반영한 답’이 정답임을 확인하는 뜻이에요. 제안이 틀려 답을 고쳤다면 오류로 분류하고 이유를 적어 주세요. 반영한 답도 틀렸다면 평가에서 제외해 주세요. 이 분류는 업무의 금액·상태를 수정하지 않아요.</p>
   <label>사례 분류<select value={classification} disabled={busy} onChange={e=>setClassification(e.target.value)}><option value="">직접 선택</option>{Object.entries(labels).filter(([key])=>key!=='unreviewed').map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>확인 근거와 수정 이유<textarea value={reason} maxLength={1000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
   <button type="button" disabled={busy||!classification||reason.trim().length<3} onClick={()=>void send({action:'review',id:detail.id,version:detail.version,state:classification,reason:reason.trim()})}>분류 저장</button>
   <button type="button" disabled={busy} onClick={()=>setConfirmDelete(true)}>이 개선 사례 삭제</button>
   {confirmDelete&&<fieldset aria-label="개선 사례 삭제 확인"><p>학습용 사본과 분류 이력을 지웁니다. 원래 업무 판단·원장·기억한 정책은 보존해요.</p><button type="button" disabled={busy} onClick={()=>void send({action:'delete',id:detail.id,version:detail.version})}>삭제 확인</button><button type="button" onClick={()=>setConfirmDelete(false)}>취소</button></fieldset>}
   <button type="button" disabled={busy} onClick={()=>void choose(null)}>상세 닫기</button>
  </article>}
 </section>;
}
