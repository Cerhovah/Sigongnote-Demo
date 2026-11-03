import type {DocumentForm} from '@sigongnote/contracts';
import {DocumentFormEditor} from './document-form.js';
import {workId} from "./work-id.js";
import {WorkIssue,IssuedDocument} from "./work-documents.js";
import {useEffect,useRef,useState} from "react";
import type {WorkClient} from "./work-client.js";
import {Notice,readWon} from "./work-shell.js";
export type Draft={input_lines?:{id:string;description:string;spec:string;unit:string;quantity:string|null;unit_price:string|null}[];notes?:string[];order_quantities?:{id:string;description:string;unit:string;available:string|null}[];billing?:{available:string};id:string;latest_id?:string;state:string;stale:boolean;source_candidate:boolean;missing:string[];source_refs:string[];document:{form?:DocumentForm;basis_hash:string;type:string;document_number:string;issuer:{name:string};recipient:{name:string|null};project:{id:string;name:string};date:string;lines:{id:string;description:string;spec:string;unit:string;quantity:string|null;unit_price:string|null;supply:string|null;tax:string|null}[];totals:{supply:string|null;tax:string|null;total:string|null}}};
export const documentNames:Record<string,string>={estimate:'견적서',purchase_order:'발주서',invoice:'청구서',delivery_statement:'거래명세서'};
export const won=(value:string|null)=>value===null?'확인 필요':`${BigInt(value).toLocaleString('ko-KR')}원`;
const invoiceRange='이미 청구한 금액을 뺀 이번 청구 범위';
type Field='recipient'|'margin'|'tax';
type DraftLineInput={id:string;description:string;spec:string;unit:string;quantity:string;unit_price:string};
/** A document is prepared in steps: fill one missing answer at a time, check the content, then issue. */
export function WorkDraft({client,id,onOpen,onIssued}:{client:WorkClient;id:string;onOpen:(id:string)=>void;onIssued?:(id:string)=>void}){
 const [currentId,setCurrentId]=useState(id),[recipient,setRecipient]=useState(''),[margin,setMargin]=useState(''),[vat,setVat]=useState(''),[tax,setTax]=useState(''),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
 const [issuedId,setIssuedId]=useState(''),[issuing,setIssuing]=useState(false),[field,setField]=useState(0);
 const [formDirty,setFormDirty]=useState(false);
 const [quantities,setQuantities]=useState<Record<string,string>>({});
 const [lines,setLines]=useState<DraftLineInput[]>([]);
 const pending=useRef<{body:string;id:string}|null>(null);
 const [draft,setDraft]=useState<Draft|null>(null),[error,setError]=useState('');
 useEffect(()=>{let current=true;setDraft(null);setError('');setIssuing(false);setField(0);setQuantities({});client.request<Draft>({route:'documents.read',id:currentId}).then(value=>{if(current){setDraft(value);setFormDirty(false);setLines((value.input_lines??value.document.lines.map(l=>({...l,unit_price:null}))).map(l=>({id:l.id,description:l.description,spec:l.spec??'',unit:l.unit,quantity:l.quantity??'',unit_price:l.unit_price??''})));}},()=>{if(current)setError('초안을 열지 못했어요. 연결과 자료 접근 권한을 확인해 주세요.');});return()=>{current=false;};},[client,currentId]);
 if(issuedId)return <IssuedDocument key={issuedId} client={client} id={issuedId}/>;
 if(error)return <Notice tone="danger" role="alert">{error}</Notice>;if(!draft)return <p role="status" className="muted">최신 자료로 준비한 내용을 여는 중이에요…</p>;
 const d=draft.document,missing=draft.missing.filter(m=>!(d.type==='invoice'&&m===invoiceRange));
 const fields=([missing.includes('받는 곳')?'recipient':null,missing.includes('마진 기준')?'margin':null,missing.includes('부가세 조건')?'tax':null] as (Field|null)[]).filter((f):f is Field=>f!==null);
 const issuable=!draft.stale&&d.totals.total!==null&&!draft.missing.some(m=>m!==invoiceRange);
 const name=documentNames[d.type]??'문서';
 async function complete(refresh=false,orderSelection?:string,form?:DocumentForm,lineSelection?:string){if(saving)return;
  if(orderSelection!==undefined){const values=JSON.parse(orderSelection) as {id:string;quantity:string}[];const bad=values.find(v=>!/^\d{1,12}(?:\.\d{1,6})?$/.test(v.quantity.trim()));if(bad){setSaveError('발주 수량은 숫자와 소수점으로 적어 주세요. 소수는 여섯 자리까지 가능해요.');return;}orderSelection=JSON.stringify(values.map(v=>{const [n,f]=v.quantity.trim().split('.');return {...v,quantity:BigInt(n!).toString()+(f?'.'+f:'')};}));}
 setSaving(true);setSaveError('');try{
  const answers=lineSelection!==undefined?{lines:lineSelection}:form!==undefined?{form}:orderSelection!==undefined?{quantities:orderSelection}:refresh?{}:{...(fields.includes('recipient')?{recipient}:{}),...(fields.includes('margin')?{margin_bps:Math.round(Number(margin)*100)}:{}),...(fields.includes('tax')?{tax_mode:vat as 'exclusive'|'inclusive'|'not_applicable',tax_bps:vat==='not_applicable'?0:Math.round(Number(tax)*100)}:{})};
  const body=JSON.stringify(answers);if(!pending.current||pending.current.body!==body)pending.current={body,id:workId()};
  const result=await client.request<{id:string}>({route:'documents.complete',id:currentId,client_command_id:pending.current.id,...answers});setCurrentId(result.id);pending.current=null;
 }catch{try{const current=await client.request<Draft>({route:'documents.read',id:currentId});if(current.latest_id&&current.latest_id!==currentId){pending.current=null;setCurrentId(current.latest_id);}else setSaveError('아직 반영하지 못했어요. 다시 누르면 같은 답변을 이어갑니다.');}catch{setSaveError('초안의 근거 자료와 연결을 확인해 주세요.');}}finally{setSaving(false);}}
 const head=<header className="doc-head"><span className="tag">초안 · 아직 발행하지 않았어요</span><h2>{name}</h2><p>{d.project.name} · {d.date}</p><p className="doc-parties">{d.issuer.name} → {d.recipient.name??'받는 곳 확인 필요'}</p></header>;
 if(fields.length){
  const at=Math.min(field,fields.length-1),current=fields[at]!,last=at===fields.length-1;
  return <article className="work-draft" aria-label={`${name} 초안`}>
   <p className="progress-text">빈칸 채우기 <strong>{at+1}</strong> / {fields.length}</p>{head}
   <form className="one-question" onSubmit={e=>{e.preventDefault();if(last)void complete();else setField(at+1);}}>
    {current==='recipient'?<label className="field field-large">이 {name}는 누구에게 보내나요?<input required maxLength={120} value={recipient} autoComplete="organization" onChange={e=>setRecipient(e.target.value)}/></label>:null}
    {current==='margin'?<label className="field field-large">이번 견적의 마진은 몇 %인가요?<span className="input-unit"><input required type="number" inputMode="decimal" min="0" max="99.99" step="0.01" value={margin} onChange={e=>setMargin(e.target.value)}/><span aria-hidden="true">%</span></span></label>:null}
    {current==='tax'?<><fieldset className="choice-group"><legend>부가세는 어떻게 할까요?</legend>{([['exclusive','별도로 더하기'],['inclusive',d.type==='estimate'&&draft.source_candidate?'매입단가에 포함':'금액에 포함'],['not_applicable','해당 없음']] as const).map(([value,label])=><label key={value} className="choice"><input type="radio" name="vat" required value={value} checked={vat===value} onChange={()=>setVat(value)}/><span>{label}</span></label>)}</fieldset>{vat&&vat!=='not_applicable'?<label className="field">세율 (%)<input required type="number" inputMode="decimal" min="0" max="100" step="0.01" value={tax} onChange={e=>setTax(e.target.value)}/></label>:null}</>:null}
    <p className="muted">읽은 자료에서 확인한 내용은 초안에 모았어요. 모르는 금액은 비워 두었습니다.</p>
    {saveError?<Notice tone="danger" role="alert">{saveError}</Notice>:null}
    <div className="screen-action">{at>0?<button type="button" className="button-quiet" disabled={saving} onClick={()=>setField(at-1)}>이전 질문</button>:null}<button type="submit" className="button-primary" disabled={saving}>{saving?'반영 중…':last?'답하고 초안 이어서 준비':'다음 질문으로'}</button></div>
   </form>
  </article>;
 }
 if(issuing&&issuable)return <article className="work-draft" aria-label={`${name} 발행 확인`}><p className="progress-text">발행 확인 <strong>3</strong> / 3</p><p className="doc-parties">{name} · {d.project.name}</p><WorkIssue key={draft.id} onIssued={value=>{if(onIssued)onIssued(value);else setIssuedId(value);}} client={client} draft={draft} onRefresh={value=>{setDraft(value);setCurrentId(value.id);setIssuing(false);}}/><button type="button" className="button-link" onClick={()=>setIssuing(false)}>내용 다시 보기</button></article>;
 return <article className="work-draft" aria-label={`${name} 초안`}>
  <p className="progress-text">내용 확인 <strong>2</strong> / 3</p>{head}
  {draft.stale?<Notice tone="warn" role="alert"><p>자료나 계산 기준이 바뀌었어요. 최신 자료로 다시 준비해 주세요.</p></Notice>:null}
  {missing.length?<Notice tone="warn"><p><strong>{missing[0]}</strong>: 확인하면 이어서 준비할 수 있어요.</p>{missing.length>1?<ul>{missing.slice(1).map(m=><li key={m}>{m}</li>)}</ul>:null}</Notice>:null}
  <dl className="doc-total"><div className="doc-total-main"><dt>합계</dt><dd>{won(d.totals.total)}{d.totals.total!==null?<small>{readWon(d.totals.total)}</small>:null}</dd></div><div><dt>공급가</dt><dd>{won(d.totals.supply)}</dd></div><div><dt>부가세</dt><dd>{won(d.totals.tax)}</dd></div></dl>
  {d.lines.length?<><h3 className="section-title">품목 {d.lines.length}개</h3><ul className="line-list">{d.lines.map(l=><li key={l.id} className="line"><p className="line-name"><strong>{l.description}</strong>{l.spec?<small>{l.spec}</small>:null}</p><p className="line-calc"><span>{l.quantity??'수량 확인 필요'} {l.unit} × {won(l.unit_price)}</span><strong>{won(l.supply)}</strong></p><p className="line-tax">부가세 {won(l.tax)}</p></li>)}</ul></>:null}
  {!draft.stale&&d.type==='estimate'?<details className="quiet-details draft-lines" open={!d.lines.length||d.lines.some(l=>l.quantity===null||l.unit_price===null)}><summary>품목·수량·매입단가 입력</summary><form className="stack" onSubmit={e=>{e.preventDefault();void complete(false,undefined,undefined,JSON.stringify(lines));}}>{lines.map((l,index)=><fieldset className="draft-line-input" key={l.id}><legend>품목 {index+1}</legend>{([['description','품목'],['spec','규격'],['unit','단위'],['quantity','수량'],['unit_price','매입단가 (원)']] as const).map(([key,label])=><label className="field" key={key}>{label}<input required={key!=='spec'} maxLength={key==='description'?180:key==='spec'?180:key==='unit'?30:24} type={key==='quantity'||key==='unit_price'?'number':'text'} {...(key==='quantity'?{min:'0.000001',step:'0.000001',inputMode:'decimal' as const}:key==='unit_price'?{min:'0',step:'1',inputMode:'numeric' as const}:{})} value={l[key]} disabled={saving} onChange={e=>setLines(current=>current.map(x=>x.id===l.id?{...x,[key]:e.target.value}:x))}/></label>)}<button type="button" className="text-button" disabled={saving} onClick={()=>setLines(current=>current.filter(x=>x.id!==l.id))}>품목 {index+1} 삭제</button></fieldset>)}<button type="button" className="button-secondary" disabled={saving||lines.length>=100} onClick={()=>setLines(current=>[...current,{id:workId(),description:'',spec:'',unit:'개',quantity:'',unit_price:''}])}>품목 추가</button><button type="submit" className="button-secondary" disabled={saving||!lines.length}>입력한 품목으로 다시 계산</button></form></details>:null}
  {d.type==='purchase_order'&&draft.order_quantities?.length&&!draft.stale?<details className="quiet-details" open={missing.some(m=>m.includes('이번 발주'))}><summary>이번에는 일부만 발주하기</summary><form onSubmit={e=>{e.preventDefault();void complete(false,JSON.stringify(draft.order_quantities!.map(l=>({id:l.id,quantity:quantities[l.id]??d.lines.find(x=>x.id===l.id)?.quantity??l.available??''}))));}}><p>미발주 수량 안에서 이번에 필요한 양을 적어 주세요. 0인 품목은 이번 발주에서 빠져요.</p>{draft.order_quantities.map(l=><label className="field" key={l.id}>{l.description} · 남은 {l.available??'확인 필요'} {l.unit}<input required type="number" inputMode="decimal" min="0" max={l.available??undefined} step="0.000001" value={quantities[l.id]??d.lines.find(x=>x.id===l.id)?.quantity??l.available??''} onChange={e=>setQuantities(v=>({...v,[l.id]:e.target.value}))}/></label>)}<button className="button-secondary" disabled={saving} type="submit">이번 수량으로 다시 계산</button><button className="button-link" disabled={saving} type="button" onClick={()=>void complete(false,'[]')}>남은 수량 모두 준비</button></form></details>:null}
  <DocumentFormEditor key={draft.id} form={d.form??{}} issuer={d.issuer.name} type={d.type} busy={saving} onDirty={()=>setFormDirty(true)} onSave={form=>void complete(false,undefined,form)}/>
  {formDirty?<p role="status">바꾼 사업자 정보를 저장한 뒤 발행해 주세요.</p>:null}
  <p className="muted">{draft.source_candidate?'원문에서 읽어 준비한 내용이며 작업 완료나 지급을 확정하지 않았어요.':'기존 업무 기록을 바탕으로 다시 계산했어요.'} {d.type==='delivery_statement'?'거래명세서만으로 청구나 수금이 생기지 않아요.':''}</p>
  {draft.notes?.length?<ul className="muted">{[...new Set(draft.notes)].map(n=><li key={n}>{n}</li>)}</ul>:null}
  {saveError?<Notice tone="danger" role="alert">{saveError}</Notice>:null}
  {draft.source_refs.length?<details className="quiet-details"><summary>근거 자료 {draft.source_refs.length}개 보기</summary><div className="stack">{draft.source_refs.map((source,index)=><button type="button" className="button-secondary" key={source} onClick={()=>onOpen(source)}>근거 자료 {index+1} 열기</button>)}</div></details>:null}
  <div className="screen-action">{draft.stale?<button type="button" className="button-primary" disabled={saving} onClick={()=>void complete(true)}>최신 자료로 다시 준비</button>:issuable?<button type="button" className="button-primary" disabled={saving||formDirty} onClick={()=>setIssuing(true)}>이 내용으로 발행하러 가기</button>:draft.source_refs[0]?<button type="button" className="button-secondary" onClick={()=>onOpen(draft.source_refs[0]!)}>근거 자료 열고 확인</button>:null}</div>
 </article>;
}
