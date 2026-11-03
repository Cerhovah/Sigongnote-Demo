import {DocumentFormSummary,DocumentFormNotice} from './document-form.js';
import {MaterialsList} from './work-materials.js';
import type {MaterialList} from './work-client.js';
import {DeliveryPanel} from './work-delivery.js';
import {DocumentFiles} from "./work-document-files.js";
import {workId} from "./work-id.js";
import {useEffect,useRef,useState} from 'react';
import {WorkFailure,type WorkClient,type WorkRequest,type WorkContext} from './work-client.js';
import type {Draft} from './work-draft.js';
import {Icon,icons,Notice,readWon} from './work-shell.js';

type Summary={id:string;state:string;snapshot_hash:string;number:string;type:string;project:{id:string;name:string};total:string;recipient:string};
type Issued={shares?:{id:string;own:boolean;format:'pdf'|'xlsx';state:string}[];id:string;state:string;snapshot_hash:string;render_state:string;render_error?:string|null;replacement_id:string|null;files:{format:'pdf'|'xlsx';sha256:string}[];document:Draft['document']};
const names:Record<string,string>={estimate:'견적서',purchase_order:'발주서',invoice:'청구서',delivery_statement:'거래명세서'};
const changed=()=>window.dispatchEvent(new Event('documents-changed'));
const money=(s:string|null)=>s===null?'확인 필요':`${BigInt(s).toLocaleString('ko-KR')}원`;

/** The check-answers step: recipient and, for an invoice, this claim's amount. One confirmation issues. */
export function WorkIssue({client,draft,onRefresh,onIssued}:{client:WorkClient;draft:Draft;onRefresh:(d:Draft)=>void;onIssued?:(id:string)=>void}){
 const total=draft.document.totals.total,available=draft.billing?.available;
 const [recipient,setRecipient]=useState(draft.document.recipient.name??''),[amount,setAmount]=useState(total===null?'':available==='0'?'':available&&BigInt(available)<BigInt(total)?available:total),[issued,setIssued]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[previous,setPrevious]=useState<Summary[]>([]),[replacement,setReplacement]=useState(''),[rejected,setRejected]=useState(false);
 const pending=useRef<{body:string;key:string}|null>(null),running=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{let current=true;if(draft.document.type==='invoice')void client.request<{documents:Summary[]}>({route:'documents.list'}).then(r=>{if(current)setPrevious(r.documents.filter(d=>d.state==='approved'&&d.type==='invoice'&&d.project.id===draft.document.project.id));},()=>{});return()=>{current=false;};},[client,draft.document.project.id,draft.document.type]);
 if(issued)return <IssuedDocument client={client} id={issued}/>;
 if(draft.stale||total===null||draft.missing.some(m=>m!=='이미 청구한 금액을 뺀 이번 청구 범위'))return null;
 const prior=previous.find(d=>d.id===replacement);const grossCapacity=available===undefined?null:BigInt(available)+BigInt(prior?.total??'0');const capacity=grossCapacity===null?null:grossCapacity>BigInt(total)?BigInt(total):grossCapacity;
 async function issue(){if(running.current)return;
  if(draft.document.type==='invoice'&&(!/^[1-9][0-9]{0,14}$/.test(amount)||capacity===null||BigInt(amount)>capacity)){setError(`이번 청구 금액을 1원부터 ${money(capacity?.toString()??null)} 사이로 입력해 주세요.`);return;}
  running.current=true;setBusy(true);setError('');
  const old=previous.find(d=>d.id===replacement),body=JSON.stringify({recipient,amount,replacement});if(!pending.current||pending.current.body!==body)pending.current={body,key:workId()};
  try{
   if(recipient.trim()!==draft.document.recipient.name){const updated=await client.request<{id:string}>({route:'documents.complete',id:draft.id,client_command_id:pending.current.key,recipient:recipient.trim()});const next=await client.request<Draft>({route:'documents.read',id:updated.id});if(alive.current)onRefresh(next);return;}
   const result=await client.request<{documents?:{id:string}[];replacement?:{documents:{id:string}[]};replacement_id?:string}>({route:'documents.issue',id:draft.id,client_command_id:pending.current.key,basis_hash:draft.document.basis_hash,recipient_confirmation:recipient.trim(),...(draft.document.type==='invoice'?{amount_minor:amount}:{}),...(old?{replacement_id:old.id,expected_hash:old.snapshot_hash}:{})});
   const id=result.documents?.[0]?.id??result.replacement?.documents[0]?.id??result.replacement_id;
   if(!id)throw new Error('DOCUMENT_RESULT');if(alive.current){if(onIssued)onIssued(id);else setIssued(id);}changed();
  }catch(e){if(e instanceof WorkFailure&&['DOMAIN_INVARIANT','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','INVALID_CONTRACT'].includes(e.code)){pending.current=null;if(alive.current){setRejected(true);setError(e.code==='DOMAIN_INVARIANT'?'이번 금액이나 받는 곳이 현재 청구 기준과 맞지 않아요. 금액을 고치거나 최신 자료로 다시 준비해 주세요.':'자료나 기존 문서가 바뀌었어요. 발행 내역을 확인한 뒤 최신 자료로 다시 준비해 주세요.');}}else if(alive.current)setError('아직 발행 결과를 확인하지 못했어요. 같은 버튼으로 다시 확인하거나, 발행한 문서에서 확인해 주세요. 금액·자료가 바뀌었다면 최신 자료로 다시 준비해 주세요.');}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 async function refreshDraft(){if(running.current)return;running.current=true;setBusy(true);try{if(pending.current?.body!=='refresh')pending.current={body:'refresh',key:workId()};const r=await client.request<{id:string}>({route:'documents.complete',id:draft.id,client_command_id:pending.current.key});const d=await client.request<Draft>({route:'documents.read',id:r.id});if(alive.current)onRefresh(d);}catch{if(alive.current)setError('최신 자료를 아직 받지 못했어요. 연결 후 다시 눌러주세요.');}finally{running.current=false;if(alive.current)setBusy(false);}}
 const invoice=draft.document.type==='invoice';
 return <section className="work-issue" aria-labelledby="issue-title"><h3 id="issue-title" className="section-title">받는 곳{invoice?'과 이번 청구 금액':''}을 확인해 주세요</h3><form onSubmit={e=>{e.preventDefault();void issue();}}>
  <DocumentFormNotice form={draft.document.form??{}} type={draft.document.type}/>
  {draft.document.form?<details className="quiet-details"><summary>출력할 사업자 정보와 거래 조건 확인</summary><DocumentFormSummary form={draft.document.form}/></details>:null}
  <label className="field">받는 곳<input required maxLength={120} value={recipient} onChange={e=>setRecipient(e.target.value)} disabled={busy}/></label>
  {invoice?<><p className="big-figure"><span>지금 새로 청구할 수 있는 금액</span><strong>{money(available??null)}</strong><small>{readWon(available??null)}</small></p><label className="field">이번 청구 금액 (원) · 최대 {money(capacity?.toString()??null)}<input required inputMode="numeric" pattern="[1-9][0-9]{0,14}" value={amount} onChange={e=>setAmount(e.target.value)} disabled={busy}/></label>{available==='0'&&!replacement?<Notice tone="warn"><p>새로 청구할 금액이 없어요. 기존 청구 정정을 선택하고 바꿀 금액을 입력해 주세요.</p></Notice>:null}<p className="muted">일부 금액만 청구하면 전체 수량의 납품·완료로 표시하지 않아요.</p>{previous.length?<label className="field">기존 청구 정정<select value={replacement} onChange={e=>{setReplacement(e.target.value);const old=previous.find(d=>d.id===e.target.value);if(!amount||amount==='0')setAmount(old?.total??'');}} disabled={busy}><option value="">새 청구서</option>{previous.map(d=><option key={d.id} value={d.id}>{d.number} · {money(d.total)} · {d.recipient}</option>)}</select></label>:null}{replacement?<p className="muted">선택한 청구를 취소하고 이번 금액으로 바꿉니다. 이미 기록한 입금은 보존하고 다시 연결할 금액으로 남깁니다.</p>:null}</>:<p className="big-figure"><span>합계</span><strong>{money(total)}</strong><small>{readWon(total)}</small></p>}
  <p className="muted">발행하면 내용을 고정해 PDF·엑셀을 준비해요. 보내기와 입금 처리는 포함되지 않아요.</p>
  {error?<Notice tone="danger" role="alert">{error}</Notice>:null}
  <div className="screen-action">{rejected?<button type="button" className="button-secondary" disabled={busy} onClick={()=>void refreshDraft()}>최신 자료로 다시 준비</button>:null}<button type="submit" className="button-primary" disabled={busy}>{busy?'결과 확인 중…':recipient.trim()!==draft.document.recipient.name?'받는 곳 반영하고 내용 확인':replacement?'기존 청구 정정하고 발행':'확인하고 문서 발행'}</button></div></form></section>;
}

/** An issued document: its state first, then sending it. */
export function IssuedDocument({client,id}:{client:WorkClient;id:string}){
 const [doc,setDoc]=useState<Issued|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[cancel,setCancel]=useState(false),[refresh,setRefresh]=useState(0),[paused,setPaused]=useState(false);
 const running=useRef(false),pending=useRef<{kind:string;key:string}|null>(null),alive=useRef(true);
 useEffect(()=>{const update=(event:Event)=>{const detail=(event as CustomEvent<{ids?:string[];reset?:boolean}>).detail;if(detail?.ids&&!detail.ids.includes(id)&&!detail.reset)return;if(detail?.reset)setDoc(null);setRefresh(v=>v+1);};window.addEventListener('documents-changed',update);return()=>window.removeEventListener('documents-changed',update);},[id]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries loading after a user action or matching feed event.
 useEffect(()=>{let current=true,timer:ReturnType<typeof setTimeout>;let count=0;setPaused(false);async function load(){try{const d=await client.request<Issued>({route:'documents.issued',id});if(!current)return;setDoc(d);setError('');if(d.state==='approved'&&!['dead','succeeded'].includes(d.render_state)&&count++<30)timer=setTimeout(()=>void load(),2000);else if(d.state==='approved'&&d.files.length<2)setPaused(true);}catch{if(current)setError('문서를 열지 못했어요. 연결 후 다시 확인해 주세요.');}}void load();return()=>{current=false;clearTimeout(timer);};},[client,id,refresh]);
 async function command(kind:'retry'|'cancel'){if(!doc||running.current)return;running.current=true;setBusy(true);setError('');if(pending.current?.kind!==kind)pending.current={kind,key:workId()};try{
  const request:WorkRequest=kind==='cancel'?{route:'documents.cancel',id,client_command_id:pending.current.key,expected_hash:doc.snapshot_hash}:{route:'documents.retry',id,client_command_id:pending.current.key};await client.request(request);pending.current=null;if(alive.current){setCancel(false);setRefresh(v=>v+1);}changed();
 }catch(e){if(e instanceof WorkFailure&&['DOMAIN_INVARIANT','VERSION_CONFLICT'].includes(e.code)){pending.current=null;if(alive.current)setError(doc.document.type==='purchase_order'?'이미 상대가 확인했거나 입고된 발주는 조정이 필요해요. 상태를 다시 확인해 주세요.':'문서 상태가 바뀌어 처리하지 않았어요. 상태를 다시 확인해 주세요.');}else if(alive.current)setError('처리 결과를 확인하지 못했어요. 다시 누르면 같은 요청을 확인합니다.');}finally{running.current=false;if(alive.current)setBusy(false);}}
 if(!doc)return error?<Notice tone="danger" role="alert">{error}</Notice>:<p role="status" className="muted">발행한 문서를 여는 중이에요…</p>;
 const ready=doc.state==='approved'&&doc.files.length===2,tone=ready?'ok':doc.state==='approved'&&doc.render_state==='dead'?'danger':doc.state==='approved'?'info':'warn';
 const statusText=doc.state==='approved'?doc.files.length===2?'PDF·엑셀 준비 완료':doc.render_error==='INVALID_PUBLIC_DOCUMENT'?'문서 형식 확인이 필요해요. 발행 내역은 보존되어 있어요. 관리자에게 아래 문서 번호를 알려 주세요.':doc.render_state==='dead'?'출력을 마치지 못했어요. 발행 내역은 그대로 보존되어 있어요.':doc.render_state==='retry_wait'?'출력이 지연되어 서버에서 다시 시도할 예정이에요.':'파일을 준비하고 있어요. 화면을 닫아도 서버에서 계속합니다.':doc.state==='replaced'?'새 문서로 정정되었어요.':'취소된 문서예요. 이미 기록한 입금은 보존됩니다.';
 if(cancel)return <article className="work-issued" aria-label="문서 취소 확인"><h2 className="card-title">{names[doc.document.type]} {doc.document.document_number}를 취소할까요?</h2><p>{doc.document.type==='invoice'?'청구 금액은 취소되고, 이미 받은 돈은 삭제하거나 환불하지 않습니다.':doc.document.type==='purchase_order'?'아직 전달하지 않은 발주 수량을 다음 준비에 반영합니다. 상대에게 보낸 발주는 별도 확인이 필요합니다.':'이전 문서는 이력으로 보존하며, 청구나 입금은 바뀌지 않습니다.'}</p>{error?<Notice tone="danger" role="alert">{error}</Notice>:null}<div className="screen-action"><button type="button" className="button-quiet" disabled={busy} onClick={()=>setCancel(false)}>취소하지 않고 돌아가기</button><button type="button" className="button-danger" disabled={busy} onClick={()=>void command('cancel')}>문서 취소 확정</button></div></article>;
 return <article className="work-issued" aria-label="발행한 문서 상세">
 {doc.document.form?<details className="quiet-details"><summary>발행 당시 사업자 정보와 거래 조건</summary><DocumentFormSummary form={doc.document.form}/></details>:null}
  <p className={`status-line status-${tone}`} role="status"><span className="status-dot" aria-hidden="true"/>{statusText}</p>
  <h2 className="doc-title">{names[doc.document.type]} <span>{doc.document.document_number}</span></h2>
  <p className="doc-parties">{doc.document.project.name} · {doc.document.recipient.name}</p>
  <p className="big-figure"><span>합계</span><strong>{money(doc.document.totals.total)}</strong><small>{readWon(doc.document.totals.total)}</small></p>
  {ready?<DocumentFiles client={client} id={id} {...(doc.shares?{shares:doc.shares}:{})} onRefresh={()=>setRefresh(v=>v+1)}/>:null}
  {doc.state==='approved'&&doc.render_error!=='INVALID_PUBLIC_DOCUMENT'&&['dead','retry_wait'].includes(doc.render_state)?<button disabled={busy} type="button" className="button-primary" onClick={()=>void command('retry')}>같은 문서로 출력 다시 시도</button>:null}
  {!ready&&doc.state==='approved'?<button type="button" className="button-quiet" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>{paused?'자동 확인을 잠시 멈췄어요 · 상태 다시 확인':'상태 다시 확인'}</button>:null}
  {ready?<DeliveryPanel key={id} client={client} kind="document" id={id}/>:null}
  <details className="quiet-details"><summary>발행 내용 보기</summary><ul className="plain-list">{doc.document.lines.map(l=><li key={l.id}>{l.description} {l.spec} · 공급가 {money(l.supply)} · 부가세 {money(l.tax)}</li>)}</ul><p>공급가 {money(doc.document.totals.supply)} · 부가세 {money(doc.document.totals.tax)}</p></details>
  {doc.replacement_id?<p className="muted">새로 발행한 정정 문서를 발행한 문서 목록에서 확인해 주세요.</p>:null}
  <p className="muted">일반 업무 문서입니다. 전달·입금 완료는 아직 확인되지 않았어요.</p>{error?<Notice tone="danger" role="alert">{error}</Notice>:null}
  {doc.state==='approved'?<button type="button" className="button-link danger-link" disabled={busy} onClick={()=>setCancel(true)}>문서 취소</button>:null}
 </article>;
}

/** Documents: site filter and three kinds on top, the actual list below. An empty draft list offers the one real way to make a document. */
export function WorkDocumentHistory({client,selected,onSelect,context,project='',onProject,onDraft,onMaterial,view='issued',onView,onCreate,onPhotos}:{client:WorkClient;selected?:string|null;onSelect?:(id:string|null)=>void;context?:WorkContext;project?:string;onProject?:(id:string)=>void;onDraft?:(id:string)=>void;onMaterial?:(id:string)=>void;view?:'drafts'|'issued'|'received';onView?:(view:'drafts'|'issued'|'received')=>void;onCreate?:()=>void;onPhotos?:()=>void}){
 const [items,setItems]=useState<Summary[]>([]),[own,setOwn]=useState(''),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[loaded,setLoaded]=useState(false);
 const [prepared,setPrepared]=useState<{id:string;type:string;project_id:string;work_label:string}[]>([]);
 const id=onSelect?selected??'':own,select=(value:string)=>onSelect?onSelect(value):setOwn(value);
 // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the list without remounting the selected document.
 useEffect(()=>{if(id)return;let current=true;const update=()=>setRefresh(v=>v+1);window.addEventListener('documents-changed',update);void client.request<{documents:Summary[];prepared?:typeof prepared}>({route:'documents.list'}).then(r=>{if(current){setItems(r.documents??[]);setPrepared(r.prepared??[]);setError('');setLoaded(true);}},()=>{if(current)setError('문서 목록을 가져오지 못했어요. 마지막 확인 목록을 표시해요. 연결 후 목록을 다시 확인해 주세요.');});return()=>{current=false;window.removeEventListener('documents-changed',update);};},[client,refresh,id]);
 if(id)return <div className="work-document-history"><IssuedDocument key={id} client={client} id={id}/></div>;
 const visible=items.filter(d=>!project||d.project.id===project),drafts=prepared.filter(d=>!project||d.project_id===project);
 const stateLabel=(d:Summary)=>d.state==='approved'?'발행본 · 전달 별도':d.state==='replaced'?'이전 발행본 · 정정됨':'취소됨 · 이력 보존';
 return <div className="work-document-history">
  <div className="document-filter">{context&&onProject?<label className="field field-inline"><span className="sr-only">문서 볼 현장</span><select aria-label="문서 볼 현장" value={project} onChange={e=>onProject(e.target.value)}><option value="">전체 현장</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>:null}
  {onView?<fieldset className="work-category-tabs" aria-label="문서 구분">{([['drafts','초안'],['issued','발행본'],['received','받은 자료']] as const).map(([key,label])=><button key={key} type="button" aria-pressed={view===key} onClick={()=>onView(key)}>{label}{key==='drafts'&&drafts.length?<span className="list-count">{drafts.length}</span>:null}</button>)}</fieldset>:null}</div>
  {error?<Notice tone="warn" role="alert">{error}</Notice>:null}
  {view==='received'?<ReceivedDocuments key={project} client={client} project={project} onOpen={onMaterial??(()=>{})}/>:null}
  {view==='drafts'&&loaded&&!drafts.length&&!error?<div className="list-empty"><p className="muted">초안 없음</p>{onCreate?<button type="button" className="button-secondary" onClick={onCreate}><Icon d={icons.plus} size={22}/><span>문서 만들기</span></button>:null}</div>:null}
  {(view==='drafts'||!onView)&&onDraft&&drafts.length?<section className="stack" aria-labelledby="prepared-documents-title"><h2 id="prepared-documents-title" className="sr-only">준비된 초안</h2><ul className="row-list">{drafts.map(d=><li key={d.id}><button type="button" className="row" onClick={()=>onDraft(d.id)}><span className="row-icon" aria-hidden="true"><Icon d={icons.doc}/></span><span><strong>{names[d.type]??'문서'} 초안 확인</strong><small>{context?.projects?.find(p=>p.id===d.project_id)?.display_name??'현장 확인 필요'} · {d.work_label} · 발행 전</small></span><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ul>{onCreate?<button type="button" className="text-button" onClick={onCreate}>다른 문서 만들기</button>:null}</section>:null}
  {view==='issued'&&visible.length?<ul className="item-list" aria-label="발행한 문서">{visible.map(d=><li key={d.id}><button type="button" className="item" onClick={()=>select(d.id)}><span className="item-kicker">{names[d.type]} · {stateLabel(d)}</span><strong>{d.project.name} · {d.recipient}</strong><span className="item-amount">{money(d.total)}</span><small>{d.number}</small><span className="item-chevron" aria-hidden="true"><Icon d={icons.next} size={24}/></span></button></li>)}</ul>:null}
  {view==='issued'&&loaded&&!visible.length&&!error?<div className="list-empty"><p className="muted">문서 없음</p>{onCreate?<button type="button" className="button-secondary" onClick={onCreate}><Icon d={icons.plus} size={22}/><span>문서 만들기</span></button>:null}</div>:null}
  {view!=='received'&&!loaded&&!error?<p role="status" className="muted">문서 목록을 불러오고 있어요…</p>:null}
  {view!=='received'?<div className="list-foot">{loaded&&visible.length>=100?<span className="muted">최근 발행 100건까지 보여요.</span>:null}<button type="button" className="text-button" onClick={()=>setRefresh(v=>v+1)}>목록 새로 확인</button>{onPhotos?<button type="button" className="text-button" onClick={onPhotos}><Icon d={icons.photo} size={20}/>현장 사진·사진대지</button>:null}</div>:null}
 </div>;
}

function ReceivedDocuments({client,project,onOpen}:{client:WorkClient;project:string;onOpen:(id:string)=>void}){
 const [data,setData]=useState<MaterialList|null>(null),[page,setPage]=useState<string>(),[draft,setDraft]=useState(''),[q,setQ]=useState(''),[tick,setTick]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the current page.
 useEffect(()=>{let alive=true;setBusy(true);setError('');void client.request<MaterialList>({route:'materials.list',...(project?{project_id:project}:{}),...(q?{q}:{}),...(page?{cursor:page}:{})}).then(r=>{if(alive)setData(r);},()=>{if(alive){setData(null);setError('받은 자료를 확인하지 못했어요. 연결 후 다시 확인해 주세요.');}}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};},[client,project,q,page,tick]);
 return <section aria-label="받은 자료"><search><form className="search-form" onSubmit={e=>{e.preventDefault();setPage(undefined);setQ(draft.trim());}}><label htmlFor="received-search" className="sr-only">받은 자료 찾기</label><div className="search-row"><input id="received-search" type="search" placeholder="받은 자료 찾기" value={draft} maxLength={80} onChange={e=>setDraft(e.target.value)}/><button type="submit" className="button-secondary">찾기</button></div></form></search><MaterialsList items={data?.materials??[]} cursor={data?.next_cursor??null} busy={busy} error={error} query={q} page={page} onOpen={m=>onOpen(m.id)} onNext={()=>setPage(data?.next_cursor??undefined)} onFirst={()=>setPage(undefined)} onRefresh={()=>setTick(n=>n+1)}/></section>;
}
