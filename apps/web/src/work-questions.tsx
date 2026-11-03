import {RememberAnswer} from './work-memory.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {workId} from './work-id.js';
import {WorkFailure,type WorkClient} from './work-client.js';
import {WorkDraft} from './work-draft.js';
import {WorkVoice} from './work-voice.js';
import {Icon,icons,Notice} from './work-shell.js';
export type WorkQuestion={id:string;version:number;category:string;project_name:string;work_label:string;prompt:string;cause:string;automation_note?:string|null;source_refs:{revision:string;span:number;organization_version:number}[];proposal:{effects:Record<string,unknown>[];blocked:string|null;cost_options?:Record<string,Record<string,unknown>>}};
export type WorkAnswerResult={changed?:string[];document_draft_ids?:string[];deferred?:boolean;decision_id?:string;memory_cost_minor?:string};
const categoryLabels:Record<string,string>={schedule:'일정',material:'자재',defect:'하자',change:'변경비',billing:'청구'};
const causeLabels:Record<string,string>={today_blocked:'오늘 일이 막혀 있어요',safety:'안전 확인',payment_due:'지급 기한'};
const urgent=['safety','today_blocked','payment_due'];
type QuestionSnapshot={scope:string;questions:WorkQuestion[];coverage:string;allowed:boolean};
const lastQuestions=new WeakMap<WorkClient,QuestionSnapshot>();
/** Called when the signed-in account or company changes so one account never sees another's questions. */
export const forgetQuestions=(client:WorkClient)=>{lastQuestions.delete(client);};
/** An answer given on another screen removes that question before the next list arrives. */
export const dropCachedQuestion=(client:WorkClient,id:string)=>{const snap=lastQuestions.get(client);if(snap)lastQuestions.set(client,{...snap,questions:snap.questions.filter(q=>q.id!==id)});};
/** Shared polling of today's decisions for the home card and the question flow; the last answer per client avoids an empty flash between screens. */
export function useQuestions(client:WorkClient,scope=""){
 const saved=lastQuestions.get(client),cached=scope&&saved?.scope===scope?saved:undefined;
 const [loaded,setLoaded]=useState(Boolean(cached)),[questions,setQuestions]=useState<WorkQuestion[]>(cached?.questions??[]),[coverage,setCoverage]=useState(cached?.coverage??''),[allowed,setAllowed]=useState(cached?.allowed??false),[error,setError]=useState('');
 const live=useRef(true),loading=useRef(false);
 const load=useCallback(async()=>{if(loading.current)return;loading.current=true;try{const r=await client.request<{questions:WorkQuestion[];can_answer:boolean;coverage:string}>({route:'questions.list'});if(!Array.isArray(r.questions))throw new Error('Invalid response');if(!live.current)return;if(scope)lastQuestions.set(client,{scope,questions:r.questions,coverage:r.coverage,allowed:r.can_answer});{setLoaded(true);setQuestions(r.questions);setCoverage(r.coverage);setAllowed(r.can_answer);setError('');}}catch{if(live.current)setError('오늘 확인할 일을 아직 가져오지 못했어요. 연결 후 다시 확인할게요.');}finally{loading.current=false;}},[client,scope]);
 useEffect(()=>{live.current=true;void load();const refresh=()=>void load();window.addEventListener('work-answered',refresh);const timer=setInterval(refresh,10000);return()=>{live.current=false;clearInterval(timer);window.removeEventListener('work-answered',refresh);};},[load]);
 const drop=useCallback((id:string)=>{setQuestions(list=>list.filter(q=>q.id!==id));const snap=lastQuestions.get(client);if(snap)lastQuestions.set(client,{...snap,questions:snap.questions.filter(q=>q.id!==id)});},[client]);
 return {loaded,questions,coverage,allowed,error,load,drop};
}
export function questionTag(q:WorkQuestion){return [categoryLabels[q.category],causeLabels[q.cause]].filter(Boolean).join(' · ');}
/** One decision per screen: the current question, or the result of the answer just given. */
export function WorkQuestions({client,scope,onOpen,onReply,onOpenDraft,onFinish,initialResult}:{client:WorkClient;scope?:string;onOpen:(id:string)=>void;onReply?:(q:WorkQuestion)=>void;onOpenDraft?:(id:string)=>void;onFinish?:()=>void;initialResult?:WorkAnswerResult|null}){
 const {loaded,questions,coverage,allowed,error,load,drop}=useQuestions(client,scope);
 const [result,setResult]=useState<WorkAnswerResult|null>(initialResult??null),[remember,setRemember]=useState(false);
 const applied=(r:WorkAnswerResult,id?:string)=>{if(id)drop(id);setResult(r);setRemember(false);void load();window.dispatchEvent(new Event('documents-changed'));};
 const current=questions[0];
 if(result)return <section className="answer-result" aria-labelledby="result-title">
  <div className="result-mark" aria-hidden="true"><Icon d={icons.check} size={36}/></div>
  <h2 id="result-title" role="status">{result.deferred?'내일 다시 확인할게요':'답변을 반영했어요'}</h2>
  {result.changed?.length?<ul className="change-list">{result.changed.map(c=><li key={c}>{c}</li>)}</ul>:null}
  <p className="muted">보내기·송금·업무 전체 완료는 별도로 확인해요.</p>
  {result.document_draft_ids?.length?<div className="stack">{result.document_draft_ids.map((id,i)=>onOpenDraft?<button key={id} type="button" className="button-secondary" onClick={()=>onOpenDraft(id)}>준비한 문서 {result.document_draft_ids!.length>1?`${i+1} `:''}열어 보기</button>:<WorkDraft key={id} id={id} client={client} onOpen={onOpen}/>)}</div>:null}
  {result.decision_id?remember?<RememberAnswer key={result.decision_id} client={client} decision={result.decision_id} cost={result.memory_cost_minor??'0'}/>:<button type="button" className="button-secondary" onClick={()=>setRemember(true)}>다음에도 이렇게 처리하기</button>:null}
  <div className="screen-action">{questions.length?<button type="button" className={remember?"button-quiet":"button-primary"} onClick={()=>{setResult(null);setRemember(false);}}>다음 확인할 일 ({questions.length}개)</button>:<button type="button" className={remember?"button-quiet":"button-primary"} onClick={()=>{setResult(null);onFinish?.();}}>오늘 확인할 일 끝</button>}</div>
 </section>;
 return <div className="work-questions">
  {error?<Notice tone="warn" role="alert">{error}</Notice>:null}
  {current?<><p className="progress-text">확인할 일 <strong>1</strong> / {questions.length}{questions.slice(1).some(q=>q.cause==='today_blocked')?' · 지연된 일정 포함':''}</p><Question key={`${current.id}:${current.version}`} q={current} client={client} allowed={allowed} onOpen={onOpen} {...(onReply?{onReply}:{})} onDone={r=>applied(r,current.id)}/></>:null}
  {!loaded&&!error?<p role="status" className="muted">연결한 자료에서 확인할 일을 살펴보고 있어요…</p>:null}
  {loaded&&!current&&!error?<div className="empty-state"><div className="result-mark" aria-hidden="true"><Icon d={icons.check} size={36}/></div><h2>지금 확인할 일은 없어요</h2><p>새 자료가 들어오면 판단이 필요한 것만 여기에 한 장씩 보여드려요.</p>{onFinish?<div className="screen-action"><button type="button" className="button-primary" onClick={onFinish}>오늘 화면으로</button></div>:null}</div>:null}
  <details className="quiet-details"><summary>확인한 범위</summary><p>{coverage||'자료를 확인하고 있어요.'}</p></details>
 </div>;
}
function Question({q,client,allowed,onOpen,onReply,onDone}:{q:WorkQuestion;client:WorkClient;allowed:boolean;onOpen:(id:string)=>void;onReply?:(q:WorkQuestion)=>void;onDone:(r:WorkAnswerResult)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[choice,setChoice]=useState('');const pending=useRef<{kind:string;command:string}|null>(null),running=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const costs=Object.keys(q.proposal.cost_options??{});
 async function answer(defer=false){if(running.current)return;running.current=true;setBusy(true);setError('');const kind=defer?'defer':'answer';const key=kind+choice;
  if(pending.current?.kind!==key)pending.current={kind:key,command:JSON.stringify({command_id:workId(),intent:kind,targets:[{type:'work_issue',id:q.id,version:q.version}],evidence_refs:q.source_refs,effects:defer?[]:[...q.proposal.effects,...(choice&&q.proposal.cost_options?.[choice]?[q.proposal.cost_options[choice]]:[])],policy_version:1,...(!defer&&choice?{cost_choice:choice}:{}),...(defer?{next_review_at:new Date(Date.now()+86400000).toISOString()}:{})})};
  try{const r=await client.request<WorkAnswerResult>({route:'work.command',command:pending.current.command});pending.current=null;if(alive.current)onDone(r);}
  catch(e){if(alive.current){if(e instanceof WorkFailure&&['VERSION_CONFLICT','DOMAIN_INVARIANT','INVALID_CONTRACT','IDEMPOTENCY_CONFLICT','NOT_FOUND'].includes(e.code)){pending.current=null;setError('자료나 처리 기준이 바뀌었어요. 새로 확인한 질문으로 다시 답해 주세요.');}else setError('결과를 아직 확인하지 못했어요. 같은 버튼을 다시 누르면 중복 없이 확인합니다.');}}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const tag=questionTag(q);
 return <article className={`question-card${urgent.includes(q.cause)?' is-urgent':''}`} aria-labelledby={`q-${q.id}`}>
  <p className="question-where">{q.project_name} · {q.work_label}{tag?<span className="tag">{tag}</span>:null}</p>
  <h2 id={`q-${q.id}`} className="question-prompt">{q.prompt}</h2>
  {q.automation_note?<p>{q.automation_note}</p>:null}
  {q.proposal.blocked?<Notice tone="warn">{q.proposal.blocked}</Notice>:null}
  {costs.length?<fieldset className="choice-group"><legend>이 추가비는 어떤 비용인가요?</legend>{costs.map(c=><label key={c} className="choice"><input type="radio" name={`cost-${q.id}`} value={c} checked={choice===c} disabled={busy} onChange={()=>setChoice(c)}/><span>{c==='defect'?'하자 보완':'변경 추가비'}</span></label>)}</fieldset>:null}
  {error?<Notice tone="danger" role="alert">{error}</Notice>:null}
  <div className="stack">
   {allowed&&!q.proposal.blocked?<button type="button" className="button-primary" disabled={busy||(costs.length>0&&!choice)} onClick={()=>void answer()}>{busy?'반영 결과 확인 중…':'이대로 반영'}</button>:null}
   {allowed&&onReply?<button type="button" className="button-secondary" disabled={busy} onClick={()=>onReply(q)}><Icon d={icons.mic} size={24}/><span>말이나 글로 답하기</span></button>:null}
   {allowed&&!urgent.includes(q.cause)?<button type="button" className="button-quiet" disabled={busy} onClick={()=>void answer(true)}>내일 다시 확인</button>:null}
   {q.source_refs[0]?<button type="button" className="button-link" onClick={()=>onOpen(q.source_refs[0]!.revision)}>관련 원문 보기</button>:null}
  </div>
  {!allowed?<p className="muted">답변은 대표 계정에서 할 수 있어요.</p>:null}
 </article>;
}
/** Answering one question in the owner's own words; the same closed reply path as the voice transcript. */
export function QuestionReply({client,question,onAnswered,onCancel}:{client:WorkClient;question:WorkQuestion;onAnswered:(r:WorkAnswerResult)=>void;onCancel:()=>void}){
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false);
 const voice=useRef<string|undefined>(undefined);
 const running=useRef(false),pending=useRef<{id:string;text:string}|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function submit(value=text.trim(),turnId?:string){if(running.current||!value.trim()||stale)return;running.current=true;setBusy(true);setError('');
  if(!pending.current||pending.current.text!==value)pending.current={id:turnId??voice.current??workId(),text:value};
  try{const result=await client.request<WorkAnswerResult&{needs_answer?:boolean;text?:string}>({route:'work.reply',command:JSON.stringify({command_id:pending.current.id,question_id:question.id,question_version:question.version,text:value})});pending.current=null;if(result.needs_answer){setError(result.text??'답을 조금 더 구체적으로 알려주세요.');return;}window.dispatchEvent(new CustomEvent('work-answered',{detail:result}));window.dispatchEvent(new Event('documents-changed'));if(alive.current)onAnswered(result);}
  catch(e){if(e instanceof WorkFailure&&['VERSION_CONFLICT','DOMAIN_INVARIANT','INVALID_CONTRACT','NOT_FOUND'].includes(e.code)){pending.current=null;setStale(true);setError('자료가 바뀌었거나 이 답을 적용할 수 없어요. 확인할 일을 다시 열어 주세요.');}else setError('답을 아직 못 가져왔어요. 다시 누르면 같은 답을 이어서 확인해요.');}
  finally{running.current=false;setBusy(false);}
 }
 const examples=['그대로 해줘','8개로','다음 주 월요일로'];
 return <div className="reply">
  <blockquote className="quoted-question"><p className="question-where">{question.project_name} · {question.work_label}</p><p>{question.prompt}</p></blockquote>
  <WorkVoice client={client} disabled={busy||stale} inputId="reply-input" onText={setText} onRecognized={id=>{voice.current=id;}}/>
  <form onSubmit={e=>{e.preventDefault();void submit();}}>
   <label htmlFor="reply-input" className="field-label">글로 답하기</label>
   <textarea id="reply-input" value={text} maxLength={2000} rows={3} disabled={stale} onChange={e=>setText(e.target.value)} placeholder="예: 그대로 해줘"/>
   <fieldset className="chips"><legend className="sr-only">자주 쓰는 답</legend>{examples.map(x=><button key={x} type="button" className="chip" disabled={busy||stale} onClick={()=>setText(x)}>{x}</button>)}</fieldset>
   {error?<Notice tone={stale?'warn':'danger'} role="alert">{error}</Notice>:null}
   <div className="screen-action">{stale?<button type="button" className="button-primary" onClick={onCancel}>확인할 일 다시 보기</button>:<button type="submit" className="button-primary" disabled={busy||!text.trim()}>{busy?'반영하는 중…':'이 답으로 반영'}</button>}</div>
  </form>
 </div>;
}
