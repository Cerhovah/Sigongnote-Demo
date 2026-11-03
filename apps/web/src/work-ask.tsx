import {RememberAnswer} from './work-memory.js';
import {useCallback,useEffect,useRef,useState} from "react";
import {workId} from "./work-id.js";
import {WorkVoice} from "./work-voice.js";
import {evidencePlace} from './work-evidence.js';
import {Icon,icons,Notice} from "./work-shell.js";
import type {WorkClient,WorkContext} from "./work-client.js";
export type AskCard={revision_id:string;title:string;excerpt:string;created_at:string;project_name:string|null;work_label:string|null;organization_state?:string;locator?:string;version_scope?:'latest'|'history'};
export type AskQuestion={id:string;version:number;project_id:string;project_name:string;work_label:string;prompt:string;blocked:string|null;can_defer?:boolean};
type DocumentChoice={type:string;project_id:string;contexts:{id:string;label:string}[];partial:boolean};
export type AskAnswer={next_job?:{id:string;status:"ready"}|null;planner_notice?:string|null;deliveries?:{id:string;source_kind:string;source_id:string;title:string}[];delivery_choices?:boolean;photo_sheets?:{id:string;title:string;state:string}[];photo_choices?:boolean;artifacts?:{id:string;revision_id:string;label:string;number:string;state:string;render_state:string;files:{format:string;sha256:string;byte_length:number}[]}[];run_id?:string;project_id?:string|null;turn_id:string;status:string;text:string;cards:AskCard[];questions?:AskQuestion[];effects?:{decision_id?:string;memory_cost_minor?:string;changed?:string[];needs_answer?:boolean}[];document_choices?:DocumentChoice|null;document_draft?:{id:string;type?:string;latest_id?:string}};
export type Ask={text:string;project:string;answer:AskAnswer|null;busy:boolean;error:string;asked:string;askedSite:string;setVoiceId:(id:string)=>void;setText:(v:string)=>void;setProject:(v:string)=>void;submit:(value?:string,turnId?:string,inputKind?:"text"|"voice")=>Promise<void>;submitFor?:(text:string,project:string)=>Promise<void>;retry:()=>Promise<void>;reset:()=>void;continueRun?:()=>Promise<void>;cancel?:()=>Promise<void>;prepareFor?:(choice:DocumentChoice,context:string)=>Promise<void>;reply?:(q:AskQuestion,text:string,inputKind?:"text"|"voice")=>Promise<void>};
/** One conversation per screen session; a retried request keeps the same turn id so nothing runs twice. */
export function useAsk(client:WorkClient,project:string,setProject:(id:string)=>void,projects:WorkContext["projects"],storageKey?:string):Ask{
 const [text,setText]=useState(""),[answer,setAnswer]=useState<AskAnswer|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[asked,setAsked]=useState("");
 const projectNames=useRef(projects);projectNames.current=projects;
 const [askedSite,setAskedSite]=useState("전체 현장");
 const voiceId=useRef<string|undefined>(undefined);
 const running=useRef(false),conversation=useRef(workId()),pending=useRef<{id:string;text:string;project:string;siteName:string;inputKind:"text"|"voice"}|null>(null);
 const interaction=useRef(0),restoring=useRef(false),restoreRun=useRef<string|null>(null);
 useEffect(()=>{if(!storageKey)return;let disposed=false;try{const saved=localStorage.getItem(storageKey);if(saved&&/^[0-9a-f-]{36}$/.test(saved))conversation.current=saved;else localStorage.setItem(storageKey,conversation.current);}catch{}
  const version=interaction.current;restoring.current=true;
  const current=()=>!disposed&&version===interaction.current;
  void (async()=>{let turns:{text:string;response:AskAnswer}[]=[];let historyFailed=false;
   try{const history=await client.request<{turns:typeof turns}>({route:'conversation.read',id:conversation.current});turns=Array.isArray(history.turns)?history.turns:[];}catch{historyFailed=true;}
   if(!current())return;
   const last=turns.at(-1);if(last){setAsked(last.text);setAnswer(last.response);setAskedSite(projectNames.current?.find(p=>p.id===last.response.project_id)?.display_name??'전체 현장');}
   let restored:string|null=null;let request:{run_id?:string;text?:string}|null=null;
   try{restored=localStorage.getItem(storageKey+':run');request=JSON.parse(localStorage.getItem(storageKey+':request')??'null');}catch{}
   if(restored&&/^[0-9a-f-]{36}$/.test(restored)){
    restoreRun.current=restored;
    try{const result=await client.request<AskAnswer>({route:'agent.read',id:restored});if(!current())return;
     setAnswer(result);setAsked(turns.find(t=>t.response.run_id===restored)?.text??(request?.run_id===restored&&typeof request.text==='string'?request.text:'이전 요청'));
     setAskedSite(projectNames.current?.find(p=>p.id===result.project_id)?.display_name??'전체 현장');restoreRun.current=null;
    }catch{if(current())setError(last?'최신 처리 결과를 불러오지 못해 이전 대화를 표시했어요. 다시 확인해 주세요.':'저장된 처리 결과를 불러오지 못했어요. 다시 확인해 주세요.');}
   }else if(historyFailed)setError('이전 대화를 불러오지 못했어요. 연결 후 화면을 다시 열어 주세요.');
   if(current())restoring.current=false;
  })();return()=>{disposed=true;};
 },[client,storageKey]);
 useEffect(()=>{if(restoring.current||restoreRun.current||!answer?.run_id||!['queued','running'].includes(answer.status))return;let disposed=false,timer:ReturnType<typeof setTimeout>;setBusy(true);
  const poll=async()=>{try{const next=await client.request<AskAnswer>({route:'agent.read',id:answer.run_id!});if(disposed)return;setAnswer(next);setError('');setBusy(['queued','running'].includes(next.status));if(!['queued','running'].includes(next.status))pending.current=null;}catch{if(!disposed){setBusy(false);setError('서버에서 계속 처리하고 있어요. 요청 결과 다시 확인을 눌러 주세요.');}}};
  timer=setTimeout(poll,750);return()=>{disposed=true;clearTimeout(timer);};
 },[client,answer]);
 useEffect(()=>{if(!restoring.current&&!restoreRun.current&&storageKey&&answer?.run_id)try{localStorage.setItem(storageKey+':run',answer.run_id);localStorage.setItem(storageKey+':request',JSON.stringify({run_id:answer.run_id,text:asked}));}catch{}},[storageKey,answer?.run_id,asked]);
 const siteName=projects?.find(p=>p.id===project)?.display_name??(project?"이전에 선택한 현장":"전체 현장");
 const state=useRef({text,project,siteName});state.current={text,project,siteName};
 const submit=useCallback(async(value?:string,turnId?:string,inputKind?:"text"|"voice",retry=false,siteOverride?:string)=>{
   const saved=retry?pending.current:null;
   // A document started from a chosen site is fixed to that site even before the selector's state has caught up.
   const request=saved?.text??(value??state.current.text).trim(),site=saved?.project??siteOverride??state.current.project,name=saved?.siteName??(siteOverride!==undefined?projectNames.current?.find(p=>p.id===siteOverride)?.display_name??(siteOverride?"이전에 선택한 현장":"전체 현장"):state.current.siteName);
  if(running.current||!request)return;interaction.current++;restoring.current=false;restoreRun.current=null;running.current=true;setBusy(true);setError("");setAsked(request);setAnswer(null);if(storageKey)try{localStorage.removeItem(storageKey+':run');localStorage.removeItem(storageKey+':request');}catch{}
   setAskedSite(name);
   if(!pending.current||pending.current.text!==request||pending.current.project!==site)pending.current={id:turnId??(value===undefined?voiceId.current:undefined)??workId(),text:request,project:site,siteName:name,inputKind:inputKind??(value===undefined&&voiceId.current?"voice":"text")};
   voiceId.current=undefined;
   try{const result=await client.request<AskAnswer>({route:"conversation.turn",id:conversation.current,client_turn_id:pending.current.id,text:request,...(pending.current.inputKind==="voice"?{input_kind:"voice" as const}:{}),...(site?{selected_project_id:site}:{})});setAnswer(result);if(state.current.text.trim()===request)setText("");if(!result.run_id)pending.current=null;}
   catch{setError("답을 아직 못 가져왔어요. 다시 요청하면 같은 요청을 이어서 확인해요.");}
  finally{running.current=false;setBusy(false);}
 },[client,storageKey]);
  const reset=useCallback(()=>{setAnswer(null);setError("");setAsked("");},[]);
 const retry=useCallback(async()=>{const run=restoreRun.current??answer?.run_id;if(run){const version=interaction.current;try{const result=await client.request<AskAnswer>({route:'agent.read',id:run});if(version!==interaction.current)return;setAnswer(result);if(restoreRun.current){let saved:null|{run_id?:string;text?:string}=null;try{saved=JSON.parse(localStorage.getItem(storageKey+':request')??'null');}catch{}setAsked(saved?.run_id===run&&typeof saved.text==='string'?saved.text:'이전 요청');setAskedSite(projectNames.current?.find(p=>p.id===result.project_id)?.display_name??'전체 현장');}restoreRun.current=null;setError('');}catch{if(version===interaction.current)setError('아직 연결하지 못했어요. 잠시 후 결과를 다시 확인해 주세요.');}}else await submit(undefined,undefined,"text",true);},[submit,client,answer?.run_id,storageKey]);
 const cancel=useCallback(async()=>{if(!answer?.run_id)return;try{setAnswer(await client.request<AskAnswer>({route:'agent.cancel',id:answer.run_id}));setBusy(false);pending.current=null;}catch{setError('취소 결과를 아직 확인하지 못했어요. 연결 후 다시 확인해 주세요.');}},[client,answer?.run_id]);
 const continueRun=useCallback(async()=>{if(running.current||!answer?.run_id||!answer.next_job)return;interaction.current++;restoring.current=false;restoreRun.current=null;running.current=true;setBusy(true);setError('');try{setAnswer(await client.request<AskAnswer>({route:'agent.continue',id:answer.run_id}));}catch(e){const code=(e as {code?:string}).code;
  setError(code==='VERSION_CONFLICT'?'작업 상태나 해석 기준이 바뀌었어요. 현재 결과를 확인한 뒤 새 요청으로 이어가 주세요.':code==='NOT_FOUND'?'자료나 처리 권한이 바뀌어 이어갈 수 없어요. 연결 범위를 확인해 주세요.':'이어가기 결과를 아직 확인하지 못했어요. 요청 결과를 다시 확인해 주세요.');
  if(code==='VERSION_CONFLICT'||code==='NOT_FOUND')try{setAnswer(await client.request<AskAnswer>({route:'agent.read',id:answer.run_id}));}catch{/* Keep the prior result and the precise failure visible. */}
 }finally{running.current=false;setBusy(false);}},[client,answer]);
 const answering=useRef<{key:string;turn:string}|null>(null);
 const reply=useCallback(async(q:AskQuestion,value:string,inputKind:"text"|"voice"="text")=>{const text=value.trim();if(running.current||!text)return;interaction.current++;restoring.current=false;restoreRun.current=null;running.current=true;setBusy(true);setError('');
  const key=JSON.stringify([q.id,q.version,text,inputKind]);if(answering.current?.key!==key)answering.current={key,turn:workId()};
  try{const result=await client.request<AskAnswer>({route:'agent.start',command:JSON.stringify({client_turn_id:answering.current.turn,project_id:q.project_id,instruction:text,input_kind:inputKind,answer_to:{id:q.id,version:q.version}})});setAnswer(result);setAsked(text);setAskedSite(q.project_name);}catch{setError('답변 결과를 아직 확인하지 못했어요. 같은 답변을 다시 보내도 한 번만 처리해요.');}finally{running.current=false;setBusy(false);}
 },[client]);
 const prepareFor=useCallback(async(choice:DocumentChoice,context:string)=>{if(running.current)return;interaction.current++;restoring.current=false;restoreRun.current=null;running.current=true;setBusy(true);setError('');const key=JSON.stringify([choice.project_id,choice.type,context]);if(answering.current?.key!==key)answering.current={key,turn:workId()};try{setAnswer(await client.request<AskAnswer>({route:'agent.start',command:JSON.stringify({client_turn_id:answering.current.turn,project_id:choice.project_id,instruction:'선택한 업무의 문서 준비',input_kind:'text',document_request:{type:choice.type,context_id:context}})}));}catch{setError('같은 업무를 다시 누르면 준비를 이어가요.');}finally{running.current=false;setBusy(false);}},[client]);
 const submitFor=useCallback(async(text:string,site:string)=>{setProject(site);await submit(text,undefined,"text",false,site);},[submit,setProject]);
 return {text,project,answer,busy,error,asked,askedSite,setText,setVoiceId:(id:string)=>{voiceId.current=id;},setProject,submit,submitFor,retry,reset,cancel,continueRun,reply,prepareFor};
}
export function AskSite({context,ask}:{context:WorkContext;ask:Ask}){
 return <label className="field ask-site">요청할 현장<select aria-label="대화에서 찾을 현장" value={ask.project} disabled={ask.busy} onChange={e=>ask.setProject(e.target.value)}><option value="">전체 현장</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>;
}
const examples=["석고보드 자료 찾아줘","견적서 준비해줘","발주서 준비해줘","청구서 준비해줘"];
/** Writing or saying one request. The answer opens on its own screen. */
export function AskCompose({client,context,ask,onSent}:{client:WorkClient;context:WorkContext;ask:Ask;onSent:()=>void}){
 const send=(value?:string,turnId?:string)=>{onSent();void ask.submit(value,turnId,turnId?"voice":undefined);};
 return <form className="ask" onSubmit={e=>{e.preventDefault();if(ask.text.trim())send();}}>
  <WorkVoice client={client} disabled={ask.busy} inputId="work-chat-input" onText={ask.setText} onRecognized={ask.setVoiceId}/>
  <label htmlFor="work-chat-input" className="field-label">글로 쓰기</label>
  <p className="field-hint">요청한 글은 AI가 해석해 연결된 업무 자료를 찾아요.</p>
  <textarea id="work-chat-input" value={ask.text} maxLength={2000} rows={3} onChange={e=>ask.setText(e.target.value)} placeholder="현장 이름과 찾을 자료, 준비할 문서를 적어주세요"/>
  <fieldset className="chips"><legend className="sr-only">이렇게 말해 보세요</legend>{examples.map(x=><button key={x} type="button" className="chip" onClick={()=>ask.setText(x)}>{x}</button>)}</fieldset>
   <AskSite context={context} ask={ask}/>
  <div className="screen-action"><button type="submit" className="button-primary" disabled={ask.busy||!ask.text.trim()}>{ask.busy?"처리 중…":"요청하기"}</button></div>
 </form>;
}
const draftNames:Record<string,string>={estimate:"견적서",purchase_order:"발주서",invoice:"청구서",delivery_statement:"거래명세서"};
/** The single outcome of a request: a prepared document, found materials, or a short answer. */
export function AskResult({ask,client,issued={},onOpen,onOpenDraft,onOpenIssued,onOpenSheet,onPhotos,onDelivery,onDocuments,onAgain}:{ask:Ask;client?:WorkClient|undefined;issued?:Record<string,string>;onOpen:(id:string)=>void;onOpenDraft:(id:string)=>void;onOpenIssued?:(id:string)=>void;onOpenSheet?:(id:string)=>void;onPhotos?:()=>void;onDocuments?:()=>void;onDelivery?:(kind:string,id:string)=>void;onAgain:()=>void}){
 const answer=ask.answer,done=answer?.document_draft?Boolean(issued[answer.document_draft.id]):false;
 const [questionId,setQuestionId]=useState<string|null>(null);
 const question=answer?.questions?.find(q=>q.id===questionId)??answer?.questions?.[0];
 let mainAssigned=false;const actionClass=()=>{if(mainAssigned)return 'button-secondary';mainAssigned=true;return 'button-primary';};
 return <div className="ask-result" aria-live="polite" aria-busy={ask.busy}>
   {ask.asked?<blockquote className="quoted-request"><span className="sr-only">요청한 내용:</span>“{ask.asked}”</blockquote>:null}
   {ask.asked?<p className="question-where">요청한 현장: {ask.askedSite}</p>:null}
  {ask.busy?<div className="working" role="status"><span className="spinner" aria-hidden="true"/>요청을 처리하고 있어요…</div>:null}
  {ask.busy&&answer?.run_id&&ask.cancel?<button type="button" className="button-secondary" onClick={()=>void ask.cancel?.()}>남은 처리 취소</button>:null}
   {ask.error?<><Notice tone="danger" role="alert">{ask.error}</Notice><div className="screen-action"><button type="button" className={actionClass()} onClick={()=>void ask.retry()}>요청 결과 다시 확인</button></div></>:null}
  {answer?<>
   {answer.planner_notice?<Notice>{answer.planner_notice}</Notice>:null}
   {answer.next_job&&ask.continueRun?<div className="screen-action"><button type="button" className={actionClass()} disabled={ask.busy} onClick={()=>void ask.continueRun?.()}>남은 확인 이어가기</button>{ask.cancel?<button type="button" className="button-secondary" disabled={ask.busy} onClick={()=>void ask.cancel?.()}>여기까지 확인</button>:null}</div>:null}
   {answer.document_draft?null:<p className="answer-text">{answer.text}</p>}
   {answer.document_draft?<><article className="card draft-ready"><p className="question-where">준비한 문서</p><h2 className="card-title">{draftNames[answer.document_draft.type??""]??"문서"} {done?"발행을 마쳤어요":"초안이 준비됐어요"}</h2><p>{done?"발행한 문서에서 PDF를 보낼 수 있어요.":"받는 곳과 금액을 확인한 뒤 발행할 수 있어요. 아직 보내지 않았어요."}</p></article><div className="screen-action"><button type="button" className={actionClass()} onClick={()=>onOpenDraft(answer.document_draft!.latest_id??answer.document_draft!.id)}><Icon d={icons.doc} size={24}/><span>{done?"발행한 문서 보기":"문서 확인하기"}</span></button></div></>:null}
   {answer.deliveries?.map(d=><button type="button" className={actionClass()} key={d.id} onClick={()=>onDelivery?.(d.source_kind,d.source_id)}>{d.title} · 전달 내용 확인</button>)}{answer.delivery_choices?<button type="button" className={actionClass()} onClick={onDocuments}>보낼 문서 고르기</button>:null}
   {answer.photo_sheets?.map(s=><button type="button" className={actionClass()} key={s.id} onClick={()=>onOpenSheet?.(s.id)}>{s.title} · 사진대지 보기</button>)}{answer.photo_choices?<button type="button" className={actionClass()} onClick={onPhotos}>현장 사진 고르기</button>:null}
   {answer.artifacts?.map(a=><article className="card" key={a.id}><h2 className="card-title">{a.label} · {a.number}</h2><p>{a.state!=='approved'?'취소·정정된 문서예요. 현재 상태를 확인해 주세요.':a.files.length?a.files.map(f=>f.format.toUpperCase()).join(' · ')+' 파일을 열 수 있어요.':a.render_state==='dead'?'출력을 마치지 못했어요. 문서를 열어 원인과 다음 단계를 확인해 주세요.':a.render_state==='retry_wait'?'출력이 지연되어 서버에서 다시 시도할 예정이에요.':'출력 파일을 준비하고 있어요.'}</p>{onOpenIssued?<button type="button" className={actionClass()} onClick={()=>onOpenIssued(a.id)}>발행 문서와 파일 보기</button>:null}</article>)}
   {answer.document_choices?<section className="card"><h2 className="card-title">문서를 준비할 일</h2>{answer.document_choices.contexts.map(c=><button className="button-secondary" key={c.id} type="button" disabled={ask.busy} onClick={()=>void ask.prepareFor?.(answer.document_choices!,c.id)}>{c.label}</button>)}{answer.document_choices.partial?<p>최근 업무 20개를 표시했어요. 업무 이름을 함께 요청하면 더 좁힐 수 있어요.</p>:null}</section>:null}
   {answer.effects?.some(e=>e.decision_id)?<section className="card"><h2 className="card-title">반영한 내용</h2><ul>{[...new Set(answer.effects.flatMap(e=>e.changed??[]))].map(v=><li key={v}>{v}</li>)}</ul><button type="button" className="button-secondary" disabled={ask.busy} onClick={()=>void ask.submit("오늘 확인할 일")}>남은 확인할 일 보기</button>{client&&answer.effects.find(e=>e.decision_id)?.decision_id?<RememberAnswer actionClass={actionClass()} client={client} decision={answer.effects.find(e=>e.decision_id)!.decision_id!} cost={answer.effects.find(e=>e.decision_id)?.memory_cost_minor??'0'}/>:null}</section>:null}
   {question?<><ExceptionAnswer key={question.id} q={question} ask={ask} client={client} actionClass={question.blocked?'button-secondary':actionClass()}/>{(answer.questions?.length??0)>1?<nav aria-label="확인할 질문 고르기">{answer.questions?.map((q,i)=><button type="button" className="button-secondary" key={q.id} aria-current={q.id===question.id?'step':undefined} disabled={ask.busy} onClick={()=>setQuestionId(q.id)}>확인할 일 {i+1}{q.id===question.id?' · 선택됨':''}</button>)}</nav>:null}</>:null}
   {answer.cards.length?<><h2 className="section-title">찾은 자료 {answer.cards.length}개</h2><ul className="item-list">{answer.cards.map(card=><li key={card.revision_id}><button type="button" className="item" onClick={()=>onOpen(card.revision_id)}><strong>{card.title}</strong><span className="item-meta">{card.organization_state==="conflict"?"현장 확인 필요":card.project_name??"현장 확인 전"}{card.work_label?` · ${card.work_label}`:""}</span><span className="item-excerpt">{card.excerpt}</span><small>{card.locator?`${evidencePlace(card.locator)} · `:''}{card.version_scope==='history'?'이전 판 포함 · ':''}{new Date(card.created_at).toLocaleString("ko-KR")} · 읽은 내용과 원문 보기</small><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ul></>:null}
   {!answer.document_draft?<div className="screen-action"><button type="button" className="button-secondary" onClick={onAgain}><Icon d={icons.mic} size={24}/><span>다른 요청하기</span></button></div>:null}
  </>:null}
  {!ask.busy&&!answer&&!ask.error?<div className="empty-state"><h2>아직 요청한 내용이 없어요</h2><div className="screen-action"><button type="button" className={actionClass()} onClick={onAgain}>요청하러 가기</button></div></div>:null}
 </div>;
}

function ExceptionAnswer({q,ask,client,actionClass}:{q:AskQuestion;ask:Ask;client?:WorkClient|undefined;actionClass:string}){
 const [value,setValue]=useState(''),voice=useRef(false);return <form className="card" onSubmit={e=>{e.preventDefault();void ask.reply?.(q,value.trim()||"이대로 반영",value.trim()&&voice.current?"voice":"text");}}><p className="question-where">{q.project_name} · {q.work_label}</p><h2 className="card-title">{q.prompt}</h2>{q.blocked?<Notice>{q.blocked}</Notice>:<>{client?<WorkVoice client={client} disabled={ask.busy} inputId={`answer-${q.id}`} onText={setValue} onRecognized={()=>{voice.current=true;}}/>:null}<label className="field">다르게 답하기<textarea id={`answer-${q.id}`} value={value} maxLength={2000} onChange={e=>setValue(e.target.value)} placeholder="이대로 반영 / 28개로 / 내일 다시 확인"/></label><button type="submit" className={actionClass} disabled={ask.busy}>{value.trim()?"답변 반영":"이대로 반영"}</button></>}{q.can_defer?<button type="button" className="button-secondary" disabled={ask.busy} onClick={()=>void ask.reply?.(q,"내일 다시 확인")}>내일 다시 확인</button>:null}</form>;
}
