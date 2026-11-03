import {useEffect,useState} from 'react';
import type {WorkClient,WorkContext,WorkRequest} from './work-client.js';
import {categoryNames,type Category} from './work-materials.js';
import {Icon,icons,ListHead,Notice} from './work-shell.js';

type Thread={id:string;label:string;project_id:string;project_name:string;categories:Category[];evidence_count:number;updated_at:string};
type Entry={subject?:string|null;quantity?:{value:string;unitCode:string}|null;amount?:{minor:string|null;knowledge:string;currency:string}|null;id:string;kind:string;mode:string;asserted:boolean;occurred_at:string|null;recorded_at:string;withdrawn:boolean;evidence_ids:string[];supersedes:string|null;reverses:string|null};
type Detail={id:string;label:string;project_name:string;events:Entry[];evidence:{id:string;title:string;categories:Category[];created_at:string;parse_state:string}[];documents:{id:string;type:string;number:string;state:string}[];drafts:{id:string;type:string}[];partial:boolean;next_cursor:string|null};
export type Agenda={today:string;items:{id:string;label:string;project_name:string;due_date:string}[];partial:boolean};
const kindNames:Record<string,string>={observation:'관측 기록',request:'요청',proposal:'제안',acceptance:'합의 기록',ordered:'발주 기록',dispatch:'출고 기록',receipt:'인수 기록',inspection:'점검 기록',billing:'청구 기록',payment:'지급 기록',correction:'정정',cancellation:'취소'};
const documentNames:Record<string,string>={estimate:'견적서',purchase_order:'발주서',invoice:'청구서',delivery_statement:'거래명세서'};
const units:Record<string,string>={ea:'개',m:'m',m2:'㎡',m3:'㎥',kg:'kg',ton:'톤',sheet:'장',set:'세트',day:'일'};
const eventMoney=(e:Entry)=>e.amount?.knowledge==='known'&&e.amount.minor!==null?`${BigInt(e.amount.minor).toLocaleString('ko-KR')}원`:'금액 미확인';
const time=(value:string)=>new Date(value).toLocaleString('ko-KR',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});

/** A read that keeps its last good value through a transient failure and drops it when access is lost. */
export function useLiveRead<T>(client:WorkClient,request:WorkRequest){
 const [snapshot,setSnapshot]=useState<{client:WorkClient;key:string;data:T}|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0);const key=JSON.stringify(request);
 // biome-ignore lint/correctness/useExhaustiveDependencies: key is the serialized read request; tick is an explicit retry.
 useEffect(()=>{let live=true,running=false;setError('');const load=()=>{if(running||document.visibilityState==='hidden')return;running=true;void client.request<T>(JSON.parse(key) as WorkRequest).then(r=>{if(live){setSnapshot({client,key,data:r});setError('');}},(failure:unknown)=>{if(live){const code=(failure as {code?:string}|null)?.code;const transient=!code||['connection_wait','INTERNAL_ERROR','SERVICE_UNAVAILABLE','TIMEOUT'].includes(code);if(!transient)setSnapshot(null);setError(transient?'최신 기록을 확인하지 못했어요. 아래 내용은 마지막으로 확인한 기록입니다. 연결되면 다시 확인해요.':'현재 기록을 열람할 수 없어요. 연결과 열람 권한을 확인한 뒤 다시 눌러 주세요.');}}).finally(()=>{running=false;});};load();const timer=setInterval(load,10000);window.addEventListener('focus',load);document.addEventListener('visibilitychange',load);return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',load);document.removeEventListener('visibilitychange',load);};},[client,key,tick]);
 return {data:snapshot?.client===client&&snapshot.key===key?snapshot.data:null,error,retry:()=>setTick(n=>n+1)};
}
export const useAgenda=(client:WorkClient)=>useLiveRead<Agenda>(client,{route:'agenda.read'});
/** Confirmed work dates for today and tomorrow. Arrival dates of materials are never shown as appointments. */
export function AgendaRows({data,onOpen}:{data:Agenda;onOpen:(id:string)=>void}){
 if(!data.items.length)return null;
 return <ul className="task-list">{data.items.map(item=><li key={item.id} className="task-row"><span className={`task-date${item.due_date<data.today?' is-overdue':''}`}>{item.due_date<data.today?'지남':item.due_date===data.today?'오늘':'내일'}<small>{item.due_date.slice(5).replace('-','.')}</small></span><button type="button" className="task-open" onClick={()=>onOpen(item.id)}><span className="task-text">{item.label}</span><span className="task-meta"><span>{item.project_name}</span></span><Icon d={icons.next} size={20}/></button></li>)}</ul>;
}
export function WorkAgenda({client,onOpen}:{client:WorkClient;onOpen:(id:string)=>void}){
 const {data,error,retry}=useAgenda(client);
 return <section className="today-section work-agenda" aria-labelledby="agenda-title"><ListHead id="agenda-title" title="오늘·내일 일정" count={data?.items.length}/>
  {error?<Notice tone="warn" role="alert">{error}<button type="button" className="button-quiet" onClick={retry}>일정 다시 확인</button></Notice>:null}{!data&&!error?<p role="status" className="muted">일정을 확인하고 있어요…</p>:data?.items.length?<AgendaRows data={data} onOpen={onOpen}/>:data?<p className="muted">확인된 오늘·내일 일정이 없어요.</p>:null}
  {data?.partial?<p className="muted">먼저 확인할 일정 40개를 표시했어요.</p>:null}
 </section>;
}

/** The work threads of one site (or every site), filtered by the five kinds. The site itself is the screen title, so no site picker here. */
export function WorkLedger({client,context,project,category,onProject,onCategory,onOpen,onSearch,showProject=false}:{client:WorkClient;context:WorkContext;project:string;category:Category|'';onProject:(id:string)=>void;onCategory:(category:Category|'')=>void;onOpen:(id:string)=>void;onSearch:(query:string)=>void;showProject?:boolean}){
 const [page,setPage]=useState<string|null>(null),[search,setSearch]=useState('');
 const {data,error,retry}=useLiveRead<{items:Thread[];next_cursor:string|null}>(client,{route:'ledger.list',...(project?{project_id:project}:{}),...(category?{category}:{}),...(page?{cursor:page}:{})});
 return <div className="ledger-home">
  <div className="ledger-filter-head">{showProject?<label className="field">현장<select value={project} onChange={e=>onProject(e.target.value)}><option value="">모든 현장</option>{context.projects?.map(p=><option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>:null}<search className="ledger-search"><form onSubmit={e=>{e.preventDefault();onSearch(search.trim());}}><label htmlFor="ledger-search" className="sr-only">근거 자료 찾기</label><div><input id="ledger-search" type="search" value={search} onChange={e=>setSearch(e.target.value)} maxLength={80} placeholder="자료 내용으로 찾기"/><button type="submit" aria-label="근거 자료 검색"><Icon d={icons.search} size={24}/></button></div></form></search></div>
  <fieldset className="work-category-tabs" aria-label="업무 기록 분류"><button type="button" aria-pressed={!category} onClick={()=>onCategory('')}>모든 기록</button>{(Object.keys(categoryNames) as Category[]).map(c=><button key={c} type="button" aria-pressed={category===c} onClick={()=>onCategory(c)}>{categoryNames[c]}</button>)}</fieldset>
  <section aria-labelledby="ledger-threads-title" className="today-section"><ListHead id="ledger-threads-title" title={category?`${categoryNames[category]} 업무`:'이어지는 업무'} count={data?.items.length}/>
  {error?<Notice tone="warn" role="alert">{error}</Notice>:null}{!data&&!error?<p role="status" className="muted">업무 기록을 확인하고 있어요…</p>:data?.items.length?<ul className="ledger-rows">{data.items.map(item=><li key={item.id}><button type="button" className="ledger-row" onClick={()=>onOpen(item.id)}><span className="ledger-row-icon"><Icon d={icons.doc}/></span><span><strong>{item.label}</strong><small>{item.project_name} · 근거 {item.evidence_count}개</small><span className="ledger-tags">{item.categories.map(c=><span key={c}>{categoryNames[c]}</span>)}</span></span><span className="ledger-row-tail">{time(item.updated_at)}<Icon d={icons.next} size={22}/></span></button></li>)}</ul>:data?<p className="muted">업무 없음</p>:null}
  {data?.next_cursor||page?<div className="work-actions">{data?.next_cursor?<button type="button" className="button-secondary" onClick={()=>setPage(data.next_cursor)}>다음 업무 보기</button>:null}{page?<button type="button" className="button-quiet" onClick={()=>setPage(null)}>처음 업무로</button>:null}</div>:null}
  {error?<button type="button" className="text-button" onClick={retry}>새로 확인</button>:null}</section>
 </div>;
}

export function WorkLedgerDetail({client,id,onEvidence,onDocument,onDraft}:{client:WorkClient;id:string;onEvidence:(id:string)=>void;onDocument:(id:string)=>void;onDraft:(id:string)=>void}){
 const [page,setPage]=useState<string|null>(null);
 const {data,error,retry}=useLiveRead<Detail>(client,{route:'ledger.read',id,...(page?{cursor:page}:{})});
 if(error&&!data)return <Notice tone="warn" role="alert">{error}<button type="button" className="button-secondary" onClick={retry}>업무 다시 확인</button></Notice>;
 if(!data)return <p role="status">업무 흐름을 불러오고 있어요…</p>;
 return <div className="ledger-detail">{error?<Notice tone="warn" role="alert">{error}<button type="button" className="button-quiet" onClick={retry}>업무 다시 확인</button></Notice>:null}<header className="ledger-detail-heading"><p className="section-eyebrow">{data.project_name}</p><h2>{data.label}</h2></header><div className="ledger-detail-grid"><section className="ledger-panel"><h3>업무 흐름</h3>
  {data.events.length?<ol className="ledger-timeline">{data.events.map(e=><li key={e.id}><time dateTime={e.occurred_at??e.recorded_at}>{time(e.occurred_at??e.recorded_at)} · {e.occurred_at?'업무 시각':'기록 시각'}</time><div><strong>{e.withdrawn?'근거 열람 중지':e.mode==='applied'?'확인한 판단 반영':kindNames[e.kind]??'업무 기록'}</strong>{!e.withdrawn?<><p>{e.subject??'업무 내용 확인 필요'}</p><p>수량 {e.quantity?`${e.quantity.value} ${units[e.quantity.unitCode]??e.quantity.unitCode}`:'미확인'} · {eventMoney(e)}</p></>:null}<p className="muted">{e.withdrawn?'내용은 표시하지 않으며 이전 기록의 존재를 보존해요.':e.mode==='applied'?'서버에 기록된 판단이에요. 업무 전체 완료나 송금을 뜻하지 않아요.':e.asserted?'자료에서 읽은 기록이에요. 승인·지급 실행과는 별개예요.':'자료에서 읽은 요청·예정 또는 확인 전 내용이에요.'}</p>{e.supersedes||e.reverses?<span className="ledger-tag-warn">이전 기록 정정·취소</span>:null}{e.evidence_ids.map(revision=>{const source=data.evidence.find(s=>s.id===revision);return <button key={revision} type="button" className="ledger-evidence-link" onClick={()=>onEvidence(revision)}><Icon d={icons.doc} size={18}/>{source?.title??'근거 자료 열기'}</button>;})}</div></li>)}</ol>:<p className="muted">기록 없음</p>}
  <div className="work-actions">{data.next_cursor?<button type="button" className="button-secondary" onClick={()=>setPage(data.next_cursor)}>이전 기록 더 보기</button>:null}{page?<button type="button" className="button-quiet" onClick={()=>setPage(null)}>최근 기록으로</button>:null}</div></section><aside className="ledger-detail-aside"><section className="ledger-panel"><h3>관련 문서</h3>{data.drafts.map(d=><button key={d.id} type="button" className="ledger-evidence-link" onClick={()=>onDraft(d.id)}>{documentNames[d.type]??'문서'} · 검토할 초안</button>)}{data.documents.map(d=><button key={d.id} type="button" className="ledger-evidence-link" onClick={()=>onDocument(d.id)}>{documentNames[d.type]??'문서'} {d.number} · {d.state==='approved'?'발행본':d.state==='replaced'?'이전 정정본':'취소본'}</button>)}{!data.documents.length&&!data.drafts.length?<p className="muted">문서 없음</p>:null}</section><section className="ledger-panel"><h3>연결된 근거 {data.evidence.length}개</h3>{data.evidence.map(s=><button key={s.id} type="button" className="ledger-evidence-link" onClick={()=>onEvidence(s.id)}><Icon d={icons.doc} size={20}/><span>{s.title}<small>들어온 시각 {time(s.created_at)}</small></span></button>)}</section></aside></div>{data.partial?<Notice tone="info">연결 근거 100개, 관련 문서 20개까지 표시했어요. 전체 자료는 문서의 받은 자료에서 찾을 수 있습니다.</Notice>:null}</div>;
}
