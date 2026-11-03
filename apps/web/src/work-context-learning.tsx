import {useCallback,useEffect,useRef,useState} from 'react';
import type {WorkClient} from './work-client.js';
import {workId} from './work-id.js';

type CorrectionCase={id:string;version:number;state:string;eligible:boolean;source_ref:string;source_version:string;snapshot:{previous:{summary:string;project_name:string|null};replacement:{summary:string;project_name:string|null};evidence:{id:string;kind:string;version:string}[]};review_reason:string|null};
type Evaluation={independent:number;matched:number;wrong:number;abstained:number;leakage:number;canPromote:boolean};
type Procedure={id:string;version:number;state:string;usable:boolean;evaluation:Evaluation|null;train_ids:string[]};
type Report={consent:{allowed:boolean};cases:CorrectionCase[];procedures:Procedure[]};

/** Site-reading corrections have their own evidence and owner-reviewed lifecycle. */
export function WorkContextLearning({client}:{client:WorkClient}){
 const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<string[]>([]),[reasons,setReasons]=useState<Record<string,string>>({});
 const epoch=useRef(0),alive=useRef(true),retry=useRef<{body:string;id:string}|null>(null);
 const load=useCallback(async()=>{const current=++epoch.current;try{const value=await client.request<Report>({route:'context-learning.list'});if(alive.current&&current===epoch.current){setReport(value);setError('');setSelected(previous=>previous.filter(id=>value.cases.some(c=>c.id===id&&c.state==='adopted')));}}catch{if(alive.current&&current===epoch.current){setReport(null);setSelected([]);setError('교정 사례를 확인하지 못했어요. 권한과 연결을 다시 확인해 주세요.');}}},[client]);
 useEffect(()=>{alive.current=true;void load();const refresh=()=>{if(document.visibilityState==='hidden'){epoch.current++;setReport(null);}else void load();};document.addEventListener('visibilitychange',refresh);const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load();},30000);return()=>{alive.current=false;epoch.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[load]);
 async function send(payload:Record<string,unknown>){if(busy)return;setBusy(true);setError('');const body=JSON.stringify(payload);if(retry.current?.body!==body)retry.current={body,id:workId()};try{await client.request({route:'context-learning.command',command:JSON.stringify({...payload,command_id:retry.current.id})});retry.current=null;if(alive.current)await load();}catch{if(alive.current){setReport(null);setError('저장 결과를 확인하지 못했어요. 다시 확인한 뒤 같은 내용을 보내면 중복 저장하지 않아요.');}}finally{if(alive.current)setBusy(false);}}
 const stateNames:Record<string,string>={shadow:'새 자료에서 비교 중',promoted:'읽기 절차 사용 중',withdrawn:'사용 중지'};
 return <section aria-label="현장 연결 교정 학습" data-activity-ignore="true">
  <h2>현장 연결 교정</h2>
  {error&&<p role="alert">{error}<button type="button" disabled={busy} onClick={()=>void load()}>다시 확인</button></p>}
  {report&&!report.consent.allowed?<p>회사 내부 개선에 동의한 뒤의 실제 교정을 여기서 확인합니다.</p>:report?<>
   {!report.cases.length&&<p>아직 확인할 현장 교정이 없어요.</p>}
   <ul className="row-list">{report.cases.map(c=><li key={c.id}>
    <p>{c.snapshot.previous.project_name??'현장 미특정'} → <strong>{c.snapshot.replacement.project_name??'현장 미특정'}</strong></p>
    <p>{c.snapshot.replacement.summary}</p>
    <details><summary>당시 근거 확인</summary><p>교정 전: {c.snapshot.previous.summary}</p>{c.snapshot.evidence.map(e=><p key={e.kind+e.id}><a href={'#/materials/item/'+e.id}>근거 열기</a> · 저장한 판 {e.version.split(':')[0]}</p>)}</details>
    {c.state==='adopted'?<><label><input type="checkbox" disabled={busy} checked={selected.includes(c.id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))}/>확인한 정답 · 읽기 절차 후보에 사용</label><button type="button" disabled={busy} onClick={()=>void send({action:'case.review',id:c.id,version:c.version,state:'excluded',reason:'정답 채택 철회'})}>정답 채택 취소</button></>:c.state==='excluded'?<p>학습에서 제외했어요.</p>:<>
     <label>확인한 이유<input value={reasons[c.id]??''} maxLength={500} disabled={busy} onChange={event=>setReasons(previous=>({...previous,[c.id]:event.target.value}))}/></label>
     <button type="button" disabled={busy||!c.eligible||!reasons[c.id]?.trim()} onClick={()=>void send({action:'case.review',id:c.id,version:c.version,state:'adopted',reason:reasons[c.id]!.trim()})}>이 교정을 정답으로 확인</button>
     <button type="button" disabled={busy||!reasons[c.id]?.trim()} onClick={()=>void send({action:'case.review',id:c.id,version:c.version,state:'excluded',reason:reasons[c.id]!.trim()})}>학습에서 제외</button>
    </>}
   </li>)}</ul>
   {report.cases.some(c=>c.state==='adopted')&&<button type="button" disabled={busy||!selected.length} onClick={()=>void send({action:'procedure.create',case_ids:selected})}>선택한 사례로 읽기 절차 비교 시작</button>}
   <ul className="row-list">{report.procedures.map(p=><li key={p.id}>
    <strong>{stateNames[p.state]??p.state}</strong><p>최근 기록에서 현장 후보를 찾고 현재 근거로 다시 확인합니다.</p>
    {p.evaluation?<p>나중에 들어온 독립 자료 {p.evaluation.independent}건 · 일치 {p.evaluation.matched} · 오류 {p.evaluation.wrong} · 미특정 {p.evaluation.abstained} · 평가에 섞인 학습 자료 {p.evaluation.leakage}</p>:<p>새 자료와 확인한 정답이 쌓이면 비교할 수 있어요.</p>}
    {p.state==='shadow'&&<><button type="button" disabled={busy||!p.usable} onClick={()=>void send({action:'procedure.evaluate',id:p.id,version:p.version})}>새 자료 비교 결과 확인</button><button type="button" disabled={busy||!p.usable||!p.evaluation?.canPromote} onClick={()=>void send({action:'procedure.promote',id:p.id,version:p.version})}>이 읽기 절차 사용</button></>}
    {p.state!=='withdrawn'&&<button type="button" disabled={busy} onClick={()=>void send({action:'procedure.withdraw',id:p.id,version:p.version})}>절차 사용 중지</button>}
   </li>)}</ul>
  </>:null}
 </section>;
}
